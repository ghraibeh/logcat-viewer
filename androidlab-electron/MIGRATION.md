# AndroidLab: Python/PyQt6 → Electron migration notes

This document tracks the port of the Python app (`../logcat_viewer/`, ~18k LOC,
35 modules) to Electron + TypeScript + React, the dependency mapping, the
per-module mapping, and the feature-parity checklist.

## Approach

Incremental, verified, phase-by-phase. The Python app is barely coupled to
Python: its only third-party runtime deps are PyQt6 (UI), PyQt6-WebEngine (one
map), PyAV (optional H.264 mirror), and an external `mitmdump` binary (optional).
Everything else is stdlib orchestrating the external `adb` binary and parsing its
text output — which ports cleanly to Node/TypeScript.

## Dependency mapping (Python → Node)

| Python | Node / Electron | Notes |
|---|---|---|
| PyQt6 widgets/layouts | React + TypeScript + CSS | ✅ Phase 2 (shell + Logs) |
| Custom `QPainter` (badges, switches, spark graphs, tiles) | HTML/CSS; `<canvas>` only for spark graphs / mirror frame / inspector overlay | badges/switches/pills are CSS |
| `QWebEngineView` (MapLibre map) | renderer `<iframe>`/`<webview>` | Phase 3 (Location) |
| `QProcess` `LogcatReader` | `child_process.spawn` + byte-buffered batches → IPC | ✅ `main/services/logcat.ts` |
| `QThread` workers | `async` in main process → IPC | pattern established |
| `QProcess.startDetached` one-shots | `execFile` / detached `spawn` | Phase 3 |
| stdlib `sqlite3` | `better-sqlite3` | Phase 3 (Databases) |
| PyAV / ffmpeg (H.264 mirror) | bundled static ffmpeg → fragmented MP4 → `MediaSource` | Phase 3 (hardest item) |
| mitmproxy `mitmdump` + `mitm_addon.py` | Node MITM proxy + generated CA (`node-forge`), addon logic ported to JS | Phase 3 (hard item) |
| jadx / Shark / JRE provisioning | identical: download + `spawn('java', …)` | Phase 3, no Python involved |
| XML parse/build (prefs, uiautomator, notifs) | `fast-xml-parser` | Phase 3 |
| `adb` external binary | same binary, bundled via electron-builder `extraResources` | Phase 4 bundling |
| PyInstaller `.app` | **electron-builder** (dmg/zip) | scaffolded; Phase 4 |
| `tests/smoke.py` + live checks | `vitest` (pure) + node scripts driving adb | ✅ core tests; live in Phase 4 |

## Architecture mapping

| Python | Electron |
|---|---|
| `__main__.py` / `main.py` (QApplication) | `src/main/index.ts` (app lifecycle + window) |
| `theme.py` (`apply(app)`) | `src/renderer/styles/theme.css` + `about.css` |
| `resources.py` (`find_adb`, bundle paths) | `src/main/services/adb.ts` (`findAdb`, bundled path) |
| `adb.py` `LogcatReader` | `src/main/services/logcat.ts` |
| `apps.py` (queries, PID resolution) | `src/main/services/adb.ts` (`listApps`, `resolvePids`, `forceCrash`, clones) |
| `parser.py` | `src/core/parser.ts` |
| `filters.py` `FilterSpec` | `src/core/filters.ts` |
| `model.py` `LogTableModel` | `src/core/logStore.ts` (+ renderer external-store wrapper) |
| `colors.py` | `src/core/colors.ts` |
| `logtools.py` | `src/core/logtools.ts` + `src/main/services/presets.ts` + `logfile.ts` |
| `delegates.py` (badge/message painters) | `src/renderer/components/LogTable.tsx` (CSS badge + wrap/no-wrap cells) |
| `about.py` | `src/renderer/components/AboutDialog.tsx` |
| `ui.py` `MainWindow` | `src/renderer/App.tsx` + `state/useAppController.ts` + components |
| `prefs.py` (SharedPreferences editor) | `src/core/prefs.ts` + `src/main/services/prefs.ts` + `components/PrefsView.tsx` |
| `crash.py` (Crashes/ANR + R8 retrace) | `src/core/crash.ts` + `src/main/services/crash.ts` + `components/CrashView.tsx` |
| `appmgr.py` (App Manager) | `src/core/appmgr.ts` + `src/main/services/appmgr.ts` + `components/AppManagerView.tsx` |
| `pull.py` `PullWorker` (extract APK) | folded into `appmgr` service `extractApk()` (`pm path` → `adb pull` → ~/Downloads/<pkg>) |

## IPC contract

