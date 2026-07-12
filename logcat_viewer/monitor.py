"""Device performance monitor: live CPU + RAM usage sampled over adb.

One background `QThread` (`MonitorWorker`) reads `/proc/stat`, `/proc/meminfo`
and `/proc/loadavg` in a single `adb shell cat` round-trip, computes the CPU%
from the jiffies delta between consecutive samples, and streams a dict to the
`MonitorView` dashboard (big readouts + history sparklines drawn with QPainter —
no extra dependency). Polling only runs while the tab is visible with a device
selected. Pure parse helpers are unit-tested in tests/smoke.py.
"""
from __future__ import annotations

import os
import re
import shlex
import shutil
import subprocess
import tempfile
from collections import deque

from PyQt6.QtCore import Qt, QThread, pyqtSignal, QPointF
from PyQt6.QtGui import QColor, QPainter, QPen, QPolygonF
from PyQt6.QtWidgets import (
    QComboBox, QGridLayout, QHBoxLayout, QLabel, QMessageBox, QPushButton,
    QVBoxLayout, QWidget,
)

from . import theme
from .leakdetect import LeakDetectWorker, LeakReportWindow, leak_summary

# One shot: the three procfs files are concatenated; each is told apart by shape
# (stat lines start with "cpu"/"intr"/…, meminfo lines are "Key:  N kB", the
# loadavg line is three floats), so no separators are needed.
PROBE = "cat /proc/stat /proc/meminfo /proc/loadavg"

# When a package is being watched we append dumpsys reads (no root / no
# debuggable needed) behind markers so the output can be split back apart.
_CPU_MARK = "@@CPU@@"
_MEM_MARK = "@@MEM@@"
_BAT_MARK = "@@BAT@@"
_GFX_MARK = "@@GFX@@"

_LOADAVG_RE = re.compile(r"^\s*(\d+\.\d+)\s+(\d+\.\d+)\s+(\d+\.\d+)")
# dumpsys cpuinfo rows: "  8.3% 12345/com.example.app: 5% user + 3.3% kernel"
_APP_CPU_RE = re.compile(r"^\s*([\d.]+)%\s+\d+/(\S+?):", re.M)


def build_probe(package: str | None) -> str:
    """The one-round-trip shell probe: procfs + battery, plus per-app cpuinfo /
    meminfo / gfxinfo (frame stats) when an app is being watched."""
    script = PROBE
    if package:
        q = shlex.quote(package)
        script += (f"; echo {_CPU_MARK}; dumpsys cpuinfo 2>/dev/null"
                   f"; echo {_MEM_MARK}; dumpsys meminfo {q} 2>/dev/null")
    script += f"; echo {_BAT_MARK}; dumpsys battery 2>/dev/null"
    if package:
        q = shlex.quote(package)
        script += f"; echo {_GFX_MARK}; dumpsys gfxinfo {q} 2>/dev/null"
    return script


def parse_battery(text: str):
    """{'level': %, 'temp_c': °C, 'powered': bool} from dumpsys battery, or None."""
    m = re.search(r"level:\s*(\d+)", text)
    if not m:
        return None
    out = {"level": int(m.group(1)), "temp_c": None,
           "powered": bool(re.search(r"(AC|USB|Wireless) powered: true", text))}
    t = re.search(r"temperature:\s*(-?\d+)", text)
    if t:
        out["temp_c"] = int(t.group(1)) / 10.0   # reported in tenths of °C
    return out


def parse_gfxinfo(text: str):
    """Cumulative frame stats from dumpsys gfxinfo: total/janky frames, jank %
    and frame-time percentiles. None when the app renders nothing."""
    total = re.search(r"Total frames rendered:\s*(\d+)", text)
    if not total:
        return None
    out = {"total": int(total.group(1)), "janky": 0, "janky_pct": 0.0}
    j = re.search(r"Janky frames:\s*(\d+)\s*\(([\d.]+)%\)", text)
    if j:
        out["janky"] = int(j.group(1))
        out["janky_pct"] = float(j.group(2))
    for pct in (50, 90, 95, 99):
        m = re.search(rf"{pct}th percentile:\s*(\d+)ms", text)
        if m:
            out[f"p{pct}"] = int(m.group(1))
    return out


