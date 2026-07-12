"""Notification inspector: parse the device's active notifications out of
`dumpsys notification --noredact` (package, channel, when, title/text where the
build exposes them). Read-only, no root needed. The parser is best-effort over
a notoriously free-form dump and is smoke-tested against a captured sample.
"""
from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass, field

from PyQt6.QtCore import QThread, pyqtSignal
from PyQt6.QtWidgets import (
    QHBoxLayout, QHeaderView, QLabel, QPushButton, QTableWidget,
    QTableWidgetItem, QVBoxLayout, QWidget,
)


def dump_args(serial: str) -> list[str]:
    return ["-s", serial, "shell", "dumpsys", "notification", "--noredact"]


@dataclass
class NotifItem:
    pkg: str
    channel: str = ""
    title: str = ""
    text: str = ""
    when: str = ""
    key: str = ""
    extra: dict = field(default_factory=dict)


_REC_RE = re.compile(r"NotificationRecord\([^)]*pkg=(\S+?)[\s)]")
_FIELD_RES = {
    "title": re.compile(r"android\.title=(?:String\s*)?\((.*?)\)"),
    "text": re.compile(r"android\.text=(?:String\s*)?\((.*?)\)"),
    "channel": re.compile(r"NotificationChannel\{[^}]*?m?[Ii]d='([^']+)'", re.S),
    "when": re.compile(r"when=(\S+)"),
    "key": re.compile(r"key=(\S+)"),
}


def parse_notifications(text: str) -> list[NotifItem]:
    """Split the dump into NotificationRecord blocks and pull the fields we
    can rely on across Android versions."""
    heads = list(_REC_RE.finditer(text))
    items: list[NotifItem] = []
    seen: set[str] = set()
    for i, m in enumerate(heads):
        block = text[m.start():heads[i + 1].start() if i + 1 < len(heads) else len(text)]
        it = NotifItem(pkg=m.group(1))
        for name, rx in _FIELD_RES.items():
            fm = rx.search(block)
            if fm:
                setattr(it, name, fm.group(1))
        if it.key and it.key in seen:
            continue   # the dump repeats records in several sections
        seen.add(it.key or f"{it.pkg}/{len(items)}")
        items.append(it)
    return items


class NotifWorker(QThread):
    done = pyqtSignal(bool, str, list)

    def __init__(self, adb, serial, parent=None):
        super().__init__(parent)
        self._adb, self._serial = adb, serial

    def run(self):
        try:
            r = subprocess.run([self._adb, *dump_args(self._serial)],
                               capture_output=True, text=True, errors="replace",
                               timeout=20)
        except (subprocess.SubprocessError, OSError) as exc:
            self.done.emit(False, str(exc), [])
            return
        items = parse_notifications(r.stdout)
        self.done.emit(True, f"{len(items)} active notification(s)", items)


class NotifsView(QWidget):
    """Toolbox pane: table of active notifications, refresh on demand."""
    status = pyqtSignal(str)
    failed = pyqtSignal(str)

    def __init__(self, adb: str, parent=None):
        super().__init__(parent)
        self._adb = adb or ""
        self._serial: str | None = None
        self._worker: NotifWorker | None = None
        self._build()

    def _build(self):
        root = QVBoxLayout(self)
        root.setContentsMargins(16, 12, 16, 12)
        root.setSpacing(10)
        row = QHBoxLayout()
        self.refresh_btn = QPushButton("⟳  Refresh")
        self.refresh_btn.clicked.connect(self.refresh)
        row.addWidget(self.refresh_btn)
        self.count_lbl = QLabel("")
        self.count_lbl.setObjectName("MockStatus")
        row.addWidget(self.count_lbl)
        row.addStretch(1)
        root.addLayout(row)
        self.table = QTableWidget(0, 5)
        self.table.setHorizontalHeaderLabels(["package", "channel", "title", "text", "when"])
        self.table.horizontalHeader().setSectionResizeMode(3, QHeaderView.ResizeMode.Stretch)
        self.table.verticalHeader().setVisible(False)
        self.table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        root.addWidget(self.table, 1)

    def set_serial(self, serial: str | None):
        if serial != self._serial:
            self._serial = serial
            self.table.setRowCount(0)
            self.count_lbl.setText("")

    def shutdown(self):
        if self._worker is not None:
            self._worker.wait(2000)
            self._worker = None

    def refresh(self):
        if not (self._adb and self._serial):
            self.failed.emit("Notifications: no device selected")
            return
        if self._worker is not None:
            return
        self.refresh_btn.setEnabled(False)
        self._worker = NotifWorker(self._adb, self._serial, self)
        self._worker.done.connect(self._on_done)
        self._worker.start()

    def _on_done(self, ok: bool, message: str, items: list):
        self._worker = None
        self.refresh_btn.setEnabled(True)
        if not ok:
            self.failed.emit(f"Notifications: {message}")
            return
        self.table.setRowCount(len(items))
        for r, it in enumerate(items):
            for c, val in enumerate((it.pkg, it.channel, it.title, it.text, it.when)):
                self.table.setItem(r, c, QTableWidgetItem(val))
        self.count_lbl.setText(message)
        self.status.emit(f"Notifications: {message}")
