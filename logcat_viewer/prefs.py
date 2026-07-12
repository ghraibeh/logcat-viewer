"""SharedPreferences viewer/editor for the selected app (debuggable → run-as,
rooted → su fallback), completing the app-state story next to the DB inspector.

Reads `shared_prefs/*.xml`, parses them into typed rows, lets you edit values
(type-checked), and writes the rebuilt XML back with `dd` over stdin — the same
private-write trick as the file explorer. The app keeps its own copy cached in
memory, so a **Force-stop** button is provided to make it re-read on next launch.
Pure XML parse/build/update helpers are Qt-free and smoke-tested.
"""
from __future__ import annotations

import subprocess
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from xml.sax.saxutils import escape, quoteattr

from PyQt6.QtCore import Qt, QThread, pyqtSignal
from PyQt6.QtGui import QFont
from PyQt6.QtWidgets import (
    QHBoxLayout, QHeaderView, QLabel, QListWidget, QMessageBox, QPushButton,
    QSplitter, QTableWidget, QTableWidgetItem, QVBoxLayout, QWidget,
)

PREFS_DIR = "shared_prefs"


@dataclass
class Pref:
    key: str
    type: str      # string | int | long | float | boolean | set
    value: str     # display/edit representation ("a, b" for sets)


# --- pure helpers -------------------------------------------------------------
def _prefix(su: bool, package: str) -> list[str]:
    return ["su", "-c"] if su else ["run-as", package]


def ls_prefs_args(serial: str, package: str, *, su: bool = False) -> list[str]:
    d = f"/data/data/{package}/{PREFS_DIR}" if su else PREFS_DIR
    return ["-s", serial, "shell", *_prefix(su, package), "ls", d]


def cat_pref_args(serial: str, package: str, fname: str, *, su: bool = False) -> list[str]:
    d = f"/data/data/{package}/{PREFS_DIR}/{fname}" if su else f"{PREFS_DIR}/{fname}"
    return ["-s", serial, "exec-out", *_prefix(su, package), "cat", d]


def write_pref_args(serial: str, package: str, fname: str, *, su: bool = False) -> list[str]:
    d = f"/data/data/{package}/{PREFS_DIR}/{fname}" if su else f"{PREFS_DIR}/{fname}"
    return ["-s", serial, "shell", *_prefix(su, package), "dd", f"of={d}"]


def parse_prefs_xml(text: str) -> list[Pref]:
    """SharedPreferences XML -> typed rows. String-sets flatten to a comma view
    (read-only in the editor)."""
    start = text.find("<")
    if start < 0:
        return []
    root = ET.fromstring(text[start:])
    out: list[Pref] = []
    for el in root:
        key = el.attrib.get("name", "")
        if el.tag == "string":
            out.append(Pref(key, "string", el.text or ""))
        elif el.tag in ("int", "long", "float", "boolean"):
            out.append(Pref(key, el.tag, el.attrib.get("value", "")))
        elif el.tag == "set":
            vals = [c.text or "" for c in el if c.tag == "string"]
            out.append(Pref(key, "set", ", ".join(vals)))
    return out


def build_prefs_xml(prefs: list[Pref]) -> str:
    """Rows -> SharedPreferences XML (the exact shape Android writes)."""
    lines = ["<?xml version='1.0' encoding='utf-8' standalone='yes' ?>", "<map>"]
    for p in prefs:
        name = quoteattr(p.key)
        if p.type == "string":
            lines.append(f"    <string name={name}>{escape(p.value)}</string>")
        elif p.type == "set":
            lines.append(f"    <set name={name}>")
            for v in [s.strip() for s in p.value.split(",") if s.strip()]:
                lines.append(f"        <string>{escape(v)}</string>")
            lines.append("    </set>")
        else:
            lines.append(f"    <{p.type} name={name} value={quoteattr(p.value)} />")
    lines.append("</map>")
    return "\n".join(lines) + "\n"


def validate_pref_value(type_: str, value: str) -> str | None:
    """None if `value` fits the type, else a human error."""
    try:
        if type_ == "int":
            v = int(value)
            if not -2**31 <= v < 2**31:
                return "int out of 32-bit range"
        elif type_ == "long":
            int(value)
        elif type_ == "float":
            float(value)
        elif type_ == "boolean" and value not in ("true", "false"):
            return "boolean must be true or false"
    except ValueError:
        return f"not a valid {type_}"
    return None


