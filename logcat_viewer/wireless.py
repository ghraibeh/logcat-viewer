"""Wireless adb: pair (Android 11+ Wi-Fi debugging), connect to host:port, and
one-click "switch the current USB device to Wi-Fi" (tcpip 5555 + connect to the
device's wlan IP). Pure arg builders + IP parsing are smoke-tested; every adb
call runs on a one-shot worker.
"""
from __future__ import annotations

import re
import subprocess
import time

from PyQt6.QtCore import QThread, pyqtSignal
from PyQt6.QtWidgets import (
    QDialog, QGridLayout, QHBoxLayout, QLabel, QLineEdit, QPushButton,
    QVBoxLayout,
)


# --- pure builders / parsers -----------------------------------------------------
def pair_args(host_port: str, code: str) -> list[str]:
    return ["pair", host_port, code]


def connect_args(host_port: str) -> list[str]:
    return ["connect", host_port]


def tcpip_args(serial: str, port: int = 5555) -> list[str]:
    return ["-s", serial, "tcpip", str(port)]


def ip_route_args(serial: str) -> list[str]:
    return ["-s", serial, "shell", "ip", "route"]


def parse_device_ip(ip_route_out: str) -> str | None:
    """The device's wlan IP from `ip route` (the `src` of the wlan subnet)."""
    for line in ip_route_out.splitlines():
        if "wlan" in line:
            m = re.search(r"\bsrc\s+(\d+\.\d+\.\d+\.\d+)", line)
            if m:
                return m.group(1)
    m = re.search(r"\bsrc\s+(\d+\.\d+\.\d+\.\d+)", ip_route_out)
    return m.group(1) if m else None


def looks_ok(out: str) -> bool:
    low = out.lower()
    return ("successfully paired" in low or "connected to" in low
            or "already connected" in low or "restarting in tcp" in low)


class WirelessWorker(QThread):
    """Run one wireless op: 'pair' | 'connect' | 'switch' (tcpip→connect)."""
    done = pyqtSignal(bool, str)   # ok, message

    def __init__(self, adb: str, op: str, host_port: str = "", code: str = "",
                 serial: str = "", parent=None):
        super().__init__(parent)
        self._adb, self._op = adb, op
        self._host_port, self._code, self._serial = host_port, code, serial

    def _run(self, args, timeout=25) -> str:
        r = subprocess.run([self._adb, *args], capture_output=True, text=True,
                           errors="replace", timeout=timeout)
        return (r.stdout + "\n" + r.stderr).strip()

    def run(self):
        try:
            if self._op == "pair":
                out = self._run(pair_args(self._host_port, self._code))
            elif self._op == "connect":
                out = self._run(connect_args(self._host_port))
            else:  # switch: current USB device → Wi-Fi
                ip = parse_device_ip(self._run(ip_route_args(self._serial)))
                if not ip:
                    self.done.emit(False, "Couldn't find the device's Wi-Fi IP "
                                          "(is Wi-Fi connected?)")
                    return
                out = self._run(tcpip_args(self._serial))
                if "error" in out.lower():
                    self.done.emit(False, out)
                    return
                time.sleep(1.5)   # adbd restarts in TCP mode
                out = self._run(connect_args(f"{ip}:5555"))
        except (subprocess.SubprocessError, OSError) as exc:
            self.done.emit(False, str(exc))
            return
        self.done.emit(looks_ok(out), out or "(no output)")


class WirelessDialog(QDialog):
    """Non-modal Wi-Fi connection dialog; emits `devices_changed` on success so
    the main window can refresh its device list."""
    devices_changed = pyqtSignal()

    def __init__(self, adb: str, current_serial: str | None, parent=None):
        super().__init__(parent)
        self.setWindowTitle("Connect over Wi-Fi")
        self._adb = adb
        self._serial = current_serial
        self._worker: WirelessWorker | None = None

        v = QVBoxLayout(self)
        v.setSpacing(10)

        hint = QLabel(
            "Enable Wireless debugging on the device (Developer options), then\n"
            "pair once with the code shown under “Pair device with pairing code”.")
        hint.setObjectName("MockStatus")
        v.addWidget(hint)

        grid = QGridLayout()
        grid.setHorizontalSpacing(8)
        grid.setVerticalSpacing(8)
        grid.addWidget(QLabel("Pair"), 0, 0)
        self.pair_edit = QLineEdit()
        self.pair_edit.setPlaceholderText("192.168.1.42:37123")
        grid.addWidget(self.pair_edit, 0, 1)
        self.code_edit = QLineEdit()
        self.code_edit.setPlaceholderText("pairing code")
        self.code_edit.setMaximumWidth(120)
        grid.addWidget(self.code_edit, 0, 2)
        self.pair_btn = QPushButton("Pair")
        self.pair_btn.clicked.connect(self._pair)
        grid.addWidget(self.pair_btn, 0, 3)

        grid.addWidget(QLabel("Connect"), 1, 0)
        self.connect_edit = QLineEdit()
        self.connect_edit.setPlaceholderText("192.168.1.42:5555   (or :37000 wireless-debug port)")
        grid.addWidget(self.connect_edit, 1, 1, 1, 2)
        self.connect_btn = QPushButton("Connect")
        self.connect_btn.clicked.connect(self._connect)
        grid.addWidget(self.connect_btn, 1, 3)
        v.addLayout(grid)

        row = QHBoxLayout()
        self.switch_btn = QPushButton("Switch current USB device to Wi-Fi")
        self.switch_btn.setToolTip("adb tcpip 5555 + connect to the device's wlan IP — "
                                   "unplug the cable afterwards")
        self.switch_btn.setEnabled(bool(current_serial))
        self.switch_btn.clicked.connect(self._switch)
        row.addWidget(self.switch_btn)
        row.addStretch(1)
        close_btn = QPushButton("Close")
        close_btn.clicked.connect(self.close)
        row.addWidget(close_btn)
        v.addLayout(row)

        self.result_lbl = QLabel("")
        self.result_lbl.setWordWrap(True)
        self.result_lbl.setObjectName("MockStatus")
        v.addWidget(self.result_lbl)
        self.resize(520, 220)

    def _busy(self, on: bool, msg: str = ""):
        for b in (self.pair_btn, self.connect_btn, self.switch_btn):
            b.setEnabled(not on)
        if not on:
            self.switch_btn.setEnabled(bool(self._serial))
        if msg:
            self.result_lbl.setText(msg)

    def _start(self, op: str, **kw):
        if self._worker is not None:
            return
        self._busy(True, "Working…")
        self._worker = WirelessWorker(self._adb, op, serial=self._serial or "", **kw)
        self._worker.done.connect(self._on_done)
        self._worker.start()

    def _pair(self):
        hp, code = self.pair_edit.text().strip(), self.code_edit.text().strip()
        if not hp or not code:
            self.result_lbl.setText("Enter the pairing host:port and code")
            return
        self._start("pair", host_port=hp, code=code)

    def _connect(self):
        hp = self.connect_edit.text().strip()
        if not hp:
            self.result_lbl.setText("Enter host:port to connect to")
            return
        self._start("connect", host_port=hp)

    def _switch(self):
        if self._serial:
            self._start("switch")

    def _on_done(self, ok: bool, message: str):
        self._worker = None
        self._busy(False, ("✓  " if ok else "✗  ") + message)
        if ok:
            self.devices_changed.emit()

    def closeEvent(self, event):
        if self._worker is not None:
            self._worker.wait(2000)
            self._worker = None
        super().closeEvent(event)
