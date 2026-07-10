---
name: run-app
description: Launch, relaunch, or verify the Logcat Viewer desktop app on a connected device. Use when asked to run/start/restart the app, confirm a change works, or after editing any logcat_viewer/*.py file. Covers killing stale instances, cleaning up orphaned on-device processes, the smoke suite, and live-device checks.
---

# Run & verify Logcat Viewer

## Launch / relaunch (do this after any code change to see it live)

Always kill the previous GUI instance first — a bare re-run leaves two windows, and a hard kill can
orphan the old instance's `adb`/on-device children.

```bash
cd /Users/penguin/Downloads/logcat-viewer
pkill -f logcat_viewer 2>/dev/null; sleep 1
nohup ./run.sh >/tmp/logcat-viewer.out 2>&1 &
sleep 3
pgrep -f logcat_viewer >/dev/null && echo "RUNNING (pid $(pgrep -f logcat_viewer | head -1))" \
  || { echo "NOT RUNNING"; tail -30 /tmp/logcat-viewer.out; }
```

- An `exit code 143/144` background notification right after this is just the `pkill` terminating the
  previous instance — **expected, not a failure.**
- If it won't start, read `/tmp/logcat-viewer.out` for the Python traceback.

## Clean up orphaned device processes

The device has a single display encoder; a stale `screenrecord` (e.g. left after a hard `pkill`)
makes the next mirror stall for seconds. Clear it and confirm the device is healthy:

```bash
A=~/Android/sdk/platform-tools/adb
S=$("$A" devices | awk 'NR>1 && $2=="device"{print $1; exit}')
"$A" -s "$S" shell pkill screenrecord 2>/dev/null
"$A" -s "$S" shell ps -A -o NAME | grep -c screenrecord   # 0 == clean
```

## Verify

1. **Headless smoke** (fast, no device) — run after any parser/filter/model/UI change:
   ```bash
   QT_QPA_PLATFORM=offscreen .venv/bin/python tests/smoke.py    # expect "ALL SMOKE CHECKS PASSED"
   ```
2. **Live device** — smoke passing does **not** prove a device feature works. Drive the real flow
   over adb (short standalone PyQt scripts that instantiate the worker/view and assert on results),
   e.g. measure H.264 mirror fps, confirm a pulled APK exists on disk, confirm no `screenrecord` is
   left on the device after stop. Use `tests/live_check.py <serial>` as the reference harness.

## Notes
- The venv is Python 3.12 (`uv`). If imports fail, recreate: `uv venv --python 3.12 .venv &&
  uv pip install --python .venv/bin/python -r requirements.txt`.
- Resolve adb like the app does: `$ADB` → `PATH` → `~/Android/sdk/platform-tools/adb`.
