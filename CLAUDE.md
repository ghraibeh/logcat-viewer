# CLAUDE.md

Guidance for Claude Code when working in this repo.

## What this is

**AndroidLab** — a standalone native-feeling **macOS desktop app** (Python + PyQt6) that streams
**live `adb logcat`**, filters it like Android Studio's Logcat, and bundles a set of device tools:
**app filter, install/pull APK, screen mirror (hardware H.264, incl. clipboard paste / text
typing), screenshot, screen recording, mock GPS location, network HTTP intercept, a SQLite
database inspector, a device file explorer, an App-Manager-style app manager (incl. live running
services), an APK→Java decompiler (jadx) with a source viewer, a live CPU/RAM/battery performance
monitor (per-app overlay + gfxinfo jank stats), LeakCanary/Shark memory-leak detection, a
uiautomator layout inspector, a crash/ANR viewer with local R8/ProGuard retrace, a
SharedPreferences editor, a device-controls panel (dev toggles, battery mock, Doze, standby
buckets), a toolbox (intent/deep-link tester, monkey runner, perfetto capture, notification
inspector, bugreport), wireless adb pair/connect, log export/import, and named filter presets**.

It is a **self-contained project**. It talks to whatever device `adb` can see and is **not tied to
any particular app, SDK, or codebase** — do not couple it to, or pull patterns from, any sibling
project on this machine. Its only runtime dependency on the outside world is the `adb` binary.

## Run & test

```bash
./run.sh                                            # launch (uses .venv)
.venv/bin/python -m logcat_viewer                   # same, explicit
QT_QPA_PLATFORM=offscreen .venv/bin/python tests/smoke.py            # headless smoke suite
QT_QPA_PLATFORM=offscreen .venv/bin/python tests/live_check.py <serial>   # drive real adb ~3.5s
QT_QPA_PLATFORM=offscreen .venv/bin/python tests/live_mock.py <serial>    # mock-location e2e on device
QT_QPA_PLATFORM=offscreen .venv/bin/python tests/live_dbinspect.py <serial> [pkg]  # DB inspector e2e on device
QT_QPA_PLATFORM=offscreen .venv/bin/python tests/live_files.py <serial> [pkg]      # file-explorer e2e on device
QT_QPA_PLATFORM=offscreen .venv/bin/python tests/live_appmgr.py <serial> [pkg]     # app-manager e2e on device
QT_QPA_PLATFORM=offscreen .venv/bin/python tests/live_tools.py <serial>            # dev-tool suite (crashes/inspector/controls/probe/notifs/perfetto), read-only e2e
QT_QPA_PLATFORM=offscreen .venv/bin/python tests/decompile_check.py               # jadx decompile of bundled APK (offline, no device)
```

- **Python 3.12** venv via `uv`. Recreate with `uv venv --python 3.12 .venv && uv pip install
  --python .venv/bin/python -r requirements.txt`. **Do not "upgrade" to system Python 3.14** — this
  Mac's Homebrew 3.14 ships a broken `pyexpat` that breaks `pip`/venv creation.
- **PyAV (`av`) is optional** — it enables the low-latency H.264 mirror; without it the mirror falls
  back to a `screencap` poller. Everything else works without it.
- **PyQt6-WebEngine is required** (renders the MapLibre map in the Location tab). It's the one
  hard dep beyond PyQt6 — the map is created lazily on first show so it costs nothing until the
  Location tab is opened (and headless smoke never spins it up). QtWebEngine needs a non-empty
  `argv`: `__main__.py` passes `sys.argv` + sets `AA_ShareOpenGLContexts` before the `QApplication`.
- **The mock-location helper APK** is prebuilt at `logcat_viewer/assets/mocklocation.apk` and
  **committed**. Rebuild from `android-helper/` with `./build.sh` (raw `aapt2`/`d8`/`apksigner`, no
  Gradle — avoids AGP/JDK-version issues). The app auto-installs it on first use.
- There is **no unit-test framework** — `tests/smoke.py` is a hand-rolled offscreen check that
  exercises parser → filters → model → full UI pipeline. Add to it in the same `check(cond, msg)`
  style. Genuinely verify device features against a **real device over adb**, not just smoke.

## Architecture

Data flow: `LogcatReader` (QProcess) → `parse_line` → batched into `LogTableModel` → `QTableView`
with custom delegates. Filtering is a `FilterSpec` compiled once and applied incrementally.

