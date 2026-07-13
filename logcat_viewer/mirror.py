"""In-app device screen mirror.

A background thread polls `adb exec-out screencap -p` and streams PNG frames to a
canvas that scales them to fit. Clicks/drag map back to device pixels and are
forwarded via `adb shell input` (tap/swipe); nav keys via keyevent. A "scrcpy"
button pops out full-quality, low-latency mirroring when scrcpy is installed.
Screenshot / screen-record buttons capture full-resolution PNG / MP4 to disk.

A display picker (shown only when the device has more than one display, e.g.
the Controls tab's simulated secondary display) mirrors any display:
`screencap -d <SurfaceFlinger id>` polls it and `input -d <logical id>` routes
taps to it. screenrecord rejects virtual display IDs, so secondary displays
always use the screencap poller and MP4 recording stays main-display-only.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import time

from PyQt6.QtCore import QProcess, QRect, Qt, QThread, QTimer, pyqtSignal
from PyQt6.QtGui import QColor, QImage, QKeySequence, QPainter, QPen, QShortcut
from PyQt6.QtWidgets import (
    QComboBox, QDockWidget, QHBoxLayout, QPushButton, QVBoxLayout, QWidget,
)

from . import theme

# Android keyevent codes.
KEY_BACK, KEY_HOME, KEY_RECENTS = 4, 3, 187

_OVERLAY_ACCENT = {"installing": theme.ACCENT, "success": theme.GREEN, "error": theme.RED,
                   "recording": theme.RED, "capturing": theme.ACCENT}
_OVERLAY_ICON = {"installing": "●", "success": "✓", "error": "✗",
                 "recording": "⏺", "capturing": "◉"}
_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def _capture_dir() -> str:
    d = os.path.expanduser("~/Downloads")
    return d if os.path.isdir(d) else os.path.expanduser("~")


def _safe(serial: str | None) -> str:
    return "".join(c if c.isalnum() else "_" for c in (serial or "device"))


_HAVE_AV = None


def have_av() -> bool:
    """Whether PyAV (ffmpeg) is importable, enabling the low-latency H.264 mirror."""
    global _HAVE_AV
    if _HAVE_AV is None:
        try:
            import av  # noqa: F401
            _HAVE_AV = True
        except Exception:
            _HAVE_AV = False
    return _HAVE_AV


# H.264 stream bitrate (device-side encoder). 8 Mbit is crisp at 1080p while
# staying small enough to transfer with little latency.
H264_BITRATE = "8M"


def apk_paths(mime) -> list[str]:
    if not mime.hasUrls():
        return []
    return [u.toLocalFile() for u in mime.urls() if u.toLocalFile().lower().endswith(".apk")]


# Characters the device shell would eat when `adb shell input text …` re-parses
# the command line. `input` itself needs spaces sent as %s. Escaped one by one;
# a literal "%s" in the text and non-ASCII chars are `input`'s own limitations.
_INPUT_SPECIALS = "\\\"'`&|;<>()*~$#?[]{}"


def escape_input_text(text: str) -> str:
    """Make arbitrary text safe for `adb shell input text <arg>`."""
    out = []
    for ch in text.replace("\r\n", " ").replace("\n", " ").replace("\t", " "):
        if ch == " ":
            out.append("%s")
        elif ch in _INPUT_SPECIALS:
            out.append("\\" + ch)
        else:
            out.append(ch)
    return "".join(out)

def screencap_args(display_id: int | None = None) -> list[str]:
    """screencap argv tail; display_id is a SurfaceFlinger ID (None = primary)."""
    args = ["screencap"]
    if display_id is not None:
        args += ["-d", str(display_id)]
    return args + ["-p"]


def build_display_list(sf_text: str, display_text: str) -> list[dict]:
    """Join `dumpsys SurfaceFlinger --display-id` (capture IDs) with `dumpsys
    display` viewports (logical IDs for `input -d`). Physical displays first.

    SF lines:   Display <id> (HWC display 0): ... displayName="samsung lcd"
                Display <id> (Virtual display): displayName="Overlay #1" ...
    Viewports:  DisplayViewport{..., displayId=14, ..., uniqueId='overlay:1', ...}
    Physical viewports carry uniqueId='local:<sf-id>'; overlay ones
    'overlay:<n>' matching the SF displayName "Overlay #<n>".
    """
    viewports = {uid: int(did) for did, uid in re.findall(
        r"DisplayViewport\{[^}]*?displayId=(\d+),[^}]*?uniqueId='([^']+)'",
        display_text or "")}
    out = []
    for line in (sf_text or "").splitlines():
        m = re.match(r"Display (\d+) \(([^)]*)\)", line.strip())
        if not m:
            continue
        sf_id, kind = int(m.group(1)), m.group(2)
        nm = re.search(r'displayName="([^"]*)"', line)
        name = (nm.group(1).strip() if nm else "") or kind
        virtual = "virtual" in kind.lower()
        if virtual:
            onum = re.search(r"#(\d+)", name)
            logical = viewports.get(f"overlay:{onum.group(1)}") if onum else None
        else:
            logical = viewports.get(f"local:{sf_id}")
        out.append({"sf_id": sf_id, "name": name, "virtual": virtual,
                    "logical": logical})
    out.sort(key=lambda d: d["virtual"])   # stable: physical first
    return out


class DisplayListWorker(QThread):
    """Enumerate the device's displays (two dumpsys reads, off the UI thread)."""
    done = pyqtSignal(list)

    def __init__(self, adb, serial, parent=None):
        super().__init__(parent)
        self._adb, self._serial = adb, serial

    def run(self):
        try:
            sf = subprocess.run(
                [self._adb, "-s", self._serial, "shell",
                 "dumpsys", "SurfaceFlinger", "--display-id"],
                capture_output=True, text=True, timeout=10).stdout
            dp = subprocess.run(
                [self._adb, "-s", self._serial, "shell", "dumpsys", "display"],
                capture_output=True, text=True, timeout=10).stdout
        except (subprocess.SubprocessError, OSError):
            self.done.emit([])
            return
        self.done.emit(build_display_list(sf, dp))