def parse_app_cpu(text: str, package: str):
    """Whole-device CPU% attributed to the package (summed across its processes,
    incl. `pkg:child`), from dumpsys cpuinfo. None if the app isn't listed."""
    total = None
    for m in _APP_CPU_RE.finditer(text):
        if m.group(2).split(":", 1)[0] == package:
            total = (total or 0.0) + float(m.group(1))
    return total


def parse_app_meminfo(text: str):
    """The app's TOTAL PSS in KB from dumpsys meminfo, or None if not running."""
    m = re.search(r"TOTAL PSS:\s*(\d+)", text)        # newer Android
    if m:
        return int(m.group(1))
    m = re.search(r"^\s*TOTAL\s+(\d+)", text, re.M)    # older table: PSS is col 1
    return int(m.group(1)) if m else None


def parse_cpu_stat(text: str):
    """(total_jiffies, idle_jiffies) from the aggregate `cpu` line, or None.
    idle counts idle + iowait so busy% = 1 - Δidle/Δtotal."""
    for line in text.splitlines():
        parts = line.split()
        if parts and parts[0] == "cpu":
            nums = [int(x) for x in parts[1:] if x.isdigit()]
            if len(nums) < 4:
                return None
            idle = nums[3] + (nums[4] if len(nums) > 4 else 0)  # idle + iowait
            return sum(nums), idle
    return None


def cpu_core_count(text: str) -> int:
    """Number of per-core `cpuN` lines in /proc/stat."""
    return sum(1 for l in text.splitlines() if re.match(r"cpu\d+\b", l))


def parse_cpu_cores(text: str) -> list:
    """Per-core (total, idle) jiffies from the `cpuN` lines, ordered by core."""
    cores = []
    for line in text.splitlines():
        m = re.match(r"cpu(\d+)\b", line)
        if not m:
            continue
        nums = [int(x) for x in line.split()[1:] if x.isdigit()]
        if len(nums) >= 4:
            idle = nums[3] + (nums[4] if len(nums) > 4 else 0)
            cores.append((int(m.group(1)), sum(nums), idle))
    cores.sort()
    return [(t, i) for _n, t, i in cores]


def parse_meminfo(text: str) -> dict:
    """meminfo keys we care about, in KB."""
    want = {"MemTotal": "total", "MemAvailable": "available", "MemFree": "free",
            "Buffers": "buffers", "Cached": "cached",
            "SwapTotal": "swap_total", "SwapFree": "swap_free"}
    out: dict[str, int] = {}
    for line in text.splitlines():
        key, _, rest = line.partition(":")
        if key in want:
            tok = rest.strip().split()
            if tok and tok[0].isdigit():
                out[want[key]] = int(tok[0])
    return out


def mem_used_kb(info: dict):
    """(used_kb, total_kb) or None. Prefer MemAvailable; fall back to the
    classic free+buffers+cached estimate on kernels without it."""
    total = info.get("total")
    if not total:
        return None
    if "available" in info:
        used = total - info["available"]
    else:
        used = total - info.get("free", 0) - info.get("buffers", 0) - info.get("cached", 0)
    return max(0, used), total


def parse_loadavg(text: str):
    """(1m, 5m, 15m) load averages, or None."""
    for line in text.splitlines():
        m = _LOADAVG_RE.match(line)
        if m:
            return tuple(float(g) for g in m.groups())
    return None


def cpu_percent(prev, cur):
    """Busy% (0..100) between two (total, idle) samples, or None if no delta."""
    if not prev or not cur:
        return None
    dt = cur[0] - prev[0]
    di = cur[1] - prev[1]
    if dt <= 0:
        return None
    return max(0.0, min(100.0, 100.0 * (dt - di) / dt))


