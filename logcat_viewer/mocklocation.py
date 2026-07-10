"""Mock GPS location: a MapLibre picker + the on-device helper that applies it.

Modern Android (6+) won't accept a mock fix from adb directly — only from an app
that is selected as the system "mock location app". So this ships a tiny helper
APK (see ``android-helper/``, bundled at ``assets/mocklocation.apk``) that runs a
foreground service and pushes the coordinate to the OS via LocationManager test
providers. This module:

* auto-installs the helper and grants it the mock-location app-op (``MockSetupWorker``),
* drives it over adb — ``set``/``stop`` (pure command builders below, so they're
  unit-testable), and
* renders the picker (``MockLocationView``): a MapLibre map + coordinate controls.

The coordinate only ever travels Mac -> device over the local adb link; nothing is
received from the network, which is the whole point of the helper-app design.
"""
from __future__ import annotations

import os
import subprocess
from pathlib import Path

from PyQt6.QtCore import QLocale, Qt, QProcess, QThread, QTimer, QUrl, pyqtSignal
from PyQt6.QtGui import QDoubleValidator
from PyQt6.QtWidgets import (
    QComboBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from . import apps as applib
from .resources import asset_path

HELPER_PKG = "com.logcatviewer.mocklocation"
SERVICE = f"{HELPER_PKG}/.MockService"
MOCK_APPOP = "android:mock_location"

MAP_HTML = asset_path("map.html")
HELPER_APK = asset_path("mocklocation.apk")


# --- pure command builders (no device needed → covered by smoke tests) -------
def set_args(serial: str, lat: float, lng: float,
             acc: float | None = None, alt: float | None = None) -> list[str]:
    """adb args (after the binary) to start/update the mock at ``lat,lng``.

    lat/lng are passed as **string** extras (``--es``) so full precision
    survives — ``--ef`` is a 32-bit float and would round off ~2 decimals."""
    args = ["-s", serial, "shell", "am", "start-foreground-service",
            "-n", SERVICE, "--es", "cmd", "set",
            "--es", "lat", f"{lat:.7f}", "--es", "lng", f"{lng:.7f}"]
    if acc is not None:
        args += ["--es", "acc", f"{acc:g}"]
    if alt is not None:
        args += ["--es", "alt", f"{alt:g}"]
    return args


def stop_args(serial: str) -> list[str]:
    """adb args (after the binary) to stop mocking and tear down the providers."""
    return ["-s", serial, "shell", "am", "start-foreground-service",
            "-n", SERVICE, "--es", "cmd", "stop"]


def _coord_validator(lo: float, hi: float) -> QDoubleValidator:
    """A dot-decimal validator regardless of system locale (we always parse with
    Python's ``float``, which expects '.')."""
    v = QDoubleValidator(lo, hi, 7)
    v.setLocale(QLocale(QLocale.Language.C))
    return v


# --- setup worker: install helper (if missing) + grant the mock app-op -------
class MockSetupWorker(QThread):
    """Ensure the helper is installed and allowed to mock. Runs off the UI thread
    (an install can take several seconds)."""

    done = pyqtSignal(bool, str)   # ok, human message

    def __init__(self, adb: str, serial: str, apk_path: str, parent=None):
        super().__init__(parent)
        self._adb = adb
        self._serial = serial
        self._apk = str(apk_path)

    def run(self):
        try:
            already = self._is_installed()
            if not already:
                ok, msg = self._install()
                if not ok:
                    self.done.emit(False, msg)
                    return
            self._appops_allow()
            if not self._appop_is_allow():
                self.done.emit(
                    False,
                    "Couldn't grant the mock-location permission (appops). "
                    "Enable USB debugging (Secure settings) may be required.")
                return
        except (subprocess.SubprocessError, OSError) as exc:
            self.done.emit(False, f"Setup failed: {exc}")
            return
        self.done.emit(True, "Helper ready" if already else "Helper installed")

    def _is_installed(self) -> bool:
        r = applib._run(self._adb, self._serial,
                        ["shell", "pm", "list", "packages", HELPER_PKG], timeout=8)
        return HELPER_PKG in r.stdout

    def _install(self) -> tuple[bool, str]:
        if not os.path.isfile(self._apk):
            return False, f"Bundled helper APK is missing:\n{self._apk}"
        r = subprocess.run([self._adb, "-s", self._serial, "install", "-r", "-g", self._apk],
                           capture_output=True, text=True, timeout=180)
        if r.returncode == 0 and "Success" in r.stdout:
            return True, "installed"
        # Some devices reject grant-at-install (-g); retry plain, then grant perms.
        r2 = subprocess.run([self._adb, "-s", self._serial, "install", "-r", self._apk],
                            capture_output=True, text=True, timeout=180)
        if r2.returncode == 0 and "Success" in r2.stdout:
            for perm in ("android.permission.ACCESS_FINE_LOCATION",
                         "android.permission.ACCESS_COARSE_LOCATION"):
                applib._run(self._adb, self._serial,
                            ["shell", "pm", "grant", HELPER_PKG, perm], timeout=8)
            return True, "installed"
        blob = (r.stderr or r.stdout or r2.stderr or r2.stdout or "").strip().splitlines()
        return False, "Install failed: " + (blob[-1] if blob else "unknown error")

    def _appops_allow(self):
        applib._run(self._adb, self._serial,
                    ["shell", "appops", "set", HELPER_PKG, MOCK_APPOP, "allow"], timeout=8)

    def _appop_is_allow(self) -> bool:
        r = applib._run(self._adb, self._serial,
                        ["shell", "appops", "get", HELPER_PKG, MOCK_APPOP], timeout=8)
        return "allow" in r.stdout.lower()


# --- the picker widget -------------------------------------------------------
class MockLocationView(QWidget):
    """MapLibre map + coordinate controls to pick and toggle a mock GPS location.

    The map (QWebEngineView) is created lazily the first time the widget is shown,
    so it costs nothing until the Location tab is opened (and headless smoke tests
    that never show it never spin up WebEngine)."""

    status = pyqtSignal(str)   # transient status-bar text
    failed = pyqtSignal(str)   # error -> status bar

    PRESETS = [
        ("San Francisco", 37.7749, -122.4194),
        ("New York", 40.7128, -74.0060),
        ("London", 51.5074, -0.1278),
        ("Paris", 48.8566, 2.3522),
        ("Tokyo", 35.6762, 139.6503),
        ("Dubai", 25.2048, 55.2708),
        ("Sydney", -33.8688, 151.2093),
    ]

    def __init__(self, adb: str, parent=None):
        super().__init__(parent)
        self.adb = adb or ""
        self._serial: str | None = None
        self._lat: float | None = None
        self._lng: float | None = None
        self._enabled = False
        self._ready_serials: set[str] = set()   # helper verified installed+allowed
        self._setup_worker: MockSetupWorker | None = None
        self._web = None                         # QWebEngineView, created lazily
        self._map_loaded = False
        self._build_ui()

    # --- construction ------------------------------------------------------
    def _build_ui(self):
        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)

        self._map_holder = QWidget()
        self._map_layout = QVBoxLayout(self._map_holder)
        self._map_layout.setContentsMargins(0, 0, 0, 0)
        self._map_msg = QLabel("Opening map…")
        self._map_msg.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._map_layout.addWidget(self._map_msg)
        root.addWidget(self._map_holder, 1)

        bar = QWidget()
        bar.setObjectName("MockBar")
        h = QHBoxLayout(bar)
        h.setContentsMargins(12, 8, 12, 8)
        h.setSpacing(8)

        self.enable_btn = QPushButton("Enable Mock")
        self.enable_btn.setObjectName("start")          # reuse green→red styling
        self.enable_btn.setCheckable(True)
        self.enable_btn.setProperty("running", "false")
        self.enable_btn.setToolTip("Install the helper (if needed) and start mocking the chosen location")
        h.addWidget(self.enable_btn)
        h.addSpacing(8)

        h.addWidget(QLabel("Lat"))
        self.lat_edit = QLineEdit()
        self.lat_edit.setMaximumWidth(120)
        self.lat_edit.setPlaceholderText("37.7749")
        self.lat_edit.setValidator(_coord_validator(-90.0, 90.0))
        h.addWidget(self.lat_edit)
        h.addWidget(QLabel("Lng"))
        self.lng_edit = QLineEdit()
        self.lng_edit.setMaximumWidth(120)
        self.lng_edit.setPlaceholderText("-122.4194")
        self.lng_edit.setValidator(_coord_validator(-180.0, 180.0))
        h.addWidget(self.lng_edit)
        self.go_btn = QPushButton("Go")
        self.go_btn.setObjectName("toggle")
        self.go_btn.setToolTip("Move the pin to the typed coordinate")
        h.addWidget(self.go_btn)
        h.addSpacing(8)

        self.preset_combo = QComboBox()
        self.preset_combo.addItem("Presets…")
        for name, la, lo in self.PRESETS:
            self.preset_combo.addItem(name, (la, lo))
        h.addWidget(self.preset_combo)

        h.addStretch(1)
        self.status_label = QLabel("Pick a location, then Enable Mock")
        self.status_label.setObjectName("MockStatus")
        h.addWidget(self.status_label)
        root.addWidget(bar)

        self.enable_btn.toggled.connect(self._on_enable_toggled)
        self.go_btn.clicked.connect(self._apply_fields)
        self.lat_edit.returnPressed.connect(self._apply_fields)
        self.lng_edit.returnPressed.connect(self._apply_fields)
        self.preset_combo.activated.connect(self._on_preset)

        # Coalesce live pin-drags into one `set` while mocking is active.
        self._send_timer = QTimer(self)
        self._send_timer.setSingleShot(True)
        self._send_timer.timeout.connect(self._send_set)

    # --- lazy map ----------------------------------------------------------
    def showEvent(self, event):
        super().showEvent(event)
        self._ensure_web()

    def _ensure_web(self):
        if self._web is not None:
            return
        try:
            from PyQt6.QtWebEngineWidgets import QWebEngineView
            from PyQt6.QtWebEngineCore import QWebEngineSettings
        except ImportError as exc:
            self._map_msg.setText(f"Map unavailable — PyQt6-WebEngine not installed\n({exc})")
            return
        self._web = QWebEngineView(self._map_holder)
        s = self._web.settings()
        # The map page is a local file that pulls MapLibre + tiles over https.
        s.setAttribute(QWebEngineSettings.WebAttribute.LocalContentCanAccessRemoteUrls, True)
        s.setAttribute(QWebEngineSettings.WebAttribute.LocalContentCanAccessFileUrls, True)
        self._web.page().titleChanged.connect(self._on_title)
        self._web.loadFinished.connect(self._on_map_loaded)
        self._map_msg.hide()
        self._map_layout.addWidget(self._web)
        self._web.load(QUrl.fromLocalFile(str(MAP_HTML)))

    def _on_map_loaded(self, ok: bool):
        self._map_loaded = bool(ok)
        if not ok:
            self.status.emit("Map failed to load (needs internet for tiles)")
            return
        if self._lat is not None:   # a coord was chosen before the map finished
            self._js_set_marker(self._lat, self._lng, recenter=True)

    # --- JS bridge ---------------------------------------------------------
    def _on_title(self, title: str):
        """The map encodes a picked coordinate as `MOCKLOC:lat,lng|seq`."""
        if not title.startswith("MOCKLOC:"):
            return
        payload = title[len("MOCKLOC:"):].split("|", 1)[0]
        try:
            lat_s, lng_s = payload.split(",")
            lat, lng = float(lat_s), float(lng_s)
        except ValueError:
            return
        self._store_coords(lat, lng, update_fields=True)
        if self._enabled:
            self._send_timer.start(250)   # debounce live drags
            self._reflect_mocking()

    def _js_set_marker(self, lat: float, lng: float, recenter: bool):
        if self._web is not None and self._map_loaded:
            flag = "true" if recenter else "false"
            self._web.page().runJavaScript(f"setLocation({lat},{lng},{flag})")

    # --- coordinate plumbing ----------------------------------------------
    def _store_coords(self, lat: float, lng: float, update_fields: bool):
        self._lat, self._lng = lat, lng
        if update_fields:
            self.lat_edit.setText(f"{lat:.7f}")
            self.lng_edit.setText(f"{lng:.7f}")

    def _apply_fields(self):
        try:
            lat = float(self.lat_edit.text())
            lng = float(self.lng_edit.text())
        except ValueError:
            self._flash("Enter a valid latitude and longitude")
            return
        if not (-90 <= lat <= 90 and -180 <= lng <= 180):
            self._flash("Latitude ±90, longitude ±180")
            return
        self._store_coords(lat, lng, update_fields=False)
        self._js_set_marker(lat, lng, recenter=True)
        if self._enabled:
            self._send_set()
        else:
            self._flash(f"Selected {lat:.5f}, {lng:.5f}")

    def _on_preset(self, index: int):
        data = self.preset_combo.itemData(index)
        if not data:
            return
        lat, lng = data
        self._store_coords(lat, lng, update_fields=True)
        self._js_set_marker(lat, lng, recenter=True)
        if self._enabled:
            self._send_set()
        self.preset_combo.setCurrentIndex(0)

    # --- enable / disable --------------------------------------------------
    def _on_enable_toggled(self, checked: bool):
        if checked:
            # Adopt whatever coordinate is available — a prior map pick, or one
            # just typed into the Lat/Lng fields (no need to press Go first).
            if not self._ensure_coords():
                self._flash("Enter a Lat/Lng or click the map first")
                self._mark_coords_missing()
                self._set_toggle(False)
                return
            if not self.adb or not self._serial:
                self._flash("No device selected")
                self._set_toggle(False)
                return
            self._begin_enable()
        else:
            self._disable()

    def _ensure_coords(self) -> bool:
        """True if we have a coordinate to mock — using an existing pick, else
        parsing the Lat/Lng fields so typing + Enable works without pressing Go."""
        if self._lat is not None:
            return True
        try:
            lat = float(self.lat_edit.text())
            lng = float(self.lng_edit.text())
        except ValueError:
            return False
        if not (-90 <= lat <= 90 and -180 <= lng <= 180):
            return False
        self._store_coords(lat, lng, update_fields=False)
        self._js_set_marker(lat, lng, recenter=True)
        return True

    def _mark_coords_missing(self):
        """Briefly outline the empty coordinate fields so the requirement is
        obvious (the status-bar message alone is easy to miss)."""
        for edit in (self.lat_edit, self.lng_edit):
            if not edit.text().strip():
                edit.setStyleSheet("border: 1px solid #e5534b; border-radius: 7px;")
        QTimer.singleShot(1500, self._clear_coord_marks)

    def _clear_coord_marks(self):
        self.lat_edit.setStyleSheet("")
        self.lng_edit.setStyleSheet("")

    def _begin_enable(self):
        if self._serial in self._ready_serials:
            self._start_mock()
            return
        if self._setup_worker is not None:
            return
        self.enable_btn.setEnabled(False)
        self._set_status("Installing helper…")
        self._setup_worker = MockSetupWorker(self.adb, self._serial, HELPER_APK)
        self._setup_worker.done.connect(self._on_setup_done)
        self._setup_worker.start()

    def _on_setup_done(self, ok: bool, message: str):
        self._setup_worker = None
        self.enable_btn.setEnabled(True)
        if ok:
            self._ready_serials.add(self._serial)
            self.status.emit(message)
            self._start_mock()
        else:
            self._set_toggle(False)
            self._set_status("Setup failed")
            self.failed.emit(message)

    def _start_mock(self):
        self._enabled = True
        self._set_toggle(True)
        self._send_set()

    def _disable(self):
        was = self._enabled
        self._enabled = False
        self._set_toggle(False)
        if was and self.adb and self._serial:
            QProcess.startDetached(self.adb, stop_args(self._serial))
        # The helper removes the mock override and actively reacquires a real fix,
        # so the device snaps back to its real location (given any GPS/network signal).
        self._set_status("Mock off — restoring real location…")
        self.status.emit("Mock disabled — restoring the device's real location")

    def _send_set(self):
        if not self.adb or not self._serial or self._lat is None:
            return
        QProcess.startDetached(self.adb, set_args(self._serial, self._lat, self._lng, acc=5))
        self._reflect_mocking()

    # --- device / lifecycle ------------------------------------------------
    def set_serial(self, serial: str | None):
        if serial == self._serial:
            return
        if self._enabled:
            self._disable()          # stop mocking the old device before switching
        self._serial = serial
        self._set_status("Pick a location, then Enable Mock" if serial
                         else "No device selected")

    def shutdown(self):
        """Stop mocking on app close so no orphaned mock outlives the app."""
        if self._enabled and self.adb and self._serial:
            QProcess.startDetached(self.adb, stop_args(self._serial))
            self._enabled = False

    # --- small UI helpers --------------------------------------------------
    def _set_toggle(self, on: bool):
        self.enable_btn.blockSignals(True)
        self.enable_btn.setChecked(on)
        self.enable_btn.blockSignals(False)
        self.enable_btn.setText("Disable Mock" if on else "Enable Mock")
        self.enable_btn.setProperty("running", "true" if on else "false")
        self.enable_btn.style().unpolish(self.enable_btn)
        self.enable_btn.style().polish(self.enable_btn)
        if on:
            self._reflect_mocking()

    def _reflect_mocking(self):
        if self._lat is not None:
            self._set_status(f"Mocking {self._lat:.5f}, {self._lng:.5f}")

    def _set_status(self, text: str):
        self.status_label.setText(text)

    def _flash(self, text: str):
        self._set_status(text)
        self.status.emit(text)
