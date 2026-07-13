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

from PyQt6.QtCore import (
    QEasingCurve, QPropertyAnimation, Qt, QThread, pyqtProperty, pyqtSignal,
)
from PyQt6.QtGui import QColor, QPainter
from PyQt6.QtWidgets import (
    QAbstractButton, QButtonGroup, QComboBox, QHBoxLayout, QLabel, QPushButton,
    QScrollArea, QSlider, QVBoxLayout, QWidget,
)

from . import theme

# Poke every process to re-read debug.* sysprops (Binder SYSPROPS_TRANSACTION,
# '_SPR' = 1599295570) — how `setprop debug.layout` applies without a restart.
_SYSPROPS_POKE = ["shell", "service", "call", "activity", "1599295570"]

BUCKETS = ["active", "working_set", "frequent", "rare", "restricted"]

# `am get-standby-bucket` prints the raw constant on most builds.
_BUCKET_NUMS = {"5": "exempted", "10": "active", "20": "working_set",
                "30": "frequent", "40": "rare", "45": "restricted", "50": "never"}

# Color-space simulation (the "Simulate color space" dev option): the secure
# daltonizer setting; -1 in our API means simulation off.
DALTONIZER = [("Off", -1), ("Grayscale", 0), ("Protan", 11),
              ("Deutan", 12), ("Tritan", 13)]

# "Simulate secondary displays" dev-option presets (overlay_display_devices).
OVERLAYS = [("Off", ""), ("480p", "720x480/142"),
            ("720p", "1280x720/213"), ("1080p", "1920x1080/320")]

# Rotation: -1 = auto (accelerometer), else a forced user_rotation quadrant.
ROTATIONS = [("Auto", -1), ("0°", 0), ("90°", 1), ("180°", 2), ("270°", 3)]

TIMEOUTS = [("15s", 15000), ("30s", 30000), ("1m", 60000),
            ("10m", 600000), ("30m", 1800000)]

_READS = [
    ("night", "cmd uimode night"),
    ("font_scale", "settings get system font_scale"),
    ("density", "wm density"),
    ("anim", "settings get global animator_duration_scale"),
    ("show_touches", "settings get system show_touches"),
    ("pointer", "settings get system pointer_location"),
    ("layout", "getprop debug.layout"),
    ("hwui", "getprop debug.hwui.profile"),
    ("rtl", "settings get global debug.force_rtl"),
    ("overdraw", "getprop debug.hwui.overdraw"),
    ("dalt", "settings get secure accessibility_display_daltonizer_enabled"
             "; settings get secure accessibility_display_daltonizer"),
    ("wifi", "cmd wifi status"),
    ("data", "settings get global mobile_data"),
    ("airplane", "settings get global airplane_mode_on"),
    ("anr", "settings get secure anr_show_background"),
    ("rot", "settings get system accelerometer_rotation"
            "; settings get system user_rotation"),
    ("bright", "settings get system screen_brightness"
               "; settings get system screen_brightness_mode"),
    ("timeout", "settings get system screen_off_timeout"),
    ("loc", "settings get secure location_mode"),
    ("bt", "settings get global bluetooth_on"),
    ("lowpower", "settings get global low_power"),
    ("datasaver", "cmd netpolicy get restrict-background"),
    ("overlay", "settings get global overlay_display_devices"),
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
    dalt_lines = sections.get("dalt", "").splitlines() + ["", ""]
    dalt_on = dalt_lines[0].strip() == "1"
    dalt_val = _first_num(dalt_lines[1])
    wifi_line = (sections.get("wifi", "").splitlines() or [""])[0].lower()
    rot_lines = sections.get("rot", "").splitlines() + ["", ""]
    bright_lines = sections.get("bright", "").splitlines() + ["", ""]
    overlay = sections.get("overlay", "").strip()
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
        "rtl": sections.get("rtl", "").strip() == "1",
        "overdraw": "show" in sections.get("overdraw", ""),
        "dalt": int(dalt_val) if dalt_on and dalt_val is not None else -1,
        "wifi": "is enabled" in wifi_line,
        "data": sections.get("data", "").strip() == "1",
        "airplane": sections.get("airplane", "").strip() == "1",
        "anr": sections.get("anr", "").strip() == "1",
        "rotation": -1 if rot_lines[0].strip() == "1"
                    else int(_first_num(rot_lines[1], 0) or 0),
        "brightness": int(_first_num(bright_lines[0], 128) or 128),
        "bright_auto": bright_lines[1].strip() == "1",
        "timeout_ms": int(_first_num(sections.get("timeout", ""), 0) or 0),
        "location": (sections.get("loc", "").strip() or "0") not in ("0", "null"),
        "bluetooth": sections.get("bt", "").strip() == "1",
        "battery_saver": sections.get("lowpower", "").strip() == "1",
        "data_saver": "enabled" in sections.get("datasaver", "").lower(),
        "overlay": "" if overlay in ("", "null") else overlay,
        "finish": sections.get("finish", "").strip() == "1",
        "stay": (sections.get("stay", "").strip() or "0") not in ("0", "null"),
        "battery_level": int(level.group(1)) if level else None,
        "battery_powered": powered,
        "doze_idle": sections.get("doze", "").strip().upper() == "IDLE",
    }


