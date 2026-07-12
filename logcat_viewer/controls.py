"""Device Controls: one-click developer/device toggles that devs otherwise
type by hand — dark mode, font scale, density, animation scales, show-taps /
pointer-location / layout-bounds / GPU-bars, don't-keep-activities, stay-awake,
battery mocking (`dumpsys battery`), Doze force-idle and per-app standby buckets.

All state reads happen in ONE `adb shell` round-trip (`read_state_script`, each
section behind a `@@key@@` marker) on a worker; every setter is a short one-shot
worker running a list of adb argvs (some toggles need a follow-up
SYSPROPS_TRANSACTION poke to apply live). Pure builders/parsers are smoke-tested.
"""
from __future__ import annotations

import re
import subprocess

from PyQt6.QtCore import Qt, QThread, pyqtSignal
from PyQt6.QtWidgets import (
    QCheckBox, QComboBox, QGridLayout, QHBoxLayout, QLabel, QPushButton,
    QScrollArea, QSlider, QVBoxLayout, QWidget,
)

# Poke every process to re-read debug.* sysprops (Binder SYSPROPS_TRANSACTION,
# '_SPR' = 1599295570) — how `setprop debug.layout` applies without a restart.
_SYSPROPS_POKE = ["shell", "service", "call", "activity", "1599295570"]

BUCKETS = ["active", "working_set", "frequent", "rare", "restricted"]

_READS = [
    ("night", "cmd uimode night"),
    ("font_scale", "settings get system font_scale"),
    ("density", "wm density"),
    ("anim", "settings get global animator_duration_scale"),
    ("show_touches", "settings get system show_touches"),
    ("pointer", "settings get system pointer_location"),
    ("layout", "getprop debug.layout"),
    ("hwui", "getprop debug.hwui.profile"),
    ("finish", "settings get global always_finish_activities"),
    ("stay", "settings get global stay_on_while_plugged_in"),
    ("battery", "dumpsys battery"),
    ("doze", "dumpsys deviceidle get deep"),
]


def read_state_script() -> str:
    """One shell script that prints every control's state behind markers."""
    return "; ".join(f"echo @@{k}@@; {cmd} 2>/dev/null" for k, cmd in _READS)


def parse_state(text: str) -> dict:
    """Split marker-delimited output back into {key: section_text}."""
    out: dict[str, str] = {}
    key = None
    for line in text.splitlines():
        m = re.match(r"^@@(\w+)@@\s*$", line.strip())
        if m:
            key = m.group(1)
            out[key] = ""
        elif key:
            out[key] += line + "\n"
    return {k: v.strip() for k, v in out.items()}


def _first_num(s: str, default=None):
    m = re.search(r"-?\d+(?:\.\d+)?", s or "")
    return float(m.group(0)) if m else default


def interpret_state(sections: dict) -> dict:
    """Normalize raw sections into typed control values."""
    batt = sections.get("battery", "")
    level = re.search(r"level:\s*(\d+)", batt)
    powered = bool(re.search(r"(AC|USB|Wireless) powered: true", batt))
    dens = sections.get("density", "")
    over = re.search(r"Override density:\s*(\d+)", dens)
    phys = re.search(r"Physical density:\s*(\d+)", dens)
    return {
        "night": "yes" in sections.get("night", "").lower(),
        "font_scale": _first_num(sections.get("font_scale", ""), 1.0) or 1.0,
        "density": int((over or phys).group(1)) if (over or phys) else None,
        "density_overridden": over is not None,
        "anim_off": (_first_num(sections.get("anim", ""), 1.0) or 0.0) == 0.0,
        "show_touches": sections.get("show_touches", "").strip() == "1",
        "pointer": sections.get("pointer", "").strip() == "1",
        "layout": sections.get("layout", "").strip() == "true",
        "hwui": "visual_bars" in sections.get("hwui", ""),
        "finish": sections.get("finish", "").strip() == "1",
        "stay": (sections.get("stay", "").strip() or "0") not in ("0", "null"),
        "battery_level": int(level.group(1)) if level else None,
        "battery_powered": powered,
        "doze_idle": sections.get("doze", "").strip().upper() == "IDLE",
    }


