"""Toolbox tab: groups the small one-shot dev tools (Intents, Monkey, Perfetto,
Notifications, Bugreport) as sub-tabs and fans set_serial/set_package + the
status/failed/saved signals between them and the main window, so ui.py wires
one view instead of five.
"""
from __future__ import annotations

from PyQt6.QtCore import pyqtSignal
from PyQt6.QtWidgets import QTabWidget, QVBoxLayout, QWidget

from .bugreport import BugreportView
from .intents import IntentView
from .notifs import NotifsView
from .perfetto import PerfettoView
from .stress import MonkeyView


class ToolboxView(QWidget):
    status = pyqtSignal(str)
    failed = pyqtSignal(str)
    saved = pyqtSignal(bool, str, str)

    def __init__(self, adb: str, parent=None):
        super().__init__(parent)
        v = QVBoxLayout(self)
        v.setContentsMargins(0, 0, 0, 0)
        v.setSpacing(0)
        self.tabs = QTabWidget()
        self.tabs.setDocumentMode(True)
        self.intents = IntentView(adb)
        self.monkey = MonkeyView(adb)
        self.perfetto = PerfettoView(adb)
        self.notifs = NotifsView(adb)
        self.bugreport = BugreportView(adb)
        self.tabs.addTab(self.intents, "Intents")
        self.tabs.addTab(self.monkey, "Monkey")
        self.tabs.addTab(self.perfetto, "Perfetto")
        self.tabs.addTab(self.notifs, "Notifications")
        self.tabs.addTab(self.bugreport, "Bugreport")
        v.addWidget(self.tabs)
        self._panes = [self.intents, self.monkey, self.perfetto,
                       self.notifs, self.bugreport]
        for pane in self._panes:
            pane.status.connect(self.status)
            pane.failed.connect(self.failed)
            if hasattr(pane, "saved"):
                pane.saved.connect(self.saved)

    def set_serial(self, serial):
        for pane in self._panes:
            pane.set_serial(serial)

    def set_package(self, package):
        for pane in self._panes:
            if hasattr(pane, "set_package"):
                pane.set_package(package)

    def shutdown(self):
        for pane in self._panes:
            pane.shutdown()
