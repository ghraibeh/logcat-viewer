"""Network Intercept: capture the device's HTTP(S) traffic, HTTP-Toolkit style.

Two tiers, one UI:

* **Tier 1 — built-in (zero extra deps).** A tiny in-process ``asyncio`` proxy
  (``serve``) bound to ``127.0.0.1``. The device is pointed at it with
  ``adb reverse`` + the global ``http_proxy`` setting. Plain HTTP is captured in
  full (method, url, headers, request/response bodies); HTTPS is blind-tunnelled
  via ``CONNECT`` so we record only metadata (host + SNI + byte counts), never
  decrypting.
* **Tier 2 — optional (mitmproxy).** If a ``mitmdump`` binary is on ``PATH`` the
  "Decrypt HTTPS" toggle runs it as a subprocess (see ``assets/mitm_addon.py``)
  and streams decrypted flows into the same table. Absent → silently Tier 1.

The proxy engine lives in a ``QThread`` (its own asyncio loop) and only ever
*emits signals* — it never touches widgets. The device wiring (``adb reverse`` /
``settings put global http_proxy``) is applied on enable — after snapshotting the
device's *original* proxy — and, critically, restored synchronously on *every*
exit path (disable / device switch / app close): the device is put back exactly
as it was (original proxy re-applied, or the setting deleted if it had none), so
a proxy left pointing at a dead reverse tunnel never strands the device offline.

For the case the host *can't* clean up — the device is unplugged / reboots / adb
dies / the app crashes — a device-side **watchdog** (a held-open ``adb shell``
whose shell traps SIGHUP) restores the original proxy on the device itself when
the link drops. A normal stop releases it via one byte on its stdin so it exits
*without* restoring (the host already did), avoiding any clobber of a new session.
"""
from __future__ import annotations

import asyncio
import base64
import html
import json
import re
import shutil
import socket
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path

from PyQt6.QtCore import (
    QAbstractTableModel, QModelIndex, QPointF, QProcess, QRect, QRectF, Qt, QThread, QTimer,
    pyqtSignal,
)
from PyQt6.QtGui import (
    QBrush, QColor, QFont, QFontMetrics, QGuiApplication, QKeySequence, QPainter, QPainterPath,
    QPen, QShortcut, QSyntaxHighlighter, QTextCharFormat, QTextCursor, QTextDocument,
)
from PyQt6.QtWidgets import (
    QAbstractItemView,
    QComboBox,
    QFileDialog,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPlainTextEdit,
    QPushButton,
    QSizePolicy,
    QSpinBox,
    QSplitter,
    QStackedWidget,
    QStyle,
    QStyledItemDelegate,
    QTableView,
    QTextBrowser,
    QTreeWidget,
    QTreeWidgetItem,
    QVBoxLayout,
    QWidget,
)

from .resources import asset_path
from .theme import ACCENT, BG, BORDER, SURFACE, AMBER, GREEN, RED, TEXT, TEXT_DIM

DEFAULT_PORT = 8099
MAX_BODY = 1_048_576        # capture at most 1 MB of any single body (relay is unbounded)
FLOW_CAP = 5000             # ring-buffer of captured flows
PEEK_BYTES = 8192           # bytes sniffed from a CONNECT tunnel to read the TLS SNI
RELAY_CHUNK = 65536
_STREAM_LIMIT = 1 << 20     # asyncio StreamReader buffer (headers up to 1 MB)

MITM_ADDON = asset_path("mitm_addon.py")
# Pin mitmproxy's config dir so it always reuses the SAME CA — the cert the user
# installed on the device stays valid across every app run (install once).
MITM_CONFDIR = Path.home() / ".mitmproxy"


def _cert_marker(serial: str) -> Path:
    """Per-device marker: 'this device has had the CA cert pushed'. Lets us
    prompt for the one-time install only once per device, not every run."""
    safe = "".join(c if c.isalnum() else "_" for c in (serial or "device"))
    return MITM_CONFDIR / f".logcatviewer-cert-{safe}"


_HAVE_MITM: bool | None = None


def have_mitmproxy() -> bool:
    """Whether a ``mitmdump`` binary is available (enables HTTPS decryption)."""
    global _HAVE_MITM
    if _HAVE_MITM is None:
        try:
            _HAVE_MITM = shutil.which("mitmdump") is not None
        except Exception:
            _HAVE_MITM = False
    return _HAVE_MITM


# --- pure adb command builders (no device needed → covered by smoke tests) ----
def reverse_args(serial: str, port: int) -> list[str]:
    """adb args to tunnel device ``127.0.0.1:port`` back to the host's port."""
    return ["-s", serial, "reverse", f"tcp:{port}", f"tcp:{port}"]


def set_proxy_args(serial: str, port: int) -> list[str]:
    """adb args to point the device's global HTTP proxy at the reverse tunnel."""
    return ["-s", serial, "shell", "settings", "put", "global",
            "http_proxy", f"127.0.0.1:{port}"]


def clear_proxy_args(serial: str) -> list[str]:
    """adb args to clear the global HTTP proxy (``:0`` = disabled, no reboot)."""
    return ["-s", serial, "shell", "settings", "put", "global", "http_proxy", ":0"]


def get_proxy_args(serial: str) -> list[str]:
    """adb args to read the device's current global HTTP proxy (``null`` = unset)."""
    return ["-s", serial, "shell", "settings", "get", "global", "http_proxy"]


# A device proxy value is host:port-ish; anything with shell metacharacters is
# rejected (defence-in-depth, since it's embedded in the on-device shell script).
_SAFE_PROXY = re.compile(r"[A-Za-z0-9._:\-\[\]]+")


def _real_proxy(original: str) -> str:
    """The device's genuine prior proxy to restore, or '' if it had none.

    Empty / ``null`` / ``:0`` / our-own ``127.0.0.1:`` tunnel / anything with
    unsafe characters → '' (meaning: delete the setting, the true clean state)."""
    val = (original or "").strip()
    if (val and val.lower() != "null" and val != ":0"
            and not val.startswith("127.0.0.1:") and _SAFE_PROXY.fullmatch(val)):
        return val
    return ""


def restore_proxy_args(serial: str, original: str) -> list[str]:
    """adb args to put the proxy back exactly as it was before we touched it —
    the prior proxy verbatim, or delete the setting if the device had none."""
    val = _real_proxy(original)
    if val:
        return ["-s", serial, "shell", "settings", "put", "global", "http_proxy", val]
    return ["-s", serial, "shell", "settings", "delete", "global", "http_proxy"]


def proxy_restore_cmd(original: str) -> str:
    """The device-shell command that restores the original proxy (or deletes it)."""
    val = _real_proxy(original)
    return (f"settings put global http_proxy {val}" if val
            else "settings delete global http_proxy")


def proxy_watchdog_script(original: str) -> str:
    """A tiny device-side script (run over a held-open ``adb shell``) that
    self-heals the proxy when the connection drops.

    * On **disconnect / app crash** adbd delivers SIGHUP to this shell → the trap
      restores the device's original proxy. This is the safety net for when the
      host never got to run its own teardown.
    * On a **normal stop** the app writes one byte to the shell's stdin → ``read``
      returns → the trap is disarmed and it exits *without* restoring (the host
      restores synchronously), so a later stray trap can't clobber a new session."""
    return f"trap '{proxy_restore_cmd(original)}' HUP INT TERM; read _ 2>/dev/null; trap - HUP INT TERM"


def reverse_remove_args(serial: str, port: int) -> list[str]:
    """adb args to remove the reverse tunnel for ``port``."""
    return ["-s", serial, "reverse", "--remove", f"tcp:{port}"]


# --- captured request/response ------------------------------------------------
class Flow:
    """One captured request/response. ``__slots__`` — thousands may be held."""

    __slots__ = (
        "id", "ts", "method", "scheme", "host", "port", "path", "status",
        "req_headers", "resp_headers", "req_size", "resp_size", "duration_ms",
        "req_body", "resp_body", "req_truncated", "resp_truncated",
        "body_captured", "note", "search",
    )

    def __init__(self, method="", scheme="http", host="", port=80, path="/",
                 status=None, req_headers=None, resp_headers=None, req_size=0,
                 resp_size=0, duration_ms=None, req_body=None, resp_body=None,
                 req_truncated=False, resp_truncated=False, body_captured=True,
                 note="", ts=None):
        self.id = 0
        self.ts = ts if ts is not None else time.time()
        self.method = method
        self.scheme = scheme
        self.host = host
        self.port = port
        self.path = path
        self.status = status
        self.req_headers = req_headers or []
        self.resp_headers = resp_headers or []
        self.req_size = req_size
        self.resp_size = resp_size
        self.duration_ms = duration_ms
        self.req_body = req_body
        self.resp_body = resp_body
        self.req_truncated = req_truncated
        self.resp_truncated = resp_truncated
        self.body_captured = body_captured
        self.note = note
        self.search = (host + " " + path).lower()

    @property
    def url(self) -> str:
        hostport = self.host if self.port in (80, 443) else f"{self.host}:{self.port}"
        return f"{self.scheme}://{hostport}{self.path}"


# --- TLS / HTTP wire helpers (Qt-free → unit-testable) ------------------------
def parse_sni(data: bytes) -> str | None:
    """Best-effort Server Name Indication from a TLS ClientHello. Any malformed
    input returns ``None`` — SNI is a nicety and must never break the tunnel."""
    try:
        if len(data) < 43 or data[0] != 0x16 or data[5] != 0x01:
            return None
        idx = 5 + 4          # skip record header (5) + handshake type/len (4)
        idx += 2             # client version
        idx += 32            # random
        idx += 1 + data[idx]                                   # session id
        idx += 2 + int.from_bytes(data[idx:idx + 2], "big")    # cipher suites
        idx += 1 + data[idx]                                   # compression methods
        ext_total = int.from_bytes(data[idx:idx + 2], "big")
        idx += 2
        end = min(len(data), idx + ext_total)
        while idx + 4 <= end:
            etype = int.from_bytes(data[idx:idx + 2], "big")
            elen = int.from_bytes(data[idx + 2:idx + 4], "big")
            idx += 4
            if etype == 0x0000:                    # server_name extension
                p = idx + 2                        # skip server_name_list length
                p += 1                             # name type (host_name)
                nlen = int.from_bytes(data[p:p + 2], "big")
                p += 2
                name = data[p:p + nlen]
                return name.decode("latin-1") or None
            idx += elen
        return None
    except Exception:
        return None


def parse_head(raw: bytes) -> tuple[str, list[tuple[str, str]]]:
    """Split an HTTP head into (start-line, [(name, value), ...])."""
    text = raw.split(b"\r\n\r\n", 1)[0].decode("latin-1", "replace")
    lines = text.split("\r\n")
    start = lines[0] if lines else ""
    headers = []
    for line in lines[1:]:
        if ":" in line:
            k, v = line.split(":", 1)
            headers.append((k.strip(), v.strip()))
    return start, headers


