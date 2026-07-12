"""Perfetto system-trace capture: run `perfetto` on the device (Android 9+)
with a category preset + duration, pull the trace, and hand off to
ui.perfetto.dev (the trace file is opened locally there — nothing uploads
without the user doing it).
"""
from __future__ import annotations

import os
import subprocess
import time

from PyQt6.QtCore import QThread, QUrl, pyqtSignal
from PyQt6.QtGui import QDesktopServices
from PyQt6.QtWidgets import (
    QComboBox, QHBoxLayout, QLabel, QPushButton, QVBoxLayout, QWidget,
)

REMOTE_TRACE = "/data/misc/perfetto-traces/logcatviewer.perfetto-trace"

PRESETS = [
    ("UI / jank", ["gfx", "view", "wm", "am", "input", "sched", "freq"]),
    ("Scheduling", ["sched", "freq", "idle", "binder_driver"]),
    ("Memory", ["am", "dalvik", "memory", "sched"]),
    ("Everything", ["gfx", "view", "wm", "am", "input", "sched", "freq", "idle",
                    "binder_driver", "dalvik", "memory", "hal", "res"]),
]
DURATIONS = [("5 s", 5), ("10 s", 10), ("30 s", 30), ("60 s", 60)]


def perfetto_args(serial: str, duration_s: int, categories: list[str]) -> list[str]:
    return ["-s", serial, "shell", "perfetto", "-o", REMOTE_TRACE,
            "-t", f"{duration_s}s", *categories]


def pull_trace_args(serial: str, dest: str) -> list[str]:
    return ["-s", serial, "pull", REMOTE_TRACE, dest]


class PerfettoWorker(QThread):
    done = pyqtSignal(bool, str, str)   # ok, message, local path

    def __init__(self, adb, serial, duration_s, categories, dest, parent=None):
        super().__init__(parent)
        self._adb, self._serial = adb, serial
        self._duration, self._cats, self._dest = duration_s, categories, dest
        self._proc: subprocess.Popen | None = None
        self._cancel = False

    def cancel(self):
        self._cancel = True
        if self._proc is not None:
            self._proc.kill()

    def run(self):
        try:
            self._proc = subprocess.Popen(
                [self._adb, *perfetto_args(self._serial, self._duration, self._cats)],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            _, err = self._proc.communicate(timeout=self._duration + 30)
            if self._cancel:
                self.done.emit(False, "Cancelled", "")
                return
            if self._proc.returncode != 0:
                hint = (err or "").strip().splitlines()
                self.done.emit(False, "perfetto failed: "
                               + (hint[-1] if hint else "requires Android 9+"), "")
                return
            r = subprocess.run([self._adb, *pull_trace_args(self._serial, self._dest)],
                               capture_output=True, text=True, timeout=120)
            if r.returncode != 0:
                self.done.emit(False, (r.stderr or r.stdout).strip(), "")
                return
        except subprocess.TimeoutExpired:
            if self._proc:
                self._proc.kill()
            self.done.emit(False, "perfetto timed out", "")
            return
        except (subprocess.SubprocessError, OSError) as exc:
            self.done.emit(False, str(exc), "")
            return
        self.done.emit(True, f"Trace saved: {os.path.basename(self._dest)}", self._dest)


class PerfettoView(QWidget):
    """Toolbox pane: preset + duration → capture → open in ui.perfetto.dev."""
    status = pyqtSignal(str)
    failed = pyqtSignal(str)
    saved = pyqtSignal(bool, str, str)

    def __init__(self, adb: str, parent=None):
        super().__init__(parent)
        self._adb = adb or ""
        self._serial: str | None = None
        self._worker: PerfettoWorker | None = None
        self._last_trace = ""
        self._build()

    def _build(self):
        root = QVBoxLayout(self)
        root.setContentsMargins(16, 12, 16, 12)
        root.setSpacing(10)
        row = QHBoxLayout()
        row.setSpacing(8)
        row.addWidget(QLabel("Categories"))
        self.preset_combo = QComboBox()
        for name, cats in PRESETS:
            self.preset_combo.addItem(name, cats)
        row.addWidget(self.preset_combo)
        row.addWidget(QLabel("Duration"))
        self.dur_combo = QComboBox()
        for label, s in DURATIONS:
            self.dur_combo.addItem(label, s)
        self.dur_combo.setCurrentIndex(1)
        row.addWidget(self.dur_combo)
        self.rec_btn = QPushButton("⏺  Record trace")
        self.rec_btn.clicked.connect(self.toggle)
        row.addWidget(self.rec_btn)
        self.open_btn = QPushButton("Open ui.perfetto.dev")
        self.open_btn.setToolTip("Open the trace viewer — drag the saved file in")
        self.open_btn.clicked.connect(
            lambda: QDesktopServices.openUrl(QUrl("https://ui.perfetto.dev")))
        row.addWidget(self.open_btn)
        row.addStretch(1)
        root.addLayout(row)
        self.info = QLabel(
            "Captures a system trace (scheduling, frames, binder, memory…) with the\n"
            "device's built-in perfetto (Android 9+). The trace saves to ~/Downloads;\n"
            "inspect it in ui.perfetto.dev.")
        self.info.setObjectName("MockStatus")
        root.addWidget(self.info)
        root.addStretch(1)

    def set_serial(self, serial: str | None):
        self._serial = serial

    def shutdown(self):
        if self._worker is not None:
            self._worker.cancel()
            self._worker.wait(3000)
            self._worker = None

    def toggle(self):
        if self._worker is not None:
            self._worker.cancel()
            return
        if not (self._adb and self._serial):
            self.failed.emit("Perfetto: no device selected")
            return
        d = os.path.expanduser("~/Downloads")
        if not os.path.isdir(d):
            d = os.path.expanduser("~")
        dest = os.path.join(d, f"trace-{time.strftime('%Y%m%d-%H%M%S')}.perfetto-trace")
        dur = self.dur_combo.currentData()
        self.rec_btn.setText("■  Stop")
        self.status.emit(f"Recording {dur}s perfetto trace…")
        self._worker = PerfettoWorker(self._adb, self._serial, dur,
                                      self.preset_combo.currentData(), dest, self)
        self._worker.done.connect(self._on_done)
        self._worker.start()

    def _on_done(self, ok: bool, message: str, path: str):
        self._worker = None
        self.rec_btn.setText("⏺  Record trace")
        if ok:
            self._last_trace = path
            self.saved.emit(True, message, os.path.dirname(path))
        else:
            self.failed.emit(f"Perfetto: {message}")
