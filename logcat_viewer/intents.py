"""Intent / deep-link tester: fire `am start` / `am broadcast` / `am startservice`
at the device with action, data URI, component, mime type and typed extras.

`build_am_args` is a pure builder (unit-tested in smoke); the launch itself is a
one-shot worker that captures `am`'s output (it reports bad intents on stdout).
"""
from __future__ import annotations

import subprocess

from PyQt6.QtCore import QThread, pyqtSignal
from PyQt6.QtGui import QFont
from PyQt6.QtWidgets import (
    QComboBox, QGridLayout, QHBoxLayout, QLabel, QLineEdit, QPlainTextEdit,
    QPushButton, QTableWidget, QTableWidgetItem, QVBoxLayout, QWidget,
)

MODES = [("Start activity", "start"), ("Send broadcast", "broadcast"),
         ("Start service", "startservice")]

EXTRA_TYPES = ["string", "int", "long", "float", "boolean"]
_EXTRA_FLAG = {"string": "--es", "int": "--ei", "long": "--el",
               "float": "--ef", "boolean": "--ez"}


def build_am_args(serial: str, verb: str, action: str = "", data: str = "",
                  mime: str = "", component: str = "",
                  extras: list | None = None) -> list[str]:
    """adb args for one `am` invocation. ``extras`` is [(type, key, value)].
    ``start`` waits (-W) so the result (or the resolver error) comes back."""
    cmd = ["-s", serial, "shell", "am", verb]
    if verb == "start":
        cmd.append("-W")
    if action:
        cmd += ["-a", action]
    if data:
        cmd += ["-d", data]
    if mime:
        cmd += ["-t", mime]
    if component:
        cmd += ["-n", component]
    for typ, key, val in (extras or []):
        flag = _EXTRA_FLAG.get(typ)
        if flag and key:
            cmd += [flag, key, val]
    return cmd


class AmWorker(QThread):
    done = pyqtSignal(bool, str)   # ok, am output

    def __init__(self, adb: str, args: list[str], parent=None):
        super().__init__(parent)
        self._adb = adb
        self._args = args

    def run(self):
        try:
            r = subprocess.run([self._adb, *self._args], capture_output=True,
                               text=True, errors="replace", timeout=25)
        except (subprocess.SubprocessError, OSError) as exc:
            self.done.emit(False, str(exc))
            return
        out = (r.stdout + "\n" + r.stderr).strip()
        bad = ("Error" in out or "Exception" in out or "does not exist" in out
               or "Activity not started" in out or r.returncode != 0)
        self.done.emit(not bad, out or "(no output)")


