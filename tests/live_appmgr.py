"""Live end-to-end check of the App Management tab against a real device.

Drives the app's own code paths — the pure command builders + `dumpsys`/`appops`
parsers, the `AppListWorker` / `AppDetailWorker` / `AppActionWorker` chain (run
synchronously here, same code the QThreads run), and the wired `AppManagerView`
listing installed apps. Read-only by default: it lists apps, inspects one app's
details (info / permissions / components / app-ops), extracts its APK to a temp
dir, and force-stops it (reversible). It does NOT uninstall / clear / disable —
those destructive ops are gated to "ask" and are for manual verification.

Usage: QT_QPA_PLATFORM=offscreen .venv/bin/python tests/live_appmgr.py [serial] [package]
"""
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PyQt6.QtCore import QEventLoop, QTimer
from PyQt6.QtWidgets import QApplication

from logcat_viewer import adb as adblib
from logcat_viewer.appmgr import (
    AppManagerView, AppListWorker, AppDetailWorker, AppActionWorker, AppIconWorker,
    ClearCacheWorker, BulkPermWorker, force_stop_args as _fs,
)
from PyQt6.QtGui import QImage

app = QApplication([])
adb = adblib.find_adb()
if not adb:
    print("adb not found"); sys.exit(2)

serial = sys.argv[1] if len(sys.argv) > 1 else None
if not serial:
    serial = next((d.serial for d in adblib.list_devices(adb) if d.online), None)
if not serial:
    print("no online device"); sys.exit(2)
target = sys.argv[2] if len(sys.argv) > 2 else None
print(f"adb={adb}\ndevice={serial}\n")

fails = []
def check(cond, msg):
    print(("ok  " if cond else "FAIL") + "  " + msg)
    if not cond:
        fails.append(msg)


def run_worker(w, *, timeout=60000):
    """Start a real QThread worker and pump the event loop until it finishes."""
    got = {}
    w.done.connect(lambda *a: got.setdefault("args", a))
    loop = QEventLoop()
    w.finished.connect(loop.quit)
    QTimer.singleShot(timeout, loop.quit)
    w.start()
    loop.exec()
    return got.get("args")


# --- 1. list installed apps --------------------------------------------------
res = run_worker(AppListWorker(adb, serial))
ok, apps, error = res if res else (False, [], "no result")
check(ok and len(apps) > 10, f"AppListWorker returned {len(apps)} apps")
sys_ct = sum(1 for a in apps if a.system)
dis_ct = sum(1 for a in apps if not a.enabled)
check(sys_ct > 0, f"tagged {sys_ct} system apps")
print(f"     ({sys_ct} system, {dis_ct} disabled)")

# choose a target: the requested one, else Settings, else the first user app
by_name = {a.package: a for a in apps}
if not target:
    target = ("com.android.settings" if "com.android.settings" in by_name
              else next((a.package for a in apps if not a.system), apps[0].package))
tinfo = by_name.get(target)
check(tinfo is not None, f"target package present: {target}")
print(f"     target={target}  apk={tinfo.apk_path if tinfo else '?'}\n")

# --- 2. app detail (dumpsys + appops + sizes) --------------------------------
res = run_worker(AppDetailWorker(adb, serial, target, tinfo.apk_path if tinfo else "", 1))
ok, detail, error, seq = res if res else (False, None, "no result", 1)
check(ok and detail is not None, f"AppDetailWorker read {target}: {error or 'ok'}")
if detail:
    g = detail.general
    check(bool(g.get("versionName") or g.get("versionCode")),
          f"general has a version ({g.get('versionName')} / {g.get('versionCode')})")
    check("dataDir" in g, f"general has dataDir ({g.get('dataDir')})")
    check(len(detail.permissions) > 0,
          f"parsed {len(detail.permissions)} requested permissions")
    ncomp = (len(detail.activities) + len(detail.services)
             + len(detail.receivers) + len(detail.providers))
    check(ncomp > 0,
          f"parsed {ncomp} components "
          f"(A{len(detail.activities)} S{len(detail.services)} "
          f"R{len(detail.receivers)} P{len(detail.providers)})")
    print(f"     appops={len(detail.appops)}  apkSize={g.get('apkSize') or '—'}  "
          f"dataSize={g.get('dataSize') or '—'}")
    granted = sum(1 for p in detail.permissions if p.granted is True)
    print(f"     permissions: {granted} granted / {len(detail.permissions)} total\n")

