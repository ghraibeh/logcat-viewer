# CLAUDE.md

Guidance for Claude Code when working in this repo.

## What this is

**Logcat Viewer** — a standalone native-feeling **macOS desktop app** (Python + PyQt6) that streams
**live `adb logcat`**, filters it like Android Studio's Logcat, and bundles a set of device tools:
**app filter, install/pull APK, screen mirror (hardware H.264), screenshot, screen recording,
mock GPS location, network HTTP intercept, a SQLite database inspector, a device file explorer,
and an App-Manager-style app manager**.

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
| `logcat_viewer/mirror.py` | Screen mirror: `H264MirrorWorker` (screenrecord→h264→PyAV decode), `MirrorWorker` (screencap fallback), `ScreenshotWorker`, `RecordWorker`, and `MirrorView` (canvas + control bar, tap/swipe/keys, drop-to-install, capture buttons). |
| `logcat_viewer/pull.py` | `PullWorker` (QThread): pull an app's APK(s) off the device. |
| `logcat_viewer/mocklocation.py` | Mock GPS: pure `set_args`/`stop_args` command builders, `MockSetupWorker` (QThread — auto-install helper APK + `appops set android:mock_location allow`), and `MockLocationView` (MapLibre `QWebEngineView` + coordinate controls; drives the helper via `QProcess.startDetached`). Map created lazily on first show. |
| `logcat_viewer/dbinspect.py` | Database Inspector: pure `list_dbs_args`/`cat_db_args`/`edit_args` command builders (`run-as`, rooted `su` fallback) + `classify_listing`/`db_candidates` + SQL builders (`sql_literal`/`build_update_sql`, injection-safe); stdlib-`sqlite3` readers (`open_readonly` = `query_only`, `list_tables`, `read_table` w/ rowids, `run_query`, `apply_local_update`) on a **pulled snapshot** (db + `-wal`/`-shm`/`-journal` sidecars); workers `DbListWorker` (also probes on-device `sqlite3`), `DbOpenWorker`, `QueryWorker`, `EditWorker` (writes to the **live** DB via on-device `sqlite3` over stdin — never file-replacement), `DbExportWorker` (self-contained `.db` via sqlite backup); `SqlResultModel`, `CellDialog` (view/edit a cell), `DatabaseView` (schema tree → results table + paging + read-only SQL; cell copy/view/edit; right-click DB → export; CSV export). Follows the shared **App** picker. |
| `logcat_viewer/files.py` | File Explorer: pure adb command builders (`ls_args` `-lHA`, `cat_args`, `mkdir`/`rename`/`delete_args`; `run-as`/rooted-`su` variants) + `parse_ls_line`/`classify_listing` + `access_for` (app-private → run-as, else plain shell; Root-su toggle forces su) + path helpers; workers `DirListWorker` (run-as→su escalation, latest-wins seq), `PullWorker` (public `adb pull`, private `exec-out … cat` + recursion), `PushWorker` (public `adb push`, private `run-as … dd` over stdin + recursion), `FileOpWorker` (mkdir/rename/delete); `FileTable`/`IconGrid` (shared `_Dnd` mixin: drag-in push + drag-out staged-pull) + `Breadcrumb` + `FilesView` (Windows-Explorer look: command bar, back/forward + breadcrumb address bar + search, Quick-access nav pane, Details/Large-icons views, drawn folder/type-tinted file icons). Follows the shared **App** picker for private data. |
| `logcat_viewer/assets/` | `map.html` (MapLibre GL JS picker; JS↔Qt bridge via `document.title`) + `mocklocation.apk` (prebuilt helper). |
| `android-helper/` | Source + `build.sh` for the helper APK: a foreground `MockService` that pushes the coordinate to the OS via `LocationManager` gps/network/fused **test providers**. Package `com.logcatviewer.mocklocation`, driven over adb by `am start-foreground-service`. On stop it removes the providers **and reacquires a real fix** (`getCurrentLocation`, ignoring `isMock` results) so the device returns to its real location. |
| `logcat_viewer/appmgr.py` | App Management (App-Manager-style): pure command builders (`list_packages_args`, `dumpsys_args`, `launch`/`force_stop`/`clear`/`enable`/`disable`/`uninstall`/`grant`/`revoke`/`component`/`appops_set`/`app_info_args`) + parsers (`parse_pkg_list_line`, `build_app_list`, `parse_general`/`parse_permissions`/`parse_components`/`parse_appops`/`parse_signatures`, `parse_app_detail`) — components come from the resolver tables filtered to the package (adb-only limit: no-filter components don't appear); workers `AppListWorker` (`pm list -f -i -U`), `AppDetailWorker` (dumpsys + appops + APK/data/cache sizes, latest-wins seq), `AppActionWorker` (generic one-shot for every state-changing op), reuses `pull.PullWorker` to extract APKs; `AppManagerView` = searchable app list (letter-tile icons, All/User/System/Disabled filter) + header actions + **Info / Permissions / Components / App Ops / Signature** sub-tabs (grant/revoke, component enable/disable, appops set via right-click). Follows the shared **App** picker (selects that app). |
| `logcat_viewer/ui.py` | `MainWindow`: shared device toolbar + **Logs / Location / Network HTTP / Databases / Files / Apps `QTabWidget`**, live filter bar, table + detail pane, the mirror `QDockWidget`, and all the wiring. Entry `__main__.py`. |

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
   orphaned mock outlives the app (switching device also stops the old one first).
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