def _header_get(headers, name: str) -> str | None:
    low = name.lower()
    for k, v in headers:
        if k.lower() == low:
            return v
    return None


def _split_url(target: str) -> tuple[str, str, int, str]:
    """Parse a proxy absolute-form request target into (scheme, host, port, path)."""
    if "://" in target:
        scheme, rest = target.split("://", 1)
    else:
        scheme, rest = "http", target
    hostport, sep, path = rest.partition("/")
    path = "/" + path if sep else (path or "/")
    if "@" in hostport:
        hostport = hostport.split("@", 1)[1]
    host, _, port_s = hostport.partition(":")
    port = int(port_s) if port_s.isdigit() else (443 if scheme == "https" else 80)
    return scheme, host, port, path


def _parse_status(start_line: str) -> int | None:
    parts = start_line.split(" ", 2)
    if len(parts) >= 2 and parts[1].isdigit():
        return int(parts[1])
    return None


async def _read_head(reader: asyncio.StreamReader) -> bytes:
    try:
        return await reader.readuntil(b"\r\n\r\n")
    except asyncio.IncompleteReadError as exc:
        return exc.partial
    except Exception:
        return b""


async def _readexactly(reader: asyncio.StreamReader, n: int) -> bytes:
    try:
        return await reader.readexactly(n)
    except asyncio.IncompleteReadError as exc:
        return exc.partial


