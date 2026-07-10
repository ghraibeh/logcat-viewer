"""Live check of the app filter: stream, pick the busiest PID, resolve it to a
package, filter by that app, and verify every shown row belongs to it.

Usage: QT_QPA_PLATFORM=offscreen .venv/bin/python tests/live_app_check.py [serial]
"""
import os
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PyQt6.QtCore import QTimer
from PyQt6.QtWidgets import QApplication
from logcat_viewer import apps
from logcat_viewer.ui import MainWindow

serial = sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1:6555"
app = QApplication([])
win = MainWindow()
idx = win.device_combo.findData(serial)
if idx is not None and idx >= 0:
    win.device_combo.setCurrentIndex(idx)
print(f"device: {win.device_combo.currentText()}")
win.toggle_stream()


def phase2():
    win._flush()
    total = win.model.total_count()
    counts = Counter(win.model.entries[i].pid for i in range(total))
    if not counts:
        print("no logs captured; is the device idle?")
        win.reader.stop(); app.quit(); sys.exit(2)
    top_pid, top_n = counts.most_common(1)[0]
    procs = dict(apps.running_processes(win.adb, serial))
    name = procs.get(top_pid, "?")
    base = name.split(":", 1)[0]
    print(f"busiest pid {top_pid} ({top_n} lines) -> process '{name}' -> app '{base}'")
    print(f"apps loaded in picker: {win.app_combo.count() - 1}")
    win.app_combo.setEditText(base)
    win.select_app()
    print(f"resolved pids for {base}: {sorted(win._app_pids)}")
    QTimer.singleShot(2500, done)


def done():
    win._flush()
    total = win.model.total_count()
    shown = win.model.rowCount()
    pids = win._app_pids or frozenset()
    bad = [win.model.entry_at(r).pid for r in range(shown) if win.model.entry_at(r).pid not in pids]
    print(f"after filter: {shown}/{total} shown, all belong to app: {not bad}")
    if bad:
        print("  offending pids:", sorted(set(bad))[:10])
    ok = shown > 0 and not bad and shown <= total
    win.reader.stop()
    app.quit()
    sys.exit(0 if ok else 2)


QTimer.singleShot(3000, phase2)
sys.exit(app.exec())