class _DisplayCombo(QComboBox):
    """Combo that asks for a fresh display list every time it opens."""
    popupRequested = pyqtSignal()

    def showPopup(self):
        self.popupRequested.emit()
        super().showPopup()


# Number of staggered capture threads. screencap on the device serializes only
# partially, so overlapping N roundtrips raises the effective frame rate.
CAPTURE_THREADS = 2


class MirrorWorker(QThread):
    # (capture-start timestamp, frame) — the timestamp lets the view drop
    # out-of-order completions so content only ever moves forward.
    frame = pyqtSignal(float, QImage)
    failed = pyqtSignal(str)

    def __init__(self, adb: str, serial: str, start_delay_ms: int = 0,
                 display_id: int | None = None, parent=None):
        super().__init__(parent)
        self._adb = adb
        self._serial = serial
        self._delay = start_delay_ms
        self._display_id = display_id
        self._run = True

    def stop(self):
        self._run = False

    def run(self):
        # Capture back-to-back with no artificial delay — latency is bound by
        # screencap itself. PNG beats raw here: its ~75KB transfers far faster
        # than a ~2.8MB raw framebuffer over adb.
        if self._delay:
            self.msleep(self._delay)
        misses = 0
        while self._run:
            ts = time.monotonic()
            try:
                out = subprocess.run(
                    [self._adb, "-s", self._serial, "exec-out",
                     *screencap_args(self._display_id)],
                    capture_output=True, timeout=10).stdout
            except (subprocess.SubprocessError, OSError) as exc:
                self.failed.emit(str(exc))
                return
            if not self._run:
                return
            img = QImage()
            if out and img.loadFromData(out, "PNG") and not img.isNull():
                misses = 0
                self.frame.emit(ts, img)  # QImage is implicitly shared; no copy needed
            else:
                misses += 1
                if misses > 5:
                    self.failed.emit("no screen data (device offline?)")
                    return
                self.msleep(120)