class IntentView(QWidget):
    """Toolbox pane: compose and fire an intent; keeps a short history log."""
    status = pyqtSignal(str)
    failed = pyqtSignal(str)

    def __init__(self, adb: str, parent=None):
        super().__init__(parent)
        self._adb = adb or ""
        self._serial: str | None = None
        self._worker: AmWorker | None = None
        self._build()

    def _build(self):
        root = QVBoxLayout(self)
        root.setContentsMargins(16, 12, 16, 12)
        root.setSpacing(10)

        # Quick deep-link row — the everyday case.
        quick = QHBoxLayout()
        quick.setSpacing(8)
        quick.addWidget(QLabel("Deep link"))
        self.link_edit = QLineEdit()
        self.link_edit.setPlaceholderText("myapp://path/to/screen   or   https://example.com/…")
        self.link_edit.returnPressed.connect(self._fire_link)
        quick.addWidget(self.link_edit, 1)
        self.link_btn = QPushButton("Open  (VIEW)")
        self.link_btn.setToolTip("am start -W -a android.intent.action.VIEW -d <uri>")
        self.link_btn.clicked.connect(self._fire_link)
        quick.addWidget(self.link_btn)
        root.addLayout(quick)

        grid = QGridLayout()
        grid.setHorizontalSpacing(8)
        grid.setVerticalSpacing(6)
        self.mode_combo = QComboBox()
        for label, verb in MODES:
            self.mode_combo.addItem(label, verb)
        grid.addWidget(QLabel("Mode"), 0, 0)
        grid.addWidget(self.mode_combo, 0, 1)
        self.action_edit = QLineEdit()
        self.action_edit.setPlaceholderText("android.intent.action.VIEW")
        grid.addWidget(QLabel("Action"), 0, 2)
        grid.addWidget(self.action_edit, 0, 3)
        self.data_edit = QLineEdit()
        self.data_edit.setPlaceholderText("data URI  (geo:0,0?q=cafe, content://…, https://…)")
        grid.addWidget(QLabel("Data"), 1, 0)
        grid.addWidget(self.data_edit, 1, 1)
        self.mime_edit = QLineEdit()
        self.mime_edit.setPlaceholderText("mime type  (text/plain)")
        grid.addWidget(QLabel("Type"), 1, 2)
        grid.addWidget(self.mime_edit, 1, 3)
        self.component_edit = QLineEdit()
        self.component_edit.setPlaceholderText("component  com.pkg/.MainActivity  (optional)")
        grid.addWidget(QLabel("Component"), 2, 0)
        grid.addWidget(self.component_edit, 2, 1, 1, 3)
        grid.setColumnStretch(1, 1)
        grid.setColumnStretch(3, 1)
        root.addLayout(grid)

        # Extras table + fire row.
        ex_row = QHBoxLayout()
        ex_row.addWidget(QLabel("Extras"))
        add_btn = QPushButton("+")
        add_btn.setObjectName("toggle")
        add_btn.setToolTip("Add an extra")
        add_btn.clicked.connect(self._add_extra)
        ex_row.addWidget(add_btn)
        rm_btn = QPushButton("−")
        rm_btn.setObjectName("toggle")
        rm_btn.setToolTip("Remove the selected extra")
        rm_btn.clicked.connect(self._rm_extra)
        ex_row.addWidget(rm_btn)
        ex_row.addStretch(1)
        self.fire_btn = QPushButton("⚡  Send intent")
        self.fire_btn.clicked.connect(self._fire_full)
        ex_row.addWidget(self.fire_btn)
        root.addLayout(ex_row)

        self.extras = QTableWidget(0, 3)
        self.extras.setHorizontalHeaderLabels(["type", "key", "value"])
        self.extras.horizontalHeader().setStretchLastSection(True)
        self.extras.verticalHeader().setVisible(False)
        self.extras.setMaximumHeight(120)
        root.addWidget(self.extras)

        self.out = QPlainTextEdit()
        self.out.setReadOnly(True)
        self.out.setFrameShape(QPlainTextEdit.Shape.NoFrame)
        mono = QFont("SF Mono")
        mono.setStyleHint(QFont.StyleHint.Monospace)
        mono.setPointSize(11)
        self.out.setFont(mono)
        self.out.setPlaceholderText("am output appears here…")
        root.addWidget(self.out, 1)

    # --- extras table ------------------------------------------------------------
    def _add_extra(self):
        r = self.extras.rowCount()
        self.extras.insertRow(r)
        combo = QComboBox()
        combo.addItems(EXTRA_TYPES)
        self.extras.setCellWidget(r, 0, combo)
        self.extras.setItem(r, 1, QTableWidgetItem(""))
        self.extras.setItem(r, 2, QTableWidgetItem(""))

    def _rm_extra(self):
        r = self.extras.currentRow()
        if r >= 0:
            self.extras.removeRow(r)

    def _collect_extras(self) -> list:
        out = []
        for r in range(self.extras.rowCount()):
            combo = self.extras.cellWidget(r, 0)
            key = self.extras.item(r, 1)
            val = self.extras.item(r, 2)
            if combo and key and key.text().strip():
                out.append((combo.currentText(), key.text().strip(),
                            val.text() if val else ""))
        return out

    # --- firing --------------------------------------------------------------------
    def set_serial(self, serial: str | None):
        self._serial = serial

    def shutdown(self):
        if self._worker is not None:
            self._worker.wait(2000)
            self._worker = None

    def _fire_link(self):
        uri = self.link_edit.text().strip()
        if not uri:
            self.status.emit("Enter a deep link first")
            return
        self._fire(build_am_args(self._serial or "", "start",
                                 action="android.intent.action.VIEW", data=uri),
                   f"VIEW {uri}")

    def _fire_full(self):
        verb = self.mode_combo.currentData()
        args = build_am_args(
            self._serial or "", verb,
            action=self.action_edit.text().strip(),
            data=self.data_edit.text().strip(),
            mime=self.mime_edit.text().strip(),
            component=self.component_edit.text().strip(),
            extras=self._collect_extras())
        self._fire(args, f"am {verb}")

    def _fire(self, args: list[str], label: str):
        if not self._adb or not self._serial:
            self.failed.emit("Intents: no device selected")
            return
        if self._worker is not None:
            self.status.emit("An intent is already in flight…")
            return
        self.fire_btn.setEnabled(False)
        self.link_btn.setEnabled(False)
        self.out.appendPlainText(f"$ adb {' '.join(args)}")
        self.status.emit(f"Sending: {label}")
        self._worker = AmWorker(self._adb, args, self)
        self._worker.done.connect(self._on_done)
        self._worker.start()

    def _on_done(self, ok: bool, out: str):
        self._worker = None
        self.fire_btn.setEnabled(True)
        self.link_btn.setEnabled(True)
        self.out.appendPlainText(out + "\n")
        self.out.verticalScrollBar().setValue(self.out.verticalScrollBar().maximum())
        if ok:
            self.status.emit("✓ Intent sent")
        else:
            self.failed.emit("Intent failed — see the am output")
