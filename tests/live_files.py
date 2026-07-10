"""Live end-to-end check of the File Explorer against a real device.

Drives the app's own code paths — the pure `ls_args`/`classify_listing`
parsing, and the `DirListWorker` / `PushWorker` / `PullWorker` / `FileOpWorker`
chain (run synchronously here, same code the QThreads run) — plus the wired
`FilesView` listing a directory. Exercises a full round-trip in
`/data/local/tmp` (push PC→device, list, pull device→PC + byte-compare,
mkdir → rename → delete) and, if a debuggable app is found, lists its private
data via `run-as`. Nothing app-specific is hard-coded.

Usage: QT_QPA_PLATFORM=offscreen .venv/bin/python tests/live_files.py [serial] [package]
"""
import os
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PyQt6.QtCore import QEventLoop, QTimer
from PyQt6.QtWidgets import QApplication

from logcat_viewer import adb as adblib
from logcat_viewer.files import (
    DirListWorker, PullWorker, PushWorker, FileOpWorker, FilesView,
    ls_args, classify_listing, mkdir_args, rename_args, delete_args, join_path,
)

app = QApplication([])
adb = adblib.find_adb()
if not adb:
    print("adb not found"); sys.exit(2)

serial = sys.argv[1] if len(sys.argv) > 1 else None
if not serial:
    serial = next((d.serial for d in adblib.list_devices(adb) if d.online), None)
if not serial:
    print("no online device"); sys.exit(2)
print(f"adb={adb}\ndevice={serial}\n")

fails = []
def check(cond, msg):
    print(("ok  " if cond else "FAIL") + "  " + msg)
    if not cond:
        fails.append(msg)


def list_dir(path, run_as=None, su=False):
    """Run the real DirListWorker synchronously → (ok, entries, error)."""
    res = {}
    w = DirListWorker(adb, serial, path, run_as, su, 1)
    w.done.connect(lambda seq, ok, p, e, err, used: res.update(ok=ok, entries=e, err=err))
    w.run()
    return res.get("ok"), res.get("entries") or [], res.get("err")


TMP = "/data/local/tmp"
name = f"logcatviewer_live_{os.getpid()}.txt"
remote = join_path(TMP, name)
payload = b"hello from logcat-viewer file explorer\n" * 64
local_dir = tempfile.mkdtemp(prefix="live-files-")
local_src = os.path.join(local_dir, name)
with open(local_src, "wb") as fh:
    fh.write(payload)

# 1) list a world-readable directory via the real worker.
ok, entries, err = list_dir("/sdcard")
check(ok, f"DirListWorker listed /sdcard: {len(entries)} item(s)" + (f" (err={err})" if err else ""))

# 2) push a local file into /data/local/tmp (PC → device) via the real worker.
pushed = {}
pw = PushWorker(adb, serial, [local_src], TMP, None, False)
pw.done.connect(lambda ok, msg, d: pushed.update(ok=ok, msg=msg))
pw.run()
check(pushed.get("ok"), f"PushWorker pushed the file to {TMP}: {pushed.get('msg')}")

# 3) list /data/local/tmp and confirm the file appears.
ok, entries, err = list_dir(TMP)
check(ok and any(e.name == name for e in entries),
      f"the pushed file shows up in {TMP} ({len(entries)} item(s))")

# 4) pull it back (device → PC) and byte-compare.
pull_dest = os.path.join(local_dir, "pulled")
os.makedirs(pull_dest, exist_ok=True)
pulled = {}
plw = PullWorker(adb, serial, [(remote, "file", name)], pull_dest, None, False)
plw.done.connect(lambda ok, msg, d: pulled.update(ok=ok, msg=msg))
plw.run()
roundtrip = os.path.join(pull_dest, name)
same = os.path.exists(roundtrip) and open(roundtrip, "rb").read() == payload
check(pulled.get("ok") and same,
      f"PullWorker pulled the file back byte-for-byte: {pulled.get('msg')}")

# 5) mkdir → rename → delete round-trip via FileOpWorker.
def run_op(argv, label):
    res = {}
    w = FileOpWorker(adb, argv, "ok")
    w.done.connect(lambda ok, msg: res.update(ok=ok, msg=msg))
    w.run()
    check(res.get("ok"), f"{label}: {res.get('msg')}")
    return res.get("ok")

dir1 = join_path(TMP, f"lcv_dir_{os.getpid()}")
dir2 = dir1 + "_renamed"
run_op(mkdir_args(serial, dir1), "mkdir")
ok, entries, _ = list_dir(TMP)
check(any(e.name == os.path.basename(dir1) and e.kind == "dir" for e in entries),
      "new folder appears as a directory in the listing")
run_op(rename_args(serial, dir1, dir2), "rename")
ok, entries, _ = list_dir(TMP)
check(any(e.name == os.path.basename(dir2) for e in entries)
      and not any(e.name == os.path.basename(dir1) for e in entries),
      "rename moved the folder to its new name")
run_op(delete_args(serial, [dir2, remote]), "delete folder + pushed file")
ok, entries, _ = list_dir(TMP)
check(not any(e.name in (os.path.basename(dir2), name) for e in entries),
      "delete removed both the folder and the pushed file")

# 6) app-private listing via run-as (best-effort — needs a debuggable app).
pkg = sys.argv[2] if len(sys.argv) > 2 else None
if not pkg:
    out = subprocess.run([adb, "-s", serial, "shell", "pm", "list", "packages", "-3"],
                         capture_output=True, text=True, timeout=20).stdout
    for line in out.splitlines():
        p = line.strip()
        if not p.startswith("package:"):
            continue
        p = p[len("package:"):]
        r = subprocess.run([adb, *ls_args(serial, f"/data/data/{p}", run_as=p)],
                           capture_output=True, text=True, timeout=10)
        ents, e = classify_listing(r.returncode, r.stdout, r.stderr)
        if ents is not None:
            pkg = p
            break
if pkg:
    ok, entries, err = list_dir(f"/data/data/{pkg}", run_as=pkg)
    check(ok, f"DirListWorker listed private data of '{pkg}' via run-as "
              f"({len(entries)} item(s))" + (f" err={err}" if err else ""))
else:
    print("note  no debuggable third-party app found — skipped the run-as listing check")

# 7) the wired FilesView lists a directory end-to-end.
view = FilesView(adb)
view.set_serial(serial)
view.resize(900, 600)
view._navigate(TMP)
view.show()   # showEvent → _maybe_reload; navigation already kicked off a load


def wait_until(predicate, timeout_ms=15000):
    if predicate():
        return True
    loop = QEventLoop()
    timer = QTimer(); timer.setInterval(150)
    timer.timeout.connect(lambda: predicate() and loop.quit())
    QTimer.singleShot(timeout_ms, loop.quit)
    timer.start(); loop.exec(); timer.stop()
    return predicate()

listed = wait_until(lambda: view.table.rowCount() > 0)
check(listed and view.table.rowCount() > 0,
      f"FilesView populated the table for {TMP} ({view.table.rowCount()} rows)")

view.shutdown()
shutil.rmtree(local_dir, ignore_errors=True)

print()
if fails:
    print(f"{len(fails)} FAILURE(S)"); sys.exit(1)
print("ALL LIVE FILE-EXPLORER CHECKS PASSED")