class H264MirrorWorker(QThread):
    """Low-latency mirror: stream the device display as a continuous H.264
    elementary stream (`screenrecord --output-format=h264`) and decode it with
    PyAV/ffmpeg. Unlike the screencap poller this is real delta-compressed video
    — smooth (30–60 fps) at a fraction of the bandwidth — which is the same
    technique scrcpy and Android Studio's mirror use.

    Each `screenrecord` session is capped at `--time-limit 180` (the maximum
    every build accepts) and the outer loop transparently reconnects on EOF, so
    the stream is effectively unbounded. We deliberately avoid `--time-limit 0`
    ("unbounded"): real devices honor it, but some emulators/VMs read 0 as *stop
    immediately* and emit an empty stream — the mirror would paint one primed
    frame and then freeze."""
    frame = pyqtSignal(QImage)
    failed = pyqtSignal(str)

    def __init__(self, adb, serial, bitrate=H264_BITRATE, parent=None):
        super().__init__(parent)
        self._adb = adb
        self._serial = serial
        self._bitrate = bitrate
        self._run = True
        self._proc = None

    def stop(self):
        self._run = False
        p = self._proc
        if p is not None and p.poll() is None:
            try:
                p.kill()
            except OSError:
                pass

    def _kill_remote(self):
        """Terminate any on-device `screenrecord`. Killing the local adb client
        doesn't reliably reap the remote process, and the device has a single
        display encoder — a straggler makes the next session block for seconds.
        Safe because the H.264 mirror only runs when no MP4 recording is active."""
        try:
            subprocess.run([self._adb, "-s", self._serial, "shell", "pkill", "screenrecord"],
                           capture_output=True, timeout=6)
        except (subprocess.SubprocessError, OSError):
            pass

    def _emit_frame(self, frame):
        rgb = frame.reformat(format="rgb24")
        plane = rgb.planes[0]
        buf = bytes(plane)  # copy out of the decoder's buffer
        img = QImage(buf, rgb.width, rgb.height, plane.line_size,
                     QImage.Format.Format_RGB888).copy()  # detach from `buf`
        if not img.isNull():
            self.frame.emit(img)

    def _prime_frame(self):
        """Show the current screen instantly via a single screencap. On a static
        screen, `screenrecord` H.264 emits no frame until the display next
        changes (e.g. a touch) — without this the view sits on "Connecting…"."""
        try:
            out = subprocess.run(
                [self._adb, "-s", self._serial, "exec-out", "screencap", "-p"],
                capture_output=True, timeout=6).stdout
        except (subprocess.SubprocessError, OSError):
            return
        img = QImage()
        if out and img.loadFromData(out, "PNG") and not img.isNull():
            self.frame.emit(img)

    def run(self):
        try:
            import av
        except Exception as exc:  # pragma: no cover - guarded by have_av()
            self.failed.emit(f"PyAV unavailable: {exc}")
            return

        cmd = [self._adb, "-s", self._serial, "exec-out", "screenrecord",
               "--output-format=h264", "--time-limit", "180",
               "--bit-rate", self._bitrate, "-"]
        self._kill_remote()   # clear any straggler holding the encoder
        self.msleep(120)      # let the encoder free before we grab it
        self._prime_frame()   # paint the current screen at once (H.264 may stall until a redraw)
        total = 0
        try:
            while self._run:
                codec = av.CodecContext.create("h264", "r")
                try:
                    codec.thread_type = "AUTO"
                except Exception:
                    pass
                try:
                    self._proc = subprocess.Popen(cmd, stdout=subprocess.PIPE,
                                                  stderr=subprocess.PIPE)
                except (subprocess.SubprocessError, OSError) as exc:
                    self.failed.emit(str(exc))
                    return
                session = 0
                while self._run:
                    chunk = self._proc.stdout.read1(65536)  # available bytes, no full-buffer wait
                    if not chunk:
                        break
                    session += len(chunk)
                    total += len(chunk)
                    try:
                        for packet in codec.parse(chunk):
                            for frame in codec.decode(packet):
                                self._emit_frame(frame)
                    except av.error.FFmpegError:
                        pass  # transient decode hiccup; next keyframe resyncs
                err = b""
                try:
                    err = self._proc.stderr.read() or b""
                except OSError:
                    pass
                try:
                    self._proc.kill()
                except OSError:
                    pass
                if session == 0:  # this session yielded nothing
                    if total == 0:  # never worked at all -> report so we can fall back
                        msg = err.decode("utf-8", "replace").strip() or "no video stream"
                        self.failed.emit(msg)
                        return
                    self.msleep(150)  # brief gap before reconnecting
        finally:
            self._kill_remote()   # never leave a device-side encoder session behind


class ScreenshotWorker(QThread):
    """Grab a full-resolution PNG via `screencap -p` and write it to disk."""
    done = pyqtSignal(bool, str, str)  # ok, message, containing-directory

    def __init__(self, adb, serial, dest_file, display_id: int | None = None,
                 parent=None):
        super().__init__(parent)
        self._adb = adb
        self._serial = serial
        self._dest = dest_file
        self._display_id = display_id

    def run(self):
        try:
            res = subprocess.run(
                [self._adb, "-s", self._serial, "exec-out",
                 *screencap_args(self._display_id)],
                capture_output=True, timeout=20)
        except (subprocess.SubprocessError, OSError) as exc:
            self.done.emit(False, f"Screenshot failed: {exc}", "")
            return
        data = res.stdout or b""
        if not data.startswith(_PNG_MAGIC):
            detail = (res.stderr or b"").decode("utf-8", "replace").strip()
            self.done.emit(False, f"Screenshot failed: {detail or 'no image data'}", "")
            return
        try:
            with open(self._dest, "wb") as fh:
                fh.write(data)
        except OSError as exc:
            self.done.emit(False, f"Cannot write {self._dest}: {exc}", "")
            return
        self.done.emit(True, f"Saved {os.path.basename(self._dest)}", os.path.dirname(self._dest))


