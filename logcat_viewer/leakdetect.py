"""Memory-leak detection over adb using LeakCanary's Shark analyzer.

No app changes needed: we capture a managed heap dump of a **debuggable** app
with ``am dumpheap`` (any app on a rooted device), pull the ``.hprof``, and run
Shark's ``analyze`` command on it — producing the same leak traces LeakCanary
prints in-app (application leaks + shortest path to the GC root).

Shark ships only thin jars on Maven (its CLI drags in neo4j for an interactive
mode we don't use), so we provision just the jars the ``analyze`` path needs and
invoke ``shark.MainKt`` directly. The Java runtime + downloads reuse the same
machinery as the jadx decompiler (`decompile.py`), cached under
``~/Library/Application Support/AndroidLab/tools``.
"""
from __future__ import annotations

import html
import os
import re
import subprocess
import time
import urllib.error

from PyQt6.QtCore import pyqtSignal, QUrl
from PyQt6.QtGui import QDesktopServices
from PyQt6.QtWidgets import (
    QFileDialog, QHBoxLayout, QLabel, QPushButton, QVBoxLayout, QWidget,
)
from PyQt6.QtCore import QThread

from .decompile import (
    CancelledError, _download, cached_jre_java, download_jre, system_java, tools_dir,
)
from . import theme
from .theme import GREEN, RED, TEXT

SHARK_VERSION = "2.14"
SHARK_MAIN = "shark.MainKt"
_MAVEN = "https://repo1.maven.org/maven2"

# The exact jar set the `analyze` command needs (neo4j/interactive deps omitted —
# they're only class-loaded by the `neo4j`/`interactive` commands). (path, artifact, version)
_SHARK_JARS = [
    ("com/squareup/leakcanary", "shark-cli", SHARK_VERSION),
    ("com/squareup/leakcanary", "shark-android", SHARK_VERSION),
    ("com/squareup/leakcanary", "shark", SHARK_VERSION),
    ("com/squareup/leakcanary", "shark-graph", SHARK_VERSION),
    ("com/squareup/leakcanary", "shark-hprof", SHARK_VERSION),
    ("com/squareup/leakcanary", "shark-log", SHARK_VERSION),
    ("org/jetbrains/kotlin", "kotlin-stdlib", "1.3.72"),
    ("org/jetbrains/kotlin", "kotlin-reflect", "1.3.72"),
    ("org/jetbrains", "annotations", "13.0"),
    ("com/squareup/okio", "okio", "2.2.2"),
    ("com/github/ajalt", "clikt", "2.3.0"),
    ("jline", "jline", "2.14.6"),
]


def shark_dir() -> str:
    d = os.path.join(tools_dir(), f"shark-{SHARK_VERSION}")
    os.makedirs(d, exist_ok=True)
    return d


def _jar_path(artifact: str, version: str) -> str:
    return os.path.join(shark_dir(), f"{artifact}-{version}.jar")


def cached_shark() -> str | None:
    """Classpath string if every jar is already downloaded, else None."""
    paths = [_jar_path(a, v) for _p, a, v in _SHARK_JARS]
    return os.pathsep.join(paths) if all(os.path.exists(p) for p in paths) else None


def download_shark(progress, is_cancelled) -> str | None:
    for i, (path, art, ver) in enumerate(_SHARK_JARS, 1):
        dest = _jar_path(art, ver)
        if os.path.exists(dest):
            continue
        url = f"{_MAVEN}/{path}/{art}/{ver}/{art}-{ver}.jar"
        try:
            _download(url, dest, progress, is_cancelled,
                      f"Shark {i}/{len(_SHARK_JARS)} ({art})")
        except CancelledError:
            raise
        except (OSError, urllib.error.URLError):
            if os.path.exists(dest):
                try:
                    os.remove(dest)
                except OSError:
                    pass
            return None
    return cached_shark()


def provision_shark(progress, is_cancelled) -> tuple[str, str]:
    """Return (java_binary, classpath). Downloads Java and/or the Shark jars if
    missing. Raises RuntimeError on failure, CancelledError if cancelled."""
    java = system_java() or cached_jre_java()
    if not java:
        java = download_jre(progress, is_cancelled)
    if not java:
        raise RuntimeError("Java not found and the JRE download failed. Install "
                           "Java (e.g. `brew install openjdk`) or set JAVA_HOME.")
    cp = cached_shark() or download_shark(progress, is_cancelled)
    if not cp:
        raise RuntimeError("Could not download the Shark analyzer jars "
                           "(check your network connection).")
    return java, cp