def bucket_name(raw: str | None) -> str | None:
    """Canonical bucket name from `am get-standby-bucket` output (name or number)."""
    s = (raw or "").strip().lower()
    if not s:
        return None
    if s in BUCKETS or s in ("exempted", "never"):
        return s
    return _BUCKET_NUMS.get(s.split()[0])


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


def set_force_rtl(on: bool):
    return [["shell", "settings", "put", "global", "debug.force_rtl",
             "1" if on else "0"], _SYSPROPS_POKE]


def set_overdraw(on: bool):
    return [["shell", "setprop", "debug.hwui.overdraw", "show" if on else "false"],
            _SYSPROPS_POKE]


def set_color_space(mode: int):
    """Daltonizer simulation; -1 = off, else a DALTONIZER value."""
    if mode < 0:
        return [["shell", "settings", "put", "secure",
                 "accessibility_display_daltonizer_enabled", "0"]]
    return [["shell", "settings", "put", "secure",
             "accessibility_display_daltonizer", str(mode)],
            ["shell", "settings", "put", "secure",
             "accessibility_display_daltonizer_enabled", "1"]]


def set_wifi(on: bool):
    return [["shell", "cmd", "wifi", "set-wifi-enabled",
             "enabled" if on else "disabled"]]


def set_mobile_data(on: bool):
    return [["shell", "svc", "data", "enable" if on else "disable"]]


def set_airplane(on: bool):
    return [["shell", "cmd", "connectivity", "airplane-mode",
             "enable" if on else "disable"]]


def set_show_anrs(on: bool):
    return [["shell", "settings", "put", "secure", "anr_show_background",
             "1" if on else "0"]]


def set_rotation(mode: int):
    """-1 = back to auto-rotate, else lock to a user_rotation quadrant."""
    if mode < 0:
        return [["shell", "settings", "put", "system", "accelerometer_rotation", "1"]]
    return [["shell", "settings", "put", "system", "accelerometer_rotation", "0"],
            ["shell", "settings", "put", "system", "user_rotation", str(mode)]]


def set_brightness(value: int):
    return [["shell", "settings", "put", "system", "screen_brightness", str(value)]]


def set_auto_brightness(on: bool):
    return [["shell", "settings", "put", "system", "screen_brightness_mode",
             "1" if on else "0"]]


def set_screen_timeout(ms: int):
    return [["shell", "settings", "put", "system", "screen_off_timeout", str(ms)]]


def set_location(on: bool):
    return [["shell", "cmd", "location", "set-location-enabled",
             "true" if on else "false"]]


def set_bluetooth(on: bool):
    return [["shell", "cmd", "bluetooth_manager", "enable" if on else "disable"]]


def set_battery_saver(on: bool):
    return [["shell", "settings", "put", "global", "low_power", "1" if on else "0"]]


def set_data_saver(on: bool):
    return [["shell", "cmd", "netpolicy", "set", "restrict-background",
             "true" if on else "false"]]