Single boundary in `src/main/ipc.ts` / `src/preload/index.ts`, exposed to the
renderer as the typed `window.androidlab` (`src/shared/api.ts`). `invoke/handle`
for queries; `webContents.send` event streams for the live logcat lines / state /
errors and native-menu actions. Context isolation + sandbox on; no `ipcRenderer`
or Node primitives reach the page.

## Feature-parity checklist

### Phase 2 — Logs tab + shell (COMPLETE)

Legend: ✅ implemented · 🧪 verified (unit / offline e2e) · ⏳ pending live device

| Feature | Status |
|---|---|
| adb discovery ($ADB → bundled → PATH → SDK fallbacks) | ✅ 🧪 |
| Device list + select (`adb devices -l` parse, prefer online) | ✅ ⏳(live) |
| Live logcat stream (spawn, threadtime, byte-buffer batching, partial tail) | ✅ ⏳(live) · pipeline 🧪 |
| threadtime parse → `LogEntry` (+ dividers/malformed handling) | ✅ 🧪 |
| Capped ring buffer + incremental filtered view + trim | ✅ 🧪 |
| Level filter (≥ priority) | ✅ 🧪 |
| Search (substring OR on `\|`, or regex) over tag+msg / raw | ✅ 🧪 |
| Tag / PID / Exclude advanced filters (+ regex, invalid-regex disable+mark) | ✅ 🧪 |
| App picker (combo + left panel list, clones marked) → PID-set filter | ✅ ⏳(live) |
| App PID re-resolve every 3 s (add-only) | ✅ ⏳(live) |
| Start / Stop / Pause (buffered) / Clear | ✅ ⏳(live) |
| Rate (/s), shown/total, dropped-backlog cap status | ✅ 🧪 |
| Level badge + per-tag color + per-level message color | ✅ 🧪 |
| Wrap ↔ single-line (grow-to-widest, horizontal scroll) | ✅ 🧪 |
| Font +/− (⌘+ / ⌘−) | ✅ 🧪 |
| Row selection (single/range/toggle) + detail pane + copy (⌘C / Edit▸Copy) | ✅ 🧪 |
| Right-click menu: Copy / Clear / Force-crash (app or row PID) | ✅ ⏳(live for crash) |
| Named filter presets (save/apply/delete, JSON in app-support) | ✅ 🧪 |
| Open log file (parse + skipped count) / Export filtered / Export entire | ✅ 🧪 |
| Install APK(s) (single / install-multiple, `-r -d`) | ✅ ⏳(live) |
| Native menu (File: Open ⌘O / Export ⌘E / Export all; About; ⌘K clear; ⌘F find) | ✅ 🧪 |
| About dialog (drawn `>_` logo, features, author) | ✅ 🧪 |
| Dark theme (palette, pills, inputs, scrollbars, tabs) | ✅ 🧪 |

**Verification:** `npm test` (17 core parity tests), `npm run typecheck` (strict,
clean), `npm run build` (clean), `npm run smoke` (boots the window, pushes
synthetic lines through the real logcat IPC path, asserts the virtualized table
renders the expected rows with zero renderer errors). Live-device flows are
pending a device on adb (none attached at time of writing).

### Phase 3 — device tools (IN PROGRESS)

**Monitor tab — COMPLETE** (`monitor.py` core). Reuses the shared app-picker;
establishes two reusable patterns: a **polling worker → IPC sample-event stream**
(`main/services/monitor.ts`) and a **canvas** spark graph + per-core bars.

| Feature | Status |
|---|---|
| One-round-trip probe (procfs + battery, +per-app dumpsys) | ✅ 🧪 |
| CPU% from jiffies delta; per-core meter | ✅ 🧪 |
| Memory used/total (MemAvailable + fallback) | ✅ 🧪 |
| Battery level/temp/charging | ✅ 🧪 |
| Per-app CPU / PSS / gfxinfo jank overlay | ✅ 🧪 |
| History spark-lines (device + app series) + refresh-rate selector | ✅ 🧪(e2e smoke) |
| Poll only while tab active; restart on device/app/interval change | ✅ ⏳(live) |
| **Detect leaks** button (LeakCanary/Shark) | ⏳ deferred to the leakdetect cluster |

**Inspector tab — COMPLETE** (`inspector.py`). Establishes the **binary-capture**
pattern (`exec-out screencap -p` → base64 over IPC → `<img>`, reused by
screenshot/mirror) and an interactive canvas overlay.

| Feature | Status |
|---|---|
| Capture: screenshot (PNG, validated) + `uiautomator dump` in one pass | ✅ ⏳(live) |
| uiautomator XML → node tree (tolerates trailing dump noise) | ✅ 🧪 |
| Click screenshot → deepest-then-smallest node hit-test → select in tree | ✅ 🧪 |
| Hierarchy tree (expand to depth 3) ↔ selection ↔ bounds overlay | ✅ 🧪(e2e mount) |
| Properties table (non-empty/non-false first, then false) | ✅ 🧪 |