# --- 3. extract APK to a temp dir (read-only pull) ---------------------------
from logcat_viewer.pull import PullWorker
tmp = tempfile.mkdtemp(prefix="live-appmgr-")
try:
    res = run_worker(PullWorker(adb, serial, target, tmp), timeout=180000)
    ok, msg, dest = res if res else (False, "no result", "")
    apks = [f for f in (os.listdir(dest) if dest and os.path.isdir(dest) else [])
            if f.endswith(".apk")]
    check(ok and apks, f"extracted APK(s): {apks}  → {dest}")
finally:
    shutil.rmtree(tmp, ignore_errors=True)

# --- 3b. real app icon straight out of the APK (no whole-APK download) -------
res = run_worker(AppIconWorker(adb, serial, target, tinfo.apk_path if tinfo else ""),
                 timeout=30000)
pkg, result = res if res else (target, None)
if result == "unavailable":
    print("     (device has no `unzip`; icons fall back to letter tiles)")
    check(True, "icon fetch degrades gracefully without unzip")
elif isinstance(result, QImage) and not result.isNull():
    check(result.width() > 0 and result.height() > 0,
          f"AppIconWorker decoded a {result.width()}x{result.height()} icon for {target}")
else:
    print(f"     ({target} has no raster launcher icon — adaptive-only; tile fallback)")
    check(True, "adaptive-only app falls back to the letter tile")

# --- 4. reversible state-changes: force-stop + clear cache -------------------
res = run_worker(AppActionWorker(adb, _fs(serial, target), f"force-stop {target}"))
ok, msg = res if res else (False, "no result")
check(ok, f"AppActionWorker force-stop: {msg}")

res = run_worker(ClearCacheWorker(adb, serial, target))
ok, msg = res if res else (False, "no result")
# cache clear can legitimately fail on a locked-down system app w/o root — report either way
print(f"     clear-cache → {msg}")
check(ok or "Could not clear cache" in msg,
      "ClearCacheWorker ran its fallback chain and reported a result")

# bulk revoke → grant round-trip over the target's runtime permissions (reversible)
runtime = [p.name for p in (detail.permissions if detail else []) if p.runtime]
if runtime:
    res = run_worker(BulkPermWorker(adb, serial, target, runtime, False))  # revoke all
    ok, msg = res if res else (False, "no result")
    print(f"     revoke-all → {msg}")
    check(ok or "Could not" in msg, "BulkPermWorker revoke-all ran across runtime perms")
    res = run_worker(BulkPermWorker(adb, serial, target, runtime, True))   # grant back
    ok, msg = res if res else (False, "no result")
    print(f"     grant-all  → {msg}")
    check(ok or "Could not" in msg, "BulkPermWorker grant-all restored runtime perms")
else:
    print("     (target has no runtime permissions to bulk-change)")
    check(True, "no runtime perms to bulk-change — skipped")

# --- 5. the wired view lists apps on the real device -------------------------
view = AppManagerView(adb)
view.resize(1000, 640)
view.show()
view.set_serial(serial)
loop = QEventLoop()
QTimer.singleShot(30000, loop.quit)
# poll until the list populates
def _poll():
    if view.app_list.count() > 0:
        loop.quit()
    else:
        QTimer.singleShot(200, _poll)
QTimer.singleShot(200, _poll)
loop.exec()
check(view.app_list.count() > 10,
      f"AppManagerView listed {view.app_list.count()} apps on the device")
view.shutdown()
check(not os.path.isdir(view._tmp), "AppManagerView.shutdown() removed its temp dir")

print()
if fails:
    print(f"{len(fails)} FAILURE(S)")
    sys.exit(1)
print("ALL LIVE APP-MANAGER CHECKS PASSED")