def set_overlay_display(spec: str):
    """OVERLAYS preset value; "" removes the simulated display.

    Off deletes the row: adb's shell-arg join drops an empty trailing "" and
    `settings put` then fails with "Bad arguments"."""
    if not spec:
        return [["shell", "settings", "delete", "global", "overlay_display_devices"]]
    return [["shell", "settings", "put", "global", "overlay_display_devices", spec]]


def set_app_locale(package: str, locale: str):
    """Per-app locale (Android 13+); "" resets to the system locale."""
    return [["shell", "cmd", "locale", "set-app-locales", package,
             "--user", "0", "--locales", locale]]


def get_app_locales_args(package: str):
    return ["shell", "cmd", "locale", "get-app-locales", package, "--user", "0"]


def parse_app_locales(text: str) -> str:
    """'Locales for com.x for user 0 are [fr-FR]' → 'fr-FR' ('' if unset)."""
    m = re.search(r"\[([^\]]*)\]", text or "")
    return m.group(1).strip() if m else ""


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
                loc = subprocess.run(
                    [self._adb, "-s", self._serial,
                     *get_app_locales_args(self._package)],
                    capture_output=True, text=True, timeout=10).stdout
                state["app_locales"] = parse_app_locales(loc)
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


class Switch(QAbstractButton):
    """Painter-drawn animated toggle switch (settings-page style).

    Drop-in for QCheckBox's checked API: setChecked()/isChecked(). Only user
    clicks emit `clicked`, so programmatic state loads never fire setters.
    """
    _W, _H, _PAD = 40, 22, 3

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setCheckable(True)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setFixedSize(self._W, self._H)
        self._pos = 0.0
        self._anim = QPropertyAnimation(self, b"pos", self)
        self._anim.setDuration(130)
        self._anim.setEasingCurve(QEasingCurve.Type.OutCubic)
        self.toggled.connect(self._animate)

    def _get_pos(self) -> float:
        return self._pos

    def _set_pos(self, v: float):
        self._pos = v
        self.update()

    pos = pyqtProperty(float, _get_pos, _set_pos)

    def _animate(self, on: bool):
        self._anim.stop()
        self._anim.setEndValue(1.0 if on else 0.0)
        self._anim.start()

    def setChecked(self, on: bool):  # jump, don't animate, on programmatic loads
        super().setChecked(on)
        if not self.isVisible():
            self._anim.stop()
            self._set_pos(1.0 if on else 0.0)

    @staticmethod
    def _blend(a: QColor, b: QColor, t: float) -> QColor:
        return QColor(round(a.red() + (b.red() - a.red()) * t),
                      round(a.green() + (b.green() - a.green()) * t),
                      round(a.blue() + (b.blue() - a.blue()) * t))

    def paintEvent(self, _event):
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        t = max(0.0, min(1.0, self._pos))
        track = self._blend(QColor(theme.SURFACE_3), QColor(theme.ACCENT), t)
        thumb = QColor("#ffffff")
        if not self.isEnabled():
            track = QColor(theme.SURFACE_2)
            thumb = QColor(theme.TEXT_DIM)
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(track)
        r = self.rect().adjusted(0, 0, -1, -1)
        p.drawRoundedRect(r, self._H / 2 - 0.5, self._H / 2 - 0.5)
        d = self._H - 2 * self._PAD - 1
        x = self._PAD + t * (self._W - 2 * self._PAD - d - 1)
        p.setBrush(thumb)
        p.drawEllipse(int(x), self._PAD, d, d)
        p.end()


