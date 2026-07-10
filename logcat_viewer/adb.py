"""adb discovery + a QProcess-backed live `logcat` reader."""
from __future__ import annotations

import os
import shutil
import subprocess
from dataclasses import dataclass

from PyQt6.QtCore import QProcess, pyqtSignal, QObject

from .resources import bundled_adb

# Common macOS locations for adb if it isn't on PATH.
_FALLBACK_ADB = [
    os.path.expanduser("~/Android/sdk/platform-tools/adb"),
    os.path.expanduser("~/Library/Android/sdk/platform-tools/adb"),
    "/opt/homebrew/bin/adb",
    "/usr/local/bin/adb",
]


def find_adb() -> str | None:
    """Resolve the adb binary: $ADB, bundled copy, PATH, then common SDK paths."""
    env = os.environ.get("ADB")
    if env and os.path.exists(env):
        return env
    bundled = bundled_adb()
    if bundled:
        return bundled
    which = shutil.which("adb")
    if which:
        return which
    for cand in _FALLBACK_ADB:
        if os.path.exists(cand):
            return cand
    return None


@dataclass
class Device:
    serial: str
    state: str          # "device", "offline", "unauthorized", ...
    description: str     # model / product info from `adb devices -l`

    @property
    def online(self) -> bool:
        return self.state == "device"

    @property
    def label(self) -> str:
        extra = f" — {self.description}" if self.description else ""
        state = "" if self.online else f" [{self.state}]"
        return f"{self.serial}{extra}{state}"


def list_devices(adb: str) -> list[Device]:
    """Run `adb devices -l` and parse the table."""
    try:
        out = subprocess.run(
            [adb, "devices", "-l"], capture_output=True, text=True, timeout=8
        ).stdout
    except (subprocess.SubprocessError, OSError):
        return []
    devices: list[Device] = []
    for line in out.splitlines()[1:]:  # skip "List of devices attached"
        line = line.strip()
        if not line or line.startswith("*"):
            continue
        parts = line.split()
        if len(parts) < 2:
            continue
        serial, state = parts[0], parts[1]
        desc_bits = []
        for p in parts[2:]:
            if p.startswith("model:"):
                desc_bits.insert(0, p.split(":", 1)[1].replace("_", " "))
            elif p.startswith("device:"):
                desc_bits.append(p.split(":", 1)[1])
        devices.append(Device(serial, state, " ".join(desc_bits)))
    return devices


class LogcatReader(QObject):
    """Spawns `adb -s <serial> logcat -v threadtime` and emits decoded lines
    in batches. Runs on the Qt event loop (no extra threads)."""

    linesReady = pyqtSignal(list)   # list[str] — raw text lines
    stateChanged = pyqtSignal(str)  # "started" | "stopped" | "error"
    error = pyqtSignal(str)

    def __init__(self, adb: str, parent=None):
        super().__init__(parent)
        self._adb = adb
        self._proc: QProcess | None = None
        self._buf = b""

    @property
    def running(self) -> bool:
        return self._proc is not None and self._proc.state() != QProcess.ProcessState.NotRunning

    def start(self, serial: str, clear_first: bool = False) -> None:
        self.stop()
        if clear_first:
            try:
                subprocess.run([self._adb, "-s", serial, "logcat", "-c"], timeout=8)
            except (subprocess.SubprocessError, OSError):
                pass
        self._buf = b""
        proc = QProcess(self)
        proc.setProcessChannelMode(QProcess.ProcessChannelMode.SeparateChannels)
        proc.readyReadStandardOutput.connect(self._on_stdout)
        proc.readyReadStandardError.connect(self._on_stderr)
        proc.started.connect(lambda: self.stateChanged.emit("started"))
        proc.finished.connect(self._on_finished)
        proc.errorOccurred.connect(self._on_proc_error)
        self._proc = proc
        proc.start(self._adb, ["-s", serial, "logcat", "-v", "threadtime"])

    def stop(self) -> None:
        if self._proc is not None:
            self._proc.readyReadStandardOutput.disconnect()
            self._proc.kill()
            self._proc.waitForFinished(1500)
            self._proc = None
            self.stateChanged.emit("stopped")

    # --- QProcess plumbing -------------------------------------------------
    def _on_stdout(self) -> None:
        if self._proc is None:
            return
        self._buf += bytes(self._proc.readAllStandardOutput())
        if b"\n" not in self._buf:
            return
        chunk, _, self._buf = self._buf.rpartition(b"\n")  # keep partial tail
        text = chunk.decode("utf-8", errors="replace")
        lines = text.split("\n")
        if lines:
            self.linesReady.emit(lines)

    def _on_stderr(self) -> None:
        if self._proc is None:
            return
        data = bytes(self._proc.readAllStandardError()).decode("utf-8", errors="replace").strip()
        if data:
            self.error.emit(data)

    def _on_finished(self, code, status) -> None:
        self._proc = None
        self.stateChanged.emit("stopped")

    def _on_proc_error(self, err) -> None:
        self.error.emit(f"process error: {err}")
        self.stateChanged.emit("error")
