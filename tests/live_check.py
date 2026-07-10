"""Live end-to-end check against a real device (no visible window needed).

Usage: QT_QPA_PLATFORM=offscreen .venv/bin/python tests/live_check.py [serial]
Starts the real adb logcat pipeline for ~3.5s and reports what was ingested.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PyQt6.QtCore import QTimer
from PyQt6.QtWidgets import QApplication
from logcat_viewer.ui import MainWindow

app = QApplication([])
win = MainWindow()

serial = sys.argv[1] if len(sys.argv) > 1 else None
if serial:
    idx = win.device_combo.findData(serial)
else:
    idx = 0
    serial = win.device_combo.currentData()
if idx is not None and idx >= 0:
    win.device_combo.setCurrentIndex(idx)

print(f"adb: {win.adb}")
print(f"device: {win.device_combo.currentText()}  (data={win.device_combo.currentData()})")
win.toggle_stream()


def done():
    win._flush()
    print(f"running: {win.reader.running}")
    print(f"ingested: {win.model.total_count()} entries   rate~{win._rate}/s")
    n = win.model.total_count()
    for r in range(min(3, win.model.rowCount())):
        e = win.model.entry_at(r)
        print(f"  [{e.level}] {e.tag}: {e.msg[:70]}")
    win.reader.stop()
    app.quit()
    sys.exit(0 if n > 0 else 2)


QTimer.singleShot(3500, done)
sys.exit(app.exec())