# --- workers --------------------------------------------------------------------
class PrefListWorker(QThread):
    """List pref files; tries run-as first, escalates to su."""
    done = pyqtSignal(bool, str, list, bool)   # ok, error, files, used_su

    def __init__(self, adb, serial, package, parent=None):
        super().__init__(parent)
        self._adb, self._serial, self._package = adb, serial, package

    def _ls(self, su):
        r = subprocess.run([self._adb, *ls_prefs_args(self._serial, self._package, su=su)],
                           capture_output=True, text=True, timeout=15)
        bad = r.returncode != 0 or "not debuggable" in (r.stdout + r.stderr).lower() \
            or "no such" in (r.stdout + r.stderr).lower() or "denied" in r.stderr.lower()
        files = [l.strip() for l in r.stdout.splitlines() if l.strip().endswith(".xml")]
        return (not bad), files, (r.stderr or r.stdout).strip()

    def run(self):
        try:
            ok, files, err = self._ls(False)
            if ok:
                self.done.emit(True, "", files, False)
                return
            ok, files, err2 = self._ls(True)
            if ok:
                self.done.emit(True, "", files, True)
                return
        except (subprocess.SubprocessError, OSError) as exc:
            self.done.emit(False, str(exc), [], False)
            return
        self.done.emit(False, err or err2 or "cannot access shared_prefs "
                       "(app must be debuggable, or device rooted)", [], False)


class PrefLoadWorker(QThread):
    done = pyqtSignal(bool, str, str, list)   # ok, error, fname, prefs

    def __init__(self, adb, serial, package, fname, su, parent=None):
        super().__init__(parent)
        self._adb, self._serial = adb, serial
        self._package, self._fname, self._su = package, fname, su

    def run(self):
        try:
            r = subprocess.run(
                [self._adb, *cat_pref_args(self._serial, self._package,
                                           self._fname, su=self._su)],
                capture_output=True, timeout=20)
            prefs = parse_prefs_xml(r.stdout.decode("utf-8", errors="replace"))
        except (subprocess.SubprocessError, OSError, ET.ParseError) as exc:
            self.done.emit(False, str(exc), self._fname, [])
            return
        self.done.emit(True, "", self._fname, prefs)


class PrefSaveWorker(QThread):
    done = pyqtSignal(bool, str)

    def __init__(self, adb, serial, package, fname, xml_text, su, parent=None):
        super().__init__(parent)
        self._adb, self._serial = adb, serial
        self._package, self._fname, self._xml, self._su = package, fname, xml_text, su

    def run(self):
        try:
            r = subprocess.run(
                [self._adb, *write_pref_args(self._serial, self._package,
                                             self._fname, su=self._su)],
                input=self._xml.encode("utf-8"), capture_output=True, timeout=30)
        except (subprocess.SubprocessError, OSError) as exc:
            self.done.emit(False, str(exc))
            return
        err = r.stderr.decode("utf-8", errors="replace")
        # dd reports its copy summary on stderr even on success.
        ok = r.returncode == 0 and "denied" not in err.lower() and "error" not in err.lower()
        self.done.emit(ok, "" if ok else err.strip() or "write failed")