def leak_summary(report: str) -> str:
    """One-line headline pulled from Shark's report text."""
    m = re.search(r"(\d+)\s+APPLICATION LEAKS", report)
    if m:
        n = int(m.group(1))
        return "No application leaks found ✓" if n == 0 else f"{n} application leak(s) found"
    return "Analysis complete"


# --- turn Shark's text report into a visual HTML report ----------------------
def _count(report: str, label: str) -> int:
    m = re.search(r"(\d+)\s+" + re.escape(label), report)
    return int(m.group(1)) if m else 0


def _parse_metadata(report: str) -> dict:
    md: dict[str, str] = {}
    if "METADATA" in report:
        for line in report.split("METADATA", 1)[1].splitlines():
            if set(line.strip()) == {"="}:
                break
            k, _, v = line.partition(":")
            if k.strip() and v.strip():
                md[k.strip()] = v.strip()
    return md


def _split_blocks(report: str) -> list[str]:
    """Split on Shark's '====' separator lines."""
    blocks, cur = [], []
    for line in report.splitlines():
        if len(line.strip()) >= 4 and set(line.strip()) == {"="}:
            if cur:
                blocks.append("\n".join(cur))
                cur = []
        else:
            cur.append(line)
    if cur:
        blocks.append("\n".join(cur))
    return blocks


def _is_trace(block: str) -> bool:
    return any(k in block for k in ("Leaking:", "GC Root:", "bytes retained"))


def _fmt_int(v: str) -> str:
    try:
        return f"{int(v):,}"
    except ValueError:
        return v


def _fmt_mb(v: str) -> str:
    try:
        return f"{int(v) / 1e6:.1f} MB"
    except ValueError:
        return v


# (tile label, metadata key, formatter)
_TILES = [
    ("Heap size", "Heap total bytes", _fmt_mb),
    ("Instances", "Instance count", _fmt_int),
    ("Classes", "Class count", _fmt_int),
    ("Threads", "Thread count", _fmt_int),
    ("Bitmaps", "Bitmap count", _fmt_int),
    ("Bitmap memory", "Bitmap total bytes", _fmt_mb),
    ("Android SDK", "Build.VERSION.SDK_INT", str),
    ("Manufacturer", "Build.MANUFACTURER", str),
    ("Analysis time", "Analysis duration", str),
]


def _trace_to_html(block: str) -> str:
    """Colorize a leak-trace block line-by-line, preserving the ASCII chain."""
    rows = []
    for line in block.splitlines():
        esc = html.escape(line) or "&nbsp;"
        if "~~~" in line:
            cls = "cause"
        elif "Leaking: YES" in line:
            cls = "yes"
        elif "Leaking: NO" in line:
            cls = "no"
        elif "Leaking: UNKNOWN" in line:
            cls = "unknown"
        elif "GC Root:" in line:
            cls = "root"
        elif re.match(r"\s*(Signature:|[\d,]+ bytes retained)", line):
            cls = "meta"
        else:
            cls = ""
        rows.append(f'<span class="{cls}">{esc}</span>')
    return "\n".join(rows)


def _leak_card(block: str, index: int) -> str:
    retained = re.search(r"([\d,]+) bytes retained", block)
    sig = re.search(r"Signature:\s*(\w+)", block)
    bits = [f"Leak #{index}"]
    if retained:
        try:
            bits.append(f"{int(retained.group(1).replace(',', '')) / 1024:.1f} KB retained")
        except ValueError:
            pass
    if sig:
        bits.append(f"signature {sig.group(1)[:12]}")
    head = html.escape("  ·  ".join(bits))
    return (f'<div class="card leak"><div class="leak-head">🔴 {head}</div>'
            f'<pre class="trace">{_trace_to_html(block)}</pre></div>')