class ControlsView(QWidget):
    """Device Controls tab: settings-style cards of switches + battery/doze
    simulation. Standby-bucket row follows the shared App picker."""
    status = pyqtSignal(str)
    failed = pyqtSignal(str)
    view_secondary = pyqtSignal()   # "open the mirror on the secondary display"

    _FONT_SCALES = [("0.85×", 0.85), ("1×", 1.0), ("1.15×", 1.15), ("1.3×", 1.3)]
    _BUCKET_SEGS = [("Active", "active"), ("Working", "working_set"),
                    ("Frequent", "frequent"), ("Rare", "rare"),
                    ("Restricted", "restricted")]

    def __init__(self, adb: str, parent=None):
        super().__init__(parent)
        self._adb = adb or ""
        self._serial: str | None = None
        self._package: str | None = None
        self._state_worker: StateWorker | None = None
        self._cmd_workers: list[CmdWorker] = []
        self._overlay_on = False        # a secondary display exists (last read)
        self._build()

    # --- UI ------------------------------------------------------------------
    def _switch(self, tip: str, setter) -> Switch:
        sw = Switch()
        sw.setToolTip(tip)
        sw.clicked.connect(lambda on: self._apply(setter(on), sw.property("label")))
        return sw

    def _card(self, title: str) -> tuple[QWidget, QVBoxLayout]:
        card = QWidget()
        card.setObjectName("MonCard")
        v = QVBoxLayout(card)
        v.setContentsMargins(16, 13, 16, 13)
        v.setSpacing(0)
        cap = QLabel(title)
        cap.setObjectName("MonCaption")
        v.addWidget(cap)
        v.addSpacing(4)
        return card, v

    def _row(self, box: QVBoxLayout, title: str, desc: str, *ctrls: QWidget,
             sep: bool = True):
        """A settings row: name + dim description left, the control(s) right."""
        if sep and box.count() > 2:      # caption + spacing already there
            line = QWidget()
            line.setObjectName("CtrlSep")
            line.setFixedHeight(1)
            box.addWidget(line)
        row = QWidget()
        h = QHBoxLayout(row)
        h.setContentsMargins(0, 9, 0, 9)
        h.setSpacing(10)
        text = QVBoxLayout()
        text.setSpacing(1)
        t = QLabel(title)
        t.setObjectName("CtrlTitle")
        text.addWidget(t)
        if desc:
            d = QLabel(desc)
            d.setObjectName("CtrlDesc")
            text.addWidget(d)
        h.addLayout(text, 1)
        for c in ctrls:
            if isinstance(c, Switch):
                c.setProperty("label", title)
            h.addWidget(c, 0, Qt.AlignmentFlag.AlignVCenter)
        box.addWidget(row)

    def _segments(self, items) -> tuple[QWidget, QButtonGroup]:
        """A pill of exclusive segment buttons; only user clicks emit."""
        wrap = QWidget()
        wrap.setObjectName("SegWrap")
        h = QHBoxLayout(wrap)
        h.setContentsMargins(2, 2, 2, 2)
        h.setSpacing(1)
        grp = QButtonGroup(wrap)
        grp.setExclusive(True)
        for label, data in items:
            b = QPushButton(label)
            b.setObjectName("seg")
            b.setCheckable(True)
            b.setProperty("data", data)
            grp.addButton(b)
            h.addWidget(b)
        return wrap, grp

    @staticmethod
    def _select_segment(grp: QButtonGroup, data):
        """Check the segment carrying `data` (or clear the pill entirely)."""
        grp.setExclusive(False)
        for b in grp.buttons():
            b.setChecked(b.property("data") == data)
        grp.setExclusive(True)

    def _build(self):
        outer = QVBoxLayout(self)
        outer.setContentsMargins(16, 14, 16, 0)
        outer.setSpacing(10)

        # --- heading: title · live state chips · refresh ----------------------
        head = QHBoxLayout()
        title = QLabel("Device Controls")
        title.setObjectName("MonHeading")
        head.addWidget(title)
        head.addStretch(1)
        self.chips = QHBoxLayout()
        self.chips.setSpacing(6)
        head.addLayout(self.chips)
        head.addSpacing(8)
        self.refresh_btn = QPushButton("⟳  Refresh")
        self.refresh_btn.setToolTip("Re-read every toggle's state from the device")
        self.refresh_btn.clicked.connect(self.refresh)
        head.addWidget(self.refresh_btn)
        outer.addLayout(head)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QScrollArea.Shape.NoFrame)
        body = QWidget()
        cols = QHBoxLayout(body)
        cols.setContentsMargins(0, 2, 0, 16)
        cols.setSpacing(12)
        left = QVBoxLayout()
        left.setSpacing(12)
        right = QVBoxLayout()
        right.setSpacing(12)
        cols.addLayout(left, 1)
        cols.addLayout(right, 1)

        # --- Display ---------------------------------------------------------
        disp, v = self._card("DISPLAY")
        self.night_cb = self._switch("cmd uimode night", set_night)
        self._row(v, "Dark mode", "Force the system night mode", self.night_cb)

        font_wrap, self.font_group = self._segments(self._FONT_SCALES)
        self.font_group.buttonClicked.connect(
            lambda b: self._apply(set_font_scale(b.property("data")),
                                  f"Font scale {b.text()}"))
        self._row(v, "Font scale", "System-wide text size", font_wrap)

        self.density_combo = QComboBox()
        self.density_combo.setEditable(True)
        for d in ("320", "400", "440", "480", "560"):
            self.density_combo.addItem(d)
        self.density_combo.setFixedWidth(88)
        dens_btn = QPushButton("Set")
        dens_btn.setObjectName("toggle")
        dens_btn.clicked.connect(self._set_density)
        dens_reset = QPushButton("Reset")
        dens_reset.setObjectName("toggle")
        dens_reset.clicked.connect(lambda: self._apply(set_density(None), "Density reset"))
        self._row(v, "Density", "Override the display density (dpi)",
                  self.density_combo, dens_btn, dens_reset)

        self.bright_slider = QSlider(Qt.Orientation.Horizontal)
        self.bright_slider.setRange(1, 255)
        self.bright_slider.setValue(128)
        self.bright_slider.setMinimumWidth(120)
        self.bright_lbl = QLabel("128")
        self.bright_lbl.setObjectName("CtrlChip")
        self.bright_slider.valueChanged.connect(
            lambda n: self.bright_lbl.setText(str(n)))
        self.bright_slider.sliderReleased.connect(
            lambda: self._apply(set_brightness(self.bright_slider.value()),
                                f"Brightness {self.bright_slider.value()}"))
        self._row(v, "Brightness", "Drag and release to apply (0–255)",
                  self.bright_slider, self.bright_lbl)

        self.bright_auto_cb = self._switch("settings put system screen_brightness_mode",
                                           set_auto_brightness)
        self._row(v, "Auto brightness", "Adaptive brightness on/off",
                  self.bright_auto_cb)

        timeout_wrap, self.timeout_group = self._segments(TIMEOUTS)
        self.timeout_group.buttonClicked.connect(
            lambda b: self._apply(set_screen_timeout(b.property("data")),
                                  f"Screen timeout {b.text()}"))
        self._row(v, "Screen timeout", "Idle time before the screen sleeps",
                  timeout_wrap)

        rot_wrap, self.rot_group = self._segments(ROTATIONS)
        self.rot_group.buttonClicked.connect(
            lambda b: self._apply(set_rotation(b.property("data")),
                                  f"Rotation {b.text()}"))
        self._row(v, "Rotation", "Auto-rotate or lock an orientation", rot_wrap)
        left.addWidget(disp)

        # --- Connectivity ------------------------------------------------------
        net, v = self._card("CONNECTIVITY")
        self.wifi_cb = self._switch(
            "cmd wifi set-wifi-enabled — careful: kills a wireless-adb link", set_wifi)
        self._row(v, "Wi-Fi", "Toggle the Wi-Fi radio", self.wifi_cb)
        self.data_cb = self._switch("svc data enable/disable", set_mobile_data)
        self._row(v, "Mobile data", "Toggle cellular data", self.data_cb)
        self.airplane_cb = self._switch(
            "cmd connectivity airplane-mode — careful: kills a wireless-adb link",
            set_airplane)
        self._row(v, "Airplane mode", "All radios off — test offline behavior",
                  self.airplane_cb)
        self.bt_cb = self._switch("cmd bluetooth_manager enable/disable", set_bluetooth)
        self._row(v, "Bluetooth", "Toggle the Bluetooth radio", self.bt_cb)
        self.loc_cb = self._switch("cmd location set-location-enabled", set_location)
        self._row(v, "Location", "Toggle location services", self.loc_cb)
        self.datasaver_cb = self._switch("cmd netpolicy set restrict-background",
                                         set_data_saver)
        self._row(v, "Data saver", "Restrict background data — test app behavior",
                  self.datasaver_cb)
        left.addWidget(net)

        # --- Power / background -----------------------------------------------
        pwr, v = self._card("POWER & BACKGROUND")
        self.batt_slider = QSlider(Qt.Orientation.Horizontal)
        self.batt_slider.setRange(1, 100)
        self.batt_slider.setValue(100)
        self.batt_slider.setMinimumWidth(120)
        self.batt_lbl = QLabel("100%")
        self.batt_lbl.setObjectName("CtrlChip")
        self.batt_slider.valueChanged.connect(lambda n: self.batt_lbl.setText(f"{n}%"))
        batt_btn = QPushButton("Apply")
        batt_btn.setObjectName("toggle")
        batt_btn.setToolTip("Fake battery level + unplugged (dumpsys battery)")
        batt_btn.clicked.connect(
            lambda: self._apply(set_battery_level(self.batt_slider.value()),
                                f"Battery mocked to {self.batt_slider.value()}%"))
        batt_reset = QPushButton("Reset")
        batt_reset.setObjectName("toggle")
        batt_reset.setToolTip("Back to the real battery state")
        batt_reset.clicked.connect(lambda: self._apply(reset_battery(), "Battery reset"))
        self._row(v, "Mock battery", "Fake a level — the device acts unplugged",
                  self.batt_slider, self.batt_lbl, batt_btn, batt_reset)

        self.saver_cb = self._switch("settings put global low_power",
                                     set_battery_saver)
        self._row(v, "Battery saver", "Low-power mode (takes effect unplugged)",
                  self.saver_cb)

        self.doze_cb = self._switch(
            "dumpsys deviceidle force-idle — test JobScheduler/WorkManager behavior",
            set_doze)
        self._row(v, "Force Doze", "Deep idle now (unplugs the battery first)",
                  self.doze_cb)

        bucket_wrap, self.bucket_group = self._segments(self._BUCKET_SEGS)
        self.bucket_group.buttonClicked.connect(self._on_bucket_clicked)
        self._row(v, "Standby bucket", "Background budget for the picked app",
                  bucket_wrap)
        self.bucket_lbl = QLabel("Pick an app in the App box to set its bucket")
        self.bucket_lbl.setObjectName("CtrlDesc")
        v.addWidget(self.bucket_lbl)
        self._enable_bucket(False)
        left.addWidget(pwr)
        left.addStretch(1)

        # --- Debug overlays ----------------------------------------------------
        ovl, v = self._card("DEBUG OVERLAYS")
        self.layout_cb = self._switch("setprop debug.layout (applies live)",
                                      set_layout_bounds)
        self._row(v, "Layout bounds", "Outline every view's clip bounds", self.layout_cb)
        self.touches_cb = self._switch("settings put system show_touches",
                                       set_show_touches)
        self._row(v, "Show taps", "Visual feedback where touches land", self.touches_cb)
        self.pointer_cb = self._switch("settings put system pointer_location",
                                       set_pointer_location)
        self._row(v, "Pointer location", "Crosshair trace + coordinate bar",
                  self.pointer_cb)
        self.hwui_cb = self._switch("debug.hwui.profile visual_bars", set_hwui_profile)
        self._row(v, "GPU profile bars", "On-screen frame-time bars per window",
                  self.hwui_cb)
        self.overdraw_cb = self._switch("debug.hwui.overdraw show (applies live)",
                                        set_overdraw)
        self._row(v, "GPU overdraw", "Tint areas drawn more than once",
                  self.overdraw_cb)
        right.addWidget(ovl)

        # --- Simulation ---------------------------------------------------------
        sim, v = self._card("SIMULATION")
        self.rtl_cb = self._switch("settings put global debug.force_rtl", set_force_rtl)
        self._row(v, "Force RTL", "Mirror every layout right-to-left", self.rtl_cb)

        dalt_wrap, self.dalt_group = self._segments(DALTONIZER)
        self.dalt_group.buttonClicked.connect(
            lambda b: self._apply(set_color_space(b.property("data")),
                                  f"Color space {b.text()}"))
        self._row(v, "Color space", "Simulate color blindness (daltonizer)", dalt_wrap)

        overlay_wrap, self.overlay_group = self._segments(OVERLAYS)
        self.overlay_group.buttonClicked.connect(self._on_overlay_clicked)
        self.overlay_view_btn = QPushButton("👁 View")
        self.overlay_view_btn.setObjectName("toggle")
        self.overlay_view_btn.setToolTip(
            "Mirror the secondary display (creates a 720p one first if it's off)")
        self.overlay_view_btn.clicked.connect(self._view_secondary)
        self._row(v, "Secondary display", "Simulate an extra display (overlay window)",
                  overlay_wrap, self.overlay_view_btn)

        self.locale_combo = QComboBox()
        self.locale_combo.setEditable(True)
        for loc in ("en", "ar", "fr", "de", "es", "ja", "ko",
                    "zh-CN", "pt-BR", "ru", "hi", "tr"):
            self.locale_combo.addItem(loc)
        self.locale_combo.setFixedWidth(88)
        self.locale_btn = QPushButton("Set")
        self.locale_btn.setObjectName("toggle")
        self.locale_btn.setEnabled(False)
        self.locale_btn.clicked.connect(lambda: self._set_app_locale())
        self.locale_reset = QPushButton("Reset")
        self.locale_reset.setObjectName("toggle")
        self.locale_reset.setEnabled(False)
        self.locale_reset.clicked.connect(
            lambda: self._set_app_locale(reset=True))
        self._row(v, "App locale", "Per-app language (Android 13+)",
                  self.locale_combo, self.locale_btn, self.locale_reset)
        self.locale_lbl = QLabel("Pick an app in the App box to set its locale")
        self.locale_lbl.setObjectName("CtrlDesc")
        v.addWidget(self.locale_lbl)
        right.addWidget(sim)

        # --- Behavior -----------------------------------------------------------
        beh, v = self._card("BEHAVIOR")
        self.anim_cb = self._switch("all three animation scales → 0", set_animations)
        self._row(v, "Animations off", "Window, transition + animator scales to 0",
                  self.anim_cb)
        self.finish_cb = self._switch("always_finish_activities", set_finish_activities)
        self._row(v, "Don't keep activities", "Destroy every activity once left",
                  self.finish_cb)
        self.stay_cb = self._switch("stay_on_while_plugged_in", set_stay_awake)
        self._row(v, "Stay awake", "Screen never sleeps while charging", self.stay_cb)
        self.anr_cb = self._switch("settings put secure anr_show_background",
                                   set_show_anrs)
        self._row(v, "Background ANRs", "Show ANR dialogs for background apps",
                  self.anr_cb)
        right.addWidget(beh)
        right.addStretch(1)

        scroll.setWidget(body)
        outer.addWidget(scroll, 1)

    def _enable_bucket(self, on: bool):
        for b in self.bucket_group.buttons():
            b.setEnabled(on)

    def _set_chips(self, items: list[tuple[str, str]]):
        """Replace the heading chips: [(text, tone)] — tone styles via QSS."""
        while self.chips.count():
            w = self.chips.takeAt(0).widget()
            if w is not None:
                w.deleteLater()
        for text, tone in items:
            chip = QLabel(text)
            chip.setObjectName("CtrlChip")
            chip.setProperty("tone", tone)
            self.chips.addWidget(chip)

    # --- lifecycle -------------------------------------------------------------
    def set_serial(self, serial: str | None):
        if serial == self._serial:
            return
        self._serial = serial
        self._set_chips([])
        if serial and self.isVisible():
            self.refresh()

    def set_package(self, package: str | None):
        self._package = package or None
        self._enable_bucket(bool(self._package))
        self.locale_btn.setEnabled(bool(self._package))
        self.locale_reset.setEnabled(bool(self._package))
        if not self._package:
            self._select_segment(self.bucket_group, None)
        self.bucket_lbl.setText(
            f"App: {self._package}" if self._package
            else "Pick an app in the App box to set its bucket")
        self.locale_lbl.setText(
            f"App: {self._package}" if self._package
            else "Pick an app in the App box to set its locale")

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
        self.night_cb.setChecked(state.get("night", False))
        self.layout_cb.setChecked(state.get("layout", False))
        self.touches_cb.setChecked(state.get("show_touches", False))
        self.pointer_cb.setChecked(state.get("pointer", False))
        self.hwui_cb.setChecked(state.get("hwui", False))
        self.anim_cb.setChecked(state.get("anim_off", False))
        self.finish_cb.setChecked(state.get("finish", False))
        self.stay_cb.setChecked(state.get("stay", False))
        self.doze_cb.setChecked(state.get("doze_idle", False))
        self.rtl_cb.setChecked(state.get("rtl", False))
        self.overdraw_cb.setChecked(state.get("overdraw", False))
        self.wifi_cb.setChecked(state.get("wifi", False))
        self.data_cb.setChecked(state.get("data", False))
        self.airplane_cb.setChecked(state.get("airplane", False))
        self.anr_cb.setChecked(state.get("anr", False))
        self.bt_cb.setChecked(state.get("bluetooth", False))
        self.loc_cb.setChecked(state.get("location", False))
        self.datasaver_cb.setChecked(state.get("data_saver", False))
        self.saver_cb.setChecked(state.get("battery_saver", False))
        self.bright_auto_cb.setChecked(state.get("bright_auto", False))
        self.bright_slider.setValue(state.get("brightness", 128))
        self._select_segment(self.dalt_group, state.get("dalt", -1))
        self._select_segment(self.timeout_group, state.get("timeout_ms", 0))
        self._select_segment(self.rot_group, state.get("rotation", -1))
        self._select_segment(self.overlay_group, state.get("overlay", ""))
        self._overlay_on = bool(state.get("overlay", ""))
        if self._package and "app_locales" in state:
            self.locale_combo.setEditText(state["app_locales"])
        fs = state.get("font_scale", 1.0)
        nearest = min(self._FONT_SCALES, key=lambda it: abs(it[1] - fs))[1]
        self._select_segment(self.font_group, nearest)
        if state.get("density"):
            self.density_combo.setCurrentText(str(state["density"]))
        if state.get("battery_level") is not None:
            self.batt_slider.setValue(state["battery_level"])
        bucket = bucket_name(state.get("bucket"))
        if self._package:
            self._select_segment(self.bucket_group, bucket)

        chips: list[tuple[str, str]] = []
        if state.get("battery_level") is not None:
            if state.get("battery_powered"):
                chips.append((f"🔋 {state['battery_level']}%", ""))
            else:
                chips.append((f"🔋 {state['battery_level']}% · unplugged", "warn"))
        if state.get("doze_idle"):
            chips.append(("😴 dozing", "warn"))
        if state.get("airplane"):
            chips.append(("✈ airplane", "warn"))
        if state.get("battery_saver"):
            chips.append(("⚡ saver", "warn"))
        if self._package and state.get("bucket"):
            chips.append((f"bucket · {bucket or state['bucket']}", "accent"))
        self._set_chips(chips)

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

    def _on_bucket_clicked(self, btn):
        if self._package:
            b = btn.property("data")
            self._apply(set_standby_bucket(self._package, b),
                        f"{self._package} → {b} bucket")

    def _set_app_locale(self, reset: bool = False):
        if not self._package:
            return
        loc = "" if reset else self.locale_combo.currentText().strip()
        self._apply(set_app_locale(self._package, loc),
                    f"{self._package} locale → {loc or 'system default'}")

    def _on_overlay_clicked(self, btn):
        self._overlay_on = bool(btn.property("data"))
        self._apply(set_overlay_display(btn.property("data")),
                    f"Secondary display {btn.text()}")

    def _view_secondary(self):
        """One click: make sure a secondary display exists, then hand off to
        the mirror (ui.py opens it on that display)."""
        if not self._overlay_on:
            default = OVERLAYS[2][1]    # 720p
            self._overlay_on = True
            self._select_segment(self.overlay_group, default)
            self._apply(set_overlay_display(default), "Secondary display 720p")
        self.view_secondary.emit()
