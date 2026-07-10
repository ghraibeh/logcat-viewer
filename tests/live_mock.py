"""Live end-to-end check of the mock-location feature against a real device.

Drives the *app's own* code paths — MockSetupWorker (auto-install + appops) and
the set/stop commands MockLocationView issues — then reads the OS back via
`dumpsys location` to prove the coordinate actually took effect.

Usage: QT_QPA_PLATFORM=offscreen .venv/bin/python tests/live_mock.py [serial]
"""
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PyQt6.QtWidgets import QApplication

from logcat_viewer import adb as adblib
from logcat_viewer.mocklocation import (
    HELPER_APK, HELPER_PKG, MockLocationView, MockSetupWorker, set_args, stop_args,
)

LAT, LNG = 35.6586, 139.7454   # Tokyo Tower — clearly not a real GPS fix here

app = QApplication([])
adb = adblib.find_adb()
if not adb:
    print("adb not found"); sys.exit(2)

serial = sys.argv[1] if len(sys.argv) > 1 else None
if not serial:
    devs = adblib.list_devices(adb)
    serial = next((d.serial for d in devs if d.online), None)
if not serial:
    print("no online device"); sys.exit(2)
print(f"adb={adb}\ndevice={serial}\n")

fails = []
def check(cond, msg):
    print(("ok  " if cond else "FAIL") + "  " + msg)
    if not cond:
        fails.append(msg)


def dumpsys_location():
    return subprocess.run([adb, "-s", serial, "shell", "dumpsys", "location"],
                          capture_output=True, text=True, timeout=15).stdout


def poll(predicate, tries=8):
    """Call dumpsys repeatedly (each call is ~1s, past a ticker push)."""
    out = ""
    for _ in range(tries):
        out = dumpsys_location()
        if predicate(out):
            return True, out
    return False, out


# 1) setup: install (if missing) + grant the mock app-op, via the real worker.
result = {}
w = MockSetupWorker(adb, serial, HELPER_APK)
w.done.connect(lambda ok, msg: result.update(ok=ok, msg=msg))
w.run()   # run synchronously on this thread — exercises the real install/appops code
check(result.get("ok") is True, f"MockSetupWorker succeeded: {result.get('msg')}")
installed = HELPER_PKG in subprocess.run(
    [adb, "-s", serial, "shell", "pm", "list", "packages", HELPER_PKG],
    capture_output=True, text=True).stdout
check(installed, "helper package is installed on the device")

# 2) enable: build the view and push a coordinate exactly as the UI does.
mv = MockLocationView(adb)
mv._serial = serial
mv._ready_serials.add(serial)     # setup already done above
mv._store_coords(LAT, LNG, update_fields=False)
mv._start_mock()                  # -> _send_set() -> adb am start-foreground-service
ok, out = poll(lambda o: "35.658" in o and "139.745" in o)
check(ok, "dumpsys location reports the mocked coordinate on some provider")
check("gps provider [mock]" in out, "gps provider is flagged as mock")
check(HELPER_PKG in out, "mock is attributed to the helper package")

# 3) disable: stop mocking and confirm the override is gone. (A provider's
# cached last-known fix can linger, so assert on the mock *override* being torn
# down — no provider flagged [mock] — not on the stale coordinate string.)
subprocess.run([adb, "-s", serial, "logcat", "-c"], capture_output=True)   # isolate restore logs
mv._disable()
gone, out = poll(lambda o: "provider [mock]" not in o, tries=6)
check(gone, "after disable, no provider is flagged [mock] anymore (override removed)")

# The helper then reacquires the device's real location. That needs live GPS/network
# signal, so treat "no fix available" as an environment note, not a failure.
def helper_log():
    return subprocess.run([adb, "-s", serial, "logcat", "-d", "-s", "MockLocation"],
                          capture_output=True, text=True, timeout=10).stdout

restored, note = False, ""
for _ in range(14):
    dumpsys_location()   # ~1s pacing between checks
    log = helper_log()
    hit = [l for l in log.splitlines() if "real location restored" in l]
    if hit:
        restored, note = True, hit[-1].split("restored:")[-1].strip()
        break
    if "restore:" in log:   # timed out with no fix / no provider
        note = [l for l in log.splitlines() if "restore:" in l][-1].split(":", 3)[-1].strip()
        break
if restored:
    check(True, f"real location reacquired after disable ({note})")
else:
    print(f"note  real location not reacquired in this environment ({note or 'no signal'}) — "
          "it resumes when the device gets a fix")

# leave the device clean
subprocess.run([adb] + stop_args(serial), capture_output=True)

print()
if fails:
    print(f"{len(fails)} FAILURE(S)"); sys.exit(1)
print("ALL LIVE MOCK CHECKS PASSED")