def build_report_html(package: str, report: str) -> str:
    """Render Shark's text report as a themed, visual HTML document."""
    app_leaks = _count(report, "APPLICATION LEAKS")
    lib_leaks = _count(report, "LIBRARY LEAKS")
    unreachable = _count(report, "UNREACHABLE OBJECTS")
    md = _parse_metadata(report)

    section, app_traces, lib_traces = None, [], []
    for b in _split_blocks(report):
        head = next((l for l in b.splitlines() if l.strip()), "")
        if re.match(r"\d+\s+APPLICATION LEAKS", head):
            section = "app"
        elif re.match(r"\d+\s+LIBRARY LEAKS", head):
            section = "lib"
        elif re.match(r"\d+\s+UNREACHABLE", head):
            section = "unreach"
        elif head.startswith("METADATA") or head.startswith("HEAP ANALYSIS"):
            section = "meta"
        elif _is_trace(b):
            (app_traces if section == "app" else lib_traces).append(b)

    ok = app_leaks == 0
    banner_class = "ok" if ok else "bad"
    banner_num = "0" if ok else str(app_leaks)
    banner_txt = "No application leaks 🎉" if ok else \
        f"{app_leaks} application leak{'s' if app_leaks != 1 else ''} found"

    tiles = "".join(
        f'<div class="tile"><div class="tv">{html.escape(fmt(md[key]))}</div>'
        f'<div class="tl">{label}</div></div>'
        for label, key, fmt in _TILES if key in md)

    parts = [f'<div class="banner {banner_class}"><div class="bignum">{banner_num}</div>'
             f'<div><div class="btitle">{html.escape(banner_txt)}</div>'
             f'<div class="bsub">{html.escape(package)}'
             f'{f" · {lib_leaks} library leaks" if lib_leaks else ""}'
             f'{f" · {unreachable} unreachable objects" if unreachable else ""}'
             f'</div></div></div>']
    if tiles:
        parts.append(f'<div class="tiles">{tiles}</div>')
    if app_traces:
        parts.append('<h2>Application leaks</h2>')
        parts += [_leak_card(b, i) for i, b in enumerate(app_traces, 1)]
    elif ok:
        parts.append('<div class="card note">No retained objects reached from your app were '
                     'found in this heap dump. Reproduce the suspected leak (rotate, navigate '
                     'away, etc.) then run detection again.</div>')
    if lib_traces:
        parts.append('<h2>Library leaks <span class="dim">(known 3rd-party bugs)</span></h2>')
        parts += [_leak_card(b, i).replace("🔴", "📚") for i, b in enumerate(lib_traces, 1)]
    parts.append('<details class="raw"><summary>Raw Shark report</summary>'
                 f'<pre>{html.escape(report)}</pre></details>')

    css = _CSS
    for token, color in (("@BG@", theme.BG), ("@SURFACE@", theme.SURFACE),
                         ("@SURFACE2@", theme.SURFACE_2), ("@BORDER@", theme.BORDER),
                         ("@TEXT@", theme.TEXT), ("@DIM@", theme.TEXT_DIM),
                         ("@ACCENT@", theme.ACCENT), ("@GREEN@", theme.GREEN),
                         ("@RED@", theme.RED), ("@AMBER@", theme.AMBER)):
        css = css.replace(token, color)
    return f"<!doctype html><html><head><meta charset='utf-8'><style>{css}</style></head>" \
           f"<body>{''.join(parts)}</body></html>"