Verified: `npm test` (37 tests: 17 core + 12 monitor + 8 inspector), typecheck,
build, and the smoke now also switches to Monitor (asserts CPU readout + spark
canvases) and Inspector (asserts the view + canvas mount), with zero renderer
console errors.

**Controls tab — COMPLETE** (`controls.py`). Establishes the **read-all-state
(one round-trip) → apply-setter-argvs → re-read** pattern (reused by Prefs).
CSS toggle switches, segmented pills, sliders, and live heading chips.

| Feature | Status |
|---|---|
| One-shot state read (26 settings behind `@@key@@` markers) → typed state | ✅ 🧪 |
| ~30 setters as adb argv sequences (+ SYSPROPS poke for live debug.*) | ✅ 🧪 |
| Display / Connectivity / Power / Debug / Simulation / Behavior cards | ✅ 🧪(e2e mount, 20 switches) |
| Per-app standby bucket + app locale (follow the App picker) | ✅ ⏳(live) |
| Mock battery / Doze / airplane / saver heading chips | ✅ 🧪 |
| 👁 secondary-display view hand-off to the mirror | ⏳ deferred to the mirror cluster |

**Databases tab — COMPLETE** (`dbinspect.py`; implemented by a subagent, then
integrated + smoke-verified). Reads pulled DB snapshots with **sql.js** (wasm —
no native `better-sqlite3`/electron-rebuild), edits the live DB via the
on-device `sqlite3` binary (never file-replacement). Follows the App picker.

| Feature | Status |
|---|---|
| List an app's DBs (run-as → rooted-su fallback; probe on-device sqlite3) | ✅ ⏳(live: needs a debuggable app) |
| Pull DB + `-wal`/`-shm`/`-journal` sidecars; open read-only (sql.js) | ✅ 🧪 |
| Schema tree (tables/views + counts) → results table + LIMIT/OFFSET paging | ✅ 🧪(e2e mount) |
| Read-only SQL box (latest-wins), row cap + truncation flag | ✅ 🧪 |
| Cell copy / view / edit (live write via on-device sqlite3) + Set NULL | ✅ ⏳(live) |
| Export self-contained `.db` (save dialog) + CSV export | ✅ ⏳(live) |
| Injection-safe SQL builders (`sqlLiteral`/`buildUpdateSql`) | ✅ 🧪 (19 db tests) |

Known difference (documented): sql.js opens a single in-memory image of the
*main* DB file, so **un-checkpointed WAL frames aren't visible** (Python's stdlib
sqlite3 folds the `-wal` in). Checkpointed data always is; sidecars are still
pulled. Live paths pending a debuggable app (the emulator has none): run-as pull,
on-device sqlite3 edits, and the export dialogs.

**Files tab — COMPLETE** (`files.py`; subagent-implemented, integrated +
smoke-verified; live `/sdcard` listing confirmed on the emulator). Windows-
Explorer UI (command bar, back/forward + breadcrumb address bar + search,
Quick-access nav, Details/Large-icons views, drawn folder/type icons).

| Feature | Status |
|---|---|
| `ls -lHA` listing + parse (dirs/files/symlinks/device-nodes/dotfiles/spaces) | ✅ 🧪 + live |
| run-as → rooted-su access escalation for app-private dirs | ✅ ⏳(live: needs debuggable app) |
| Pull (public `adb pull`; private `exec-out cat` + dir recursion) — via dialog | ✅ ⏳(live) |
| Push (public `adb push`; private `run-as dd` over stdin + recursion) — via dialog | ✅ ⏳(live) |
| mkdir / rename / delete (public + private) | ✅ ⏳(live) |
| Breadcrumb + Quick-access (App-data follows the picker) + Details/Icons | ✅ 🧪(e2e mount) |
| Finder drag-in via `webUtils.getPathForFile` (best-effort); drag-out omitted | ✅/⏳ |

Verified: `npm run typecheck` clean, `npm test` 88 passed (24 files tests),
offline smoke PASS (Files command bar mounts), live `ls -lHA /sdcard`.

**Toolbox tab — COMPLETE** (`intents.py`/`stress.py`/`perfetto.py`/`notifs.py`/
`bugreport.py`/`toolbox.py`; subagent-implemented, integrated + smoke-verified;
live `dumpsys notification` parse confirmed). Sub-tabbed view; streaming tools
(Monkey/Perfetto/Bugreport) use the logcat/monitor event-stream IPC pattern.

