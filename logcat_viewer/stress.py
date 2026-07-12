"""Monkey stress-test runner: fire `adb shell monkey -p <pkg>` with seed /
throttle / event-count, stream its output live, and stop it cleanly (killing
the local adb AND the on-device monkey process — a straggler keeps injecting
events long after the cable command dies).
"""
from __future__ import annotations

import subprocess

from PyQt6.QtCore import QThread, pyqtSignal
from PyQt6.QtGui import QFont
from PyQt6.QtWidgets import (
    QHBoxLayout, QLabel, QPlainTextEdit, QPushButton, QSpinBox, QVBoxLayout,
    QWidget,
)

# Kill any monkey left on the device (its full cmdline is the am jar invocation).
KILL_MONKEY = "kill -9 $(pgrep -f com.android.commands.monkey) 2>/dev/null; true"


def monkey_args(serial: str, package: str, events: int, seed: int,
                throttle_ms: int) -> list[str]:
    return ["-s", serial, "shell", "monkey", "-p", package, "-s", str(seed),
            "--throttle", str(throttle_ms), "--ignore-security-exceptions",
            "-v", str(events)]


class MonkeyWorker(QThread):
    line = pyqtSignal(str)
    done = pyqtSignal(bool, str)   # ok, summary

    def __init__(self, adb, serial, package, events, seed, throttle, parent=None):
        super().__init__(parent)
        self._adb, self._serial = adb, serial
        self._args = monkey_args(serial, package, events, seed, throttle)
        self._proc: subprocess.Popen | None = None
        self._stop = False

    def stop(self):
        self._stop = True
        if self._proc is not None:
            self._proc.kill()

    def run(self):
        try:
            self._proc = subprocess.Popen(
                [self._adb, *self._args], stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT, text=True, errors="replace")
            crashed = False
            for out_line in self._proc.stdout:
                out_line = out_line.rstrip()
                if not out_line:
                    continue
                if "// CRASH" in out_line or "// NOT RESPONDING" in out_line:
                    crashed = True
                self.line.emit(out_line)
            code = self._proc.wait()
        except (subprocess.SubprocessError, OSError) as exc:
            self.done.emit(False, f"monkey failed: {exc}")
            return
        finally:
            # Never leave a monkey running on the device.
            try:
                subprocess.run([self._adb, "-s", self._serial, "shell", KILL_MONKEY],
                               capture_output=True, timeout=8)
            except (subprocess.SubprocessError, OSError):
                pass
        if self._stop:
            self.done.emit(True, "Monkey stopped")
        elif crashed:
            self.done.emit(False, "Monkey aborted — the app crashed or ANR'd "
                                  "(see the Crashes tab)")
        else:
            self.done.emit(code == 0, "Monkey finished" if code == 0
                           else f"monkey exited with code {code}")


class MonkeyView(QWidget):
    """Toolbox pane: parameters + live output. Follows the shared App picker."""
    status = pyqtSignal(str)
    failed = pyqtSignal(str)

    def __init__(self, adb: str, parent=None):
        super().__init__(parent)
        self._adb = adb or ""
        self._serial: str | None = None
        self._package: str | None = None
        self._worker: MonkeyWorker | None = None
        self._build()

    def _build(self):
        root = QVBoxLayout(self)
        root.setContentsMargins(16, 12, 16, 12)
        root.setSpacing(10)
        row = QHBoxLayout()
        row.setSpacing(8)
        self.pkg_lbl = QLabel("Pick an app in the App box")
        row.addWidget(self.pkg_lbl)
        row.addSpacing(10)
        row.addWidget(QLabel("Events"))
        self.events_spin = QSpinBox()
        self.events_spin.setRange(10, 1_000_000)
        self.events_spin.setValue(500)
        row.addWidget(self.events_spin)
        row.addWidget(QLabel("Seed"))
        self.seed_spin = QSpinBox()
        self.seed_spin.setRange(0, 1_000_000)
        self.seed_spin.setValue(42)
        self.seed_spin.setToolTip("Same seed → same event sequence (reproducible crashes)")
        row.addWidget(self.seed_spin)
        row.addWidget(QLabel("Throttle ms"))
        self.throttle_spin = QSpinBox()
        self.throttle_spin.setRange(0, 5000)
        self.throttle_spin.setValue(100)
        row.addWidget(self.throttle_spin)
        row.addStretch(1)
        self.start_btn = QPushButton("🐒  Start monkey")
        self.start_btn.clicked.connect(self.toggle)
        row.addWidget(self.start_btn)
        root.addLayout(row)

        self.out = QPlainTextEdit()
        self.out.setReadOnly(True)
        self.out.setMaximumBlockCount(2000)   # keep the log bounded
        self.out.setFrameShape(QPlainTextEdit.Shape.NoFrame)
        mono = QFont("SF Mono")
        mono.setStyleHint(QFont.StyleHint.Monospace)
        mono.setPointSize(11)
        self.out.setFont(mono)
        self.out.setPlaceholderText(
            "Random UI stress events are injected into the selected app.\n"
            "Same seed = same sequence, so crashes are reproducible.")
        root.addWidget(self.out, 1)

    def set_serial(self, serial: str | None):
        self._serial = serial

    def set_package(self, package: str | None):
        self._package = package or None
        self.pkg_lbl.setText(self._package or "Pick an app in the App box")

    def shutdown(self):
        if self._worker is not None:
            self._worker.stop()
            self._worker.wait(3000)
            self._worker = None

    def toggle(self):
        if self._worker is not None:
            self._worker.stop()
            return
        if not (self._adb and self._serial):
            self.failed.emit("Monkey: no device selected")
            return
        if not self._package:
            self.failed.emit("Monkey: pick an app in the App box first")
            return
        self.out.clear()
        self.start_btn.setText("■  Stop")
        self.status.emit(f"Monkey → {self._package}")
        self._worker = MonkeyWorker(self._adb, self._serial, self._package,
                                    self.events_spin.value(), self.seed_spin.value(),
                                    self.throttle_spin.value(), self)
        self._worker.line.connect(self.out.appendPlainText)
        self._worker.done.connect(self._on_done)
        self._worker.start()

    def _on_done(self, ok: bool, summary: str):
        self._worker = None
        self.start_btn.setText("🐒  Start monkey")
        self.out.appendPlainText(f"\n— {summary}")
        if ok:
            self.status.emit(f"✓ {summary}")
        else:
            self.failed.emit(summary)