_CSS = """
* { box-sizing: border-box; }
body { background:@BG@; color:@TEXT@; margin:0; padding:20px;
  font-family:-apple-system,"SF Pro Text","Helvetica Neue",Arial; font-size:13px; }
h2 { font-size:15px; margin:22px 4px 10px; font-weight:600; }
h2 .dim { color:@DIM@; font-weight:400; font-size:12px; }
.banner { display:flex; align-items:center; gap:16px; padding:18px 20px;
  border-radius:14px; border:1px solid @BORDER@; background:@SURFACE@; }
.banner.ok { border-left:5px solid @GREEN@; }
.banner.bad { border-left:5px solid @RED@; }
.bignum { font-size:44px; font-weight:800; line-height:1; }
.banner.ok .bignum { color:@GREEN@; }
.banner.bad .bignum { color:@RED@; }
.btitle { font-size:17px; font-weight:700; }
.bsub { color:@DIM@; margin-top:3px; font-family:Menlo,monospace; font-size:12px; }
.tiles { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr));
  gap:10px; margin-top:14px; }
.tile { background:@SURFACE@; border:1px solid @BORDER@; border-radius:10px; padding:12px 14px; }
.tv { font-size:20px; font-weight:700; }
.tl { color:@DIM@; font-size:11px; text-transform:uppercase; letter-spacing:.6px; margin-top:3px; }
.card { background:@SURFACE@; border:1px solid @BORDER@; border-radius:12px;
  padding:0; margin:10px 0; overflow:hidden; }
.card.leak { border-left:5px solid @RED@; }
.leak-head { padding:11px 15px; font-weight:600; background:@SURFACE2@;
  border-bottom:1px solid @BORDER@; }
.card.note { padding:15px; color:@DIM@; }
.trace { margin:0; padding:14px 16px; font-family:Menlo,monospace; font-size:12px;
  line-height:1.5; white-space:pre; overflow-x:auto; }
.trace .yes { color:@RED@; font-weight:600; }
.trace .no { color:@GREEN@; }
.trace .unknown { color:@DIM@; }
.trace .root { color:@ACCENT@; font-weight:600; }
.trace .cause { color:@AMBER@; font-weight:700; }
.trace .meta { color:@DIM@; }
.raw { margin-top:22px; color:@DIM@; }
.raw summary { cursor:pointer; padding:8px 0; }
.raw pre { background:@SURFACE@; border:1px solid @BORDER@; border-radius:10px;
  padding:14px; overflow-x:auto; font-family:Menlo,monospace; font-size:11px;
  white-space:pre; color:@DIM@; }
"""


