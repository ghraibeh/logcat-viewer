# AndroidLab

A native-feeling macOS desktop app (Python + PyQt6) that streams **live `adb logcat`**
and filters it like logcat — by **level, tag, PID, free text, and regex** — with live,
as-you-type filtering over a large in-memory buffer, plus a set of device tools (install/pull APK,
screen mirror, screenshot, screen recording, **mock GPS location**, HTTP intercept, SQLite database
inspector, a **file explorer** with two-way transfer & drag-and-drop, an **App-Manager-style app
manager**, and a **CPU/RAM performance monitor**).

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
  - **📋 Paste / ⌨ Type** — types the Mac clipboard (`⌘V` on the mirror) or a typed string into the
    focused field on the device via `input text` (shell-escaped; ASCII — an `input` limitation).
- **Mock GPS location** — the **Location** tab shows a **MapLibre** map; click the map, drag the pin,
  search a place by name, type coordinates, or pick a preset, then hit **Enable Mock**. Works on **all
  Android versions**: modern Android only accepts a mock fix from an app that is the selected mock
  location app, so a tiny bundled helper APK (`android-helper/`, no UI, ~20 KB) is **auto-installed on
  first use** and granted the mock-location app-op (`appops set … android:mock_location allow`) — no
  manual on-device setup. The helper runs a foreground service that pushes the coordinate to the OS via
  `LocationManager` **gps + network + fused** test providers; the coordinate only ever travels
  Mac → device over adb (nothing from the network). **Toggle off and it removes the override *and*
  actively reacquires the device's real GPS fix, snapping back to the real location** (given any
  signal); it's also stopped automatically when the app closes. *(The map needs internet for tiles;
  controls work offline.)*
- **Database Inspector** — the **Databases** tab reads the **selected app's** SQLite databases,
  Android-Studio style. Pick an app in the **App** box; the tab lists its databases and their tables
  (with row counts), lets you page through rows, and run **read-only SQL**. It pulls a **snapshot** of
  each database (plus its `-wal`/`-shm` sidecars, so WAL data is current) with `run-as … cat` and reads
  it locally with Python's stdlib `sqlite3` — **no extra dependency**. Like Android Studio's inspector,
  the app must be **debuggable** (or the device rooted → `su`).
  - **Schema explorer** — databases (🛢 cylinder icon) and their tables/views (grid icon) in a tree.
    A **connected** database shows green with its tables listed; **disconnected** shows dim. Right-click
    a database → **Connect / Disconnect / Reconnect (fresh snapshot)**. A **filter box** searches the
    tree by database *and* table name.
  - **Right-click a cell → Copy value / Copy row / View value** — the View dialog shows the full cell
    (JSON pretty-printed), handy for long text/blobs. `⌘C` copies the selected cells as TSV.
  - **Edit a value** — double-click a cell (or right-click → *Edit value*) to change it and **Save to
    device**. Writes go through the on-device `sqlite3` binary (which handles WAL/locking correctly —
    never a risky file-replacement), targeted by rowid. Available on devices that ship `sqlite3`
    (emulators, rooted, or userdebug builds); elsewhere the cell opens read-only with a clear note.
  - **Export** — right-click a database → *Export database as .db file* saves a **self-contained**
    copy (WAL folded in via SQLite's backup API, no sidecars). *Export CSV* saves the current result.
  - Browsing/queries run on the local snapshot (opened `query_only`), so reads never modify the device;
    edits are the only writes and go straight to the live DB. Hit **Refresh** for a fresh snapshot.
- **File Explorer** — the **Files** tab is a **Windows-Explorer-style** device file browser (dark-
  themed): a command bar (New folder / Upload / Download / Rename / Delete / Sort / View), a
  **back / forward / up / refresh** row with a clickable **breadcrumb address bar** (click it to type
  a raw path) and a **Search** box, plus a **Quick access / This device** navigation pane. Switch
  between **Details** (Name / Date modified / Type / Size) and **Large icons** views. The sidebar
  jumps to internal storage (`/sdcard`), Downloads, Pictures, `/data/local/tmp`, `/system`, device
  root `/`, and the **selected app's private data** (`/data/data/<pkg>` via `run-as`, with a rooted
  **Root (su)** fallback toggle). Symlinks like `/sdcard` are followed automatically.
  - **Transfer** — **Download** pulls the selected item(s) to this Mac; **Upload** pushes file(s)
    into the current folder; double-click a file to open it locally. Public paths use `adb
    pull`/`push`; app-private paths stream via `run-as … cat` (pull) and `run-as … dd` (push), so no
    root is needed for a debuggable app.
  - **Drag & drop both ways** — drop files from Finder onto the view to upload them to the current
    folder, or drag items out to Finder to download them.
  - **Manage** — **New folder**, **Rename**, and **Delete** (with a confirmation prompt), plus
    right-click **Copy device path**. Everything runs off the UI thread.