class MonitorWorker(QThread):
    """Polls the device every `interval_ms` and emits a sample dict."""
    sample = pyqtSignal(object)   # {"cpu", "mem", "load", "cores", "app"}
    failed = pyqtSignal(str)

    def __init__(self, adb: str, serial: str, interval_ms: int = 1000,
                 package: str | None = None, parent=None):
        super().__init__(parent)
        self._adb = adb
        self._serial = serial
        self._interval = max(250, interval_ms)
        self._package = package or None
        self._run = True

    def run(self):
        prev_cpu = None
        prev_cores = None
        prev_gfx = None
        probe = build_probe(self._package)
        while self._run:
            try:
                r = subprocess.run(
                    [self._adb, "-s", self._serial, "shell", probe],
                    capture_output=True, text=True, timeout=10)
            except (subprocess.SubprocessError, OSError) as exc:
                if self._run:
                    self.failed.emit(str(exc))
                return
            if not self._run:
                return
            text = r.stdout
            gfx = None
            text, _, gfx_txt = text.partition(_GFX_MARK)
            text, _, bat_txt = text.partition(_BAT_MARK)
            battery = parse_battery(bat_txt)
            app = None
            if self._package:
                gfx = parse_gfxinfo(gfx_txt)
                if gfx is not None:
                    # jank% across just the frames rendered since the last sample
                    if prev_gfx and gfx["total"] > prev_gfx["total"]:
                        df = gfx["total"] - prev_gfx["total"]
                        dj = max(0, gfx["janky"] - prev_gfx["janky"])
                        gfx["recent_pct"] = 100.0 * dj / df
                    prev_gfx = {"total": gfx["total"], "janky": gfx["janky"]}
                text, _, rest = text.partition(_CPU_MARK)
                cpu_txt, _, mem_txt = rest.partition(_MEM_MARK)
                acpu = parse_app_cpu(cpu_txt, self._package)
                amem = parse_app_meminfo(mem_txt)
                app = {"cpu": acpu, "mem_kb": amem,
                       "running": acpu is not None or amem is not None}
            cur_cpu = parse_cpu_stat(text)
            pct = cpu_percent(prev_cpu, cur_cpu)
            if cur_cpu:
                prev_cpu = cur_cpu
            cur_cores = parse_cpu_cores(text)
            cores_pct = None
            if prev_cores and len(prev_cores) == len(cur_cores):
                cores_pct = [cpu_percent(p, c) for p, c in zip(prev_cores, cur_cores)]
            if cur_cores:
                prev_cores = cur_cores
            self.sample.emit({
                "cpu": pct,
                "mem": mem_used_kb(parse_meminfo(text)),
                "load": parse_loadavg(text),
                "cores": cpu_core_count(text),
                "cores_pct": cores_pct,
                "battery": battery,
                "gfx": gfx,
                "app": app,
            })
            slept = 0
            while self._run and slept < self._interval:  # responsive to stop()
                self.msleep(50)
                slept += 50

    def stop(self):
        self._run = False


class SparkGraph(QWidget):
    """A lightweight history graph of fractions in [0, 1]. The primary series is
    filled; an optional secondary series (the selected app) is a plain line."""

    def __init__(self, color: str, app_color: str, maxlen: int = 120, parent=None):
        super().__init__(parent)
        self._color = QColor(color)
        self._app_color = QColor(app_color)
        self._vals: deque = deque(maxlen=maxlen)
        self._app: deque = deque(maxlen=maxlen)
        self.setMinimumHeight(120)

    def push(self, frac, app_frac=None):
        self._vals.append(None if frac is None else max(0.0, min(1.0, frac)))
        self._app.append(None if app_frac is None else max(0.0, min(1.0, app_frac)))
        self.update()

    def clear(self):
        self._vals.clear()
        self._app.clear()
        self.update()

    def paintEvent(self, _event):
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        w, h = self.width(), self.height()
        p.fillRect(self.rect(), QColor(theme.BG))
        p.setPen(QPen(QColor(theme.BORDER), 1))
        for frac in (0.25, 0.5, 0.75):
            y = int(h - frac * h)
            p.drawLine(0, y, w, y)
        step = w / (self._vals.maxlen - 1)

        def points(vals):
            n = len(vals)
            x0 = w - (n - 1) * step  # newest sample pinned to the right edge
            return [None if v is None else QPointF(x0 + i * step, h - 2 - v * (h - 4))
                    for i, v in enumerate(vals)]

        self._draw(p, points(list(self._vals)), self._color, h, fill=True)
        if any(v is not None for v in self._app):
            self._draw(p, points(list(self._app)), self._app_color, h, fill=False)

    @staticmethod
    def _draw(p, pts, color, h, fill):
        line = QPen(color, 2)
        line.setJoinStyle(Qt.PenJoinStyle.RoundJoin)
        fill_c = QColor(color)
        fill_c.setAlpha(46)
        seg: list[QPointF] = []

        def flush():
            if len(seg) < 2:
                return
            if fill:
                poly = QPolygonF(seg + [QPointF(seg[-1].x(), h), QPointF(seg[0].x(), h)])
                p.setPen(Qt.PenStyle.NoPen)
                p.setBrush(fill_c)
                p.drawPolygon(poly)
            p.setBrush(Qt.BrushStyle.NoBrush)
            p.setPen(line)
            p.drawPolyline(QPolygonF(seg))

        for pt in pts:
            if pt is None:
                flush()
                seg.clear()
            else:
                seg.append(pt)
        flush()


