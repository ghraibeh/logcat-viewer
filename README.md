# Logcat Viewer

A native-feeling macOS desktop app (Python + PyQt6) that streams **live `adb logcat`**
and filters it like logcat — by **level, tag, PID, free text, and regex** — with live,
as-you-type filtering over a large in-memory buffer, plus a set of device tools (install/pull APK,
screen mirror, screenshot, screen recording).

Standalone project — it works with **any** `adb`-visible device and app; its only external
requirement is the `adb` binary.

![toolbar: device ▾  Start  Pause  Clear · Level ▾  Tag  PID  Find  Exclude]

## Run

```bash
./run.sh
# or:
.venv/bin/python -m logcat_viewer
```

Pick a device, press **Start**. Existing buffer dumps immediately, then it follows live.

## Features

- **Live stream** from `adb -s <serial> logcat -v threadtime`, multi-device picker.
- **Pull APK** — pick an app in the **App** box, click **Pull**, choose a folder, and its APK(s)
  (base + all splits) are pulled off the device via `pm path` + `adb pull` into a `<package>/`
  subfolder. Runs async; a dialog reports the result with an **Open Folder** button. App clones
  running inside a virtualization host are pulled from their sandbox path when possible.
- **Install APK** — the **Install…** button (or **drag `.apk` files onto the window**) installs to the
  selected device via `adb install -r -d`; several `.apk`s at once are installed as splits
  (`install-multiple`). Runs async (no UI freeze); on finish a **dialog reports success or failure**
  (failure shows the adb reason + full output), and on success the app list refreshes.