# --- pure setter builders: each returns a list of adb argvs -----------------------
def set_night(on: bool):
    return [["shell", "cmd", "uimode", "night", "yes" if on else "no"]]


def set_font_scale(scale: float):
    return [["shell", "settings", "put", "system", "font_scale", str(scale)]]


def set_density(dpi: int | None):
    return [["shell", "wm", "density", str(dpi) if dpi else "reset"]]


def set_animations(off: bool):
    v = "0" if off else "1"
    return [["shell", "settings", "put", "global", key, v] for key in
            ("window_animation_scale", "transition_animation_scale",
             "animator_duration_scale")]


def set_show_touches(on: bool):
    return [["shell", "settings", "put", "system", "show_touches", "1" if on else "0"]]


def set_pointer_location(on: bool):
    return [["shell", "settings", "put", "system", "pointer_location", "1" if on else "0"]]


def set_layout_bounds(on: bool):
    return [["shell", "setprop", "debug.layout", "true" if on else "false"],
            _SYSPROPS_POKE]


def set_hwui_profile(on: bool):
    return [["shell", "setprop", "debug.hwui.profile", "visual_bars" if on else "false"],
            _SYSPROPS_POKE]


def set_finish_activities(on: bool):
    return [["shell", "settings", "put", "global", "always_finish_activities",
             "1" if on else "0"]]


def set_stay_awake(on: bool):
    return [["shell", "settings", "put", "global", "stay_on_while_plugged_in",
             "7" if on else "0"]]


def set_battery_level(level: int):
    return [["shell", "dumpsys", "battery", "unplug"],
            ["shell", "dumpsys", "battery", "set", "level", str(level)]]


def reset_battery():
    return [["shell", "dumpsys", "battery", "reset"]]


def set_doze(on: bool):
    if on:
        # force-idle requires the device to look unplugged first.
        return [["shell", "dumpsys", "battery", "unplug"],
                ["shell", "dumpsys", "deviceidle", "force-idle"]]
    return [["shell", "dumpsys", "deviceidle", "unforce"],
            ["shell", "dumpsys", "battery", "reset"]]


def set_standby_bucket(package: str, bucket: str):
    return [["shell", "am", "set-standby-bucket", package, bucket]]


def get_standby_bucket_args(package: str):
    return ["shell", "am", "get-standby-bucket", package]


class StateWorker(QThread):
    """Read every control's current state in one shell round-trip."""
    done = pyqtSignal(bool, str, dict)

    def __init__(self, adb, serial, package=None, parent=None):
        super().__init__(parent)
        self._adb, self._serial, self._package = adb, serial, package

    def run(self):
        try:
            r = subprocess.run([self._adb, "-s", self._serial, "shell",
                                read_state_script()],
                               capture_output=True, text=True, timeout=15)
            state = interpret_state(parse_state(r.stdout))
            if self._package:
                b = subprocess.run(
                    [self._adb, "-s", self._serial,
                     *get_standby_bucket_args(self._package)],
                    capture_output=True, text=True, timeout=10).stdout.strip()
                state["bucket"] = b if b in [x.upper() for x in BUCKETS] + BUCKETS else b
        except (subprocess.SubprocessError, OSError) as exc:
            self.done.emit(False, str(exc), {})
            return
        self.done.emit(True, "", state)


class CmdWorker(QThread):
    """Run a short sequence of adb argvs; report the first failure."""
    done = pyqtSignal(bool, str)

    def __init__(self, adb, serial, argvs, label, parent=None):
        super().__init__(parent)
        self._adb, self._serial, self._argvs, self.label = adb, serial, argvs, label

    def run(self):
        for argv in self._argvs:
            try:
                r = subprocess.run([self._adb, "-s", self._serial, *argv],
                                   capture_output=True, text=True, timeout=15)
            except (subprocess.SubprocessError, OSError) as exc:
                self.done.emit(False, f"{self.label}: {exc}")
                return
            err = (r.stderr or "").strip()
            if r.returncode != 0 and err:
                self.done.emit(False, f"{self.label}: {err.splitlines()[-1]}")
                return
        self.done.emit(True, self.label)


