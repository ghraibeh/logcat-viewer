---
name: add-device-tool
description: Add a new device feature to Logcat Viewer (anything that runs an adb/subprocess operation against the selected device — install, pull, capture, mirror, mock-location, etc.). Use when implementing a new button/panel that talks to the device, so it follows the established non-blocking worker + UI-wiring + feedback pattern instead of freezing the UI.
---

# Add a device tool

Every feature that talks to the device follows the same shape. Copy it rather than inventing a new
one. Reference implementations: `logcat_viewer/pull.py` (worker) and the mirror/install methods in
`logcat_viewer/ui.py`.

## 1. Worker thread (never block the UI)

Put blocking `adb`/`subprocess` work in a `QThread` in its own module. Emit a result signal; never
touch widgets from `run()`.

```python
from PyQt6.QtCore import QThread, pyqtSignal
import subprocess

class MyWorker(QThread):
    done = pyqtSignal(bool, str, str)          # ok, human message, path/detail
    def __init__(self, adb, serial, ..., parent=None):
        super().__init__(parent); self._adb = adb; self._serial = serial
    def run(self):
        try:
            res = subprocess.run([self._adb, "-s", self._serial, ...],
                                 capture_output=True, text=True, timeout=...)
        except (subprocess.SubprocessError, OSError) as exc:
            self.done.emit(False, f"...: {exc}", ""); return
        ok = res.returncode == 0
        self.done.emit(ok, "..." if ok else (res.stderr or res.stdout).strip(), "...")
```

- Long-lived streams (like the mirror) use a `_run` flag + `stop()` that also `kill()`s the local
  process; do device-side cleanup (e.g. `pkill`) in a `finally` so nothing is orphaned.
- Reuse `apps._run(adb, serial, args, timeout)` for short synchronous queries; reuse
  `apps.list_packages` / `apps.apk_paths_on_device` etc. instead of re-shelling `pm`.
- Use `adb exec-out` for binary output (screencap/screenrecord), `adb shell` for text.

## 2. Wire it into MainWindow (`ui.py`)

- Resolve inputs: `serial = self.device_combo.currentData()`, `self.adb` (bail if either is missing
  with a `statusBar().showMessage(...)`).
- Guard against concurrent runs: keep a `self._my_worker` handle; if not `None`, show "already
  running…" and return.
- Disable the button + set a "…ing" label while running; re-enable in the done handler.
- Keep one worker reference alive on `self` (a GC'd QThread crashes).

```python
self._my_worker = MyWorker(self.adb, serial, ...)
self._my_worker.done.connect(self._on_my_done)
self._my_worker.start()
```

## 3. Feedback (match the existing pattern)

In the `done` handler: clear the worker handle, re-enable the button, then report. Success → status
bar + (for saved files) a **non-modal** `QMessageBox` with an **Open Folder** button
(`QDesktopServices.openUrl(QUrl.fromLocalFile(dir))`). Failure → status bar + non-modal error box
with the adb reason. Copy `_on_pull_done` / `_on_mirror_captured`.

## 4. UI placement

Small controls → a new `objectName("toggle")` button on an existing toolbar row (matches the theme).
A large, immersive surface (map, big panel) → a `QDockWidget` (like the mirror) or a separate
top-level window, **not** a cramped toolbar widget. Confirm placement with the user if it changes the
main-window layout.

## 5. Permissions & versions

Device state-changing commands (`appops set`, `settings put`, `install`, `uninstall`, `force-stop`,
`kill`, `rm`) are gated to **ask** in `.claude/settings.json` — expect a prompt. When a feature must
work across Android versions, branch on the API level (`adb shell getprop ro.build.version.sdk`) and
say so in a comment.

## 6. Verify

Add a `check(...)` to `tests/smoke.py` for any pure logic, then drive the real flow on a device (see
the `run-app` skill). Update `README.md`'s Features list and `requirements.txt` if you added a dep.