class CoreBars(QWidget):
    """A row of vertical bars, one per CPU core, heat-colored by load."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self._vals: list = []            # per-core busy % (0..100) or None
        self.setMinimumHeight(96)

    def set_values(self, vals):
        self._vals = list(vals or [])
        self.update()

    def clear(self):
        self._vals = []
        self.update()

    @staticmethod
    def _heat(pct):
        if pct is None:
            return QColor(theme.BORDER_2)
        if pct < 50:
            return QColor(theme.GREEN)
        if pct < 80:
            return QColor(theme.AMBER)
        return QColor(theme.RED)

    def paintEvent(self, _event):
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.fillRect(self.rect(), QColor(theme.BG))
        n = len(self._vals)
        if n == 0:
            p.setPen(QColor(theme.TEXT_DIM))
            p.drawText(self.rect(), int(Qt.AlignmentFlag.AlignCenter),
                       "waiting for per-core data…")
            return
        w, h = self.width(), self.height()
        top_pad, bottom_pad = 16, 16          # room for the % (top) and label (bottom)
        track_h = h - top_pad - bottom_pad
        gap = 8
        bw = (w - gap * (n + 1)) / n
        base = h - bottom_pad
        for i, pct in enumerate(self._vals):
            x = gap + i * (bw + gap)
            # track
            p.setPen(Qt.PenStyle.NoPen)
            p.setBrush(QColor(theme.SURFACE_2))
            p.drawRoundedRect(int(x), top_pad, int(bw), track_h, 4, 4)
            # fill
            val = 0.0 if pct is None else max(0.0, min(100.0, pct))
            fh = int(track_h * val / 100.0)
            if fh > 0:
                p.setBrush(self._heat(pct))
                p.drawRoundedRect(int(x), base - fh, int(bw), fh, 4, 4)
            # labels
            p.setPen(QColor(theme.TEXT))
            p.drawText(int(x), 0, int(bw), top_pad,
                       int(Qt.AlignmentFlag.AlignCenter),
                       "–" if pct is None else f"{val:.0f}%")
            p.setPen(QColor(theme.TEXT_DIM))
            p.drawText(int(x), base + 1, int(bw), bottom_pad,
                       int(Qt.AlignmentFlag.AlignCenter), f"C{i}")


class MonitorView(QWidget):
    """CPU + RAM dashboard. Polls only while visible with a device selected."""
    status = pyqtSignal(str)
    failed = pyqtSignal(str)

    _INTERVALS = [("0.5 s", 500), ("1 s", 1000), ("2 s", 2000), ("5 s", 5000)]

    _APP_COLOR = theme.AMBER   # the selected-app overlay line, on both cards

    def __init__(self, adb: str, parent=None):
        super().__init__(parent)
        self._adb = adb or ""
        self._serial: str | None = None
        self._package: str | None = None
        self._worker: MonitorWorker | None = None
        self._interval = 1000
        self._leak_worker: LeakDetectWorker | None = None
        self._leak_dirs: list = []             # temp hprof dirs, cleaned on shutdown
        self._leak_windows: list = []          # keep report windows alive
        self._build()

    # --- UI ---------------------------------------------------------------
    def _build(self):
        root = QVBoxLayout(self)
        root.setContentsMargins(16, 14, 16, 16)
        root.setSpacing(12)

        head = QHBoxLayout()
        title = QLabel("Device Performance")
        title.setObjectName("MonHeading")
        head.addWidget(title)
        head.addStretch(1)
        self.leak_btn = QPushButton("🔎  Detect leaks")
        self.leak_btn.setToolTip("Capture a heap dump of the selected app and analyze it "
                                 "for memory leaks with LeakCanary's Shark (debuggable apps)")
        self.leak_btn.setEnabled(False)
        self.leak_btn.clicked.connect(self._detect_leaks)
        head.addWidget(self.leak_btn)
        head.addSpacing(6)
        head.addWidget(QLabel("Refresh"))
        self.interval_combo = QComboBox()
        for label, ms in self._INTERVALS:
            self.interval_combo.addItem(label, ms)
        self.interval_combo.setCurrentIndex(1)  # 1 s
        self.interval_combo.activated.connect(self._on_interval)
        head.addWidget(self.interval_combo)
        root.addLayout(head)

        cards = QGridLayout()
        cards.setSpacing(12)
        self.cpu_value = QLabel("—")
        self.cpu_sub = QLabel("waiting for device…")
        self.cpu_app = QLabel("")
        self.cpu_graph = SparkGraph(theme.ACCENT, self._APP_COLOR)
        cards.addWidget(self._card("CPU", self.cpu_value, self.cpu_sub,
                                   self.cpu_app, self.cpu_graph), 0, 0)

        self.mem_value = QLabel("—")
        self.mem_sub = QLabel("waiting for device…")
        self.mem_app = QLabel("")
        self.mem_graph = SparkGraph(theme.GREEN, self._APP_COLOR)
        cards.addWidget(self._card("Memory", self.mem_value, self.mem_sub,
                                   self.mem_app, self.mem_graph), 0, 1)
        cards.setColumnStretch(0, 1)
        cards.setColumnStretch(1, 1)

        # Battery + UI-rendering (jank) cards.
        self.bat_value = QLabel("—")
        self.bat_sub = QLabel("waiting for device…")
        self.bat_app = QLabel("")
        self.bat_graph = SparkGraph(theme.GREEN_H, self._APP_COLOR)
        cards.addWidget(self._card("Battery", self.bat_value, self.bat_sub,
                                   self.bat_app, self.bat_graph), 1, 0)

        self.gfx_value = QLabel("—")
        self.gfx_sub = QLabel("pick an app to see its frame stats")
        self.gfx_app = QLabel("")
        self.gfx_graph = SparkGraph(theme.RED, self._APP_COLOR)
        cards.addWidget(self._card("UI Rendering (jank)", self.gfx_value, self.gfx_sub,
                                   self.gfx_app, self.gfx_graph), 1, 1)

        # Per-core CPU meter spans both columns beneath the cards.
        core_card = QWidget()
        core_card.setObjectName("MonCard")
        cv = QVBoxLayout(core_card)
        cv.setContentsMargins(16, 12, 16, 12)
        cv.setSpacing(6)
        cap = QLabel("PER-CORE CPU")
        cap.setObjectName("MonCaption")
        cv.addWidget(cap)
        self.core_bars = CoreBars()
        cv.addWidget(self.core_bars, 1)
        cards.addWidget(core_card, 2, 0, 1, 2)
        cards.setRowStretch(0, 3)
        cards.setRowStretch(1, 3)
        cards.setRowStretch(2, 2)
        root.addLayout(cards, 1)

    def _card(self, name, value_lbl, sub_lbl, app_lbl, graph) -> QWidget:
        card = QWidget()
        card.setObjectName("MonCard")
        v = QVBoxLayout(card)
        v.setContentsMargins(16, 14, 16, 14)
        v.setSpacing(4)
        cap = QLabel(name)
        cap.setObjectName("MonCaption")
        value_lbl.setObjectName("MonValue")
        sub_lbl.setObjectName("MonSub")
        app_lbl.setObjectName("MonApp")
        app_lbl.setStyleSheet(f"color: {self._APP_COLOR};")  # matches its graph line
        v.addWidget(cap)
        v.addWidget(value_lbl)
        v.addWidget(sub_lbl)
        v.addWidget(app_lbl)
        v.addSpacing(6)
        v.addWidget(graph, 1)
        return card

    # --- lifecycle --------------------------------------------------------
    def set_serial(self, serial: str | None):
        if serial == self._serial:
            return
        self._serial = serial
        self._stop()
        self._reset_readouts()
        self._update_leak_btn()
        self._sync()

    def set_package(self, package: str | None):
        """Follow the shared App picker: overlay this app's CPU/RAM on the cards
        (works for any running app — no root or debuggable build needed)."""
        package = package or None
        if package == self._package:
            return
        self._package = package
        self.cpu_graph.clear()
        self.mem_graph.clear()
        self.gfx_graph.clear()
        self.gfx_value.setText("—")
        self.gfx_sub.setText("pick an app to see its frame stats"
                             if not package else "waiting for frames…")
        self.core_bars.clear()
        self._reset_app_readouts()
        self._update_leak_btn()
        if self._worker is not None:   # restart so the worker watches the new app
            self._stop()
            self._sync()

    def _update_leak_btn(self):
        self.leak_btn.setEnabled(
            bool(self._adb and self._serial and self._package) and self._leak_worker is None)

    def _on_interval(self, _idx):
        self._interval = self.interval_combo.currentData()
        if self._worker is not None:           # apply immediately by restarting
            self._stop()
            self._sync()

    def showEvent(self, event):
        super().showEvent(event)
        self._sync()

    def hideEvent(self, event):
        super().hideEvent(event)
        self._stop()

    def _sync(self):
        if self.isVisible() and self._adb and self._serial and self._worker is None:
            self._start()
        elif not (self.isVisible() and self._serial):
            self._stop()

    def _start(self):
        self._worker = MonitorWorker(
            self._adb, self._serial, self._interval, self._package, self)
        self._worker.sample.connect(self._on_sample)
        self._worker.failed.connect(self._on_failed)
        self._worker.start()
        self.status.emit(f"Monitoring {self._serial}")

    def _stop(self):
        if self._worker is not None:
            self._worker.stop()
            self._worker.wait(2000)
            self._worker = None

    def shutdown(self):
        self._stop()
        if self._leak_worker is not None:
            self._leak_worker.cancel()
            self._leak_worker.wait(3000)
            self._leak_worker = None
        for d in self._leak_dirs:
            shutil.rmtree(d, ignore_errors=True)
        self._leak_dirs.clear()

    # --- leak detection (LeakCanary / Shark over adb) ---------------------
    def _detect_leaks(self):
        if not (self._adb and self._serial and self._package):
            return
        if self._leak_worker is not None:
            self.status.emit("A leak analysis is already running…")
            return
        leak_dir = tempfile.mkdtemp(prefix="logcatviewer-leak-")
        self._leak_dirs.append(leak_dir)
        self.leak_btn.setEnabled(False)
        self.leak_btn.setText("Detecting…")
        self._leak_worker = LeakDetectWorker(
            self._adb, self._serial, self._package, leak_dir, self)
        self._leak_worker.progress.connect(lambda m: self.status.emit(m))
        self._leak_worker.done.connect(self._on_leak_done)
        self._leak_worker.start()

    def _on_leak_done(self, ok: bool, report: str, hprof: str):
        pkg = self._package or "app"
        self._leak_worker = None
        self.leak_btn.setText("🔎  Detect leaks")
        self._update_leak_btn()
        if not ok:
            self.status.emit("Leak analysis failed")
            if report and report != "Cancelled.":
                box = QMessageBox(self)
                box.setModal(False)
                box.setIcon(QMessageBox.Icon.Warning)
                box.setWindowTitle("Memory leak detection")
                box.setText(f"Couldn't analyze {pkg} for leaks.")
                box.setInformativeText(report)
                box.show()
            return
        self.status.emit(f"✓ {leak_summary(report)} — {pkg}")
        win = LeakReportWindow(pkg, report, hprof)
        self._leak_windows.append(win)
        win.show()
        win.raise_()

    # --- sample handling --------------------------------------------------
    def _reset_readouts(self):
        self.cpu_value.setText("—")
        self.mem_value.setText("—")
        self.bat_value.setText("—")
        self.gfx_value.setText("—")
        msg = "waiting for device…" if self._serial else "No device selected"
        self.cpu_sub.setText(msg)
        self.mem_sub.setText(msg)
        self.bat_sub.setText(msg)
        self.gfx_sub.setText("pick an app to see its frame stats"
                             if not self._package else msg)
        self.cpu_graph.clear()
        self.mem_graph.clear()
        self.bat_graph.clear()
        self.gfx_graph.clear()
        self.core_bars.clear()
        self._reset_app_readouts()

    def _reset_app_readouts(self):
        if self._package:
            self.cpu_app.setText(f"■ {self._package}: …")
            self.mem_app.setText(f"■ {self._package}: …")
        else:
            self.cpu_app.setText("")
            self.mem_app.setText("")

    def _on_sample(self, s: dict):
        pct = s.get("cpu")
        app = s.get("app")
        acpu = (app or {}).get("cpu")
        if pct is None:
            self.cpu_value.setText("…")
        else:
            self.cpu_value.setText(f"{pct:.0f}%")
            self.cpu_graph.push(pct / 100.0, None if acpu is None else acpu / 100.0)
        if s.get("cores_pct") is not None:
            self.core_bars.set_values(s["cores_pct"])
        cores = s.get("cores") or 0
        load = s.get("load")
        bits = []
        if cores:
            bits.append(f"{cores} cores")
        if load:
            bits.append("load " + " / ".join(f"{x:.2f}" for x in load))
        self.cpu_sub.setText("   ·   ".join(bits) or " ")

        mem = s.get("mem")
        total = 0
        if mem:
            used, total = mem
            frac = used / total if total else 0
            self.mem_value.setText(f"{self._gb(used)} / {self._gb(total)} GB  ({frac*100:.0f}%)")
            amem = (app or {}).get("mem_kb")
            self.mem_graph.push(frac, None if (not amem or not total) else amem / total)
            self.mem_sub.setText(f"{self._gb(total - used)} GB free")

        bat = s.get("battery")
        if bat:
            self.bat_value.setText(f"{bat['level']}%")
            bits = []
            if bat.get("temp_c") is not None:
                bits.append(f"{bat['temp_c']:.1f} °C")
            bits.append("charging" if bat.get("powered") else "unplugged")
            self.bat_sub.setText("   ·   ".join(bits))
            self.bat_graph.push(bat["level"] / 100.0)

        gfx = s.get("gfx")
        if self._package:
            if gfx:
                shown = gfx.get("recent_pct", gfx.get("janky_pct", 0.0))
                self.gfx_value.setText(f"{shown:.1f}% janky")
                pcts = "  ".join(f"p{p} {gfx[f'p{p}']}ms" for p in (50, 90, 95, 99)
                                 if f"p{p}" in gfx)
                self.gfx_sub.setText(
                    f"{gfx['total']:,} frames · {gfx['janky']:,} janky "
                    f"({gfx['janky_pct']:.1f}% lifetime)   {pcts}")
                self.gfx_graph.push(min(1.0, shown / 100.0))
            else:
                self.gfx_value.setText("—")
                self.gfx_sub.setText("no frames rendered (app visible?)")

        # app overlay read-outs
        if app is not None:
            self.cpu_app.setText(
                f"■ {self._package}: {acpu:.0f}%" if acpu is not None
                else f"■ {self._package}: not running")
            amem = app.get("mem_kb")
            self.mem_app.setText(
                f"■ {self._package}: {self._mb(amem)} MB PSS" if amem
                else f"■ {self._package}: not running")

    def _on_failed(self, message: str):
        self._stop()
        self._reset_readouts()
        self.cpu_sub.setText("Could not read device stats")
        self.failed.emit(f"Monitor: {message}")

    @staticmethod
    def _gb(kb: int) -> str:
        return f"{kb / 1024 / 1024:.2f}"

    @staticmethod
    def _mb(kb: int) -> str:
        return f"{kb / 1024:,.0f}"