- **App Management** — the **Apps** tab is an **[App-Manager](https://github.com/muntashirakon/AppManager)-style**
  view of every installed package (**real app icons**, pulled lazily from each APK — extracted straight
  out of the APK zip via the device's `unzip`, no root and no whole-APK download — with a drawn
  letter-tile fallback; search + **All / User / System / Disabled** filter). Pick an app to see a rich
  detail pane:
  - **Info** — version name/code, min/target SDK, UID, installer, first-install / last-update times,
    data dir, code path, ABI, flags, and **APK / data / cache sizes**.
  - **Permissions** — every requested permission with its **granted / denied** state; right-click to
    **Grant** or **Revoke** (`pm grant`/`revoke`), or use **Grant all** / **Revoke all** to change
    every changeable runtime permission at once (install/normal perms are dimmed and left untouched).
  - **Components** — activities, services, receivers, and providers (from the manifest resolver
    tables); right-click to **Enable / Disable / Reset** a component (`pm enable`/`disable`).
  - **App Ops** — per-op modes (`appops get`); right-click to set **allow / deny / ignore / default /
    foreground** (`appops set`), or add any op by name.
  - **Signature** — the signing summary from `dumpsys package`.
  - **Running** — the app's live services (`dumpsys activity services`): component, process, PID,
    foreground/started state.
  - **Prefs** — the **SharedPreferences editor** (see below), scoped to the selected app.
  - **Crashes** — the **crash/ANR viewer** (see below), with its "This app" filter following the
    selected app.
  - **Decompile to Java** — right-click an app → **Decompile to Java (jadx)**. It pulls the APK and
    runs **jadx** (DEX → readable Java + decoded resources/manifest), then opens a **source explorer**
    window: a file tree of the decompiled project on the left and a read-only **code editor** on the
    right (line numbers + Java/XML syntax highlighting), with a file filter, **Re-decompile**, and
    **Open in Finder**. jadx + a Java runtime are **provisioned on first use** — an existing jadx/Java
    is used if present, otherwise they're downloaded once into
    `~/Library/Application Support/AndroidLab/` and cached (no manual install). Results are cached
    per app, so re-opening is instant.
  - **Actions** — **Launch**, **Force-stop**, **Clear cache** (only the cache — tries
    `pm clear --cache-only`, then `run-as`/rooted-`su` `rm`), **Clear data**, **Enable/Disable**
    (freeze), **Uninstall** (Clear data + Uninstall confirm first), **Extract APK** (pulls base +
    splits to this Mac, with an *Open Folder* button), and **App Info** (opens the OS App-details
    screen). All device work runs off the UI thread.
- **Performance Monitor** — the **Monitor** tab shows the device's **live CPU and RAM** usage:
  overall CPU% (from `/proc/stat` jiffies deltas) with core count and 1/5/15-min load averages, and
  memory used/total (from `/proc/meminfo`), each with a rolling history **sparkline**. Pick an app in
  the shared **App** picker and its **per-process CPU% and memory (PSS)** overlay onto the same cards
  as a second line (via `dumpsys cpuinfo`/`meminfo` — works for **any running app**, no root or
  debuggable build needed). A refresh-rate selector (0.5 – 5 s) sets the poll interval. Sampling runs
  on a background thread and only while the tab is open with a device selected, so it costs nothing
  otherwise. A **🔎 Detect leaks** button runs **memory-leak detection** on the selected app
  (below).
- **Memory-leak detection (LeakCanary / Shark)** — on the **Monitor** tab, pick an app and hit
  **Detect leaks**: it captures a managed heap dump (`am dumpheap`), pulls the `.hprof`, and analyzes
  it with LeakCanary's **Shark** engine, opening a report window with the application leaks and each
  leak's shortest path to the GC root (plus a *Save report* / *Open .hprof folder*). Works on **any
  debuggable app** (or any app on a rooted device) — no LeakCanary library baked in. Shark + a JRE are
  **auto-provisioned on first use** (downloaded once, cached), same as the jadx decompiler.
- **Layout Inspector** — the **Inspector** tab captures a screenshot + the **view hierarchy**
  (`uiautomator dump`, works for any app) side by side: click the screenshot to select the view
  under the cursor (or browse the tree), see its **bounds highlighted** and every property
  (resource-id, class, text, clickable…). No debuggable build needed.
- **Crashes & ANRs** — the **Apps ▸ Crashes** sub-tab scans the dedicated **logcat crash buffer**
  plus the system's **dropbox** records (`data_app_crash` / `anr` / `wtf` / native) and presents
  them **Crashlytics-style**: identical crashes **group with an ×N badge**, and the trace renders
  as a structured view — exception headline card, **your app's frames highlighted**, long runs of
  framework frames **folded behind a click**, and a **Caused-by chain** with the root cause marked
  (click to jump). Filter by kind (💥/⏳/🧨), by the selected app (the filter follows the app you
  pick in the Apps list), or free-text. When a **FATAL EXCEPTION / ANR appears in the live stream,
  the Apps tab badges `Apps ●`** (and the sub-tab `Crashes ●`) and the view re-scans itself.
  Obfuscated traces are auto-detected with a hint to load an **R8/ProGuard `mapping.txt`**, which
  retraces **locally** (classes, methods, line numbers — no retrace binary; the mapping is
  remembered across sessions). Copy or save any record as text.
- **SharedPreferences editor** — the **Apps ▸ Prefs** sub-tab lists the selected app's
  `shared_prefs/*.xml` (run-as for debuggable apps, `su` fallback on rooted devices), shows typed
  key/values, validates edits by type, and writes the rebuilt XML back to the device. A
  **Force-stop** button makes the app re-read the file on next launch.
- **Device Controls** — the **Controls** tab is one-click toggles for the things devs flip daily:
  **dark mode**, **font scale**, **display density**, **animations off**, **show taps / pointer
  location / layout bounds / GPU profile bars** (applied live via a SYSPROPS poke), **don't keep
  activities**, **stay awake** — plus **battery mocking** (`dumpsys battery`), **force Doze**
  (`deviceidle force-idle`) and per-app **standby buckets** for background-work testing. Current
  device state is read back in one shell round-trip.
- **Toolbox** — one tab of small everyday tools:
  - **Intents** — fire deep links (`am start -W -a VIEW -d <uri>`) or compose full intents
    (activity / broadcast / service, action, data, mime, component, **typed extras**) and read
    `am`'s verdict inline.
  - **Monkey** — reproducible UI stress runs (`monkey -p pkg -s seed`) with live output; crashes it
    triggers land in the Crashes tab. The on-device monkey is always killed on stop.
  - **Perfetto** — record a system trace (UI/jank, scheduling, memory presets; 5–60 s) and pull it
    for ui.perfetto.dev.
  - **Notifications** — the device's active notifications (package, channel, title, text) via
    `dumpsys notification --noredact`.
  - **Bugreport** — full `adb bugreport` zip with a progress bar.
- **Wireless adb** — the **📶** toolbar button pairs (Android 11+ pairing code), connects to
  `host:port`, or **switches the current USB device to Wi-Fi** in one click (`tcpip 5555` +
  connect to the device's wlan IP).
- **Log export / import & filter presets** — **File ▸ Export Filtered/Entire Log** writes the
  buffer as threadtime text (`⌘E`); **File ▸ Open Log File** (`⌘O`) loads a saved log back into
  the viewer through the same parser/filters. The filter bar has **named presets** (＋ saves the
  current filters, the picker applies one) persisted across sessions.
- **App filter** — the **Logs** tab has a **click-to-pick app list** down the left side (**All apps**
  + every installed app, plus sandboxed app **clones** running inside a virtualization host) — no
  typing; a filter box narrows it. There's also the searchable **App** picker in the top toolbar; the
  two stay in sync and either filters the stream to that app's PIDs — matching `pkg` **and** `pkg:*`,
  so all extra/`:child` processes are included. PIDs are re-resolved every 3s, so an app launch or
  restart is picked up automatically.
- **Filter bar (all live, debounced):**
  - **Level** — **All levels**, or a minimum priority (Verbose → Fatal).
  - **Find** — the primary search box; matches the tag + message. Type `|`-separated terms for **OR**
    (e.g. `error|success`), or flip the `.*` toggle for full **regex**.
  - **Advanced** (collapsed by default) reveals:
    - **Tag** — substring, `|`-OR terms, or regex (e.g. `ActivityManager|WindowManager`).
    - **PID** — one or several (`1234, 5678`).
    - **Exclude** — hide matching lines; substring, `|`-OR terms, or regex.
  - **Clear filters** resets every field; invalid regex turns the field red and is ignored (log keeps
    flowing) rather than erroring.
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
- Python venv with PyQt6 + PyQt6-WebEngine (already created in `.venv`). To recreate:
  ```bash
  uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python PyQt6 PyQt6-WebEngine av
  # or, with a working system python:  python3 -m venv .venv && .venv/bin/pip install PyQt6 PyQt6-WebEngine av
  ```
  `PyQt6-WebEngine` renders the MapLibre map in the Location tab. `av` (PyAV / ffmpeg) is optional —
  it enables the low-latency H.264 screen mirror; without it the mirror still works via the screencap
  poller.
- The mock-location helper APK ships prebuilt at `logcat_viewer/assets/mocklocation.apk`. To rebuild it
  from source (`android-helper/`) you need the Android SDK build-tools + a JDK: `cd android-helper &&
  ./build.sh` (uses `aapt2`/`d8`/`apksigner` directly — no Gradle).
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
  mocklocation.py  mock GPS: setup worker (auto-install helper + appops), set/stop, MockLocationView
  intercept.py     Network Intercept: built-in HTTP(S) proxy (+ optional mitmproxy); snapshots & restores the device's original proxy, incl. an on-device watchdog that self-heals it if the link drops, InterceptView
  dbinspect.py     Database Inspector: list/pull an app's SQLite DBs (run-as), stdlib-sqlite reader, DatabaseView
  files.py         File Explorer: browse/transfer/manage device files (run-as/su), drag&drop, FilesView
  appmgr.py        App Management: list apps + inspect/manage (perms, components, app-ops, actions), AppManagerView
  decompile.py     Decompile APK→Java (jadx, auto-provisioned) + source-tree/code-viewer, SourceViewerWindow
  monitor.py       Performance Monitor: /proc CPU+RAM+battery poller (QThread) + per-app gfxinfo jank stats + sparkline dashboard + Detect-leaks, MonitorView
  leakdetect.py    Memory-leak detection: am dumpheap → pull → LeakCanary Shark analyze (auto-provisioned jars+JRE), LeakDetectWorker + LeakReportWindow
  inspector.py     Layout Inspector: screencap + uiautomator dump → screenshot + hierarchy tree with hit-testing, InspectorView
  crash.py         Crashes (Apps sub-tab): crash-buffer + dropbox scanner, grouped + rendered traces, R8/ProGuard mapping.txt retrace (local), CrashView
  prefs.py         SharedPreferences editor (Apps sub-tab): run-as/su list/read, typed edit + validation, dd write-back, PrefsView
  controls.py      Device Controls: dev toggles / battery mock / Doze / standby buckets, one-round-trip state read, ControlsView
  intents.py       Intent tester: deep links + full am start/broadcast/startservice with typed extras, IntentView
  stress.py        Monkey runner: seeded stress runs with live output + clean device-side kill, MonkeyView
  perfetto.py      Perfetto capture: preset categories + duration → pull trace for ui.perfetto.dev, PerfettoView
  notifs.py        Notification inspector: dumpsys notification --noredact parser, NotifsView
  bugreport.py     Bugreport: adb bugreport zip with progress, BugreportView
  toolbox.py       Toolbox tab: hosts Intents/Monkey/Perfetto/Notifications/Bugreport as sub-tabs
  wireless.py      Wireless adb: pair / connect / switch-USB-device-to-Wi-Fi dialog + workers
  logtools.py      log export text + named filter presets (JSON in app-support)
  ui.py        MainWindow: controls, live filter bar, Logs/Location/Network/Databases/Files/Apps (incl. Prefs+Crashes sub-tabs)/Monitor/Inspector/Controls/Toolbox tabs, docks, wiring
  __main__.py  entry point
  assets/      map.html (MapLibre picker) + mocklocation.apk (prebuilt helper)
android-helper/  source + build.sh for the mock-location helper APK (LocationManager test providers)
tests/
  smoke.py       offscreen: parser/filters/model/UI pipeline + mock command builders
  live_check.py  drives the real adb pipeline against a device for ~3.5s
  live_mock.py   drives the mock-location flow (auto-install → set → stop) against a device
  live_dbinspect.py  drives the DB inspector (list → pull → read tables/rows) against a device
  live_files.py      drives the file explorer (list → push → pull → mkdir/rename/delete) against a device
  live_appmgr.py     drives app management (list → detail → extract APK → force-stop) against a device
  live_tools.py      drives the dev-tool suite (crashes, inspector, controls state, probe, notifs, services, perfetto) read-only against a device
  decompile_check.py decompiles the bundled APK with jadx and opens it in the source viewer (offline)
```

## Tests

```bash
QT_QPA_PLATFORM=offscreen .venv/bin/python tests/smoke.py
QT_QPA_PLATFORM=offscreen .venv/bin/python tests/live_check.py <serial>
QT_QPA_PLATFORM=offscreen .venv/bin/python tests/live_mock.py <serial>   # mock location, end-to-end
QT_QPA_PLATFORM=offscreen .venv/bin/python tests/live_dbinspect.py <serial> [pkg]  # DB inspector, end-to-end
QT_QPA_PLATFORM=offscreen .venv/bin/python tests/live_files.py <serial> [pkg]      # file explorer, end-to-end
QT_QPA_PLATFORM=offscreen .venv/bin/python tests/live_appmgr.py <serial> [pkg]     # app management, end-to-end
QT_QPA_PLATFORM=offscreen .venv/bin/python tests/live_tools.py <serial>            # dev-tool suite, read-only, end-to-end
QT_QPA_PLATFORM=offscreen .venv/bin/python tests/decompile_check.py                # jadx decompile of the bundled APK (offline)
```

## Development

- **[CLAUDE.md](CLAUDE.md)** — architecture, threading model, and hard rules for working in this repo.
- **`.claude/skills/`** — task playbooks: `run-app` (launch/relaunch/verify on a device) and
  `add-device-tool` (the worker + UI-wiring pattern for any new device feature).
- **`.claude/settings.json`** — permission rules (read-only adb queries pre-approved; state-changing
  commands like `install`/`appops set` prompt).

## Not built (easy follow-ons)

Custom highlight rules, GPX route playback for the mock location, QR-code Wi-Fi pairing, DataStore
(protobuf) editing in the Prefs tab. Say the word.
