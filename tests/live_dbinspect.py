"""Live end-to-end check of the Database Inspector against a real device.

Drives the app's own code paths — the pure `list_dbs_args`/`classify_listing`
detection, the `DbListWorker` → `DbOpenWorker` → `QueryWorker` chain (run
synchronously here, same code the QThreads run), and finally the wired
`DatabaseView` populating its results model — against a **debuggable** app it
auto-detects on the device (no app hard-coded).

Usage: QT_QPA_PLATFORM=offscreen .venv/bin/python tests/live_dbinspect.py [serial] [package]
"""
import os
import subprocess
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PyQt6.QtCore import QEventLoop, QTimer
from PyQt6.QtWidgets import QApplication

from logcat_viewer import adb as adblib
from logcat_viewer.dbinspect import (
    DatabaseView, DbListWorker, DbOpenWorker, QueryWorker, EditWorker,
    classify_listing, list_dbs_args, open_readonly,
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


def find_target():
    """A debuggable third-party app that has at least one database."""
    out = subprocess.run([adb, "-s", serial, "shell", "pm", "list", "packages", "-3"],
                         capture_output=True, text=True, timeout=20).stdout
    pkgs = [l.strip()[len("package:"):] for l in out.splitlines()
            if l.strip().startswith("package:")]
    for p in pkgs:
        try:
            r = subprocess.run([adb, *list_dbs_args(serial, p)],
                               capture_output=True, text=True, timeout=10)
        except subprocess.SubprocessError:
            continue
        dbs, err = classify_listing(r.returncode, r.stdout, r.stderr)
        if dbs:
            return p, dbs
    return None, []


pkg = sys.argv[2] if len(sys.argv) > 2 else None
if pkg:
    r = subprocess.run([adb, *list_dbs_args(serial, pkg)], capture_output=True, text=True, timeout=10)
    dbs, _ = classify_listing(r.returncode, r.stdout, r.stderr)
else:
    pkg, dbs = find_target()

if not pkg or not dbs:
    print("note  no debuggable app with a database found on this device — "
          "can't run the live check (this is an environment limitation, not a failure)")
    sys.exit(0)
print(f"target app = {pkg}\ndatabases  = {dbs}\n")

# 1) list databases via the real worker (run synchronously → exercises run()).
listed = {}
w = DbListWorker(adb, serial, pkg)
w.done.connect(lambda ok, d, m, su, hs: listed.update(ok=ok, dbs=d, msg=m, su=su, sqlite3=hs))
w.run()
check(listed.get("ok") and listed.get("dbs"),
      f"DbListWorker listed {len(listed.get('dbs') or [])} database(s): {listed.get('msg')}")

# 2) pull the first db (+ sidecars) and introspect its tables via the real worker.
import tempfile
tmp = tempfile.mkdtemp(prefix="live-db-")
opened = {}
db_name = listed["dbs"][0]
ow = DbOpenWorker(adb, serial, pkg, db_name, tmp, listed.get("su", False))
ow.done.connect(lambda ok, name, path, tabs, msg: opened.update(
    ok=ok, name=name, path=path, tables=tabs, msg=msg))
ow.run()
check(opened.get("ok"), f"DbOpenWorker pulled + opened '{db_name}': {opened.get('msg')}")
check(bool(opened.get("path")) and os.path.getsize(opened["path"]) > 0,
      "the database snapshot was pulled to a non-empty local file")
tables = opened.get("tables") or []
check(len(tables) > 0, f"introspected {len(tables)} table(s)/view(s) in '{db_name}'")

# pick a table that actually has rows (proves WAL data was read from the sidecar)
with_rows = next(((n, t, c) for (n, t, c) in tables if t == "table" and c > 0), None)
if with_rows is None:
    with_rows = next(((n, t, c) for (n, t, c) in tables if t == "table"), tables[0])
tname, _ttype, tcount = with_rows

# 3) browse a page of that table via the real QueryWorker.
browsed = {}
qw = QueryWorker(opened["path"], table=tname, limit=50, offset=0)
qw.done.connect(lambda ok, cols, rows, total, trunc, msg, rowids: browsed.update(
    ok=ok, cols=cols, rows=rows, total=total, msg=msg, rowids=rowids))
qw.run()
check(browsed.get("ok") and browsed.get("cols"),
      f"QueryWorker read table '{tname}': {len(browsed.get('cols') or [])} columns")
check(browsed.get("total") == tcount,
      f"row total matches the introspected count ({browsed.get('total')} == {tcount})")
if tcount > 0:
    check(len(browsed.get("rows") or []) > 0,
          f"got {len(browsed.get('rows') or [])} row(s) back (WAL data included)")
    check(browsed.get("rowids") and len(browsed["rowids"]) == len(browsed["rows"]),
          "QueryWorker returns per-row rowids for editing")

# 4) a free-form read-only query runs; a write is rejected (query_only) on the
#    real pulled snapshot — including WAL-mode dbs.
con = open_readonly(opened["path"])
cnt = con.execute(f'SELECT COUNT(*) FROM "{tname}"').fetchone()[0]
check(cnt == tcount, f"stdlib sqlite read of the snapshot agrees on COUNT(*) = {cnt}")
rejected = False
try:
    con.execute(f'DELETE FROM "{tname}"')
except sqlite3.OperationalError:
    rejected = True
con.close()
check(rejected, "query_only snapshot rejects writes (device DB is never modified)")

# 4b) export the pulled snapshot as a self-contained .db (WAL folded in) and
#     confirm the exported file is a valid SQLite db with the same tables.
from logcat_viewer.dbinspect import DbExportWorker, list_tables as _list_tables, is_sqlite_file
exported = {}
dest_db = os.path.join(tmp, "exported.db")
ew = DbExportWorker(opened["path"], dest_db)
ew.done.connect(lambda ok, msg, d: exported.update(ok=ok, msg=msg, dir=d))
ew.run()
check(exported.get("ok") and is_sqlite_file(dest_db),
      f"DbExportWorker wrote a valid .db file: {exported.get('msg')}")
_src_tabs = {t[0] for t in _list_tables(open_readonly(opened["path"]))}
_exp_con = open_readonly(dest_db)
_exp_tabs = {t[0] for t in _list_tables(_exp_con)}
_exp_con.close()
check(_exp_tabs == _src_tabs and not os.path.exists(dest_db + "-wal"),
      "exported .db has the same tables and is self-contained (no -wal sidecar)")

# 5) edit path graceful behavior: run EditWorker against the live device. Where
#    the device has sqlite3 the row is updated; where it doesn't, it fails with a
#    clear message (never a crash, never file-replacement).
if tcount > 0 and browsed.get("rowids"):
    edited = {}
    colname = browsed["cols"][0]
    ew2 = EditWorker(adb, serial, pkg, db_name, tname, colname, browsed["rowids"][0],
                     browsed["rows"][0][0], False, listed.get("su", False))
    ew2.done.connect(lambda ok, msg: edited.update(ok=ok, msg=msg))
    ew2.run()
    if listed.get("sqlite3"):
        check(edited.get("ok"), f"EditWorker updated a row on the device: {edited.get('msg')}")
    else:
        check(edited.get("ok") is False and "sqlite3" in (edited.get("msg") or "").lower(),
              f"no on-device sqlite3 → edit fails gracefully with a clear reason "
              f"({edited.get('msg')})")

# 5) the wired DatabaseView populates its results model end-to-end (list →
#    auto-open first db → auto-select first table → results).
view = DatabaseView(adb)
view.set_serial(serial)
view.set_package(pkg)
view.resize(900, 600)
view.show()   # showEvent → _maybe_reload kicks off the real async chain


def wait_until(predicate, timeout_ms=20000):
    if predicate():
        return True
    loop = QEventLoop()
    timer = QTimer(); timer.setInterval(150)
    timer.timeout.connect(lambda: predicate() and loop.quit())
    QTimer.singleShot(timeout_ms, loop.quit)
    timer.start()
    loop.exec()
    timer.stop()
    return predicate()


# tree lists the databases, and the first one gets pulled/opened by the wired chain
opened_in_view = wait_until(lambda: view._db_paths.get(listed["dbs"][0]) is not None)
check(view.tree.topLevelItemCount() == len(listed["dbs"]),
      f"DatabaseView schema tree shows {view.tree.topLevelItemCount()} database node(s)")
check(opened_in_view, "DatabaseView pulled + opened the first database via its worker chain")
# a table is auto-selected and queried end-to-end (columns present even if the
# app's tables happen to be empty)
loaded = wait_until(lambda: view.model.columnCount() > 0)
check(loaded, f"DatabaseView auto-loaded a table into the results model "
      f"({view.model.columnCount()} cols)")
# explicitly browsing a table that has rows renders exactly that page of rows
if tcount > 0:
    from logcat_viewer.dbinspect import PAGE_SIZE
    view.model.clear()   # so wait_until observes the new browse, not the auto-loaded page
    view._browse_table(listed["dbs"][0], tname, 0)
    expect = min(tcount, PAGE_SIZE)
    shown = wait_until(lambda: view.model.rowCount() == expect)
    check(shown, f"browsing '{tname}' in the view renders its page of rows "
          f"(want {expect}, got {view.model.rowCount()})")

# connect/disconnect: the auto-connected first DB shows tables; disconnecting it
# drops the snapshot files and clears its tables.
first_db = listed["dbs"][0]
first_item = view._db_items.get(first_db)
snap = view._db_paths.get(first_db)
check(first_item is not None and first_item.childCount() > 0,
      f"'{first_db}' is connected in the tree (tables listed as children)")
view._disconnect_db(first_db, silent=True)
check(first_db not in view._db_paths and first_item.childCount() == 0
      and (snap is None or not os.path.exists(snap)),
      "disconnect removes the snapshot + tables and marks the DB disconnected")

view.shutdown()
import shutil
shutil.rmtree(tmp, ignore_errors=True)

print()
if fails:
    print(f"{len(fails)} FAILURE(S)"); sys.exit(1)
print("ALL LIVE DB-INSPECT CHECKS PASSED")