class LeakDetectWorker(QThread):
    """Capture a heap dump of `package`, pull it, and analyze it with Shark."""
    progress = pyqtSignal(str)                    # human status while working
    done = pyqtSignal(bool, str, str)             # ok, report/error, local hprof path

    def __init__(self, adb, serial, package, out_dir, parent=None):
        super().__init__(parent)
        self._adb, self._serial, self._pkg = adb, serial, package
        self._out_dir = out_dir
        self._cancel = False
        self._proc: subprocess.Popen | None = None

    def cancel(self):
        self._cancel = True
        if self._proc and self._proc.poll() is None:
            try:
                self._proc.kill()
            except OSError:
                pass

    def _adb_run(self, args, timeout):
        return subprocess.run([self._adb, "-s", self._serial, *args],
                              capture_output=True, text=True, timeout=timeout)

    def run(self):
        try:
            self.progress.emit("Preparing the Shark analyzer…")
            java, cp = provision_shark(self.progress.emit, lambda: self._cancel)
        except CancelledError:
            self.done.emit(False, "Cancelled.", "")
            return
        except RuntimeError as exc:
            self.done.emit(False, str(exc), "")
            return

        remote = "/data/local/tmp/logcatviewer-leak.hprof"
        try:
            self._adb_run(["shell", "rm", "-f", remote], 10)
            self.progress.emit(f"Capturing heap dump of {self._pkg}…")
            r = self._adb_run(["shell", "am", "dumpheap", self._pkg, remote], 60)
        except (subprocess.SubprocessError, OSError) as exc:
            self.done.emit(False, f"adb error: {exc}", "")
            return
        blob = (r.stdout + r.stderr).lower()
        if any(k in blob for k in ("not debuggable", "unknown package", "no process",
                                   "exception", "permission deni")):
            self.done.emit(False,
                           "Heap dump failed — the app must be debuggable "
                           "(or the device rooted).\n\n" + (r.stdout + r.stderr).strip(), "")
            return

        self.progress.emit("Waiting for the dump to finish…")
        size = self._wait_stable(remote)
        if self._cancel:
            self.done.emit(False, "Cancelled.", "")
            return
        if not size:
            self.done.emit(False, "No heap dump was produced — the app may not be "
                                  "debuggable, or it stopped during the dump.", "")
            return

        local = os.path.join(self._out_dir, f"{self._pkg}.hprof")
        self.progress.emit(f"Pulling heap dump ({size/1e6:.0f} MB)…")
        try:
            self._adb_run(["pull", remote, local], 180)
            self._adb_run(["shell", "rm", "-f", remote], 10)
        except (subprocess.SubprocessError, OSError) as exc:
            self.done.emit(False, f"Failed to pull the heap dump: {exc}", "")
            return
        if not os.path.exists(local) or os.path.getsize(local) == 0:
            self.done.emit(False, "The pulled heap dump was empty.", "")
            return

        self.progress.emit("Analyzing the heap with Shark (this can take a minute)…")
        try:
            self._proc = subprocess.Popen(
                [java, "-cp", cp, SHARK_MAIN, "-h", local, "analyze"],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            out, err = self._proc.communicate(timeout=600)
        except subprocess.TimeoutExpired:
            self.cancel()
            self.done.emit(False, "Shark analysis timed out.", local)
            return
        except (subprocess.SubprocessError, OSError) as exc:
            self.done.emit(False, f"Shark failed to run: {exc}", local)
            return
        if self._cancel:
            self.done.emit(False, "Cancelled.", local)
            return
        report = out.strip() or err.strip()
        if "APPLICATION LEAKS" not in report:
            self.done.emit(False, "Shark did not return a report:\n\n"
                           + (err.strip() or out.strip() or "(no output)"), local)
            return
        self.done.emit(True, report, local)

    def _wait_stable(self, remote: str) -> int:
        """Poll the remote file size until it stops growing; return final size."""
        stat = (f"stat -c %s {remote} 2>/dev/null || "
                f"toybox stat -c %s {remote} 2>/dev/null || echo 0")
        prev, stable = -1, 0
        for _ in range(90):
            if self._cancel:
                return 0
            try:
                out = self._adb_run(["shell", stat], 10).stdout.strip()
                size = int(out.splitlines()[-1]) if out else 0
            except (subprocess.SubprocessError, OSError, ValueError):
                size = 0
            if size and size == prev:
                stable += 1
                if stable >= 2:          # unchanged across two polls → done
                    return size
            else:
                stable = 0
            prev = size
            time.sleep(1)
        return prev if prev > 0 else 0


class LeakReportWindow(QWidget):
    """Top-level window showing Shark's leak result as a visual HTML report."""

    def __init__(self, package: str, report: str, hprof_path: str, parent=None):
        super().__init__(parent)
        self._hprof = hprof_path
        self._html = build_report_html(package, report)
        self.setWindowTitle(f"Memory leaks — {package}")
        self.resize(920, 700)
        v = QVBoxLayout(self)
        v.setContentsMargins(0, 0, 0, 0)
        v.setSpacing(0)

        bar = QWidget()
        bar.setObjectName("Toolbar")
        bh = QHBoxLayout(bar)
        bh.setContentsMargins(12, 8, 12, 8)
        headline = leak_summary(report)
        leaks = not headline.startswith("No application")
        dot = QLabel("●")
        dot.setStyleSheet(f"color: {RED if leaks else GREEN}; font-size: 15px;")
        title = QLabel(f"  {package}   ·   {headline}")
        title.setStyleSheet(f"color: {TEXT}; font-weight: 600;")
        bh.addWidget(dot)
        bh.addWidget(title)
        bh.addStretch(1)
        save_btn = QPushButton("Save report…")
        save_btn.clicked.connect(self._save)
        folder_btn = QPushButton("Open .hprof folder")
        folder_btn.clicked.connect(self._open_folder)
        folder_btn.setEnabled(bool(hprof_path and os.path.exists(hprof_path)))
        bh.addWidget(save_btn)
        bh.addWidget(folder_btn)
        v.addWidget(bar)

        # QtWebEngine is already a hard dep (the map); import lazily so headless
        # smoke never spins it up.
        from PyQt6.QtWebEngineWidgets import QWebEngineView
        self.view = QWebEngineView()
        self.view.setHtml(self._html)
        v.addWidget(self.view, 1)

    def _save(self):
        path, _ = QFileDialog.getSaveFileName(
            self, "Save leak report", os.path.expanduser("~/Downloads/leak-report.html"),
            "HTML (*.html)")
        if path:
            try:
                with open(path, "w") as f:
                    f.write(self._html)
            except OSError:
                pass

    def _open_folder(self):
        if self._hprof and os.path.exists(self._hprof):
            QDesktopServices.openUrl(QUrl.fromLocalFile(os.path.dirname(self._hprof)))