| File | Role |
|---|---|
| `logcat_viewer/adb.py` | `find_adb()` binary discovery; `list_devices()`; `LogcatReader` (QProcess-backed live `logcat -v threadtime`, batches lines on the event loop — no thread). |
| `logcat_viewer/apps.py` | Pure-subprocess device queries: `list_packages`, `running_processes`, `list_apps`, `resolve_pids`, `apk_paths_on_device`, `force_crash`. Resolves a package → its PIDs (`pkg` or `pkg:suffix`). |
| `logcat_viewer/parser.py` | `LogEntry` (`__slots__`) + `parse_line()` threadtime regex; `PRIORITY` map. |
| `logcat_viewer/filters.py` | `FilterSpec` dataclass: level/tag/PID/find/exclude, substring **or** regex; `.compile()` precompiles (invalid regex → field disabled + error, stream keeps flowing); `.match(e)`. |
| `logcat_viewer/model.py` | `LogTableModel` (`QAbstractTableModel`): incremental filtered view + ring-buffer trim; column constants `COL_*`. |
| `logcat_viewer/delegates.py` | `LevelBadgeDelegate` (level chip) + `MessageDelegate` (wrap / single-line paint, tight height). |
| `logcat_viewer/colors.py` | Per-level message/badge colors + deterministic per-tag hue. |
| `logcat_viewer/theme.py` | `apply(app)`: Fusion + dark `QPalette` + QSS. Palette constants + object-name selectors (`#toggle`, `#start`, `#pause`, `#fontLabel`, `#Toolbar`, `#Detail`, `#FilterBar`, `#MockBar`, `#MockStatus`) + `QTabBar`. |
| `logcat_viewer/mirror.py` | Screen mirror: `H264MirrorWorker` (screenrecord→h264→PyAV decode), `MirrorWorker` (screencap fallback, per-display via `screencap -d`), `ScreenshotWorker`, `RecordWorker`, and `MirrorView` (canvas + control bar, tap/swipe/keys, drop-to-install, capture buttons, 📋 clipboard-paste / ⌨ type via `input text` + `escape_input_text`). Multi-display: pure `build_display_list` joins `dumpsys SurfaceFlinger --display-id` (SF capture ids) with `dumpsys display` viewports (logical ids, re-generated per overlay); `DisplayListWorker` + a control-bar picker (hidden unless >1 display, refreshed on open) mirror any display — e.g. the Controls tab's simulated secondary display — via the screencap poller (screenrecord rejects virtual ids ⇒ no H.264, MP4 record main-only), taps routed with `input -d <logical>`, screenshots via `screencap -d`, scrcpy handed `--display-id`. A mirrored display that vanishes falls back to Main; `show_secondary()` retries the probe (~8×600ms) then auto-switches to the first secondary display — the Controls tab's 👁 View one-click path. |
| `logcat_viewer/pull.py` | `PullWorker` (QThread): pull an app's APK(s) off the device. |
| `logcat_viewer/mocklocation.py` | Mock GPS: pure `set_args`/`stop_args` command builders, `MockSetupWorker` (QThread — auto-install helper APK + `appops set android:mock_location allow`), and `MockLocationView` (MapLibre `QWebEngineView` + coordinate controls; drives the helper via `QProcess.startDetached`). Map created lazily on first show. |
| `logcat_viewer/dbinspect.py` | Database Inspector: pure `list_dbs_args`/`cat_db_args`/`edit_args` command builders (`run-as`, rooted `su` fallback) + `classify_listing`/`db_candidates` + SQL builders (`sql_literal`/`build_update_sql`, injection-safe); stdlib-`sqlite3` readers (`open_readonly` = `query_only`, `list_tables`, `read_table` w/ rowids, `run_query`, `apply_local_update`) on a **pulled snapshot** (db + `-wal`/`-shm`/`-journal` sidecars); workers `DbListWorker` (also probes on-device `sqlite3`), `DbOpenWorker`, `QueryWorker`, `EditWorker` (writes to the **live** DB via on-device `sqlite3` over stdin — never file-replacement), `DbExportWorker` (self-contained `.db` via sqlite backup); `SqlResultModel`, `CellDialog` (view/edit a cell), `DatabaseView` (schema tree → results table + paging + read-only SQL; cell copy/view/edit; right-click DB → export; CSV export). Follows the shared **App** picker. |
| `logcat_viewer/files.py` | File Explorer: pure adb command builders (`ls_args` `-lHA`, `cat_args`, `mkdir`/`rename`/`delete_args`; `run-as`/rooted-`su` variants) + `parse_ls_line`/`classify_listing` + `access_for` (app-private → run-as, else plain shell; Root-su toggle forces su) + path helpers; workers `DirListWorker` (run-as→su escalation, latest-wins seq), `PullWorker` (public `adb pull`, private `exec-out … cat` + recursion), `PushWorker` (public `adb push`, private `run-as … dd` over stdin + recursion), `FileOpWorker` (mkdir/rename/delete); `FileTable`/`IconGrid` (shared `_Dnd` mixin: drag-in push + drag-out staged-pull) + `Breadcrumb` + `FilesView` (Windows-Explorer look: command bar, back/forward + breadcrumb address bar + search, Quick-access nav pane, Details/Large-icons views, drawn folder/type-tinted file icons). Follows the shared **App** picker for private data. |
| `logcat_viewer/assets/` | `map.html` (MapLibre GL JS picker; JS↔Qt bridge via `document.title`) + `mocklocation.apk` (prebuilt helper). |
| `android-helper/` | Source + `build.sh` for the helper APK: a foreground `MockService` that pushes the coordinate to the OS via `LocationManager` gps/network/fused **test providers**. Package `com.logcatviewer.mocklocation`, driven over adb by `am start-foreground-service`. On stop it removes the providers **and reacquires a real fix** (`getCurrentLocation`, ignoring `isMock` results) so the device returns to its real location. |
| `logcat_viewer/appmgr.py` | App Management (App-Manager-style): pure command builders (`list_packages_args`, `dumpsys_args`, `launch`/`force_stop`/`clear`/`enable`/`disable`/`uninstall`/`grant`/`revoke`/`component`/`appops_set`/`app_info_args`) + parsers (`parse_pkg_list_line`, `build_app_list`, `parse_general`/`parse_permissions`/`parse_components`/`parse_appops`/`parse_signatures`, `parse_app_detail`) — components come from the resolver tables filtered to the package (adb-only limit: no-filter components don't appear); workers `AppListWorker` (`pm list -f -i -U`), `AppDetailWorker` (dumpsys + appops + APK/data/cache sizes, latest-wins seq), `AppActionWorker` (generic one-shot for every state-changing op), `ClearCacheWorker` (cache-only: `pm clear --cache-only` → `run-as`/`su` `rm` fallback chain), `BulkPermWorker` (Grant all / Revoke all across an app's runtime perms), `AppIconWorker` (real app icon via on-device `unzip -l`/`-p` of the APK — `pick_launcher_icon` grabs the densest raster `ic_launcher`; adaptive-only apps fall back to the drawn tile), reuses `pull.PullWorker` to extract APKs; `running_services_args` + `parse_running_services` (dumpsys `ServiceRecord` blocks — newer builds append ` c:<caller>` inside the braces) feed a live-services list; `AppManagerView` = searchable app list (real icons loaded lazily per visible row + bounded worker pool, All/User/System/Disabled filter) + header actions + **Info / Permissions / Components / App Ops / Signature / Running / Prefs / Crashes** sub-tabs (grant/revoke + Grant all/Revoke all for runtime perms, component enable/disable, appops set via right-click; Prefs = the embedded `PrefsView`, Crashes = the embedded `CrashView` — both follow the app selected in the list, and `notify_live_crash()` relays live-crash pings to the crash view + badges the sub-tab). Follows the shared **App** picker (selects that app). |
| `logcat_viewer/decompile.py` | Decompiler: **provisions jadx + a JRE on first use** (`system_jadx`/`system_java` → `cached_*` → `download_jadx`/`download_jre` into `~/Library/Application Support/AndroidLab`; existing tools preferred over downloading), `DecompileWorker` (pull APK[s] → run `jadx -d`, cancelable, only steers `JAVA_HOME`/`PATH` for a *downloaded* JRE — overriding them for a system jadx hangs it), and `SourceViewerWindow` (a top-level window: `QFileSystemModel` tree + read-only `CodeEditor` with a line-number gutter + a Java/XML `Highlighter`). Reached via right-click an app in the Apps tab → *Decompile*. |
| `logcat_viewer/monitor.py` | Performance Monitor: pure parsers (`parse_cpu_stat`/`cpu_percent`/`parse_meminfo`/`mem_used_kb`/`parse_loadavg`/`parse_battery`; per-app `parse_app_cpu`/`parse_app_meminfo`/`parse_gfxinfo` + `build_probe`) reading `/proc/stat`+`/proc/meminfo`+`/proc/loadavg`+`dumpsys battery` (and, when an app is picked, `dumpsys cpuinfo`/`meminfo`/`gfxinfo`) in one `adb shell` round-trip; `MonitorWorker` (QThread poller, visible-only, tracks gfx deltas for recent-jank%), `SparkGraph` (QPainter history graph, device + app series), `MonitorView` = CPU/RAM/Battery/UI-Rendering cards with per-app overlay following the shared **App** picker + a refresh-rate selector + a **Detect leaks** button. |
| `logcat_viewer/leakdetect.py` | Memory-leak detection (LeakCanary/Shark) over adb, **no app instrumentation**: `am dumpheap` a **debuggable** app → poll-until-stable → pull `.hprof` → run Shark's `analyze` (`shark.MainKt`). Provisions just the analyze-path jars (`provision_shark`/`download_shark`, pinned Maven set — neo4j/interactive deps omitted) + a JRE via `decompile.py`'s helpers, cached under app-support `tools/`. `LeakDetectWorker` (cancelable QThread), `leak_summary`, `LeakReportWindow` (report + Save / Open-folder). Driven from the Monitor tab's **Detect leaks** button. |
| `logcat_viewer/inspector.py` | Layout Inspector: pure `screencap_args`/`uidump_args` + `parse_bounds`/`build_ui_tree` (tolerates the trailing dump notice) /`node_at` (deepest-then-smallest hit-test); `InspectWorker` (screenshot + `uiautomator dump /dev/tty` in one pass); `InspectorView` = `_ShotCanvas` (scaled screenshot + selected-bounds overlay, click→select) ↔ hierarchy `QTreeWidget` + properties table, two-way selection. Works for any app (accessibility tree — no debuggable needed). |
| `logcat_viewer/crash.py` | Crashes (Crashlytics-style): pure `crash_buffer_args` (`logcat -b crash -d`) / `dropbox_print_args` + `split_crash_blocks` (per-PID blocks; keeps a prefix-free `plain` body for rendering) / `split_dropbox_print` + **grouping** (`crash_signature`/`group_crashes` → ×N badges) + **visualization** (`classify_trace_line` app/framework/cause/exception, `build_crash_html` — themed QTextBrowser HTML: kind/×N/RETRACED chips header, Caused-by chain links with the root cause marked, app frames highlighted, runs of >`FOLD_THRESHOLD` framework frames folded behind `fold:` anchors, `looks_obfuscated` hint banner) + a local **R8/ProGuard retracer** (`parse_mapping`/`retrace`, best-effort, no retrace binary; last mapping path persisted + auto-reloaded via `MappingLoadWorker`); `CrashScanWorker` (buffer + all `CRASH_TAGS` in one pass); `CrashView` = kind-filter chips + search + **This app** (follows the app selected in the Apps list) → grouped list ↔ rendered trace (anchor clicks toggle folds / jump to causes), Copy/Save, and `notify_live_crash()`. **Hosted as an Apps-tab sub-tab** (appmgr embeds it); ui.py pings it from the log stream (`_flag_live_crash`: E-priority `AndroidRuntime: FATAL EXCEPTION` / `ActivityManager: ANR in` lines) which badges **Apps ●** (outer tab) + **Crashes ●** (sub-tab) and auto-rescans (debounced 1.5 s; deferred to next show when hidden). |
| `logcat_viewer/prefs.py` | SharedPreferences editor: pure `ls_prefs_args`/`cat_pref_args`/`write_pref_args` (run-as, rooted-`su` variants) + `parse_prefs_xml`/`build_prefs_xml` (exact Android XML shape, string-sets read-only) /`validate_pref_value`; workers `PrefListWorker` (run-as→su escalation), `PrefLoadWorker`, `PrefSaveWorker` (writes via `dd` over stdin — same trick as files.py); `PrefsView` = file list ↔ typed key/value table with inline edit + revert-on-invalid, **Save to device** + **Force-stop app** (apps cache prefs in memory). **Hosted as an Apps-tab sub-tab** (appmgr embeds it); follows the app selected in the Apps list. |
| `logcat_viewer/controls.py` | Device Controls: pure `read_state_script()` (every toggle read in ONE `adb shell` round-trip behind `@@key@@` markers) + `parse_state`/`interpret_state`/`bucket_name`/`parse_app_locales` + per-control setter builders (`set_night`/`set_font_scale`/`set_density`/`set_animations`/`set_show_touches`/`set_pointer_location`/`set_layout_bounds`+`set_hwui_profile`+`set_overdraw`+`set_force_rtl` (each with the `_SYSPROPS_POKE` so they apply live) /`set_color_space` (daltonizer, −1=off) /`set_rotation` (−1=auto, else lock quadrant) /`set_brightness`+`set_auto_brightness`/`set_screen_timeout`/`set_wifi` (`cmd wifi`) /`set_mobile_data` (`svc data`) /`set_airplane` (`cmd connectivity`) /`set_bluetooth` (`cmd bluetooth_manager`) /`set_location` (`cmd location`) /`set_data_saver` (`cmd netpolicy`) /`set_battery_saver`/`set_overlay_display` (simulate secondary display) /`set_app_locale` (per-app language, Android 13+) /`set_show_anrs`/`set_finish_activities`/`set_stay_awake`/`set_battery_level`/`reset_battery`/`set_doze` (unplug-first) /`set_standby_bucket`); `StateWorker` (+ per-app bucket & locale when an app is picked) + `CmdWorker` (argv sequence, auto-refresh after); `ControlsView` = settings-style cards (Display / Connectivity / Power&Background / Debug overlays / Simulation / Behavior) of painter-drawn `Switch` rows + segmented pills (font scale, timeout, rotation, color space, secondary display, standby bucket — apply on click) + sliders (brightness applies on release; mock battery has Apply), heading state chips (battery/doze/airplane/saver/bucket); bucket + app-locale rows follow the **App** picker; a **👁 View** button by the secondary-display segments creates a 720p display when off and emits `view_secondary` → ui.py shows the mirror dock + `mirror.show_secondary()` (one-click flow). Shell-blocked on One UI (probed, deliberately absent): strict-mode flash, SurfaceFlinger refresh-rate overlay, SystemUI demo mode, NFC (no readable state). |
| `logcat_viewer/intents.py` | Intent tester (Toolbox): pure `build_am_args` (start `-W` / broadcast / startservice; action/data/mime/component + typed extras `--es/--ei/--el/--ef/--ez`); `AmWorker` (captures `am`'s output — it reports errors on stdout); `IntentView` = quick deep-link row (VIEW) + full composer + extras table + output log. |
| `logcat_viewer/stress.py` | Monkey runner (Toolbox): pure `monkey_args` (seeded, throttled, `--ignore-security-exceptions -v`) + `KILL_MONKEY` (device-side `pgrep -f` kill — a straggler keeps injecting events); `MonkeyWorker` (streams output, flags `// CRASH`/`// NOT RESPONDING`, always kills the on-device monkey in `finally`); `MonkeyView` follows the **App** picker. |
| `logcat_viewer/perfetto.py` | Perfetto capture (Toolbox): pure `perfetto_args` (category presets + duration, Android 9+) / `pull_trace_args`; `PerfettoWorker` (capture → pull → `~/Downloads/*.perfetto-trace`, cancelable); `PerfettoView` + an **Open ui.perfetto.dev** button. |
| `logcat_viewer/notifs.py` | Notification inspector (Toolbox): pure `parse_notifications` over `dumpsys notification --noredact` (`NotificationRecord` blocks → pkg/channel/title/text/when, deduped by key — the dump repeats records); `NotifWorker` + `NotifsView` table. |
| `logcat_viewer/bugreport.py` | Bugreport (Toolbox): `BugreportWorker` (`adb bugreport <zip>`, parses the `[ 55%]` progress lines, cancelable) + `BugreportView` (progress bar → saved dialog). |
| `logcat_viewer/toolbox.py` | `ToolboxView`: sub-tab host for Intents/Monkey/Perfetto/Notifications/Bugreport — fans out `set_serial`/`set_package`, re-emits `status`/`failed`/`saved` so ui.py wires one view. |
| `logcat_viewer/wireless.py` | Wireless adb: pure `pair_args`/`connect_args`/`tcpip_args`/`ip_route_args` + `parse_device_ip` (wlan `src`) + `looks_ok`; `WirelessWorker` (pair / connect / **switch**: tcpip 5555 → connect to the device's wlan IP); `WirelessDialog` (non-modal, `devices_changed` → main-window refresh). Toolbar **📶** button. |
| `logcat_viewer/logtools.py` | Log session tools (pure): `entry_line`/`export_text` (raw threadtime lines — exports re-parse cleanly), filter-preset persistence (`load_presets`/`save_presets`/`clean_preset` → JSON in app-support). Export/Open/Presets wiring lives in ui.py (**File** menu: Open Log File ⌘O / Export Filtered ⌘E / Export Entire; preset combo + ＋/− on the filter bar). |
| `logcat_viewer/ui.py` | `MainWindow`: shared device toolbar (+ **📶 Wi-Fi**) + **Logs / Location / Network HTTP / Databases / Files / Apps (with Prefs + Crashes sub-tabs) / Monitor / Inspector / Controls / Toolbox `QTabWidget`**, live filter bar (+ preset picker), table + detail pane, the mirror `QDockWidget`, File menu (open/export log), and all the wiring (`refresh_devices` fans `set_serial` to every view; `select_app` fans `set_package`; `closeEvent` calls every view's `shutdown()`). `AppPickerPanel` is the reusable left **click-to-pick app list** (filter + icon list) embedded in the **Logs** and **Monitor** tabs; all instances are registered in `self._app_panels`, populated by `reload_apps`, and drive the shared App picker via `_on_app_panel_picked` → `select_app` (`_sync_log_app_selection` keeps every panel + the combo in sync). Entry `__main__.py`. |

### Threading model (important)
- **Live logcat** runs via `QProcess` on the Qt event loop (`LogcatReader`) — no extra thread.
- **Every blocking device operation runs on a `QThread` worker** (`H264MirrorWorker`, `MirrorWorker`,
  `ScreenshotWorker`, `RecordWorker`, `PullWorker`, `MockSetupWorker`) that emits result signals. The
  UI thread never blocks on `subprocess`/`adb`. Match this pattern for any new device feature.
- One-shot fire-and-forget device input (taps, keyevents, mock `set`/`stop`) uses
  `QProcess.startDetached`.

### Device / adb access
- Resolve the binary once via `adb.find_adb()` (`$ADB` → `PATH` → common SDK paths). Pass the path +
  the selected serial (`device_combo.currentData()`) into workers. Always target `-s <serial>`.
- `apps._run(adb, serial, args, timeout)` is the shared synchronous adb helper for short queries.
- Prefer `adb exec-out` (binary-clean) over `adb shell` for binary payloads (screencap/screenrecord).

## Rules (hard constraints)

1. **Never block the UI thread** on adb/subprocess — spawn a `QThread` worker and signal back.
2. **Keep it dependency-light.** Hard deps are PyQt6 and PyQt6-WebEngine (the map); PyAV is optional
   with a graceful fallback. Don't add another dependency without a fallback or a clear reason.
3. **The device has ONE display encoder.** `screenrecord` (H.264 mirror **and** MP4 recording) can't
   run twice at once — the mirror auto-switches to the screencap poller while recording. **Always
   clean up on-device `screenrecord`** (a straggler makes the next session stall for seconds): the
   H.264 worker `pkill screenrecord` before starting and in a `finally` on exit. Same ethos for the
   **mock-location** foreground service: `MockLocationView.shutdown()` sends `stop` on app close so no
   orphaned mock outlives the app (switching device also stops the old one first). Same ethos for the
   **network intercept**: it snapshots the device's original `http_proxy` before wiring it and restores
   it on every exit path, **plus** a device-side watchdog (`proxy_watchdog_script`, a held-open
   `adb shell` that traps SIGHUP) that self-heals the proxy if the link drops without a clean teardown
   (unplug / reboot / adb-kill / crash) — a dangling proxy otherwise kills the device's internet.
4. **Clean up before relaunch.** `pkill -f logcat_viewer` orphans the GUI's `adb`/on-device children;
   kill stale processes when relaunching (see the `run-app` skill).
5. **Verify on a real device.** Smoke passing ≠ feature working — drive the actual flow over adb.
6. **Perf:** measure only *visible* rows for row-height/column-fit; keep the ring buffer bounded;
   don't add unconditional work to the per-line hot path.
7. **Stay decoupled.** This is a general adb tool. Keep filter examples, comments, and features
   app-agnostic — no hard-coding of any specific app's package or tags into the product.

## Conventions

- Match the dark theme: reuse `theme.py` palette constants and object-name selectors rather than
  inline styles (the small nav/toggle buttons use `objectName("toggle")`).
- Keep new modules small and single-purpose (one worker + its view helper per file, like `pull.py`).
- User feedback for long device ops: status-bar message + a **non-modal** `QMessageBox` (with an
  **Open Folder** button for saved files) — see `_on_pull_done` / `_on_mirror_captured` in `ui.py`.