class RecordWorker(QThread):
    """Run `screenrecord` on the device until stopped, then pull the MP4.

    Stopping is done by sending SIGINT to the on-device `screenrecord` process
    (via `pkill -INT`) so it finalizes a valid MP4 — killing the local adb
    process would leave a truncated file. screenrecord also self-stops at the
    device's built-in time limit (~180s), which the poll loop handles too."""
    done = pyqtSignal(bool, str, str)  # ok, message, containing-directory

    def __init__(self, adb, serial, remote, dest_file, parent=None):
        super().__init__(parent)
        self._adb = adb
        self._serial = serial
        self._remote = remote
        self._dest = dest_file
        self._proc = None
        self._stopping = False

    def stop(self):
        # Requested from the UI thread; the run() poll loop does the SIGINT so
        # signalling can retry until screenrecord actually exits.
        self._stopping = True

    def _signal_stop(self):
        try:
            subprocess.run([self._adb, "-s", self._serial, "shell",
                            "pkill", "-INT", "screenrecord"],
                           capture_output=True, timeout=6)
        except (subprocess.SubprocessError, OSError):
            pass

    def run(self):
        try:
            self._proc = subprocess.Popen(
                [self._adb, "-s", self._serial, "shell", "screenrecord", self._remote],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        except (subprocess.SubprocessError, OSError) as exc:
            self.done.emit(False, f"Could not start screenrecord: {exc}", "")
            return

        # Wait for a stop request or screenrecord's own time limit. Re-issue the
        # SIGINT each tick while stopping so we win the start-vs-stop race.
        while self._proc.poll() is None:
            if self._stopping:
                self._signal_stop()
                time.sleep(0.3)
            else:
                time.sleep(0.15)
        out = b""
        if self._proc.stdout:
            try:
                out = self._proc.stdout.read() or b""
            except OSError:
                pass
        rec_msg = out.decode("utf-8", "replace").strip()

        # Pull whatever screenrecord finalized, then clean up the device copy.
        try:
            pull = subprocess.run(
                [self._adb, "-s", self._serial, "pull", self._remote, self._dest],
                capture_output=True, text=True, timeout=180)
        except (subprocess.SubprocessError, OSError) as exc:
            self.done.emit(False, f"Recording made but pull failed: {exc}", "")
            return
        try:
            subprocess.run([self._adb, "-s", self._serial, "shell", "rm", "-f", self._remote],
                           capture_output=True, timeout=10)
        except (subprocess.SubprocessError, OSError):
            pass

        if pull.returncode == 0 and os.path.exists(self._dest) and os.path.getsize(self._dest) > 0:
            self.done.emit(True, f"Saved {os.path.basename(self._dest)}",
                           os.path.dirname(self._dest))
        else:
            reason = (pull.stderr or pull.stdout or rec_msg or "screenrecord produced no file").strip()
            self.done.emit(False, f"Recording failed: {reason.splitlines()[-1] if reason else 'unknown'}", "")


class _ScreenCanvas(QWidget):
    """Paints the current frame scaled-to-fit and turns mouse gestures into
    device-pixel tap/swipe signals."""

    tap = pyqtSignal(int, int)
    swipe = pyqtSignal(int, int, int, int, int)  # x1,y1,x2,y2,duration_ms
    apksDropped = pyqtSignal(list)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._img: QImage | None = None
        self._msg = "Connecting…"
        self._rect = QRect()
        self._press = None
        self._drop_hint = False
        self._overlay = None      # (kind, text) shown as a banner on top of the screen
        self.setMinimumSize(200, 320)
        self.setAcceptDrops(True)

    def set_image(self, img):
        self._img = img
        self.update()

    def set_message(self, msg):
        self._img = None
        self._msg = msg
        self.update()

    def set_overlay(self, kind, text):
        self._overlay = (kind, text)
        self.update()

    def clear_overlay(self):
        self._overlay = None
        self.update()

    def paintEvent(self, _):
        p = QPainter(self)
        p.fillRect(self.rect(), QColor("#0d0f13"))
        if self._img is None or self._img.isNull():
            p.setPen(QColor("#8b93a1"))
            p.drawText(self.rect(), Qt.AlignmentFlag.AlignCenter, self._msg)
        else:
            aw, ah = self.width(), self.height()
            iw, ih = self._img.width(), self._img.height()
            scale = min(aw / iw, ah / ih)
            w, h = int(iw * scale), int(ih * scale)
            self._rect = QRect((aw - w) // 2, (ah - h) // 2, w, h)
            p.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform, True)
            p.drawImage(self._rect, self._img)
        if self._overlay:
            self._paint_overlay(p)
        if self._drop_hint:
            self._paint_drop_hint(p)

    def _paint_overlay(self, p):
        kind, text = self._overlay
        accent = QColor(_OVERLAY_ACCENT.get(kind, theme.ACCENT))
        p.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        fm = p.fontMetrics()
        m = 10
        rect = QRect(m, m, max(0, self.width() - 2 * m), fm.height() + 20)
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(QColor(16, 18, 24, 238))
        p.drawRoundedRect(rect, 9, 9)
        p.setBrush(accent)
        p.drawRoundedRect(QRect(rect.x(), rect.y() + 4, 5, rect.height() - 8), 2, 2)
        p.setPen(accent)
        p.drawText(QRect(rect.x() + 14, rect.y(), 20, rect.height()),
                   int(Qt.AlignmentFlag.AlignVCenter | Qt.AlignmentFlag.AlignLeft),
                   _OVERLAY_ICON.get(kind, "●"))
        tr = QRect(rect.x() + 36, rect.y(), rect.width() - 46, rect.height())
        p.setPen(QColor("#e6e9ef"))
        p.drawText(tr, int(Qt.AlignmentFlag.AlignVCenter | Qt.AlignmentFlag.AlignLeft),
                   fm.elidedText(text, Qt.TextElideMode.ElideMiddle, tr.width()))

    def _paint_drop_hint(self, p):
        p.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        p.fillRect(self.rect(), QColor(16, 18, 24, 150))
        pen = QPen(QColor(theme.ACCENT))
        pen.setWidth(2)
        pen.setStyle(Qt.PenStyle.DashLine)
        p.setPen(pen)
        p.setBrush(Qt.BrushStyle.NoBrush)
        p.drawRoundedRect(self.rect().adjusted(6, 6, -7, -7), 12, 12)
        p.setPen(QColor("#e6e9ef"))
        p.drawText(self.rect(), Qt.AlignmentFlag.AlignCenter, "Drop APK to install")

    # --- drag & drop -------------------------------------------------------
    def dragEnterEvent(self, e):
        if apk_paths(e.mimeData()):
            e.acceptProposedAction()
            self._drop_hint = True
            self.update()

    def dragMoveEvent(self, e):
        if apk_paths(e.mimeData()):
            e.acceptProposedAction()

    def dragLeaveEvent(self, e):
        self._drop_hint = False
        self.update()

    def dropEvent(self, e):
        paths = apk_paths(e.mimeData())
        self._drop_hint = False
        self.update()
        if paths:
            e.acceptProposedAction()
            self.apksDropped.emit(paths)

    def _to_device(self, pos):
        if self._img is None or not self._rect.contains(pos):
            return None
        fx = (pos.x() - self._rect.x()) / self._rect.width()
        fy = (pos.y() - self._rect.y()) / self._rect.height()
        return int(fx * self._img.width()), int(fy * self._img.height())

    def mousePressEvent(self, e):
        self._press = (self._to_device(e.position().toPoint()), e.timestamp())

    def mouseReleaseEvent(self, e):
        if not self._press or self._press[0] is None:
            self._press = None
            return
        (x1, y1), t1 = self._press
        self._press = None
        d2 = self._to_device(e.position().toPoint()) or (x1, y1)
        x2, y2 = d2
        if abs(x2 - x1) + abs(y2 - y1) < 12:
            self.tap.emit(x1, y1)
        else:
            self.swipe.emit(x1, y1, x2, y2, max(50, e.timestamp() - t1))


class MirrorView(QWidget):
    """Canvas + control bar; owns the capture worker for one device."""

    failed = pyqtSignal(str)
    apksDropped = pyqtSignal(list)
    captured = pyqtSignal(bool, str, str)  # screenshot/recording: ok, message, directory
    fullscreen_changed = pyqtSignal(bool)

    def __init__(self, adb: str, parent=None):
        super().__init__(parent)
        self._adb = adb
        self._serial = None
        self._workers: list[MirrorWorker] = []      # screencap fallback threads
        self._h264: H264MirrorWorker | None = None  # low-latency video mirror
        self._h264_ok = True                        # cleared if the stream fails
        self._recording = False                     # MP4 record in progress
        self._last_ts = 0.0
        self._display_id: int | None = None         # SF id; None = main display
        self._display_logical: int | None = None    # logical id for `input -d`
        self._want_secondary = 0                    # pending auto-switch retries
        self._dlist_worker: DisplayListWorker | None = None
        self._shot_worker: ScreenshotWorker | None = None
        self._rec_worker: RecordWorker | None = None
        self._dock: QDockWidget | None = None
        self._fs_placeholder: QWidget | None = None
        self._in_fullscreen = False
        self._fs_esc: QShortcut | None = None
        self.setMinimumWidth(240)

        self._overlay_timer = QTimer(self)
        self._overlay_timer.setSingleShot(True)
        self._overlay_timer.timeout.connect(lambda: self.canvas.clear_overlay())

        root = QHBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)
        self.canvas = _ScreenCanvas()
        self.canvas.tap.connect(self._tap)
        self.canvas.swipe.connect(self._swipe)
        self.canvas.apksDropped.connect(self.apksDropped)  # relay drops upward

        # vertical control rail on the right of the canvas
        bar = QVBoxLayout()
        bar.setContentsMargins(6, 6, 6, 6)
        bar.setSpacing(6)
        self.back_btn = QPushButton("‹")
        self.back_btn.setToolTip("Back")
        self.home_btn = QPushButton("●")
        self.home_btn.setToolTip("Home")
        self.recents_btn = QPushButton("▭")
        self.recents_btn.setToolTip("Recents")
        self.shot_btn = QPushButton("📷")
        self.shot_btn.setToolTip("Save a screenshot to ~/Downloads")
        self.rec_btn = QPushButton("⏺")
        self.rec_btn.setToolTip("Record the screen to an MP4 in ~/Downloads")
        self.paste_btn = QPushButton("📋")
        self.paste_btn.setToolTip("Type the Mac clipboard into the focused field (⌘V)")
        self.type_btn = QPushButton("⌨")
        self.type_btn.setToolTip("Type text into the focused field on the device")
        self.fullscreen_btn = QPushButton("⛶")
        self.fullscreen_btn.setToolTip("Full screen mirror (Esc to exit)")
        self.scrcpy_btn = QPushButton("⤢")
        self.scrcpy_btn.setToolTip("Open full-quality interactive mirror (scrcpy)")
        self.display_combo = _DisplayCombo()
        self.display_combo.setToolTip(
            "Which display to mirror (secondary displays use the screencap preview)")
        self.display_combo.addItem("Main", (None, None))
        self.display_combo.setFixedWidth(44)  # keep the side rail slim; popup shows full names
        self.display_combo.setVisible(False)
        self.display_combo.popupRequested.connect(self._probe_displays)
        self.display_combo.activated.connect(self._on_display_pick)
        for b in (self.back_btn, self.home_btn, self.recents_btn,
                  self.shot_btn, self.rec_btn, self.paste_btn, self.type_btn,
                  self.fullscreen_btn, self.scrcpy_btn):
            b.setObjectName("toggle")
            b.setFixedSize(32, 32)   # compact square icons for the side rail
        self.back_btn.clicked.connect(lambda: self._key(KEY_BACK))
        self.home_btn.clicked.connect(lambda: self._key(KEY_HOME))
        self.recents_btn.clicked.connect(lambda: self._key(KEY_RECENTS))
        self.shot_btn.clicked.connect(self.screenshot)
        self.rec_btn.clicked.connect(self.toggle_record)
        self.paste_btn.clicked.connect(self.paste_clipboard)
        self.type_btn.clicked.connect(self.type_text)
        self.fullscreen_btn.clicked.connect(self.toggle_fullscreen)
        self.scrcpy_btn.clicked.connect(self._launch_scrcpy)
        self.scrcpy_btn.setEnabled(shutil.which("scrcpy") is not None)
        center = Qt.AlignmentFlag.AlignHCenter
        bar.addWidget(self.back_btn, 0, center)
        bar.addWidget(self.home_btn, 0, center)
        bar.addWidget(self.recents_btn, 0, center)
        bar.addWidget(self.shot_btn, 0, center)
        bar.addWidget(self.rec_btn, 0, center)
        bar.addWidget(self.paste_btn, 0, center)
        bar.addWidget(self.type_btn, 0, center)
        bar.addStretch(1)
        bar.addWidget(self.display_combo, 0, center)
        bar.addWidget(self.fullscreen_btn, 0, center)
        bar.addWidget(self.scrcpy_btn, 0, center)
        root.addWidget(self.canvas, 1)
        root.addLayout(bar)

    def bind_dock(self, dock: QDockWidget):
        """Remember the dock panel so the mirror can pop out to full screen."""
        self._dock = dock

    def is_fullscreen(self) -> bool:
        return self._in_fullscreen

    def mirror_running(self) -> bool:
        """True while a device session is active (capture workers may be running)."""
        return self._serial is not None and bool(self._workers or self._h264)

    def toggle_fullscreen(self):
        if self.is_fullscreen():
            self.exit_fullscreen()
        else:
            self.enter_fullscreen()

    def enter_fullscreen(self):
        if not self._dock or self.is_fullscreen():
            return
        self._fs_placeholder = QWidget()
        self._dock.setWidget(self._fs_placeholder)
        self.setWindowTitle("Screen Mirror")
        self.setWindowFlags(Qt.WindowType.Window)
        self._fs_esc = QShortcut(QKeySequence(Qt.Key.Key_Escape), self,
                                 activated=self.exit_fullscreen)
        self.fullscreen_btn.setText("⛶ Exit")
        self.fullscreen_btn.setToolTip("Exit full screen (Esc)")
        self._in_fullscreen = True
        self.showFullScreen()
        self.raise_()
        self.activateWindow()
        self.fullscreen_changed.emit(True)

    def exit_fullscreen(self):
        if not self.is_fullscreen() or not self._dock:
            return
        self._in_fullscreen = False
        self.hide()
        self.setWindowFlags(Qt.WindowType.Widget)
        if self._fs_esc is not None:
            self._fs_esc.deleteLater()
            self._fs_esc = None
        self._dock.setWidget(self)
        self._fs_placeholder = None
        self.fullscreen_btn.setText("⛶")
        self.fullscreen_btn.setToolTip("Full screen mirror (Esc to exit)")
        self.show()
        self.fullscreen_changed.emit(False)

    def keyPressEvent(self, event):
        if self.is_fullscreen() and event.key() == Qt.Key.Key_Escape:
            self.exit_fullscreen()
            return
        if event.matches(QKeySequence.StandardKey.Paste):
            self.paste_clipboard()
            return
        super().keyPressEvent(event)

    def closeEvent(self, event):
        if self.is_fullscreen():
            self.exit_fullscreen()
            event.ignore()
            return
        super().closeEvent(event)

    # --- lifecycle ---------------------------------------------------------
    def start(self, serial: str):
        self.stop()
        self._serial = serial
        self._h264_ok = True        # give the video mirror a fresh chance
        self._recording = False
        self._want_secondary = 0
        self._set_display(None, None)   # display ids are per-device
        self.display_combo.blockSignals(True)
        self.display_combo.clear()
        self.display_combo.addItem("Main", (None, None))
        self.display_combo.blockSignals(False)
        self.display_combo.setVisible(False)
        self.canvas.set_message("Connecting…")
        self._start_capture()
        self._probe_displays()

    def stop(self):
        if self.is_fullscreen():
            self.exit_fullscreen()
        # Finalize an in-flight recording so the MP4 isn't left truncated.
        if self._rec_worker is not None:
            self._rec_worker.stop()
            self._rec_worker.wait(15000)
        self._recording = False
        self._stop_capture()
        if self._dlist_worker is not None:
            self._dlist_worker.wait(1500)
            self._dlist_worker = None

    def _start_capture(self):
        """Start the best available live feed: H.264 video when PyAV is present
        and we're not busy recording (which needs the device's sole encoder),
        else the screencap poller. Secondary displays always use the poller —
        screenrecord rejects virtual display IDs."""
        if not self._serial:
            return
        if (have_av() and self._h264_ok and not self._recording
                and self._display_id is None):
            self._h264 = H264MirrorWorker(self._adb, self._serial)
            self._h264.frame.connect(self._on_h264_frame)
            self._h264.failed.connect(self._on_h264_fail)
            self._h264.start()
        else:
            self._last_ts = 0.0
            for i in range(CAPTURE_THREADS):
                w = MirrorWorker(self._adb, self._serial, start_delay_ms=i * 55,
                                 display_id=self._display_id)
                w.frame.connect(self._on_frame)
                w.failed.connect(self._on_fail)
                self._workers.append(w)
                w.start()

    # --- display picker ------------------------------------------------------
    def _set_display(self, sf_id: int | None, logical: int | None):
        self._display_id = sf_id
        self._display_logical = logical
        # screenrecord can't capture virtual displays.
        self.rec_btn.setEnabled(sf_id is None or self._rec_worker is not None)
        self.rec_btn.setToolTip(
            "Record the screen to an MP4 in ~/Downloads" if sf_id is None
            else "Recording works on the main display only")

    def _probe_displays(self):
        if not self._serial or self._dlist_worker is not None:
            return
        self._dlist_worker = DisplayListWorker(self._adb, self._serial, self)
        self._dlist_worker.done.connect(self._on_displays)
        self._dlist_worker.start()

    def show_secondary(self, attempts: int = 8):
        """One-click path to the secondary display: keep probing briefly (it
        may still be coming up if it was just enabled) and switch to the first
        one found."""
        self._want_secondary = attempts
        self._probe_displays()

    def _on_displays(self, displays: list):
        self._dlist_worker = None
        current = self._display_id
        self.display_combo.blockSignals(True)
        self.display_combo.clear()
        self.display_combo.addItem("Main", (None, None))
        for d in displays[1:]:      # everything beyond the primary display
            self.display_combo.addItem(d["name"], (d["sf_id"], d["logical"]))
        idx = 0
        for i in range(self.display_combo.count()):
            if self.display_combo.itemData(i)[0] == current:
                idx = i
                break
        self.display_combo.setCurrentIndex(idx)
        self.display_combo.blockSignals(False)
        self.display_combo.setVisible(self.display_combo.count() > 1)
        if current is not None and self.display_combo.itemData(idx)[0] != current:
            # the mirrored display disappeared — fall back to the main one
            self._set_display(None, None)
            self.canvas.set_message("Connecting…")
            self._restart_capture()
        if self._want_secondary:
            if self.display_combo.count() > 1:      # found one — switch to it
                self._want_secondary = 0
                self.display_combo.setCurrentIndex(1)
                self._on_display_pick()
            else:
                self._want_secondary -= 1
                if self._want_secondary > 0:        # still booting; probe again
                    QTimer.singleShot(600, self._probe_displays)
                else:
                    self.failed.emit("no secondary display found")

    def _on_display_pick(self):
        sf_id, logical = self.display_combo.currentData() or (None, None)
        if sf_id == self._display_id:
            return
        self._set_display(sf_id, logical)
        self.canvas.set_message("Connecting…")
        self._restart_capture()

    def _stop_capture(self):
        if self._h264 is not None:
            self._h264.stop()
            self._h264.wait(2500)
            self._h264 = None
        for w in self._workers:
            w.stop()
        for w in self._workers:
            w.wait(1500)
        self._workers = []

    def _restart_capture(self):
        self._stop_capture()
        self._start_capture()

    def _on_h264_frame(self, img):
        self.canvas.set_image(img)

    def _on_h264_fail(self, msg):
        # Not fatal: drop to the screencap preview for this device.
        self._h264_ok = False
        self.failed.emit(f"video stream unavailable ({msg}); using preview")
        self._restart_capture()

    def _on_frame(self, ts, img):
        if ts > self._last_ts:      # newest capture wins; drop stale completions
            self._last_ts = ts
            self.canvas.set_image(img)

    def _on_fail(self, msg):
        self.canvas.set_message(msg)
        self._stop_capture()        # leave any recording running
        self.failed.emit(msg)

    # --- control -----------------------------------------------------------
    def _input(self, args):
        if self._serial:
            # Route input to the mirrored display (`input -d <logical id>`).
            dis = (["-d", str(self._display_logical)]
                   if self._display_id is not None and self._display_logical is not None
                   else [])
            QProcess.startDetached(self._adb,
                                   ["-s", self._serial, "shell", "input", *dis, *args])

    def _tap(self, x, y):
        self._input(["tap", str(x), str(y)])

    def _swipe(self, x1, y1, x2, y2, ms):
        self._input(["swipe", str(x1), str(y1), str(x2), str(y2), str(ms)])

    def _key(self, code):
        self._input(["keyevent", str(code)])

    def send_text(self, text: str):
        """Type text into the focused field via `input text` (ASCII-ish only —
        an `input` limitation; newlines become spaces)."""
        if not self._serial:
            self._flash_error("Mirror not connected")
            return
        text = text.strip("\x00")
        if not text:
            return
        self._input(["text", escape_input_text(text)])

    def paste_clipboard(self):
        from PyQt6.QtGui import QGuiApplication
        self.send_text(QGuiApplication.clipboard().text())

    def type_text(self):
        from PyQt6.QtWidgets import QInputDialog
        text, ok = QInputDialog.getText(self, "Type on device",
                                        "Text for the focused field:")
        if ok and text:
            self.send_text(text)

    def _launch_scrcpy(self):
        scrcpy = shutil.which("scrcpy")
        if scrcpy and self._serial:
            args = ["-s", self._serial]
            if self._display_id is not None and self._display_logical is not None:
                args += ["--display-id", str(self._display_logical)]
            QProcess.startDetached(scrcpy, args)

    # --- capture: screenshot & screen record -------------------------------
    def _flash_error(self, text):
        """Brief on-canvas error banner (used when there's no device)."""
        self.canvas.set_overlay("error", text)
        self._overlay_timer.start(4000)

    def screenshot(self):
        if not self._serial:
            self._flash_error("Mirror not connected")
            return
        if self._shot_worker is not None:
            return
        tag = "" if self._display_id is None else f"-display{self._display_logical}"
        name = (f"screenshot-{_safe(self._serial)}{tag}-"
                f"{time.strftime('%Y%m%d-%H%M%S')}.png")
        dest = os.path.join(_capture_dir(), name)
        self._overlay_timer.stop()
        self.canvas.set_overlay("capturing", "Capturing screenshot…")
        self._shot_worker = ScreenshotWorker(self._adb, self._serial, dest,
                                             display_id=self._display_id)
        self._shot_worker.done.connect(self._on_shot_done)
        self._shot_worker.start()

    def _on_shot_done(self, ok, message, directory):
        self._shot_worker = None
        self.canvas.set_overlay("success" if ok else "error", message)
        self._overlay_timer.start(5000)
        self.captured.emit(ok, message, directory)

    def toggle_record(self):
        if self._rec_worker is not None:
            self._stop_record()
        else:
            self._start_record()

    def _start_record(self):
        if not self._serial:
            self._flash_error("Mirror not connected")
            return
        if self._display_id is not None:
            self._flash_error("Recording works on the main display only")
            return
        ts = time.strftime("%Y%m%d-%H%M%S")
        remote = f"/sdcard/logcatviewer-{ts}.mp4"
        dest = os.path.join(_capture_dir(), f"screenrecord-{_safe(self._serial)}-{ts}.mp4")
        # The device has one display encoder; the H.264 mirror uses it too, so
        # free it by switching the live preview to screencap while recording.
        self._recording = True
        self._restart_capture()
        self._rec_worker = RecordWorker(self._adb, self._serial, remote, dest)
        self._rec_worker.done.connect(self._on_record_done)
        self._rec_worker.start()
        self.rec_btn.setText("⏹")
        self.rec_btn.setStyleSheet("background:#e5534b; color:#ffffff;")
        self._overlay_timer.stop()
        self.canvas.set_overlay("recording", "Recording… (tap Stop to finish)")

    def _stop_record(self):
        if self._rec_worker is not None:
            self.rec_btn.setEnabled(False)
            self.rec_btn.setText("…")
            self.canvas.set_overlay("capturing", "Finalizing recording…")
            self._rec_worker.stop()

    def _on_record_done(self, ok, message, directory):
        self._rec_worker = None
        self.rec_btn.setEnabled(True)
        self.rec_btn.setText("⏺")
        self.rec_btn.setStyleSheet("")
        self.canvas.set_overlay("success" if ok else "error", message)
        self._overlay_timer.start(6000)
        self.captured.emit(ok, message, directory)
        # Encoder is free again — resume the low-latency video mirror.
        self._recording = False
        if self._serial and self.isVisible():
            self._restart_capture()

    # --- install status banner (drawn on top of the mirrored screen) -------
    def install_started(self, names):
        self._overlay_timer.stop()
        self.canvas.set_overlay("installing", f"Installing {names}…")

    def install_finished(self, ok, text):
        self.canvas.set_overlay("success" if ok else "error", text)
        self._overlay_timer.start(6000)