class ControlsView(QWidget):
    """Device Controls tab: grouped toggle grid + battery/doze simulation.
    Standby-bucket row follows the shared App picker."""
    status = pyqtSignal(str)
    failed = pyqtSignal(str)

    _FONT_SCALES = [("Small (0.85)", 0.85), ("Default (1.0)", 1.0),
                    ("Large (1.15)", 1.15), ("Largest (1.3)", 1.3)]

    def __init__(self, adb: str, parent=None):
        super().__init__(parent)
        self._adb = adb or ""
        self._serial: str | None = None
        self._package: str | None = None
        self._state_worker: StateWorker | None = None
        self._cmd_workers: list[CmdWorker] = []
        self._loading = False           # guard: setChecked during refresh
        self._build()

    # --- UI ------------------------------------------------------------------
    def _check(self, label: str, tip: str, setter) -> QCheckBox:
        cb = QCheckBox(label)
        cb.setToolTip(tip)
        cb.toggled.connect(lambda on: self._apply(setter(on), label) if not self._loading else None)
        return cb

    def _card(self, title: str) -> tuple[QWidget, QGridLayout]:
        card = QWidget()
        card.setObjectName("MonCard")
        v = QVBoxLayout(card)
        v.setContentsMargins(16, 12, 16, 14)
        v.setSpacing(8)
        cap = QLabel(title)
        cap.setObjectName("MonCaption")
        v.addWidget(cap)
        grid = QGridLayout()
        grid.setHorizontalSpacing(18)
        grid.setVerticalSpacing(8)
        v.addLayout(grid)
        return card, grid

    def _build(self):
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(0)

        bar = QWidget()
        bar.setObjectName("FilterBar")
        bh = QHBoxLayout(bar)
        bh.setContentsMargins(12, 8, 12, 8)
        self.refresh_btn = QPushButton("⟳  Read device state")
        self.refresh_btn.clicked.connect(self.refresh)
        bh.addWidget(self.refresh_btn)
        self.state_lbl = QLabel("")
        self.state_lbl.setObjectName("MockStatus")
        bh.addWidget(self.state_lbl)
        bh.addStretch(1)
        outer.addWidget(bar)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QScrollArea.Shape.NoFrame)
        body = QWidget()
        root = QVBoxLayout(body)
        root.setContentsMargins(16, 14, 16, 16)
        root.setSpacing(12)

        # --- Display ---------------------------------------------------------
        disp, g = self._card("DISPLAY")
        self.night_cb = self._check("Dark mode", "cmd uimode night", set_night)
        g.addWidget(self.night_cb, 0, 0)
        g.addWidget(QLabel("Font scale"), 0, 1, Qt.AlignmentFlag.AlignRight)
        self.font_combo = QComboBox()
        for label, v in self._FONT_SCALES:
            self.font_combo.addItem(label, v)
        self.font_combo.activated.connect(
            lambda *_: self._apply(set_font_scale(self.font_combo.currentData()),
                                   "Font scale"))
        g.addWidget(self.font_combo, 0, 2)
        g.addWidget(QLabel("Density"), 0, 3, Qt.AlignmentFlag.AlignRight)
        self.density_combo = QComboBox()
        self.density_combo.setEditable(True)
        for d in ("320", "400", "440", "480", "560"):
            self.density_combo.addItem(d)
        g.addWidget(self.density_combo, 0, 4)
        dens_btn = QPushButton("Set")
        dens_btn.setObjectName("toggle")
        dens_btn.clicked.connect(self._set_density)
        g.addWidget(dens_btn, 0, 5)
        dens_reset = QPushButton("Reset")
        dens_reset.setObjectName("toggle")
        dens_reset.clicked.connect(lambda: self._apply(set_density(None), "Density reset"))
        g.addWidget(dens_reset, 0, 6)
        g.setColumnStretch(7, 1)
        root.addWidget(disp)

        # --- Developer -------------------------------------------------------
        dev, g = self._card("DEVELOPER")
        self.layout_cb = self._check(
            "Show layout bounds", "setprop debug.layout (applies live)", set_layout_bounds)
        self.touches_cb = self._check("Show taps", "settings put system show_touches",
                                      set_show_touches)
        self.pointer_cb = self._check("Pointer location", "settings put system pointer_location",
                                      set_pointer_location)
        self.hwui_cb = self._check("GPU profile bars", "debug.hwui.profile visual_bars",
                                   set_hwui_profile)
        self.anim_cb = self._check("Animations OFF", "all three animation scales → 0",
                                   set_animations)
        self.finish_cb = self._check("Don't keep activities",
                                     "always_finish_activities", set_finish_activities)
        self.stay_cb = self._check("Stay awake (charging)",
                                   "stay_on_while_plugged_in", set_stay_awake)
        for i, cb in enumerate((self.layout_cb, self.touches_cb, self.pointer_cb,
                                self.hwui_cb, self.anim_cb, self.finish_cb, self.stay_cb)):
            g.addWidget(cb, i // 4, i % 4)
        g.setColumnStretch(4, 1)
        root.addWidget(dev)

        # --- Power / background ------------------------------------------------
        pwr, g = self._card("POWER & BACKGROUND  (testing)")
        g.addWidget(QLabel("Mock battery"), 0, 0)
        self.batt_slider = QSlider(Qt.Orientation.Horizontal)
        self.batt_slider.setRange(1, 100)
        self.batt_slider.setValue(100)
        self.batt_slider.setFixedWidth(180)
        g.addWidget(self.batt_slider, 0, 1)
        self.batt_lbl = QLabel("100%")
        self.batt_slider.valueChanged.connect(lambda v: self.batt_lbl.setText(f"{v}%"))
        g.addWidget(self.batt_lbl, 0, 2)
        batt_btn = QPushButton("Apply")
        batt_btn.setObjectName("toggle")
        batt_btn.setToolTip("Fake battery level + unplugged (dumpsys battery)")
        batt_btn.clicked.connect(
            lambda: self._apply(set_battery_level(self.batt_slider.value()),
                                f"Battery mocked to {self.batt_slider.value()}%"))
        g.addWidget(batt_btn, 0, 3)
        batt_reset = QPushButton("Reset")
        batt_reset.setObjectName("toggle")
        batt_reset.clicked.connect(lambda: self._apply(reset_battery(), "Battery reset"))
        g.addWidget(batt_reset, 0, 4)

        self.doze_cb = self._check(
            "Force Doze (deep idle)",
            "dumpsys deviceidle force-idle — test JobScheduler/WorkManager behavior",
            set_doze)
        g.addWidget(self.doze_cb, 1, 0, 1, 2)

        g.addWidget(QLabel("Standby bucket"), 2, 0)
        self.bucket_combo = QComboBox()
        self.bucket_combo.addItems(BUCKETS)
        g.addWidget(self.bucket_combo, 2, 1)
        self.bucket_btn = QPushButton("Apply to app")
        self.bucket_btn.setObjectName("toggle")
        self.bucket_btn.setEnabled(False)
        self.bucket_btn.clicked.connect(self._set_bucket)
        g.addWidget(self.bucket_btn, 2, 2, 1, 2)
        self.bucket_lbl = QLabel("Pick an app in the App box to set its bucket")
        self.bucket_lbl.setObjectName("MonSub")
        g.addWidget(self.bucket_lbl, 3, 0, 1, 5)
        g.setColumnStretch(5, 1)
        root.addWidget(pwr)
        root.addStretch(1)

        scroll.setWidget(body)
        outer.addWidget(scroll, 1)

    # --- lifecycle -------------------------------------------------------------
    def set_serial(self, serial: str | None):
        if serial == self._serial:
            return
        self._serial = serial
        self.state_lbl.setText("")
        if serial and self.isVisible():
            self.refresh()

    def set_package(self, package: str | None):
        self._package = package or None
        self.bucket_btn.setEnabled(bool(self._package))
        self.bucket_lbl.setText(
            f"App: {self._package}" if self._package
            else "Pick an app in the App box to set its bucket")

    def showEvent(self, event):
        super().showEvent(event)
        if self._serial:
            self.refresh()

    def shutdown(self):
        for w in self._cmd_workers:
            w.wait(1500)
        if self._state_worker is not None:
            self._state_worker.wait(1500)
            self._state_worker = None

    # --- read state ---------------------------------------------------------------
    def refresh(self):
        if not self._adb or not self._serial or self._state_worker is not None:
            return
        self.refresh_btn.setEnabled(False)
        self._state_worker = StateWorker(self._adb, self._serial, self._package, self)
        self._state_worker.done.connect(self._on_state)
        self._state_worker.start()

    def _on_state(self, ok: bool, message: str, state: dict):
        self._state_worker = None
        self.refresh_btn.setEnabled(True)
        if not ok:
            self.failed.emit(f"Controls: {message}")
            return
        self._loading = True
        try:
            self.night_cb.setChecked(state.get("night", False))
            self.layout_cb.setChecked(state.get("layout", False))
            self.touches_cb.setChecked(state.get("show_touches", False))
            self.pointer_cb.setChecked(state.get("pointer", False))
            self.hwui_cb.setChecked(state.get("hwui", False))
            self.anim_cb.setChecked(state.get("anim_off", False))
            self.finish_cb.setChecked(state.get("finish", False))
            self.stay_cb.setChecked(state.get("stay", False))
            self.doze_cb.setChecked(state.get("doze_idle", False))
            fs = state.get("font_scale", 1.0)
            idx = min(range(len(self._FONT_SCALES)),
                      key=lambda i: abs(self._FONT_SCALES[i][1] - fs))
            self.font_combo.setCurrentIndex(idx)
            if state.get("density"):
                self.density_combo.setCurrentText(str(state["density"]))
            if state.get("battery_level") is not None:
                self.batt_slider.setValue(state["battery_level"])
        finally:
            self._loading = False
        bits = []
        if state.get("battery_level") is not None:
            bits.append(f"battery {state['battery_level']}%"
                        + ("" if state.get("battery_powered") else " (unplugged)"))
        if state.get("doze_idle"):
            bits.append("DOZING")
        if state.get("bucket"):
            bits.append(f"bucket: {state['bucket']}")
        self.state_lbl.setText("   ·   ".join(bits))

    # --- apply -----------------------------------------------------------------
    def _apply(self, argvs: list, label: str):
        if not self._adb or not self._serial:
            self.failed.emit("Controls: no device selected")
            return
        w = CmdWorker(self._adb, self._serial, argvs, label, self)
        self._cmd_workers.append(w)
        w.done.connect(lambda ok, msg, w=w: self._on_cmd_done(ok, msg, w))
        w.start()

    def _on_cmd_done(self, ok: bool, message: str, worker):
        if worker in self._cmd_workers:
            self._cmd_workers.remove(worker)
        if ok:
            self.status.emit(f"✓ {message}")
        else:
            self.failed.emit(f"Controls: {message}")
        self.refresh()

    def _set_density(self):
        text = self.density_combo.currentText().strip()
        if text.isdigit():
            self._apply(set_density(int(text)), f"Density {text} dpi")
        else:
            self.failed.emit("Controls: density must be a number")

    def _set_bucket(self):
        if self._package:
            b = self.bucket_combo.currentText()
            self._apply(set_standby_bucket(self._package, b),
                        f"{self._package} → {b} bucket")
