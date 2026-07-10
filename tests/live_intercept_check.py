"""Live end-to-end check of the Network Intercept tab against a real device.

Drives the real UI: enable intercept (wires adb reverse + global http_proxy),
generate device traffic, confirm a flow was captured, then disable and confirm
the device proxy was cleared (so the device keeps its internet).

Usage: QT_QPA_PLATFORM=offscreen .venv/bin/python tests/live_intercept_check.py [serial]
"""
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PyQt6.QtCore import QTimer
from PyQt6.QtWidgets import QApplication
from logcat_viewer.ui import MainWindow

app = QApplication([])
win = MainWindow()

serial = sys.argv[1] if len(sys.argv) > 1 else win.device_combo.currentData()
idx = win.device_combo.findData(serial)
if idx is not None and idx >= 0:
    win.device_combo.setCurrentIndex(idx)
serial = win.device_combo.currentData()
adb = win.adb
iv = win.intercept_view
PORT = 8099

print(f"adb: {adb}")
print(f"device: {win.device_combo.currentText()}  (serial={serial})")


def adb_out(*args, timeout=8):
    try:
        return subprocess.run([adb, "-s", serial, *args], capture_output=True,
                              text=True, timeout=timeout).stdout.strip()
    except (subprocess.SubprocessError, OSError) as exc:
        return f"<error: {exc}>"


# Enable intercept through the real toggle path.
iv.set_serial(serial)
win.tabs.setCurrentWidget(iv)
iv.port_spin.setValue(PORT)
iv.enable_btn.setChecked(True)


def phase_traffic():
    proxy = adb_out("shell", "settings", "get", "global", "http_proxy")
    rev = adb_out("reverse", "--list")
    print(f"\n[wired] http_proxy = {proxy!r}")
    print(f"[wired] reverse --list:\n  " + rev.replace("\n", "\n  "))
    ok_wired = f"127.0.0.1:{PORT}" in proxy and f"tcp:{PORT}" in rev
    print(f"[wired] proxy + tunnel present: {ok_wired}")
    print("\n[traffic] opening http://neverssl.com on the device…")
    subprocess.run([adb, "-s", serial, "shell", "am", "start", "-a",
                    "android.intent.action.VIEW", "-d", "http://neverssl.com"],
                   capture_output=True, timeout=10)
    QTimer.singleShot(8000, phase_check)


def phase_check():
    total = iv.model.total_count()
    pending = len(iv._pending)
    print(f"\n[capture] flows captured: {total} (+{pending} pending)")
    for r in range(min(6, iv.model.rowCount())):
        f = iv.model.flow_at(r)
        note = f"  [{f.note}]" if f.note else ""
        print(f"  {f.method} {f.scheme}://{f.host}{f.path[:50]}  -> {f.status}{note}")
    globals()["_captured_ok"] = (total + pending) > 0
    print("\n[teardown] disabling intercept…")
    iv.enable_btn.setChecked(False)     # real disable path (synchronous teardown)
    QTimer.singleShot(1500, phase_verify_clear)


def phase_verify_clear():
    proxy = adb_out("shell", "settings", "get", "global", "http_proxy")
    rev = adb_out("reverse", "--list")
    cleared = f"127.0.0.1:{PORT}" not in proxy and f"tcp:{PORT}" not in rev
    print(f"[teardown] http_proxy now = {proxy!r}")
    print(f"[teardown] tunnel removed + proxy cleared: {cleared}")
    captured_ok = globals().get("_captured_ok", False)
    iv.shutdown()   # belt-and-suspenders
    ok = captured_ok and cleared
    print(f"\nRESULT: {'PASS' if ok else 'FAIL'}  "
          f"(captured={captured_ok}, cleared={cleared})")
    app.quit()
    sys.exit(0 if ok else 2)


QTimer.singleShot(2500, phase_traffic)
sys.exit(app.exec())