async def _relay_body(src, dst, headers, cap: int, read_until_eof: bool):
    """Relay a message body from ``src`` to ``dst`` verbatim (framing preserved),
    capturing up to ``cap`` decoded bytes. Returns (relayed_size, body, truncated)."""
    te = (_header_get(headers, "Transfer-Encoding") or "").lower()
    cl = _header_get(headers, "Content-Length")
    captured = bytearray()
    total = 0
    truncated = False

    def cap_bytes(chunk: bytes):
        nonlocal truncated
        if len(captured) < cap:
            take = cap - len(captured)
            captured.extend(chunk[:take])
            if len(chunk) > take:
                truncated = True

    try:
        if "chunked" in te:
            while True:
                size_line = await src.readline()
                if not size_line:
                    break
                dst.write(size_line)
                try:
                    size = int(size_line.split(b";")[0].strip() or b"0", 16)
                except ValueError:
                    break
                if size == 0:
                    while True:                       # relay trailers to the blank line
                        t = await src.readline()
                        if not t:
                            break
                        dst.write(t)
                        if t in (b"\r\n", b"\n"):
                            break
                    await dst.drain()
                    break
                chunk = await _readexactly(src, size)
                dst.write(chunk)
                dst.write(await _readexactly(src, 2))     # trailing CRLF
                await dst.drain()
                total += len(chunk)
                cap_bytes(chunk)
        elif cl is not None and cl.strip().isdigit():
            remaining = int(cl.strip())
            while remaining > 0:
                chunk = await src.read(min(RELAY_CHUNK, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                total += len(chunk)
                dst.write(chunk)
                await dst.drain()
                cap_bytes(chunk)
        elif read_until_eof:
            while True:
                chunk = await src.read(RELAY_CHUNK)
                if not chunk:
                    break
                total += len(chunk)
                dst.write(chunk)
                await dst.drain()
                cap_bytes(chunk)
    except Exception:
        pass
    return total, bytes(captured), truncated


async def _pump(src, dst) -> int:
    """Blindly copy ``src`` → ``dst`` until EOF; return bytes moved."""
    total = 0
    try:
        while True:
            chunk = await src.read(RELAY_CHUNK)
            if not chunk:
                break
            total += len(chunk)
            dst.write(chunk)
            await dst.drain()
    except Exception:
        pass
    finally:
        try:
            if dst.can_write_eof():
                dst.write_eof()
        except Exception:
            pass
    return total


async def _handle_connect(reader, writer, target, emit_flow, new_id):
    host, _, port_s = target.partition(":")
    port = int(port_s) if port_s.isdigit() else 443
    try:
        writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        await writer.drain()
    except Exception:
        return
    peek = b""
    try:
        peek = await asyncio.wait_for(reader.read(PEEK_BYTES), timeout=10)
    except Exception:
        peek = b""
    sni = parse_sni(peek) if peek else None
    host_display = sni or host
    ts = time.time()
    try:
        up_reader, up_writer = await asyncio.open_connection(host, port, limit=_STREAM_LIMIT)
    except Exception as exc:
        flow = Flow(method="CONNECT", scheme="https", host=host_display, port=port,
                    path="", status=None, body_captured=False,
                    note=f"connect failed: {exc}", ts=ts)
        flow.id = new_id()
        emit_flow(flow)
        return
    c2s = s2c = 0
    try:
        if peek:
            up_writer.write(peek)
            await up_writer.drain()
        results = await asyncio.gather(_pump(reader, up_writer), _pump(up_reader, writer),
                                       return_exceptions=True)
        c2s = results[0] if isinstance(results[0], int) else 0
        s2c = results[1] if isinstance(results[1], int) else 0
    finally:
        for w in (up_writer, writer):
            try:
                w.close()
            except Exception:
                pass
    flow = Flow(method="CONNECT", scheme="https", host=host_display, port=port, path="",
                status=None, req_size=len(peek) + c2s, resp_size=s2c,
                duration_ms=int((time.time() - ts) * 1000), body_captured=False,
                note="encrypted — enable Decrypt HTTPS to see contents", ts=ts)
    flow.id = new_id()
    emit_flow(flow)


async def _handle_http(reader, writer, method, target, req_headers, emit_flow, new_id):
    scheme, host, port, path = _split_url(target)
    if not host:
        return
    ts = time.time()
    try:
        up_reader, up_writer = await asyncio.open_connection(host, port, limit=_STREAM_LIMIT)
    except Exception as exc:
        flow = Flow(method=method, scheme=scheme, host=host, port=port, path=path,
                    status=None, req_headers=req_headers, note=f"upstream error: {exc}",
                    body_captured=False, ts=ts)
        flow.id = new_id()
        emit_flow(flow)
        return

    have_host = False
    out = [f"{method} {path} HTTP/1.1\r\n".encode("latin-1")]
    for k, v in req_headers:
        lk = k.lower()
        if lk in ("connection", "proxy-connection", "keep-alive"):
            continue
        if lk == "host":
            have_host = True
        out.append(f"{k}: {v}\r\n".encode("latin-1"))
    if not have_host:
        hostport = host if port == 80 else f"{host}:{port}"
        out.append(f"Host: {hostport}\r\n".encode("latin-1"))
    out.append(b"Connection: close\r\n\r\n")
    up_writer.write(b"".join(out))
    await up_writer.drain()

    req_size, req_body, req_trunc = await _relay_body(
        reader, up_writer, req_headers, MAX_BODY, read_until_eof=False)

    resp_head = await _read_head(up_reader)
    resp_start, resp_headers = parse_head(resp_head)
    status = _parse_status(resp_start)

    client_head = [resp_start]
    for k, v in resp_headers:
        if k.lower() in ("connection", "proxy-connection", "keep-alive"):
            continue
        client_head.append(f"{k}: {v}")
    client_head.append("Connection: close")
    try:
        writer.write(("\r\n".join(client_head) + "\r\n\r\n").encode("latin-1"))
        await writer.drain()
    except Exception:
        pass

    has_body = not (status in (204, 304) or (status is not None and 100 <= status < 200))
    resp_size, resp_body, resp_trunc = await _relay_body(
        up_reader, writer, resp_headers, MAX_BODY, read_until_eof=has_body)

    for w in (up_writer, writer):
        try:
            w.close()
        except Exception:
            pass

    flow = Flow(method=method, scheme=scheme, host=host, port=port, path=path,
                status=status, req_headers=req_headers, resp_headers=resp_headers,
                req_size=req_size, resp_size=resp_size,
                duration_ms=int((time.time() - ts) * 1000),
                req_body=req_body or None, resp_body=resp_body or None,
                req_truncated=req_trunc, resp_truncated=resp_trunc, ts=ts)
    flow.id = new_id()
    emit_flow(flow)


async def _handle_client(reader, writer, emit_flow, new_id):
    try:
        head = await _read_head(reader)
        if not head:
            return
        start_line, headers = parse_head(head)
        parts = start_line.split(" ")
        if len(parts) < 3:
            return
        method, target = parts[0], parts[1]
        if method.upper() == "CONNECT":
            await _handle_connect(reader, writer, target, emit_flow, new_id)
        else:
            await _handle_http(reader, writer, method, target, headers, emit_flow, new_id)
    except Exception:
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


async def serve(port, emit_flow, stop_event, on_started=None):
    """Run the Tier-1 proxy on ``127.0.0.1:port`` until ``stop_event`` is set.

    Raises ``OSError`` (before ``on_started``) if the port can't be bound."""
    counter = [0]

    def new_id():
        counter[0] += 1
        return counter[0]

    async def cb(reader, writer):
        await _handle_client(reader, writer, emit_flow, new_id)

    server = await asyncio.start_server(cb, "127.0.0.1", port, limit=_STREAM_LIMIT)
    bound = server.sockets[0].getsockname()[1] if server.sockets else port
    if on_started is not None:
        on_started(bound)
    try:
        await stop_event.wait()
    finally:
        server.close()
        try:
            await server.wait_closed()
        except Exception:
            pass
    return bound


# --- engine workers -----------------------------------------------------------
class InterceptWorker(QThread):
    """Tier-1 built-in proxy: runs an asyncio loop in its own thread."""

    flow = pyqtSignal(object)      # a Flow
    started = pyqtSignal(int)      # bound port
    failed = pyqtSignal(str)

    def __init__(self, port: int, parent=None):
        super().__init__(parent)
        self._port = port
        self._loop: asyncio.AbstractEventLoop | None = None
        self._stop: asyncio.Event | None = None

    def run(self):
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        self._loop = loop
        self._stop = asyncio.Event()
        try:
            loop.run_until_complete(
                serve(self._port, self._emit, self._stop,
                      on_started=lambda p: self.started.emit(p)))
        except OSError as exc:
            self.failed.emit(f"port {self._port} unavailable ({exc})")
        except Exception as exc:  # pragma: no cover - defensive
            self.failed.emit(str(exc))
        finally:
            try:
                loop.close()
            except Exception:
                pass

    def _emit(self, flow: Flow):
        self.flow.emit(flow)       # queued (cross-thread) → delivered on the UI thread

    def stop(self):
        loop, stop = self._loop, self._stop
        if loop is not None and stop is not None:
            loop.call_soon_threadsafe(stop.set)


class MitmdumpWorker(QThread):
    """Tier-2 HTTPS decryption: drive ``mitmdump`` and parse its JSON flow lines."""

    flow = pyqtSignal(object)
    started = pyqtSignal(int)
    failed = pyqtSignal(str)

    def __init__(self, port: int, parent=None):
        super().__init__(parent)
        self._port = port
        self._run = True
        self._proc = None

    def run(self):
        mitm = shutil.which("mitmdump")
        if not mitm:
            self.failed.emit("mitmdump not found")
            return
        # Reap any mitmdump we orphaned in a prior crash (matched by our addon
        # path, so we never touch the user's own mitmproxy sessions).
        try:
            subprocess.run(["pkill", "-f", str(MITM_ADDON)], capture_output=True, timeout=4)
        except (subprocess.SubprocessError, OSError):
            pass
        cmd = [mitm, "-q", "-p", str(self._port), "-s", str(MITM_ADDON),
               "--set", "flow_detail=0", "--set", f"confdir={MITM_CONFDIR}"]
        try:
            self._proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        except (OSError, subprocess.SubprocessError) as exc:
            self.failed.emit(str(exc))
            return
        self.started.emit(self._port)
        got_any = False
        while self._run:
            raw = self._proc.stdout.readline()
            if not raw:
                break
            try:
                data = json.loads(raw.decode("utf-8", "replace"))
            except (ValueError, TypeError):
                continue
            fl = _json_to_flow(data)
            if fl is not None:
                got_any = True
                self.flow.emit(fl)
        code = self._proc.poll()
        if self._run and not got_any and code not in (0, None):
            err = ""
            try:
                err = (self._proc.stderr.read() or b"").decode("utf-8", "replace").strip()
            except Exception:
                pass
            self.failed.emit(err.splitlines()[-1] if err else f"mitmdump exited ({code})")
        self._terminate()

    def _terminate(self):
        p = self._proc
        if p is not None and p.poll() is None:
            try:
                p.terminate()
                p.wait(timeout=2)
            except Exception:
                try:
                    p.kill()
                except Exception:
                    pass

    def stop(self):
        self._run = False
        self._terminate()


def _decode_body(s):
    if s is None:
        return None
    if isinstance(s, str) and s.startswith("base64:"):
        try:
            return base64.b64decode(s[7:])
        except Exception:
            return b""
    return s.encode("utf-8", "replace")


def _json_to_flow(d: dict) -> Flow | None:
    try:
        return Flow(
            method=d.get("method", ""),
            scheme=d.get("scheme", "https"),
            host=d.get("host", ""),
            port=int(d.get("port", 443)),
            path=d.get("path", "/"),
            status=d.get("status"),
            req_headers=[tuple(h) for h in d.get("req_headers", [])],
            resp_headers=[tuple(h) for h in d.get("resp_headers", [])],
            req_size=int(d.get("req_size", 0)),
            resp_size=int(d.get("resp_size", 0)),
            duration_ms=d.get("duration_ms"),
            req_body=_decode_body(d.get("req_body")),
            resp_body=_decode_body(d.get("resp_body")),
            req_truncated=bool(d.get("req_trunc")),
            resp_truncated=bool(d.get("resp_trunc")),
            body_captured=True,
            ts=d.get("ts"),
        )
    except Exception:
        return None


# --- copy-as-cURL / body pretty-print -----------------------------------------
def build_flow_export(f: "Flow") -> str:
    """A complete, human-readable dump of one flow: request + response, headers
    and (decoded) bodies — everything about that URL, for the Download button."""
    out = [f"# {f.method} {f.url}"]
    meta = []
    if f.status is not None:
        meta.append(f"status {f.status}")
    if f.duration_ms is not None:
        meta.append(f"{f.duration_ms} ms")
    if f.resp_size:
        meta.append(_human_size(f.resp_size))
    if meta:
        out.append("# " + "  ·  ".join(meta))

    out += ["", "===== REQUEST =====", f"{f.method} {f.path}  ({f.scheme})"]
    out += [f"{k}: {v}" for k, v in f.req_headers]
    req = pretty_body(f.req_body, f.req_headers)
    if req:
        out += ["", req]

    out += ["", "===== RESPONSE =====",
            f"HTTP {f.status}" if f.status is not None else "(no response)"]
    out += [f"{k}: {v}" for k, v in f.resp_headers]
    if f.body_captured:
        resp = pretty_body(f.resp_body, f.resp_headers)
        if resp:
            out += ["", resp]
    else:
        out += ["", f.note or "(encrypted — body not captured)"]
    return "\n".join(out) + "\n"


def flow_to_curl(f: Flow) -> str:
    parts = [f"curl -X {f.method} '{f.url}'"]
    for k, v in f.req_headers:
        if k.lower() in ("content-length", "proxy-connection", "connection"):
            continue
        parts.append(f"-H '{k}: {v}'")
    if f.req_body:
        try:
            parts.append("--data-raw '" + f.req_body.decode("utf-8") + "'")
        except Exception:
            pass
    return " \\\n  ".join(parts)


def decode_body(body, headers) -> bytes:
    """Undo Content-Encoding so text/JSON bodies aren't shown as '<N bytes binary>'.

    gzip/zstd are detected by magic bytes (so an already-decoded Tier-2 body is
    left untouched); deflate/brotli fall back to the header. Any failure returns
    the original bytes — decoding is best-effort and must never raise."""
    if not body:
        return body
    enc = (_header_get(headers, "Content-Encoding") or "").lower()
    try:
        if body[:2] == b"\x1f\x8b":                       # gzip
            import gzip
            import zlib
            try:
                return gzip.decompress(body)
            except Exception:                             # truncated → best effort
                return zlib.decompressobj(16 + zlib.MAX_WBITS).decompress(body)
        if body[:4] == b"\x28\xb5\x2f\xfd":               # zstd
            import zstandard
            return zstandard.ZstdDecompressor().decompress(body)
        if "deflate" in enc:
            import zlib
            for wbits in (zlib.MAX_WBITS, -zlib.MAX_WBITS):
                try:
                    return zlib.decompressobj(wbits).decompress(body)
                except Exception:
                    continue
        elif "br" in enc:
            import brotli
            return brotli.decompress(body)
    except Exception:
        return body
    return body


_TREE_STR = QColor("#8fbf6b")
_TREE_NUM = QColor("#e0a45e")
_TREE_KW = QColor("#c58fe0")
_TREE_KEY = QColor("#6f9ff0")


def looks_json(text: str) -> bool:
    t = (text or "").strip()
    if not t or t[0] not in "{[":
        return False
    try:
        json.loads(t)
        return True
    except Exception:
        return False


def _json_tree_item(key, value) -> QTreeWidgetItem:
    """Build one QTreeWidgetItem (recursively) for a JSON key/value."""
    item = QTreeWidgetItem()
    item.setText(0, str(key))
    item.setForeground(0, QBrush(_TREE_KEY))
    if isinstance(value, dict):
        item.setText(1, f"{{{len(value)}}}")
        item.setForeground(1, QBrush(_C_DIM))
        for k, v in value.items():
            item.addChild(_json_tree_item(k, v))
    elif isinstance(value, list):
        item.setText(1, f"[{len(value)}]")
        item.setForeground(1, QBrush(_C_DIM))
        for i, v in enumerate(value):
            item.addChild(_json_tree_item(i, v))
    else:
        if isinstance(value, bool):
            item.setText(1, "true" if value else "false"); item.setForeground(1, QBrush(_TREE_KW))
        elif value is None:
            item.setText(1, "null"); item.setForeground(1, QBrush(_TREE_KW))
        elif isinstance(value, str):
            item.setText(1, value); item.setForeground(1, QBrush(_TREE_STR))
        else:
            item.setText(1, str(value)); item.setForeground(1, QBrush(_TREE_NUM))
    return item


def populate_json_tree(tree: QTreeWidget, text: str) -> bool:
    """Fill ``tree`` from JSON ``text``. Returns False if it isn't JSON."""
    tree.clear()
    try:
        data = json.loads(text)
    except Exception:
        return False
    if isinstance(data, dict):
        for k, v in data.items():
            tree.addTopLevelItem(_json_tree_item(k, v))
    elif isinstance(data, list):
        for i, v in enumerate(data):
            tree.addTopLevelItem(_json_tree_item(i, v))
    else:
        root = QTreeWidgetItem()
        root.setText(1, str(data))
        tree.addTopLevelItem(root)
    tree.expandToDepth(1)
    return True


def pretty_body(body, headers) -> str:
    if not body:
        return ""
    body = decode_body(body, headers)
    try:
        text = body.decode("utf-8")
    except (UnicodeDecodeError, AttributeError):
        return f"<{len(body)} bytes binary>"
    ctype = (_header_get(headers, "Content-Type") or "").lower()
    if "json" in ctype or text[:1] in "{[":
        try:
            return json.dumps(json.loads(text), indent=2, ensure_ascii=False)
        except Exception:
            return text
    return text


# --- filter -------------------------------------------------------------------
@dataclass
class FlowFilterSpec:
    """Method / status-class / host+path filter for the flow table."""

    method: str = ""            # "" = any
    status_class: int = 0       # 0 = any, else 2/3/4/5 for 2xx..5xx
    text_query: str = ""        # substring or regex over host+path
    text_regex: bool = False

    _text_re: "re.Pattern | None" = field(default=None, init=False, repr=False)
    errors: "dict[str, str]" = field(default_factory=dict, init=False, repr=False)

    def compile(self) -> "FlowFilterSpec":
        self.errors = {}
        self._text_re = None
        if self.text_query and self.text_regex:
            try:
                self._text_re = re.compile(self.text_query, re.IGNORECASE)
            except re.error as exc:
                self.errors["text"] = str(exc)
        return self

    def has_error(self, key: str) -> bool:
        return key in self.errors

    def match(self, f: Flow) -> bool:
        if self.method and f.method.upper() != self.method.upper():
            return False
        if self.status_class:
            if f.status is None or f.status // 100 != self.status_class:
                return False
        if self.text_query:
            if self._text_re is not None:
                if not self._text_re.search(f.search):
                    return False
            elif not self.text_regex:
                if self.text_query.lower() not in f.search:
                    return False
        return True


# --- table model --------------------------------------------------------------
(COL_METHOD, COL_STATUS, COL_SOURCE, COL_HOST, COL_PATH,
 COL_TYPE, COL_SIZE, COL_TIME) = range(8)
FLOW_HEADERS = ["Method", "Status", "", "Host", "Path", "Type", "Size", "Time"]

_C_TEXT = QColor(TEXT)
_C_DIM = QColor(TEXT_DIM)
_C_GREEN = QColor(GREEN)
_C_AMBER = QColor(AMBER)
_C_RED = QColor(RED)
_C_ACCENT = QColor(ACCENT)

ACCENT_ROLE = int(Qt.ItemDataRole.UserRole) + 1   # per-row status/scheme accent color

_METHOD_COLORS = {
    "GET": QColor(ACCENT),
    "POST": QColor(GREEN),
    "PUT": QColor(AMBER),
    "PATCH": QColor(AMBER),
    "DELETE": QColor(RED),
    "HEAD": QColor(TEXT_DIM),
    "OPTIONS": QColor(TEXT_DIM),
    "CONNECT": QColor(TEXT_DIM),
}


def _method_color(method: str) -> QColor:
    return _METHOD_COLORS.get((method or "").upper(), _C_ACCENT)


def _status_color(status) -> QColor:
    if status is None:
        return _C_DIM
    return {5: _C_RED, 4: _C_AMBER, 3: _C_ACCENT, 2: _C_GREEN}.get(status // 100, _C_DIM)


def _fmt(hex_color: str) -> QTextCharFormat:
    f = QTextCharFormat()
    f.setForeground(QColor(hex_color))
    return f


def _headers_html(pairs) -> str:
    rows = "".join(
        f'<tr><td style="color:{TEXT_DIM};padding:1px 14px 1px 0;white-space:nowrap;'
        f'vertical-align:top">{html.escape(k)}</td>'
        f'<td style="color:{TEXT};word-break:break-all">{html.escape(v)}</td></tr>'
        for k, v in pairs)
    return (f'<table style="font-family:Menlo,monospace;font-size:12px;'
            f'border-collapse:collapse">{rows}</table>')


def _human_size(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f} KB"
    return f"{n / (1024 * 1024):.1f} MB"


class FlowTableModel(QAbstractTableModel):
    """Incremental, ring-buffered, filtered view over captured flows
    (same shape as the logcat ``LogTableModel``)."""

    def __init__(self, max_entries: int = FLOW_CAP, trim_chunk: int = 500, parent=None):
        super().__init__(parent)
        self.max_entries = max_entries
        self.trim_chunk = trim_chunk
        self.flows: list[Flow] = []
        self.visible: list[int] = []
        self._spec = FlowFilterSpec().compile()

    # --- Qt model interface ------------------------------------------------
    def rowCount(self, parent=QModelIndex()) -> int:
        return 0 if parent.isValid() else len(self.visible)

    def columnCount(self, parent=QModelIndex()) -> int:
        return 0 if parent.isValid() else len(FLOW_HEADERS)

    def headerData(self, section, orientation, role=Qt.ItemDataRole.DisplayRole):
        if orientation == Qt.Orientation.Horizontal and role == Qt.ItemDataRole.DisplayRole:
            return FLOW_HEADERS[section]
        return None

    def data(self, index, role=Qt.ItemDataRole.DisplayRole):
        if not index.isValid():
            return None
        f = self.flows[self.visible[index.row()]]
        col = index.column()
        if role == Qt.ItemDataRole.DisplayRole:
            if col == COL_METHOD:
                return f.method
            if col == COL_STATUS:
                return "" if f.status is None else str(f.status)
            if col == COL_SOURCE:
                return ""   # android source glyph painted by the delegate
            if col == COL_HOST:
                return f.host
            if col == COL_PATH:
                return f.path
            if col == COL_TYPE:
                return _header_get(f.resp_headers, "Content-Type") or ("tunnel" if not f.body_captured else "")
            if col == COL_SIZE:
                return _human_size(f.resp_size)
            if col == COL_TIME:
                return "" if f.duration_ms is None else f"{f.duration_ms} ms"
        elif role == Qt.ItemDataRole.ForegroundRole:
            if col == COL_METHOD:
                return _method_color(f.method)
            if col == COL_STATUS:
                return _status_color(f.status)
            if col == COL_HOST:
                return _C_TEXT
            return _C_DIM
        elif role == Qt.ItemDataRole.FontRole:
            if col in (COL_METHOD, COL_STATUS):
                fnt = QFont()
                fnt.setBold(True)
                return fnt
        elif role == ACCENT_ROLE:
            return (_status_color(f.status) if f.status is not None
                    else (_C_ACCENT if f.scheme == "https" else _C_DIM))
        elif role == Qt.ItemDataRole.TextAlignmentRole:
            if col in (COL_STATUS, COL_SOURCE, COL_SIZE, COL_TIME):
                return int(Qt.AlignmentFlag.AlignCenter)
            return int(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter)
        return None

    # --- data flow ---------------------------------------------------------
    def append_batch(self, new_flows: list[Flow]) -> None:
        if not new_flows:
            return
        base = len(self.flows)
        self.flows.extend(new_flows)
        matched = [base + off for off, f in enumerate(new_flows) if self._spec.match(f)]
        if matched:
            first = len(self.visible)
            self.beginInsertRows(QModelIndex(), first, first + len(matched) - 1)
            self.visible.extend(matched)
            self.endInsertRows()
        if len(self.flows) > self.max_entries:
            self._trim()

    def set_filter(self, spec: FlowFilterSpec) -> None:
        self.beginResetModel()
        self._spec = spec
        self._rebuild_visible()
        self.endResetModel()

    def clear(self) -> None:
        self.beginResetModel()
        self.flows = []
        self.visible = []
        self.endResetModel()

    def flow_at(self, row: int) -> Flow:
        return self.flows[self.visible[row]]

    def total_count(self) -> int:
        return len(self.flows)

    # --- internals ---------------------------------------------------------
    def _rebuild_visible(self) -> None:
        m = self._spec.match
        self.visible = [i for i, f in enumerate(self.flows) if m(f)]

    def _trim(self) -> None:
        drop = len(self.flows) - self.max_entries + self.trim_chunk
        self.beginResetModel()
        self.flows = self.flows[drop:]
        self._rebuild_visible()
        self.endResetModel()


# --- proxy device wiring (off the UI thread) ----------------------------------
class ProxySetupWorker(QThread):
    """Wire the device to the host proxy: ``adb reverse`` then ``settings put``.
    Never sets the proxy if the reverse tunnel fails (would strand the device)."""

    done = pyqtSignal(bool, str, str)   # ok, message, original_proxy (to restore later)

    def __init__(self, adb: str, serial: str, port: int, parent=None):
        super().__init__(parent)
        self._adb = adb
        self._serial = serial
        self._port = port

    def _read_original_proxy(self) -> str:
        """Snapshot the device's current proxy BEFORE we overwrite it, so it can
        be restored verbatim on teardown (some devices route through a real
        proxy — wiping it strands the device's internet)."""
        try:
            g = subprocess.run([self._adb, *get_proxy_args(self._serial)],
                               capture_output=True, text=True, timeout=8)
            return (g.stdout or "").strip()
        except (subprocess.SubprocessError, OSError):
            return ""

    def run(self):
        original = self._read_original_proxy()
        try:
            r = subprocess.run([self._adb, *reverse_args(self._serial, self._port)],
                               capture_output=True, text=True, timeout=8)
            if r.returncode != 0:
                msg = (r.stderr or r.stdout or "").strip().splitlines()
                self.done.emit(False, "adb reverse failed: "
                               + (msg[-1] if msg else "needs Android 5+ / a connected device"),
                               original)
                return
            subprocess.run([self._adb, *set_proxy_args(self._serial, self._port)],
                           capture_output=True, text=True, timeout=8)
        except (subprocess.SubprocessError, OSError) as exc:
            self.done.emit(False, f"proxy setup failed: {exc}", original)
            return
        self.done.emit(True, f"Proxy on 127.0.0.1:{self._port}", original)


class CertPushWorker(QThread):
    """Push mitmproxy's CA cert to the device's Download folder (generating it
    first if the user hasn't run mitmproxy yet), so it can be installed as a
    user CA. Runs off the UI thread — generation can take a few seconds."""

    done = pyqtSignal(bool, str, str)   # ok, message, device directory

    def __init__(self, adb: str, serial: str, parent=None):
        super().__init__(parent)
        self._adb = adb
        self._serial = serial

    def run(self):
        cert = Path.home() / ".mitmproxy" / "mitmproxy-ca-cert.pem"
        if not cert.is_file():
            self._generate(cert)
        if not cert.is_file():
            self.done.emit(False, "Couldn't find or generate mitmproxy's CA cert. "
                                  "Install mitmproxy, or enable Decrypt HTTPS once first.", "")
            return
        try:
            for name in ("mitmproxy-ca-cert.cer", "mitmproxy-ca-cert.pem"):
                r = subprocess.run(
                    [self._adb, "-s", self._serial, "push", str(cert), f"/sdcard/Download/{name}"],
                    capture_output=True, text=True, timeout=20)
                if r.returncode != 0:
                    blob = (r.stderr or r.stdout or "").strip().splitlines()
                    self.done.emit(False, "adb push failed: " + (blob[-1] if blob else "unknown"), "")
                    return
        except (subprocess.SubprocessError, OSError) as exc:
            self.done.emit(False, f"push failed: {exc}", "")
            return
        self.done.emit(True, "Pushed mitmproxy-ca-cert.cer to the device's Download folder",
                       "/sdcard/Download")

    def _generate(self, cert: Path):
        """Start mitmdump on a throwaway port just long enough to mint the CA."""
        mitm = shutil.which("mitmdump")
        if not mitm:
            return
        proc = None
        try:
            sock = socket.socket()
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
            sock.close()
            proc = subprocess.Popen([mitm, "-q", "-p", str(port),
                                     "--set", f"confdir={MITM_CONFDIR}"],
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            for _ in range(40):                       # wait up to ~4s for the CA to appear
                if cert.is_file():
                    break
                time.sleep(0.1)
        except (OSError, subprocess.SubprocessError):
            pass
        finally:
            if proc is not None and proc.poll() is None:
                try:
                    proc.terminate()
                    proc.wait(timeout=2)
                except Exception:
                    try:
                        proc.kill()
                    except Exception:
                        pass


def teardown_proxy(adb: str, serial: str, port: int, original: str = "") -> None:
    """Synchronously restore the device's original proxy + drop the reverse
    tunnel. Best-effort but must run on every exit path — a dangling proxy kills
    the device's internet. ``original`` is the value captured at enable time; the
    device is put back exactly as it was (or the proxy is deleted if it had none)."""
    if not adb or not serial:
        return
    for args in (restore_proxy_args(serial, original), reverse_remove_args(serial, port)):
        try:
            subprocess.run([adb, *args], capture_output=True, text=True, timeout=5)
        except (subprocess.SubprocessError, OSError):
            pass


# --- table delegates ----------------------------------------------------------
def _selection_fill(painter, option):
    if option.state & QStyle.StateFlag.State_Selected:
        c = QColor(option.palette.highlight().color())
        c.setAlpha(51)
        painter.fillRect(option.rect, c)


_ANDROID_GREEN = QColor("#3ddc84")


def _draw_android(painter: QPainter, rect):
    """Draw a small Android bugdroid head, centered in ``rect``."""
    cx = rect.x() + rect.width() / 2.0
    cy = rect.y() + rect.height() / 2.0
    painter.setPen(Qt.PenStyle.NoPen)
    painter.setBrush(_ANDROID_GREEN)
    head = QPainterPath()                       # dome: semicircle top, flat bottom
    head.moveTo(cx - 6, cy + 4)
    head.lineTo(cx - 6, cy)
    head.arcTo(cx - 6, cy - 6, 12, 12, 180, -180)
    head.lineTo(cx + 6, cy + 4)
    head.closeSubpath()
    painter.drawPath(head)
    pen = QPen(_ANDROID_GREEN, 1.3, Qt.PenStyle.SolidLine, Qt.PenCapStyle.RoundCap)
    painter.setPen(pen)
    painter.drawLine(QPointF(cx - 3.4, cy - 5.4), QPointF(cx - 5.4, cy - 8.4))   # antennae
    painter.drawLine(QPointF(cx + 3.4, cy - 5.4), QPointF(cx + 5.4, cy - 8.4))
    painter.setPen(Qt.PenStyle.NoPen)
    painter.setBrush(QColor(BG))
    painter.drawEllipse(QPointF(cx - 2.2, cy - 1.6), 0.95, 0.95)                 # eyes
    painter.drawEllipse(QPointF(cx + 2.2, cy - 1.6), 0.95, 0.95)


class _MethodDelegate(QStyledItemDelegate):
    """Leftmost column: a thin status-colored accent stripe + the method text."""

    def paint(self, painter, option, index):
        painter.save()
        _selection_fill(painter, option)
        accent = index.data(ACCENT_ROLE) or _C_DIM
        r = option.rect
        painter.fillRect(QRect(r.x(), r.y() + 1, 3, r.height() - 2), accent)
        text = index.data(Qt.ItemDataRole.DisplayRole) or ""
        color = index.data(Qt.ItemDataRole.ForegroundRole) or _C_TEXT
        f = QFont(option.font)
        f.setBold(True)
        painter.setFont(f)
        painter.setPen(color)
        painter.drawText(r.adjusted(12, 0, -4, 0),
                         int(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter), text)
        painter.restore()


class _SourceDelegate(QStyledItemDelegate):
    """Source column: the green Android bugdroid (all flows come from the device)."""

    def paint(self, painter, option, index):
        painter.save()
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        _selection_fill(painter, option)
        _draw_android(painter, option.rect)
        painter.restore()


# --- detail view (structured request / response with JSON highlighting) -------
class _JsonHighlighter(QSyntaxHighlighter):
    """Lightweight JSON coloring: keys, strings, numbers, keywords."""

    def __init__(self, document):
        super().__init__(document)
        self._str = _fmt("#8fbf6b")     # strings — green
        self._key = _fmt("#6f9ff0")     # object keys — blue
        self._num = _fmt("#e0a45e")     # numbers — amber
        self._kw = _fmt("#c58fe0")      # true / false / null — purple

    def highlightBlock(self, text):
        for m in re.finditer(r'"(?:[^"\\]|\\.)*"', text):
            self.setFormat(m.start(), m.end() - m.start(), self._str)
        for m in re.finditer(r'"(?:[^"\\]|\\.)*"(?=\s*:)', text):
            self.setFormat(m.start(), m.end() - m.start(), self._key)   # override key strings
        for m in re.finditer(r'(?<![\w"])-?\d+\.?\d*(?:[eE][+-]?\d+)?', text):
            self.setFormat(m.start(), m.end() - m.start(), self._num)
        for m in re.finditer(r'\b(?:true|false|null)\b', text):
            self.setFormat(m.start(), m.end() - m.start(), self._kw)


class _LineGutter(QWidget):
    def __init__(self, editor):
        super().__init__(editor)
        self._editor = editor

    def paintEvent(self, event):
        self._editor.paint_gutter(event)


class _CodeEdit(QPlainTextEdit):
    """Read-only viewer with a line-number gutter + JSON syntax highlighting."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setObjectName("FlowBody")
        self.setReadOnly(True)
        self.setFrameShape(QPlainTextEdit.Shape.NoFrame)
        self.setLineWrapMode(QPlainTextEdit.LineWrapMode.NoWrap)
        mono = QFont("SF Mono")
        mono.setStyleHint(QFont.StyleHint.Monospace)
        mono.setPointSize(11)
        self.setFont(mono)
        self._gutter = _LineGutter(self)
        self.blockCountChanged.connect(lambda _: self._refresh_margin())
        self.updateRequest.connect(self._on_update)
        self._refresh_margin()
        self._hl = _JsonHighlighter(self.document())

    def gutter_width(self) -> int:
        digits = max(2, len(str(max(1, self.blockCount()))))
        return 14 + QFontMetrics(self.font()).horizontalAdvance("9") * digits

    def _refresh_margin(self):
        self.setViewportMargins(self.gutter_width(), 0, 0, 0)

    def _on_update(self, rect, dy):
        if dy:
            self._gutter.scroll(0, dy)
        else:
            self._gutter.update(0, rect.y(), self._gutter.width(), rect.height())
        if rect.contains(self.viewport().rect()):
            self._refresh_margin()

    def resizeEvent(self, event):
        super().resizeEvent(event)
        cr = self.contentsRect()
        self._gutter.setGeometry(QRect(cr.left(), cr.top(), self.gutter_width(), cr.height()))

    def paint_gutter(self, event):
        painter = QPainter(self._gutter)
        painter.fillRect(event.rect(), QColor(SURFACE))
        block = self.firstVisibleBlock()
        num = block.blockNumber()
        top = self.blockBoundingGeometry(block).translated(self.contentOffset()).top()
        bottom = top + self.blockBoundingRect(block).height()
        painter.setPen(_C_DIM)
        fh = QFontMetrics(self.font()).height()
        while block.isValid() and top <= event.rect().bottom():
            if block.isVisible() and bottom >= event.rect().top():
                painter.drawText(0, int(top), self._gutter.width() - 6, fh,
                                 int(Qt.AlignmentFlag.AlignRight), str(num + 1))
            block = block.next()
            top = bottom
            bottom = top + self.blockBoundingRect(block).height()
            num += 1
        painter.end()


def _set_pill(label: QLabel, text: str, color: QColor):
    if not text:
        label.setVisible(False)
        return
    label.setVisible(True)
    label.setText(f"  {text}  ")
    label.setStyleSheet(
        f"QLabel{{background:rgba({color.red()},{color.green()},{color.blue()},0.16);"
        f"color:{color.name()};border-radius:6px;font-weight:700;}}")


class FlowDetail(QWidget):
    """Summary bar + stacked REQUEST / RESPONSE cards. Each section has its own
    collapse, JSON tree toggle, maximize (fill the panel), find, and copy."""

    copied = pyqtSignal(str)             # human message → status bar

    def __init__(self, parent=None):
        super().__init__(parent)
        self._flow = None
        v = QVBoxLayout(self)
        v.setContentsMargins(0, 0, 0, 0)
        v.setSpacing(0)

        summary = QWidget()
        summary.setObjectName("FlowSummary")
        sh = QHBoxLayout(summary)
        sh.setContentsMargins(12, 7, 12, 7)
        sh.setSpacing(8)
        self._method_lbl = QLabel()
        self._status_lbl = QLabel()
        for _p in (self._method_lbl, self._status_lbl):
            _p.setSizePolicy(QSizePolicy.Policy.Maximum, QSizePolicy.Policy.Fixed)
            _p.setFixedHeight(22)
        self._full_url = ""
        self._url_lbl = QLabel()
        self._url_lbl.setObjectName("FlowUrl")
        # A long URL must NOT force the pane wide — ignore its width hint and
        # elide the text to whatever room the summary bar has.
        self._url_lbl.setSizePolicy(QSizePolicy.Policy.Ignored, QSizePolicy.Policy.Preferred)
        self._meta_lbl = QLabel()
        self._meta_lbl.setObjectName("FlowMeta")
        sh.addWidget(self._method_lbl)
        sh.addWidget(self._status_lbl)
        sh.addWidget(self._url_lbl, 1)
        sh.addWidget(self._meta_lbl)
        # Fixed height so a collapsed/maximized section can never balloon the bar.
        summary.setFixedHeight(36)
        v.addWidget(summary)

        self._cards = QSplitter(Qt.Orientation.Vertical)
        self._req = self._make_panel("REQUEST", "req")
        self._resp = self._make_panel("RESPONSE", "resp")
        self._cards.addWidget(self._req["card"])
        self._cards.addWidget(self._resp["card"])
        self._cards.setSizes([300, 340])
        v.addWidget(self._cards, 1)
        self.clear()

    def _make_panel(self, title: str, kind: str) -> dict:
        card = QWidget()
        cv = QVBoxLayout(card)
        cv.setContentsMargins(0, 0, 0, 0)
        cv.setSpacing(0)

        bar = QWidget()
        bar.setObjectName("FlowSection")
        bh = QHBoxLayout(bar)
        bh.setContentsMargins(11, 3, 6, 3)
        bh.setSpacing(6)
        col_btn = QPushButton("▾")
        col_btn.setObjectName("toggle")
        col_btn.setCheckable(True)
        col_btn.setToolTip("Collapse / expand this section")
        hdr = QLabel(title)
        hdr.setObjectName("FlowSectionTitle")
        view_btn = QPushButton("Tree")
        view_btn.setObjectName("toggle")
        view_btn.setCheckable(True)
        view_btn.setToolTip("Switch the body between JSON tree and text view")
        search_btn = QPushButton("🔍")
        search_btn.setObjectName("toggle")
        search_btn.setCheckable(True)
        search_btn.setToolTip(f"Find in this {title.lower()}")
        max_btn = QPushButton("⛶")
        max_btn.setObjectName("toggle")
        max_btn.setCheckable(True)
        max_btn.setToolTip("Maximize this section to fill the panel")
        copy_h = QPushButton("⧉ Headers")
        copy_h.setObjectName("toggle")
        copy_h.setToolTip("Copy the headers to the clipboard")
        copy_b = QPushButton("⧉ Body")
        copy_b.setObjectName("toggle")
        copy_b.setToolTip("Copy the body to the clipboard")
        copy_h.clicked.connect(lambda: self._copy(kind, "headers"))
        copy_b.clicked.connect(lambda: self._copy(kind, "body"))
        bh.addWidget(col_btn)
        bh.addWidget(hdr)
        bh.addStretch(1)
        bh.addWidget(view_btn)
        bh.addWidget(search_btn)
        bh.addWidget(max_btn)
        bh.addWidget(copy_h)
        bh.addWidget(copy_b)
        cv.addWidget(bar)

        # Per-section find bar (hidden until 🔍 is toggled).
        search_bar = QWidget()
        search_bar.setObjectName("FlowSearch")
        search_bar.setSizePolicy(QSizePolicy.Policy.Preferred, QSizePolicy.Policy.Fixed)
        seh = QHBoxLayout(search_bar)
        seh.setContentsMargins(11, 4, 6, 4)
        seh.setSpacing(6)
        search_edit = QLineEdit()
        search_edit.setPlaceholderText(f"Find in {title.lower()}…")
        search_count = QLabel("")
        search_count.setObjectName("FlowMeta")
        sprev = QPushButton("‹")
        sprev.setObjectName("toggle")
        sprev.setToolTip("Previous match")
        snext = QPushButton("›")
        snext.setObjectName("toggle")
        snext.setToolTip("Next match  (⏎)")
        sclose = QPushButton("✕")
        sclose.setObjectName("toggle")
        sclose.setToolTip("Close find  (Esc)")
        seh.addWidget(search_edit, 1)
        seh.addWidget(search_count)
        seh.addWidget(sprev)
        seh.addWidget(snext)
        seh.addWidget(sclose)
        search_bar.setVisible(False)
        cv.addWidget(search_bar)

        inner = QSplitter(Qt.Orientation.Vertical)
        headers = QTextBrowser()
        headers.setObjectName("FlowHeaders")
        headers.setFrameShape(QTextBrowser.Shape.NoFrame)
        # The body area swaps between the JSON tree and the text/code view.
        body = _CodeEdit()
        tree = QTreeWidget()
        tree.setObjectName("FlowTree")
        tree.setColumnCount(2)
        tree.setHeaderLabels(["Key", "Value"])
        tree.setFrameShape(QTreeWidget.Shape.NoFrame)
        tree.setFont(body.font())
        tree.header().setStretchLastSection(True)
        tree.setColumnWidth(0, 220)
        stack = QStackedWidget()
        stack.addWidget(body)   # index 0 = text
        stack.addWidget(tree)   # index 1 = tree
        inner.addWidget(headers)
        inner.addWidget(stack)
        inner.setSizes([120, 320])
        cv.addWidget(inner, 1)

        panel = {"card": card, "bar": bar, "inner": inner, "hdr": hdr, "headers": headers,
                 "body": body, "tree": tree, "stack": stack, "view_btn": view_btn,
                 "col_btn": col_btn, "max_btn": max_btn, "search_btn": search_btn,
                 "search_bar": search_bar, "search_edit": search_edit,
                 "search_count": search_count, "search_i": 0, "text": ""}
        view_btn.toggled.connect(lambda checked, p=panel: self._toggle_view(p, checked))
        col_btn.toggled.connect(lambda collapsed, p=panel: self._toggle_collapse(p, collapsed))
        max_btn.toggled.connect(lambda on, p=panel: self._toggle_max(p, on))
        search_btn.toggled.connect(lambda on, p=panel: self._toggle_search(p, on))
        search_edit.textChanged.connect(lambda _t, p=panel: self._update_count(p))
        search_edit.returnPressed.connect(lambda p=panel: self._find(p, False))
        snext.clicked.connect(lambda _c=False, p=panel: self._find(p, False))
        sprev.clicked.connect(lambda _c=False, p=panel: self._find(p, True))
        sclose.clicked.connect(lambda _c=False, b=search_btn: b.setChecked(False))
        QShortcut(QKeySequence(Qt.Key.Key_Escape), search_edit,
                  activated=lambda b=search_btn: b.setChecked(False))
        return panel

    # --- per-section collapse / maximize -----------------------------------
    def _toggle_collapse(self, panel: dict, collapsed: bool):
        if collapsed and panel["max_btn"].isChecked():
            panel["max_btn"].setChecked(False)   # can't be maximized and collapsed
        panel["inner"].setVisible(not collapsed)
        panel["search_bar"].setVisible(False if collapsed else panel["search_btn"].isChecked())
        panel["col_btn"].setText("▸" if collapsed else "▾")
        if collapsed:
            panel["card"].setMaximumHeight(panel["bar"].sizeHint().height())
        else:
            panel["card"].setMaximumHeight(16777215)

    def _toggle_max(self, panel: dict, on: bool):
        """Maximize one section: hide the other so this fills the whole panel."""
        other = self._resp if panel is self._req else self._req
        if on:
            if panel["col_btn"].isChecked():
                panel["col_btn"].setChecked(False)      # expand it first
            if other["max_btn"].isChecked():
                other["max_btn"].blockSignals(True)
                other["max_btn"].setChecked(False)
                other["max_btn"].blockSignals(False)
            other["card"].setVisible(False)
        else:
            other["card"].setVisible(True)

    # --- per-section find --------------------------------------------------
    def _toggle_search(self, panel: dict, on: bool):
        panel["search_bar"].setVisible(on)
        if on:
            if panel["view_btn"].isChecked():
                panel["view_btn"].setChecked(False)     # show text so matches are visible
            panel["search_i"] = 0
            panel["search_edit"].setFocus()
            panel["search_edit"].selectAll()
            self._update_count(panel)
        else:
            panel["search_edit"].clear()

    def _update_count(self, panel: dict):
        term = panel["search_edit"].text().lower()
        if not term:
            panel["search_count"].setText("")
            return
        total = (panel["headers"].toPlainText().lower().count(term)
                 + panel["body"].toPlainText().lower().count(term))
        panel["search_count"].setText(f"{total} match" + ("" if total == 1 else "es"))

    def _find(self, panel: dict, backward: bool):
        term = panel["search_edit"].text()
        if not term:
            return
        targets = [panel["headers"], panel["body"]]
        for _ in range(len(targets) + 1):
            w = targets[panel["search_i"]]
            found = (w.find(term, QTextDocument.FindFlag.FindBackward) if backward
                     else w.find(term))
            if found:
                w.setFocus()
                return
            panel["search_i"] = (panel["search_i"] + (-1 if backward else 1)) % len(targets)
            nxt = targets[panel["search_i"]]
            cur = nxt.textCursor()
            cur.movePosition(QTextCursor.MoveOperation.End if backward
                             else QTextCursor.MoveOperation.Start)
            nxt.setTextCursor(cur)

    def _set_body(self, panel: dict, text: str):
        """Set a panel's body text and keep the tree/text toggle in sync."""
        panel["text"] = text
        panel["body"].setPlainText(text)
        is_json = looks_json(text)
        panel["view_btn"].setEnabled(is_json)
        if not is_json:
            panel["view_btn"].blockSignals(True)
            panel["view_btn"].setChecked(False)
            panel["view_btn"].setText("Tree")
            panel["view_btn"].blockSignals(False)
            panel["stack"].setCurrentIndex(0)
        elif panel["view_btn"].isChecked():
            populate_json_tree(panel["tree"], text)
            panel["stack"].setCurrentIndex(1)
        else:
            panel["stack"].setCurrentIndex(0)

    def _toggle_view(self, panel: dict, checked: bool):
        if checked and populate_json_tree(panel["tree"], panel["text"]):
            panel["stack"].setCurrentIndex(1)
            panel["view_btn"].setText("Text")
        else:
            panel["stack"].setCurrentIndex(0)
            panel["view_btn"].setText("Tree")

    def _copy(self, kind: str, part: str):
        f = self._flow
        if f is None:
            self.copied.emit("Select a request first")
            return
        headers = f.req_headers if kind == "req" else f.resp_headers
        if part == "headers":
            text = "\n".join(f"{k}: {v}" for k, v in headers)
        elif kind == "req":
            text = pretty_body(f.req_body, f.req_headers)
        elif f.body_captured:
            text = pretty_body(f.resp_body, f.resp_headers)
        else:
            text = f.note or ""
        QGuiApplication.clipboard().setText(text)
        who = "request" if kind == "req" else "response"
        self.copied.emit(f"Copied {who} {part}" if text else f"{who} {part} is empty")

    def set_flow(self, f):
        if f is None:
            self.clear()
            return
        self._flow = f
        _set_pill(self._method_lbl, f.method, _method_color(f.method))
        _set_pill(self._status_lbl, "" if f.status is None else str(f.status),
                  _status_color(f.status))
        self._full_url = f.url
        self._url_lbl.setToolTip(f.url)
        self._elide_url()
        meta = []
        if f.duration_ms is not None:
            meta.append(f"{f.duration_ms} ms")
        if f.resp_size:
            meta.append(_human_size(f.resp_size))
        self._meta_lbl.setText("   ·   ".join(meta))

        self._req["hdr"].setText("REQUEST")
        self._req["headers"].setHtml(_headers_html(list(f.req_headers)))
        self._set_body(self._req, pretty_body(f.req_body, f.req_headers))

        if not f.body_captured:
            self._resp["hdr"].setText("RESPONSE")
            self._resp["headers"].setHtml("")
            self._set_body(self._resp, f.note or "encrypted (metadata only)")
        else:
            self._resp["hdr"].setText(
                f"RESPONSE · {f.status}" if f.status is not None else "RESPONSE")
            self._resp["headers"].setHtml(_headers_html(list(f.resp_headers)))
            self._set_body(self._resp, pretty_body(f.resp_body, f.resp_headers))

        for p in (self._req, self._resp):
            p["search_i"] = 0
            if p["search_bar"].isVisible():
                self._update_count(p)

    def clear(self):
        self._flow = None
        self._method_lbl.setVisible(False)
        self._status_lbl.setVisible(False)
        self._full_url = "Select a request to inspect"
        self._url_lbl.setToolTip("")
        self._elide_url()
        self._meta_lbl.setText("")
        for p in (self._req, self._resp):
            p["headers"].setHtml("")
            self._set_body(p, "")
        self._req["hdr"].setText("REQUEST")
        self._resp["hdr"].setText("RESPONSE")

    def _elide_url(self):
        avail = max(40, self._url_lbl.width())
        fm = self._url_lbl.fontMetrics()
        self._url_lbl.setText(fm.elidedText(self._full_url, Qt.TextElideMode.ElideRight, avail))

    def resizeEvent(self, event):
        super().resizeEvent(event)
        self._elide_url()


# --- the Intercept tab --------------------------------------------------------
_METHODS = ["All methods", "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]
_STATUS_CLASSES = [("All status", 0), ("2xx", 2), ("3xx", 3), ("4xx", 4), ("5xx", 5)]
_ERR_STYLE = "border: 1px solid #e2554e; border-radius: 3px;"
FLOW_FLUSH_MS = 100


class InterceptView(QWidget):
    """Flow table + request/response detail + a control bar. Owns the proxy
    engine for one device; started only when the user hits Enable Intercept."""

    status = pyqtSignal(str)             # transient status-bar text
    failed = pyqtSignal(str)             # error -> status bar + box
    saved = pyqtSignal(bool, str, str)   # save-body: ok, message, directory

    def __init__(self, adb: str, parent=None):
        super().__init__(parent)
        self.adb = adb or ""
        self._serial: str | None = None
        self._enabled = False
        self._engine: QThread | None = None
        self._setup_worker: ProxySetupWorker | None = None
        self._cert_worker: CertPushWorker | None = None
        self._active_serial: str | None = None
        self._active_port = DEFAULT_PORT
        self._orig_proxy = ""                # device's proxy before we wired it, to restore
        self._watchdog: QProcess | None = None   # on-device self-heal if the link drops
        self._engine_is_mitm = False
        self._fell_back = False
        self._seq = 0
        self._pending: list[Flow] = []
        self.model = FlowTableModel()
        self._build_ui()

        self._flush_timer = QTimer(self)
        self._flush_timer.timeout.connect(self._flush)
        self._flush_timer.start(FLOW_FLUSH_MS)

    # --- construction ------------------------------------------------------
    def _build_ui(self):
        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)

        # Filter bar (top) — mirrors the Logs tab filter bar.
        fbar = QWidget()
        fbar.setObjectName("FilterBar")
        fb = QHBoxLayout(fbar)
        fb.setContentsMargins(12, 8, 12, 8)
        fb.setSpacing(8)
        self.method_combo = QComboBox()
        self.method_combo.addItems(_METHODS)
        self.status_combo = QComboBox()
        for name, cls in _STATUS_CLASSES:
            self.status_combo.addItem(name, cls)
        self.find_edit = QLineEdit()
        self.find_edit.setPlaceholderText("filter host + path…")
        self.find_regex_btn = QPushButton(".*")
        self.find_regex_btn.setObjectName("toggle")
        self.find_regex_btn.setCheckable(True)
        self.find_regex_btn.setToolTip("Treat filter as a regular expression")
        self.curl_btn = QPushButton("Copy cURL")
        self.curl_btn.setObjectName("toggle")
        self.curl_btn.setToolTip("Copy the selected request as a curl command")
        self.save_btn = QPushButton("Save Body")
        self.save_btn.setObjectName("toggle")
        self.save_btn.setToolTip("Save the selected response body to a file")
        self.download_btn = QPushButton("⬇ Download")
        self.download_btn.setObjectName("toggle")
        self.download_btn.setToolTip("Download everything about this request "
                                     "(URL, request + response headers and bodies)")
        self.clear_btn = QPushButton("Clear")
        self.clear_btn.setObjectName("toggle")
        fb.addWidget(QLabel("Method"))
        fb.addWidget(self.method_combo)
        fb.addWidget(self.status_combo)
        fb.addWidget(QLabel("Find"))
        fb.addWidget(self.find_edit, 1)
        fb.addWidget(self.find_regex_btn)
        fb.addStretch(0)
        fb.addWidget(self.curl_btn)
        fb.addWidget(self.save_btn)
        fb.addWidget(self.download_btn)
        fb.addWidget(self.clear_btn)
        root.addWidget(fbar)

        # Request list (left) + detail (right), HTTP-Toolkit style.
        split = QSplitter(Qt.Orientation.Horizontal)
        self.table = QTableView()
        self.table.setObjectName("FlowTable")
        self.table.setModel(self.model)
        self.table.setShowGrid(True)     # thin dark separator between rows
        self.table.setAlternatingRowColors(False)
        self.table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.table.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self.table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.table.setFrameShape(QAbstractItemView.Shape.NoFrame)
        self.table.setTextElideMode(Qt.TextElideMode.ElideRight)
        vh = self.table.verticalHeader()
        vh.setVisible(False)
        vh.setDefaultSectionSize(30)
        header = self.table.horizontalHeader()
        header.setHighlightSections(False)
        header.setStretchLastSection(False)
        header.setSectionResizeMode(QHeaderView.ResizeMode.Interactive)
        header.setSectionResizeMode(COL_PATH, QHeaderView.ResizeMode.Stretch)
        self.table.setColumnWidth(COL_METHOD, 66)
        self.table.setColumnWidth(COL_STATUS, 54)
        self.table.setColumnWidth(COL_SOURCE, 40)
        self.table.setColumnWidth(COL_HOST, 200)
        # Size / Type / Time live in the detail summary — keep the left list lean.
        for c in (COL_TYPE, COL_SIZE, COL_TIME):
            self.table.setColumnHidden(c, True)
        self.table.setItemDelegateForColumn(COL_METHOD, _MethodDelegate(self.table))
        self.table.setItemDelegateForColumn(COL_SOURCE, _SourceDelegate(self.table))
        split.addWidget(self.table)

        self.table.setMinimumWidth(260)
        self.detail = FlowDetail()
        self.detail.setMinimumWidth(340)
        self.detail.copied.connect(self._toast)   # copy feedback → toast + status bar
        split.addWidget(self.detail)
        split.setStretchFactor(0, 3)
        split.setStretchFactor(1, 2)
        split.setSizes([780, 560])
        root.addWidget(split, 1)

        # Floating "copied" toast — a child positioned over the view, not in the layout.
        self._toast_lbl = QLabel("", self)
        self._toast_lbl.setObjectName("Toast")
        self._toast_lbl.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._toast_lbl.setVisible(False)
        self._toast_timer = QTimer(self)
        self._toast_timer.setSingleShot(True)
        self._toast_timer.timeout.connect(self._toast_lbl.hide)

        # Control bar (bottom) — mirrors the Location tab's control bar.
        bar = QWidget()
        bar.setObjectName("InterceptBar")
        h = QHBoxLayout(bar)
        h.setContentsMargins(12, 8, 12, 8)
        h.setSpacing(8)
        self.enable_btn = QPushButton("Enable Intercept")
        self.enable_btn.setObjectName("start")           # reuse green→red styling
        self.enable_btn.setCheckable(True)
        self.enable_btn.setProperty("running", "false")
        self.enable_btn.setToolTip("Route the device's HTTP(S) traffic through this app")
        h.addWidget(self.enable_btn)
        h.addSpacing(6)
        h.addWidget(QLabel("Port"))
        self.port_spin = QSpinBox()
        self.port_spin.setRange(1024, 65535)
        self.port_spin.setValue(DEFAULT_PORT)
        self.port_spin.setMaximumWidth(90)
        h.addWidget(self.port_spin)
        self.decrypt_btn = QPushButton("Decrypt HTTPS")
        self.decrypt_btn.setObjectName("toggle")
        self.decrypt_btn.setCheckable(True)
        self.cert_btn = QPushButton("Install CA Cert")
        self.cert_btn.setObjectName("toggle")
        if have_mitmproxy():
            self.decrypt_btn.setChecked(True)   # decrypt on by default when available
            self.decrypt_btn.setToolTip("Decrypt HTTPS via mitmproxy (needs its CA cert on the device)")
            self.cert_btn.setToolTip("Push mitmproxy's CA cert to the device's Download folder to install")
        else:
            self.decrypt_btn.setEnabled(False)
            self.decrypt_btn.setToolTip("Install mitmproxy (brew install mitmproxy) to decrypt HTTPS")
            self.cert_btn.setEnabled(False)
            self.cert_btn.setToolTip("Install mitmproxy (brew install mitmproxy) first")
        h.addWidget(self.decrypt_btn)
        h.addWidget(self.cert_btn)
        h.addStretch(1)
        self.status_label = QLabel("Select a device, then Enable Intercept")
        self.status_label.setObjectName("InterceptStatus")
        h.addWidget(self.status_label)
        root.addWidget(bar)

        # wiring
        self.enable_btn.toggled.connect(self._on_enable_toggled)
        self.decrypt_btn.toggled.connect(self._on_decrypt_toggled)
        self.cert_btn.clicked.connect(self._install_cert)
        self.table.selectionModel().selectionChanged.connect(self._on_selection)
        self.method_combo.currentIndexChanged.connect(self._apply_filter)
        self.status_combo.currentIndexChanged.connect(self._apply_filter)
        self.find_regex_btn.toggled.connect(self._apply_filter)
        self.find_edit.textChanged.connect(self._apply_filter)
        self.curl_btn.clicked.connect(self._copy_curl)
        self.save_btn.clicked.connect(self._save_body)
        self.download_btn.clicked.connect(self._download_flow)
        self.clear_btn.clicked.connect(self._clear)

    # --- device lifecycle --------------------------------------------------
    def set_serial(self, serial: str | None):
        if serial == self._serial:
            return
        if self._enabled:
            self._disable()          # tear down the old device before switching
        self._serial = serial
        self._set_status("Select a device, then Enable Intercept" if serial
                         else "No device selected")

    def shutdown(self):
        """Stop capture + clear the device proxy on app close (critical)."""
        if self._cert_worker is not None:
            self._cert_worker.wait(5000)
        if self._enabled:
            self._disable()

    # --- enable / disable --------------------------------------------------
    def _on_enable_toggled(self, checked: bool):
        if checked:
            if not self.adb or not self._serial:
                self._flash("No device selected")
                self._set_toggle(False)
                return
            self._begin_enable()
        else:
            self._disable()

    def _begin_enable(self):
        if self._setup_worker is not None:
            return
        self._active_serial = self._serial
        self._active_port = self.port_spin.value()
        self._fell_back = False
        self.enable_btn.setEnabled(False)
        self.port_spin.setEnabled(False)
        self._set_status("Wiring device proxy…")
        self._setup_worker = ProxySetupWorker(self.adb, self._active_serial, self._active_port)
        self._setup_worker.done.connect(self._on_setup_done)
        self._setup_worker.start()

    def _on_setup_done(self, ok: bool, message: str, original: str = ""):
        if self._setup_worker is not None:
            self._setup_worker.wait(3000)   # let the thread fully finish before GC
        self._setup_worker = None
        self._orig_proxy = original         # restore exactly this on teardown
        self.enable_btn.setEnabled(True)
        if not ok:
            self.port_spin.setEnabled(True)
            self._set_toggle(False)
            self._set_status("Proxy setup failed")
            self.failed.emit(message)
            return
        self._enabled = True
        self._start_watchdog()          # self-heal the proxy if the device drops
        self._set_toggle(True)
        self._start_engine()

    def _start_engine(self):
        want_mitm = self.decrypt_btn.isChecked() and have_mitmproxy()
        self._engine_is_mitm = want_mitm
        engine = MitmdumpWorker(self._active_port) if want_mitm else InterceptWorker(self._active_port)
        engine.flow.connect(self._on_flow)
        engine.started.connect(self._on_engine_started)
        engine.failed.connect(self._on_engine_failed)
        self._engine = engine
        engine.start()
        if want_mitm:
            self._maybe_prompt_cert()

    def _maybe_prompt_cert(self):
        """Guide the CA-cert install only the FIRST time for this device; on
        later runs the already-installed cert keeps working — no re-nag."""
        serial = self._active_serial
        if serial and not _cert_marker(serial).exists():
            self._install_cert()   # first time on this device → push + open Settings + guide
        else:
            self.status.emit("Decrypting HTTPS — CA cert already set up "
                             "(click Install CA Cert if bodies don't appear)")

    def _stop_engine(self):
        if self._engine is not None:
            self._engine.stop()
            self._engine.wait(3000)
            self._engine = None

    def _start_watchdog(self):
        """Hold an ``adb shell`` open on the device that restores the original
        proxy if the connection drops without us tearing it down (unplug, reboot,
        adb kill, app crash)."""
        self._stop_watchdog()
        if not self.adb or not self._active_serial:
            return
        wd = QProcess(self)
        wd.finished.connect(self._on_watchdog_finished)
        wd.start(self.adb, ["-s", self._active_serial, "shell",
                            proxy_watchdog_script(self._orig_proxy)])
        self._watchdog = wd

    def _stop_watchdog(self):
        """Ask the device watchdog to exit *without* restoring (the host restores
        synchronously on a normal stop) — a byte on its stdin releases its
        ``read`` and disarms the trap."""
        wd = self._watchdog
        self._watchdog = None
        if wd is None:
            return
        try:
            wd.finished.disconnect()           # deliberate stop → don't treat as a disconnect
        except (TypeError, RuntimeError):
            pass
        try:
            if wd.state() != QProcess.ProcessState.NotRunning:
                wd.write(b"\n")
                wd.closeWriteChannel()
                if not wd.waitForFinished(1500):
                    wd.kill()
                    wd.waitForFinished(1000)
        except (RuntimeError, OSError):
            pass

    def _on_watchdog_finished(self, *_):
        """Reached only when the watchdog dies on its own — i.e. the device
        dropped. Its on-device trap has already restored the proxy; stop cleanly."""
        self._watchdog = None
        if self._enabled:
            self.status.emit("Device disconnected — intercept stopped; "
                             "device proxy restored on-device")
            self._disable()

    def _disable(self):
        was = self._enabled
        self._enabled = False
        self._stop_engine()
        self._stop_watchdog()
        if was and self._active_serial:
            teardown_proxy(self.adb, self._active_serial, self._active_port,
                           self._orig_proxy)
        self.port_spin.setEnabled(True)
        self._set_toggle(False)
        self._set_status("Intercept off")
        if was:
            restored = "restored" if self._orig_proxy and \
                not self._orig_proxy.lower().startswith(("null", ":0", "127.0.0.1:")) \
                else "cleared"
            self.status.emit(f"Intercept disabled — device proxy {restored}")

    def _on_decrypt_toggled(self, _checked: bool):
        # Swap engines in place (device wiring stays up) while enabled.
        if self._enabled:
            self._stop_engine()
            self._fell_back = False
            self._start_engine()

    def _on_engine_started(self, port: int):
        mode = "decrypting HTTPS" if self._engine_is_mitm else "capturing"
        self._set_status(f"Intercept on — {mode} · port {port} · {self._active_serial}")

    def _on_engine_failed(self, message: str):
        if self._engine_is_mitm and not self._fell_back:
            # mitmdump couldn't start — fall back to the built-in engine.
            self._fell_back = True
            self._stop_engine()
            self.decrypt_btn.blockSignals(True)
            self.decrypt_btn.setChecked(False)
            self.decrypt_btn.blockSignals(False)
            self._engine_is_mitm = False
            self.status.emit(f"mitmproxy unavailable ({message}); using built-in capture")
            engine = InterceptWorker(self._active_port)
            engine.flow.connect(self._on_flow)
            engine.started.connect(self._on_engine_started)
            engine.failed.connect(self._on_engine_failed)
            self._engine = engine
            engine.start()
            return
        self.failed.emit(message)
        self._disable()

    # --- flow ingest -------------------------------------------------------
    def _on_flow(self, flow: Flow):
        self._seq += 1
        flow.id = self._seq
        self._pending.append(flow)

    def _flush(self):
        if not self._pending:
            return
        batch = self._pending
        self._pending = []
        at_bottom = self._at_bottom()
        self.model.append_batch(batch)
        if at_bottom:
            self.table.scrollToBottom()

    def _at_bottom(self) -> bool:
        sb = self.table.verticalScrollBar()
        return sb.value() >= sb.maximum() - 4

    # --- filtering ---------------------------------------------------------
    def _apply_filter(self, *_):
        method = self.method_combo.currentText()
        spec = FlowFilterSpec(
            method="" if method == _METHODS[0] else method,
            status_class=self.status_combo.currentData() or 0,
            text_query=self.find_edit.text().strip(),
            text_regex=self.find_regex_btn.isChecked(),
        ).compile()
        self.model.set_filter(spec)
        self.find_edit.setStyleSheet(_ERR_STYLE if spec.has_error("text") else "")

    # --- detail / actions --------------------------------------------------
    def _selected_flow(self) -> Flow | None:
        rows = self.table.selectionModel().selectedRows()
        if not rows:
            return None
        row = rows[-1].row()
        if 0 <= row < self.model.rowCount():
            return self.model.flow_at(row)
        return None

    def _on_selection(self, *_):
        self.detail.set_flow(self._selected_flow())

    # --- toast feedback ----------------------------------------------------
    def _toast(self, text: str):
        self.status.emit(text)   # keep the status-bar line too
        mark = "✓ " if text.lower().startswith("copied") else ""
        self._toast_lbl.setText(f"  {mark}{text}  ")
        self._toast_lbl.adjustSize()
        self._reposition_toast()
        self._toast_lbl.show()
        self._toast_lbl.raise_()
        self._toast_timer.start(1600)

    def _reposition_toast(self):
        w, h = self._toast_lbl.width(), self._toast_lbl.height()
        x = (self.width() - w) // 2
        y = self.height() - h - 46          # float just above the bottom control bar
        self._toast_lbl.move(max(8, x), max(8, y))

    def resizeEvent(self, event):
        super().resizeEvent(event)
        if self._toast_lbl.isVisible():
            self._reposition_toast()

    def _copy_curl(self):
        f = self._selected_flow()
        if f is None:
            self._flash("Select a request first")
            return
        QGuiApplication.clipboard().setText(flow_to_curl(f))
        self._toast("Copied cURL")

    def _save_body(self):
        f = self._selected_flow()
        if f is None or not f.resp_body:
            self._flash("Select a request with a captured response body")
            return
        import os
        data = decode_body(f.resp_body, f.resp_headers)   # save the decompressed body
        default = os.path.join(os.path.expanduser("~/Downloads"),
                               (f.path.rstrip("/").split("/")[-1] or "response") + ".bin")
        path, _ = QFileDialog.getSaveFileName(self, "Save response body", default)
        if not path:
            return
        try:
            with open(path, "wb") as fh:
                fh.write(data)
        except OSError as exc:
            self.saved.emit(False, f"Save failed: {exc}", "")
            return
        self.saved.emit(True, f"Saved {_human_size(len(data))} to {os.path.basename(path)}",
                        os.path.dirname(path))

    def _download_flow(self):
        f = self._selected_flow()
        if f is None:
            self._flash("Select a request first")
            return
        import os
        stem = "".join(c if (c.isalnum() or c in "._-") else "_"
                       for c in (f.host + f.path.split("?")[0]))[:80].strip("_") or "flow"
        default = os.path.join(os.path.expanduser("~/Downloads"), stem + ".txt")
        path, _ = QFileDialog.getSaveFileName(self, "Download request + response", default)
        if not path:
            return
        try:
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(build_flow_export(f))
        except OSError as exc:
            self.saved.emit(False, f"Download failed: {exc}", "")
            return
        self.saved.emit(True, f"Downloaded {os.path.basename(path)}", os.path.dirname(path))

    def _clear(self):
        self.model.clear()
        self._pending.clear()
        self.detail.clear()

    def _install_cert(self):
        """Push mitmproxy's CA cert to the device so the user can install it."""
        if not self.adb or not self._serial:
            self._flash("Select a device first")
            return
        if not have_mitmproxy():
            self._flash("Install mitmproxy first (brew install mitmproxy)")
            return
        if self._cert_worker is not None:
            return
        self.cert_btn.setEnabled(False)
        self._set_status("Pushing CA cert to the device…")
        self._cert_worker = CertPushWorker(self.adb, self._serial)
        self._cert_worker.done.connect(self._on_cert_pushed)
        self._cert_worker.start()

    def _on_cert_pushed(self, ok: bool, message: str, device_dir: str):
        if self._cert_worker is not None:
            self._cert_worker.wait(3000)   # let the thread fully finish before GC
        self._cert_worker = None
        self.cert_btn.setEnabled(have_mitmproxy())
        if not ok:
            self._set_status("CA cert push failed")
            self.failed.emit(message)
            return
        self.status.emit(message)
        # Remember we've set this device up, so we don't nag on every future run.
        serial = self._serial or self._active_serial
        if serial:
            try:
                _cert_marker(serial).write_text("installed\n")
            except OSError:
                pass
        # Jump the device straight to its Security settings to speed up the install.
        if self.adb and self._serial:
            QProcess.startDetached(self.adb, ["-s", self._serial, "shell", "input",
                                              "keyevent", "KEYCODE_WAKEUP"])
            QProcess.startDetached(self.adb, ["-s", self._serial, "shell", "am", "start",
                                              "-a", "android.settings.SECURITY_SETTINGS"])
        self._show_cert_dialog()

    def _show_cert_dialog(self):
        box = QMessageBox(self)
        box.setModal(False)
        box.setIcon(QMessageBox.Icon.Information)
        box.setWindowTitle("Install the CA certificate on the device")
        box.setText("mitmproxy-ca-cert.cer was copied to the device's Download folder.")
        box.setInformativeText(
            "On the device (Security settings just opened), install it as a user CA:\n"
            "  • Samsung: Biometrics and security → Other security settings →\n"
            "    Install from device storage → CA certificate → pick mitmproxy-ca-cert.cer\n"
            "  • Stock Android: Encryption & credentials → Install a certificate →\n"
            "    CA certificate → pick the file\n\n"
            "Then keep Decrypt HTTPS on. Note: on a non-rooted device only browsers, "
            "WebViews, debuggable apps, and apps that opt in will trust it; cert-pinned "
            "apps and QUIC/HTTP-3 won't be captured.")
        box.show()

    # --- small helpers -----------------------------------------------------
    def _set_toggle(self, on: bool):
        self.enable_btn.blockSignals(True)
        self.enable_btn.setChecked(on)
        self.enable_btn.blockSignals(False)
        self.enable_btn.setText("Disable Intercept" if on else "Enable Intercept")
        self.enable_btn.setProperty("running", "true" if on else "false")
        self.enable_btn.style().unpolish(self.enable_btn)
        self.enable_btn.style().polish(self.enable_btn)

    def _set_status(self, text: str):
        self.status_label.setText(text)

    def _flash(self, text: str):
        self._set_status(text)
        self.status.emit(text)