| Feature | Status |
|---|---|
| Intents: deep-link (VIEW) + composer w/ typed extras (`--es/--ei/--el/--ef/--ez`) | ✅ 🧪 ⏳(live launch) |
| Monkey: seeded/throttled run, streamed output, crash/ANR flags, **always kills** device monkey | ✅ 🧪 ⏳(live) |
| Perfetto: preset+duration capture → pull to ~/Downloads, cancelable | ✅ ⏳(live) |
| Notifications: `dumpsys notification --noredact` parse + dedupe → table | ✅ 🧪 + live |
| Bugreport: `adb bugreport` zip with `[ NN%]` progress, cancelable | ✅ ⏳(live) |
| Guaranteed device-side cleanup (monkey/perfetto/bugreport) on stop + shutdown | ✅ |

Verified: typecheck clean, `npm test` 102 passed (7 files; 14 toolbox), offline
smoke PASS (all 7 tabs mount), live notification dump.

**Apps tab — COMPLETE** (`appmgr.py` + `prefs.py` + `crash.py`). A full-width
view with its **own** searchable app list (real APK icons, All/User/System/
Disabled filter), header actions, and eight sub-tabs — **Info / Permissions /
Components / App Ops / Signature / Running / Prefs / Crashes**. Two-way synced
with the shared App picker (clicking an app drives `c.selectApp`; an external
pick selects here). Establishes the **live-crash flag** pattern: the controller's
per-line hot path bumps `liveCrashSeq` on a `FATAL EXCEPTION` / `ANR in` entry,
which badges the outer **Apps ●** tab, the **Crashes ●** sub-tab, and triggers a
debounced (1.5 s) crash rescan (deferred to next show when the sub-tab is hidden).

| Feature | Status |
|---|---|
| App list (`pm list -f -i -U` + system/disabled sets, sorted, filter) | ✅ 🧪 + live |
| Real APK icons (lazy per-visible-row, bounded 3-wide pool, drawn-tile fallback) | ✅ ⏳(live: emulator has no `unzip` icon path exercised) |
| Detail: Info / Permissions / Components / App Ops / Signature / Running | ✅ 🧪 + live (com.android.settings: 196 perms, 237 acts) |
| Actions: Launch / Force-stop / Clear cache / Clear data / Enable-Disable / Uninstall / App Info | ✅ ⏳(live: read-only verify only — no destructive ops run) |
| Extract APK (`pm path` → `adb pull` → ~/Downloads/<pkg>, Open Folder) | ✅ ⏳(live) |
| Grant/Revoke + Grant-all/Revoke-all runtime perms; component enable/disable; appops set (right-click) | ✅ 🧪 ⏳(live) |
| **Decompile to Java (jadx)…** right-click item | ⏳ **stubbed** — shows "Decompiler is ported in a later cluster"; wired to the Decompile cluster later (see `// TODO(decompile-cluster)` in AppManagerView) |
| **Prefs** sub-tab: list ↔ typed key/value edit + revert-on-invalid, Save (dd), Force-stop | ✅ 🧪 ⏳(live: needs a debuggable app — emulator has none) |
| **Crashes** sub-tab: kind chips + search + This-app → grouped ×N list ↔ HTML trace | ✅ 🧪 + live (scan runs; 0 records on a clean emulator) |
| Crash HTML: fold framework runs, Caused-by links, app-frame highlight, obf banner | ✅ 🧪 |
| R8/ProGuard retrace (parse mapping + retrace, last-path persisted) | ✅ 🧪 |
| Copy / Save crash record (save dialog + Open Folder) | ✅ ⏳(live) |
| Live-crash → Apps ● + Crashes ● badges + debounced rescan | ✅ 🧪(smoke mounts) |

Verified: `npm run typecheck` clean, `npm test` **138 passed** (10 files; +11
prefs, +10 crash, +15 appmgr), `npm run build` clean, offline smoke PASS
(`apps=1 prefs=1 crash=1 errors=0`), and a read-only live parse against the
attached emulator (app list + one app's full detail + crash scan). Only stub:
the right-click Decompile action (the Decompile cluster is not yet ported).
Pending live: the Prefs run-as/su read + write and destructive app actions need a
debuggable app / a device with `unzip` + `sqlite3` (the emulator has neither a
debuggable app nor a user app).

**Still pending** (each shows a "migrated in Phase 3" placeholder): Location
(mock GPS + map), Network HTTP (intercept), memory-leak detection, plus screen
mirror, Wi-Fi adb, and Pull APK.

### Phase 4 — QA, packaging, docs (PENDING)

Bundle `adb` into the packaged app (electron-builder `extraResources`), port the
live-device check scripts, produce the dmg/zip, and finalize the parity report.
