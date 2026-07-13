# AndroidLab (Electron)

A native-feeling **Electron** reimplementation of AndroidLab — the Python/PyQt6
desktop app that streams live `adb logcat`, filters it like Android Studio's
Logcat, and bundles a full device toolkit. This is a ground-up port to
**Electron + TypeScript + React**, with **no Python runtime** required.

Its only external runtime dependency is the `adb` binary (found on `$PATH` /
`$ADB` / common SDK locations, or bundled into the packaged app).

## Requirements

- Node.js ≥ 20 (built and tested on Node 24)
- `adb` available on `PATH` (or set `$ADB`) for device features

## Run & build

```bash
npm install          # installs deps + downloads the Electron binary
npm run dev          # launch with hot-reload (electron-vite dev)
npm run build        # type-check-clean production bundles into out/
npm run start        # run the built app (electron-vite preview)
npm test             # core-pipeline parity unit tests (vitest)
npm run typecheck    # strict tsc over main + renderer
npm run dist         # package a macOS .dmg / .zip (electron-builder)
```

> If `npm run start` reports *"Electron failed to install correctly"*, the
> Electron binary download was interrupted during `npm install`. Re-run it with
> `node node_modules/electron/install.js`.

## Architecture

```
src/
  core/        Pure, DOM-free, unit-tested logic shared by both processes:
               parser, filters, colors, logtools, priorities, logStore (model)
  shared/      IPC channel names + cross-boundary types + the preload API type
  main/        Privileged process: app lifecycle, window, native menu, and the
               services that shell out to adb / touch the filesystem / show
               dialogs. Every blocking device op lives here (never the renderer).
    services/  adb, logcat (stream), apk, logfile, presets
    ipc.ts     the single main↔renderer boundary (invoke/handle + event streams)
  preload/     contextBridge: exposes a typed, minimal `window.androidlab` API;
               no ipcRenderer or Node primitives leak into the page
  renderer/    React UI: the tab shell, virtualized log table, filter bar,
               app-picker, detail pane, About/dialogs, and the app controller
```

**Data flow (mirrors the Python app):** `adb logcat` (spawned in main) →
byte-buffered line batches → IPC event → renderer parses (`parseLine`) →
`pending` buffer → 100 ms flush → `LogStore` (capped ring buffer + incremental
filtered view) → virtualized `<LogTable>`.

### Security

Context isolation **on**, sandbox **on**, `nodeIntegration` **off**, a strict
CSP, an explicit `setWindowOpenHandler`/`will-navigate` block, and a preload
that exposes only a small typed API surface. All subprocess and filesystem
access is confined to the main process.

## Migration status

See [`MIGRATION.md`](./MIGRATION.md) for the dependency mapping, per-module
mapping, and the feature-parity checklist. **Phase 2 (the Logs tab — live
streaming, filtering, presets, export/open, install) is complete.** The
remaining device-tool tabs are being migrated in Phase 3.