- **Screen mirror** — the **Mirror** button opens a side panel mirroring the selected device.
  When **PyAV** is installed it streams the device display as **hardware-encoded H.264**
  (`screenrecord --output-format=h264`) and decodes it with ffmpeg — smooth **~60 fps** delta-compressed
  video, the same technique scrcpy/Android Studio use (after a ~1 s encoder warm-up). Without PyAV it
  falls back to a `screencap` poller (~14 fps). It also drops to the poller automatically while an MP4
  **recording** is running, since the device has a single display encoder. Click = tap, drag = swipe, plus
  **Back / Home / Recents** buttons. **Drop an `.apk` onto the mirror** to install it to that device —
  a status banner (Installing… → ✓/✗) is drawn on top of the screen. A **⤢ scrcpy** button pops out
  full-quality, low-latency interactive mirroring if
  [scrcpy](https://github.com/Genymobile/scrcpy) is installed (`brew install scrcpy`).
  - **📷 Screenshot** — grabs a full-resolution PNG (`screencap -p`) into `~/Downloads` and shows an
    on-screen banner + a dialog with **Open Folder**.
  - **⏺ Rec / ⏹ Stop** — records the screen to an MP4 in `~/Downloads`. A red *Recording…* banner
    stays on the screen until you press **Stop**; the file is finalized cleanly by SIGINT-ing the
    on-device `screenrecord` (so the MP4 is never truncated), pulled off the device, and the device
    copy deleted. (screenrecord self-stops at the device's ~180s limit; the recording is still saved.)
- **App filter** — searchable **App** picker lists installed apps (plus sandboxed app clones running
  inside a virtualization host, which aren't OS-installed). Selecting one filters the stream to that
  app's PIDs — matching `pkg` **and** `pkg:*`, so all extra/`:child` processes are included. PIDs are
  re-resolved every 3s, so an app launch or restart is picked up automatically.
- **Filter bar (all live, debounced):**
  - **Level** — minimum priority (Verbose → Fatal).
  - **Tag** — substring or, with the `.*` toggle, **regex** (e.g. `ActivityManager|WindowManager`).
  - **PID** — one or several (`1234, 5678`).
  - **Find** — matches the whole line (tag + message); substring or regex.
  - **Exclude** — hide matching lines; substring or regex.
  - Invalid regex turns the field red and is ignored (log keeps flowing) rather than erroring.
- **Color by level** (legible in light & dark), monospace table.
- **Right-click menu** on the log: **Copy** selected lines, **Clear log**, and **Force-crash**
  the app (the filtered app, or the right-clicked row's process) — `am force-stop` + `kill -9`
  the resolved PIDs (the `kill` path covers sandboxed clones too; needs a rooted shell).
- **Wrap toggle** — on (default): long messages wrap to multiple lines, each row grows to fit.
  Off: compact single-line rows with a **horizontal scrollbar** to read long lines. Only visible
  rows are measured, so it stays fast at any buffer size.
- **Text size** — `A− / A+` buttons (and `⌘+` / `⌘−`) resize the log font; row height tracks it.
- **Pause / Resume** — freezes the view; incoming lines are buffered (capped) and flushed on resume.
- **Clear**, **Auto-scroll** toggle, **detail pane** showing the full selected line.
- **Ring buffer** — keeps the most recent ~200k lines so memory stays bounded under heavy logging.

## Keyboard

| Shortcut | Action |
|---|---|
| `⌘F` | focus the Find box |
| `⌘K` / `⌃K` | clear |
| `⌘C` | copy selected rows (full lines) |
| `⌘+` / `⌘−` | increase / decrease text size |
| right-click | Copy · Clear · Force-crash app |

## Filtering examples

| Goal | Set |
|---|---|
| One subsystem | Tag regex `ActivityManager\|WindowManager` |
| One app only | pick it in the **App** box (or set **PID**) |
| One process | PID = the process pid |
| Crashes only | Level = Error, Find `FATAL\|SIGSEGV\|ANR` (regex) |
| Cut noise | Exclude regex `chatty\|Choreographer` |

## Requirements / setup

- `adb` on `PATH`, or set `$ADB`, or standard SDK path (`~/Android/sdk/platform-tools/adb`).
- Python venv with PyQt6 (already created in `.venv`). To recreate:
  ```bash
  uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python PyQt6 av
  # or, with a working system python:  python3 -m venv .venv && .venv/bin/pip install PyQt6 av
  ```
  `av` (PyAV / ffmpeg) is optional — it enables the low-latency H.264 screen mirror; without it the
  mirror still works via the screencap poller.
  > Note: this Mac's Homebrew Python 3.14 has a broken `pyexpat` that breaks `pip` in venvs,
  > so the venv uses a managed Python 3.12 via `uv`.

## Layout

```
logcat_viewer/
  adb.py       device discovery + QProcess-backed logcat reader (batched, event-loop only)
  apps.py      device app/process queries: list packages, resolve pkg->PIDs, apk paths, force-crash
  parser.py    threadtime line -> LogEntry (__slots__)
  filters.py   FilterSpec: level/tag/PID/find/exclude, substring or regex
  model.py     QAbstractTableModel: incremental filtered view + ring-buffer trim
  delegates.py level-badge + message (wrap / single-line) cell painting
  colors.py    per-level + per-tag colors
  theme.py     Fusion + dark palette + QSS stylesheet
  mirror.py    screen mirror (H.264 + screencap), screenshot, screen recording, MirrorView
  pull.py      PullWorker: pull an app's APK(s) off the device
  ui.py        MainWindow: controls, live filter bar, table, detail pane, docks, wiring
  __main__.py  entry point
tests/
  smoke.py       offscreen: parser/filters/model/UI pipeline
  live_check.py  drives the real adb pipeline against a device for ~3.5s
```

## Tests

```bash
QT_QPA_PLATFORM=offscreen .venv/bin/python tests/smoke.py
QT_QPA_PLATFORM=offscreen .venv/bin/python tests/live_check.py <serial>
```

## Development

- **[CLAUDE.md](CLAUDE.md)** — architecture, threading model, and hard rules for working in this repo.
- **`.claude/skills/`** — task playbooks: `run-app` (launch/relaunch/verify on a device) and
  `add-device-tool` (the worker + UI-wiring pattern for any new device feature).
- **`.claude/settings.json`** — permission rules (read-only adb queries pre-approved; state-changing
  commands like `install`/`appops set` prompt).

## Not built (easy follow-ons)

Mock location, export to file, saved/named filter presets, custom highlight rules. Say the word.
