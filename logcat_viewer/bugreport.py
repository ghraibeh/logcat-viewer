"""One-click full bugreport (`adb bugreport <file>.zip`) with live progress —
adb prints `[ 55%/100%]`-style lines while the device assembles the report.
"""
from __future__ import annotations

import os
import re
import subprocess
import time

from PyQt6.QtCore import QThread, pyqtSignal
from PyQt6.QtWidgets import QHBoxLayout, QLabel, QProgressBar, QPushButton, QVBoxLayout, QWidget

_PCT_RE = re.compile(r"(\d+)[%/]")


class BugreportWorker(QThread):
    progress = pyqtSignal(int)          # 0..100 (best effort)
    done = pyqtSignal(bool, str, str)   # ok, message, directory

    def __init__(self, adb, serial, dest, parent=None):
        super().__init__(parent)
        self._adb, self._serial, self._dest = adb, serial, dest
        self._proc: subprocess.Popen | None = None
        self._cancel = False

    def cancel(self):
        self._cancel = True
        if self._proc is not None:
            self._proc.kill()

    def run(self):
        try:
            self._proc = subprocess.Popen(
                [self._adb, "-s", self._serial, "bugreport", self._dest],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                errors="replace")
            for line in self._proc.stdout:
                m = _PCT_RE.search(line)
                if m:
                    self.progress.emit(min(100, int(m.group(1))))
            code = self._proc.wait()
        except (subprocess.SubprocessError, OSError) as exc:
            self.done.emit(False, f"bugreport failed: {exc}", "")
            return
        if self._cancel:
            self.done.emit(False, "Bugreport cancelled", "")
        elif code == 0 and os.path.exists(self._dest):
            self.done.emit(True, f"Bugreport saved: {os.path.basename(self._dest)}",
                           os.path.dirname(self._dest))
        else:
            self.done.emit(False, f"bugreport exited with code {code}", "")


class BugreportView(QWidget):
    """Toolbox pane: generate a full bugreport zip into ~/Downloads."""
    status = pyqtSignal(str)
    failed = pyqtSignal(str)
    saved = pyqtSignal(bool, str, str)

    def __init__(self, adb: str, parent=None):
        super().__init__(parent)
        self._adb = adb or ""
        self._serial: str | None = None
        self._worker: BugreportWorker | None = None
        root = QVBoxLayout(self)
        root.setContentsMargins(16, 12, 16, 12)
        root.setSpacing(10)
        row = QHBoxLayout()
        self.go_btn = QPushButton("🧾  Generate bugreport")
        self.go_btn.clicked.connect(self.toggle)
        row.addWidget(self.go_btn)
        self.bar = QProgressBar()
        self.bar.setRange(0, 100)
        self.bar.setValue(0)
        self.bar.setVisible(False)
        row.addWidget(self.bar, 1)
        root.addLayout(row)
        info = QLabel("Full device bugreport (dumpstate + dumpsys + logs) zipped to "
                      "~/Downloads. Takes a minute or two.")
        info.setObjectName("MockStatus")
        root.addWidget(info)
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
            self.failed.emit("Bugreport: no device selected")
            return
        d = os.path.expanduser("~/Downloads")
        if not os.path.isdir(d):
            d = os.path.expanduser("~")
        safe = "".join(c if c.isalnum() else "_" for c in self._serial)
        dest = os.path.join(d, f"bugreport-{safe}-{time.strftime('%Y%m%d-%H%M%S')}.zip")
        self.go_btn.setText("■  Cancel")
        self.bar.setVisible(True)
        self.bar.setValue(0)
        self.status.emit("Generating bugreport…")
        self._worker = BugreportWorker(self._adb, self._serial, dest, self)
        self._worker.progress.connect(self.bar.setValue)
        self._worker.done.connect(self._on_done)
        self._worker.start()

    def _on_done(self, ok: bool, message: str, directory: str):
        self._worker = None
        self.go_btn.setText("🧾  Generate bugreport")
        self.bar.setVisible(False)
        if ok:
            self.saved.emit(True, message, directory)
        else:
            self.failed.emit(message)