# --- view --------------------------------------------------------------------------
class PrefsView(QWidget):
    """Prefs tab: file list on the left, typed key/value editor on the right.
    Follows the shared App picker."""
    status = pyqtSignal(str)
    failed = pyqtSignal(str)

    def __init__(self, adb: str, parent=None):
        super().__init__(parent)
        self._adb = adb or ""
        self._serial: str | None = None
        self._package: str | None = None
        self._su = False
        self._prefs: list[Pref] = []
        self._fname: str | None = None
        self._dirty = False
        self._workers: list[QThread] = []
        self._build()

    def _build(self):
        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)
        bar = QWidget()
        bar.setObjectName("FilterBar")
        h = QHBoxLayout(bar)
        h.setContentsMargins(12, 8, 12, 8)
        h.setSpacing(8)
        self.reload_btn = QPushButton("⟳  Reload")
        self.reload_btn.clicked.connect(self.reload)
        h.addWidget(self.reload_btn)
        self.save_btn = QPushButton("💾  Save to device")
        self.save_btn.setEnabled(False)
        self.save_btn.clicked.connect(self.save)
        h.addWidget(self.save_btn)
        self.stop_btn = QPushButton("Force-stop app")
        self.stop_btn.setToolTip("The app caches prefs in memory — force-stop so the "
                                 "next launch re-reads the edited file")
        self.stop_btn.clicked.connect(self._force_stop)
        h.addWidget(self.stop_btn)
        h.addStretch(1)
        self.info_lbl = QLabel("Pick an app in the App box")
        self.info_lbl.setObjectName("MockStatus")
        h.addWidget(self.info_lbl)
        root.addWidget(bar)

        split = QSplitter(Qt.Orientation.Horizontal)
        self.file_list = QListWidget()
        self.file_list.currentTextChanged.connect(self._on_file_pick)
        split.addWidget(self.file_list)
        self.table = QTableWidget(0, 3)
        self.table.setHorizontalHeaderLabels(["key", "type", "value"])
        self.table.horizontalHeader().setSectionResizeMode(2, QHeaderView.ResizeMode.Stretch)
        self.table.verticalHeader().setVisible(False)
        mono = QFont("SF Mono")
        mono.setStyleHint(QFont.StyleHint.Monospace)
        mono.setPointSize(11)
        self.table.setFont(mono)
        self.table.itemChanged.connect(self._on_edit)
        split.addWidget(self.table)
        split.setStretchFactor(0, 0)
        split.setStretchFactor(1, 1)
        split.setSizes([260, 800])
        root.addWidget(split, 1)

    # --- lifecycle ------------------------------------------------------------
    def set_serial(self, serial: str | None):
        if serial == self._serial:
            return
        self._serial = serial
        self._clear(all_files=True)
        if self.isVisible():
            self.reload()

    def set_package(self, package: str | None):
        package = package or None
        if package == self._package:
            return
        self._package = package
        self._clear(all_files=True)
        self.info_lbl.setText(package or "Pick an app in the App box")
        if self.isVisible():
            self.reload()

    def showEvent(self, event):
        super().showEvent(event)
        if self._package and not self.file_list.count():
            self.reload()

    def shutdown(self):
        for w in self._workers:
            w.wait(1500)

    def _clear(self, all_files=False):
        self._prefs = []
        self._fname = None
        self._dirty = False
        self.save_btn.setEnabled(False)
        self.table.blockSignals(True)
        self.table.setRowCount(0)
        self.table.blockSignals(False)
        if all_files:
            self.file_list.clear()

    # --- listing / loading -------------------------------------------------------
    def reload(self):
        if not (self._adb and self._serial and self._package):
            return
        self.reload_btn.setEnabled(False)
        w = PrefListWorker(self._adb, self._serial, self._package, self)
        self._track(w)
        w.done.connect(self._on_listed)
        w.start()

    def _track(self, w: QThread):
        self._workers.append(w)
        w.finished.connect(lambda w=w: self._workers.remove(w)
                           if w in self._workers else None)

    def _on_listed(self, ok, error, files, used_su):
        self.reload_btn.setEnabled(True)
        self._su = used_su
        self.file_list.clear()
        if not ok:
            self.info_lbl.setText(f"{self._package}: {error}")
            self.failed.emit(f"Prefs: {error}")
            return
        self.file_list.addItems(files)
        mode = "root" if used_su else "run-as"
        self.info_lbl.setText(f"{self._package}   ·   {len(files)} file(s)   ·   {mode}")
        if files:
            self.file_list.setCurrentRow(0)

    def _on_file_pick(self, fname: str):
        if not fname:
            return
        if self._dirty and self._fname:
            self.status.emit("Unsaved changes discarded")
        self._fname = fname
        w = PrefLoadWorker(self._adb, self._serial, self._package, fname, self._su, self)
        self._track(w)
        w.done.connect(self._on_loaded)
        w.start()

    def _on_loaded(self, ok, error, fname, prefs):
        if fname != self._fname:
            return  # stale
        if not ok:
            self.failed.emit(f"Prefs: {error}")
            return
        self._prefs = prefs
        self._dirty = False
        self.save_btn.setEnabled(False)
        t = self.table
        t.blockSignals(True)
        t.setRowCount(len(prefs))
        for r, p in enumerate(prefs):
            for c, (val, editable) in enumerate(
                    ((p.key, False), (p.type, False),
                     (p.value, p.type != "set"))):
                item = QTableWidgetItem(val)
                if not editable:
                    item.setFlags(item.flags() & ~Qt.ItemFlag.ItemIsEditable)
                t.setItem(r, c, item)
        t.blockSignals(False)

    # --- editing / saving ---------------------------------------------------------
    def _on_edit(self, item: QTableWidgetItem):
        if item.column() != 2 or item.row() >= len(self._prefs):
            return
        p = self._prefs[item.row()]
        err = validate_pref_value(p.type, item.text())
        if err:
            self.failed.emit(f"Prefs: {p.key}: {err}")
            self.table.blockSignals(True)
            item.setText(p.value)   # revert
            self.table.blockSignals(False)
            return
        p.value = item.text()
        self._dirty = True
        self.save_btn.setEnabled(True)

    def save(self):
        if not (self._dirty and self._fname and self._package and self._serial):
            return
        self.save_btn.setEnabled(False)
        xml_text = build_prefs_xml(self._prefs)
        w = PrefSaveWorker(self._adb, self._serial, self._package,
                           self._fname, xml_text, self._su, self)
        self._track(w)
        w.done.connect(self._on_saved)
        w.start()

    def _on_saved(self, ok, error):
        if ok:
            self._dirty = False
            self.status.emit(f"✓ {self._fname} written — force-stop the app to apply")
        else:
            self.save_btn.setEnabled(True)
            self.failed.emit(f"Prefs: {error}")
            box = QMessageBox(self)
            box.setModal(False)
            box.setIcon(QMessageBox.Icon.Warning)
            box.setWindowTitle("SharedPreferences")
            box.setText(f"Couldn't write {self._fname}")
            box.setInformativeText(error)
            box.show()

    def _force_stop(self):
        # fire-and-forget one-shot, like taps/keyevents (never block the UI thread)
        if self._adb and self._serial and self._package:
            from PyQt6.QtCore import QProcess
            QProcess.startDetached(self._adb, ["-s", self._serial, "shell",
                                               "am", "force-stop", self._package])
            self.status.emit(f"✓ force-stopped {self._package}")
