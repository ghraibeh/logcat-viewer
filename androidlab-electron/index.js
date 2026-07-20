"use strict";
const node_path = require("node:path");
const electron = require("electron");
const node_os = require("node:os");
const node_child_process = require("node:child_process");
const node_fs = require("node:fs");
const net = require("node:net");
const node_http = require("node:http");
const WebSocket = require("ws");
const node_https = require("node:https");
const fastXmlParser = require("fast-xml-parser");
const node_module = require("node:module");
const initSqlJs = require("sql.js");
const promises = require("node:fs/promises");
const tls = require("node:tls");
const forge = require("node-forge");
const node_zlib = require("node:zlib");
const IPC = {
  // adb queries (invoke/handle)
  adbFind: "adb:find",
  adbListDevices: "adb:list-devices",
  adbListApps: "adb:list-apps",
  adbResolvePids: "adb:resolve-pids",
  adbForceCrash: "adb:force-crash",
  adbDeviceInfo: "adb:device-info",
  // hotplug: main pushes the fresh device list on USB attach/detach (no refresh)
  devicesChanged: "adb:devices-changed",
  // logcat stream control (invoke/handle)
  logcatStart: "logcat:start",
  logcatStop: "logcat:stop",
  logcatRunning: "logcat:running",
  // logcat stream events (main -> renderer)
  logcatLines: "logcat:lines",
  logcatState: "logcat:state",
  logcatError: "logcat:error",
  // interactive adb shell over a PTY (control invoke/handle + event streams)
  shellStart: "shell:start",
  shellWrite: "shell:write",
  shellResize: "shell:resize",
  shellStop: "shell:stop",
  shellRunning: "shell:running",
  shellData: "shell:data",
  shellState: "shell:state",
  // performance monitor (invoke/handle + events)
  monitorStart: "monitor:start",
  monitorStop: "monitor:stop",
  monitorSample: "monitor:sample",
  monitorFailed: "monitor:failed",
  // memory-leak detection (control invoke/handle + event streams)
  leakStart: "leak:start",
  leakCancel: "leak:cancel",
  leakProgress: "leak:progress",
  leakDone: "leak:done",
  leakSaveReport: "leak:save-report",
  // layout inspector (invoke/handle)
  inspectCapture: "inspect:capture",
  // screen mirror (invoke/handle + event streams)
  mirrorStartH264: "mirror:start-h264",
  mirrorStartScrcpy: "mirror:start-scrcpy",
  mirrorStartPoller: "mirror:start-poller",
  mirrorStop: "mirror:stop",
  mirrorInput: "mirror:input",
  mirrorControl: "mirror:control",
  mirrorScreenshot: "mirror:screenshot",
  mirrorRecordStart: "mirror:record-start",
  mirrorRecordStop: "mirror:record-stop",
  mirrorListDisplays: "mirror:list-displays",
  mirrorIsEmulator: "mirror:is-emulator",
  mirrorScrcpyAvailable: "mirror:scrcpy-available",
  mirrorLaunchScrcpy: "mirror:launch-scrcpy",
  // detached mirror window (Android Studio-style pop-out) — invoke/handle
  mirrorPopoutOpen: "mirror:popout-open",
  // main-window renderer -> main: open the window
  mirrorPopoutClose: "mirror:popout-close",
  // -> main: close the window (arg: redock?)
  mirrorPopoutUpdate: "mirror:popout-update",
  // -> main: push a new device to the window
  mirrorPopoutInfo: "mirror:popout-info",
  // popout renderer -> main: which device to mirror
  mirrorPopoutFullscreen: "mirror:popout-fullscreen",
  // popout renderer -> main: toggle OS-window fullscreen
  // mirror events (main -> renderer)
  mirrorFrame: "mirror:frame",
  mirrorH264: "mirror:h264",
  mirrorControlReady: "mirror:control-ready",
  mirrorFailed: "mirror:failed",
  mirrorRecordDone: "mirror:record-done",
  mirrorPopoutInfoEvent: "mirror:popout-info-event",
  // main -> popout: device changed
  mirrorPopoutClosed: "mirror:popout-closed",
  // main -> main window: popout closed, re-dock
  mirrorPopoutFullscreenEvent: "mirror:popout-fullscreen-event",
  // main -> popout: OS-window fullscreen changed
  // device controls (invoke/handle)
  controlsRead: "controls:read",
  controlsApply: "controls:apply",
  // wireless adb / iOS Wi-Fi connections (invoke/handle)
  wirelessEnable: "wireless:enable",
  wirelessIosGet: "wireless:ios-get",
  wirelessIosSet: "wireless:ios-set",
  // app settings (invoke/handle)
  settingsGet: "settings:get",
  settingsSet: "settings:set",
  // mock GPS location (invoke/handle)
  mocklocSetup: "mockloc:setup",
  mocklocSet: "mockloc:set",
  mocklocStop: "mockloc:stop",
  // database inspector (invoke/handle)
  dbList: "db:list",
  dbOpen: "db:open",
  dbReadTable: "db:read-table",
  dbQuery: "db:query",
  dbEdit: "db:edit",
  dbExport: "db:export",
  dbExportCsv: "db:export-csv",
  // file explorer (invoke/handle)
  filesList: "files:list",
  filesPull: "files:pull",
  filesPush: "files:push",
  filesMkdir: "files:mkdir",
  filesRename: "files:rename",
  filesDelete: "files:delete",
  filesOpen: "files:open",
  filesChoosePullDir: "files:choose-pull-dir",
  filesChoosePush: "files:choose-push",
  // apk install (invoke/handle)
  apkInstall: "apk:install",
  // log file open/export (invoke/handle)
  logfileOpen: "logfile:open",
  logfileExport: "logfile:export",
  // filter presets (invoke/handle)
  presetsLoad: "presets:load",
  presetsSave: "presets:save",
  // toolbox: intents + notifications (invoke/handle)
  toolboxRunIntent: "toolbox:run-intent",
  toolboxListNotifs: "toolbox:list-notifs",
  // toolbox: monkey (control invoke/handle + event streams)
  toolboxMonkeyStart: "toolbox:monkey-start",
  toolboxMonkeyStop: "toolbox:monkey-stop",
  toolboxMonkeyLine: "toolbox:monkey-line",
  toolboxMonkeyDone: "toolbox:monkey-done",
  // toolbox: perfetto (control invoke/handle + event streams)
  toolboxPerfettoStart: "toolbox:perfetto-start",
  toolboxPerfettoCancel: "toolbox:perfetto-cancel",
  toolboxPerfettoProgress: "toolbox:perfetto-progress",
  toolboxPerfettoDone: "toolbox:perfetto-done",
  // toolbox: bugreport (control invoke/handle + event streams)
  toolboxBugreportStart: "toolbox:bugreport-start",
  toolboxBugreportCancel: "toolbox:bugreport-cancel",
  toolboxBugreportProgress: "toolbox:bugreport-progress",
  toolboxBugreportDone: "toolbox:bugreport-done",
  // SharedPreferences editor (Apps ▸ Prefs sub-tab)
  prefsList: "prefs:list",
  prefsLoad: "prefs:load",
  prefsSave: "prefs:save",
  prefsForceStop: "prefs:force-stop",
  // crash & ANR viewer (Apps ▸ Crashes sub-tab)
  crashScan: "crash:scan",
  crashRetrace: "crash:retrace",
  crashLoadMapping: "crash:load-mapping",
  crashChooseMapping: "crash:choose-mapping",
  crashLastMapping: "crash:last-mapping",
  crashSave: "crash:save",
  // app manager (Apps tab)
  appmgrList: "appmgr:list",
  appmgrDetail: "appmgr:detail",
  appmgrAction: "appmgr:action",
  appmgrClearCache: "appmgr:clear-cache",
  appmgrBulkPerms: "appmgr:bulk-perms",
  appmgrIcon: "appmgr:icon",
  appmgrExtractApk: "appmgr:extract-apk",
  // iOS Apps tab (go-ios backend)
  iosDeviceInfo: "ios:device-info",
  iosDeviceIp: "ios:device-ip",
  iosDeviceImage: "ios:device-image",
  iosListApps: "ios:list-apps",
  iosAppIcon: "ios:app-icon",
  iosChooseIpa: "ios:choose-ipa",
  iosInstall: "ios:install",
  iosUninstall: "ios:uninstall",
  // iOS developer tier: userspace tunnel + process control
  iosTunnelStatus: "ios:tunnel-status",
  iosTunnelStart: "ios:tunnel-start",
  iosTunnelStop: "ios:tunnel-stop",
  iosProcesses: "ios:processes",
  iosLaunch: "ios:launch",
  iosKill: "ios:kill",
  // iOS screen mirror (macOS native AVFoundation/VideoToolbox H.264 helper)
  iosMirrorStart: "ios-mirror:start",
  iosMirrorStop: "ios-mirror:stop",
  iosMirrorSaveFrame: "ios-mirror:save-frame",
  // save a canvas PNG to ~/Downloads
  iosMirrorSetMuted: "ios-mirror:set-muted",
  // mute/unmute the device audio played on this Mac
  iosMirrorGetMuted: "ios-mirror:get-muted",
  // read the mute preference (survives remounts)
  iosMirrorH264: "ios-mirror:h264",
  // event: raw Annex-B H.264 bytes (main -> renderer)
  iosMirrorState: "ios-mirror:state",
  // event: status message
  iosMirrorFailed: "ios-mirror:failed",
  // event: feed could not produce frames
  // iOS touch/keyboard forwarding (WebDriverAgent/DeviceKit via go-ios)
  iosInputGetConfig: "iosinput:get-config",
  // read persisted signing config
  iosInputSetConfig: "iosinput:set-config",
  // save signing config (paths + ids, no key material)
  iosInputChooseKey: "iosinput:choose-key",
  // file picker for the ASC .p8 private key
  iosInputProvision: "iosinput:provision",
  // sign + install the agent (long-running)
  iosInputCancel: "iosinput:cancel",
  // cancel a running provision
  iosInputStatus: "iosinput:status",
  // is the agent installed + reachable?
  iosInputSize: "iosinput:size",
  // device points (for canvas -> device mapping)
  iosInputTap: "iosinput:tap",
  iosInputSwipe: "iosinput:swipe",
  iosInputGesture: "iosinput:gesture",
  // full captured finger path (live-ish drag)
  iosInputDrag: "iosinput:drag",
  // streamed drag segments during the drag (start/move/end)
  iosInputType: "iosinput:type",
  iosInputKey: "iosinput:key",
  // one physical keystroke forwarded live (char / special / combo)
  iosInputButton: "iosinput:button",
  // iosinput events (main -> renderer)
  iosInputProgress: "iosinput:progress",
  // provisioning progress line
  iosInputDone: "iosinput:done",
  // provisioning finished (ok + message)
  // network HTTP intercept (control invoke/handle + event streams)
  interceptStart: "intercept:start",
  interceptStop: "intercept:stop",
  interceptSetDecrypt: "intercept:set-decrypt",
  interceptInstallCert: "intercept:install-cert",
  interceptDetail: "intercept:detail",
  interceptSaveBody: "intercept:save-body",
  interceptDownloadFlow: "intercept:download-flow",
  // intercept events (main -> renderer)
  interceptFlows: "intercept:flows",
  interceptStarted: "intercept:started",
  interceptStatus: "intercept:status",
  interceptFailed: "intercept:failed",
  // system helpers
  systemOpenPath: "system:open-path",
  // native menu -> renderer
  menuAction: "menu:action"
};
const iconPath$1 = node_path.join(electron.app.getAppPath(), "build", "icon.png");
class MirrorWindowManager {
  /** @param notifyRedock called when the popout closes and the mirror should
   *  return to the in-app dock. */
  constructor(notifyRedock) {
    this.notifyRedock = notifyRedock;
  }
  win = null;
  info = { serial: null, platform: "android" };
  /** Set when the main window initiates a full close so the `closed` handler
   *  does NOT ask the main window to re-dock. */
  suppressRedock = false;
  isOpen() {
    return !!this.win && !this.win.isDestroyed();
  }
  getInfo() {
    return this.info;
  }
  /** Open the popout for `info` (or focus + retarget an already-open one). */
  open(info) {
    this.info = info;
    if (this.isOpen()) {
      this.pushInfo();
      this.win.focus();
      return;
    }
    const win = new electron.BrowserWindow({
      width: 420,
      height: 860,
      minWidth: 300,
      minHeight: 480,
      show: false,
      backgroundColor: "#16171c",
      title: "Screen Mirror — MobileLabKit",
      icon: iconPath$1,
      titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
      webPreferences: {
        preload: node_path.join(__dirname, "../preload/index.js"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false
      }
    });
    this.win = win;
    win.on("ready-to-show", () => win.show());
    win.webContents.on("did-finish-load", () => {
      void win.webContents.setVisualZoomLevelLimits(1, 1);
      win.webContents.setZoomFactor(1);
    });
    win.on("enter-full-screen", () => this.pushFullscreen(true));
    win.on("leave-full-screen", () => this.pushFullscreen(false));
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (e) => e.preventDefault());
    const devUrl = process.env["ELECTRON_RENDERER_URL"];
    if (devUrl) void win.loadURL(`${devUrl}#mirror`);
    else void win.loadFile(node_path.join(__dirname, "../renderer/index.html"), { hash: "mirror" });
    win.on("closed", () => {
      this.win = null;
      const suppressed = this.suppressRedock;
      this.suppressRedock = false;
      if (!suppressed) this.notifyRedock();
    });
  }
  /** Retarget an open popout at a new device (main window switched device). */
  update(info) {
    this.info = info;
    this.pushInfo();
  }
  pushInfo() {
    if (this.isOpen()) this.win.webContents.send(IPC.mirrorPopoutInfoEvent, this.info);
  }
  pushFullscreen(fullscreen) {
    if (this.isOpen()) this.win.webContents.send(IPC.mirrorPopoutFullscreenEvent, fullscreen);
  }
  /** Toggle the popout OS window between fullscreen and windowed. */
  toggleFullScreen() {
    if (!this.isOpen()) return;
    this.win.setFullScreen(!this.win.isFullScreen());
  }
  /** Close the window. `redock` re-attaches the in-app dock; `false` is a full
   *  close initiated from the main window (no re-dock). */
  close(redock) {
    if (!this.isOpen()) return;
    this.suppressRedock = !redock;
    this.win.close();
  }
  /** Tear down without re-docking (app/main-window shutting down). */
  destroy() {
    this.suppressRedock = true;
    if (this.isOpen()) this.win.destroy();
    this.win = null;
  }
}
const FALLBACK_ADB = [
  node_path.join(node_os.homedir(), "Android/sdk/platform-tools/adb"),
  node_path.join(node_os.homedir(), "Library/Android/sdk/platform-tools/adb"),
  "/opt/homebrew/bin/adb",
  "/usr/local/bin/adb"
];
function whichAdb() {
  const paths = (process.env.PATH ?? "").split(node_path.delimiter);
  for (const dir of paths) {
    if (!dir) continue;
    const cand = node_path.join(dir, "adb");
    if (node_fs.existsSync(cand)) return cand;
  }
  return null;
}
function bundledAdb() {
  if (!electron.app.isPackaged) return null;
  const cand = node_path.join(process.resourcesPath, "platform-tools", "adb");
  return node_fs.existsSync(cand) ? cand : null;
}
let cachedAdb;
function findAdb() {
  if (cachedAdb !== void 0) return cachedAdb;
  const env = process.env.ADB;
  if (env && node_fs.existsSync(env)) return cachedAdb = env;
  const bundled = bundledAdb();
  if (bundled) return cachedAdb = bundled;
  const which = whichAdb();
  if (which) return cachedAdb = which;
  for (const cand of FALLBACK_ADB) {
    if (node_fs.existsSync(cand)) return cachedAdb = cand;
  }
  return cachedAdb = null;
}
function run$3(adb, serial, args, timeoutMs = 8e3) {
  const cmd = serial ? ["-s", serial, ...args] : args;
  return new Promise((resolve) => {
    node_child_process.execFile(
      adb,
      cmd,
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => {
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          code: err && typeof err.code === "number" ? err.code : err ? 1 : 0
        });
      }
    );
  });
}
async function sh$1(adb, serial, args, timeoutMs = 8e3) {
  const r = await run$3(adb, serial, args, timeoutMs);
  return r.stdout;
}
function runBinary(adb, args, timeoutMs = 2e4) {
  return new Promise((resolve) => {
    node_child_process.execFile(
      adb,
      args,
      { timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, encoding: "buffer" },
      (_err, stdout, stderr) => {
        resolve({
          stdout: stdout ?? Buffer.alloc(0),
          stderr: stderr ? stderr.toString("utf8") : ""
        });
      }
    );
  });
}
function deviceLabel$1(serial, description, online) {
  const extra = description ? ` — ${description}` : "";
  const state = online ? "" : "";
  return `${serial}${extra}${state}`;
}
async function listDevices$1(adb) {
  const out = await sh$1(adb, null, ["devices", "-l"]);
  const devices = [];
  const lines = out.split("\n").slice(1);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("*")) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const serial = parts[0];
    const state = parts[1];
    const descBits = [];
    for (const p of parts.slice(2)) {
      if (p.startsWith("model:")) descBits.unshift(p.split(":", 2)[1].replace(/_/g, " "));
      else if (p.startsWith("device:")) descBits.push(p.split(":", 2)[1]);
    }
    const online = state === "device";
    const description = descBits.join(" ");
    const stateSuffix = online ? "" : ` [${state}]`;
    devices.push({
      serial,
      state,
      description,
      online,
      label: deviceLabel$1(serial, description, online) + stateSuffix,
      platform: "android",
      // Wireless-adb devices connect by ip:port serial; USB serials have no colon.
      transports: [serial.includes(":") ? "wifi" : "usb"]
    });
  }
  return devices;
}
async function listPackages(adb, serial) {
  const out = await sh$1(adb, serial, ["shell", "pm", "list", "packages"]);
  return out.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("package:")).map((l) => l.slice("package:".length));
}
async function runningProcesses(adb, serial) {
  let out = await sh$1(adb, serial, ["shell", "ps", "-A", "-o", "PID,NAME"]);
  const procs = [];
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    const idx = trimmed.search(/\s/);
    if (idx <= 0) continue;
    const pidStr = trimmed.slice(0, idx);
    const name = trimmed.slice(idx).trim();
    if (/^\d+$/.test(pidStr) && name) procs.push([parseInt(pidStr, 10), name]);
  }
  if (procs.length === 0) {
    out = await sh$1(adb, serial, ["shell", "ps", "-A"]);
    for (const line of out.split("\n")) {
      const cols = line.split(/\s+/).filter(Boolean);
      if (cols.length >= 2 && /^\d+$/.test(cols[1])) {
        procs.push([parseInt(cols[1], 10), cols[cols.length - 1]]);
      }
    }
  }
  return procs;
}
function baseName$1(name) {
  return name.split(":", 1)[0];
}
const KNOWN_HOSTS = ["com.glite.poc", "com.gbag.poc", "top.niunaijun.blackboxa"];
async function listClones(adb, serial) {
  const clones = {};
  const out = await sh$1(adb, serial, ["shell", "ls -d /data/data/*/blackbox/data/app/*/ 2>/dev/null"]);
  for (const line of out.split("\n")) {
    const parts = line.trim().replace(/\/+$/, "").split("/");
    if (parts.length >= 8 && parts[1] === "data" && parts[2] === "data" && parts.includes("blackbox")) {
      (clones[parts[3]] ??= []).push(parts[parts.length - 1]);
    }
  }
  if (Object.keys(clones).length > 0) return clones;
  const candidates = new Set(KNOWN_HOSTS);
  for (const [, name] of await runningProcesses(adb, serial)) {
    if (name.includes(":")) candidates.add(baseName$1(name));
  }
  for (const host of candidates) {
    const listing = await sh$1(adb, serial, ["shell", "run-as", host, "ls", "blackbox/data/app/"]);
    const names = listing.split("\n").map((l) => l.trim()).filter(
      (l) => l && !l.includes("/") && !l.toLowerCase().includes("not debuggable") && !l.toLowerCase().includes("no such") && !l.toLowerCase().includes("unknown")
    );
    if (names.length > 0) clones[host] = names;
  }
  return clones;
}
async function listApps$1(adb, serial) {
  const device = new Set(await listPackages(adb, serial));
  device.delete("");
  const cloneMap = await listClones(adb, serial);
  const cloneToHost = /* @__PURE__ */ new Map();
  for (const [host, cl] of Object.entries(cloneMap)) {
    for (const c of cl) cloneToHost.set(c, host);
  }
  const cloneNames = [...cloneToHost.keys()].sort();
  const deviceOnly = [...device].filter((d) => !cloneToHost.has(d)).sort();
  const entries = [];
  for (const c of cloneNames) entries.push({ pkg: c, clone: true, host: cloneToHost.get(c) ?? "" });
  for (const d of deviceOnly) entries.push({ pkg: d, clone: false, host: "" });
  return entries;
}
async function resolvePids(adb, serial, pkg) {
  const pids = [];
  for (const [pid, name] of await runningProcesses(adb, serial)) {
    if (name === pkg || name.startsWith(pkg + ":")) pids.push(pid);
  }
  return pids;
}
async function forceCrash(adb, serial, pkg, pids) {
  const notes = [];
  if (pkg) {
    await run$3(adb, serial, ["shell", "am", "force-stop", pkg], 6e3);
    notes.push(`force-stop ${pkg}`);
  }
  const uniq = [...new Set(pids)].sort((a, b) => a - b);
  if (uniq.length > 0) {
    await run$3(adb, serial, ["shell", "kill", "-9", ...uniq.map(String)], 6e3);
    notes.push("kill " + uniq.join(","));
  }
  return notes;
}
const DEBOUNCE_MS = 400;
const RESTART_OK_MS = 3e3;
const RESTART_FAST_FAIL_MS = 2e4;
class DeviceWatcher {
  constructor(opts) {
    this.opts = opts;
  }
  adbProc = null;
  iosProc = null;
  debounce = null;
  stopped = false;
  start() {
    this.stopped = false;
    this.startAdb();
    this.startIos();
  }
  fire() {
    if (this.stopped) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      if (!this.stopped) this.opts.onChange();
    }, DEBOUNCE_MS);
  }
  startAdb() {
    if (this.stopped || this.adbProc) return;
    const adb = this.opts.findAdb();
    if (!adb) {
      this.scheduleRestart("adb", RESTART_FAST_FAIL_MS);
      return;
    }
    const startedAt = Date.now();
    try {
      const p = node_child_process.spawn(adb, ["track-devices"], { stdio: ["ignore", "pipe", "ignore"] });
      this.adbProc = p;
      p.stdout?.on("data", () => this.fire());
      p.on("error", () => {
      });
      p.on("exit", () => {
        if (this.adbProc === p) this.adbProc = null;
        this.scheduleRestart("adb", Date.now() - startedAt < 1500 ? RESTART_FAST_FAIL_MS : RESTART_OK_MS);
      });
    } catch {
      this.scheduleRestart("adb", RESTART_FAST_FAIL_MS);
    }
  }
  startIos() {
    if (this.stopped || this.iosProc) return;
    const bin = this.opts.findGoIos();
    if (!bin) {
      this.scheduleRestart("ios", RESTART_FAST_FAIL_MS);
      return;
    }
    const startedAt = Date.now();
    try {
      const p = node_child_process.spawn(bin, ["listen"], { stdio: ["ignore", "pipe", "ignore"] });
      this.iosProc = p;
      let buf = "";
      p.stdout?.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        if (/"MessageType"\s*:\s*"(Attached|Detached)"/.test(buf)) {
          buf = "";
          this.fire();
        }
        if (buf.length > 65536) buf = buf.slice(-4096);
      });
      p.on("error", () => {
      });
      p.on("exit", () => {
        if (this.iosProc === p) this.iosProc = null;
        this.scheduleRestart("ios", Date.now() - startedAt < 1500 ? RESTART_FAST_FAIL_MS : RESTART_OK_MS);
      });
    } catch {
      this.scheduleRestart("ios", RESTART_FAST_FAIL_MS);
    }
  }
  scheduleRestart(which, delayMs) {
    if (this.stopped) return;
    setTimeout(() => {
      if (this.stopped) return;
      if (which === "adb") this.startAdb();
      else this.startIos();
    }, delayMs);
  }
  stop() {
    this.stopped = true;
    if (this.debounce) {
      clearTimeout(this.debounce);
      this.debounce = null;
    }
    for (const p of [this.adbProc, this.iosProc]) {
      try {
        p?.kill();
      } catch {
      }
    }
    this.adbProc = null;
    this.iosProc = null;
  }
}
const tcpipArgs = (port = 5555) => ["tcpip", String(port)];
const ipRouteArgs = () => ["shell", "ip", "route"];
const connectArgs = (hostPort) => ["connect", hostPort];
function parseDeviceIp(ipRouteOut) {
  for (const line of ipRouteOut.split("\n")) {
    if (line.includes("wlan")) {
      const m2 = /\bsrc\s+(\d+\.\d+\.\d+\.\d+)/.exec(line);
      if (m2) return m2[1];
    }
  }
  const m = /\bsrc\s+(\d+\.\d+\.\d+\.\d+)/.exec(ipRouteOut);
  return m ? m[1] : null;
}
function looksOk(out) {
  const low = out.toLowerCase();
  return low.includes("successfully paired") || low.includes("connected to") || low.includes("already connected") || low.includes("restarting in tcp");
}
const READS$1 = [
  ["props", "getprop"],
  ["battery", "dumpsys battery"],
  ["storage", "df -k /data"],
  ["mem", "cat /proc/meminfo"],
  ["size", "wm size"],
  ["density", "wm density"],
  ["route", "ip route"],
  ["uptime", "cat /proc/uptime"],
  ["kernel", "uname -a"],
  ["devname", "settings get global device_name"]
];
function buildProbe$1() {
  return READS$1.map(([k, cmd]) => `echo @@${k}@@; ${cmd} 2>/dev/null`).join("; ");
}
function splitSections(text2) {
  const raw = {};
  let key2 = null;
  for (const line of text2.split("\n")) {
    const m = /^@@(\w+)@@\s*$/.exec(line.trim());
    if (m) {
      key2 = m[1];
      raw[key2] = "";
    } else if (key2 !== null) {
      raw[key2] += line + "\n";
    }
  }
  const out = {};
  for (const k of Object.keys(raw)) out[k] = raw[k].trim();
  return out;
}
function parseGetprop(text2) {
  const out = {};
  for (const line of text2.split("\n")) {
    const m = /^\[([^\]]+)\]:\s*\[(.*)\]$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}
const BATTERY_STATUS = {
  "1": "Unknown",
  "2": "Charging",
  "3": "Discharging",
  "4": "Not charging",
  "5": "Full"
};
const BATTERY_HEALTH = {
  "1": "Unknown",
  "2": "Good",
  "3": "Overheating",
  "4": "Dead",
  "5": "Over voltage",
  "6": "Failure",
  "7": "Cold"
};
function parseBattery$1(text2) {
  const level = /^\s*level:\s*(\d+)/m.exec(text2);
  if (!level) return null;
  const statusN = /^\s*status:\s*(\d+)/m.exec(text2);
  const healthN = /^\s*health:\s*(\d+)/m.exec(text2);
  const temp = /^\s*temperature:\s*(-?\d+)/m.exec(text2);
  const volt = /^\s*voltage:\s*(\d+)/m.exec(text2);
  const tech = /^\s*technology:\s*(.+)$/m.exec(text2);
  return {
    level: parseInt(level[1], 10),
    status: statusN ? BATTERY_STATUS[statusN[1]] ?? "" : "",
    health: healthN ? BATTERY_HEALTH[healthN[1]] ?? "" : "",
    tempC: temp ? parseInt(temp[1], 10) / 10 : null,
    // dumpsys reports mV (~4300) on phones, occasionally µV on some tablets.
    voltageV: volt ? mvToVolts(parseInt(volt[1], 10)) : null,
    technology: tech ? tech[1].trim() : "",
    charging: statusN && (statusN[1] === "2" || statusN[1] === "5") || /(AC|USB|Wireless) powered:\s*true/.test(text2)
  };
}
function mvToVolts(v) {
  const volts = v > 1e5 ? v / 1e6 : v / 1e3;
  return Math.round(volts * 100) / 100;
}
function parseStorage(text2) {
  const rowRe = /(\d+)\s+(\d+)\s+(\d+)\s+\d+%?\s+(\/\S*)/g;
  let best = null;
  let m;
  while ((m = rowRe.exec(text2)) !== null) {
    if (m[4].startsWith("/data")) {
      best = m;
      break;
    }
    if (!best) best = m;
  }
  if (!best) return null;
  const total = parseInt(best[1], 10) * 1024;
  const free = parseInt(best[3], 10) * 1024;
  if (!total) return null;
  return { totalBytes: total, freeBytes: free };
}
function parseRamBytes(text2) {
  const m = /MemTotal:\s*(\d+)\s*kB/i.exec(text2);
  return m ? parseInt(m[1], 10) * 1024 : null;
}
function parseResolution(text2) {
  const over = /Override size:\s*(\d+)x(\d+)/i.exec(text2);
  const phys = /Physical size:\s*(\d+)x(\d+)/i.exec(text2);
  const m = over ?? phys;
  return m ? `${m[1]} × ${m[2]}` : "";
}
function parseDensity(text2) {
  const over = /Override density:\s*(\d+)/i.exec(text2);
  const phys = /Physical density:\s*(\d+)/i.exec(text2);
  const m = over ?? phys;
  return m ? `${m[1]} dpi` : "";
}
function parseUptime(text2) {
  const m = /^\s*([\d.]+)/.exec(text2);
  if (!m) return "";
  const s = Math.floor(parseFloat(m[1]));
  const d = Math.floor(s / 86400);
  const h = Math.floor(s % 86400 / 3600);
  const mm = Math.floor(s % 3600 / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  parts.push(`${mm}m`);
  return parts.join(" ");
}
function cap$1(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
function cleanCarrier(s) {
  return s.replace(/[,\s]+$/g, "").trim();
}
function dedupeCsv(s) {
  const parts = s.split(",").map((x) => x.trim()).filter(Boolean);
  return parts.every((x) => x === parts[0]) ? parts[0] ?? "" : parts.join(", ");
}
function parseDeviceInfo$1(raw, fallbackSerial = "") {
  const s = splitSections(raw);
  const p = parseGetprop(s.props ?? "");
  const g = (k) => p[k] ?? "";
  const model = g("ro.product.model");
  const manufacturer = g("ro.product.manufacturer");
  const brand = g("ro.product.brand");
  const androidVersion = g("ro.build.version.release");
  const sdk = g("ro.build.version.sdk");
  const devName = (s.devname ?? "").trim();
  const name = devName && devName.toLowerCase() !== "null" ? devName : model || cap$1(manufacturer);
  const soc = [g("ro.soc.manufacturer"), g("ro.soc.model")].map((x) => x.trim()).filter(Boolean).join(" ");
  const chip = soc || g("ro.board.platform") || g("ro.hardware");
  const ramBytes = parseRamBytes(s.mem ?? "");
  const resolution = parseResolution(s.size ?? "");
  const density = parseDensity(s.density ?? "");
  const carrier = cleanCarrier(g("gsm.operator.alpha"));
  const simState = cleanCarrier(g("gsm.sim.state"));
  const radio = dedupeCsv(g("gsm.version.baseband") || g("ro.baseband"));
  const serial = g("ro.serialno") || fallbackSerial;
  const kernel = (s.kernel ?? "").trim();
  const kernelRelease = /\b(\d+\.\d+\.\d+\S*)/.exec(kernel)?.[1] ?? kernel;
  const details = [
    ["Manufacturer", cap$1(manufacturer)],
    ["Model", model],
    ["Codename", g("ro.product.device")],
    ["Brand", cap$1(brand)],
    ["Android version", androidVersion ? `${androidVersion} (API ${sdk})` : ""],
    ["Build number", g("ro.build.display.id") || g("ro.build.id")],
    ["Security patch", g("ro.build.version.security_patch")],
    ["Build type", [g("ro.build.type"), g("ro.build.tags")].filter(Boolean).join(" · ")],
    ["Fingerprint", g("ro.build.fingerprint")],
    ["Kernel", kernelRelease],
    ["Bootloader", g("ro.bootloader")],
    ["Baseband", radio],
    ["SoC", soc],
    ["CPU ABI", g("ro.product.cpu.abi")],
    ["Hardware", g("ro.hardware")],
    ["Serial number", serial],
    ["Encryption", cap$1(g("ro.crypto.state"))],
    ["Uptime", parseUptime(s.uptime ?? "")]
  ].filter(([, v]) => v !== "");
  return {
    name,
    model,
    manufacturer: cap$1(manufacturer),
    brand: cap$1(brand),
    device: g("ro.product.device"),
    androidVersion,
    androidName: androidVersion ? `Android ${androidVersion}` : "",
    sdk,
    buildId: g("ro.build.display.id") || g("ro.build.id"),
    fingerprint: g("ro.build.fingerprint"),
    securityPatch: g("ro.build.version.security_patch"),
    abi: g("ro.product.cpu.abi"),
    hardware: g("ro.hardware"),
    board: g("ro.product.board") || g("ro.board.platform"),
    bootloader: g("ro.bootloader"),
    buildType: g("ro.build.type"),
    buildTags: g("ro.build.tags"),
    kernel: kernelRelease,
    serial,
    chip,
    radio,
    ram: ramBytes ? fmtRam(ramBytes) : "",
    ramBytes,
    resolution,
    density,
    display: [resolution, density].filter(Boolean).join(" · "),
    ip: parseDeviceIp(s.route ?? "") ?? "",
    carrier,
    simState,
    telephony: !!(carrier || simState && !/^absent$/i.test(simState)),
    encryption: cap$1(g("ro.crypto.state")),
    uptime: parseUptime(s.uptime ?? ""),
    storage: parseStorage(s.storage ?? ""),
    battery: parseBattery$1(s.battery ?? ""),
    details
  };
}
const RAM_SIZES = [1, 2, 3, 4, 6, 8, 12, 16, 18, 24, 32];
function fmtRam(bytes) {
  const gib = bytes / 1024 ** 3;
  const nominal = RAM_SIZES.find((s) => s >= gib && s - gib <= 1.25);
  return `${nominal ?? Math.round(gib)} GB`;
}
async function readDeviceInfo(adb, serial) {
  const r = await run$3(adb, serial, ["shell", buildProbe$1()], 15e3);
  if (!r.stdout.trim()) return null;
  return parseDeviceInfo$1(r.stdout, serial);
}
const MAX_BODY$1 = 4e4;
function isObj$1(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function str$2(o, key2) {
  return typeof o[key2] === "string" ? o[key2] : "";
}
function cap(s) {
  return s.length > MAX_BODY$1 ? s.slice(0, MAX_BODY$1) + "\n… (truncated)" : s;
}
function baseName(p) {
  return p.split(/[\\/]/).pop() ?? p;
}
function dateFromName(fn) {
  const m = /(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(fn);
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : "";
}
const SKIP_NAME = /(^analytics|^sfa-|^proactive|^xp_amp|app_usage|-dnu|\.ca\.synced|^awd|^summaries)/i;
function categorize(fnLower) {
  if (fnLower.includes("jetsamevent")) return { kind: "native", source: "JetsamEvent", title: () => "Low-memory (Jetsam) termination" };
  if (fnLower.includes(".cpu_resource")) return { kind: "anr", source: "cpu_resource", title: (n) => `CPU resource limit — ${n}` };
  if (fnLower.includes(".wakeups_resource")) return { kind: "anr", source: "wakeups_resource", title: (n) => `Excessive wakeups — ${n}` };
  if (fnLower.includes(".diskwrites_resource") || fnLower.includes(".disk_resource")) return { kind: "anr", source: "disk_resource", title: (n) => `Excessive disk writes — ${n}` };
  if (fnLower.includes("-hang") || fnLower.includes(".hang")) return { kind: "anr", source: "hang", title: (n) => `Hang — ${n}` };
  return null;
}
const CRASH_BUG_TYPES = /* @__PURE__ */ new Set(["109", "309", "385", "208", "3", "113"]);
function looksLikeCrash(bugType, body) {
  if (CRASH_BUG_TYPES.has(bugType)) return true;
  return /"exception"|"faultingThread"|Exception Type:|Crashed Thread:/.test(body.slice(0, 4e3));
}
function summarizeJson(body) {
  let b;
  try {
    const p = JSON.parse(body);
    if (!isObj$1(p)) return cap(body);
    b = p;
  } catch {
    return cap(body);
  }
  const lines = [];
  if ("largestProcess" in b || "memoryStatus" in b) {
    if (b.largestProcess) lines.push(`Largest process: ${String(b.largestProcess)}`);
    const ms = isObj$1(b.memoryStatus) ? b.memoryStatus : null;
    if (ms) {
      if (ms.pageSize) lines.push(`Page size: ${String(ms.pageSize)} bytes`);
      if (ms.memoryPages && isObj$1(ms.memoryPages)) {
        const mp = ms.memoryPages;
        lines.push(`Memory pages — active ${mp.active ?? "?"}, free ${mp.free ?? "?"}, wired ${mp.wired ?? "?"}`);
      }
    }
    if (Array.isArray(b.processes)) {
      const procs = b.processes.filter(isObj$1).map((p) => ({ name: str$2(p, "name"), pid: p.pid, pages: typeof p.rpages === "number" ? p.rpages : 0 })).sort((x, y) => y.pages - x.pages).slice(0, 12);
      lines.push("", `Top memory users (of ${b.processes.length} processes):`);
      for (const p of procs) lines.push(`  ${p.name || "?"} (pid ${p.pid ?? "?"}) — ${p.pages} pages`);
    }
    return lines.join("\n");
  }
  const exc = isObj$1(b.exception) ? b.exception : null;
  if (exc) lines.push(`Exception: ${str$2(exc, "type")} ${str$2(exc, "signal")} ${str$2(exc, "subtype")}`.trim());
  const term = isObj$1(b.termination) ? b.termination : null;
  if (term) {
    const reasons = Array.isArray(term.reasons) ? term.reasons.join(" ") : "";
    lines.push(`Termination: ${str$2(term, "namespace")} ${str$2(term, "indicator")} ${reasons}`.trim());
  }
  const images = Array.isArray(b.usedImages) ? b.usedImages : [];
  const threads = Array.isArray(b.threads) ? b.threads : [];
  const faultIdx = typeof b.faultingThread === "number" ? b.faultingThread : threads.findIndex((t) => t.triggered === true);
  const ft = faultIdx >= 0 ? threads[faultIdx] : void 0;
  if (ft && Array.isArray(ft.frames)) {
    lines.push("", `Crashed thread ${faultIdx}:`);
    for (const f of ft.frames.slice(0, 30)) {
      const img = typeof f.imageIndex === "number" ? images[f.imageIndex] : void 0;
      const imgName = img ? str$2(img, "name") : "";
      lines.push(`  ${imgName || "?"} + ${f.imageOffset ?? "?"}`);
    }
  }
  return lines.length ? lines.join("\n") : cap(JSON.stringify(b, null, 2));
}
function parseIpsReport(filename, raw) {
  const fn = baseName(filename);
  const fnLower = fn.toLowerCase();
  const nl = raw.indexOf("\n");
  const headText = nl > 0 ? raw.slice(0, nl) : raw;
  const body = nl > 0 ? raw.slice(nl + 1).trim() : "";
  let header = {};
  try {
    const h = JSON.parse(headText);
    if (isObj$1(h)) header = h;
  } catch {
  }
  if (Object.keys(header).length === 0) {
    if (/Incident Identifier|Exception Type:|Crashed Thread:/.test(raw)) {
      return {
        kind: "crash",
        when: dateFromName(fn),
        process: fn.split("-")[0],
        title: "Crash",
        text: raw,
        source: "crash",
        plain: cap(raw)
      };
    }
    return null;
  }
  const bugType = header.bug_type != null ? String(header.bug_type) : "";
  const name = str$2(header, "name") || str$2(header, "app_name") || str$2(header, "procName");
  const bundleId = str$2(header, "bundleID") || str$2(header, "bundle_id");
  const os = str$2(header, "os_version");
  const when = str$2(header, "timestamp") || dateFromName(fn);
  const cat = categorize(fnLower);
  let kind;
  let source;
  let title;
  if (cat) {
    kind = cat.kind;
    source = cat.source;
    title = cat.title(name || fn.split("-")[0]);
  } else if (!SKIP_NAME.test(fn) && looksLikeCrash(bugType, body)) {
    kind = "crash";
    source = "crash";
    title = `Crash — ${name || fn.split("-")[0]}`;
  } else {
    return null;
  }
  const rendered = body.startsWith("{") ? summarizeJson(body) : body || headText;
  const metaHead = [
    `Process:  ${name || "?"}${bundleId ? `  (${bundleId})` : ""}`,
    `Type:     ${source}`,
    os ? `OS:       ${os}` : "",
    `Date:     ${when}`
  ].filter(Boolean).join("\n");
  const plain = `${metaHead}

${cap(rendered)}`;
  return {
    kind,
    when,
    process: bundleId || name || fn.split("-")[0],
    title,
    text: plain,
    source,
    plain
  };
}
const CF_EPOCH_OFFSET = 978307200;
function parsePlist(buf) {
  if (buf.length >= 8 && buf.toString("latin1", 0, 6) === "bplist") {
    return parseBinaryPlist(buf);
  }
  const head = buf.toString("utf8", 0, Math.min(buf.length, 512)).replace(/^﻿/, "").trimStart();
  if (head.startsWith("<?xml") || head.startsWith("<plist") || head.startsWith("<!DOCTYPE plist")) {
    return parseXmlPlist(buf.toString("utf8"));
  }
  throw new Error("not a recognised plist (neither bplist00 nor XML)");
}
function readUIntBE(buf, offset, size2) {
  let v = 0;
  for (let i = 0; i < size2; i++) v = v * 256 + buf[offset + i];
  return v;
}
function readInt(buf, offset, size2) {
  switch (size2) {
    case 1:
      return buf.readUInt8(offset);
    case 2:
      return buf.readUInt16BE(offset);
    case 4:
      return buf.readUInt32BE(offset);
    case 8:
      return Number(buf.readBigInt64BE(offset));
    case 16: {
      const hi = buf.readBigInt64BE(offset);
      const lo = buf.readBigUInt64BE(offset + 8);
      return Number((hi << 64n) + lo);
    }
    default:
      throw new Error(`unsupported int size ${size2}`);
  }
}
function utf16beToString(buf, start, units) {
  let s = "";
  for (let i = 0; i < units; i++) s += String.fromCharCode(buf.readUInt16BE(start + i * 2));
  return s;
}
function parseBinaryPlist(buf) {
  if (buf.length < 40) throw new Error("binary plist too small");
  const trailer = buf.length - 32;
  const offsetIntSize = buf[trailer + 6];
  const objectRefSize = buf[trailer + 7];
  const numObjects = readUIntBE(buf, trailer + 8, 8);
  const topObject = readUIntBE(buf, trailer + 16, 8);
  const offsetTableOffset = readUIntBE(buf, trailer + 24, 8);
  if (!offsetIntSize || !objectRefSize || numObjects <= 0) throw new Error("malformed binary plist trailer");
  const offsetTable = new Array(numObjects);
  for (let i = 0; i < numObjects; i++) {
    offsetTable[i] = readUIntBE(buf, offsetTableOffset + i * offsetIntSize, offsetIntSize);
  }
  const readLength = (off, objInfo) => {
    if (objInfo !== 15) return [objInfo, off];
    const m = buf[off];
    if ((m & 240) !== 16) throw new Error("expected int length marker");
    const n = 1 << (m & 15);
    return [readInt(buf, off + 1, n), off + 1 + n];
  };
  const readRef = (pos) => readUIntBE(buf, pos, objectRefSize);
  const stack = /* @__PURE__ */ new Set();
  const parseObject = (idx) => {
    if (idx >= numObjects) throw new Error("object index out of range");
    if (stack.has(idx)) throw new Error("cyclic plist reference");
    let off = offsetTable[idx];
    const marker = buf[off];
    const objType = marker & 240;
    const objInfo = marker & 15;
    off += 1;
    switch (objType) {
      case 0:
        if (marker === 8) return false;
        if (marker === 9) return true;
        return null;
      case 16:
        return readInt(buf, off, 1 << objInfo);
      case 32:
        if (objInfo === 2) return buf.readFloatBE(off);
        if (objInfo === 3) return buf.readDoubleBE(off);
        throw new Error(`unsupported real size ${1 << objInfo}`);
      case 48:
        return new Date((buf.readDoubleBE(off) + CF_EPOCH_OFFSET) * 1e3).toISOString();
      case 64: {
        const [len, dOff] = readLength(off, objInfo);
        return buf.toString("base64", dOff, dOff + len);
      }
      case 80: {
        const [len, sOff] = readLength(off, objInfo);
        return buf.toString("latin1", sOff, sOff + len);
      }
      case 96: {
        const [len, sOff] = readLength(off, objInfo);
        return utf16beToString(buf, sOff, len);
      }
      case 128:
        return { UID: readUIntBE(buf, off, objInfo + 1) };
      case 160:
      case 192: {
        const [count, aOff] = readLength(off, objInfo);
        const arr = [];
        stack.add(idx);
        for (let i = 0; i < count; i++) arr.push(parseObject(readRef(aOff + i * objectRefSize)));
        stack.delete(idx);
        return arr;
      }
      case 208: {
        const [count, kOff] = readLength(off, objInfo);
        const vOff = kOff + count * objectRefSize;
        const obj = {};
        stack.add(idx);
        for (let i = 0; i < count; i++) {
          const key2 = parseObject(readRef(kOff + i * objectRefSize));
          obj[String(key2)] = parseObject(readRef(vOff + i * objectRefSize));
        }
        stack.delete(idx);
        return obj;
      }
      default:
        throw new Error(`unknown plist object type 0x${objType.toString(16)}`);
    }
  };
  return parseObject(topObject);
}
function decodeEntities(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(parseInt(d, 10))).replace(/&amp;/g, "&");
}
function parseXmlPlist(xml) {
  const body = xml.replace(/<!--[\s\S]*?-->/g, "");
  const len = body.length;
  let i = 0;
  const readTag = () => {
    for (; ; ) {
      const lt = body.indexOf("<", i);
      if (lt < 0) {
        i = len;
        return null;
      }
      const gt = body.indexOf(">", lt);
      if (gt < 0) {
        i = len;
        return null;
      }
      let raw = body.slice(lt + 1, gt).trim();
      i = gt + 1;
      if (raw.startsWith("?") || raw.startsWith("!")) continue;
      const selfClose = raw.endsWith("/");
      if (selfClose) raw = raw.slice(0, -1).trim();
      const close = raw.startsWith("/");
      if (close) raw = raw.slice(1).trim();
      return { name: raw.split(/\s/)[0], close, selfClose };
    }
  };
  const readText = (tag) => {
    const closeIdx = body.indexOf("</" + tag, i);
    const end = closeIdx < 0 ? len : closeIdx;
    const text2 = body.slice(i, end);
    i = closeIdx < 0 ? len : body.indexOf(">", closeIdx) + 1;
    return decodeEntities(text2.trim());
  };
  const valueFromOpenTag = (tag) => {
    if (tag.selfClose) {
      switch (tag.name) {
        case "true":
          return true;
        case "false":
          return false;
        case "dict":
          return {};
        case "array":
          return [];
        default:
          return "";
      }
    }
    switch (tag.name) {
      case "true":
        return true;
      case "false":
        return false;
      case "string":
        return readText("string");
      case "integer":
        return parseInt(readText("integer"), 10);
      case "real":
        return parseFloat(readText("real"));
      case "date":
        return readText("date");
      case "data":
        return readText("data").replace(/\s+/g, "");
      case "dict":
        return parseDict();
      case "array":
        return parseArray();
      default:
        throw new Error(`unexpected plist element <${tag.name}>`);
    }
  };
  const parseNextValue = () => {
    const tag = readTag();
    if (!tag) throw new Error("unexpected end of plist");
    return valueFromOpenTag(tag);
  };
  function parseDict() {
    const out = {};
    for (; ; ) {
      const t = readTag();
      if (!t) throw new Error("unterminated <dict>");
      if (t.close && t.name === "dict") return out;
      if (t.name !== "key") throw new Error("expected <key> in <dict>");
      const key2 = readText("key");
      out[key2] = parseNextValue();
    }
  }
  function parseArray() {
    const out = [];
    for (; ; ) {
      const save = i;
      const t = readTag();
      if (!t) throw new Error("unterminated <array>");
      if (t.close && t.name === "array") return out;
      i = save;
      out.push(parseNextValue());
    }
  }
  for (; ; ) {
    const t = readTag();
    if (!t) throw new Error("no <plist> root");
    if (t.name === "plist" && !t.close) break;
  }
  return parseNextValue();
}
function prefFor(key2, v) {
  if (typeof v === "boolean") return { key: key2, type: "boolean", value: v ? "true" : "false" };
  if (typeof v === "number") return { key: key2, type: Number.isInteger(v) ? "int" : "float", value: String(v) };
  if (typeof v === "string") return { key: key2, type: "string", value: v };
  return { key: key2, type: "set", value: JSON.stringify(v) };
}
function plistValueToPrefs(root) {
  if (!root || typeof root !== "object" || Array.isArray(root)) return [];
  const out = [];
  for (const [key2, v] of Object.entries(root)) {
    out.push(prefFor(key2, v));
  }
  out.sort((a, b) => {
    const la = a.key.toLowerCase();
    const lb = b.key.toLowerCase();
    return la < lb ? -1 : la > lb ? 1 : 0;
  });
  return out;
}
const SPECS = {
  // iPhone 16 family (A18 / A18 Pro)
  "iPhone17,1": { name: "iPhone 16 Pro", chip: "A18 Pro", ram: "8 GB", display: "6.3-inch · 2622×1206 · 120 Hz" },
  "iPhone17,2": { name: "iPhone 16 Pro Max", chip: "A18 Pro", ram: "8 GB", display: "6.9-inch · 2868×1320 · 120 Hz" },
  "iPhone17,3": { name: "iPhone 16", chip: "A18", ram: "8 GB", display: "6.1-inch · 2556×1179 · 60 Hz" },
  "iPhone17,4": { name: "iPhone 16 Plus", chip: "A18", ram: "8 GB", display: "6.7-inch · 2796×1290 · 60 Hz" },
  // iPhone 15 family
  "iPhone16,1": { name: "iPhone 15 Pro", chip: "A17 Pro", ram: "8 GB", display: "6.1-inch · 2556×1179 · 120 Hz" },
  "iPhone16,2": { name: "iPhone 15 Pro Max", chip: "A17 Pro", ram: "8 GB", display: "6.7-inch · 2796×1290 · 120 Hz" },
  "iPhone15,4": { name: "iPhone 15", chip: "A16 Bionic", ram: "6 GB", display: "6.1-inch · 2556×1179 · 60 Hz" },
  "iPhone15,5": { name: "iPhone 15 Plus", chip: "A16 Bionic", ram: "6 GB", display: "6.7-inch · 2796×1290 · 60 Hz" },
  // iPhone 14 family
  "iPhone15,2": { name: "iPhone 14 Pro", chip: "A16 Bionic", ram: "6 GB", display: "6.1-inch · 2556×1179 · 120 Hz" },
  "iPhone15,3": { name: "iPhone 14 Pro Max", chip: "A16 Bionic", ram: "6 GB", display: "6.7-inch · 2796×1290 · 120 Hz" },
  "iPhone14,7": { name: "iPhone 14", chip: "A15 Bionic", ram: "6 GB", display: "6.1-inch · 2532×1170 · 60 Hz" },
  "iPhone14,8": { name: "iPhone 14 Plus", chip: "A15 Bionic", ram: "6 GB", display: "6.7-inch · 2778×1284 · 60 Hz" },
  // iPhone 13 family
  "iPhone14,2": { name: "iPhone 13 Pro", chip: "A15 Bionic", ram: "6 GB", display: "6.1-inch · 2532×1170 · 120 Hz" },
  "iPhone14,3": { name: "iPhone 13 Pro Max", chip: "A15 Bionic", ram: "6 GB", display: "6.7-inch · 2778×1284 · 120 Hz" },
  "iPhone14,4": { name: "iPhone 13 mini", chip: "A15 Bionic", ram: "4 GB", display: "5.4-inch · 2340×1080 · 60 Hz" },
  "iPhone14,5": { name: "iPhone 13", chip: "A15 Bionic", ram: "4 GB", display: "6.1-inch · 2532×1170 · 60 Hz" },
  "iPhone14,6": { name: "iPhone SE (3rd gen)", chip: "A15 Bionic", ram: "4 GB", display: "4.7-inch · 1334×750 · 60 Hz" },
  // iPhone 12 family
  "iPhone13,1": { name: "iPhone 12 mini", chip: "A14 Bionic", ram: "4 GB" },
  "iPhone13,2": { name: "iPhone 12", chip: "A14 Bionic", ram: "4 GB" },
  "iPhone13,3": { name: "iPhone 12 Pro", chip: "A14 Bionic", ram: "6 GB" },
  "iPhone13,4": { name: "iPhone 12 Pro Max", chip: "A14 Bionic", ram: "6 GB" }
};
const PLATFORM_CHIP = {
  t8140: "A18 Pro",
  t8150: "A18",
  t8130: "A17 Pro",
  t8120: "A16 Bionic",
  t8110: "A15 Bionic",
  t8101: "A14 Bionic",
  t8030: "A13 Bionic",
  t8027: "A12 Bionic",
  t8015: "A11 Bionic"
};
function str$1(o, key2) {
  const v = o[key2];
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}
function bool(o, key2) {
  return o[key2] === true || o[key2] === "true";
}
function num$1(o, key2) {
  const v = o[key2];
  return typeof v === "number" ? v : null;
}
function safeParse(json) {
  try {
    const o = JSON.parse(json.trim());
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}
function osNameFor(deviceClass) {
  const c = deviceClass.toLowerCase();
  if (c === "ipad") return "iPadOS";
  if (c === "watch") return "watchOS";
  if (c === "appletv" || c === "tv") return "tvOS";
  return "iOS";
}
function parseDeviceInfo(infoJson, diskJson, batteryRegistryJson, batteryCheckJson) {
  const info = safeParse(infoJson);
  const disk = safeParse(diskJson);
  const reg = safeParse(batteryRegistryJson);
  const chk = safeParse(batteryCheckJson);
  const productType = str$1(info, "ProductType");
  const platform = str$1(info, "HardwarePlatform");
  const spec = SPECS[productType];
  const deviceClass = str$1(info, "DeviceClass") || "iPhone";
  const totalBytes = num$1(disk, "TotalBytes");
  const freeBytes = num$1(disk, "FreeBytes");
  const storage = totalBytes && freeBytes !== null ? { totalBytes, freeBytes } : null;
  const level = num$1(chk, "BatteryCurrentCapacity") ?? num$1(reg, "CurrentCapacity");
  const design = num$1(reg, "DesignCapacity");
  const nominal = num$1(reg, "NominalChargeCapacity");
  const temp = num$1(reg, "Temperature");
  const battery = level === null ? null : {
    level,
    healthPct: design && nominal ? Math.round(nominal / design * 1e3) / 10 : null,
    cycleCount: num$1(reg, "CycleCount"),
    tempC: temp !== null ? Math.round(temp / 10) / 10 : null,
    charging: bool(reg, "IsCharging") || bool(chk, "BatteryIsCharging"),
    designCapacity: design,
    nominalCapacity: nominal
  };
  const detailKeys = [
    ["Serial Number", "SerialNumber"],
    ["UDID", "UniqueDeviceID"],
    ["Model Number", "ModelNumber"],
    ["Board ID", "BoardId"],
    ["Chip ID", "ChipID"],
    ["Hardware Model", "HardwareModel"],
    ["Wi-Fi Address", "WiFiAddress"],
    ["Bluetooth Address", "BluetoothAddress"],
    ["Firmware", "FirmwareVersion"],
    ["Baseband", "BasebandVersion"],
    ["Region", "RegionInfo"],
    ["Time Zone", "TimeZone"],
    ["Boot Session", "BootSessionID"]
  ];
  const details = detailKeys.map(([label, key2]) => [label, str$1(info, key2)]).filter(([, v]) => v !== "");
  return {
    name: str$1(info, "DeviceName") || deviceClass,
    productType,
    marketingName: spec?.name ?? productType ?? "Unknown device",
    deviceClass,
    osName: osNameFor(deviceClass),
    osVersion: str$1(info, "HumanReadableProductVersionString") || str$1(info, "ProductVersion"),
    buildVersion: str$1(info, "BuildVersion"),
    modelNumber: str$1(info, "ModelNumber"),
    regionInfo: str$1(info, "RegionInfo"),
    chip: spec?.chip ?? PLATFORM_CHIP[platform] ?? "",
    cpuArch: str$1(info, "CPUArchitecture"),
    hardwarePlatform: platform,
    ram: spec?.ram ?? "",
    display: spec?.display ?? "",
    activated: str$1(info, "ActivationState") === "Activated",
    passwordProtected: bool(info, "PasswordProtected"),
    timeZone: str$1(info, "TimeZone"),
    uses24h: bool(info, "Uses24HourClock"),
    telephony: bool(info, "TelephonyCapability"),
    simStatus: /ready/i.test(str$1(info, "SIMStatus")) ? "Ready" : str$1(info, "SIMStatus") ? "No SIM" : "",
    baseband: str$1(info, "BasebandVersion"),
    storage,
    battery,
    details
  };
}
function jsonValues(stdout) {
  const text2 = (stdout ?? "").trim();
  if (!text2) return [];
  try {
    return [JSON.parse(text2)];
  } catch {
  }
  const vals = [];
  for (const raw of text2.split("\n")) {
    const s = raw.trim();
    if (!s || s[0] !== "{" && s[0] !== "[") continue;
    try {
      vals.push(JSON.parse(s));
    } catch {
    }
  }
  return vals;
}
function isObj(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function str(o, key2) {
  const v = o[key2];
  return typeof v === "string" ? v : "";
}
function parseDeviceListDetails(stdout) {
  const byUdid = /* @__PURE__ */ new Map();
  const order = [];
  for (const v of jsonValues(stdout)) {
    if (!isObj(v) || !Array.isArray(v.deviceList)) continue;
    for (const e of v.deviceList) {
      if (!isObj(e)) continue;
      const udid = str(e, "Udid");
      if (!udid) continue;
      const conn = str(e, "ConnectionType") === "Network" ? "wifi" : "usb";
      if (!byUdid.has(udid)) {
        byUdid.set(udid, /* @__PURE__ */ new Set());
        order.push(udid);
      }
      byUdid.get(udid).add(conn);
    }
  }
  return order.map((udid) => {
    const set = byUdid.get(udid);
    const transports = [];
    if (set.has("usb")) transports.push("usb");
    if (set.has("wifi")) transports.push("wifi");
    return { udid, transports };
  });
}
function parseWifiConnections(stdout) {
  for (const v of jsonValues(stdout)) {
    if (isObj(v) && typeof v.EnableWifiConnections === "boolean") return v.EnableWifiConnections;
  }
  return null;
}
function parseInfo(stdout) {
  for (const v of jsonValues(stdout)) {
    if (isObj(v) && ("ProductVersion" in v || "DeviceName" in v)) {
      return { name: str(v, "DeviceName"), model: str(v, "ProductType"), version: str(v, "ProductVersion") };
    }
  }
  return null;
}
function parseNetworkInfo(stdout) {
  for (const v of jsonValues(stdout)) {
    if (isObj(v) && ("IPv4" in v || "IPv6" in v || "Mac" in v)) {
      return { ipv4: str(v, "IPv4"), ipv6: str(v, "IPv6"), mac: str(v, "Mac") };
    }
  }
  return { ipv4: "", ipv6: "", mac: "" };
}
function deviceLabel(udid, f) {
  if (!f) return { label: udid, description: "" };
  const name = f.name || udid;
  const description = [f.model, f.version ? `iOS ${f.version}` : ""].filter(Boolean).join(" · ");
  return { label: description ? `${name} — ${description}` : name, description };
}
const USAGE_LABELS = {
  NSCameraUsageDescription: "Camera",
  NSMicrophoneUsageDescription: "Microphone",
  NSPhotoLibraryUsageDescription: "Photos",
  NSPhotoLibraryAddUsageDescription: "Photos (add only)",
  NSContactsUsageDescription: "Contacts",
  NSLocationWhenInUseUsageDescription: "Location (in use)",
  NSLocationAlwaysUsageDescription: "Location (always)",
  NSLocationAlwaysAndWhenInUseUsageDescription: "Location (always)",
  NSCalendarsUsageDescription: "Calendars",
  NSCalendarsFullAccessUsageDescription: "Calendars",
  NSRemindersUsageDescription: "Reminders",
  NSRemindersFullAccessUsageDescription: "Reminders",
  NSMotionUsageDescription: "Motion & fitness",
  NSFaceIDUsageDescription: "Face ID",
  NSBluetoothAlwaysUsageDescription: "Bluetooth",
  NSBluetoothPeripheralUsageDescription: "Bluetooth",
  NSLocalNetworkUsageDescription: "Local network",
  NSAppleMusicUsageDescription: "Media library",
  NSSpeechRecognitionUsageDescription: "Speech recognition",
  NSHealthShareUsageDescription: "Health (read)",
  NSHealthUpdateUsageDescription: "Health (write)",
  NSUserTrackingUsageDescription: "Tracking (App Tracking Transparency)"
};
function parseUsage(o) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const [key2, label] of Object.entries(USAGE_LABELS)) {
    if (typeof o[key2] === "string" && !seen.has(label)) {
      seen.add(label);
      out.push([label, o[key2].trim()]);
    }
  }
  return out;
}
function normType(t) {
  return t === "User" || t === "System" || t === "Hidden" ? t : "Unknown";
}
function parseApps(stdout) {
  let arr = null;
  for (const v of jsonValues(stdout)) {
    if (Array.isArray(v)) {
      arr = v;
      break;
    }
  }
  if (!arr) return [];
  const out = [];
  for (const item of arr) {
    if (!isObj(item)) continue;
    const bundleId = str(item, "CFBundleIdentifier");
    if (!bundleId) continue;
    out.push({
      bundleId,
      name: str(item, "CFBundleDisplayName") || str(item, "CFBundleName") || bundleId,
      version: str(item, "CFBundleShortVersionString"),
      build: str(item, "CFBundleVersion"),
      type: normType(item.ApplicationType),
      minOS: str(item, "MinimumOSVersion"),
      signer: str(item, "SignerIdentity"),
      path: str(item, "Path"),
      container: str(item, "Container"),
      usage: parseUsage(item)
    });
  }
  out.sort((a, b) => {
    const la = a.name.toLowerCase();
    const lb = b.name.toLowerCase();
    return la < lb ? -1 : la > lb ? 1 : 0;
  });
  return out;
}
function listArgs() {
  return ["list", "--details"];
}
function wifiConnectionsArgs(udid, op) {
  return ["wificonnections", op, "--udid", udid];
}
function infoArgs(udid) {
  return ["info", "--udid", udid];
}
function ipArgs(udid) {
  return ["ip", "--udid", udid];
}
function appsArgs(udid, kind = "all") {
  const flags = kind === "all" ? ["--all"] : kind === "system" ? ["--system"] : [];
  return ["apps", ...flags, "--udid", udid];
}
function installArgs(udid, ipaPath) {
  return ["install", `--path=${ipaPath}`, "--udid", udid];
}
function uninstallArgs(udid, bundleId) {
  return ["uninstall", bundleId, "--udid", udid];
}
function iconArgs(udid, bundleId) {
  return ["get-app-icon", `--bundleid=${bundleId}`, "--udid", udid];
}
function parseAppIconDataUrl(stdout) {
  for (const v of jsonValues(stdout)) {
    if (!isObj(v)) continue;
    const b64 = str(v, "pngData");
    if (b64) return `data:image/png;base64,${b64}`;
  }
  return null;
}
function num(o, ...keys2) {
  for (const k of keys2) {
    const v = o[k];
    if (typeof v === "number") return v;
    if (typeof v === "string" && /^\d+$/.test(v)) return parseInt(v, 10);
  }
  return 0;
}
function parseProcesses(stdout) {
  for (const v of jsonValues(stdout)) {
    if (Array.isArray(v)) {
      const out = [];
      for (const item of v) {
        if (!isObj(item)) continue;
        const pid = num(item, "Pid", "pid", "ProcessIdentifier");
        const name = str(item, "Name") || str(item, "name") || str(item, "ExecutableName");
        if (!pid && !name) continue;
        out.push({
          pid,
          name,
          isApp: item.IsApplication === true || item.isApplication === true,
          path: str(item, "RealAppName") || str(item, "realAppName") || str(item, "Path"),
          startDate: str(item, "StartDate") || str(item, "startDate")
        });
      }
      return out.sort((a, b) => a.pid - b.pid);
    }
    if (isObj(v)) {
      const out = [];
      for (const [k, name] of Object.entries(v)) {
        if (/^\d+$/.test(k) && typeof name === "string") {
          out.push({ pid: parseInt(k, 10), name, isApp: false, path: "", startDate: "" });
        }
      }
      if (out.length) return out.sort((a, b) => a.pid - b.pid);
    }
  }
  return [];
}
function tunnelHasUdid(stdout, udid) {
  for (const v of jsonValues(stdout)) {
    if (Array.isArray(v)) {
      return v.some((e) => isObj(e) && str(e, "udid") === udid);
    }
  }
  return false;
}
function userspaceTunPort(stdout, udid) {
  for (const v of jsonValues(stdout)) {
    if (Array.isArray(v)) {
      const e = v.find((x) => isObj(x) && str(x, "udid") === udid);
      if (isObj(e)) {
        const p = num(e, "userspaceTunPort");
        return p > 0 ? p : null;
      }
    }
  }
  return null;
}
function psArgs(udid, appsOnly = false) {
  return ["ps", ...appsOnly ? ["--apps"] : [], "--udid", udid];
}
function launchArgs(udid, bundleId, killExisting = false) {
  return ["launch", bundleId, ...killExisting ? ["--kill-existing"] : [], "--udid", udid];
}
function killArgs(udid, bundleId) {
  return ["kill", bundleId, "--udid", udid];
}
function tunnelStartArgs() {
  return ["tunnel", "start", "--userspace"];
}
function tunnelLsArgs() {
  return ["tunnel", "ls"];
}
function imageListArgs(udid) {
  return ["image", "list", "--udid", udid];
}
function imageAutoArgs(udid, basedir) {
  return ["image", "auto", "--basedir", basedir, "--udid", udid];
}
function imageIsMounted(stdout) {
  return /"signature"\s*:/.test(stdout) || /image signature/i.test(stdout);
}
function setLocationArgs(udid, lat, lon) {
  return ["setlocation", `--lat=${lat}`, `--lon=${lon}`, "--udid", udid];
}
function syslogArgs(udid) {
  return ["syslog", "--udid", udid];
}
const SYSLOG_MONTHS = {
  Jan: "01",
  Feb: "02",
  Mar: "03",
  Apr: "04",
  May: "05",
  Jun: "06",
  Jul: "07",
  Aug: "08",
  Sep: "09",
  Oct: "10",
  Nov: "11",
  Dec: "12"
};
const SYSLOG_LEVEL = {
  debug: "D",
  info: "I",
  notice: "I",
  default: "I",
  warning: "W",
  warn: "W",
  error: "E",
  err: "E",
  fault: "F",
  critical: "F",
  alert: "F",
  emergency: "F"
};
const SYSLOG_RE = /^(\w{3}) +(\d+) (\d{2}:\d{2}:\d{2}) \S+ (.+?)\[(\d+)\] <([^>]+)>: ?([\s\S]*)$/;
function syslogToThreadtime(msg) {
  const m = SYSLOG_RE.exec(msg.trimEnd());
  if (!m) return null;
  const [, mon, day, time, proc2, pid, level, message] = m;
  const mm = SYSLOG_MONTHS[mon] ?? "01";
  const dd = day.padStart(2, "0");
  const lvl = SYSLOG_LEVEL[level.toLowerCase()] ?? "I";
  const tag = proc2.trim().replace(/:/g, "");
  return `${mm}-${dd} ${time}.000 ${pid} 0 ${lvl} ${tag}: ${message.trimStart()}`;
}
function batteryCheckArgs(udid) {
  return ["batterycheck", "--udid", udid];
}
function batteryRegistryArgs(udid) {
  return ["batteryregistry", "--udid", udid];
}
function diskspaceArgs(udid) {
  return ["diskspace", "--udid", udid];
}
function parseSysmontapCpu(line) {
  const t = line.trim();
  if (!t.startsWith("{")) return null;
  try {
    const o = JSON.parse(t);
    if (isObj(o) && o.msg === "received CPU usage data" && typeof o.cpu_total_load === "number") {
      return {
        cpuCount: typeof o.cpu_count === "number" ? o.cpu_count : 0,
        cpuTotalLoad: o.cpu_total_load,
        perCpu: Array.isArray(o.per_cpu) ? o.per_cpu.filter((x) => typeof x === "number") : [],
        memTotalKb: typeof o.mem_total_kb === "number" ? o.mem_total_kb : 0,
        memUsedKb: typeof o.mem_used_kb === "number" ? o.mem_used_kb : 0
      };
    }
  } catch {
  }
  return null;
}
function sysmontapCpuPercent(cpuTotalLoad, cpuCount) {
  if (cpuCount <= 0) return 0;
  return Math.max(0, Math.min(100, cpuTotalLoad / cpuCount));
}
function parseIosBattery(checkJson, registryJson) {
  const parse = (s) => {
    try {
      const o = JSON.parse(s.trim());
      return isObj(o) ? o : {};
    } catch {
      return {};
    }
  };
  const c = parse(checkJson);
  const r = parse(registryJson);
  const level = typeof c.BatteryCurrentCapacity === "number" ? c.BatteryCurrentCapacity : typeof r.CurrentCapacity === "number" ? r.CurrentCapacity : null;
  if (level === null) return null;
  const tempC = typeof r.Temperature === "number" ? r.Temperature / 100 : null;
  const powered = c.BatteryIsCharging === true || c.ExternalConnected === true || r.IsCharging === true;
  return { level, tempC, powered };
}
function fsyncTreeArgs(udid, bundleId, path = ".") {
  return ["fsync", `--app=${bundleId}`, "tree", `--path=${path}`, "--udid", udid];
}
function fsyncPullArgs(udid, bundleId, remote, local) {
  return ["fsync", `--app=${bundleId}`, "pull", `--srcPath=${remote}`, `--dstPath=${local}`, "--udid", udid];
}
function parseFsyncTree(stdout) {
  const out = [];
  const stack = [];
  for (const raw of stdout.split("\n")) {
    const m = /^((?:\|\s\s)*)\|-(.+)$/.exec(raw.replace(/\r$/, ""));
    if (!m) continue;
    const depth = m[1].length / 3;
    const isDir = m[2].endsWith("/");
    const name = isDir ? m[2].slice(0, -1) : m[2];
    if (!name || name === ".") continue;
    stack[depth] = name;
    stack.length = depth + 1;
    out.push({ path: stack.join("/"), name, isDir, depth });
  }
  return out;
}
const CA_PROFILE_IDENTIFIER = "com.androidlabkit.ca";
const CA_PROFILE_NAME = "MobileLabKit CA";
function profileAddArgs(udid, file) {
  return ["profile", "add", file, "--udid", udid];
}
function caMobileconfig(derBase64) {
  const CERT_UUID = "A11DAB00-0000-4000-8000-000000000001";
  const ROOT_UUID = "A11DAB00-0000-4000-8000-000000000002";
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>PayloadContent</key>",
    "  <array>",
    "    <dict>",
    "      <key>PayloadType</key><string>com.apple.security.root</string>",
    "      <key>PayloadVersion</key><integer>1</integer>",
    `      <key>PayloadIdentifier</key><string>${CA_PROFILE_IDENTIFIER}.cert</string>`,
    `      <key>PayloadUUID</key><string>${CERT_UUID}</string>`,
    `      <key>PayloadDisplayName</key><string>${CA_PROFILE_NAME}</string>`,
    "      <key>PayloadCertificateFileName</key><string>androidlabkit-ca.cer</string>",
    "      <key>PayloadContent</key>",
    `      <data>${derBase64}</data>`,
    "    </dict>",
    "  </array>",
    "  <key>PayloadType</key><string>Configuration</string>",
    "  <key>PayloadVersion</key><integer>1</integer>",
    `  <key>PayloadIdentifier</key><string>${CA_PROFILE_IDENTIFIER}</string>`,
    `  <key>PayloadUUID</key><string>${ROOT_UUID}</string>`,
    `  <key>PayloadDisplayName</key><string>${CA_PROFILE_NAME}</string>`,
    "  <key>PayloadDescription</key><string>Installs the MobileLabKit HTTPS-decryption certificate for network inspection.</string>",
    "  <key>PayloadRemovalDisallowed</key><false/>",
    "</dict>",
    "</plist>",
    ""
  ].join("\n");
}
const GOIOS_SUBDIR = {
  "darwin-arm64": "go-ios-darwin-arm64_darwin_arm64",
  "darwin-x64": "go-ios-darwin-amd64_darwin_amd64",
  "linux-arm64": "go-ios-linux-arm64_linux_arm64",
  "linux-x64": "go-ios-linux-amd64_linux_amd64",
  "win32-x64": "go-ios-windows-amd64_windows_amd64"
};
function binName() {
  return process.platform === "win32" ? "ios.exe" : "ios";
}
function nodeModulesCandidates() {
  const sub = GOIOS_SUBDIR[`${process.platform}-${process.arch}`];
  if (!sub) return [];
  const rel2 = node_path.join("node_modules", "go-ios", "dist", sub, binName());
  return [node_path.join(electron.app.getAppPath(), rel2), node_path.join(process.cwd(), rel2)];
}
function whichGoIos() {
  const paths = (process.env.PATH ?? "").split(node_path.delimiter);
  for (const dir of paths) {
    if (!dir) continue;
    const cand = node_path.join(dir, binName());
    if (node_fs.existsSync(cand)) return cand;
  }
  return null;
}
let cached;
function findGoIos() {
  if (cached !== void 0) return cached;
  const env = process.env.GO_IOS;
  if (env && node_fs.existsSync(env)) return cached = env;
  if (electron.app.isPackaged) {
    const bundled = node_path.join(process.resourcesPath, "go-ios", binName());
    if (node_fs.existsSync(bundled)) return cached = bundled;
  }
  for (const cand of nodeModulesCandidates()) {
    if (node_fs.existsSync(cand)) return cached = cand;
  }
  return cached = whichGoIos();
}
function run$2(bin, args, timeoutMs = 15e3) {
  return new Promise((resolve) => {
    node_child_process.execFile(
      bin,
      args,
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => {
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          code: err && typeof err.code === "number" ? err.code : err ? 1 : 0
        });
      }
    );
  });
}
function lastLine$3(stderr, stdout, fallback) {
  const out = (stderr || stdout || "").trim();
  if (!out) return fallback;
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? fallback;
}
function goiosError(stderr, stdout, fallback) {
  let best = "";
  for (const raw of `${stderr}
${stdout}`.split("\n")) {
    const s = raw.trim();
    if (!s.startsWith("{")) continue;
    try {
      const o = JSON.parse(s);
      const level = typeof o.level === "string" ? o.level.toUpperCase() : "";
      if (level !== "ERROR" && level !== "FATAL") continue;
      const msg = [o.err, o.msg].find((v) => typeof v === "string" && v);
      if (msg) best = msg;
    } catch {
    }
  }
  return best || lastLine$3(stderr, stdout, fallback);
}
async function listDevices(bin) {
  const entries = parseDeviceListDetails((await run$2(bin, listArgs(), 15e3)).stdout);
  const devices = [];
  for (const { udid, transports } of entries) {
    const info = parseInfo((await run$2(bin, infoArgs(udid), 1e4)).stdout);
    const { label, description } = deviceLabel(udid, info);
    devices.push({
      serial: udid,
      state: "device",
      description,
      online: true,
      label,
      platform: "ios",
      transports: transports.length ? transports : ["usb"]
    });
  }
  return devices;
}
async function wifiConnections(bin, udid, op) {
  const r = await run$2(bin, wifiConnectionsArgs(udid, op), 2e4);
  const enabled = parseWifiConnections(r.stdout);
  if (enabled === null) {
    const raw = goiosError(r.stderr, r.stdout, "Wi-Fi connection command failed");
    const message = /not found|no ios device/i.test(raw) ? "Device unreachable — it may have dropped off Wi-Fi. Reconnect it (or plug in over USB) and try again." : raw;
    return { ok: false, enabled: false, message };
  }
  return { ok: true, enabled, message: "" };
}
async function listApps(bin, udid) {
  const r = await run$2(bin, appsArgs(udid, "all"), 3e4);
  const apps = parseApps(r.stdout);
  if (apps.length === 0) {
    return { ok: false, apps: [], error: lastLine$3(r.stderr, r.stdout, "No apps returned") };
  }
  return { ok: true, apps, error: "" };
}
async function appIcon(bin, udid, bundleId) {
  const file = iconCacheFile$1(udid, bundleId);
  if (node_fs.existsSync(file)) {
    try {
      return { dataUrl: `data:image/png;base64,${node_fs.readFileSync(file).toString("base64")}`, unavailable: false };
    } catch {
    }
  }
  const r = await run$2(bin, iconArgs(udid, bundleId), 15e3).catch(() => ({ stdout: "", stderr: "" }));
  const dataUrl = parseAppIconDataUrl(r.stdout);
  if (dataUrl) {
    const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    try {
      node_fs.writeFileSync(file, Buffer.from(b64, "base64"));
    } catch {
    }
  }
  return { dataUrl, unavailable: false };
}
function iconCacheFile$1(udid, bundleId) {
  const safe = (s) => s.replace(/[^\w.-]/g, "_");
  const dir = node_path.join(electron.app.getPath("userData"), "ios-app-icons", safe(udid));
  node_fs.mkdirSync(dir, { recursive: true });
  return node_path.join(dir, `${safe(bundleId)}.png`);
}
async function install(bin, udid, ipaPath) {
  const r = await run$2(bin, installArgs(udid, ipaPath), 3e5);
  if (r.code === 0) return { ok: true, message: `Installed ${node_path.basename(ipaPath)}` };
  return { ok: false, message: lastLine$3(r.stderr, r.stdout, "Install failed") };
}
async function uninstall(bin, udid, bundleId) {
  const r = await run$2(bin, uninstallArgs(udid, bundleId), 6e4);
  if (r.code === 0) return { ok: true, message: `Uninstalled ${bundleId}` };
  return { ok: false, message: lastLine$3(r.stderr, r.stdout, "Uninstall failed") };
}
async function deviceInfo(bin, udid) {
  const [info, disk, reg, chk] = await Promise.all([
    run$2(bin, infoArgs(udid), 12e3),
    run$2(bin, diskspaceArgs(udid), 1e4),
    run$2(bin, batteryRegistryArgs(udid), 1e4),
    run$2(bin, batteryCheckArgs(udid), 1e4)
  ]);
  return parseDeviceInfo(info.stdout, disk.stdout, reg.stdout, chk.stdout);
}
async function deviceIp(bin, udid) {
  const r = await run$2(bin, ipArgs(udid), 16e3);
  return parseNetworkInfo(r.stdout);
}
let agentProc = null;
function delay$4(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function errMsg$5(e) {
  return e instanceof Error ? e.message : String(e);
}
function portOpen(port, timeoutMs = 2e3) {
  return new Promise((resolve) => {
    const sock2 = net.connect({ host: "127.0.0.1", port }, () => {
      sock2.destroy();
      resolve(true);
    });
    sock2.once("error", () => resolve(false));
    sock2.setTimeout(timeoutMs, () => {
      sock2.destroy();
      resolve(false);
    });
  });
}
async function tunnelHealthy(bin, udid) {
  const r = await run$2(bin, tunnelLsArgs(), 6e3);
  if (!tunnelHasUdid(r.stdout, udid)) return false;
  const port = userspaceTunPort(r.stdout, udid);
  if (port === null) return true;
  return portOpen(port);
}
const TUNNEL_INFO_PORT = 60105;
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function listGoIosTunnelPids(bin) {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      const q = "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'tunnel\\s+start' -and $_.CommandLine -match 'go-ios' } | ForEach-Object { $_.ProcessId }";
      node_child_process.execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", q],
        { timeout: 6e3 },
        (_e, out) => resolve(
          (out ?? "").split(/\r?\n/).map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n) && n > 0)
        )
      );
      return;
    }
    node_child_process.execFile("ps", ["-axww", "-o", "pid=,command="], { timeout: 6e3 }, (_e, out) => {
      const pids = [];
      for (const line of (out ?? "").split("\n")) {
        const m = /^\s*(\d+)\s+(.*)$/.exec(line);
        if (!m) continue;
        const cmd = m[2];
        if (/tunnel\s+start/.test(cmd) && (cmd.includes(bin) || cmd.includes("go-ios"))) {
          pids.push(parseInt(m[1], 10));
        }
      }
      resolve(pids);
    });
  });
}
async function sweepStaleTunnels(bin) {
  const own = agentProc?.pid;
  const exclude = (p) => p !== own && p !== process.pid;
  const byName = (await listGoIosTunnelPids(bin)).filter(exclude);
  const byPort = (await pidsOnPort(TUNNEL_INFO_PORT)).filter(exclude);
  const stale = [.../* @__PURE__ */ new Set([...byName, ...byPort])];
  if (stale.length === 0) return 0;
  console.error(`[go-ios] clearing ${stale.length} process(es) holding the tunnel port: ${stale.join(", ")}`);
  for (const pid of stale) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
    }
  }
  for (let i = 0; i < 20; i++) {
    if (!stale.some(pidAlive) && !await portOpen(TUNNEL_INFO_PORT, 400)) break;
    await delay$4(150);
  }
  return stale.length;
}
function pidsOnPort(port) {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      node_child_process.execFile("netstat", ["-ano", "-p", "tcp"], { timeout: 6e3 }, (_e, out) => {
        const pids = /* @__PURE__ */ new Set();
        for (const line of (out ?? "").split(/\r?\n/)) {
          if (new RegExp(`[:.]${port}\\b`).test(line) && /LISTENING/i.test(line)) {
            const m = /(\d+)\s*$/.exec(line.trim());
            if (m) pids.add(parseInt(m[1], 10));
          }
        }
        resolve([...pids]);
      });
      return;
    }
    node_child_process.execFile("lsof", ["-ti", `tcp:${port}`], { timeout: 6e3 }, (_e, out) => {
      resolve(
        (out ?? "").split(/\s+/).map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n) && n > 0)
      );
    });
  });
}
function spawnAgent(bin) {
  try {
    const child = node_child_process.spawn(bin, tunnelStartArgs(), {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, GOIOS_NETWORK_TUNNEL: "1" }
    });
    agentProc = child;
    let stderr = "";
    child.stderr?.on("data", (b) => {
      stderr += b.toString("utf8");
      if (stderr.length > 8192) stderr = stderr.slice(-8192);
    });
    child.on("error", () => {
      if (agentProc === child) agentProc = null;
    });
    child.on("exit", () => {
      if (agentProc === child) agentProc = null;
      if (/address already in use/i.test(stderr)) {
        console.error("[go-ios] tunnel agent exited: fixed port in use (a stale agent raced the spawn)");
      }
    });
    return { ok: true, message: "" };
  } catch (e) {
    return { ok: false, message: `Could not start developer tunnel: ${errMsg$5(e)}` };
  }
}
async function ensureAgent$1(bin) {
  if (agentProc && await portOpen(TUNNEL_INFO_PORT, 800)) return { ok: true, message: "agent active" };
  stopTunnel();
  for (let attempt = 0; attempt < 2; attempt++) {
    await sweepStaleTunnels(bin);
    const spawned = spawnAgent(bin);
    if (!spawned.ok) return spawned;
    for (let i = 0; i < 16; i++) {
      await delay$4(500);
      if (agentProc && await portOpen(TUNNEL_INFO_PORT, 500)) return { ok: true, message: "agent started" };
      if (agentProc === null) break;
    }
    stopTunnel();
  }
  return { ok: false, message: "Developer tunnel agent did not start (fixed port busy?)." };
}
async function ensureTunnel(bin, udid) {
  if (await tunnelHealthy(bin, udid)) return { ok: true, message: "tunnel active" };
  const agent = await ensureAgent$1(bin);
  if (!agent.ok) return agent;
  for (let i = 0; i < 24; i++) {
    await delay$4(500);
    if (await tunnelHealthy(bin, udid)) return { ok: true, message: "tunnel started" };
    if (agentProc === null) {
      const restart = await ensureAgent$1(bin);
      if (!restart.ok) return restart;
    }
  }
  return {
    ok: false,
    message: "Developer tunnel did not come up — check the device is unlocked, trusted, and has Developer Mode enabled."
  };
}
async function ensureAgentRunning(bin) {
  return ensureAgent$1(bin);
}
function stopTunnel() {
  const pid = agentProc?.pid;
  agentProc = null;
  if (pid) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
    }
  }
  freeTunnelPortSync();
}
function freeTunnelPortSync() {
  try {
    if (process.platform === "win32") return;
    const out = node_child_process.execFileSync("lsof", ["-ti", `tcp:${TUNNEL_INFO_PORT}`], { timeout: 3e3 }).toString();
    for (const s of out.split(/\s+/)) {
      const p = parseInt(s.trim(), 10);
      if (Number.isFinite(p) && p > 0 && p !== process.pid) {
        try {
          process.kill(p, "SIGKILL");
        } catch {
        }
      }
    }
  } catch {
  }
}
async function getTunnelStatus(bin, udid) {
  return { ready: await tunnelHealthy(bin, udid) };
}
async function startTunnel(bin, udid) {
  return ensureTunnel(bin, udid);
}
async function processes(bin, udid, appsOnly) {
  const ens = await ensureTunnel(bin, udid);
  if (!ens.ok) return { ok: false, processes: [], error: ens.message };
  const r = await run$2(bin, psArgs(udid, appsOnly), 2e4);
  const list2 = parseProcesses(r.stdout);
  if (list2.length === 0 && r.code !== 0) {
    return { ok: false, processes: [], error: lastLine$3(r.stderr, r.stdout, "Could not list processes") };
  }
  return { ok: true, processes: list2, error: "" };
}
async function launch(bin, udid, bundleId) {
  const ens = await ensureTunnel(bin, udid);
  if (!ens.ok) return { ok: false, message: ens.message };
  const r = await run$2(bin, launchArgs(udid, bundleId), 3e4);
  if (r.code === 0) {
    const m = /pid["\s:]+(\d+)/i.exec(`${r.stderr}
${r.stdout}`);
    return { ok: true, message: m ? `Launched (pid ${m[1]})` : `Launched ${bundleId}` };
  }
  return { ok: false, message: lastLine$3(r.stderr, r.stdout, "Launch failed") };
}
async function kill(bin, udid, bundleId) {
  const ens = await ensureTunnel(bin, udid);
  if (!ens.ok) return { ok: false, message: ens.message };
  const r = await run$2(bin, killArgs(udid, bundleId), 2e4);
  if (r.code === 0) return { ok: true, message: `Force-quit ${bundleId}` };
  return { ok: false, message: lastLine$3(r.stderr, r.stdout, "Force-quit failed") };
}
let mockProc = null;
function stopMockProc() {
  if (mockProc) {
    try {
      mockProc.kill("SIGINT");
    } catch {
    }
    mockProc = null;
  }
}
function ddiCacheDir() {
  const dir = node_path.join(electron.app.getPath("userData"), "ios-ddi");
  node_fs.mkdirSync(dir, { recursive: true });
  return dir;
}
async function imageMounted(bin, udid) {
  const r = await run$2(bin, imageListArgs(udid), 15e3);
  return imageIsMounted(`${r.stdout}
${r.stderr}`);
}
async function ensureImageMounted(bin, udid) {
  if (await imageMounted(bin, udid)) return { ok: true, message: "developer image mounted" };
  const r = await run$2(bin, imageAutoArgs(udid, ddiCacheDir()), 12e4);
  if (await imageMounted(bin, udid)) return { ok: true, message: "developer image mounted" };
  return {
    ok: false,
    message: lastLine$3(
      r.stderr,
      r.stdout,
      "Could not mount the Developer Disk Image — is Developer Mode on and the device unlocked?"
    )
  };
}
async function mockSetup(bin, udid) {
  const ens = await ensureTunnel(bin, udid);
  if (!ens.ok) return ens;
  return ensureImageMounted(bin, udid);
}
async function setLocation(bin, udid, lat, lon) {
  const ens = await ensureTunnel(bin, udid);
  if (!ens.ok) return ens;
  const mount = await ensureImageMounted(bin, udid);
  if (!mount.ok) return mount;
  stopMockProc();
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    let proc2;
    try {
      proc2 = node_child_process.spawn(bin, setLocationArgs(udid, lat, lon), { stdio: ["ignore", "ignore", "pipe"] });
    } catch (e) {
      return done({ ok: false, message: `Set location failed: ${errMsg$5(e)}` });
    }
    mockProc = proc2;
    let errBuf = "";
    proc2.stderr?.on("data", (d) => {
      errBuf += d.toString();
    });
    proc2.on("exit", () => {
      if (mockProc === proc2) {
        mockProc = null;
      }
      done({ ok: false, message: lastLine$3(errBuf, "", "Set location failed") });
    });
    setTimeout(() => done({ ok: true, message: `Mocking ${lat}, ${lon}` }), 1500);
  });
}
async function resetLocation(_bin, udid) {
  stopMockProc();
  return { ok: true, message: "Location reset" };
}
function shutdownMock() {
  stopMockProc();
}
let monitorProc = null;
let monitorBatteryTimer = null;
async function readBattery(bin, udid) {
  const [c, r] = await Promise.all([
    run$2(bin, batteryCheckArgs(udid), 8e3),
    run$2(bin, batteryRegistryArgs(udid), 8e3)
  ]);
  return parseIosBattery(c.stdout || c.stderr, r.stdout || r.stderr);
}
async function monitorStart(bin, udid, intervalMs, onSample, onFailed) {
  monitorStop();
  const ens = await ensureTunnel(bin, udid);
  if (!ens.ok) {
    onFailed(ens.message);
    return false;
  }
  let battery = await readBattery(bin, udid).catch(() => null);
  monitorBatteryTimer = setInterval(() => {
    void readBattery(bin, udid).then((b) => {
      if (b) battery = b;
    }).catch(() => {
    });
  }, 5e3);
  const proc2 = node_child_process.spawn(bin, ["sysmontap", "--udid", udid], { stdio: ["ignore", "ignore", "pipe"] });
  monitorProc = proc2;
  const throttle = Math.max(250, intervalMs);
  let buf = "";
  let lastEmit = 0;
  proc2.stderr?.on("data", (d) => {
    buf += d.toString();
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const s = parseSysmontapCpu(line);
      if (!s) continue;
      const now = Date.now();
      if (now - lastEmit < throttle) continue;
      lastEmit = now;
      onSample({
        cpu: sysmontapCpuPercent(s.cpuTotalLoad, s.cpuCount),
        mem: s.memTotalKb > 0 ? [s.memUsedKb, s.memTotalKb] : null,
        load: null,
        cores: s.cpuCount,
        coresPct: s.perCpu.length > 0 ? s.perCpu : null,
        battery,
        gfx: null,
        app: null
      });
    }
  });
  proc2.on("exit", (code) => {
    if (monitorProc === proc2) monitorProc = null;
    if (code && code !== 0) onFailed("sysmontap stopped unexpectedly");
  });
  return true;
}
function monitorStop() {
  if (monitorProc) {
    try {
      monitorProc.kill("SIGINT");
    } catch {
    }
    monitorProc = null;
  }
  if (monitorBatteryTimer) {
    clearInterval(monitorBatteryTimer);
    monitorBatteryTimer = null;
  }
}
let syslogProc = null;
function syslogRunning() {
  return syslogProc !== null;
}
function syslogStart(bin, udid, onLines, onState) {
  syslogStop();
  const proc2 = node_child_process.spawn(bin, syslogArgs(udid), { stdio: ["ignore", "pipe", "ignore"] });
  syslogProc = proc2;
  proc2.on("spawn", () => onState("started"));
  let buf = "";
  proc2.stdout?.on("data", (d) => {
    buf += d.toString();
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    const out = [];
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      let msg = t;
      try {
        const o = JSON.parse(t);
        if (o && typeof o.msg === "string") msg = o.msg;
      } catch {
      }
      const tt = syslogToThreadtime(msg);
      if (tt) out.push(tt);
    }
    if (out.length) onLines(out);
  });
  proc2.on("exit", () => {
    if (syslogProc === proc2) syslogProc = null;
    onState("stopped");
  });
  return true;
}
function syslogStop() {
  if (syslogProc) {
    try {
      syslogProc.kill();
    } catch {
    }
    syslogProc = null;
  }
}
function walkFiles(dir, out = []) {
  let entries;
  try {
    entries = node_fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = node_path.join(dir, name);
    try {
      if (node_fs.statSync(full).isDirectory()) walkFiles(full, out);
      else out.push(full);
    } catch {
    }
  }
  return out;
}
async function crashReports(bin, udid) {
  let dir;
  try {
    dir = node_fs.mkdtempSync(node_path.join(node_os.tmpdir(), "androidlab-ios-crash-"));
  } catch (e) {
    return { ok: false, message: `crash scan failed: ${errMsg$5(e)}`, items: [] };
  }
  try {
    await run$2(bin, ["crash", "cp", "*", dir, "--udid", udid], 9e4);
    const items = [];
    for (const f of walkFiles(dir)) {
      if (!/\.(ips|crash|panic|synced)$/i.test(f) && !/\.ips\./i.test(f)) continue;
      let raw;
      try {
        raw = node_fs.readFileSync(f, "utf8");
      } catch {
        continue;
      }
      const item = parseIpsReport(node_path.basename(f), raw);
      if (item) items.push(item);
    }
    items.sort((a, b) => a.when < b.when ? 1 : a.when > b.when ? -1 : 0);
    return { ok: true, message: `${items.length} report(s)`, items };
  } catch (e) {
    return { ok: false, message: `crash scan failed: ${errMsg$5(e)}`, items: [] };
  } finally {
    try {
      node_fs.rmSync(dir, { recursive: true, force: true });
    } catch {
    }
  }
}
function containerErr(combo) {
  if (/InstallationLookupFailed/i.test(combo)) {
    return "This app's container isn't accessible — iOS only opens containers for apps with File Sharing enabled or your own dev-signed apps.";
  }
  return combo.split("\n").map((l) => l.trim()).filter(Boolean).pop() || "Couldn't open the app container";
}
async function containerTree(bin, udid, bundleId, path = ".") {
  const r = await run$2(bin, fsyncTreeArgs(udid, bundleId, path), 3e4);
  const entries = parseFsyncTree(r.stdout);
  if (entries.length === 0 && /InstallationLookupFailed|no such|not found|failed/i.test(r.stderr + r.stdout)) {
    return { ok: false, entries: [], error: containerErr(r.stderr + r.stdout) };
  }
  return { ok: true, entries, error: "" };
}
async function containerPull(bin, udid, bundleId, remote, destDir) {
  node_fs.mkdirSync(destDir, { recursive: true });
  await run$2(bin, fsyncPullArgs(udid, bundleId, remote, destDir), 12e4);
  const file = node_path.join(destDir, node_path.basename(remote));
  return node_fs.existsSync(file) ? file : null;
}
async function iosPrefsList(bin, udid, bundleId) {
  const r = await run$2(bin, fsyncTreeArgs(udid, bundleId, "Library/Preferences"), 3e4);
  if (/InstallationLookupFailed/i.test(r.stderr + r.stdout)) {
    return { ok: false, files: [], error: containerErr(r.stderr + r.stdout), usedSu: false };
  }
  const files = [...new Set(r.stdout.match(/[A-Za-z0-9][^\s|/]*\.plist/g) ?? [])];
  return { ok: true, files, error: "", usedSu: false };
}
async function iosPrefsLoad(bin, udid, bundleId, fname) {
  const dir = node_fs.mkdtempSync(node_path.join(node_os.tmpdir(), "androidlab-ios-prefs-"));
  try {
    const inner = await containerPull(bin, udid, bundleId, `Library/Preferences/${fname}`, dir);
    if (!inner) return { ok: false, error: `Couldn't read ${fname} from the device`, fname, prefs: [] };
    let prefs;
    try {
      prefs = plistValueToPrefs(parsePlist(node_fs.readFileSync(inner)));
    } catch (e) {
      return { ok: false, error: `Couldn't decode ${fname}: ${errMsg$5(e)}`, fname, prefs: [] };
    }
    return { ok: true, error: "", fname, prefs };
  } catch (e) {
    return { ok: false, error: errMsg$5(e), fname, prefs: [] };
  } finally {
    try {
      node_fs.rmSync(dir, { recursive: true, force: true });
    } catch {
    }
  }
}
const DEFAULT_BUNDLE_ID = "com.androidlabkit.uiagent";
function defaultConfig() {
  return {
    method: "manual",
    // WDA is the wired runtime: go-ios can LAUNCH it (`runwda`) and we forward its
    // port. DeviceKit has no exposed launcher in go-ios, so `ui` can't reach it.
    agent: "wda",
    p12Path: "",
    p12Password: "",
    profilePath: "",
    keyId: "",
    issuerId: "",
    p8Path: "",
    bundleId: DEFAULT_BUNDLE_ID,
    provisioned: false
  };
}
function ascReady(c) {
  return !!(c.keyId.trim() && c.issuerId.trim() && c.p8Path.trim() && c.bundleId.trim());
}
function manualReady(c) {
  return !!(c.p12Path.trim() && c.profilePath.trim());
}
function provisionArgs(udid, s, p12Out, profileOut, profileName = "MobileLabKit UI Agent") {
  return [
    "sign",
    "provision",
    "appstoreconnect",
    `--bundleid=${s.bundleId}`,
    `--asc-key-id=${s.keyId}`,
    `--asc-issuer-id=${s.issuerId}`,
    `--asc-private-key=${s.p8Path}`,
    `--p12-output=${p12Out}`,
    `--profile-output=${profileOut}`,
    `--profile-name=${profileName}`,
    `--udid=${udid}`
  ];
}
function uiInstallArgs(udid, agent, p12, profile, p12password) {
  const a = ["ui", "install", agent, `--p12file=${p12}`, `--profile=${profile}`];
  if (p12password) a.push(`--p12password=${p12password}`);
  a.push(`--udid=${udid}`);
  return a;
}
const WDA_PORT = 8100;
const WDA_LOCAL_URL = `http://127.0.0.1:${WDA_PORT}`;
const WDA_XCTEST_CONFIG = "WebDriverAgentRunner.xctest";
function uiDriverFlags(d) {
  if (!d) return [];
  const f = [`--driver=${d.driver}`];
  if (d.driver === "wda" && d.wdaUrl) f.push(`--wda-url=${d.wdaUrl}`);
  if (d.driver === "devicekit" && d.devicekitUrl) f.push(`--devicekit-url=${d.devicekitUrl}`);
  return f;
}
function runWdaArgs(udid, bundleId) {
  return [
    "runwda",
    `--bundleid=${bundleId}`,
    `--testrunnerbundleid=${bundleId}`,
    `--xctestconfig=${WDA_XCTEST_CONFIG}`,
    `--udid=${udid}`
  ];
}
function forwardArgs(udid, hostPort, devicePort) {
  return ["forward", String(hostPort), String(devicePort), `--udid=${udid}`];
}
function appsListArgs(udid) {
  return ["apps", "--list", `--udid=${udid}`];
}
function findWdaBundleId(appsListStdout) {
  for (const line of appsListStdout.split("\n")) {
    const id = line.trim().split(/\s+/)[0];
    if (/WebDriverAgentRunner\.xctrunner$/i.test(id)) return id;
  }
  return null;
}
const DEVICEKIT_PORT = 12004;
const DEVICEKIT_WS_PATH = "/ws";
const DEVICEKIT_LOCAL_WS = `ws://127.0.0.1:${DEVICEKIT_PORT}${DEVICEKIT_WS_PATH}`;
const DEVICEKIT_XCTEST_CONFIG = "devicekit-iosUITests.xctest";
function runDeviceKitArgs(udid, bundleId) {
  return ["runtest", `--test-runner-bundle-id=${bundleId}`, `--xctest-config=${DEVICEKIT_XCTEST_CONFIG}`, `--udid=${udid}`];
}
function findDeviceKitBundleId(appsListStdout) {
  for (const line of appsListStdout.split("\n")) {
    const id = line.trim().split(/\s+/)[0];
    if (/devicekit-iosUITests\.xctrunner$/i.test(id)) return id;
  }
  return null;
}
function dkRpc(id, method, params) {
  return { jsonrpc: "2.0", id, method, params };
}
function dkTapParams(x, y) {
  return { x: Math.round(x), y: Math.round(y), deviceId: "any" };
}
function dkTextParams(text2) {
  return { text: text2, deviceId: "any" };
}
function dkButtonParams(name) {
  return { button: name, deviceId: "any" };
}
function dkGestureParams(actions) {
  return { actions, deviceId: "any" };
}
function dkKeysParams(keys2) {
  return { keys: keys2, deviceId: "any" };
}
const DK_NAMED = {
  Enter: "return",
  Backspace: "backspace",
  Delete: "forwarddelete",
  Tab: "tab",
  Escape: "escape",
  " ": "space",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Home: "home",
  End: "end",
  PageUp: "pageup",
  PageDown: "pagedown"
};
function deviceKitKey(domKey) {
  if (DK_NAMED[domKey]) return DK_NAMED[domKey];
  if (domKey.length === 1) return domKey;
  if (/^F([1-9]|1[0-2])$/.test(domKey)) return domKey.toLowerCase();
  return null;
}
const WDA_NAMED = {
  Enter: "",
  Backspace: "",
  Delete: "",
  Tab: "",
  Escape: "",
  " ": " ",
  ArrowUp: "",
  ArrowDown: "",
  ArrowLeft: "",
  ArrowRight: "",
  Home: "",
  End: "",
  PageUp: "",
  PageDown: ""
};
function wdaKeyValue(domKey) {
  if (WDA_NAMED[domKey]) return [WDA_NAMED[domKey]];
  if (domKey.length === 1) return [domKey];
  return null;
}
const MAX_GESTURE_POINTS = 40;
const MAX_POINTER_ACTION_POINTS = 6;
function pathToGestureActions(points, button2 = 0) {
  if (points.length === 0) return [];
  if (points.length === 1) {
    const p = points[0];
    return [
      { type: "press", duration: 0, x: Math.round(p.x), y: Math.round(p.y), button: button2 },
      { type: "release", duration: 0, x: Math.round(p.x), y: Math.round(p.y), button: button2 }
    ];
  }
  let kept = points;
  if (points.length > MAX_GESTURE_POINTS) {
    kept = [];
    const step = (points.length - 1) / (MAX_GESTURE_POINTS - 1);
    for (let i = 0; i < MAX_GESTURE_POINTS; i++) kept.push(points[Math.round(i * step)]);
    kept[kept.length - 1] = points[points.length - 1];
  }
  const actions = [{ type: "press", duration: 0, x: Math.round(kept[0].x), y: Math.round(kept[0].y), button: button2 }];
  for (let i = 1; i < kept.length; i++) {
    const dtSec = Math.max(0, (kept[i].t - kept[i - 1].t) / 1e3);
    actions.push({ type: "move", duration: dtSec, x: Math.round(kept[i].x), y: Math.round(kept[i].y), button: button2 });
  }
  const last = kept[kept.length - 1];
  actions.push({ type: "release", duration: 0, x: Math.round(last.x), y: Math.round(last.y), button: button2 });
  return actions;
}
function pathToPointerActions(points, maxPoints = MAX_POINTER_ACTION_POINTS) {
  if (points.length === 0) return [];
  const round = (p) => ({ x: Math.round(p.x), y: Math.round(p.y) });
  if (points.length === 1) {
    const p = round(points[0]);
    return [
      { type: "pointerMove", duration: 0, x: p.x, y: p.y },
      { type: "pointerDown", button: 0 },
      { type: "pointerUp", button: 0 }
    ];
  }
  let kept = points;
  if (points.length > maxPoints) {
    kept = [];
    const step = (points.length - 1) / (maxPoints - 1);
    for (let i = 0; i < maxPoints; i++) kept.push(points[Math.round(i * step)]);
    kept[kept.length - 1] = points[points.length - 1];
  }
  const first = round(kept[0]);
  const items = [
    { type: "pointerMove", duration: 0, x: first.x, y: first.y },
    { type: "pointerDown", button: 0 }
  ];
  for (let i = 1; i < kept.length; i++) {
    const p = round(kept[i]);
    const dtMs = Math.max(0, Math.round(kept[i].t - kept[i - 1].t));
    items.push({ type: "pointerMove", duration: dtMs, x: p.x, y: p.y });
  }
  items.push({ type: "pointerUp", button: 0 });
  return items;
}
function uiStatusArgs(udid, d) {
  return ["ui", "status", `--udid=${udid}`, ...uiDriverFlags(d)];
}
function uiSizeArgs(udid, d) {
  return ["ui", "size", `--udid=${udid}`, ...uiDriverFlags(d)];
}
function parseUiSize(stdout) {
  const num2 = (re) => {
    const m = re.exec(stdout);
    return m ? Number(m[1]) : null;
  };
  const w = num2(/"width"\s*:\s*(\d+(?:\.\d+)?)/i);
  const h = num2(/"height"\s*:\s*(\d+(?:\.\d+)?)/i);
  if (w == null || h == null || w <= 0 || h <= 0) return null;
  return { width: Math.round(w), height: Math.round(h) };
}
const delay$3 = (ms) => new Promise((r) => setTimeout(r, ms));
let proc = null;
let fwd = null;
let dkUdid = null;
let sock = null;
let connecting = null;
let rpcId = 1;
const pending = /* @__PURE__ */ new Map();
function run$1(bin, args, timeout = 3e4) {
  return new Promise((resolve) => {
    node_child_process.execFile(bin, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      const code = err && typeof err.code === "number" ? err.code : err ? 1 : 0;
      resolve({ code, stdout: stdout ?? "" });
    });
  });
}
function health(timeout = 4e3) {
  return new Promise((resolve) => {
    const req = node_http.request({ host: "127.0.0.1", port: DEVICEKIT_PORT, path: "/health", method: "GET", timeout }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(/ok/i.test(Buffer.concat(chunks).toString("utf8"))));
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}
function stop() {
  if (sock) {
    try {
      sock.close();
    } catch {
    }
    sock = null;
  }
  for (const p of [proc, fwd]) {
    if (p) {
      try {
        p.kill("SIGTERM");
      } catch {
      }
    }
  }
  proc = null;
  fwd = null;
  dkUdid = null;
  pending.clear();
}
function connect() {
  if (sock && sock.readyState === WebSocket.OPEN) return Promise.resolve(true);
  if (connecting) return connecting;
  connecting = new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    const s = new WebSocket(DEVICEKIT_LOCAL_WS);
    s.on("open", () => {
      sock = s;
      finish(true);
    });
    s.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        const id = typeof msg.id === "number" ? msg.id : null;
        if (id != null) {
          const cb = pending.get(id);
          if (cb) {
            pending.delete(id);
            cb(msg);
          }
        }
      } catch {
      }
    });
    s.on("close", () => {
      if (sock === s) sock = null;
    });
    s.on("error", () => finish(false));
    setTimeout(() => {
      if (!done) {
        try {
          s.close();
        } catch {
        }
        finish(false);
      }
    }, 8e3);
  }).finally(() => {
    connecting = null;
  });
  return connecting;
}
async function call(method, params, timeout = 15e3) {
  if (!await connect()) return null;
  const s = sock;
  if (!s || s.readyState !== WebSocket.OPEN) return null;
  return new Promise((resolve) => {
    const id = rpcId++;
    const t = setTimeout(() => {
      pending.delete(id);
      resolve(null);
    }, timeout);
    pending.set(id, (msg) => {
      clearTimeout(t);
      resolve(msg);
    });
    try {
      s.send(JSON.stringify(dkRpc(id, method, params)));
    } catch {
      clearTimeout(t);
      pending.delete(id);
      resolve(null);
    }
  });
}
function reachable() {
  return !!proc && !!fwd && !!sock && sock.readyState === WebSocket.OPEN;
}
async function ensure(bin, udid, onProgress = () => {
}) {
  if (dkUdid && dkUdid !== udid) stop();
  const tun = await startTunnel(bin, udid);
  if (!tun.ok) return false;
  if (reachable() && dkUdid === udid && await health()) return true;
  const apps = await run$1(bin, appsListArgs(udid));
  const bundle = findDeviceKitBundleId(apps.stdout);
  if (!bundle) {
    onProgress("  agent: DeviceKit not installed — falling back to WebDriverAgent.");
    return false;
  }
  onProgress(`  agent: launching DeviceKit ${bundle}…`);
  stop();
  dkUdid = udid;
  proc = node_child_process.spawn(bin, runDeviceKitArgs(udid, bundle), { stdio: "ignore" });
  proc.on("error", () => {
  });
  proc.on("exit", () => {
    if (dkUdid === udid) proc = null;
  });
  fwd = node_child_process.spawn(bin, forwardArgs(udid, DEVICEKIT_PORT, DEVICEKIT_PORT), { stdio: "ignore" });
  fwd.on("error", () => {
  });
  for (let i = 0; i < 18; i++) {
    if (dkUdid !== udid) return false;
    await delay$3(2e3);
    if (!proc) {
      onProgress("  agent: the DeviceKit runner exited early — check signing/Trust on the device.");
      return false;
    }
    if (await health()) {
      if (await connect()) {
        onProgress("  agent: DeviceKit ready (WebSocket).");
        return true;
      }
    }
  }
  onProgress("  agent: DeviceKit not ready (timed out).");
  return false;
}
function tap$1(x, y) {
  return call("device.io.tap", dkTapParams(x, y), 8e3);
}
function gesture$1(actions) {
  return call("device.io.gesture", dkGestureParams(actions), 2e4);
}
function text(s) {
  return call("device.io.text", dkTextParams(s), 12e3);
}
function keys(combos) {
  return call("device.io.keys", dkKeysParams(combos), 8e3);
}
function button$1(name) {
  return call("device.io.button", dkButtonParams(name), 8e3);
}
function rel(path) {
  const p = path.replace(/^\/+/, "");
  return p === "" ? "." : p;
}
function remoteOf(path, name) {
  const base = rel(path);
  return base === "." ? name : `${base}/${name}`;
}
let tmpDir = null;
function tmp() {
  if (!tmpDir) tmpDir = node_fs.mkdtempSync(node_path.join(node_os.tmpdir(), "androidlab-iosfiles-"));
  return tmpDir;
}
async function list(bin, udid, pkg, path) {
  const t = await containerTree(bin, udid, pkg, rel(path));
  if (!t.ok) return { ok: false, path, entries: [], error: t.error, usedSu: false };
  const minDepth = t.entries.length ? Math.min(...t.entries.map((e) => e.depth)) : 0;
  const entries = t.entries.filter((e) => e.depth === minDepth).map((e) => ({
    name: e.name,
    kind: e.isDir ? "dir" : "file",
    size: null,
    mode: "",
    linkTarget: null,
    modified: ""
  }));
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    const la = a.name.toLowerCase();
    const lb = b.name.toLowerCase();
    return la < lb ? -1 : la > lb ? 1 : 0;
  });
  return { ok: true, path, entries, error: "", usedSu: false };
}
async function pull(bin, udid, pkg, path, items, destDir) {
  const pulled = [];
  const failed = [];
  for (const it of items) {
    const got = await containerPull(bin, udid, pkg, remoteOf(path, it.name), destDir);
    if (got) pulled.push(it.name);
    else failed.push(it.name);
  }
  const ok = pulled.length > 0 && failed.length === 0;
  let message;
  if (pulled.length) {
    message = `Pulled ${pulled.length} item(s) to ${destDir}`;
    if (failed.length) message += `  (${failed.length} failed: ${failed.join(", ")})`;
  } else {
    message = `Pull failed: ${failed.join(", ") || "nothing pulled"}`;
  }
  return { ok, message, dir: destDir };
}
async function openEntry(bin, udid, pkg, path, name, _kind) {
  const local = await containerPull(bin, udid, pkg, remoteOf(path, name), tmp());
  if (!local || !node_fs.existsSync(local)) return { ok: false, message: `Couldn't open ${name}`, localPath: "" };
  await electron.shell.openPath(local);
  return { ok: true, message: `Opened ${name}`, localPath: local };
}
function shutdown$1() {
  if (tmpDir) {
    try {
      node_fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
    }
    tmpDir = null;
  }
}
const NEWLINE = 10;
class LogcatReader {
  constructor(adb, cb) {
    this.adb = adb;
    this.cb = cb;
  }
  proc = null;
  buf = Buffer.alloc(0);
  get running() {
    return this.proc !== null && this.proc.exitCode === null && !this.proc.killed;
  }
  start(serial, clearFirst = false) {
    this.stop();
    if (clearFirst) {
      try {
        node_child_process.execFile(this.adb, ["-s", serial, "logcat", "-c"], { timeout: 8e3 }, () => {
        });
      } catch {
      }
    }
    this.buf = Buffer.alloc(0);
    const proc2 = node_child_process.spawn(this.adb, ["-s", serial, "logcat", "-v", "threadtime"]);
    this.proc = proc2;
    proc2.on("spawn", () => this.cb.onState("started"));
    proc2.stdout.on("data", (chunk) => this.onStdout(chunk));
    proc2.stderr.on("data", (chunk) => {
      const data = chunk.toString("utf8").trim();
      if (data) this.cb.onError(data);
    });
    proc2.on("close", () => {
      if (this.proc === proc2) this.proc = null;
      this.cb.onState("stopped");
    });
    proc2.on("error", (err) => {
      this.cb.onError(`process error: ${err.message}`);
      this.cb.onState("error");
    });
  }
  stop() {
    if (this.proc !== null) {
      const proc2 = this.proc;
      this.proc = null;
      proc2.stdout.removeAllListeners("data");
      proc2.kill("SIGKILL");
      this.cb.onState("stopped");
    }
  }
  onStdout(chunk) {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const lastNl = this.buf.lastIndexOf(NEWLINE);
    if (lastNl < 0) return;
    const complete = this.buf.subarray(0, lastNl);
    this.buf = this.buf.subarray(lastNl + 1);
    const text2 = complete.toString("utf8");
    const lines = text2.split("\n");
    if (lines.length > 0) this.cb.onLines(lines);
  }
}
let ptyMod;
function loadPty() {
  if (ptyMod !== void 0) return ptyMod;
  try {
    ptyMod = require("node-pty");
  } catch {
    ptyMod = null;
  }
  return ptyMod;
}
class ShellSession {
  constructor(adb, cb) {
    this.adb = adb;
    this.cb = cb;
  }
  proc = null;
  get running() {
    return this.proc !== null;
  }
  start(kind, serial, cols, rows) {
    this.stop();
    const p = loadPty();
    if (!p) {
      this.cb.onData(
        "\r\n\x1B[31m[shell unavailable: node-pty failed to load — run `npm run rebuild`]\x1B[0m\r\n"
      );
      this.cb.onState("error");
      return;
    }
    const [file, args] = kind === "local" ? [process.env.SHELL || "/bin/zsh", ["-l"]] : [this.adb, ["-s", serial, "shell"]];
    const proc2 = p.spawn(file, args, {
      name: "xterm-256color",
      cols: cols > 0 ? cols : 80,
      rows: rows > 0 ? rows : 24,
      cwd: process.env.HOME,
      env: process.env
    });
    this.proc = proc2;
    this.cb.onState("started");
    proc2.onData((d) => this.cb.onData(d));
    proc2.onExit(() => {
      if (this.proc === proc2) this.proc = null;
      this.cb.onState("stopped");
    });
  }
  /** Forward raw keystrokes (incl. Ctrl-C = \x03, arrows, etc.) to the pty. */
  write(data) {
    this.proc?.write(data);
  }
  resize(cols, rows) {
    if (this.proc && cols > 0 && rows > 0) {
      try {
        this.proc.resize(cols, rows);
      } catch {
      }
    }
  }
  stop() {
    if (this.proc !== null) {
      const proc2 = this.proc;
      this.proc = null;
      try {
        proc2.kill();
      } catch {
      }
      this.cb.onState("stopped");
    }
  }
  shutdown() {
    this.stop();
  }
}
const PROBE = "cat /proc/stat /proc/meminfo /proc/loadavg";
const CPU_MARK = "@@CPU@@";
const MEM_MARK = "@@MEM@@";
const BAT_MARK = "@@BAT@@";
const GFX_MARK = "@@GFX@@";
const LOADAVG_RE = /^\s*(\d+\.\d+)\s+(\d+\.\d+)\s+(\d+\.\d+)/;
const APP_CPU_RE = /^\s*([\d.]+)%\s+\d+\/(\S+?):/gm;
function shellQuote(s) {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
function buildProbe(pkg) {
  let script = PROBE;
  if (pkg) {
    const q = shellQuote(pkg);
    script += `; echo ${CPU_MARK}; dumpsys cpuinfo 2>/dev/null; echo ${MEM_MARK}; dumpsys meminfo ${q} 2>/dev/null`;
  }
  script += `; echo ${BAT_MARK}; dumpsys battery 2>/dev/null`;
  if (pkg) {
    const q = shellQuote(pkg);
    script += `; echo ${GFX_MARK}; dumpsys gfxinfo ${q} 2>/dev/null`;
  }
  return script;
}
const digits = (tokens) => tokens.filter((x) => /^\d+$/.test(x)).map(Number);
function parseBattery(text2) {
  const m = /level:\s*(\d+)/.exec(text2);
  if (!m) return null;
  const out = {
    level: parseInt(m[1], 10),
    tempC: null,
    powered: /(AC|USB|Wireless) powered: true/.test(text2)
  };
  const t = /temperature:\s*(-?\d+)/.exec(text2);
  if (t) out.tempC = parseInt(t[1], 10) / 10;
  return out;
}
function parseGfxinfo(text2) {
  const total = /Total frames rendered:\s*(\d+)/.exec(text2);
  if (!total) return null;
  const out = { total: parseInt(total[1], 10), janky: 0, jankyPct: 0 };
  const j = /Janky frames:\s*(\d+)\s*\(([\d.]+)%\)/.exec(text2);
  if (j) {
    out.janky = parseInt(j[1], 10);
    out.jankyPct = parseFloat(j[2]);
  }
  for (const pct of [50, 90, 95, 99]) {
    const m = new RegExp(`${pct}th percentile:\\s*(\\d+)ms`).exec(text2);
    if (m) out[`p${pct}`] = parseInt(m[1], 10);
  }
  return out;
}
function parseAppCpu(text2, pkg) {
  let total = null;
  APP_CPU_RE.lastIndex = 0;
  let m;
  while ((m = APP_CPU_RE.exec(text2)) !== null) {
    if (m[2].split(":", 1)[0] === pkg) total = (total ?? 0) + parseFloat(m[1]);
  }
  return total;
}
function parseAppMeminfo(text2) {
  const m = /TOTAL PSS:\s*(\d+)/.exec(text2);
  if (m) return parseInt(m[1], 10);
  const m2 = /^\s*TOTAL\s+(\d+)/m.exec(text2);
  return m2 ? parseInt(m2[1], 10) : null;
}
function parseCpuStat(text2) {
  for (const line of text2.split("\n")) {
    const parts = line.split(/\s+/).filter(Boolean);
    if (parts.length > 0 && parts[0] === "cpu") {
      const nums = digits(parts.slice(1));
      if (nums.length < 4) return null;
      const idle = nums[3] + (nums.length > 4 ? nums[4] : 0);
      return [nums.reduce((a, b) => a + b, 0), idle];
    }
  }
  return null;
}
function cpuCoreCount(text2) {
  let n = 0;
  for (const l of text2.split("\n")) if (/^cpu\d+\b/.test(l)) n++;
  return n;
}
function parseCpuCores(text2) {
  const cores = [];
  for (const line of text2.split("\n")) {
    const m = /^cpu(\d+)\b/.exec(line);
    if (!m) continue;
    const nums = digits(line.split(/\s+/).filter(Boolean).slice(1));
    if (nums.length >= 4) {
      const idle = nums[3] + (nums.length > 4 ? nums[4] : 0);
      cores.push([parseInt(m[1], 10), nums.reduce((a, b) => a + b, 0), idle]);
    }
  }
  cores.sort((a, b) => a[0] - b[0]);
  return cores.map(([, t, i]) => [t, i]);
}
const MEM_WANT = {
  MemTotal: "total",
  MemAvailable: "available",
  MemFree: "free",
  Buffers: "buffers",
  Cached: "cached",
  SwapTotal: "swap_total",
  SwapFree: "swap_free"
};
function parseMeminfo(text2) {
  const out = {};
  for (const line of text2.split("\n")) {
    const ci = line.indexOf(":");
    if (ci < 0) continue;
    const key2 = line.slice(0, ci);
    if (key2 in MEM_WANT) {
      const tok = line.slice(ci + 1).trim().split(/\s+/);
      if (tok[0] && /^\d+$/.test(tok[0])) out[MEM_WANT[key2]] = parseInt(tok[0], 10);
    }
  }
  return out;
}
function memUsedKb(info) {
  const total = info.total;
  if (!total) return null;
  let used;
  if ("available" in info) used = total - info.available;
  else used = total - (info.free ?? 0) - (info.buffers ?? 0) - (info.cached ?? 0);
  return [Math.max(0, used), total];
}
function parseLoadavg(text2) {
  for (const line of text2.split("\n")) {
    const m = LOADAVG_RE.exec(line);
    if (m) return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])];
  }
  return null;
}
function cpuPercent(prev, cur) {
  if (!prev || !cur) return null;
  const dt = cur[0] - prev[0];
  const di = cur[1] - prev[1];
  if (dt <= 0) return null;
  return Math.max(0, Math.min(100, 100 * (dt - di) / dt));
}
function partition(s, sep) {
  const i = s.indexOf(sep);
  return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i + sep.length)];
}
class MonitorService {
  constructor(adb, cb) {
    this.adb = adb;
    this.cb = cb;
  }
  running = false;
  timer = null;
  serial = "";
  pkg = null;
  interval = 1e3;
  prevCpu = null;
  prevCores = [];
  prevGfx = null;
  start(serial, pkg, intervalMs) {
    this.stop();
    this.serial = serial;
    this.pkg = pkg || null;
    this.interval = Math.max(250, intervalMs);
    this.prevCpu = null;
    this.prevCores = [];
    this.prevGfx = null;
    this.running = true;
    void this.tick();
  }
  stop() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
  tick = async () => {
    if (!this.running) return;
    const probe = buildProbe(this.pkg);
    const r = await run$3(this.adb, this.serial, ["shell", probe], 1e4);
    if (!this.running) return;
    if (!r.stdout && r.stderr) {
      this.cb.onFailed(r.stderr.trim() || "device read failed");
      this.stop();
      return;
    }
    let text2 = r.stdout;
    let gfxTxt;
    let batTxt;
    [text2, gfxTxt] = partition(text2, GFX_MARK);
    [text2, batTxt] = partition(text2, BAT_MARK);
    const battery = parseBattery(batTxt);
    let gfx = null;
    let app = null;
    if (this.pkg) {
      gfx = parseGfxinfo(gfxTxt);
      if (gfx !== null) {
        if (this.prevGfx && gfx.total > this.prevGfx.total) {
          const df = gfx.total - this.prevGfx.total;
          const dj = Math.max(0, gfx.janky - this.prevGfx.janky);
          gfx.recentPct = 100 * dj / df;
        }
        this.prevGfx = { total: gfx.total, janky: gfx.janky };
      }
      let rest;
      [text2, rest] = partition(text2, CPU_MARK);
      const [cpuTxt, memTxt] = partition(rest, MEM_MARK);
      const acpu = parseAppCpu(cpuTxt, this.pkg);
      const amem = parseAppMeminfo(memTxt);
      app = { cpu: acpu, memKb: amem, running: acpu !== null || amem !== null };
    }
    const curCpu = parseCpuStat(text2);
    const pct = cpuPercent(this.prevCpu, curCpu);
    if (curCpu) this.prevCpu = curCpu;
    const curCores = parseCpuCores(text2);
    let coresPct = null;
    if (this.prevCores.length > 0 && this.prevCores.length === curCores.length) {
      coresPct = curCores.map((c, i) => cpuPercent(this.prevCores[i], c));
    }
    if (curCores.length > 0) this.prevCores = curCores;
    this.cb.onSample({
      cpu: pct,
      mem: memUsedKb(parseMeminfo(text2)),
      load: parseLoadavg(text2),
      cores: cpuCoreCount(text2),
      coresPct,
      battery,
      gfx,
      app
    });
    if (this.running) this.timer = setTimeout(this.tick, this.interval);
  };
}
const SHARK_VERSION = "2.14";
const SHARK_MAIN = "shark.MainKt";
const MAVEN = "https://repo1.maven.org/maven2";
const REMOTE_HPROF = "/data/local/tmp/androidlab-leak.hprof";
const SHARK_JARS = [
  ["com/squareup/leakcanary", "shark-cli", SHARK_VERSION],
  ["com/squareup/leakcanary", "shark-android", SHARK_VERSION],
  ["com/squareup/leakcanary", "shark", SHARK_VERSION],
  ["com/squareup/leakcanary", "shark-graph", SHARK_VERSION],
  ["com/squareup/leakcanary", "shark-hprof", SHARK_VERSION],
  ["com/squareup/leakcanary", "shark-log", SHARK_VERSION],
  ["org/jetbrains/kotlin", "kotlin-stdlib", "1.3.72"],
  ["org/jetbrains/kotlin", "kotlin-reflect", "1.3.72"],
  ["org/jetbrains", "annotations", "13.0"],
  ["com/squareup/okio", "okio", "2.2.2"],
  ["com/github/ajalt", "clikt", "2.3.0"],
  ["jline", "jline", "2.14.6"]
];
function jarFilename(artifact, version) {
  return `${artifact}-${version}.jar`;
}
function jarUrl([path, artifact, version]) {
  return `${MAVEN}/${path}/${artifact}/${version}/${jarFilename(artifact, version)}`;
}
function adoptiumUrl(machine) {
  const arch = ["arm64", "aarch64"].includes(machine.toLowerCase()) ? "aarch64" : "x64";
  return `https://api.adoptium.net/v3/binary/latest/21/ga/mac/${arch}/jre/hotspot/normal/eclipse`;
}
function heapDumpFailed(blob) {
  const b = blob.toLowerCase();
  return ["not debuggable", "unknown package", "no process", "exception", "permission deni"].some(
    (k) => b.includes(k)
  );
}
function isValidReport(report) {
  return report.includes("APPLICATION LEAKS");
}
class CancelledError extends Error {
  constructor() {
    super("Cancelled");
    this.name = "CancelledError";
  }
}
function toolsDir() {
  const d = node_path.join(electron.app.getPath("userData"), "tools");
  node_fs.mkdirSync(d, { recursive: true });
  return d;
}
function findUnder(root, name, sub) {
  if (!node_fs.existsSync(root)) return null;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = node_fs.readdirSync(dir);
    } catch {
      continue;
    }
    if (dir.endsWith(`/${sub}`) && entries.includes(name)) return node_path.join(dir, name);
    for (const e of entries) {
      const p = node_path.join(dir, e);
      try {
        if (node_fs.statSync(p).isDirectory()) stack.push(p);
      } catch {
      }
    }
  }
  return null;
}
function checkJava(path) {
  return new Promise((resolve) => {
    if (!path || !node_fs.existsSync(path)) {
      resolve(false);
      return;
    }
    node_child_process.execFile(path, ["-version"], { timeout: 1e4 }, (err) => resolve(!err));
  });
}
async function systemJava() {
  const home = process.env.JAVA_HOME;
  if (home) {
    const cand = node_path.join(home, "bin", "java");
    if (await checkJava(cand)) return cand;
  }
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const cand = node_path.join(dir, "java");
    if (node_fs.existsSync(cand) && await checkJava(cand)) return cand;
  }
  if (await checkJava("/usr/bin/java")) return "/usr/bin/java";
  return null;
}
function cachedJreJava() {
  return findUnder(node_path.join(toolsDir(), "jre"), "java", "bin");
}
function downloadFile(url, dest, progress, isCancelled, label) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      try {
        if (node_fs.existsSync(dest)) node_fs.rmSync(dest);
      } catch {
      }
    };
    const fail = (e) => {
      cleanup();
      reject(e);
    };
    let redirects = 0;
    const request = (u) => {
      if (isCancelled()) {
        fail(new CancelledError());
        return;
      }
      const req = node_https.get(u, { headers: { "User-Agent": "MobileLabKit" } }, (res) => {
        const status2 = res.statusCode ?? 0;
        if (status2 >= 300 && status2 < 400 && res.headers.location) {
          res.resume();
          if (++redirects > 8) {
            fail(new Error("too many redirects"));
            return;
          }
          request(new URL(res.headers.location, u).toString());
          return;
        }
        if (status2 !== 200) {
          res.resume();
          fail(new Error(`HTTP ${status2}`));
          return;
        }
        const total = parseInt(res.headers["content-length"] ?? "0", 10);
        let got = 0;
        const file = node_fs.createWriteStream(dest);
        res.on("data", (chunk) => {
          if (isCancelled()) {
            req.destroy();
            file.destroy();
            fail(new CancelledError());
            return;
          }
          got += chunk.length;
          const mb = (got / 1e6).toFixed(1);
          progress(total ? `${label}: ${mb} / ${(total / 1e6).toFixed(1)} MB` : `${label}: ${mb} MB`);
        });
        res.pipe(file);
        file.on("finish", () => file.close(() => resolve()));
        file.on("error", (e) => fail(e));
      });
      req.on("error", (e) => fail(e));
    };
    request(url);
  });
}
function extractTarGz(tgz, dest) {
  return new Promise((resolve, reject) => {
    node_fs.mkdirSync(dest, { recursive: true });
    node_child_process.execFile(
      "tar",
      ["-xzf", tgz, "-C", dest],
      { timeout: 12e4 },
      (err) => err ? reject(err) : resolve()
    );
  });
}
async function downloadJre(progress, isCancelled) {
  const dst = node_path.join(toolsDir(), "jre");
  const tgz = node_path.join(toolsDir(), "jre.tar.gz");
  try {
    progress("Downloading Java runtime…");
    await downloadFile(adoptiumUrl(node_os.arch()), tgz, progress, isCancelled, "JRE");
    progress("Extracting Java runtime…");
    node_fs.rmSync(dst, { recursive: true, force: true });
    await extractTarGz(tgz, dst);
  } catch (e) {
    if (e instanceof CancelledError) throw e;
    return null;
  } finally {
    try {
      if (node_fs.existsSync(tgz)) node_fs.rmSync(tgz);
    } catch {
    }
  }
  return findUnder(dst, "java", "bin");
}
async function provisionJava(progress, isCancelled) {
  let java = await systemJava() ?? cachedJreJava();
  if (!java) java = await downloadJre(progress, isCancelled);
  if (!java) {
    throw new Error(
      "Java not found and the JRE download failed. Install Java (e.g. `brew install openjdk`) or set JAVA_HOME."
    );
  }
  return java;
}
function sharkDir() {
  const d = node_path.join(toolsDir(), `shark-${SHARK_VERSION}`);
  node_fs.mkdirSync(d, { recursive: true });
  return d;
}
function jarPath(artifact, version) {
  return node_path.join(sharkDir(), jarFilename(artifact, version));
}
function cachedShark() {
  const paths = SHARK_JARS.map(([, a, v]) => jarPath(a, v));
  return paths.every((p) => node_fs.existsSync(p)) ? paths.join(node_path.delimiter) : null;
}
async function downloadShark(progress, isCancelled) {
  for (let i = 0; i < SHARK_JARS.length; i++) {
    const jar = SHARK_JARS[i];
    const [, art, ver] = jar;
    const dest = jarPath(art, ver);
    if (node_fs.existsSync(dest)) continue;
    try {
      await downloadFile(jarUrl(jar), dest, progress, isCancelled, `Shark ${i + 1}/${SHARK_JARS.length} (${art})`);
    } catch (e) {
      if (e instanceof CancelledError) throw e;
      return null;
    }
  }
  return cachedShark();
}
async function provisionShark(progress, isCancelled) {
  const java = await provisionJava(progress, isCancelled);
  const cp = cachedShark() ?? await downloadShark(progress, isCancelled);
  if (!cp) {
    throw new Error("Could not download the Shark analyzer jars (check your network connection).");
  }
  return [java, cp];
}
function outDir() {
  const d = node_path.join(node_os.homedir(), "Downloads");
  return node_fs.existsSync(d) ? d : node_os.homedir();
}
class LeakDetectService {
  constructor(adb, cb) {
    this.adb = adb;
    this.cb = cb;
  }
  running = false;
  cancelled = false;
  serial = "";
  pkg = "";
  proc = null;
  get isRunning() {
    return this.running;
  }
  /** Kick off the whole capture → analyze flow (no-op if one is already running). */
  start(serial, pkg) {
    if (this.running) return false;
    this.running = true;
    this.cancelled = false;
    this.serial = serial;
    this.pkg = pkg;
    void this.detect().finally(() => {
      this.running = false;
      this.proc = null;
    });
    return true;
  }
  cancel() {
    this.cancelled = true;
    this.proc?.kill("SIGKILL");
  }
  shutdown() {
    this.cancel();
  }
  isCancelled = () => this.cancelled;
  done(ok, report, hprof) {
    this.cb.onDone(ok, report, hprof, this.pkg);
  }
  async detect() {
    let java;
    let cp;
    try {
      this.cb.onProgress("Preparing the Shark analyzer…");
      [java, cp] = await provisionShark(this.cb.onProgress, this.isCancelled);
    } catch (e) {
      if (e instanceof CancelledError) return this.done(false, "Cancelled.", "");
      return this.done(false, e instanceof Error ? e.message : String(e), "");
    }
    try {
      await run$3(this.adb, this.serial, ["shell", "rm", "-f", REMOTE_HPROF], 1e4);
      this.cb.onProgress(`Capturing heap dump of ${this.pkg}…`);
      const r = await run$3(this.adb, this.serial, ["shell", "am", "dumpheap", this.pkg, REMOTE_HPROF], 6e4);
      const blob = r.stdout + r.stderr;
      if (heapDumpFailed(blob)) {
        return this.done(
          false,
          "Heap dump failed — the app must be debuggable (or the device rooted).\n\n" + blob.trim(),
          ""
        );
      }
    } catch (e) {
      return this.done(false, `adb error: ${e instanceof Error ? e.message : String(e)}`, "");
    }
    if (this.cancelled) return this.done(false, "Cancelled.", "");
    this.cb.onProgress("Waiting for the dump to finish…");
    const size2 = await this.waitStable();
    if (this.cancelled) return this.done(false, "Cancelled.", "");
    if (!size2) {
      return this.done(
        false,
        "No heap dump was produced — the app may not be debuggable, or it stopped during the dump.",
        ""
      );
    }
    const local = node_path.join(outDir(), `${this.pkg}.hprof`);
    this.cb.onProgress(`Pulling heap dump (${Math.round(size2 / 1e6)} MB)…`);
    try {
      await run$3(this.adb, this.serial, ["pull", REMOTE_HPROF, local], 18e4);
      await run$3(this.adb, this.serial, ["shell", "rm", "-f", REMOTE_HPROF], 1e4);
    } catch (e) {
      return this.done(false, `Failed to pull the heap dump: ${e instanceof Error ? e.message : String(e)}`, "");
    }
    if (!node_fs.existsSync(local) || node_fs.statSync(local).size === 0) {
      return this.done(false, "The pulled heap dump was empty.", "");
    }
    if (this.cancelled) return this.done(false, "Cancelled.", local);
    this.cb.onProgress("Analyzing the heap with Shark (this can take a minute)…");
    let report;
    try {
      report = await this.analyze(java, cp, local);
    } catch (e) {
      if (e instanceof CancelledError) return this.done(false, "Cancelled.", local);
      const msg = e instanceof Error ? e.message : String(e);
      return this.done(false, msg === "timeout" ? "Shark analysis timed out." : `Shark failed to run: ${msg}`, local);
    }
    if (this.cancelled) return this.done(false, "Cancelled.", local);
    if (!isValidReport(report)) {
      return this.done(false, "Shark did not return a report:\n\n" + (report || "(no output)"), local);
    }
    this.done(true, report, local);
  }
  /** Run Shark's `analyze` command; resolve with the report (stdout or stderr). */
  analyze(java, cp, local) {
    return new Promise((resolve, reject) => {
      const env = { ...process.env };
      const dj = node_path.join(toolsDir(), "jre");
      if (java.startsWith(dj + "/")) {
        const jbin = java.slice(0, java.lastIndexOf("/"));
        env.PATH = jbin + node_path.delimiter + (env.PATH ?? "");
        env.JAVA_HOME = jbin.slice(0, jbin.lastIndexOf("/"));
      }
      const proc2 = node_child_process.spawn(java, ["-cp", cp, SHARK_MAIN, "-h", local, "analyze"], { env });
      this.proc = proc2;
      let out = "";
      let err = "";
      const timer = setTimeout(() => {
        proc2.kill("SIGKILL");
        reject(new Error("timeout"));
      }, 6e5);
      proc2.stdout?.on("data", (c) => out += c.toString("utf8"));
      proc2.stderr?.on("data", (c) => err += c.toString("utf8"));
      proc2.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      proc2.on("close", () => {
        clearTimeout(timer);
        if (this.proc === proc2) this.proc = null;
        if (this.cancelled) {
          reject(new CancelledError());
          return;
        }
        resolve(out.trim() || err.trim());
      });
    });
  }
  /** Poll the remote file size until it stops growing; return the final size. */
  async waitStable() {
    const stat = `stat -c %s ${REMOTE_HPROF} 2>/dev/null || toybox stat -c %s ${REMOTE_HPROF} 2>/dev/null || echo 0`;
    let prev = -1;
    let stable = 0;
    for (let i = 0; i < 90; i++) {
      if (this.cancelled) return 0;
      let size2 = 0;
      try {
        const out = (await run$3(this.adb, this.serial, ["shell", stat], 1e4)).stdout.trim();
        const lines = out.split("\n");
        const last = lines[lines.length - 1];
        size2 = /^\d+$/.test(last) ? parseInt(last, 10) : 0;
      } catch {
        size2 = 0;
      }
      if (size2 && size2 === prev) {
        stable++;
        if (stable >= 2) return size2;
      } else {
        stable = 0;
      }
      prev = size2;
      await new Promise((r) => setTimeout(r, 1e3));
    }
    return prev > 0 ? prev : 0;
  }
}
function screencapArgs$1(serial) {
  return ["-s", serial, "exec-out", "screencap", "-p"];
}
function uidumpArgs(serial) {
  return ["-s", serial, "exec-out", "uiautomator", "dump", "/dev/tty"];
}
new fastXmlParser.XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseAttributeValue: false,
  processEntities: true
});
async function captureInspect(adb, serial) {
  const shot = await runBinary(adb, screencapArgs$1(serial), 2e4);
  const dump = await run$3(adb, null, uidumpArgs(serial), 25e3);
  const xml = dump.stdout;
  const png = shot.stdout;
  const isPng2 = png.length >= 4 && png[0] === 137 && png[1] === 80 && png[2] === 78 && png[3] === 71;
  if (!isPng2) {
    return { ok: false, message: "screencap returned no image", pngBase64: "", xml: "" };
  }
  if (!xml.includes("<hierarchy")) {
    const err = dump.stderr.trim();
    return { ok: false, message: `uiautomator dump failed: ${err || "no XML"}`, pngBase64: "", xml: "" };
  }
  return { ok: true, message: "captured", pngBase64: png.toString("base64"), xml };
}
const H264_BITRATE = "8M";
const CAPTURE_THREADS = 3;
function screencapArgs(serial, displayId = null) {
  const d = displayId != null ? ["-d", displayId] : [];
  return ["-s", serial, "exec-out", "screencap", ...d, "-p"];
}
function screenrecordH264Args(serial, bitrate = H264_BITRATE) {
  return [
    "-s",
    serial,
    "exec-out",
    "screenrecord",
    "--output-format=h264",
    "--time-limit",
    "180",
    "--bit-rate",
    bitrate,
    "-"
  ];
}
function screenrecordFileArgs(serial, remote) {
  return ["-s", serial, "shell", "screenrecord", remote];
}
function inputArgs(serial, logicalId, rest) {
  const d = logicalId != null ? ["-d", String(logicalId)] : [];
  return ["-s", serial, "shell", "input", ...d, ...rest];
}
function pkillScreenrecordArgs(serial, signal = null) {
  const sig = signal ? [`-${signal}`] : [];
  return ["-s", serial, "shell", "pkill", ...sig, "screenrecord"];
}
function pullArgs(serial, remote, dest) {
  return ["-s", serial, "pull", remote, dest];
}
function rmArgs(serial, remote) {
  return ["-s", serial, "shell", "rm", "-f", remote];
}
function surfaceFlingerDisplaysArgs(serial) {
  return ["-s", serial, "shell", "dumpsys", "SurfaceFlinger", "--display-id"];
}
function dumpsysDisplayArgs(serial) {
  return ["-s", serial, "shell", "dumpsys", "display"];
}
function safeSerial(serial) {
  return [...serial || "device"].map((c) => /[a-zA-Z0-9]/.test(c) ? c : "_").join("");
}
function emulatorProbeArgs(serial) {
  return [
    "-s",
    serial,
    "shell",
    'echo "K=$(getprop ro.kernel.qemu) B=$(getprop ro.boot.qemu) H=$(getprop ro.hardware) M=$(getprop ro.product.model)"'
  ];
}
function isEmulatorProps(text2) {
  const val = (key2) => new RegExp(`(?:^|\\s)${key2}=(\\S*)`).exec(text2)?.[1] ?? "";
  if (val("K") === "1" || val("B") === "1") return true;
  if (/goldfish|ranchu|vbox|ttvm|nox|windroy|cuttlefish|gce|android_x86/.test(val("H").toLowerCase())) return true;
  const model = (/(?:^|\s)M=(.*)$/m.exec(text2)?.[1] ?? "").toLowerCase();
  return /sdk|emulator|android sdk built/.test(model);
}
new Set("\\\"'`&|;<>()*~$#?[]{}".split(""));
function buildDisplayList(sfText, displayText) {
  const viewports = /* @__PURE__ */ new Map();
  const vpRe = /DisplayViewport\{[^}]*?displayId=(\d+),[^}]*?uniqueId='([^']+)'/g;
  let m;
  while ((m = vpRe.exec(displayText || "")) !== null) {
    viewports.set(m[2], parseInt(m[1], 10));
  }
  const out = [];
  for (const rawLine of (sfText || "").split("\n")) {
    const line = rawLine.trim();
    const dm = /^Display (\d+) \(([^)]*)\)/.exec(line);
    if (!dm) continue;
    const sfId = dm[1];
    const kind = dm[2];
    const nm = /displayName="([^"]*)"/.exec(line);
    const name = (nm ? nm[1].trim() : "") || kind;
    const virtual = kind.toLowerCase().includes("virtual");
    let logical;
    if (virtual) {
      const onum = /#(\d+)/.exec(name);
      logical = onum ? viewports.get(`overlay:${onum[1]}`) ?? null : null;
    } else {
      logical = viewports.get(`local:${sfId}`) ?? null;
    }
    out.push({ sfId, name, virtual, logical });
  }
  out.sort((a, b) => Number(a.virtual) - Number(b.virtual));
  return out;
}
function hex2(n) {
  return n.toString(16).padStart(2, "0");
}
class AnnexBDemuxer {
  leftover = new Uint8Array(0);
  curAU = [];
  curHasVcl = false;
  curKey = false;
  codec = null;
  lastSps = null;
  spsGen = 0;
  /** `avc1.PPCCLL` from the most recent SPS, else null. */
  codecString() {
    return this.codec;
  }
  /** Monotonic counter that bumps whenever the SPS changes — i.e. the video
   *  resolution/orientation changed (a device rotation). Consumers re-init the
   *  decoder on a change so new frames aren't decoded with stale geometry. */
  spsGeneration() {
    return this.spsGen;
  }
  push(chunk) {
    const data = this.leftover.length === 0 ? chunk : concat(this.leftover, chunk);
    const starts = findStartCodes(data);
    if (starts.length === 0) {
      this.leftover = data;
      return [];
    }
    const emitted = [];
    for (let i = 0; i < starts.length; i++) {
      const scStart = starts[i];
      const scLen = data[scStart + 2] === 1 ? 3 : 4;
      const payloadStart = scStart + scLen;
      const isLast = i === starts.length - 1;
      if (isLast) {
        this.leftover = data.subarray(scStart);
        break;
      }
      const nalEnd = starts[i + 1];
      const nalWithSc = data.subarray(scStart, nalEnd);
      const payload = data.subarray(payloadStart, nalEnd);
      this.consumeNal(payload, nalWithSc, emitted);
    }
    return emitted;
  }
  /**
   * Release the trailing picture(s) — call on EOF or after a short idle gap.
   * A bare start-code sentinel terminates the leftover NAL so push() can consume
   * it (start-code framing otherwise can't know that NAL is complete), then the
   * pending access unit is emitted.
   */
  flush() {
    const out = this.push(new Uint8Array([0, 0, 1]));
    this.leftover = new Uint8Array(0);
    if (this.curAU.length > 0 && this.curHasVcl) {
      const au = this.finishAU();
      if (au) out.push(au);
    }
    return out;
  }
  reset() {
    this.leftover = new Uint8Array(0);
    this.curAU = [];
    this.curHasVcl = false;
    this.curKey = false;
  }
  consumeNal(payload, nalWithSc, out) {
    if (payload.length === 0) return;
    const type2 = payload[0] & 31;
    const isVcl = type2 >= 1 && type2 <= 5;
    let boundary = false;
    if (type2 === 9) {
      boundary = this.curAU.length > 0;
    } else if (type2 === 7 && this.curHasVcl) {
      boundary = true;
    } else if (isVcl && this.curHasVcl) {
      const firstMbZero = payload.length > 1 && (payload[1] & 128) !== 0;
      if (firstMbZero) boundary = true;
    }
    if (boundary) {
      const au = this.finishAU();
      if (au) out.push(au);
    }
    if (type2 === 7 && payload.length >= 4) {
      this.codec = `avc1.${hex2(payload[1])}${hex2(payload[2])}${hex2(payload[3])}`;
      if (this.lastSps === null || !bytesEqual(this.lastSps, payload)) {
        this.lastSps = payload.slice();
        this.spsGen++;
      }
    }
    this.curAU.push(nalWithSc);
    if (isVcl) this.curHasVcl = true;
    if (type2 === 5) this.curKey = true;
  }
  finishAU() {
    if (this.curAU.length === 0) {
      this.curHasVcl = false;
      this.curKey = false;
      return null;
    }
    const au = { data: concatAll(this.curAU), key: this.curKey };
    this.curAU = [];
    this.curHasVcl = false;
    this.curKey = false;
    return au;
  }
}
function findStartCodes(data) {
  const idx = [];
  const n = data.length;
  for (let i = 0; i + 2 < n; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      idx.push(i > 0 && data[i - 1] === 0 ? i - 1 : i);
      i += 2;
    }
  }
  return idx;
}
function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
function concatAll(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
const SCRCPY_DEVICE_SERVER_PATH = "/data/local/tmp/scrcpy-server.jar";
function parseScrcpyVersion(text2) {
  const m = /scrcpy\s+([0-9][0-9.]*[0-9]|[0-9])/i.exec(text2 || "");
  return m ? m[1] : null;
}
function scrcpyPushArgs(serial, localJar) {
  return ["-s", serial, "push", localJar, SCRCPY_DEVICE_SERVER_PATH];
}
function scrcpyKillArgs(serial) {
  return ["-s", serial, "shell", "pkill", "-f", "com.genymobile.scrcpy"];
}
const SCRCPY_MAX_FPS = 60;
function scrcpyReverseArgs(serial, scid, port) {
  return ["-s", serial, "reverse", `localabstract:scrcpy_${scid}`, `tcp:${port}`];
}
function scrcpyReverseRemoveArgs(serial, scid) {
  return ["-s", serial, "reverse", "--remove", `localabstract:scrcpy_${scid}`];
}
function scrcpyServerArgs(serial, scid, version) {
  const kv = {
    scid,
    log_level: "error",
    video: "true",
    audio: "false",
    control: "true",
    // second socket for injecting touch / key / text
    max_fps: String(SCRCPY_MAX_FPS),
    raw_stream: "true",
    // bare Annex-B video (reverse tunnel = default, no tunnel_forward)
    cleanup: "true"
  };
  return [
    "-s",
    serial,
    "shell",
    `CLASSPATH=${SCRCPY_DEVICE_SERVER_PATH}`,
    "app_process",
    "/",
    "com.genymobile.scrcpy.Server",
    version,
    ...Object.entries(kv).map(([k, v]) => `${k}=${v}`)
  ];
}
const SCRCPY_BUNDLED_VERSION = "4.0";
const PNG_MAGIC = [137, 80, 78, 71];
function isPng(buf) {
  return buf.length >= 4 && PNG_MAGIC.every((b, i) => buf[i] === b);
}
function captureDir() {
  const dl = node_path.join(node_os.homedir(), "Downloads");
  return node_fs.existsSync(dl) ? dl : node_os.homedir();
}
function stamp$1() {
  const d = /* @__PURE__ */ new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
const HANDOFF_GRACE_MS$2 = 3e3;
class MirrorService {
  constructor(adb, cb) {
    this.adb = adb;
    this.cb = cb;
  }
  serial = "";
  runToken = 0;
  // bumped on every stop/start to invalidate old loops
  // Which display the live feed is capturing (null = main), so a re-primed screencap
  // on hand-off targets the right one.
  feedDisplay = null;
  teardownTimer = null;
  h264Proc = null;
  scrcpyProc = null;
  scrcpySock = null;
  // video socket
  scrcpyControl = null;
  // control socket (touch/key/text)
  scrcpyServer = null;
  // local listener the device connects back to
  scrcpyScid = null;
  scrcpyVer = null;
  recProc = null;
  recStopping = false;
  recTimer = null;
  // --- live feed ----------------------------------------------------------
  // NOTE on dock<->popout hand-off: unlike the iOS helper (which we can SIGUSR1 to emit
  // an on-demand keyframe), scrcpy/screenrecord only emit an IDR at start + sparsely
  // after (~10s), and scrcpy rejects unverified codec options — so we can't force one.
  // Re-attaching the freshly-mounted window to the ongoing stream would therefore show
  // the prime screencap and then FREEZE until the next far-off keyframe. Instead every
  // start restarts the feed: a fresh scrcpy start emits an IDR immediately, and `prime()`
  // paints the current screen at once, so the hand-off shows a live still then smooth
  // video within ~1s — no frozen frame. (cancelTeardown drops any pending grace timer so
  // it can't fire later and kill the just-started feed.)
  startH264(serial) {
    this.cancelTeardown();
    this.hardStopFeed();
    this.serial = serial;
    this.feedDisplay = null;
    const token = ++this.runToken;
    void this.h264Loop(token);
  }
  /**
   * Preferred smooth path: stream from scrcpy's server (no static-screen stalls).
   * Falls back to the screenrecord H.264 loop when the server jar isn't installed.
   */
  startScrcpy(serial) {
    this.cancelTeardown();
    this.hardStopFeed();
    this.serial = serial;
    this.feedDisplay = null;
    const token = ++this.runToken;
    const server = resolveScrcpyServer();
    if (server) void this.scrcpyLoop(token, server);
    else void this.h264Loop(token);
  }
  startPoller(serial, displayId) {
    this.cancelTeardown();
    this.hardStopFeed();
    this.serial = serial;
    this.feedDisplay = displayId;
    const token = ++this.runToken;
    for (let i = 0; i < CAPTURE_THREADS; i++) {
      void this.pollLoop(token, displayId, i * 55);
    }
  }
  /** Stop only the live feed (leaves any recording running, like mirror.py). By default
   *  on a grace timer so a dock<->popout hand-off can cancel it (see HANDOFF_GRACE_MS);
   *  `immediate` (a genuine close) tears down now. */
  stopFeed(immediate = false) {
    if (immediate) {
      this.cancelTeardown();
      this.hardStopFeed();
      return;
    }
    if (this.teardownTimer) clearTimeout(this.teardownTimer);
    this.teardownTimer = setTimeout(() => {
      this.teardownTimer = null;
      this.hardStopFeed();
    }, HANDOFF_GRACE_MS$2);
  }
  cancelTeardown() {
    if (this.teardownTimer) {
      clearTimeout(this.teardownTimer);
      this.teardownTimer = null;
    }
  }
  /** Immediate teardown: kill the streaming proc + scrcpy + any device screenrecord. */
  hardStopFeed() {
    this.runToken++;
    if (this.h264Proc) {
      try {
        this.h264Proc.kill("SIGKILL");
      } catch {
      }
      this.h264Proc = null;
    }
    this.killScrcpy();
    void run$3(this.adb, this.serial, pkillScreenrecordArgs(this.serial).slice(2), 6e3);
  }
  async h264Loop(token) {
    await run$3(this.adb, this.serial, pkillScreenrecordArgs(this.serial).slice(2), 6e3);
    await delay$2(120);
    if (token !== this.runToken) return;
    await this.prime(token);
    let total = 0;
    while (token === this.runToken) {
      const proc2 = node_child_process.spawn(this.adb, screenrecordH264Args(this.serial, H264_BITRATE));
      this.h264Proc = proc2;
      let session = 0;
      let stderr = "";
      proc2.stdout.on("data", (chunk) => {
        if (token !== this.runToken) return;
        session += chunk.length;
        total += chunk.length;
        this.cb.onH264(new Uint8Array(chunk));
      });
      proc2.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
      const code = await new Promise((resolve) => {
        proc2.on("close", (c) => resolve(c ?? 0));
        proc2.on("error", () => resolve(-1));
      });
      if (this.h264Proc === proc2) this.h264Proc = null;
      if (token !== this.runToken) break;
      if (session === 0) {
        if (total === 0) {
          this.cb.onFailed("h264", stderr.trim() || (code < 0 ? "could not start screenrecord" : "no video stream"));
          return;
        }
        await delay$2(150);
      }
    }
    await run$3(this.adb, this.serial, pkillScreenrecordArgs(this.serial).slice(2), 6e3);
  }
  async prime(token) {
    const shot = await runBinary(this.adb, screencapArgs(this.serial, this.feedDisplay), 6e3);
    if (token !== this.runToken) return;
    if (isPng(shot.stdout)) this.cb.onFrame(shot.stdout.toString("base64"));
  }
  async pollLoop(token, displayId, startDelayMs) {
    if (startDelayMs) await delay$2(startDelayMs);
    let misses = 0;
    while (token === this.runToken) {
      const shot = await runBinary(this.adb, screencapArgs(this.serial, displayId), 1e4);
      if (token !== this.runToken) return;
      if (isPng(shot.stdout)) {
        misses = 0;
        this.cb.onFrame(shot.stdout.toString("base64"));
      } else {
        misses++;
        if (misses > 5) {
          this.cb.onFailed("poller", "no screen data (device offline?)");
          return;
        }
        await delay$2(120);
      }
    }
  }
  // --- scrcpy feed --------------------------------------------------------
  async scrcpyLoop(token, server) {
    await run$3(this.adb, this.serial, pkillScreenrecordArgs(this.serial).slice(2), 6e3);
    await run$3(this.adb, this.serial, scrcpyKillArgs(this.serial).slice(2), 6e3);
    if (token !== this.runToken) return;
    await this.prime(token);
    if (token !== this.runToken) return;
    const version = server.version ?? await this.scrcpyVersion();
    const push = await run$3(this.adb, null, scrcpyPushArgs(this.serial, server.path), 3e4);
    if (token !== this.runToken) return;
    if (push.code !== 0) {
      this.cb.onFailed("h264", `could not push scrcpy-server: ${push.stderr.trim() || "push failed"}`);
      return;
    }
    const scid = randScid();
    this.scrcpyScid = scid;
    const listener = net.createServer((sock2) => {
      sock2.on("error", () => {
      });
      if (!this.scrcpySock) {
        this.scrcpySock = sock2;
        this.readScrcpyStream(sock2, token);
      } else if (!this.scrcpyControl) {
        this.scrcpyControl = sock2;
        sock2.on("data", () => {
        });
        if (token === this.runToken) this.cb.onControlReady(true);
      } else {
        sock2.destroy();
      }
    });
    this.scrcpyServer = listener;
    const port = await new Promise((resolve) => {
      listener.once("error", () => resolve(0));
      listener.listen(0, "127.0.0.1", () => {
        const addr = listener.address();
        resolve(typeof addr === "object" && addr ? addr.port : 0);
      });
    });
    if (token !== this.runToken) return;
    if (!port) {
      this.cb.onFailed("h264", "could not open a local port for the scrcpy tunnel");
      this.killScrcpy();
      return;
    }
    const rev = await run$3(this.adb, null, scrcpyReverseArgs(this.serial, scid, port), 8e3);
    if (token !== this.runToken) return;
    if (rev.code !== 0) {
      this.cb.onFailed("h264", `adb reverse failed: ${rev.stderr.trim() || "unknown"}`);
      this.killScrcpy();
      return;
    }
    const proc2 = node_child_process.spawn(this.adb, scrcpyServerArgs(this.serial, scid, version));
    this.scrcpyProc = proc2;
    let serverLog = "";
    proc2.stdout.on("data", (c) => serverLog += c.toString("utf8"));
    proc2.stderr.on("data", (c) => serverLog += c.toString("utf8"));
    proc2.on("close", () => {
      if (this.scrcpyProc === proc2) this.scrcpyProc = null;
    });
    const started = await this.waitForVideo(token);
    if (!started) {
      if (token === this.runToken) {
        const last = serverLog.trim().split("\n").filter(Boolean).pop();
        this.cb.onFailed("h264", `scrcpy stream did not start${last ? `: ${last}` : ""}`);
        this.killScrcpy();
      }
    }
  }
  /** Resolve once the video socket dials back, or false on timeout / cancel. */
  waitForVideo(token) {
    const deadline = Date.now() + 6e3;
    return new Promise((resolve) => {
      const check = () => {
        if (token !== this.runToken) return resolve(false);
        if (this.scrcpySock) return resolve(true);
        if (Date.now() > deadline) return resolve(false);
        setTimeout(check, 100);
      };
      check();
    });
  }
  /** Forward the raw Annex-B bytes straight to the renderer's demuxer (raw_stream
   *  disables scrcpy's own framing, so this is the same byte shape as screenrecord). */
  readScrcpyStream(sock2, token) {
    sock2.on("data", (chunk) => {
      if (token !== this.runToken) return;
      this.cb.onH264(new Uint8Array(chunk));
    });
    const onEnd = () => {
      if (token === this.runToken) this.cb.onFailed("h264", "scrcpy stream ended");
    };
    sock2.on("close", onEnd);
    sock2.on("error", onEnd);
  }
  /** Inject a pre-encoded scrcpy control message (touch/key/text) if the control
   *  socket is up. No-op otherwise, so the renderer can call it unconditionally. */
  control(data) {
    const sock2 = this.scrcpyControl;
    if (sock2 && !sock2.destroyed) {
      try {
        sock2.write(Buffer.from(data));
      } catch {
      }
    }
  }
  async scrcpyVersion() {
    if (this.scrcpyVer) return this.scrcpyVer;
    const bin = this.scrcpyPath();
    const parsed = bin ? await new Promise((resolve) => {
      node_child_process.execFile(bin, ["--version"], { timeout: 6e3 }, (err, stdout) => {
        resolve(err ? null : parseScrcpyVersion(stdout));
      });
    }) : null;
    this.scrcpyVer = parsed ?? "4.0";
    return this.scrcpyVer;
  }
  /** Kill the server + sockets + local listener + adb reverse (frees the encoder).
   *  Never pkills screenrecord — recording uses that and manages its own lifecycle. */
  killScrcpy() {
    const hadControl = this.scrcpyControl != null;
    for (const s of [this.scrcpySock, this.scrcpyControl]) {
      try {
        s?.destroy();
      } catch {
      }
    }
    this.scrcpySock = null;
    this.scrcpyControl = null;
    if (hadControl) this.cb.onControlReady(false);
    if (this.scrcpyServer) {
      try {
        this.scrcpyServer.close();
      } catch {
      }
      this.scrcpyServer = null;
    }
    if (this.scrcpyProc) {
      try {
        this.scrcpyProc.kill("SIGKILL");
      } catch {
      }
      this.scrcpyProc = null;
    }
    if (this.scrcpyScid != null) {
      void run$3(this.adb, null, scrcpyReverseRemoveArgs(this.serial, this.scrcpyScid), 6e3);
      this.scrcpyScid = null;
    }
    void run$3(this.adb, this.serial, scrcpyKillArgs(this.serial).slice(2), 6e3);
  }
  // --- one-shot input -----------------------------------------------------
  input(serial, logicalId, args) {
    node_child_process.execFile(this.adb, inputArgs(serial, logicalId, args), { timeout: 8e3 }, () => {
    });
  }
  /** Whether the device is an emulator (its screenrecord encoder is slow). */
  async isEmulator(serial) {
    const r = await run$3(this.adb, null, emulatorProbeArgs(serial), 6e3);
    return isEmulatorProps(r.stdout);
  }
  // --- displays -----------------------------------------------------------
  async listDisplays(serial) {
    const sf = await run$3(this.adb, null, surfaceFlingerDisplaysArgs(serial), 1e4);
    const dp = await run$3(this.adb, null, dumpsysDisplayArgs(serial), 1e4);
    return buildDisplayList(sf.stdout, dp.stdout);
  }
  // --- screenshot ---------------------------------------------------------
  async screenshot(serial, displayId, logicalId) {
    const shot = await runBinary(this.adb, screencapArgs(serial, displayId), 2e4);
    if (!isPng(shot.stdout)) {
      return { ok: false, message: `Screenshot failed: ${shot.stderr.trim() || "no image data"}`, dir: "" };
    }
    const tag = displayId == null ? "" : `-display${logicalId}`;
    const dest = node_path.join(captureDir(), `screenshot-${safeSerial(serial)}${tag}-${stamp$1()}.png`);
    try {
      node_fs.writeFileSync(dest, shot.stdout);
    } catch (e) {
      return { ok: false, message: `Cannot write ${dest}: ${e instanceof Error ? e.message : String(e)}`, dir: "" };
    }
    return { ok: true, message: `Saved ${node_path.basename(dest)}`, dir: node_path.dirname(dest) };
  }
  // --- MP4 recording (main display only) ----------------------------------
  startRecord(serial) {
    if (this.recProc) return false;
    this.serial = serial;
    this.cancelTeardown();
    this.runToken++;
    this.killScrcpy();
    if (this.h264Proc) {
      try {
        this.h264Proc.kill("SIGKILL");
      } catch {
      }
      this.h264Proc = null;
    }
    this.recStopping = false;
    const remote = `/sdcard/androidlab-${stamp$1()}.mp4`;
    const dest = node_path.join(captureDir(), `screenrecord-${safeSerial(serial)}-${stamp$1()}.mp4`);
    const proc2 = node_child_process.spawn(this.adb, screenrecordFileArgs(serial, remote));
    this.recProc = proc2;
    let out = "";
    proc2.stdout.on("data", (c) => out += c.toString("utf8"));
    proc2.stderr.on("data", (c) => out += c.toString("utf8"));
    this.recTimer = setInterval(() => {
      if (this.recStopping) void run$3(this.adb, serial, pkillScreenrecordArgs(serial, "INT").slice(2), 6e3);
    }, 300);
    proc2.on("close", () => void this.finishRecord(serial, remote, dest, out));
    proc2.on("error", () => void this.finishRecord(serial, remote, dest, out));
    return true;
  }
  stopRecord() {
    if (!this.recProc) return false;
    this.recStopping = true;
    return true;
  }
  recordDone = null;
  /** Register the one-shot completion callback for the in-flight recording. */
  onRecordDone(cb) {
    this.recordDone = cb;
  }
  async finishRecord(serial, remote, dest, recMsg) {
    if (this.recTimer) {
      clearInterval(this.recTimer);
      this.recTimer = null;
    }
    this.recProc = null;
    this.recStopping = false;
    const pull2 = await run$3(this.adb, null, pullArgs(serial, remote, dest), 18e4);
    await run$3(this.adb, null, rmArgs(serial, remote), 1e4);
    let result;
    if (pull2.code === 0 && node_fs.existsSync(dest) && safeSize(dest) > 0) {
      result = { ok: true, message: `Saved ${node_path.basename(dest)}`, dir: node_path.dirname(dest) };
    } else {
      const reason = (pull2.stderr || pull2.stdout || recMsg || "screenrecord produced no file").trim();
      const last = reason.split("\n").filter(Boolean).pop() || "unknown";
      result = { ok: false, message: `Recording failed: ${last}`, dir: "" };
    }
    this.recordDone?.(result);
  }
  // --- scrcpy -------------------------------------------------------------
  scrcpyPath() {
    return whichIn(process.platform === "win32" ? "scrcpy.exe" : "scrcpy");
  }
  launchScrcpy(serial, logicalId) {
    const scrcpy = this.scrcpyPath();
    if (!scrcpy) return;
    const args = ["-s", serial, ...logicalId != null ? ["--display-id", String(logicalId)] : []];
    const child = node_child_process.spawn(scrcpy, args, { detached: true, stdio: "ignore" });
    child.unref();
  }
  shutdown() {
    this.cancelTeardown();
    this.hardStopFeed();
    if (this.recProc) {
      this.recStopping = true;
      void run$3(this.adb, this.serial, pkillScreenrecordArgs(this.serial, "INT").slice(2), 6e3);
    }
    if (this.recTimer) {
      clearInterval(this.recTimer);
      this.recTimer = null;
    }
  }
}
function delay$2(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function safeSize(path) {
  try {
    return node_fs.statSync(path).size;
  } catch {
    return 0;
  }
}
function whichIn(bin) {
  for (const dir of (process.env.PATH ?? "").split(node_path.delimiter)) {
    if (!dir) continue;
    const cand = node_path.join(dir, bin);
    if (node_fs.existsSync(cand)) return cand;
  }
  for (const cand of ["/opt/homebrew/bin/" + bin, "/usr/local/bin/" + bin]) {
    if (node_fs.existsSync(cand)) return cand;
  }
  return null;
}
function bundledServerPath() {
  const cands = electron.app.isPackaged ? [node_path.join(process.resourcesPath, "scrcpy-server")] : [node_path.join(electron.app.getAppPath(), "resources", "scrcpy-server"), node_path.join(process.cwd(), "resources", "scrcpy-server")];
  for (const c of cands) if (node_fs.existsSync(c)) return c;
  return null;
}
function resolveScrcpyServer() {
  const env = process.env.SCRCPY_SERVER_PATH;
  if (env && node_fs.existsSync(env)) return { path: env, version: null };
  const bundled = bundledServerPath();
  if (bundled) return { path: bundled, version: SCRCPY_BUNDLED_VERSION };
  const cands = [];
  const bin = whichIn("scrcpy");
  if (bin) cands.push(node_path.join(node_path.dirname(bin), "..", "share", "scrcpy", "scrcpy-server"));
  cands.push(
    "/opt/homebrew/share/scrcpy/scrcpy-server",
    "/usr/local/share/scrcpy/scrcpy-server",
    "/usr/share/scrcpy/scrcpy-server"
  );
  for (const c of cands) if (node_fs.existsSync(c)) return { path: c, version: null };
  return null;
}
function randScid() {
  return Math.floor(Math.random() * 2147483647).toString(16).padStart(8, "0");
}
const HANDOFF_GRACE_MS$1 = 3e3;
class IosMirrorService {
  constructor(goiosBin, cb) {
    this.goiosBin = goiosBin;
    this.cb = cb;
  }
  udid = "";
  runToken = 0;
  proc = null;
  // Our own liveness flag. Do NOT use proc.killed for this: Node sets proc.killed=true
  // the moment ANY signal is sent via .kill(), including the SIGUSR1 we send to force a
  // keyframe on re-attach — which would wrongly make the next hand-off think the helper
  // is dead and respawn it. This flips false only on a real terminate / process exit.
  alive = false;
  gotData = false;
  teardownTimer = null;
  // The user's mute preference vs what the running helper is actually doing (a fresh
  // helper always starts unmuted). SIGUSR2 only toggles, so sync compares the two.
  mutedWanted = false;
  helperMuted = false;
  // --- live feed ----------------------------------------------------------
  start(udid) {
    const reattach = udid === this.udid && this.proc != null && this.alive;
    this.cancelTeardown();
    if (reattach) {
      try {
        this.proc?.kill("SIGUSR1");
      } catch {
      }
      return;
    }
    this.hardStop();
    this.udid = udid;
    const token = ++this.runToken;
    void this.startFeed(token);
  }
  /** Stop the live feed. By default on a grace timer so a dock<->popout hand-off can
   *  cancel it (see HANDOFF_GRACE_MS). `immediate` (a genuine close) tears down now. */
  stopFeed(immediate = false) {
    if (immediate) {
      this.cancelTeardown();
      this.hardStop();
      return;
    }
    if (this.teardownTimer) clearTimeout(this.teardownTimer);
    this.teardownTimer = setTimeout(() => {
      this.teardownTimer = null;
      this.hardStop();
    }, HANDOFF_GRACE_MS$1);
  }
  cancelTeardown() {
    if (this.teardownTimer) {
      clearTimeout(this.teardownTimer);
      this.teardownTimer = null;
    }
  }
  // --- device-audio mute ----------------------------------------------------
  /** Set the mute preference. Applied to the live helper at once; a helper spawned
   *  later picks it up when it starts streaming. Returns the effective preference. */
  setMuted(muted) {
    this.mutedWanted = muted;
    this.syncMute();
    return this.mutedWanted;
  }
  getMuted() {
    return this.mutedWanted;
  }
  /** Bring the helper's actual mute state in line with the preference. Gated on
   *  gotData: by the time frames flow the helper's signal handlers are long
   *  installed (an unhandled SIGUSR2 would kill a just-spawned process). */
  syncMute() {
    if (!this.proc || !this.alive || !this.gotData) return;
    if (this.helperMuted === this.mutedWanted) return;
    try {
      this.proc.kill("SIGUSR2");
      this.helperMuted = this.mutedWanted;
    } catch {
    }
  }
  /** Immediate teardown — kills the capture helper (grace timer firing, new device, quit). */
  hardStop() {
    this.runToken++;
    this.alive = false;
    if (this.proc) {
      try {
        this.proc.kill("SIGTERM");
      } catch {
      }
      this.proc = null;
    }
    this.gotData = false;
  }
  async startFeed(token) {
    if (process.platform !== "darwin") {
      this.cb.onFailed("The iOS screen mirror is available on macOS only.");
      return;
    }
    const helper = resolveHelper$1();
    if (!helper) {
      this.cb.onFailed("The iOS capture helper (resources/iosscreen) is missing from this build.");
      return;
    }
    this.cb.onState({ mode: "h264", message: "Connecting…" });
    const name = await this.deviceName(this.udid);
    if (token !== this.runToken) return;
    const proc2 = node_child_process.spawn(helper, name ? [name] : [], { stdio: ["ignore", "pipe", "pipe"] });
    this.proc = proc2;
    this.alive = true;
    this.gotData = false;
    this.helperMuted = false;
    let err = "";
    proc2.stdout.on("data", (chunk) => {
      if (token !== this.runToken) return;
      if (!this.gotData) {
        this.gotData = true;
        this.cb.onState({ mode: "h264", message: "Live stream" });
        this.syncMute();
      }
      this.cb.onH264(new Uint8Array(chunk));
    });
    proc2.stderr.on("data", (chunk) => {
      const text2 = chunk.toString("utf8");
      err += text2;
      for (const line of text2.split("\n")) {
        const t = line.trim();
        if (t) console.error(`[iosscreen] ${t}`);
      }
    });
    proc2.on("error", (e) => {
      if (token === this.runToken) this.cb.onFailed(`Could not start the capture helper: ${e.message}`);
    });
    proc2.on("close", () => {
      if (this.proc === proc2) {
        this.proc = null;
        this.alive = false;
      }
      if (token !== this.runToken || this.gotData) return;
      this.cb.onFailed(helperFailure(err));
    });
  }
  /** The device's name via `ios info` (used to pick the right CMIO screen device). */
  async deviceName(udid) {
    return new Promise((resolve) => {
      node_child_process.execFile(this.goiosBin, infoArgs(udid), { timeout: 8e3, maxBuffer: 8 * 1024 * 1024 }, (e, stdout) => {
        if (e) return resolve(null);
        const m = /"DeviceName"\s*:\s*"([^"]+)"/.exec(stdout ?? "");
        resolve(m ? m[1] : null);
      });
    });
  }
  shutdown() {
    this.cancelTeardown();
    this.hardStop();
  }
}
function resolveHelper$1() {
  const cands = electron.app.isPackaged ? [node_path.join(process.resourcesPath, "iosscreen")] : [node_path.join(electron.app.getAppPath(), "resources", "iosscreen"), node_path.join(process.cwd(), "resources", "iosscreen")];
  for (const c of cands) if (node_fs.existsSync(c)) return c;
  return null;
}
function helperFailure(stderr) {
  if (/no iOS screen-capture device found/i.test(stderr)) {
    return "No iPhone screen available to capture. Make sure the device is connected, unlocked, and trusted — if it was just used for other tools, reconnect it (or reboot it) so macOS re-exposes its screen.";
  }
  if (/permission|not authorized|denied/i.test(stderr)) {
    return "Screen capture was blocked — grant MobileLabKit camera/screen-recording access in System Settings ▸ Privacy.";
  }
  const last = stderr.split("\n").map((l) => l.trim()).filter(Boolean).pop();
  return last ? `Screen capture failed: ${last}` : "Screen capture failed to start.";
}
const AIRPLAY_NAME = "MobileLabKit";
const DEFAULT_RES = { width: 1920, height: 1080 };
const HANDOFF_GRACE_MS = 3e3;
class IosAirplayService {
  constructor(cb) {
    this.cb = cb;
  }
  proc = null;
  runToken = 0;
  alive = false;
  gotData = false;
  teardownTimer = null;
  resKey = `${DEFAULT_RES.width}x${DEFAULT_RES.height}`;
  // Keyframe cache for the dock<->popout hand-off. iOS emits IDRs infrequently (rarely
  // on a static screen), so a freshly-mounted decoder in the other window would stay
  // black until the next one. We demux the outgoing stream, cache the last keyframe
  // access unit (SPS+PPS+IDR — iOS bundles them), and replay it on reattach so the new
  // decoder configures + paints immediately. (The USB path forces a keyframe via
  // SIGUSR1; we can't ask the phone, hence the cache.)
  demuxer = new AnnexBDemuxer();
  lastKeyframe = null;
  // Host-audio mute preference vs the receiver's actual state (a fresh receiver
  // starts unmuted). SIGUSR2 only toggles, so sync compares the two.
  mutedWanted = false;
  helperMuted = false;
  /** Start (or reattach to) the receiver at `resolution`. A dock<->popout hand-off
   *  re-invokes this with the SAME resolution while the receiver is still up → no-op
   *  (keeps streaming). A genuine resolution change respawns with the new dims. */
  start(resolution = DEFAULT_RES) {
    this.cancelTeardown();
    const key2 = `${resolution.width}x${resolution.height}`;
    if (this.proc && this.alive && this.resKey === key2) {
      this.replayKeyframe();
      return;
    }
    this.hardStop();
    this.resKey = key2;
    const token = ++this.runToken;
    void this.startReceiver(token);
  }
  /** Re-broadcast the last cached keyframe. Deferred (and repeated) so it lands after
   *  the freshly-mounted window has subscribed to the H.264 broadcast. */
  replayKeyframe() {
    const kf = this.lastKeyframe;
    if (!kf) return;
    const send = () => {
      if (this.alive && this.lastKeyframe) this.cb.onH264(kf);
    };
    setTimeout(send, 60);
    setTimeout(send, 220);
  }
  /** Stop the receiver. Defaults to a grace timer so a dock<->popout hand-off can
   *  cancel it; `immediate` (a genuine close / mode switch) tears down now. */
  stop(immediate = false) {
    if (immediate) {
      this.cancelTeardown();
      this.hardStop();
      return;
    }
    if (this.teardownTimer) clearTimeout(this.teardownTimer);
    this.teardownTimer = setTimeout(() => {
      this.teardownTimer = null;
      this.hardStop();
    }, HANDOFF_GRACE_MS);
  }
  cancelTeardown() {
    if (this.teardownTimer) {
      clearTimeout(this.teardownTimer);
      this.teardownTimer = null;
    }
  }
  // --- host-audio mute ------------------------------------------------------
  /** Set the mute preference; applied to the receiver at once (a later-spawned
   *  receiver picks it up once it starts streaming). Returns the effective value. */
  setMuted(muted) {
    this.mutedWanted = muted;
    this.syncMute();
    return this.mutedWanted;
  }
  getMuted() {
    return this.mutedWanted;
  }
  /** Bring the receiver's actual mute state in line with the preference. The receiver
   *  toggles mute on each 'm' byte it reads on stdin (portable — no POSIX signals on
   *  Windows). Gated on gotData so the write never races a just-spawned process. */
  syncMute() {
    if (!this.proc || !this.alive || !this.gotData) return;
    if (this.helperMuted === this.mutedWanted) return;
    try {
      this.proc.stdin?.write("m");
      this.helperMuted = this.mutedWanted;
    } catch {
    }
  }
  hardStop() {
    this.runToken++;
    this.alive = false;
    if (this.proc) {
      try {
        this.proc.kill("SIGTERM");
      } catch {
      }
      this.proc = null;
    }
    this.gotData = false;
    this.demuxer.reset();
    this.lastKeyframe = null;
  }
  async startReceiver(token) {
    const helper = resolveHelper();
    if (!helper) {
      this.cb.onFailed("The AirPlay receiver (resources/airplayscreen) is missing from this build.");
      return;
    }
    this.cb.onState({
      mode: "airplay",
      waiting: true,
      message: `On your iPhone, open Control Center ▸ Screen Mirroring and pick “${AIRPLAY_NAME}”.`
    });
    const proc2 = node_child_process.spawn(helper, [AIRPLAY_NAME, this.resKey], { stdio: ["pipe", "pipe", "pipe"] });
    this.proc = proc2;
    this.alive = true;
    this.gotData = false;
    this.helperMuted = false;
    let err = "";
    proc2.stdout.on("data", (chunk) => {
      if (token !== this.runToken) return;
      if (!this.gotData) {
        this.gotData = true;
        this.cb.onState({ mode: "airplay", waiting: false, message: "Live stream (AirPlay)" });
        this.syncMute();
      }
      const bytes = new Uint8Array(chunk);
      for (const au of this.demuxer.push(bytes)) {
        if (au.key) this.lastKeyframe = au.data.slice();
      }
      this.cb.onH264(bytes);
    });
    proc2.stderr.on("data", (chunk) => {
      const text2 = chunk.toString("utf8");
      err += text2;
      for (const line of text2.split("\n")) {
        const t = line.trim();
        if (t) console.error(`[airplayscreen] ${t}`);
      }
      if (token === this.runToken && /client disconnected/i.test(text2)) {
        this.gotData = false;
        this.cb.onState({
          mode: "airplay",
          waiting: true,
          message: `Disconnected. On your iPhone, pick “${AIRPLAY_NAME}” again in Screen Mirroring.`
        });
      }
    });
    proc2.on("error", (e) => {
      if (token === this.runToken) this.cb.onFailed(`Could not start the AirPlay receiver: ${e.message}`);
    });
    proc2.on("close", () => {
      if (this.proc === proc2) {
        this.proc = null;
        this.alive = false;
      }
      if (token !== this.runToken) return;
      if (!this.gotData) this.cb.onFailed(receiverFailure(err));
    });
  }
  shutdown() {
    this.cancelTeardown();
    this.hardStop();
  }
}
function resolveHelper() {
  const bin = process.platform === "win32" ? "airplayscreen.exe" : "airplayscreen";
  const cands = electron.app.isPackaged ? [node_path.join(process.resourcesPath, bin)] : [node_path.join(electron.app.getAppPath(), "resources", bin), node_path.join(process.cwd(), "resources", bin)];
  for (const c of cands) if (node_fs.existsSync(c)) return c;
  return null;
}
function receiverFailure(stderr) {
  if (/dnssd_init failed/i.test(stderr)) {
    return "AirPlay could not advertise on the network — another receiver may be using the name, or Bonjour is blocked. Check that Wi-Fi is on and try again.";
  }
  if (/raop_start failed|raop_init failed/i.test(stderr)) {
    return "The AirPlay receiver could not open its network port. Make sure no other AirPlay app is running and retry.";
  }
  const last = stderr.split("\n").map((l) => l.trim()).filter(Boolean).pop();
  return last ? `AirPlay receiver failed: ${last}` : "The AirPlay receiver failed to start.";
}
const WDA_DRIVER = { driver: "wda", wdaUrl: WDA_LOCAL_URL };
const DK_DRIVER = { driver: "devicekit" };
let activeAgent = null;
function configPath() {
  return node_path.join(electron.app.getPath("userData"), "ios-input.json");
}
function assetsDir() {
  const d = node_path.join(electron.app.getPath("userData"), "ios-agent");
  if (!node_fs.existsSync(d)) node_fs.mkdirSync(d, { recursive: true });
  return d;
}
function loadConfig() {
  const def = defaultConfig();
  try {
    const raw = JSON.parse(node_fs.readFileSync(configPath(), "utf8"));
    const str2 = (k, d) => typeof raw[k] === "string" ? raw[k] : d;
    const cfg = {
      method: raw.method === "asc" ? "asc" : "manual",
      agent: raw.agent === "wda" ? "wda" : "devicekit",
      p12Path: str2("p12Path", ""),
      p12Password: "",
      profilePath: str2("profilePath", ""),
      keyId: str2("keyId", ""),
      issuerId: str2("issuerId", ""),
      p8Path: str2("p8Path", ""),
      bundleId: str2("bundleId", def.bundleId),
      provisioned: raw.provisioned === true
    };
    const enc = str2("p12PasswordEnc", "");
    if (enc && electron.safeStorage.isEncryptionAvailable()) {
      try {
        cfg.p12Password = electron.safeStorage.decryptString(Buffer.from(enc, "base64"));
      } catch {
      }
    } else {
      cfg.p12Password = str2("p12Password", "");
    }
    return cfg;
  } catch {
    return def;
  }
}
function saveConfig(cfg) {
  const merged = { ...loadConfig(), ...cfg };
  const { p12Password, ...rest } = merged;
  const onDisk = { ...rest };
  if (p12Password) {
    if (electron.safeStorage.isEncryptionAvailable()) {
      onDisk.p12PasswordEnc = electron.safeStorage.encryptString(p12Password).toString("base64");
    } else {
      onDisk.p12Password = p12Password;
    }
  }
  node_fs.writeFileSync(configPath(), JSON.stringify(onDisk, null, 2), "utf8");
  return { ...merged };
}
const PICK = {
  p8: { title: "Select your App Store Connect API key (.p8)", name: "App Store Connect API key", ext: ["p8"] },
  p12: { title: "Select your signing certificate (.p12)", name: "PKCS#12 certificate", ext: ["p12", "pfx"] },
  profile: { title: "Select your provisioning profile", name: "Provisioning profile", ext: ["mobileprovision"] }
};
async function chooseFile(win, kind) {
  const k = PICK[kind] ?? PICK.p12;
  const opts = {
    title: k.title,
    properties: ["openFile"],
    filters: [{ name: k.name, extensions: k.ext }]
  };
  const r = win ? await electron.dialog.showOpenDialog(win, opts) : await electron.dialog.showOpenDialog(opts);
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
}
function run(bin, args, timeout = 12e4) {
  return new Promise((resolve) => {
    node_child_process.execFile(bin, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof err.code === "number" ? err.code : err ? 1 : 0;
      resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}
function lastLine$2(...streams) {
  for (const s of streams) {
    const line = s.split("\n").map((l) => l.trim()).filter(Boolean).pop();
    if (line) return line;
  }
  return "";
}
function opensslBin() {
  for (const c of ["/opt/homebrew/bin/openssl", "/usr/local/bin/openssl", "/usr/bin/openssl"]) {
    if (node_fs.existsSync(c)) return c;
  }
  return "openssl";
}
function supportsLegacy(bin) {
  return new Promise((resolve) => {
    node_child_process.execFile(bin, ["pkcs12", "-help"], { timeout: 6e3 }, (_e, stdout, stderr) => {
      resolve(/-legacy\b/.test(`${stdout ?? ""}${stderr ?? ""}`));
    });
  });
}
function opensslVersion(bin) {
  return new Promise((resolve) => {
    node_child_process.execFile(bin, ["version"], { timeout: 6e3 }, (_e, stdout) => resolve((stdout ?? "").trim()));
  });
}
async function toLegacyP12(p12Path, password, onProgress) {
  const bin = opensslBin();
  const [ver, legacy] = await Promise.all([opensslVersion(bin), supportsLegacy(bin)]);
  onProgress(`openssl: ${bin}${ver ? ` — ${ver}` : ""}`);
  onProgress(`legacy provider: ${legacy ? "available" : "unavailable"}; input password: ${password ? "provided" : "(blank)"}`);
  const out = node_path.join(assetsDir(), "signing.p12");
  const pem = node_path.join(assetsDir(), "signing.pem");
  const env = { ...process.env, P12PW: password };
  const run2 = (args) => new Promise((resolve) => {
    node_child_process.execFile(bin, args, { env, timeout: 3e4 }, (e, _o, stderr) => {
      const code = e && typeof e.code === "number" ? e.code : e ? 1 : 0;
      resolve({ code, stderr: (stderr ?? "").trim() });
    });
  });
  const emitStderr = (s) => {
    for (const l of s.split("\n").map((x) => x.trim()).filter(Boolean)) onProgress(`  openssl: ${l}`);
  };
  try {
    if (node_fs.existsSync(out)) node_fs.rmSync(out);
    if (node_fs.existsSync(pem)) node_fs.rmSync(pem);
  } catch {
  }
  try {
    const readArgs = (extra) => ["pkcs12", "-in", p12Path, "-passin", "env:P12PW", "-nodes", "-out", pem, ...extra];
    onProgress(`Step 1/2: reading the .p12 (${legacy ? "legacy" : "default"} provider)…`);
    let r = await run2(readArgs(legacy ? ["-legacy"] : []));
    if (r.stderr) emitStderr(r.stderr);
    onProgress(`  exit ${r.code}; PEM written: ${node_fs.existsSync(pem) ? "yes" : "no"}`);
    if ((r.code !== 0 || !node_fs.existsSync(pem)) && legacy) {
      onProgress("Step 1/2: retrying the read with the default provider…");
      try {
        if (node_fs.existsSync(pem)) node_fs.rmSync(pem);
      } catch {
      }
      r = await run2(readArgs([]));
      if (r.stderr) emitStderr(r.stderr);
      onProgress(`  exit ${r.code}; PEM written: ${node_fs.existsSync(pem) ? "yes" : "no"}`);
    }
    if (r.code !== 0 || !node_fs.existsSync(pem)) {
      onProgress("Step 1/2 FAILED: could not decrypt the .p12 (wrong password, or not a certificate export).");
      return { error: "Could not read the .p12 — check the password is correct and the file is a certificate export." };
    }
    try {
      const pemText = node_fs.readFileSync(pem, "utf8");
      const hasCert = /-----BEGIN CERTIFICATE-----/.test(pemText);
      const hasKey = /-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----/.test(pemText);
      onProgress(`  PEM contents: certificate ${hasCert ? "✓" : "✗ MISSING"}, private key ${hasKey ? "✓" : "✗ MISSING"}`);
      if (!hasCert) {
        onProgress("Step 1/2 FAILED: the .p12 decrypted but contains no certificate.");
        return {
          error: 'This .p12 has the private key but NO certificate. In Keychain Access, export the item under "My Certificates" (the certificate row with a ▸ that reveals the key) — not the standalone key under "Keys".'
        };
      }
    } catch {
    }
    onProgress("Step 2/2: re-encoding as a legacy .p12…");
    const w = await run2(["pkcs12", "-export", "-in", pem, "-passout", "env:P12PW", "-out", out, ...legacy ? ["-legacy"] : []]);
    if (w.stderr) emitStderr(w.stderr);
    onProgress(`  exit ${w.code}; .p12 written: ${node_fs.existsSync(out) ? "yes" : "no"}`);
    if (w.code !== 0 || !node_fs.existsSync(out)) {
      onProgress("Step 2/2 FAILED: could not re-encode to the legacy format.");
      return { error: "Could not re-encode the certificate to the legacy format openssl/go-ios needs." };
    }
    onProgress("Certificate ready (legacy .p12).");
    return { path: out };
  } finally {
    try {
      if (node_fs.existsSync(pem)) node_fs.rmSync(pem);
    } catch {
    }
  }
}
let provProc = null;
let provToken = 0;
async function provision(bin, udid, cfg, onProgress) {
  const token = ++provToken;
  let p12;
  let profile;
  let p12password;
  if (cfg.method === "manual") {
    if (!manualReady(cfg)) return { ok: false, message: "Select your certificate (.p12) and provisioning profile (.mobileprovision) first." };
    if (!node_fs.existsSync(cfg.p12Path)) return { ok: false, message: "The .p12 file no longer exists at the saved path — re-select it." };
    if (!node_fs.existsSync(cfg.profilePath)) return { ok: false, message: "The .mobileprovision file no longer exists — re-select it." };
    onProgress("Preparing the certificate…");
    const legacy = await toLegacyP12(cfg.p12Path, cfg.p12Password || "", onProgress);
    if (token !== provToken) return { ok: false, message: "cancelled" };
    if ("error" in legacy) {
      return { ok: false, message: legacy.error };
    }
    p12 = legacy.path;
    profile = cfg.profilePath;
    p12password = cfg.p12Password || void 0;
  } else {
    if (!ascReady(cfg)) return { ok: false, message: "Enter your Key ID, Issuer ID, .p8 path, and bundle id first." };
    if (!node_fs.existsSync(cfg.p8Path)) return { ok: false, message: "The .p8 key file no longer exists at the saved path — re-select it." };
    p12 = node_path.join(assetsDir(), "agent.p12");
    profile = node_path.join(assetsDir(), "agent.mobileprovision");
    onProgress("Creating signing assets via App Store Connect…");
    const prov = await runCancelable(bin, provisionArgs(udid, cfg, p12, profile));
    if (token !== provToken) return { ok: false, message: "cancelled" };
    if (prov.code !== 0 || !node_fs.existsSync(p12) || !node_fs.existsSync(profile)) {
      return { ok: false, message: `Provisioning failed: ${lastLine$2(prov.stderr, prov.stdout) || "App Store Connect rejected the request"}` };
    }
  }
  onProgress(`Signing + installing the ${cfg.agent === "wda" ? "WebDriverAgent" : "DeviceKit"} agent (this can take a minute)…`);
  const inst = await runCancelable(bin, uiInstallArgs(udid, cfg.agent, p12, profile, p12password));
  if (token !== provToken) return { ok: false, message: "cancelled" };
  if (inst.code !== 0) {
    for (const l of `${inst.stderr}
${inst.stdout}`.split("\n").map((x) => x.trim()).filter(Boolean)) onProgress(`  go-ios: ${l}`);
    return { ok: false, message: `Install failed: ${lastLine$2(inst.stderr, inst.stdout) || "could not sign/install the agent"}` };
  }
  saveConfig({ provisioned: true });
  onProgress("Launching the agent + verifying it responds…");
  const reachable2 = await ensureAgent(bin, udid, onProgress);
  return {
    ok: true,
    message: reachable2 ? "Touch input is ready — the agent is installed and reachable." : 'Agent installed. First launch can take a moment (or a "Trust" tap on the device) — enable the 👆 touch button in the mirror to start it.'
  };
}
let wdaProc = null;
let fwdProc = null;
let agentUdid = null;
const delay$1 = (ms) => new Promise((r) => setTimeout(r, ms));
function spawnAgentChild(bin, args) {
  const child = node_child_process.spawn(bin, args, { stdio: "ignore" });
  child.on("error", () => {
  });
  return child;
}
function stopAgent() {
  for (const p of [wdaProc, fwdProc]) {
    if (p) {
      try {
        p.kill("SIGTERM");
      } catch {
      }
    }
  }
  wdaProc = null;
  fwdProc = null;
  agentUdid = null;
  wdaSession = null;
}
async function wdaReady(bin, udid, timeout = 8e3) {
  const r = await run(bin, uiStatusArgs(udid, WDA_DRIVER), timeout);
  return r.code === 0 && /"ready"\s*:\s*true/i.test(r.stdout);
}
async function ensureAgent(bin, udid, onProgress = () => {
}) {
  const prefer = loadConfig().agent;
  if (prefer === "devicekit") {
    stopAgent();
    if (await ensure(bin, udid, onProgress)) {
      activeAgent = "devicekit";
      return true;
    }
    if (await ensureWda(bin, udid, onProgress)) {
      activeAgent = "wda";
      return true;
    }
    activeAgent = null;
    return false;
  }
  if (await ensureWda(bin, udid, onProgress)) {
    stop();
    activeAgent = "wda";
    return true;
  }
  stopAgent();
  const ok = await ensure(bin, udid, onProgress);
  activeAgent = ok ? "devicekit" : null;
  return ok;
}
async function ensureWda(bin, udid, onProgress = () => {
}) {
  if (agentUdid && agentUdid !== udid) stopAgent();
  const tun = await startTunnel(bin, udid);
  if (!tun.ok) {
    onProgress(`  agent: tunnel not up (${tun.message})`);
    return false;
  }
  if (wdaProc && fwdProc && agentUdid === udid && await wdaReady(bin, udid)) return true;
  const apps = await run(bin, appsListArgs(udid), 3e4);
  const wdaBundle = findWdaBundleId(apps.stdout);
  if (!wdaBundle) {
    onProgress("  agent: WebDriverAgent is not installed — (re)install the input agent first.");
    return false;
  }
  onProgress(`  agent: launching ${wdaBundle}…`);
  stopAgent();
  agentUdid = udid;
  wdaProc = spawnAgentChild(bin, runWdaArgs(udid, wdaBundle));
  fwdProc = spawnAgentChild(bin, forwardArgs(udid, WDA_PORT, WDA_PORT));
  wdaProc.on("exit", () => {
    if (wdaProc && agentUdid === udid) {
      wdaProc = null;
    }
  });
  for (let i = 0; i < 20; i++) {
    if (agentUdid !== udid) return false;
    await delay$1(2e3);
    if (!wdaProc) {
      onProgress("  agent: the WebDriverAgent runner exited early — check signing/Trust on the device.");
      return false;
    }
    if (await wdaReady(bin, udid, 6e3)) {
      onProgress("  agent: ready.");
      return true;
    }
  }
  onProgress("  agent: not ready yet (timed out waiting for WebDriverAgent).");
  return false;
}
async function ensureUp(bin, udid) {
  if (activeAgent === "devicekit" && reachable()) return true;
  if (activeAgent === "wda" && wdaProc && fwdProc && agentUdid === udid) return true;
  return ensureAgent(bin, udid);
}
function shutdown() {
  cancelProvision();
  stop();
  stopAgent();
  sizeCache = null;
}
function runCancelable(bin, args) {
  return new Promise((resolve) => {
    const child = node_child_process.spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    provProc = child;
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => stdout += c.toString("utf8"));
    child.stderr.on("data", (c) => stderr += c.toString("utf8"));
    const done = (code) => {
      if (provProc === child) provProc = null;
      resolve({ code, stdout, stderr });
    };
    child.on("close", (c) => done(c ?? 0));
    child.on("error", () => done(1));
  });
}
function cancelProvision() {
  provToken++;
  if (provProc) {
    try {
      provProc.kill("SIGTERM");
    } catch {
    }
    provProc = null;
  }
}
async function status(bin, udid) {
  if (!loadConfig().provisioned) return false;
  return ensureAgent(bin, udid);
}
function wda(method, path, body, timeout = 12e3) {
  return new Promise((resolve) => {
    const data = body === void 0 ? void 0 : Buffer.from(JSON.stringify(body));
    const req = node_http.request(
      {
        host: "127.0.0.1",
        port: WDA_PORT,
        method,
        path,
        headers: {
          "Content-Type": "application/json",
          ...data ? { "Content-Length": data.length } : {}
        },
        timeout
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text2 = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(text2);
          } catch {
          }
          resolve({ status: res.statusCode ?? 0, json, text: text2 });
        });
      }
    );
    req.on("error", () => resolve({ status: 0, json: null, text: "" }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, json: null, text: "" });
    });
    if (data) req.write(data);
    req.end();
  });
}
let wdaSession = null;
async function ensureSession() {
  if (wdaSession) return wdaSession;
  const r = await wda("POST", "/session", {
    capabilities: { alwaysMatch: { "appium:waitForQuiescence": false } },
    desiredCapabilities: { shouldWaitForQuiescence: false, shouldUseCompactResponses: true }
  });
  const sid = r.json && typeof r.json.sessionId === "string" ? r.json.sessionId : null;
  if (!sid) return null;
  wdaSession = sid;
  await wda("POST", `/session/${sid}/appium/settings`, {
    settings: { shouldWaitForQuiescence: false, waitForIdleTimeout: 0, animationCoolOffTimeout: 0, snapshotMaxDepth: 1, useCompactResponses: true }
  });
  return sid;
}
function sessionInvalid(r) {
  return r.status === 404 || /invalid session id|session does not exist/i.test(r.text);
}
async function withSession(fn) {
  let sid = await ensureSession();
  if (!sid) return;
  let r = await fn(sid);
  if (sessionInvalid(r)) {
    wdaSession = null;
    sid = await ensureSession();
    if (!sid) return;
    r = await fn(sid);
  }
}
let inputChain = Promise.resolve();
function enqueue(job) {
  inputChain = inputChain.then(job, job);
}
function pointerGesture(x1, y1, x2, y2, moveMs) {
  const acts = [
    { type: "pointerMove", duration: 0, x: Math.round(x1), y: Math.round(y1) },
    { type: "pointerDown", button: 0 }
  ];
  if (x2 !== x1 || y2 !== y1 || moveMs > 0) {
    acts.push({ type: "pointerMove", duration: Math.max(0, Math.round(moveMs)), x: Math.round(x2), y: Math.round(y2) });
  }
  acts.push({ type: "pointerUp", button: 0 });
  return { actions: [{ type: "pointer", id: "finger1", parameters: { pointerType: "touch" }, actions: acts }] };
}
let sizeCache = null;
async function cachedSize(bin, udid) {
  if (sizeCache && sizeCache.udid === udid) return { width: sizeCache.width, height: sizeCache.height };
  const driver = activeAgent === "devicekit" ? DK_DRIVER : WDA_DRIVER;
  const r = await run(bin, uiSizeArgs(udid, driver), 12e3);
  const sz = parseUiSize(r.stdout);
  if (sz) sizeCache = { udid, ...sz };
  return sz;
}
async function size(bin, udid) {
  if (!await ensureAgent(bin, udid)) return null;
  return cachedSize(bin, udid);
}
function tap(_bin, _udid, x, y) {
  enqueue(async () => {
    if (activeAgent === "devicekit") {
      await tap$1(x, y);
      return;
    }
    await withSession((sid) => wda("POST", `/session/${sid}/actions`, pointerGesture(x, y, x, y, 0)));
  });
}
function gesture(_bin, _udid, points) {
  if (!points || points.length === 0) return;
  enqueue(async () => {
    if (activeAgent === "devicekit") {
      await gesture$1(pathToGestureActions(points));
      return;
    }
    const actions = pathToPointerActions(points);
    if (actions.length === 0) return;
    await withSession(
      (sid) => wda("POST", `/session/${sid}/actions`, { actions: [{ type: "pointer", id: "finger1", parameters: { pointerType: "touch" }, actions }] }, 15e3)
    );
  });
}
let dragActive = false;
let dragAnchor = null;
let dragTarget = null;
let dragInFlight = false;
let dragFlick = null;
const DRAG_MIN_DELTA = 20;
function dragSegment(from, to, moveMs) {
  if (activeAgent === "devicekit") {
    return gesture$1([
      { type: "press", duration: 0, x: Math.round(from.x), y: Math.round(from.y), button: 0 },
      { type: "move", duration: moveMs / 1e3, x: Math.round(to.x), y: Math.round(to.y), button: 0 },
      { type: "release", duration: 0, x: Math.round(to.x), y: Math.round(to.y), button: 0 }
    ]);
  }
  return withSession((sid) => wda("POST", `/session/${sid}/actions`, pointerGesture(from.x, from.y, to.x, to.y, moveMs), 12e3));
}
async function dragPump() {
  if (dragInFlight || !dragAnchor || !dragTarget) return;
  const from = dragAnchor;
  const to = dragTarget;
  const moved = Math.abs(to.x - from.x) + Math.abs(to.y - from.y);
  if (moved >= DRAG_MIN_DELTA) {
    dragInFlight = true;
    try {
      await dragSegment(from, to, 50);
    } finally {
      dragAnchor = to;
      dragInFlight = false;
      void dragPump();
    }
    return;
  }
  if (dragActive) return;
  if (dragFlick) {
    const flick = dragFlick;
    dragFlick = null;
    dragInFlight = true;
    try {
      await dragSegment(to, { x: flick.x, y: flick.y }, flick.durMs);
    } finally {
      dragAnchor = null;
      dragTarget = null;
      dragInFlight = false;
    }
    return;
  }
  dragAnchor = null;
  dragTarget = null;
}
function dragStart(_bin, _udid, x, y) {
  dragActive = true;
  dragAnchor = { x, y };
  dragTarget = { x, y };
  dragFlick = null;
}
function dragMove(_bin, _udid, x, y) {
  if (!dragActive) return;
  dragTarget = { x, y };
  void dragPump();
}
function dragEnd(_bin, _udid, x, y, flick) {
  dragActive = false;
  dragTarget = { x, y };
  dragFlick = flick && flick.durMs > 0 ? { x: flick.x, y: flick.y, durMs: flick.durMs } : null;
  void dragPump();
}
function swipe(_bin, _udid, x1, y1, x2, y2, durationSec) {
  const raw = durationSec && durationSec > 0 ? durationSec * 1e3 : 120;
  const moveMs = Math.max(20, Math.min(300, raw));
  enqueue(async () => {
    if (activeAgent === "devicekit") {
      await gesture$1([
        { type: "press", duration: 0, x: Math.round(x1), y: Math.round(y1), button: 0 },
        { type: "move", duration: moveMs / 1e3, x: Math.round(x2), y: Math.round(y2), button: 0 },
        { type: "release", duration: 0, x: Math.round(x2), y: Math.round(y2), button: 0 }
      ]);
      return;
    }
    await withSession((sid) => wda("POST", `/session/${sid}/actions`, pointerGesture(x1, y1, x2, y2, moveMs), 12e3));
  });
}
function type(_bin, _udid, text$1) {
  enqueue(async () => {
    if (activeAgent === "devicekit") {
      await text(text$1);
      return;
    }
    await withSession((sid) => wda("POST", `/session/${sid}/wda/keys`, { value: Array.from(text$1) }));
  });
}
const keyOps = [];
let keyInFlight = false;
async function runKeyOp(op) {
  if (activeAgent === "devicekit") {
    if (op.kind === "text") {
      await text(op.text);
      return;
    }
    const hasCmdCtrl = op.modifiers.includes("command") || op.modifiers.includes("control");
    if (op.domKey === "Enter" && !hasCmdCtrl) {
      await text("\n");
      return;
    }
    const k = deviceKitKey(op.domKey);
    if (k) await keys([{ key: k, modifiers: op.modifiers }]);
    return;
  }
  if (op.kind === "text") {
    await withSession((sid) => wda("POST", `/session/${sid}/wda/keys`, { value: Array.from(op.text) }));
    return;
  }
  const value = wdaKeyValue(op.domKey);
  if (value) await withSession((sid) => wda("POST", `/session/${sid}/wda/keys`, { value }));
}
async function keyPump() {
  if (keyInFlight) return;
  const op = keyOps.shift();
  if (!op) return;
  keyInFlight = true;
  try {
    await runKeyOp(op);
  } finally {
    keyInFlight = false;
    void keyPump();
  }
}
function key(_bin, _udid, domKey, modifiers) {
  const hasCmdCtrl = modifiers.includes("command") || modifiers.includes("control");
  if (domKey.length === 1 && !hasCmdCtrl) {
    const last = keyOps[keyOps.length - 1];
    if (last && last.kind === "text") last.text += domKey;
    else keyOps.push({ kind: "text", text: domKey });
  } else {
    keyOps.push({ kind: "key", domKey, modifiers });
  }
  void keyPump();
}
function button(bin, udid, name) {
  enqueue(async () => {
    if (!await ensureUp(bin, udid)) return;
    if (activeAgent === "devicekit") {
      if (name === "appswitcher" || name === "history" || name === "recents") {
        const sz = await cachedSize(bin, udid);
        if (sz) {
          const cx = Math.round(sz.width / 2);
          const h = sz.height;
          await gesture$1([
            { type: "press", duration: 0, x: cx, y: h - 1, button: 0 },
            { type: "move", duration: 0.06, x: cx, y: Math.round(h * 0.55), button: 0 },
            // fast drag up
            { type: "move", duration: 0.22, x: cx, y: Math.round(h * 0.5), button: 0 },
            // minimal hold (floor before it goes home)
            { type: "release", duration: 0, x: cx, y: Math.round(h * 0.5), button: 0 }
          ]);
        }
        return;
      }
      await button$1(DK_BUTTON_NAME[name] ?? name);
      return;
    }
    if (name === "home") {
      await wda("POST", "/wda/homescreen");
      wdaSession = null;
      return;
    }
    if (name === "appswitcher" || name === "history" || name === "recents") {
      await withSession(async (sid) => {
        const wr = await wda("GET", `/session/${sid}/window/size`);
        const v = wr.json?.value;
        const w = v?.width ?? 0;
        const h = v?.height ?? 0;
        if (!w || !h) return wr;
        const cx = Math.round(w / 2);
        const gesture2 = {
          actions: [
            {
              type: "pointer",
              id: "finger1",
              parameters: { pointerType: "touch" },
              actions: [
                { type: "pointerMove", duration: 0, x: cx, y: h - 1 },
                { type: "pointerDown", button: 0 },
                { type: "pointerMove", duration: 60, x: cx, y: Math.round(h * 0.55) },
                // fast drag up
                { type: "pointerMove", duration: 220, x: cx, y: Math.round(h * 0.5) },
                // minimal hold
                { type: "pointerUp", button: 0 }
              ]
            }
          ]
        };
        return wda("POST", `/session/${sid}/actions`, gesture2, 12e3);
      });
      wdaSession = null;
      return;
    }
    const wdaName = WDA_BUTTON_NAME[name] ?? name;
    await withSession((sid) => wda("POST", `/session/${sid}/wda/pressButton`, { name: wdaName }));
  });
}
const WDA_BUTTON_NAME = {
  volumeup: "volumeUp",
  volumedown: "volumeDown",
  home: "home",
  lock: "lock"
};
const DK_BUTTON_NAME = {
  volumeup: "volumeUp",
  volumedown: "volumeDown",
  home: "home",
  lock: "lock"
};
const READS = [
  ["night", "cmd uimode night"],
  ["font_scale", "settings get system font_scale"],
  ["density", "wm density"],
  ["anim", "settings get global animator_duration_scale"],
  ["show_touches", "settings get system show_touches"],
  ["pointer", "settings get system pointer_location"],
  ["layout", "getprop debug.layout"],
  ["hwui", "getprop debug.hwui.profile"],
  ["rtl", "settings get global debug.force_rtl"],
  ["overdraw", "getprop debug.hwui.overdraw"],
  [
    "dalt",
    "settings get secure accessibility_display_daltonizer_enabled; settings get secure accessibility_display_daltonizer"
  ],
  ["wifi", "cmd wifi status"],
  ["data", "settings get global mobile_data"],
  ["airplane", "settings get global airplane_mode_on"],
  ["anr", "settings get secure anr_show_background"],
  ["rot", "settings get system accelerometer_rotation; settings get system user_rotation"],
  ["bright", "settings get system screen_brightness; settings get system screen_brightness_mode"],
  ["timeout", "settings get system screen_off_timeout"],
  ["loc", "settings get secure location_mode"],
  ["bt", "settings get global bluetooth_on"],
  ["lowpower", "settings get global low_power"],
  ["datasaver", "cmd netpolicy get restrict-background"],
  ["proxy", "settings get global http_proxy"],
  ["overlay", "settings get global overlay_display_devices"],
  ["finish", "settings get global always_finish_activities"],
  ["stay", "settings get global stay_on_while_plugged_in"],
  ["battery", "dumpsys battery"],
  ["doze", "dumpsys deviceidle get deep"]
];
function readStateScript() {
  return READS.map(([k, cmd]) => `echo @@${k}@@; ${cmd} 2>/dev/null`).join("; ");
}
function parseState(text2) {
  const out = {};
  let key2 = null;
  for (const line of text2.split("\n")) {
    const m = /^@@(\w+)@@\s*$/.exec(line.trim());
    if (m) {
      key2 = m[1];
      out[key2] = "";
    } else if (key2 !== null) {
      out[key2] += line + "\n";
    }
  }
  const result = {};
  for (const k of Object.keys(out)) result[k] = out[k].trim();
  return result;
}
function firstNum(s, def = null) {
  const m = /-?\d+(?:\.\d+)?/.exec(s ?? "");
  return m ? parseFloat(m[0]) : def;
}
const trunc = (n) => Math.trunc(n);
function interpretState(s) {
  const get = (k) => s[k] ?? "";
  const batt = get("battery");
  const level = /level:\s*(\d+)/.exec(batt);
  const powered = /(AC|USB|Wireless) powered: true/.test(batt);
  const dens = get("density");
  const over = /Override density:\s*(\d+)/.exec(dens);
  const phys = /Physical density:\s*(\d+)/.exec(dens);
  const densMatch = over || phys;
  const daltLines = [...get("dalt").split("\n"), "", ""];
  const daltOn = daltLines[0].trim() === "1";
  const daltVal = firstNum(daltLines[1]);
  const wifiLine = (get("wifi").split("\n")[0] || "").toLowerCase();
  const rotLines = [...get("rot").split("\n"), "", ""];
  const brightLines = [...get("bright").split("\n"), "", ""];
  const overlay = get("overlay").trim();
  const proxyRaw = get("proxy").trim();
  const proxy = proxyRaw === "" || proxyRaw.toLowerCase() === "null" || proxyRaw === ":0" ? "" : proxyRaw;
  return {
    night: get("night").toLowerCase().includes("yes"),
    fontScale: firstNum(get("font_scale"), 1) || 1,
    density: densMatch ? parseInt(densMatch[1], 10) : null,
    densityOverridden: over !== null,
    animOff: (firstNum(get("anim"), 1) || 0) === 0,
    showTouches: get("show_touches") === "1",
    pointer: get("pointer") === "1",
    layout: get("layout") === "true",
    hwui: get("hwui").includes("visual_bars"),
    rtl: get("rtl") === "1",
    overdraw: get("overdraw").includes("show"),
    dalt: daltOn && daltVal !== null ? trunc(daltVal) : -1,
    wifi: wifiLine.includes("is enabled"),
    data: get("data") === "1",
    airplane: get("airplane") === "1",
    anr: get("anr") === "1",
    rotation: rotLines[0].trim() === "1" ? -1 : trunc(firstNum(rotLines[1], 0) || 0),
    brightness: trunc(firstNum(brightLines[0], 128) || 128),
    brightAuto: brightLines[1].trim() === "1",
    timeoutMs: trunc(firstNum(get("timeout"), 0) || 0),
    location: !["0", "null"].includes(get("loc") || "0"),
    bluetooth: get("bt") === "1",
    batterySaver: get("lowpower") === "1",
    dataSaver: get("datasaver").toLowerCase().includes("enabled"),
    proxy,
    overlay: overlay === "" || overlay === "null" ? "" : overlay,
    finish: get("finish") === "1",
    stay: !["0", "null"].includes(get("stay") || "0"),
    batteryLevel: level ? parseInt(level[1], 10) : null,
    batteryPowered: powered,
    dozeIdle: get("doze").toUpperCase() === "IDLE"
  };
}
function parseAppLocales(text2) {
  const m = /\[([^\]]*)\]/.exec(text2 || "");
  return m ? m[1].trim() : "";
}
function getAppLocalesArgs(pkg) {
  return ["shell", "cmd", "locale", "get-app-locales", pkg, "--user", "0"];
}
function getStandbyBucketArgs(pkg) {
  return ["shell", "am", "get-standby-bucket", pkg];
}
async function readControlsState(adb, serial, pkg) {
  const r = await run$3(adb, serial, ["shell", readStateScript()], 15e3);
  if (!r.stdout && r.stderr) return { ok: false, message: r.stderr.trim(), state: null };
  const state = interpretState(parseState(r.stdout));
  if (pkg) {
    state.bucket = (await run$3(adb, serial, getStandbyBucketArgs(pkg), 1e4)).stdout.trim();
    state.appLocales = parseAppLocales((await run$3(adb, serial, getAppLocalesArgs(pkg), 1e4)).stdout);
  }
  return { ok: true, message: "", state };
}
async function applyControls(adb, serial, argvs, label) {
  for (const argv of argvs) {
    const r = await run$3(adb, serial, argv, 15e3);
    const err = (r.stderr || "").trim();
    if (r.code !== 0 && err) {
      return { ok: false, message: `${label}: ${err.split("\n").pop()}` };
    }
  }
  return { ok: true, message: label };
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function enableWirelessDebug(adb, serial) {
  const route = await run$3(adb, serial, ipRouteArgs(), 1e4);
  const ip = parseDeviceIp(route.stdout);
  if (!ip) {
    return { ok: false, message: "Couldn't find the device's Wi-Fi IP (is Wi-Fi connected?)" };
  }
  const tcp = await run$3(adb, serial, tcpipArgs(), 15e3);
  const tcpOut = `${tcp.stdout}
${tcp.stderr}`;
  if (tcpOut.toLowerCase().includes("error")) {
    return { ok: false, message: tcpOut.trim() };
  }
  await delay(1500);
  const address = `${ip}:5555`;
  const conn = await run$3(adb, null, connectArgs(address), 15e3);
  const out = `${conn.stdout}
${conn.stderr}`.trim();
  return { ok: looksOk(out), message: out || "(no output)", address };
}
const DEFAULTS = { autoWifi: true, wifiOptOut: [], autoTunnel: true };
function settingsPath$1() {
  return node_path.join(electron.app.getPath("userData"), "settings.json");
}
function loadSettings() {
  try {
    const raw = JSON.parse(node_fs.readFileSync(settingsPath$1(), "utf8"));
    return {
      autoWifi: typeof raw.autoWifi === "boolean" ? raw.autoWifi : DEFAULTS.autoWifi,
      wifiOptOut: Array.isArray(raw.wifiOptOut) ? raw.wifiOptOut.filter((s) => typeof s === "string") : [],
      autoTunnel: typeof raw.autoTunnel === "boolean" ? raw.autoTunnel : DEFAULTS.autoTunnel
    };
  } catch {
    return { ...DEFAULTS };
  }
}
function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  const path = settingsPath$1();
  try {
    node_fs.mkdirSync(node_path.dirname(path), { recursive: true });
    node_fs.writeFileSync(path, JSON.stringify(next, null, 2), "utf8");
  } catch {
  }
  return next;
}
const HELPER_PKG = "com.logcatviewer.mocklocation";
const SERVICE = `${HELPER_PKG}/.MockService`;
const MOCK_APPOP = "android:mock_location";
const HELPER_APK_NAME = "mocklocation.apk";
function fmtCoord(n) {
  return n.toFixed(7);
}
function formatG(n) {
  if (!Number.isFinite(n)) return String(n);
  if (n === 0) return "0";
  const s = n.toPrecision(6);
  const eIdx = s.indexOf("e");
  if (eIdx === -1) {
    return s.indexOf(".") === -1 ? s : s.replace(/\.?0+$/, "");
  }
  const mantissa = s.slice(0, eIdx);
  const exp = s.slice(eIdx);
  const m = mantissa.indexOf(".") === -1 ? mantissa : mantissa.replace(/\.?0+$/, "");
  return m + exp;
}
function setArgs(serial, lat, lng, acc = null, alt = null) {
  const args = [
    "-s",
    serial,
    "shell",
    "am",
    "start-foreground-service",
    "-n",
    SERVICE,
    "--es",
    "cmd",
    "set",
    "--es",
    "lat",
    fmtCoord(lat),
    "--es",
    "lng",
    fmtCoord(lng)
  ];
  if (acc !== null) args.push("--es", "acc", formatG(acc));
  if (alt !== null) args.push("--es", "alt", formatG(alt));
  return args;
}
function stopArgs(serial) {
  return ["-s", serial, "shell", "am", "start-foreground-service", "-n", SERVICE, "--es", "cmd", "stop"];
}
function helperApkPath() {
  if (electron.app.isPackaged) return node_path.join(process.resourcesPath, HELPER_APK_NAME);
  return node_path.join(electron.app.getAppPath(), "resources", HELPER_APK_NAME);
}
class MockLocationService {
  constructor(adb) {
    this.adb = adb;
  }
  /** The serial with a live mock we haven't stopped yet (null = nothing mocking). */
  activeSerial = null;
  // --- setup (MockSetupWorker) ---------------------------------------------
  /** Ensure the helper is installed and allowed to mock. */
  async setup(serial) {
    try {
      const already = await this.isInstalled(serial);
      if (!already) {
        const r = await this.install(serial);
        if (!r.ok) return r;
      }
      await this.appopsAllow(serial);
      if (!await this.appopIsAllow(serial)) {
        return {
          ok: false,
          message: "Couldn't grant the mock-location permission (appops). Enable USB debugging (Secure settings) may be required."
        };
      }
      return { ok: true, message: already ? "Helper ready" : "Helper installed" };
    } catch (e) {
      return { ok: false, message: `Setup failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  async isInstalled(serial) {
    const r = await run$3(this.adb, serial, ["shell", "pm", "list", "packages", HELPER_PKG], 8e3);
    return r.stdout.includes(HELPER_PKG);
  }
  async install(serial) {
    const apk = helperApkPath();
    if (!node_fs.existsSync(apk)) return { ok: false, message: `Bundled helper APK is missing:
${apk}` };
    const r = await run$3(this.adb, serial, ["install", "-r", "-g", apk], 18e4);
    if (r.code === 0 && r.stdout.includes("Success")) return { ok: true, message: "installed" };
    const r2 = await run$3(this.adb, serial, ["install", "-r", apk], 18e4);
    if (r2.code === 0 && r2.stdout.includes("Success")) {
      for (const perm of [
        "android.permission.ACCESS_FINE_LOCATION",
        "android.permission.ACCESS_COARSE_LOCATION"
      ]) {
        await run$3(this.adb, serial, ["shell", "pm", "grant", HELPER_PKG, perm], 8e3);
      }
      return { ok: true, message: "installed" };
    }
    const blob = (r.stderr || r.stdout || r2.stderr || r2.stdout || "").trim().split("\n").filter(Boolean);
    return { ok: false, message: "Install failed: " + (blob.length ? blob[blob.length - 1] : "unknown error") };
  }
  async appopsAllow(serial) {
    await run$3(this.adb, serial, ["shell", "appops", "set", HELPER_PKG, MOCK_APPOP, "allow"], 8e3);
  }
  async appopIsAllow(serial) {
    const r = await run$3(this.adb, serial, ["shell", "appops", "get", HELPER_PKG, MOCK_APPOP], 8e3);
    return r.stdout.toLowerCase().includes("allow");
  }
  // --- set / stop (the QProcess.startDetached drivers) ---------------------
  /** Start/update the mock at lat,lng. `setArgs` carries its own `-s <serial>`,
   *  so pass serial=null to `run` (which would otherwise prepend a second one). */
  async set(serial, lat, lng, acc = 5, alt = null) {
    this.activeSerial = serial;
    const r = await run$3(this.adb, null, setArgs(serial, lat, lng, acc, alt), 15e3);
    const err = (r.stderr || "").trim();
    if (r.code !== 0 && err) return { ok: false, message: err.split("\n").pop() ?? "set failed" };
    return { ok: true, message: "ok" };
  }
  /** Stop mocking + tear down the providers on `serial`. */
  async stop(serial) {
    const r = await run$3(this.adb, null, stopArgs(serial), 15e3);
    if (this.activeSerial === serial) this.activeSerial = null;
    const err = (r.stderr || "").trim();
    if (r.code !== 0 && err) return { ok: false, message: err.split("\n").pop() ?? "stop failed" };
    return { ok: true, message: "ok" };
  }
  /** No mock may outlive the app: stop whatever serial is still mocking. */
  shutdown() {
    const serial = this.activeSerial;
    if (!serial) return;
    this.activeSerial = null;
    void run$3(this.adb, null, stopArgs(serial), 8e3).catch(() => {
    });
  }
}
const SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"];
const PAGE_SIZE = 200;
const QUERY_ROW_CAP = 5e3;
const SQLITE_MAGIC = "SQLite format 3\0";
function dbHome(pkg) {
  return `/data/data/${pkg}/databases`;
}
const RUNAS_BLOCKED = ["not debuggable", "unknown package", "is unknown", "package inaccessible"];
function listDbsArgs(serial, pkg, su = false) {
  if (su) return ["-s", serial, "shell", "su", "-c", "ls", "-1", dbHome(pkg)];
  return ["-s", serial, "shell", "run-as", pkg, "ls", "-1", "databases/"];
}
function catDbArgs(serial, pkg, name, su = false) {
  if (su) return ["-s", serial, "exec-out", "su", "-c", "cat", `${dbHome(pkg)}/${name}`];
  return ["-s", serial, "exec-out", "run-as", pkg, "cat", `databases/${name}`];
}
function sqlite3ProbeArgs(serial) {
  return ["-s", serial, "shell", "command", "-v", "sqlite3"];
}
function editArgs(serial, pkg, db, su = false) {
  if (su) return ["-s", serial, "shell", "su", "-c", "sqlite3", `${dbHome(pkg)}/${db}`];
  return ["-s", serial, "shell", "run-as", pkg, "sqlite3", `databases/${db}`];
}
function dbCandidates(names) {
  const out = [];
  for (const raw of names) {
    const n = raw.trim();
    if (!n) continue;
    if (SIDECAR_SUFFIXES.some((s) => n.endsWith(s))) continue;
    if (n.endsWith("-lock") || n.endsWith(".lock")) continue;
    out.push(n);
  }
  return out.sort((a, b) => {
    const la = a.toLowerCase();
    const lb = b.toLowerCase();
    return la < lb ? -1 : la > lb ? 1 : 0;
  });
}
function classifyListing$1(returncode, stdout, stderr) {
  if (returncode === 0) return { dbs: dbCandidates(stdout.split("\n")), error: null };
  const low = (stderr || "").toLowerCase();
  if (low.includes("no such file") || low.includes("not found")) {
    return { dbs: [], error: null };
  }
  if (RUNAS_BLOCKED.some((m) => low.includes(m))) return { dbs: null, error: "blocked" };
  return { dbs: null, error: stderr.trim() || "couldn't list databases" };
}
function isSqliteFile(bytes) {
  if (bytes.length < 16) return false;
  for (let i = 0; i < 16; i++) {
    if (bytes[i] !== SQLITE_MAGIC.charCodeAt(i)) return false;
  }
  return true;
}
function quoteIdent(name) {
  return '"' + name.replace(/"/g, '""') + '"';
}
function bytesToHex(bytes) {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}
function sqlLiteral(value, setNull = false) {
  if (setNull || value === null) return "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(value);
  return "'" + value.replace(/'/g, "''") + "'";
}
function buildUpdateSql(table, col, rowid, value, setNull = false) {
  return `UPDATE ${quoteIdent(table)} SET ${quoteIdent(col)}=${sqlLiteral(value, setNull)} WHERE _rowid_=${Math.trunc(rowid)};`;
}
const nodeRequire = node_module.createRequire(__filename);
let sqlPromise = null;
function getSql() {
  if (!sqlPromise) {
    const buf = node_fs.readFileSync(nodeRequire.resolve("sql.js/dist/sql-wasm.wasm"));
    const wasmBinary = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    sqlPromise = initSqlJs({ wasmBinary });
  }
  return sqlPromise;
}
function runWithInput$1(adb, args, input, timeoutMs) {
  return new Promise((resolve) => {
    const child = node_child_process.execFile(
      adb,
      args,
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => {
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          code: err && typeof err.code === "number" ? err.code : err ? 1 : 0
        });
      }
    );
    child.stdin?.end(input);
  });
}
function toDbValue(v) {
  if (v === null) return null;
  if (v instanceof Uint8Array) return { blob: bytesToHex(v) };
  return v;
}
function errMsg$4(e) {
  return e instanceof Error ? e.message : String(e);
}
const appKey$1 = (serial, pkg) => `${serial}\0${pkg}`;
const snapKey = (serial, pkg, db) => `${serial}\0${pkg}\0${db}`;
const sanitize = (s) => s.replace(/[^\w.@-]/g, "_");
function listTables(db) {
  const res = db.exec(
    "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type DESC, name COLLATE NOCASE"
  );
  const out = [];
  if (res.length === 0) return out;
  for (const row of res[0].values) {
    const name = String(row[0]);
    const type2 = String(row[1]) === "view" ? "view" : "table";
    let count = -1;
    try {
      const c = db.exec(`SELECT COUNT(*) FROM ${quoteIdent(name)}`);
      const v = c[0]?.values[0]?.[0];
      count = typeof v === "number" ? v : -1;
    } catch {
      count = -1;
    }
    out.push({ name, type: type2, count });
  }
  return out;
}
function countRows(db, quotedTable) {
  const res = db.exec(`SELECT COUNT(*) FROM ${quotedTable}`);
  const v = res[0]?.values[0]?.[0];
  return typeof v === "number" ? v : 0;
}
function readTablePage(db, table, limit, offset) {
  const q = quoteIdent(table);
  let cols;
  let rows;
  let rowids = null;
  try {
    const stmt = db.prepare(`SELECT _rowid_ AS __rid__, * FROM ${q} LIMIT ? OFFSET ?`);
    try {
      stmt.bind([limit, offset]);
      const allc = stmt.getColumnNames();
      const raw = [];
      while (stmt.step()) raw.push(stmt.get());
      rowids = raw.map((r) => typeof r[0] === "number" ? r[0] : null);
      cols = allc.slice(1);
      rows = raw.map((r) => r.slice(1).map(toDbValue));
    } finally {
      stmt.free();
    }
  } catch {
    const stmt = db.prepare(`SELECT * FROM ${q} LIMIT ? OFFSET ?`);
    try {
      stmt.bind([limit, offset]);
      cols = stmt.getColumnNames();
      rows = [];
      while (stmt.step()) rows.push(stmt.get().map(toDbValue));
    } finally {
      stmt.free();
    }
    rowids = null;
  }
  return { cols, rows, total: countRows(db, q), rowids };
}
function runFreeQuery(db, sql, cap2) {
  const stmt = db.prepare(sql);
  try {
    const cols = stmt.getColumnNames();
    const rows = [];
    let truncated = false;
    while (stmt.step()) {
      if (rows.length >= cap2) {
        truncated = true;
        break;
      }
      rows.push(stmt.get().map(toDbValue));
    }
    return { cols, rows, truncated };
  } finally {
    stmt.free();
  }
}
const errRows$1 = (message) => ({
  ok: false,
  cols: [],
  rows: [],
  total: -1,
  truncated: false,
  rowids: null,
  message
});
class DbService {
  // (serial|pkg) -> reached via su
  constructor(adb) {
    this.adb = adb;
  }
  tmpDir = null;
  snapshots = /* @__PURE__ */ new Map();
  // (serial|pkg|db) -> local path
  suByApp = /* @__PURE__ */ new Map();
  tmp() {
    if (!this.tmpDir) this.tmpDir = node_fs.mkdtempSync(node_path.join(node_os.tmpdir(), "androidlab-db-"));
    return this.tmpDir;
  }
  // --- listing (DbListWorker) -------------------------------------------------
  async runList(serial, pkg, su) {
    const r = await run$3(this.adb, null, listDbsArgs(serial, pkg, su), 15e3);
    return classifyListing$1(r.code ?? 1, r.stdout, r.stderr);
  }
  async hasSqlite3(serial) {
    const r = await run$3(this.adb, null, sqlite3ProbeArgs(serial), 8e3);
    return r.code === 0 && r.stdout.includes("sqlite3");
  }
  async list(serial, pkg) {
    const first = await this.runList(serial, pkg, false);
    if (first.error === "blocked") {
      const suRes = await this.runList(serial, pkg, true);
      if (suRes.dbs !== null) {
        this.suByApp.set(appKey$1(serial, pkg), true);
        return {
          ok: true,
          dbs: suRes.dbs,
          message: `${suRes.dbs.length} database(s) via su`,
          usedSu: true,
          hasSqlite3: await this.hasSqlite3(serial)
        };
      }
      return {
        ok: false,
        dbs: [],
        message: `'${pkg}' is not debuggable and the device isn't rooted — its databases can’t be read. Use a debuggable build or a rooted device/emulator.`,
        usedSu: false,
        hasSqlite3: false
      };
    }
    if (first.dbs === null) {
      return {
        ok: false,
        dbs: [],
        message: `Couldn't list databases: ${first.error}`,
        usedSu: false,
        hasSqlite3: false
      };
    }
    this.suByApp.set(appKey$1(serial, pkg), false);
    return {
      ok: true,
      dbs: first.dbs,
      message: first.dbs.length ? `${first.dbs.length} database(s)` : "No databases found for this app",
      usedSu: false,
      hasSqlite3: await this.hasSqlite3(serial)
    };
  }
  // --- pulling a snapshot (DbOpenWorker._pull) --------------------------------
  async pull(serial, pkg, name, dest, su) {
    const r = await runBinary(this.adb, catDbArgs(serial, pkg, name, su), 18e4);
    if (r.stdout.length === 0) return false;
    node_fs.writeFileSync(dest, r.stdout);
    return true;
  }
  /** Ensure the main DB (+ sidecars) is pulled; returns the local path or null. */
  async ensureSnapshot(serial, pkg, name, force) {
    const key2 = snapKey(serial, pkg, name);
    const cached2 = this.snapshots.get(key2);
    if (cached2 && !force && node_fs.existsSync(cached2)) return { path: cached2, message: "" };
    const su = this.suByApp.get(appKey$1(serial, pkg)) ?? false;
    const local = node_path.join(this.tmp(), `${sanitize(serial)}__${sanitize(pkg)}__${sanitize(name)}`);
    if (!await this.pull(serial, pkg, name, local, su)) {
      return { path: null, message: `Couldn't read '${name}' from device` };
    }
    for (const suf of SIDECAR_SUFFIXES) await this.pull(serial, pkg, name + suf, local + suf, su);
    this.snapshots.set(key2, local);
    return { path: local, message: "" };
  }
  snapshotPath(serial, pkg, name) {
    const p = this.snapshots.get(snapKey(serial, pkg, name));
    return p && node_fs.existsSync(p) ? p : null;
  }
  // --- opening a database (DbOpenWorker) --------------------------------------
  async open(serial, pkg, name, force = false) {
    const snap = await this.ensureSnapshot(serial, pkg, name, force);
    if (snap.path === null) return { ok: false, name, tables: [], message: snap.message };
    const bytes = node_fs.readFileSync(snap.path);
    if (!isSqliteFile(bytes)) {
      return { ok: false, name, tables: [], message: `'${name}' is not a SQLite database` };
    }
    try {
      const SQL = await getSql();
      const db = new SQL.Database(bytes);
      try {
        const tables = listTables(db);
        return { ok: true, name, tables, message: `${name}: ${tables.length} table(s)` };
      } finally {
        db.close();
      }
    } catch (e) {
      return { ok: false, name, tables: [], message: `Couldn't open '${name}': ${errMsg$4(e)}` };
    }
  }
  // --- reading (QueryWorker) --------------------------------------------------
  async withDb(serial, pkg, name, fn) {
    const path = this.snapshotPath(serial, pkg, name);
    if (path === null) return { __err: `'${name}' is not connected — open it first` };
    try {
      const SQL = await getSql();
      const db = new SQL.Database(node_fs.readFileSync(path));
      try {
        db.run("PRAGMA query_only = ON");
        return fn(db);
      } finally {
        db.close();
      }
    } catch (e) {
      return { __err: errMsg$4(e) };
    }
  }
  async readTable(serial, pkg, name, table, limit, offset) {
    const r = await this.withDb(
      serial,
      pkg,
      name,
      (db) => readTablePage(db, table, limit || PAGE_SIZE, offset)
    );
    if ("__err" in r) return errRows$1(r.__err);
    return { ok: true, cols: r.cols, rows: r.rows, total: r.total, truncated: false, rowids: r.rowids, message: "" };
  }
  async runQuery(serial, pkg, name, sql) {
    const r = await this.withDb(serial, pkg, name, (db) => runFreeQuery(db, sql, QUERY_ROW_CAP));
    if ("__err" in r) return errRows$1(r.__err);
    return { ok: true, cols: r.cols, rows: r.rows, total: -1, truncated: r.truncated, rowids: null, message: "" };
  }
  // --- editing the LIVE device DB (EditWorker) --------------------------------
  async edit(serial, pkg, name, table, col, rowid, value, setNull) {
    const su = this.suByApp.get(appKey$1(serial, pkg)) ?? false;
    const sql = "PRAGMA busy_timeout=3000;\n" + buildUpdateSql(table, col, rowid, value, setNull) + "\nSELECT changes();\n";
    const r = await runWithInput$1(this.adb, editArgs(serial, pkg, name, su), sql, 2e4);
    const err = (r.stderr || "").trim();
    const low = err.toLowerCase();
    if (low.includes("sqlite3") && (low.includes("not found") || low.includes("no such file") || low.includes("exec failed"))) {
      return {
        ok: false,
        message: "the device has no 'sqlite3' binary — editing needs an emulator, a rooted device, or a userdebug build"
      };
    }
    if (r.code !== 0 || low.includes("error")) {
      return { ok: false, message: err || `sqlite3 exited with code ${r.code}` };
    }
    let changed = 0;
    for (const line of (r.stdout || "").split("\n").reverse()) {
      const t = line.trim();
      if (/^\d+$/.test(t)) {
        changed = parseInt(t, 10);
        break;
      }
    }
    if (changed < 1) {
      return { ok: false, message: "no row matched (it may have changed) — Refresh and retry" };
    }
    await this.mirrorLocal(serial, pkg, name, table, col, rowid, value, setNull);
    return { ok: true, message: "1 row updated on the device" };
  }
  /** Mirror a confirmed device edit onto the local snapshot (best-effort, like
   *  apply_local_update) so a subsequent page read matches without a re-pull. */
  async mirrorLocal(serial, pkg, name, table, col, rowid, value, setNull) {
    const path = this.snapshotPath(serial, pkg, name);
    if (path === null) return;
    try {
      const SQL = await getSql();
      const db = new SQL.Database(node_fs.readFileSync(path));
      try {
        db.run(buildUpdateSql(table, col, rowid, value, setNull));
        node_fs.writeFileSync(path, db.export());
      } finally {
        db.close();
      }
    } catch {
    }
  }
  // --- export a self-contained .db (DbExportWorker) ---------------------------
  async exportDb(serial, pkg, name, destPath) {
    const snap = await this.ensureSnapshot(serial, pkg, name, false);
    if (snap.path === null) return { ok: false, message: snap.message, dir: "" };
    try {
      const SQL = await getSql();
      const db = new SQL.Database(node_fs.readFileSync(snap.path));
      try {
        node_fs.writeFileSync(destPath, db.export());
      } finally {
        db.close();
      }
    } catch (e) {
      return { ok: false, message: `Export failed: ${errMsg$4(e)}`, dir: "" };
    }
    let size2 = 0;
    try {
      size2 = node_fs.statSync(destPath).size;
    } catch {
      size2 = 0;
    }
    return {
      ok: true,
      message: `Exported ${node_path.basename(destPath)} (${Math.round(size2 / 1024)} KB)`,
      dir: node_path.dirname(destPath)
    };
  }
  // --- CSV export (writes text already built by the renderer via core.toCsv) --
  saveCsv(text2, destPath, rowCount) {
    try {
      node_fs.writeFileSync(destPath, text2, "utf8");
    } catch (e) {
      return { ok: false, message: `Export failed: ${errMsg$4(e)}`, dir: "" };
    }
    return {
      ok: true,
      message: `Exported ${rowCount.toLocaleString()} row(s) to ${node_path.basename(destPath)}`,
      dir: node_path.dirname(destPath)
    };
  }
  /** Remove the pulled snapshots on app close (mirrors DatabaseView.shutdown). */
  shutdown() {
    if (this.tmpDir) {
      try {
        node_fs.rmSync(this.tmpDir, { recursive: true, force: true });
      } catch {
      }
      this.tmpDir = null;
    }
    this.snapshots.clear();
  }
}
const SQLITE_EXT = /\.(sqlite3?|db)$/i;
const SIDECAR = /-(wal|shm|journal)$/i;
function errMsg$3(e) {
  return e instanceof Error ? e.message : String(e);
}
const errRows = (message) => ({
  ok: false,
  cols: [],
  rows: [],
  total: -1,
  truncated: false,
  rowids: null,
  message
});
class IosDbService {
  constructor(bin) {
    this.bin = bin;
  }
  tmpDir = null;
  snapshots = /* @__PURE__ */ new Map();
  // (udid|pkg|name) -> local path
  seq = 0;
  tmp() {
    if (!this.tmpDir) this.tmpDir = node_fs.mkdtempSync(node_path.join(node_os.tmpdir(), "androidlab-iosdb-"));
    return this.tmpDir;
  }
  // --- list databases in the app container (fsync tree) -----------------------
  async list(udid, pkg) {
    const t = await containerTree(this.bin, udid, pkg, ".");
    if (!t.ok) return { ok: false, dbs: [], message: t.error, usedSu: false, hasSqlite3: false };
    const dbs = t.entries.filter((e) => !e.isDir && SQLITE_EXT.test(e.name) && !SIDECAR.test(e.name)).map((e) => e.path).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    return {
      ok: true,
      dbs,
      message: dbs.length ? `${dbs.length} database(s)` : "No SQLite databases found in this app’s container",
      usedSu: false,
      hasSqlite3: false
      // no on-device sqlite3 → read-only (UI hides editing)
    };
  }
  // --- pull a snapshot (fsync pull drops the file into a dir; see goios) -------
  async ensureSnapshot(udid, pkg, name, force) {
    const key2 = `${udid}|${pkg}|${name}`;
    const cached2 = this.snapshots.get(key2);
    if (cached2 && !force && node_fs.existsSync(cached2)) return cached2;
    const dir = node_path.join(this.tmp(), String(this.seq++));
    const inner = await containerPull(this.bin, udid, pkg, name, dir);
    if (inner) this.snapshots.set(key2, inner);
    return inner;
  }
  async open(udid, pkg, name, force = false) {
    const path = await this.ensureSnapshot(udid, pkg, name, force);
    if (!path) return { ok: false, name, tables: [], message: `Couldn't read '${name}' from the container` };
    const bytes = node_fs.readFileSync(path);
    if (!isSqliteFile(bytes)) {
      return { ok: false, name, tables: [], message: `'${node_path.basename(name)}' is not a SQLite database` };
    }
    try {
      const SQL = await getSql();
      const db = new SQL.Database(bytes);
      try {
        const tables = listTables(db);
        return { ok: true, name, tables, message: `${node_path.basename(name)}: ${tables.length} table(s)` };
      } finally {
        db.close();
      }
    } catch (e) {
      return { ok: false, name, tables: [], message: `Couldn't open '${node_path.basename(name)}': ${errMsg$3(e)}` };
    }
  }
  async withDb(udid, pkg, name, fn) {
    const path = this.snapshots.get(`${udid}|${pkg}|${name}`);
    if (!path || !node_fs.existsSync(path)) return { __err: `'${node_path.basename(name)}' is not connected — open it first` };
    try {
      const SQL = await getSql();
      const db = new SQL.Database(node_fs.readFileSync(path));
      try {
        db.run("PRAGMA query_only = ON");
        return fn(db);
      } finally {
        db.close();
      }
    } catch (e) {
      return { __err: errMsg$3(e) };
    }
  }
  async readTable(udid, pkg, name, table, limit, offset) {
    const r = await this.withDb(udid, pkg, name, (db) => readTablePage(db, table, limit || PAGE_SIZE, offset));
    if ("__err" in r) return errRows(r.__err);
    return { ok: true, cols: r.cols, rows: r.rows, total: r.total, truncated: false, rowids: r.rowids, message: "" };
  }
  async runQuery(udid, pkg, name, sql) {
    const r = await this.withDb(udid, pkg, name, (db) => runFreeQuery(db, sql, QUERY_ROW_CAP));
    if ("__err" in r) return errRows(r.__err);
    return { ok: true, cols: r.cols, rows: r.rows, total: -1, truncated: r.truncated, rowids: null, message: "" };
  }
  async exportDb(udid, pkg, name, destPath) {
    const path = await this.ensureSnapshot(udid, pkg, name, false);
    if (!path) return { ok: false, message: `Couldn't read '${name}' from the container`, dir: "" };
    try {
      const SQL = await getSql();
      const db = new SQL.Database(node_fs.readFileSync(path));
      try {
        node_fs.writeFileSync(destPath, db.export());
      } finally {
        db.close();
      }
    } catch (e) {
      return { ok: false, message: `Export failed: ${errMsg$3(e)}`, dir: "" };
    }
    let size2 = 0;
    try {
      size2 = node_fs.statSync(destPath).size;
    } catch {
      size2 = 0;
    }
    return { ok: true, message: `Exported ${node_path.basename(destPath)} (${Math.round(size2 / 1024)} KB)`, dir: node_path.dirname(destPath) };
  }
  shutdown() {
    if (this.tmpDir) {
      try {
        node_fs.rmSync(this.tmpDir, { recursive: true, force: true });
      } catch {
      }
      this.tmpDir = null;
    }
    this.snapshots.clear();
  }
}
const DATA_DATA = "/data/data";
function joinPath(base, name) {
  if (base === "/") return "/" + name;
  return base.replace(/\/+$/, "") + "/" + name;
}
function isAppPrivate(path, pkg) {
  if (!pkg) return false;
  const root = `${DATA_DATA}/${pkg}`;
  return path === root || path.startsWith(root + "/");
}
const NO_ACCESS = { runAs: null, su: false };
function accessFor(path, pkg, rootMode = false) {
  if (rootMode) return { runAs: null, su: true };
  if (isAppPrivate(path, pkg)) return { runAs: pkg, su: false };
  return { runAs: null, su: false };
}
function shellPrefix(serial, a) {
  const base = ["-s", serial, "shell"];
  if (a.su) return [...base, "su", "-c"];
  if (a.runAs) return [...base, "run-as", a.runAs];
  return base;
}
function execOutPrefix(serial, a) {
  const base = ["-s", serial, "exec-out"];
  if (a.su) return [...base, "su", "-c"];
  if (a.runAs) return [...base, "run-as", a.runAs];
  return base;
}
function lsArgs(serial, path, a = NO_ACCESS) {
  return [...shellPrefix(serial, a), "ls", "-lHA", path];
}
function catArgs(serial, path, a = NO_ACCESS) {
  return [...execOutPrefix(serial, a), "cat", path];
}
function mkdirArgs(serial, path, a = NO_ACCESS) {
  return [...shellPrefix(serial, a), "mkdir", "-p", path];
}
function renameArgs(serial, src, dst, a = NO_ACCESS) {
  return [...shellPrefix(serial, a), "mv", src, dst];
}
function deleteArgs(serial, paths, a = NO_ACCESS) {
  return [...shellPrefix(serial, a), "rm", "-rf", ...paths];
}
const BLOCKED = ["not debuggable", "unknown package", "is unknown", "package inaccessible"];
const WS = /* @__PURE__ */ new Set([" ", "	", "\n", "\r", "\f", "\v"]);
function pySplit(s, maxsplit) {
  const out = [];
  let i = 0;
  while (true) {
    while (i < s.length && WS.has(s[i])) i++;
    if (i >= s.length) break;
    if (out.length === maxsplit) {
      out.push(s.slice(i));
      break;
    }
    const start = i;
    while (i < s.length && !WS.has(s[i])) i++;
    out.push(s.slice(start, i));
  }
  return out;
}
function parseLsLine(line) {
  const trimmed = line.replace(/[\r\n]+$/, "");
  if (!trimmed || trimmed.startsWith("total ")) return null;
  const parts = pySplit(trimmed, 7);
  if (parts.length < 8 || parts[0].length < 10) return null;
  const mode = parts[0];
  const c = mode[0];
  let name;
  let size2;
  let modified;
  if (c === "c" || c === "b") {
    const wide = pySplit(trimmed, 8);
    name = wide.length > 8 ? wide[8] : parts[7];
    size2 = null;
    modified = wide.length > 8 ? `${wide[6]} ${wide[7]}` : "";
  } else {
    name = parts[7];
    const n = parseInt(parts[4], 10);
    size2 = Number.isNaN(n) ? null : n;
    modified = `${parts[5]} ${parts[6]}`;
  }
  let kind;
  let linkTarget = null;
  if (c === "d") {
    kind = "dir";
  } else if (c === "l") {
    kind = "link";
    const arrow = name.indexOf(" -> ");
    if (arrow >= 0) {
      linkTarget = name.slice(arrow + 4);
      name = name.slice(0, arrow);
    }
  } else if (c === "-") {
    kind = "file";
  } else {
    kind = "other";
  }
  return { name, kind, size: size2, mode, linkTarget, modified };
}
function classifyListing(returncode, stdout, stderr) {
  if (returncode === 0) {
    const entries = [];
    for (const l of stdout.split("\n")) {
      const e = parseLsLine(l);
      if (e) entries.push(e);
    }
    entries.sort((a, b) => {
      const da = a.kind !== "dir" ? 1 : 0;
      const db = b.kind !== "dir" ? 1 : 0;
      if (da !== db) return da - db;
      const la = a.name.toLowerCase();
      const lb = b.name.toLowerCase();
      return la < lb ? -1 : la > lb ? 1 : 0;
    });
    return { entries, error: null };
  }
  const low = (stderr || "").toLowerCase();
  if (low.includes("no such file") || low.includes("not a directory")) {
    return { entries: null, error: "not found" };
  }
  if (BLOCKED.some((m) => low.includes(m))) return { entries: null, error: "blocked" };
  if (low.includes("permission denied") || low.includes("operation not permitted")) {
    return { entries: null, error: "denied" };
  }
  return { entries: null, error: stderr.trim() || "couldn't list directory" };
}
const TRANSFER_TIMEOUT = 6e5;
function errMsg$2(e) {
  return e instanceof Error ? e.message : String(e);
}
function execBinary(adb, args, timeoutMs) {
  return new Promise((resolve) => {
    node_child_process.execFile(
      adb,
      args,
      { timeout: timeoutMs, maxBuffer: 512 * 1024 * 1024, encoding: "buffer" },
      (err, stdout, stderr) => {
        const code = err && typeof err.code === "number" ? err.code : err ? 1 : 0;
        resolve({
          code,
          stdout: stdout ?? Buffer.alloc(0),
          stderr: stderr ? stderr.toString("utf8") : ""
        });
      }
    );
  });
}
async function pullPublic(adb, serial, remote, local) {
  const r = await run$3(adb, serial, ["pull", remote, local], TRANSFER_TIMEOUT);
  return r.code === 0 && node_fs.existsSync(local);
}
async function pullPrivateFile(adb, serial, remote, local, a) {
  const r = await execBinary(adb, catArgs(serial, remote, a), TRANSFER_TIMEOUT);
  if (r.code !== 0) return false;
  try {
    node_fs.writeFileSync(local, r.stdout);
  } catch {
    return false;
  }
  return true;
}
async function pullPrivateDir(adb, serial, remote, local, a) {
  node_fs.mkdirSync(local, { recursive: true });
  const r = await run$3(adb, null, lsArgs(serial, remote, a), 6e4);
  const { entries } = classifyListing(r.code ?? 1, r.stdout, r.stderr);
  if (entries === null) return false;
  let ok = true;
  for (const e of entries) {
    const childR = joinPath(remote, e.name);
    const childL = node_path.join(local, e.name);
    if (e.kind === "dir") ok = await pullPrivateDir(adb, serial, childR, childL, a) && ok;
    else ok = await pullPrivateFile(adb, serial, childR, childL, a) && ok;
  }
  return ok;
}
async function pullOne(adb, serial, remote, kind, local, a) {
  if (!a.runAs && !a.su) return pullPublic(adb, serial, remote, local);
  if (kind === "dir") return pullPrivateDir(adb, serial, remote, local, a);
  return pullPrivateFile(adb, serial, remote, local, a);
}
function ddPush(adb, serial, local, remote, a) {
  const prefix2 = a.su ? ["su", "-c"] : ["run-as", a.runAs];
  const args = ["-s", serial, "shell", ...prefix2, "dd", `of=${remote}`];
  return new Promise((resolve) => {
    const child = node_child_process.spawn(adb, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    let settled = false;
    const done = (ok, detail) => {
      if (settled) return;
      settled = true;
      resolve({ ok, detail: detail.trim() });
    };
    child.stderr.on("data", (d) => stderr += d.toString("utf8"));
    child.on("error", (e) => done(false, errMsg$2(e)));
    child.on("close", (code) => done(code === 0, stderr));
    const rs = node_fs.createReadStream(local);
    rs.on("error", (e) => {
      child.stdin.end();
      done(false, errMsg$2(e));
    });
    rs.pipe(child.stdin);
  });
}
async function pushPrivatePath(adb, serial, local, remote, a) {
  let isDir = false;
  try {
    isDir = node_fs.statSync(local).isDirectory();
  } catch (e) {
    return { ok: false, detail: errMsg$2(e) };
  }
  if (isDir) {
    await run$3(adb, null, mkdirArgs(serial, remote, a), 3e4);
    let ok = true;
    let detail = "";
    for (const child of node_fs.readdirSync(local).sort()) {
      const r = await pushPrivatePath(adb, serial, node_path.join(local, child), joinPath(remote, child), a);
      ok = r.ok && ok;
      detail = detail || r.detail;
    }
    return { ok, detail };
  }
  return ddPush(adb, serial, local, remote, a);
}
async function pushPublic(adb, serial, local, remote) {
  const r = await run$3(adb, serial, ["push", local, remote], TRANSFER_TIMEOUT);
  const lines = (r.stderr || r.stdout || "").trim().split("\n");
  return { ok: r.code === 0, detail: lines.length ? lines[lines.length - 1] : "push failed" };
}
class FilesService {
  constructor(adb) {
    this.adb = adb;
  }
  tmpDir = null;
  tmp() {
    if (!this.tmpDir) this.tmpDir = node_fs.mkdtempSync(node_path.join(node_os.tmpdir(), "androidlab-files-"));
    return this.tmpDir;
  }
  // --- listing (DirListWorker: run-as → su escalation) ------------------------
  async listOnce(serial, path, a) {
    const r = await run$3(this.adb, null, lsArgs(serial, path, a), 25e3);
    return classifyListing(r.code ?? 1, r.stdout, r.stderr);
  }
  async listDir(serial, path, pkg, rootMode) {
    const a = accessFor(path, pkg, rootMode);
    const { entries, error } = await this.listOnce(serial, path, a);
    if (error === "blocked" && a.runAs && !a.su) {
      const suRes = await this.listOnce(serial, path, { runAs: null, su: true });
      if (suRes.entries !== null) {
        return { ok: true, path, entries: suRes.entries, error: "", usedSu: true };
      }
      return {
        ok: false,
        path,
        entries: [],
        error: `'${a.runAs}' is not debuggable and the device isn't rooted — its private files can’t be read.`,
        usedSu: false
      };
    }
    if (entries === null) {
      const msg = error === "not found" ? "No such directory" : error === "denied" ? "Permission denied — try the Root (su) toggle on a rooted device" : error === "blocked" ? "Not accessible (app not debuggable and no root)" : `Couldn't list: ${error}`;
      return { ok: false, path, entries: [], error: msg, usedSu: a.su };
    }
    return { ok: true, path, entries, error: "", usedSu: a.su };
  }
  // --- pulling (PullWorker) ---------------------------------------------------
  async pull(serial, path, pkg, rootMode, items, destDir) {
    const a = accessFor(path, pkg, rootMode);
    const pulled = [];
    const errors = [];
    for (const { name, kind } of items) {
      const remote = joinPath(path, name);
      const local = node_path.join(destDir, name);
      let ok2 = false;
      try {
        ok2 = await pullOne(this.adb, serial, remote, kind, local, a);
      } catch (e) {
        errors.push(`${name}: ${errMsg$2(e)}`);
        continue;
      }
      if (ok2) pulled.push(name);
      else errors.push(`${name}: pull failed`);
    }
    const ok = pulled.length > 0 && errors.length === 0;
    let message;
    if (pulled.length) {
      message = `Pulled ${pulled.length} item(s): ${pulled.join(", ")}`;
      if (errors.length) message += `  (${errors.length} failed: ${errors.join("; ")})`;
    } else {
      message = errors.length ? "Pull failed: " + errors.join("; ") : "Nothing to pull";
    }
    return { ok, message, dir: destDir };
  }
  // --- pushing (PushWorker) ---------------------------------------------------
  async push(serial, path, pkg, rootMode, sources) {
    const a = accessFor(path, pkg, rootMode);
    const pushed = [];
    const errors = [];
    for (const local of sources) {
      const name = node_path.basename(local.replace(/\/+$/, ""));
      const remote = joinPath(path, name);
      const r = a.runAs || a.su ? await pushPrivatePath(this.adb, serial, local, remote, a) : await pushPublic(this.adb, serial, local, remote);
      if (r.ok) pushed.push(name);
      else errors.push(`${name}: ${r.detail || "failed"}`);
    }
    const ok = pushed.length > 0 && errors.length === 0;
    let message;
    if (pushed.length) {
      message = `Pushed ${pushed.length} item(s) to ${path}: ${pushed.join(", ")}`;
      if (errors.length) message += `  (${errors.length} failed: ${errors.join("; ")})`;
    } else {
      message = errors.length ? "Push failed: " + errors.join("; ") : "Nothing to push";
    }
    return { ok, message, dir: "" };
  }
  // --- one-shot file ops (FileOpWorker) ---------------------------------------
  async runOp(argv, okMsg) {
    const r = await run$3(this.adb, null, argv, 45e3);
    if ((r.code ?? 1) === 0) return { ok: true, message: okMsg };
    return { ok: false, message: (r.stderr || r.stdout || "operation failed").trim() };
  }
  async mkdir(serial, path, pkg, rootMode, name) {
    const a = accessFor(path, pkg, rootMode);
    const target = joinPath(path, name);
    return this.runOp(mkdirArgs(serial, target, a), `Created ${target}`);
  }
  async rename(serial, path, pkg, rootMode, oldName, newName) {
    const a = accessFor(path, pkg, rootMode);
    const argv = renameArgs(serial, joinPath(path, oldName), joinPath(path, newName), a);
    return this.runOp(argv, `Renamed to ${newName}`);
  }
  async delete(serial, path, pkg, rootMode, names) {
    const a = accessFor(path, pkg, rootMode);
    const paths = names.map((n) => joinPath(path, n));
    return this.runOp(deleteArgs(serial, paths, a), `Deleted ${names.length} item(s)`);
  }
  // --- open a device file on the Mac (pull to a temp dir, hand back the path) -
  async openEntry(serial, path, pkg, rootMode, name, kind) {
    const a = accessFor(path, pkg, rootMode);
    const dst = node_path.join(this.tmp(), "open");
    node_fs.rmSync(dst, { recursive: true, force: true });
    node_fs.mkdirSync(dst, { recursive: true });
    const local = node_path.join(dst, name);
    const remote = joinPath(path, name);
    let ok = false;
    try {
      ok = await pullOne(this.adb, serial, remote, kind, local, a);
    } catch (e) {
      return { ok: false, message: errMsg$2(e), localPath: "" };
    }
    if (!ok) return { ok: false, message: `Couldn't open ${name}`, localPath: "" };
    return { ok: true, message: `Opened ${name}`, localPath: local };
  }
  /** Remove staged temp files on app close (mirrors FilesView.shutdown). */
  shutdown() {
    if (this.tmpDir) {
      try {
        node_fs.rmSync(this.tmpDir, { recursive: true, force: true });
      } catch {
      }
      this.tmpDir = null;
    }
  }
}
const EXTRA_FLAG = {
  string: "--es",
  int: "--ei",
  long: "--el",
  float: "--ef",
  boolean: "--ez"
};
function buildAmArgs(spec) {
  const cmd = ["shell", "am", spec.verb];
  if (spec.verb === "start") cmd.push("-W");
  if (spec.action) cmd.push("-a", spec.action);
  if (spec.data) cmd.push("-d", spec.data);
  if (spec.mime) cmd.push("-t", spec.mime);
  if (spec.component) cmd.push("-n", spec.component);
  for (const e of spec.extras ?? []) {
    const flag = EXTRA_FLAG[e.type];
    if (flag && e.key) cmd.push(flag, e.key, e.value);
  }
  return cmd;
}
function intentLooksBad(output, code) {
  return output.includes("Error") || output.includes("Exception") || output.includes("does not exist") || output.includes("Activity not started") || code !== null && code !== 0;
}
const KILL_MONKEY = "kill -9 $(pgrep -f com.android.commands.monkey) 2>/dev/null; true";
function monkeyArgs(pkg, events, seed, throttleMs) {
  return [
    "shell",
    "monkey",
    "-p",
    pkg,
    "-s",
    String(seed),
    "--throttle",
    String(throttleMs),
    "--ignore-security-exceptions",
    "-v",
    String(events)
  ];
}
function isMonkeyCrash(line) {
  return line.includes("// CRASH") || line.includes("// NOT RESPONDING");
}
const REMOTE_TRACE = "/data/misc/perfetto-traces/logcatviewer.perfetto-trace";
function perfettoArgs(durationS, categories) {
  return ["shell", "perfetto", "-o", REMOTE_TRACE, "-t", `${durationS}s`, ...categories];
}
function pullTraceArgs(dest) {
  return ["pull", REMOTE_TRACE, dest];
}
const REC_RE = /NotificationRecord\([^)]*pkg=(\S+?)[\s)]/g;
const FIELD_RES = [
  ["title", /android\.title=(?:String\s*)?\((.*?)\)/],
  ["text", /android\.text=(?:String\s*)?\((.*?)\)/],
  ["channel", /NotificationChannel\{[^}]*?m?[Ii]d='([^']+)'/],
  ["when", /when=(\S+)/],
  ["key", /key=(\S+)/]
];
function parseNotifications(text2) {
  const heads = [...text2.matchAll(REC_RE)];
  const items = [];
  const seen = /* @__PURE__ */ new Set();
  for (let i = 0; i < heads.length; i++) {
    const start = heads[i].index ?? 0;
    const end = i + 1 < heads.length ? heads[i + 1].index ?? text2.length : text2.length;
    const block = text2.slice(start, end);
    const it = { pkg: heads[i][1], channel: "", title: "", text: "", when: "", key: "" };
    for (const [name, rx] of FIELD_RES) {
      const fm = rx.exec(block);
      if (fm) it[name] = fm[1];
    }
    if (it.key && seen.has(it.key)) continue;
    seen.add(it.key || `${it.pkg}/${items.length}`);
    items.push(it);
  }
  return items;
}
const PCT_RE = /(\d+)[%/]/;
function parseBugreportProgress(line) {
  const m = PCT_RE.exec(line);
  return m ? Math.min(100, parseInt(m[1], 10)) : null;
}
function downloadsDir$1() {
  const d = node_path.join(node_os.homedir(), "Downloads");
  return node_fs.existsSync(d) ? d : node_os.homedir();
}
function stamp() {
  const p = (n) => String(n).padStart(2, "0");
  const d = /* @__PURE__ */ new Date();
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
class LineBuffer {
  buf = "";
  push(chunk, onLine) {
    this.buf += chunk.toString("utf8");
    const parts = this.buf.split("\n");
    this.buf = parts.pop() ?? "";
    for (const l of parts) onLine(l);
  }
  flush(onLine) {
    if (this.buf) {
      onLine(this.buf);
      this.buf = "";
    }
  }
}
class ToolboxService {
  constructor(adb, cb) {
    this.adb = adb;
    this.cb = cb;
  }
  monkeyProc = null;
  monkeySerial = "";
  monkeyStopped = false;
  perfettoProc = null;
  perfettoCancelled = false;
  perfettoTimedOut = false;
  perfettoTimer = null;
  bugreportProc = null;
  bugreportCancelled = false;
  // --- Intents (AmWorker) ---------------------------------------------------
  async runIntent(serial, spec) {
    const r = await run$3(this.adb, serial, buildAmArgs(spec), 25e3);
    const out = `${r.stdout}
${r.stderr}`.trim();
    return { ok: !intentLooksBad(out, r.code), output: out || "(no output)" };
  }
  // --- Notifications (NotifWorker) ------------------------------------------
  async listNotifications(serial) {
    const r = await run$3(this.adb, serial, ["shell", "dumpsys", "notification", "--noredact"], 2e4);
    if (!r.stdout && r.stderr) return { ok: false, message: r.stderr.trim(), items: [] };
    const items = parseNotifications(r.stdout);
    return { ok: true, message: `${items.length} active notification(s)`, items };
  }
  // --- Monkey (MonkeyWorker) ------------------------------------------------
  startMonkey(serial, pkg, events, seed, throttleMs) {
    this.stopMonkey();
    this.monkeySerial = serial;
    this.monkeyStopped = false;
    const proc2 = node_child_process.spawn(this.adb, ["-s", serial, ...monkeyArgs(pkg, events, seed, throttleMs)]);
    this.monkeyProc = proc2;
    let crashed = false;
    const lines = new LineBuffer();
    const onLine = (raw) => {
      const line = raw.replace(/\s+$/, "");
      if (!line) return;
      if (isMonkeyCrash(line)) crashed = true;
      this.cb.onMonkeyLine(line);
    };
    proc2.stdout.on("data", (c) => lines.push(c, onLine));
    proc2.stderr.on("data", (c) => lines.push(c, onLine));
    proc2.on("error", (err) => {
      if (this.monkeyProc === proc2) this.monkeyProc = null;
      void this.killDeviceMonkey(serial);
      this.cb.onMonkeyDone(false, `monkey failed: ${err.message}`);
    });
    proc2.on("close", (code) => {
      if (this.monkeyProc === proc2) this.monkeyProc = null;
      lines.flush(onLine);
      void this.killDeviceMonkey(serial);
      if (this.monkeyStopped) this.cb.onMonkeyDone(true, "Monkey stopped");
      else if (crashed)
        this.cb.onMonkeyDone(false, "Monkey aborted — the app crashed or ANR'd (see the Crashes tab)");
      else this.cb.onMonkeyDone(code === 0, code === 0 ? "Monkey finished" : `monkey exited with code ${code}`);
    });
  }
  stopMonkey() {
    this.monkeyStopped = true;
    this.monkeyProc?.kill("SIGKILL");
  }
  async killDeviceMonkey(serial) {
    try {
      await run$3(this.adb, serial, ["shell", KILL_MONKEY], 8e3);
    } catch {
    }
  }
  // --- Perfetto (PerfettoWorker) --------------------------------------------
  capturePerfetto(serial, durationS, categories) {
    this.cancelPerfetto();
    const dir = downloadsDir$1();
    const dest = node_path.join(dir, `trace-${stamp()}.perfetto-trace`);
    this.perfettoCancelled = false;
    this.perfettoTimedOut = false;
    const proc2 = node_child_process.spawn(this.adb, ["-s", serial, ...perfettoArgs(durationS, categories)]);
    this.perfettoProc = proc2;
    let stderr = "";
    proc2.stderr.on("data", (c) => {
      stderr += c.toString("utf8");
    });
    this.perfettoTimer = setTimeout(
      () => {
        if (this.perfettoProc === proc2) {
          this.perfettoTimedOut = true;
          proc2.kill("SIGKILL");
        }
      },
      (durationS + 30) * 1e3
    );
    proc2.on("error", (err) => {
      this.finishPerfetto(proc2);
      this.cb.onPerfettoDone(false, err.message, "", "");
    });
    proc2.on("close", (code) => {
      this.finishPerfetto(proc2);
      if (this.perfettoTimedOut) {
        this.cb.onPerfettoDone(false, "perfetto timed out", "", "");
        return;
      }
      if (this.perfettoCancelled) {
        this.cb.onPerfettoDone(false, "Cancelled", "", "");
        return;
      }
      if (code !== 0) {
        const hint = stderr.trim().split("\n").filter(Boolean).pop() || "requires Android 9+";
        this.cb.onPerfettoDone(false, `perfetto failed: ${hint}`, "", "");
        return;
      }
      this.cb.onPerfettoProgress("Pulling trace…");
      void run$3(this.adb, serial, pullTraceArgs(dest), 12e4).then((r) => {
        if (r.code !== 0) {
          this.cb.onPerfettoDone(false, (r.stderr || r.stdout).trim(), "", "");
          return;
        }
        this.cb.onPerfettoDone(true, `Trace saved: ${node_path.basename(dest)}`, dest, dir);
      });
    });
    this.cb.onPerfettoProgress("Recording…");
  }
  cancelPerfetto() {
    this.perfettoCancelled = true;
    this.perfettoProc?.kill("SIGKILL");
  }
  finishPerfetto(proc2) {
    if (this.perfettoProc === proc2) this.perfettoProc = null;
    if (this.perfettoTimer) {
      clearTimeout(this.perfettoTimer);
      this.perfettoTimer = null;
    }
  }
  // --- Bugreport (BugreportWorker) ------------------------------------------
  startBugreport(serial) {
    this.cancelBugreport();
    const dir = downloadsDir$1();
    const safe = serial.replace(/[^a-zA-Z0-9]/g, "_");
    const dest = node_path.join(dir, `bugreport-${safe}-${stamp()}.zip`);
    this.bugreportCancelled = false;
    const proc2 = node_child_process.spawn(this.adb, ["-s", serial, "bugreport", dest]);
    this.bugreportProc = proc2;
    const lines = new LineBuffer();
    const onLine = (line) => {
      const pct = parseBugreportProgress(line);
      if (pct !== null) this.cb.onBugreportProgress(pct);
    };
    proc2.stdout.on("data", (c) => lines.push(c, onLine));
    proc2.stderr.on("data", (c) => lines.push(c, onLine));
    proc2.on("error", (err) => {
      if (this.bugreportProc === proc2) this.bugreportProc = null;
      this.cb.onBugreportDone(false, `bugreport failed: ${err.message}`, "");
    });
    proc2.on("close", (code) => {
      if (this.bugreportProc === proc2) this.bugreportProc = null;
      lines.flush(onLine);
      if (this.bugreportCancelled) this.cb.onBugreportDone(false, "Bugreport cancelled", "");
      else if (code === 0 && node_fs.existsSync(dest))
        this.cb.onBugreportDone(true, `Bugreport saved: ${node_path.basename(dest)}`, dir);
      else this.cb.onBugreportDone(false, `bugreport exited with code ${code}`, "");
    });
  }
  cancelBugreport() {
    this.bugreportCancelled = true;
    this.bugreportProc?.kill("SIGKILL");
  }
  /** Kill every live device-side child (mirrors ToolboxView.shutdown fan-out). */
  shutdown() {
    this.monkeyStopped = true;
    this.perfettoCancelled = true;
    this.bugreportCancelled = true;
    if (this.perfettoTimer) {
      clearTimeout(this.perfettoTimer);
      this.perfettoTimer = null;
    }
    this.monkeyProc?.kill("SIGKILL");
    this.perfettoProc?.kill("SIGKILL");
    this.bugreportProc?.kill("SIGKILL");
    if (this.monkeySerial) void this.killDeviceMonkey(this.monkeySerial);
    this.monkeyProc = null;
    this.perfettoProc = null;
    this.bugreportProc = null;
  }
}
const PREFS_DIR = "shared_prefs";
function prefix(su, pkg) {
  return su ? ["su", "-c"] : ["run-as", pkg];
}
function lsPrefsArgs(serial, pkg, su = false) {
  const d = su ? `/data/data/${pkg}/${PREFS_DIR}` : PREFS_DIR;
  return ["-s", serial, "shell", ...prefix(su, pkg), "ls", d];
}
function catPrefArgs(serial, pkg, fname, su = false) {
  const d = su ? `/data/data/${pkg}/${PREFS_DIR}/${fname}` : `${PREFS_DIR}/${fname}`;
  return ["-s", serial, "exec-out", ...prefix(su, pkg), "cat", d];
}
function writePrefArgs(serial, pkg, fname, su = false) {
  const d = su ? `/data/data/${pkg}/${PREFS_DIR}/${fname}` : `${PREFS_DIR}/${fname}`;
  return ["-s", serial, "shell", ...prefix(su, pkg), "dd", `of=${d}`];
}
function classifyPrefsList(code, stdout, stderr) {
  const combo = (stdout + stderr).toLowerCase();
  const bad = code !== 0 || combo.includes("not debuggable") || combo.includes("no such") || stderr.toLowerCase().includes("denied");
  const files = stdout.split("\n").map((l) => l.trim()).filter((l) => l.endsWith(".xml"));
  return { ok: !bad, files, error: (stderr || stdout).trim() };
}
const PREFS_XML = new fastXmlParser.XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseAttributeValue: false,
  processEntities: true,
  preserveOrder: true,
  trimValues: false,
  textNodeName: "#text"
});
function textOf(kids) {
  if (!Array.isArray(kids)) return "";
  const t = kids.find((k) => k && typeof k === "object" && "#text" in k);
  return t ? String(t["#text"]) : "";
}
function parsePrefsXml(text2) {
  const start = text2.indexOf("<");
  if (start < 0) return [];
  let parsed;
  try {
    parsed = PREFS_XML.parse(text2.slice(start));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const mapNode = parsed.find((n) => n && typeof n === "object" && "map" in n);
  const children = mapNode ? mapNode.map : null;
  if (!Array.isArray(children)) return [];
  const out = [];
  for (const child of children) {
    const tag = Object.keys(child).find((k) => k !== ":@" && k !== "#text");
    if (!tag) continue;
    const attrs = child[":@"] ?? {};
    const key2 = attrs["@_name"] ?? "";
    if (tag === "string") {
      out.push({ key: key2, type: "string", value: textOf(child.string) });
    } else if (tag === "int" || tag === "long" || tag === "float" || tag === "boolean") {
      out.push({ key: key2, type: tag, value: String(attrs["@_value"] ?? "") });
    } else if (tag === "set") {
      const kids = Array.isArray(child.set) ? child.set : [];
      const vals = kids.filter((k) => "string" in k).map((k) => textOf(k.string));
      out.push({ key: key2, type: "set", value: vals.join(", ") });
    }
  }
  return out;
}
function escapeText(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function quoteAttr(s) {
  let data = escapeText(s).replace(/\n/g, "&#10;").replace(/\t/g, "&#9;").replace(/\r/g, "&#13;");
  if (data.includes('"')) {
    if (data.includes("'")) data = `"${data.replace(/"/g, "&quot;")}"`;
    else data = `'${data}'`;
  } else {
    data = `"${data}"`;
  }
  return data;
}
function buildPrefsXml(prefs) {
  const lines = ["<?xml version='1.0' encoding='utf-8' standalone='yes' ?>", "<map>"];
  for (const p of prefs) {
    const name = quoteAttr(p.key);
    if (p.type === "string") {
      lines.push(`    <string name=${name}>${escapeText(p.value)}</string>`);
    } else if (p.type === "set") {
      lines.push(`    <set name=${name}>`);
      for (const v of p.value.split(",").map((s) => s.trim()).filter(Boolean)) {
        lines.push(`        <string>${escapeText(v)}</string>`);
      }
      lines.push("    </set>");
    } else {
      lines.push(`    <${p.type} name=${name} value=${quoteAttr(p.value)} />`);
    }
  }
  lines.push("</map>");
  return lines.join("\n") + "\n";
}
const appKey = (serial, pkg) => `${serial} ${pkg}`;
function runWithInput(adb, args, input, timeoutMs) {
  return new Promise((resolve) => {
    const child = node_child_process.execFile(
      adb,
      args,
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: "buffer" },
      (err, _stdout, stderr) => {
        const code = err && typeof err.code === "number" ? err.code : err ? 1 : 0;
        resolve({ code, stderr: stderr ? stderr.toString("utf8") : "" });
      }
    );
    child.stdin?.end(input);
  });
}
class PrefsService {
  constructor(adb) {
    this.adb = adb;
  }
  suByApp = /* @__PURE__ */ new Map();
  // --- listing (PrefListWorker: run-as → su escalation) -----------------------
  async list(serial, pkg) {
    const r1 = await run$3(this.adb, null, lsPrefsArgs(serial, pkg, false), 15e3);
    const c1 = classifyPrefsList(r1.code ?? 1, r1.stdout, r1.stderr);
    if (c1.ok) {
      this.suByApp.set(appKey(serial, pkg), false);
      return { ok: true, files: c1.files, error: "", usedSu: false };
    }
    const r2 = await run$3(this.adb, null, lsPrefsArgs(serial, pkg, true), 15e3);
    const c2 = classifyPrefsList(r2.code ?? 1, r2.stdout, r2.stderr);
    if (c2.ok) {
      this.suByApp.set(appKey(serial, pkg), true);
      return { ok: true, files: c2.files, error: "", usedSu: true };
    }
    return {
      ok: false,
      files: [],
      error: c1.error || c2.error || "cannot access shared_prefs (app must be debuggable, or device rooted)",
      usedSu: false
    };
  }
  // --- loading one file (PrefLoadWorker) --------------------------------------
  async load(serial, pkg, fname) {
    const su = this.suByApp.get(appKey(serial, pkg)) ?? false;
    const r = await run$3(this.adb, null, catPrefArgs(serial, pkg, fname, su), 2e4);
    if (r.code !== 0 && !r.stdout) {
      return { ok: false, error: (r.stderr || "read failed").trim(), fname, prefs: [] };
    }
    return { ok: true, error: "", fname, prefs: parsePrefsXml(r.stdout) };
  }
  // --- saving (PrefSaveWorker: build XML → dd over stdin) ---------------------
  async save(serial, pkg, fname, prefs) {
    const su = this.suByApp.get(appKey(serial, pkg)) ?? false;
    const xml = buildPrefsXml(prefs);
    const r = await runWithInput(
      this.adb,
      writePrefArgs(serial, pkg, fname, su),
      Buffer.from(xml, "utf8"),
      3e4
    );
    const err = r.stderr;
    const low = err.toLowerCase();
    const ok = r.code === 0 && !low.includes("denied") && !low.includes("error");
    return { ok, error: ok ? "" : err.trim() || "write failed" };
  }
  // --- force-stop so the app re-reads on next launch --------------------------
  async forceStop(serial, pkg) {
    const r = await run$3(this.adb, serial, ["shell", "am", "force-stop", pkg], 8e3);
    return r.code === 0;
  }
}
const PRIORITY = {
  V: 2,
  D: 3,
  I: 4,
  W: 5,
  E: 6,
  F: 7,
  S: 8
};
const UNKNOWN_PRIORITY = PRIORITY.V;
const THREADTIME = /^(?<time>\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+)\s+(?<pid>\d+)\s+(?<tid>\d+)\s+(?<level>[VDIWEFS])\s+(?<tag>[\s\S]*?): ?(?<msg>[\s\S]*)$/;
function makeEntry(time, pid, tid, level, priority, tag, msg, raw) {
  return {
    time,
    pid,
    tid,
    level,
    priority,
    tag,
    msg,
    raw,
    search: (tag + " " + msg).toLowerCase()
  };
}
function parseLine(line) {
  if (!line || line.startsWith("--------- ")) {
    return null;
  }
  const m = THREADTIME.exec(line);
  if (m && m.groups) {
    const level = m.groups.level;
    return makeEntry(
      m.groups.time,
      parseInt(m.groups.pid, 10),
      parseInt(m.groups.tid, 10),
      level,
      PRIORITY[level] ?? UNKNOWN_PRIORITY,
      m.groups.tag.replace(/\s+$/, ""),
      // Python .rstrip()
      m.groups.msg,
      line
    );
  }
  return makeEntry("", 0, 0, "?", UNKNOWN_PRIORITY, "", line, line);
}
const CRASH_TAGS = [
  "data_app_crash",
  "data_app_anr",
  "data_app_wtf",
  "data_app_native_crash",
  "system_app_crash",
  "system_app_anr",
  "system_app_wtf",
  "system_server_crash"
];
function crashBufferArgs(serial) {
  return ["-s", serial, "logcat", "-b", "crash", "-v", "threadtime", "-d"];
}
function dropboxPrintArgs(serial, tag) {
  return ["-s", serial, "shell", "dumpsys", "dropbox", "--print", tag];
}
function splitLines(s) {
  if (s === "") return [];
  const parts = s.split(/\r\n|\r|\n/);
  if (parts.length > 0 && parts[parts.length - 1] === "" && /(\r\n|\r|\n)$/.test(s)) parts.pop();
  return parts;
}
function pyStrip(s, chars) {
  let i = 0;
  let j = s.length;
  while (i < j && chars.includes(s[i])) i++;
  while (j > i && chars.includes(s[j - 1])) j--;
  return s.slice(i, j);
}
const PROCESS_RE = /Process:\s*(\S+?),?\s+PID:/;
const PKG_LINE_RE = /^(?:Package|Process):\s*(\S+?)(?:\s|,|$)/m;
const ANR_RE = /ANR in (\S+)/;
const EXC_RE = /^([\w.$]+(?:Exception|Error|Throwable|Death)[\w.$]*)(?::\s*(.*))?$/;
function headline(body) {
  const anr = ANR_RE.exec(body);
  if (anr) return `ANR in ${anr[1]}`;
  for (const raw of splitLines(body)) {
    const line = raw.trim();
    if (EXC_RE.test(line)) return line.slice(0, 200);
  }
  return "";
}
function splitCrashBlocks(text2) {
  const blocks = [];
  let curPid = null;
  let curLines = [];
  let curMsgs = [];
  let curWhen = "";
  const flush = () => {
    if (curLines.length === 0) return;
    const body = curLines.join("\n");
    const msgs = curMsgs.join("\n");
    let proc2 = "";
    const m = PROCESS_RE.exec(msgs) ?? ANR_RE.exec(msgs);
    if (m) proc2 = m[1];
    const firstLine = msgs.split("\n")[0] ?? "";
    const kind = msgs.includes("ANR in ") ? "anr" : msgs.includes("*** ***") || firstLine.includes("signal ") ? "native" : "crash";
    blocks.push({
      kind,
      when: curWhen,
      process: proc2,
      title: headline(msgs) || "(crash)",
      text: body,
      source: "crash buffer",
      plain: msgs
    });
  };
  for (const raw of splitLines(text2)) {
    const e = parseLine(raw);
    if (e === null) continue;
    const startsNew = e.msg.startsWith("FATAL EXCEPTION") || e.msg.startsWith("ANR in ");
    if (e.pid !== curPid || startsNew) {
      flush();
      curLines = [];
      curMsgs = [];
      curPid = e.pid;
      curWhen = e.time;
    }
    curLines.push(
      `${e.time} ${String(e.pid).padStart(5)} ${String(e.tid).padStart(5)} ${e.level} ${e.tag}: ${e.msg}`
    );
    curMsgs.push(e.msg);
  }
  flush();
  return blocks;
}
const DROP_HEAD_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (\S+) \(([^)]*)\)\s*$/gm;
function splitDropboxPrint(text2, tag) {
  const items = [];
  const heads = [...text2.matchAll(DROP_HEAD_RE)];
  const low = tag.toLowerCase();
  const kind = tag.includes("anr") ? "anr" : tag.includes("native") || low.includes("tombstone") ? "native" : tag.includes("wtf") ? "wtf" : "crash";
  for (let i = 0; i < heads.length; i++) {
    const start = (heads[i].index ?? 0) + heads[i][0].length;
    const end = i + 1 < heads.length ? heads[i + 1].index ?? text2.length : text2.length;
    let body = text2.slice(start, end);
    body = pyStrip(pyStrip(body, "\n="), "\n");
    if (!body) continue;
    const pm = PKG_LINE_RE.exec(body);
    items.push({
      kind,
      when: heads[i][1],
      process: pm ? pm[1] : "",
      title: headline(body) || tag,
      text: body,
      source: tag,
      plain: body
    });
  }
  return items;
}
const MAP_CLASS_RE = /^([\w.$]+) -> ([\w.$]+):$/;
const MAP_METHOD_RE = /^\s+(?:(\d+):(\d+):)?[\w.$[\]]+ ([\w$<>]+)\([^)]*\)(?::(\d+))?(?::(\d+))? -> ([\w$<>]+)$/;
const methodKey = (cls, method) => `${cls} ${method}`;
function parseMapping(text2) {
  const mp = { classes: {}, methods: {} };
  let curObf = null;
  for (const line of splitLines(text2)) {
    if (line.startsWith("#")) continue;
    const cm = MAP_CLASS_RE.exec(line);
    if (cm) {
      mp.classes[cm[2]] = cm[1];
      curObf = cm[2];
      continue;
    }
    if (curObf === null) continue;
    const mm = MAP_METHOD_RE.exec(line);
    if (mm) {
      const [, start, end, origName, origStart, , obfMethod] = mm;
      const key2 = methodKey(curObf, obfMethod);
      (mp.methods[key2] ??= []).push([
        start ? parseInt(start, 10) : null,
        end ? parseInt(end, 10) : null,
        origName,
        origStart ? parseInt(origStart, 10) : null
      ]);
    }
  }
  return mp;
}
const FRAME_RE = /(\bat\s+)([\w.$]+)\.([\w$<>]+)\(([^():]*)(?::(\d+))?\)/;
const FRAME_RE_G = new RegExp(FRAME_RE.source, "g");
const TOKEN_RE_G = /[\w.$]{2,}/g;
function mapFrame(mp, atPrefix, obfCls, obfM, filePart, lineS) {
  const cls = mp.classes[obfCls] ?? obfCls;
  const line = lineS ? parseInt(lineS, 10) : null;
  let name = obfM;
  let outLine = line;
  for (const [start, end, origName, origStart] of mp.methods[methodKey(obfCls, obfM)] ?? []) {
    if (line === null || start === null || start <= line && line <= (end || start)) {
      name = origName;
      if (line !== null && origStart !== null && start !== null) outLine = origStart + (line - start);
      else if (origStart !== null) outLine = origStart;
      if (line !== null && start !== null) break;
    }
  }
  const src = cls !== obfCls && (filePart === "" || filePart === "SourceFile" || filePart === "Unknown Source") ? cls.split(".").pop().split("$", 1)[0] + ".java" : filePart;
  const tail = outLine !== null ? `(${src}:${outLine})` : `(${src})`;
  return `${atPrefix}${cls}.${name}${tail}`;
}
function retrace(mp, text2) {
  const out = [];
  for (const rawLine of splitLines(text2)) {
    let line = rawLine;
    if (FRAME_RE.test(line)) {
      line = line.replace(
        FRAME_RE_G,
        (_full, p1, p2, p3, p4, p5) => mapFrame(mp, p1, p2, p3, p4, p5)
      );
    } else {
      line = line.replace(TOKEN_RE_G, (tok) => mp.classes[tok] ?? tok);
    }
    out.push(line);
  }
  return out.join("\n");
}
const SETTINGS_FILE = "crash_settings.json";
function settingsPath() {
  return node_path.join(electron.app.getPath("userData"), SETTINGS_FILE);
}
function errMsg$1(e) {
  return e instanceof Error ? e.message : String(e);
}
class CrashService {
  constructor(adb) {
    this.adb = adb;
  }
  mapping = null;
  // --- scan (CrashScanWorker) -------------------------------------------------
  async scan(serial) {
    let items = [];
    try {
      const buf = await run$3(this.adb, null, crashBufferArgs(serial), 2e4);
      items = items.concat(splitCrashBlocks(buf.stdout));
      for (const tag of CRASH_TAGS) {
        try {
          const r = await run$3(this.adb, null, dropboxPrintArgs(serial, tag), 2e4);
          items = items.concat(splitDropboxPrint(r.stdout, tag));
        } catch {
        }
      }
    } catch (e) {
      return { ok: false, message: `crash scan failed: ${errMsg$1(e)}`, items: [] };
    }
    items.sort((a, b) => a.when < b.when ? 1 : a.when > b.when ? -1 : 0);
    return { ok: true, message: `${items.length} record(s)`, items };
  }
  // --- mapping (MappingLoadWorker) --------------------------------------------
  async loadMapping(path) {
    let text2;
    try {
      text2 = await promises.readFile(path, "utf8");
    } catch (e) {
      return { ok: false, path, classCount: 0, error: errMsg$1(e) };
    }
    const mp = parseMapping(text2);
    const classCount = Object.keys(mp.classes).length;
    if (classCount === 0) {
      return { ok: false, path, classCount: 0, error: "no class mappings found" };
    }
    this.mapping = mp;
    this.saveLastMappingPath(path);
    return { ok: true, path, classCount, error: "" };
  }
  /** Retrace `text` with the loaded mapping (returns it unchanged if none). */
  retrace(text2) {
    return this.mapping ? retrace(this.mapping, text2) : text2;
  }
  // --- last-mapping-path persistence (crash_settings.json) --------------------
  lastMappingPath() {
    try {
      const data = JSON.parse(node_fs.readFileSync(settingsPath(), "utf8"));
      const p = data.last_mapping ?? "";
      return p && node_fs.existsSync(p) ? p : "";
    } catch {
      return "";
    }
  }
  saveLastMappingPath(path) {
    try {
      const p = settingsPath();
      node_fs.mkdirSync(node_path.dirname(p), { recursive: true });
      node_fs.writeFileSync(p, JSON.stringify({ last_mapping: path }), "utf8");
    } catch {
    }
  }
}
function sh(serial) {
  return ["-s", serial, "shell"];
}
function listPackagesArgs(serial, withUid = true) {
  const flags = ["-f", "-i", "--show-versioncode"];
  if (withUid) flags.push("-U");
  return [...sh(serial), "pm", "list", "packages", ...flags];
}
function listFilteredArgs(serial, flag) {
  return [...sh(serial), "pm", "list", "packages", flag];
}
function dumpsysArgs(serial, pkg) {
  return [...sh(serial), "dumpsys", "package", pkg];
}
function runningServicesArgs(serial, pkg) {
  return [...sh(serial), "dumpsys", "activity", "services", pkg];
}
function appopsGetArgs(serial, pkg, cmd = true) {
  return [...sh(serial), ...cmd ? ["cmd", "appops", "get", pkg] : ["appops", "get", pkg]];
}
function statSizeArgs(serial, path) {
  return [...sh(serial), "stat", "-c", "%s", path];
}
function duArgs(serial, pkg, sub = ".") {
  return [...sh(serial), "run-as", pkg, "du", "-sk", sub];
}
function clearCacheArgs(serial, pkg) {
  return [...sh(serial), "pm", "clear", "--cache-only", pkg];
}
function runasClearCacheArgs(serial, pkg) {
  return [...sh(serial), "run-as", pkg, "rm", "-rf", "cache", "code_cache"];
}
function suClearCacheArgs(serial, pkg) {
  return [...sh(serial), "su", "-c", "rm", "-rf", `/data/data/${pkg}/cache`, `/data/data/${pkg}/code_cache`];
}
function grantArgs(serial, pkg, perm) {
  return [...sh(serial), "pm", "grant", pkg, perm];
}
function revokeArgs(serial, pkg, perm) {
  return [...sh(serial), "pm", "revoke", pkg, perm];
}
function unzipListArgs(serial, apkPath) {
  return [...sh(serial), "unzip", "-l", apkPath];
}
function unzipExtractArgs(serial, apkPath, entry) {
  return ["-s", serial, "exec-out", "unzip", "-p", apkPath, entry];
}
function pmPathArgs(serial, pkg) {
  return [...sh(serial), "pm", "path", pkg];
}
function parseApkPaths(stdout) {
  return stdout.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("package:")).map((l) => l.slice("package:".length));
}
const ICON_DENSITY = {
  xxxhdpi: 6,
  xxhdpi: 5,
  xhdpi: 4,
  hdpi: 3,
  tvdpi: 2,
  mdpi: 1,
  ldpi: 0,
  nodpi: 0
};
function parseZipEntries(stdout) {
  const entries = [];
  for (const line of stdout.split("\n")) {
    const parts = line.split(/\s+/).filter(Boolean);
    if (parts.length > 0) entries.push(parts[parts.length - 1]);
  }
  return entries;
}
function pickLauncherIcon(entries) {
  let best = null;
  let bestScore = -1;
  for (const e of entries) {
    const el = e.toLowerCase();
    if (!(el.startsWith("res/") && (el.endsWith(".png") || el.endsWith(".webp")))) continue;
    const parts = e.split("/");
    if (parts.length < 3) continue;
    const qual = parts[1].toLowerCase();
    const stem = (parts[parts.length - 1].split(".").slice(0, -1).join(".") || parts[parts.length - 1]).toLowerCase();
    if (!stem.includes("launcher") && !stem.includes("icon")) continue;
    if (stem.includes("foreground") || stem.includes("background")) continue;
    let score;
    if (stem === "ic_launcher") score = 400;
    else if (stem.includes("round")) score = 100;
    else if (stem.includes("launcher")) score = 200;
    else score = 50;
    if (qual.startsWith("mipmap")) score += 30;
    for (const [dens, val] of Object.entries(ICON_DENSITY)) {
      if (qual.endsWith(dens)) {
        score += val;
        break;
      }
    }
    if (score > bestScore) {
      best = e;
      bestScore = score;
    }
  }
  return best;
}
function parsePkgListLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("package:")) return null;
  const body = trimmed.slice("package:".length).trim();
  if (!body) return null;
  const parts = body.split(/\s+/);
  const head = parts[0];
  const extras = parts.slice(1);
  let apkPath;
  let pkg;
  if (head.includes("=")) {
    const idx = head.lastIndexOf("=");
    apkPath = head.slice(0, idx);
    pkg = head.slice(idx + 1);
  } else {
    apkPath = "";
    pkg = head;
  }
  const info = { package: pkg, apkPath, versionCode: "", uid: "", installer: "" };
  for (const tok of extras) {
    if (tok.startsWith("versionCode:")) info.versionCode = tok.slice(tok.indexOf(":") + 1);
    else if (tok.startsWith("uid:")) info.uid = tok.slice(tok.indexOf(":") + 1);
    else if (tok.startsWith("installer:")) {
      const v = tok.slice(tok.indexOf(":") + 1);
      info.installer = v === "null" || v === "" ? "" : v;
    }
  }
  return info;
}
function parsePackageNames(stdout) {
  const out = /* @__PURE__ */ new Set();
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("package:")) {
      const name = line.slice("package:".length).trim().split(/\s+/)[0];
      if (name) out.add(name);
    }
  }
  return out;
}
function buildAppList(detailedStdout, system, disabled) {
  const apps = [];
  for (const line of detailedStdout.split("\n")) {
    const d = parsePkgListLine(line);
    if (!d) continue;
    apps.push({
      package: d.package,
      apkPath: d.apkPath,
      versionCode: d.versionCode,
      uid: d.uid,
      installer: d.installer,
      system: system.has(d.package),
      enabled: !disabled.has(d.package)
    });
  }
  apps.sort((a, b) => {
    const la = a.package.toLowerCase();
    const lb = b.package.toLowerCase();
    return la < lb ? -1 : la > lb ? 1 : 0;
  });
  return apps;
}
const PERM_RE = /^[\w.]+$/;
function isPerm(name) {
  return !!name && name.includes(".") && PERM_RE.test(name);
}
function search1(text2, pat) {
  const m = pat.exec(text2);
  return m ? m[1].trim() : "";
}
function parsePermissions(text2) {
  const granted = /* @__PURE__ */ new Map();
  const requested = /* @__PURE__ */ new Set();
  const runtime = /* @__PURE__ */ new Set();
  let mode = null;
  for (const raw of text2.split("\n")) {
    const s = raw.trim();
    const low = s.toLowerCase();
    if (low.startsWith("requested permissions:")) {
      mode = "req";
      continue;
    }
    if (low.startsWith("install permissions:")) {
      mode = "install";
      continue;
    }
    if (low.startsWith("runtime permissions:")) {
      mode = "runtime";
      continue;
    }
    if (low.startsWith("declared permissions:")) {
      mode = null;
      continue;
    }
    if (!s) continue;
    if (mode && s.endsWith(":") && !s.includes("granted=") && !isPerm(s.slice(0, -1))) {
      mode = null;
      continue;
    }
    if (mode === "req") {
      const name = s.split(":")[0].trim();
      if (isPerm(name)) requested.add(name);
    } else if ((mode === "install" || mode === "runtime") && s.includes("granted=")) {
      const name = s.split(":")[0].trim();
      if (isPerm(name)) {
        const g = s.includes("granted=true");
        granted.set(name, (granted.get(name) ?? false) || g);
        requested.add(name);
        if (mode === "runtime") runtime.add(name);
      }
    }
  }
  return [...requested].sort((a, b) => a < b ? -1 : a > b ? 1 : 0).map((n) => ({ name: n, granted: granted.has(n) ? granted.get(n) : null, runtime: runtime.has(n) }));
}
const RESOLVER_SECTIONS = {
  "activity resolver table:": "activities",
  "receiver resolver table:": "receivers",
  "service resolver table:": "services",
  "provider resolver table:": "providers"
};
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function fullClass(pkg, comp) {
  if (comp.startsWith(".")) return pkg + comp;
  if (!comp.includes(".")) return pkg + "." + comp;
  return comp;
}
function parseComponents(text2, pkg) {
  const found = {
    activities: /* @__PURE__ */ new Set(),
    services: /* @__PURE__ */ new Set(),
    receivers: /* @__PURE__ */ new Set(),
    providers: /* @__PURE__ */ new Set()
  };
  const disabled = /* @__PURE__ */ new Set();
  const tokRe = new RegExp(escapeRegex(pkg) + "/([\\w.$]+)", "g");
  let section = null;
  let grabbingDisabled = false;
  for (const raw of text2.split("\n")) {
    const s = raw.trim();
    const low = s.toLowerCase();
    if (low in RESOLVER_SECTIONS) {
      section = RESOLVER_SECTIONS[low];
      grabbingDisabled = false;
      continue;
    }
    if (low.startsWith("disabledcomponents:")) {
      grabbingDisabled = true;
      section = null;
      continue;
    }
    if (low.startsWith("enabledcomponents:") || low.startsWith("packages:") || low.startsWith("shared users:") || low.startsWith("key set manager:") || low.startsWith("preferred activities")) {
      grabbingDisabled = false;
      if (low.startsWith("packages:") || low.startsWith("shared users:") || low.startsWith("key set manager:")) {
        section = null;
      }
      continue;
    }
    if (grabbingDisabled) {
      if (!!s && isPerm(s) || s.includes(".") && !s.includes(" ") && !!s) {
        disabled.add(fullClass(pkg, s));
      } else if (s && !s.startsWith(pkg)) {
        grabbingDisabled = false;
      }
    }
    if (section) {
      for (const m of s.matchAll(tokRe)) found[section].add(m[1]);
    }
  }
  const build = (set) => [...set].sort((a, b) => a < b ? -1 : a > b ? 1 : 0).map((c) => ({ name: c, enabled: !disabled.has(fullClass(pkg, c)) }));
  return {
    activities: build(found.activities),
    services: build(found.services),
    receivers: build(found.receivers),
    providers: build(found.providers)
  };
}
const APPOP_RE = /([A-Z][A-Z0-9_]+):\s*(allow|deny|ignore|default|foreground)/;
function parseAppops(text2) {
  const seen = /* @__PURE__ */ new Map();
  for (const raw of text2.split("\n")) {
    const m = APPOP_RE.exec(raw);
    if (m && !seen.has(m[1])) seen.set(m[1], m[2]);
  }
  return [...seen.entries()].map(([op, mode]) => ({ op, mode }));
}
const GENERAL_FIELDS = [
  ["versionName", /\bversionName=(.+)/],
  ["versionCode", /\bversionCode=(\S+)/],
  ["minSdk", /\bminSdk=(\S+)/],
  ["targetSdk", /\btargetSdk=(\S+)/],
  ["userId", /\buserId=(\S+)/],
  ["codePath", /\bcodePath=(\S+)/],
  ["dataDir", /\bdataDir=(\S+)/],
  ["primaryCpuAbi", /\bprimaryCpuAbi=(\S+)/],
  ["installerPackageName", /\binstallerPackageName=(\S+)/],
  ["firstInstallTime", /\bfirstInstallTime=(.+)/],
  ["lastUpdateTime", /\blastUpdateTime=(.+)/]
];
function parseGeneral(text2) {
  const g = {};
  for (const [key2, pat] of GENERAL_FIELDS) {
    const val = search1(text2, pat);
    if (val && val.toLowerCase() !== "null") g[key2] = val;
  }
  const fm = /\bflags=\[\s*(.*?)\s*\]/.exec(text2);
  if (fm) g.flags = fm[1];
  const sm = /\bsplits=\[(.*?)\]/.exec(text2);
  if (sm && sm[1]) g.splits = sm[1];
  return g;
}
function parseSignatures(text2) {
  const out = [];
  const prefixes = ["signatures=", "signing details:", "Signing KeySets:", "PackageSignatures"];
  for (const raw of text2.split("\n")) {
    const s = raw.trim();
    if (prefixes.some((p) => s.startsWith(p))) out.push(s);
  }
  const m = /signatureScheme=(\S+)/.exec(text2);
  if (m) out.push(`signatureScheme=${m[1]}`);
  return out;
}
const SVC_REC_RE = /\* ServiceRecord\{\S+ u\d+ ([^}\s]+)[^}]*\}/g;
const SVC_PROC_RE = /app=ProcessRecord\{\S+ (\d+):(\S+?)[/}]/;
function parseRunningServices(text2) {
  const heads = [...text2.matchAll(SVC_REC_RE)];
  const out = [];
  for (let i = 0; i < heads.length; i++) {
    const start = heads[i].index ?? 0;
    const end = i + 1 < heads.length ? heads[i + 1].index ?? text2.length : text2.length;
    const block = text2.slice(start, end);
    const pm = SVC_PROC_RE.exec(block);
    out.push({
      component: heads[i][1],
      pid: pm ? parseInt(pm[1], 10) : null,
      process: pm ? pm[2] : "",
      foreground: block.includes("isForeground=true"),
      started: block.includes("startRequested=true")
    });
  }
  return out;
}
function parseAppDetail(pkg, dumpsys, appops) {
  const comps = parseComponents(dumpsys, pkg);
  return {
    package: pkg,
    general: parseGeneral(dumpsys),
    permissions: parsePermissions(dumpsys),
    activities: comps.activities,
    services: comps.services,
    receivers: comps.receivers,
    providers: comps.providers,
    appops: parseAppops(appops),
    signatures: parseSignatures(dumpsys),
    running: []
  };
}
function opOk(returncode, stdout) {
  const head = (stdout || "").trim().toLowerCase();
  if (head.startsWith("failure") || head.startsWith("failed") || head.startsWith("error") || head.startsWith("exception")) {
    return false;
  }
  return returncode === 0;
}
function humanBytes(n) {
  let size2 = n;
  for (const unit of ["B", "KB", "MB", "GB", "TB"]) {
    if (size2 < 1024) return unit === "B" ? `${Math.round(size2)} ${unit}` : `${size2.toFixed(1)} ${unit}`;
    size2 /= 1024;
  }
  return `${size2.toFixed(1)} PB`;
}
function errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}
function lastLine$1(stderr, stdout, fallback) {
  const out = (stderr || stdout || "").trim();
  if (!out) return fallback;
  const lines = out.split("\n");
  return lines[lines.length - 1];
}
function downloadsDir() {
  const d = node_path.join(node_os.homedir(), "Downloads");
  return node_fs.existsSync(d) ? d : node_os.homedir();
}
function iconCacheFile(serial, pkg) {
  const safe = (s) => s.replace(/[^\w.-]/g, "_");
  const dir = node_path.join(electron.app.getPath("userData"), "android-app-icons", safe(serial));
  node_fs.mkdirSync(dir, { recursive: true });
  return node_path.join(dir, `${safe(pkg)}.dataurl`);
}
function imageMime(buf) {
  if (buf.length >= 8 && buf[0] === 137 && buf[1] === 80 && buf[2] === 78 && buf[3] === 71) return "image/png";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  if (buf.length >= 3 && buf[0] === 255 && buf[1] === 216 && buf[2] === 255) return "image/jpeg";
  return null;
}
class AppMgrService {
  constructor(adb) {
    this.adb = adb;
  }
  // --- app list (AppListWorker) -----------------------------------------------
  async list(serial) {
    let det = await run$3(this.adb, null, listPackagesArgs(serial, true), 25e3);
    if (det.code !== 0 || !det.stdout.includes("package:")) {
      det = await run$3(this.adb, null, listPackagesArgs(serial, false), 25e3);
    }
    const system = parsePackageNames((await run$3(this.adb, null, listFilteredArgs(serial, "-s"), 25e3)).stdout);
    const disabled = parsePackageNames((await run$3(this.adb, null, listFilteredArgs(serial, "-d"), 25e3)).stdout);
    const apps = buildAppList(det.stdout, system, disabled);
    if (apps.length === 0) {
      return { ok: false, apps: [], error: (det.stderr || "No packages returned").trim() };
    }
    return { ok: true, apps, error: "" };
  }
  // --- app detail (AppDetailWorker) -------------------------------------------
  async detail(serial, pkg, apkPath) {
    const dump = (await run$3(this.adb, null, dumpsysArgs(serial, pkg), 25e3)).stdout;
    const ops = await run$3(this.adb, null, appopsGetArgs(serial, pkg, true), 25e3);
    let opsOut = ops.stdout;
    if (ops.code !== 0 || !opsOut.trim()) {
      opsOut = (await run$3(this.adb, null, appopsGetArgs(serial, pkg, false), 25e3)).stdout;
    }
    if (dump.includes("Unable to find package") || !dump.trim()) {
      return { ok: false, detail: null, error: `Package ${pkg} not found` };
    }
    const detail = parseAppDetail(pkg, dump, opsOut);
    detail.general.apkSize = apkPath ? await this.statSize(serial, apkPath) : "";
    detail.general.dataSize = await this.du(serial, pkg, ".");
    detail.general.cacheSize = await this.du(serial, pkg, "cache");
    const r = await run$3(this.adb, null, runningServicesArgs(serial, pkg), 1e4);
    detail.running = parseRunningServices(r.stdout);
    return { ok: true, detail, error: "" };
  }
  async statSize(serial, apkPath) {
    const r = await run$3(this.adb, null, statSizeArgs(serial, apkPath), 8e3);
    const v = r.stdout.trim();
    return /^\d+$/.test(v) ? humanBytes(parseInt(v, 10)) : "";
  }
  async du(serial, pkg, sub) {
    const r = await run$3(this.adb, null, duArgs(serial, pkg, sub), 8e3);
    const first = r.stdout.trim().split(/\s+/)[0] ?? "";
    return /^\d+$/.test(first) ? humanBytes(parseInt(first, 10) * 1024) : "";
  }
  // --- generic action (AppActionWorker) — argv already carries `-s <serial>` --
  async action(argv, okMsg) {
    const r = await run$3(this.adb, null, argv, 9e4);
    if (opOk(r.code ?? 1, r.stdout)) return { ok: true, message: okMsg };
    return { ok: false, message: lastLine$1(r.stderr, r.stdout, `${okMsg} failed`) };
  }
  // --- clear cache (ClearCacheWorker) -----------------------------------------
  async clearCache(serial, pkg) {
    const attempts = [
      ["pm --cache-only", clearCacheArgs(serial, pkg)],
      ["run-as", runasClearCacheArgs(serial, pkg)],
      ["su", suClearCacheArgs(serial, pkg)]
    ];
    const errors = [];
    for (const [label, argv] of attempts) {
      const r = await run$3(this.adb, null, argv, 6e4);
      if (opOk(r.code ?? 1, r.stdout)) {
        return { ok: true, message: `Cleared cache for ${pkg} (via ${label})` };
      }
      const detail = (r.stderr || r.stdout || "").trim().replace(/\n/g, " ");
      errors.push(`${label}: ${detail.slice(0, 80) || "failed"}`);
    }
    return { ok: false, message: "Could not clear cache — " + errors.join("; ") };
  }
  // --- bulk permission change (BulkPermWorker) --------------------------------
  async bulkPerms(serial, pkg, perms, grant) {
    const verb = grant ? "grant" : "revoke";
    const title = verb[0].toUpperCase() + verb.slice(1);
    const builder = grant ? grantArgs : revokeArgs;
    let okN = 0;
    const fails = [];
    for (const perm of perms) {
      const r = await run$3(this.adb, null, builder(serial, pkg, perm), 3e4);
      if (opOk(r.code ?? 1, r.stdout)) okN += 1;
      else {
        const detail = (r.stderr || r.stdout || "").trim().replace(/\n/g, " ");
        fails.push(`${perm.split(".").pop()}: ${detail.slice(0, 50) || "failed"}`);
      }
    }
    if (okN && fails.length === 0) return { ok: true, message: `${title}ed ${okN} permission(s)` };
    if (okN) {
      return { ok: true, message: `${title}ed ${okN}, ${fails.length} failed (${fails.slice(0, 3).join("; ")})` };
    }
    return { ok: false, message: `Could not ${verb} permissions — ${fails.slice(0, 4).join("; ")}` };
  }
  // --- app icon (AppIconWorker) -----------------------------------------------
  async icon(serial, pkg, apkPath) {
    if (!apkPath) return { dataUrl: null, unavailable: false };
    const cacheFile = iconCacheFile(serial, pkg);
    if (node_fs.existsSync(cacheFile)) {
      try {
        const dataUrl2 = node_fs.readFileSync(cacheFile, "utf8");
        if (dataUrl2.startsWith("data:")) return { dataUrl: dataUrl2, unavailable: false };
      } catch {
      }
    }
    const listing = await run$3(this.adb, null, unzipListArgs(serial, apkPath), 15e3);
    if (listing.code !== 0) {
      const err = (listing.stderr || "").toLowerCase();
      const miss = err.includes("not found") || err.includes("inaccessible");
      return { dataUrl: null, unavailable: miss };
    }
    const entry = pickLauncherIcon(parseZipEntries(listing.stdout));
    if (!entry) return { dataUrl: null, unavailable: false };
    const blob = await runBinary(this.adb, unzipExtractArgs(serial, apkPath, entry), 2e4);
    const mime = imageMime(blob.stdout);
    if (!mime) return { dataUrl: null, unavailable: false };
    const dataUrl = `data:${mime};base64,${blob.stdout.toString("base64")}`;
    try {
      node_fs.writeFileSync(cacheFile, dataUrl);
    } catch {
    }
    return { dataUrl, unavailable: false };
  }
  // --- extract APK (PullWorker) -----------------------------------------------
  async extractApk(serial, pkg) {
    const remotes = parseApkPaths((await run$3(this.adb, null, pmPathArgs(serial, pkg), 15e3)).stdout);
    if (remotes.length === 0) {
      return { ok: false, message: `No APK found on device for ${pkg}`, dir: "" };
    }
    const dest = node_path.join(downloadsDir(), pkg);
    try {
      node_fs.mkdirSync(dest, { recursive: true });
    } catch (e) {
      return { ok: false, message: `Cannot create ${dest}: ${errMsg(e)}`, dir: "" };
    }
    const pulled = [];
    const errors = [];
    for (const remote of remotes) {
      const name = node_path.basename(remote);
      const local = node_path.join(dest, name);
      const r = await run$3(this.adb, serial, ["pull", remote, local], 18e4);
      if (r.code === 0 && node_fs.existsSync(local)) pulled.push(name);
      else errors.push(`${name}: ${lastLine$1(r.stderr, r.stdout, "pull failed")}`);
    }
    const ok = pulled.length > 0 && errors.length === 0;
    let message;
    if (pulled.length) {
      message = `Pulled ${pulled.length} file(s): ${pulled.join(", ")}`;
      if (errors.length) message += `  (${errors.length} failed: ${errors.join("; ")})`;
    } else {
      message = "Pull failed: " + errors.join("; ");
    }
    return { ok, message, dir: dest };
  }
}
const DEFAULT_PORT = 8099;
const MAX_BODY = 1048576;
const FLOW_CAP = 5e3;
const PEEK_BYTES = 8192;
const RELAY_CHUNK = 65536;
const STREAM_LIMIT = 1 << 20;
function reverseArgs(serial, port) {
  return ["-s", serial, "reverse", `tcp:${port}`, `tcp:${port}`];
}
function setProxyArgs(serial, port) {
  return ["-s", serial, "shell", "settings", "put", "global", "http_proxy", `127.0.0.1:${port}`];
}
function clearProxyArgs(serial) {
  return ["-s", serial, "shell", "settings", "put", "global", "http_proxy", ":0"];
}
function getProxyArgs(serial) {
  return ["-s", serial, "shell", "settings", "get", "global", "http_proxy"];
}
const SAFE_PROXY = /^[A-Za-z0-9._:\-[\]]+$/;
function realProxy(original) {
  const val = (original || "").trim();
  if (val && val.toLowerCase() !== "null" && val !== ":0" && !val.startsWith("127.0.0.1:") && SAFE_PROXY.test(val)) {
    return val;
  }
  return "";
}
function restoreProxyArgs(serial, original) {
  const val = realProxy(original);
  if (val) return ["-s", serial, "shell", "settings", "put", "global", "http_proxy", val];
  return clearProxyArgs(serial);
}
function proxyRestoreCmd(original) {
  const val = realProxy(original);
  return `settings put global http_proxy ${val ? val : ":0"}`;
}
function proxyWatchdogScript(original) {
  const cmd = proxyRestoreCmd(original);
  return `trap '${cmd}; exit 0' HUP INT TERM; read _ 2>/dev/null || ${cmd}`;
}
function reverseRemoveArgs(serial, port) {
  return ["-s", serial, "reverse", "--remove", `tcp:${port}`];
}
function parseSni(data) {
  try {
    if (data.length < 43 || data[0] !== 22 || data[5] !== 1) return null;
    const u16 = (i) => data[i] << 8 | data[i + 1];
    let idx = 5 + 4;
    idx += 2;
    idx += 32;
    idx += 1 + data[idx];
    idx += 2 + u16(idx);
    idx += 1 + data[idx];
    const extTotal = u16(idx);
    idx += 2;
    const end = Math.min(data.length, idx + extTotal);
    while (idx + 4 <= end) {
      const etype = u16(idx);
      const elen = u16(idx + 2);
      idx += 4;
      if (etype === 0) {
        let p = idx + 2;
        p += 1;
        const nlen = u16(p);
        p += 2;
        let name = "";
        for (let i = 0; i < nlen && p + i < data.length; i++) name += String.fromCharCode(data[p + i]);
        return name || null;
      }
      idx += elen;
    }
    return null;
  } catch {
    return null;
  }
}
function parseHead(raw) {
  const buf = typeof raw === "string" ? Buffer.from(raw, "latin1") : Buffer.from(raw);
  const sep = buf.indexOf("\r\n\r\n");
  const headPart = sep >= 0 ? buf.subarray(0, sep) : buf;
  const text2 = headPart.toString("latin1");
  const lines = text2.split("\r\n");
  const start = lines.length > 0 ? lines[0] : "";
  const headers = [];
  for (const line of lines.slice(1)) {
    const i = line.indexOf(":");
    if (i >= 0) headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
  }
  return [start, headers];
}
function headerGet(headers, name) {
  const low = name.toLowerCase();
  for (const [k, v] of headers) {
    if (k.toLowerCase() === low) return v;
  }
  return null;
}
function splitUrl(target) {
  let scheme;
  let rest;
  const schemeIdx = target.indexOf("://");
  if (schemeIdx >= 0) {
    scheme = target.slice(0, schemeIdx);
    rest = target.slice(schemeIdx + 3);
  } else {
    scheme = "http";
    rest = target;
  }
  const slash = rest.indexOf("/");
  let hostport;
  let path;
  if (slash >= 0) {
    hostport = rest.slice(0, slash);
    path = "/" + rest.slice(slash + 1);
  } else {
    hostport = rest;
    path = "/";
  }
  if (hostport.includes("@")) hostport = hostport.split("@").slice(1).join("@");
  const colon = hostport.indexOf(":");
  const host = colon >= 0 ? hostport.slice(0, colon) : hostport;
  const portStr = colon >= 0 ? hostport.slice(colon + 1) : "";
  const port = /^\d+$/.test(portStr) ? parseInt(portStr, 10) : scheme === "https" ? 443 : 80;
  return [scheme, host, port, path];
}
function parseStatus(startLine) {
  const parts = startLine.split(" ");
  if (parts.length >= 2 && /^\d+$/.test(parts[1])) return parseInt(parts[1], 10);
  return null;
}
function makeFlow(init) {
  const host = init.host ?? "";
  const path = init.path ?? "/";
  return {
    id: 0,
    ts: init.ts ?? Date.now() / 1e3,
    method: init.method ?? "",
    scheme: init.scheme ?? "http",
    host,
    port: init.port ?? 80,
    path,
    status: init.status ?? null,
    reqHeaders: init.reqHeaders ?? [],
    respHeaders: init.respHeaders ?? [],
    reqSize: init.reqSize ?? 0,
    respSize: init.respSize ?? 0,
    durationMs: init.durationMs ?? null,
    reqBody: init.reqBody ?? null,
    respBody: init.respBody ?? null,
    reqTruncated: init.reqTruncated ?? false,
    respTruncated: init.respTruncated ?? false,
    bodyCaptured: init.bodyCaptured ?? true,
    note: init.note ?? "",
    search: (host + " " + path).toLowerCase()
  };
}
function flowUrl(f) {
  const hostport = f.port === 80 || f.port === 443 ? f.host : `${f.host}:${f.port}`;
  return `${f.scheme}://${hostport}${f.path}`;
}
function toDisplayFlow(f) {
  return {
    id: f.id,
    ts: f.ts,
    method: f.method,
    scheme: f.scheme,
    host: f.host,
    port: f.port,
    path: f.path,
    status: f.status,
    reqSize: f.reqSize,
    respSize: f.respSize,
    durationMs: f.durationMs,
    contentType: headerGet(f.respHeaders, "Content-Type") || (f.bodyCaptured ? "" : "tunnel"),
    bodyCaptured: f.bodyCaptured,
    note: f.note,
    search: f.search
  };
}
function humanSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
function decodeBody(body, headers) {
  if (!body || body.length === 0) return body;
  const buf = Buffer.from(body);
  const enc = (headerGet(headers, "Content-Encoding") || "").toLowerCase();
  try {
    if (buf[0] === 31 && buf[1] === 139) {
      try {
        return node_zlib.gunzipSync(buf);
      } catch {
        try {
          return node_zlib.gunzipSync(buf, { finishFlush: node_zlib.constants.Z_SYNC_FLUSH });
        } catch {
          return body;
        }
      }
    }
    if (buf[0] === 40 && buf[1] === 181 && buf[2] === 47 && buf[3] === 253) {
      return body;
    }
    if (enc.includes("deflate")) {
      try {
        return node_zlib.inflateSync(buf);
      } catch {
        try {
          return node_zlib.inflateRawSync(buf);
        } catch {
          return body;
        }
      }
    } else if (enc.includes("br")) {
      return node_zlib.brotliDecompressSync(buf);
    }
  } catch {
    return body;
  }
  return body;
}
function prettyBody(body, headers) {
  if (!body || body.length === 0) return "";
  const decoded = decodeBody(body, headers);
  if (!decoded) return "";
  const buf = Buffer.from(decoded);
  let text2;
  try {
    text2 = buf.toString("utf8");
    if (text2.includes("�") && !Buffer.from(text2, "utf8").equals(buf)) {
      return `<${buf.length} bytes binary>`;
    }
  } catch {
    return `<${buf.length} bytes binary>`;
  }
  const ctype = (headerGet(headers, "Content-Type") || "").toLowerCase();
  if (ctype.includes("json") || text2[0] === "{" || text2[0] === "[") {
    try {
      return JSON.stringify(JSON.parse(text2), null, 2);
    } catch {
      return text2;
    }
  }
  return text2;
}
function flowToCurl(f) {
  const parts = [`curl -X ${f.method} '${flowUrl(f)}'`];
  for (const [k, v] of f.reqHeaders) {
    const lk = k.toLowerCase();
    if (lk === "content-length" || lk === "proxy-connection" || lk === "connection") continue;
    parts.push(`-H '${k}: ${v}'`);
  }
  if (f.reqBody && f.reqBody.length > 0) {
    const buf = Buffer.from(f.reqBody);
    const text2 = buf.toString("utf8");
    if (!(text2.includes("�") && !Buffer.from(text2, "utf8").equals(buf))) {
      parts.push(`--data-raw '${text2}'`);
    }
  }
  return parts.join(" \\\n  ");
}
function buildFlowExport(f) {
  const out = [`# ${f.method} ${flowUrl(f)}`];
  const meta = [];
  if (f.status !== null) meta.push(`status ${f.status}`);
  if (f.durationMs !== null) meta.push(`${f.durationMs} ms`);
  if (f.respSize) meta.push(humanSize(f.respSize));
  if (meta.length) out.push("# " + meta.join("  ·  "));
  out.push("", "===== REQUEST =====", `${f.method} ${f.path}  (${f.scheme})`);
  for (const [k, v] of f.reqHeaders) out.push(`${k}: ${v}`);
  const req = prettyBody(f.reqBody, f.reqHeaders);
  if (req) out.push("", req);
  out.push("", "===== RESPONSE =====", f.status !== null ? `HTTP ${f.status}` : "(no response)");
  for (const [k, v] of f.respHeaders) out.push(`${k}: ${v}`);
  if (f.bodyCaptured) {
    const resp = prettyBody(f.respBody, f.respHeaders);
    if (resp) out.push("", resp);
  } else {
    out.push("", f.note || "(encrypted — body not captured)");
  }
  return out.join("\n") + "\n";
}
const FLOW_FLUSH_MS = 100;
const TRIM_CHUNK = 500;
const CRLFCRLF = Buffer.from("\r\n\r\n");
const LF = Buffer.from("\n");
function safeDestroy(s) {
  try {
    if (s && !s.destroyed) s.destroy();
  } catch {
  }
}
function writeAsync(dst, buf) {
  if (!buf || buf.length === 0 || dst.destroyed || !dst.writable) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      dst.off("drain", finish);
      dst.off("close", finish);
      dst.off("error", finish);
      resolve();
    };
    const ok = dst.write(buf);
    if (ok) {
      finish();
      return;
    }
    dst.once("drain", finish);
    dst.once("close", finish);
    dst.once("error", finish);
  });
}
function onceWithTimeout(emitter, event, timeoutMs) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      emitter.off(event, onOk);
      emitter.off("error", onErr);
    };
    const onOk = () => {
      cleanup();
      resolve();
    };
    const onErr = (e) => {
      cleanup();
      reject(e);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timeout"));
    }, timeoutMs);
    emitter.once(event, onOk);
    emitter.once("error", onErr);
  });
}
class StreamReader {
  constructor(stream) {
    this.stream = stream;
    stream.on("data", this.onData);
    stream.on("end", this.onEnd);
    stream.on("close", this.onEnd);
    stream.on("error", this.onEnd);
  }
  chunks = [];
  size = 0;
  ended = false;
  waiter = null;
  onData = (c) => {
    this.chunks.push(c);
    this.size += c.length;
    this.wake();
  };
  onEnd = () => {
    this.ended = true;
    this.wake();
  };
  wake() {
    const w = this.waiter;
    this.waiter = null;
    if (w) w();
  }
  wait() {
    return new Promise((res) => {
      this.waiter = res;
    });
  }
  merged() {
    if (this.chunks.length === 0) return Buffer.alloc(0);
    if (this.chunks.length > 1) this.chunks = [Buffer.concat(this.chunks)];
    return this.chunks[0];
  }
  take(n) {
    const b = this.merged();
    const cut = Math.min(n, b.length);
    const out = Buffer.from(b.subarray(0, cut));
    this.chunks = cut < b.length ? [Buffer.from(b.subarray(cut))] : [];
    this.size -= cut;
    return out;
  }
  /** Bytes up to AND including `delim`; on EOF / over `limit` returns what's buffered. */
  async readUntil(delim, limit) {
    for (; ; ) {
      const b = this.merged();
      const idx = b.indexOf(delim);
      if (idx >= 0) return this.take(idx + delim.length);
      if (this.ended || this.size > limit) return this.take(this.size);
      await this.wait();
    }
  }
  /** Exactly `n` bytes, or the remainder on EOF (mirrors _readexactly's partial). */
  async readExactly(n) {
    while (this.size < n && !this.ended) await this.wait();
    return this.take(n);
  }
  /** One line incl. the trailing LF, or '' on EOF (mirrors StreamReader.readline). */
  async readLine() {
    return this.readUntil(LF, STREAM_LIMIT);
  }
  /** Up to `n` bytes (waits for at least one), '' on EOF (mirrors reader.read(n)). */
  async read(n) {
    while (this.size === 0 && !this.ended) await this.wait();
    return this.take(n);
  }
  /** Detach listeners and return any buffered leftover (for CONNECT hand-off). */
  detach() {
    this.stream.off("data", this.onData);
    this.stream.off("end", this.onEnd);
    this.stream.off("close", this.onEnd);
    this.stream.off("error", this.onEnd);
    const leftover = this.merged();
    this.chunks = [];
    this.size = 0;
    return leftover;
  }
}
async function relayBody(reader, dst, headers, cap2, readUntilEof) {
  const te = (headerGet(headers, "Transfer-Encoding") || "").toLowerCase();
  const cl = headerGet(headers, "Content-Length");
  const captured = [];
  let capLen = 0;
  let total = 0;
  let truncated = false;
  const capBytes = (chunk) => {
    if (capLen < cap2) {
      const room = cap2 - capLen;
      const slice = chunk.subarray(0, room);
      captured.push(Buffer.from(slice));
      capLen += slice.length;
      if (chunk.length > room) truncated = true;
    }
  };
  try {
    if (te.includes("chunked")) {
      for (; ; ) {
        const sizeLine = await reader.readLine();
        if (sizeLine.length === 0) break;
        await writeAsync(dst, sizeLine);
        const hexStr = sizeLine.toString("latin1").split(";")[0].trim() || "0";
        if (!/^[0-9a-fA-F]+$/.test(hexStr)) break;
        const size2 = parseInt(hexStr, 16);
        if (size2 === 0) {
          for (; ; ) {
            const t = await reader.readLine();
            if (t.length === 0) break;
            await writeAsync(dst, t);
            const s = t.toString("latin1");
            if (s === "\r\n" || s === "\n") break;
          }
          break;
        }
        const chunk = await reader.readExactly(size2);
        await writeAsync(dst, chunk);
        await writeAsync(dst, await reader.readExactly(2));
        total += chunk.length;
        capBytes(chunk);
      }
    } else if (cl !== null && /^\d+$/.test(cl.trim())) {
      let remaining = parseInt(cl.trim(), 10);
      while (remaining > 0) {
        const chunk = await reader.read(Math.min(RELAY_CHUNK, remaining));
        if (chunk.length === 0) break;
        remaining -= chunk.length;
        total += chunk.length;
        await writeAsync(dst, chunk);
        capBytes(chunk);
      }
    } else if (readUntilEof) {
      for (; ; ) {
        const chunk = await reader.read(RELAY_CHUNK);
        if (chunk.length === 0) break;
        total += chunk.length;
        await writeAsync(dst, chunk);
        capBytes(chunk);
      }
    }
  } catch {
  }
  return { size: total, body: Buffer.concat(captured), truncated };
}
function pump(src, dst) {
  return new Promise((resolve) => {
    let total = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      src.off("data", onData);
      dst.off("drain", onDrain);
      src.off("end", finish);
      src.off("close", finish);
      src.off("error", finish);
      try {
        if (dst.writable && !dst.destroyed) dst.end();
      } catch {
      }
      resolve(total);
    };
    const onData = (c) => {
      total += c.length;
      if (!dst.write(c)) src.pause();
    };
    const onDrain = () => {
      src.resume();
    };
    src.on("data", onData);
    dst.on("drain", onDrain);
    src.on("end", finish);
    src.on("close", finish);
    src.on("error", finish);
  });
}
function peekSocket(socket, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (buf) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("error", onEnd);
      socket.pause();
      resolve(buf);
    };
    const onData = (c) => finish(c.subarray(0, PEEK_BYTES));
    const onEnd = () => finish(Buffer.alloc(0));
    const timer = setTimeout(() => finish(Buffer.alloc(0)), timeoutMs);
    socket.on("data", onData);
    socket.on("end", onEnd);
    socket.on("error", onEnd);
  });
}
class InterceptService {
  constructor(wiringFor, cb) {
    this.wiringFor = wiringFor;
    this.cb = cb;
  }
  server = null;
  running = false;
  decrypt = false;
  wiring = null;
  activePort = DEFAULT_PORT;
  idCounter = 0;
  flows = [];
  flowMap = /* @__PURE__ */ new Map();
  pending = [];
  flushTimer = null;
  // Tier-2 CA + per-host leaf material (all lazy — nothing at construction).
  ca = null;
  leafKeys = null;
  ctxCache = /* @__PURE__ */ new Map();
  pinnedHosts = /* @__PURE__ */ new Set();
  // --- lifecycle ------------------------------------------------------------
  /** Wire the device + bind the proxy. Emits onStarted / onFailed / onStatus. */
  async start(serial, port, decrypt) {
    if (this.running) this.stop();
    this.decrypt = decrypt;
    this.activePort = port;
    const wiring = this.wiringFor(serial);
    if (!wiring) {
      this.cb.onFailed("No adb / go-ios backend for this device");
      return;
    }
    this.wiring = wiring;
    let wired;
    try {
      wired = await wiring.wire(port);
    } catch (e) {
      this.wiring = null;
      this.cb.onFailed(`device wiring failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (!wired.ok) {
      this.wiring = null;
      this.cb.onFailed(wired.message);
      return;
    }
    try {
      if (decrypt) this.ensureCa();
    } catch (e) {
      wiring.unwire();
      this.wiring = null;
      this.cb.onFailed(`CA generation failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const server = net.createServer((socket) => this.handleClient(socket));
    server.on("error", (err) => {
      if (!this.running) {
        wiring.unwire();
        this.wiring = null;
        this.cb.onFailed(`port ${port} unavailable (${err.message})`);
      }
    });
    server.listen(port, wiring.bindHost, () => {
      this.running = true;
      this.server = server;
      this.cb.onStarted(port);
      this.cb.onStatus(
        `Intercept on — ${decrypt ? "decrypting HTTPS" : "capturing"} · port ${port} · ${serial}`
      );
      if (wired.message) this.cb.onStatus(wired.message);
      if (decrypt && wiring.autoInstallCertOnStart) this.maybePromptCert(serial);
    });
  }
  /** Toggle HTTPS decryption on the running session (new connections honor it). */
  setDecrypt(on) {
    this.decrypt = on;
    if (this.running && this.wiring) {
      if (on) {
        try {
          this.ensureCa();
        } catch {
        }
        if (this.wiring.autoInstallCertOnStart) this.maybePromptCert(this.wiring.serial);
      }
      this.cb.onStatus(
        `Intercept on — ${on ? "decrypting HTTPS" : "capturing"} · port ${this.activePort} · ${this.wiring.serial}`
      );
    }
  }
  /** Stop capture + unwire the device (restore proxy / drop tunnel, per platform). */
  stop() {
    this.running = false;
    if (this.server) {
      try {
        this.server.close();
      } catch {
      }
      this.server = null;
    }
    if (this.wiring) {
      this.wiring.unwire();
      this.wiring = null;
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
  /** App-close hook — no dangling proxy may outlive the app (CLAUDE.md #3). */
  shutdown() {
    this.stop();
  }
  // --- Tier-2 CA + leaf certs (node-forge) ----------------------------------
  caDir() {
    return node_path.join(electron.app.getPath("userData"), "intercept");
  }
  caCertPath() {
    return node_path.join(this.caDir(), "androidlab-ca.crt");
  }
  caKeyPath() {
    return node_path.join(this.caDir(), "androidlab-ca.key");
  }
  /** Load the persisted CA, or generate + persist one (RSA 2048, cA:true). */
  ensureCa() {
    if (this.ca) return;
    const certPath = this.caCertPath();
    const keyPath = this.caKeyPath();
    if (node_fs.existsSync(certPath) && node_fs.existsSync(keyPath)) {
      const certPem2 = node_fs.readFileSync(certPath, "utf8");
      const keyPem2 = node_fs.readFileSync(keyPath, "utf8");
      this.ca = {
        cert: forge.pki.certificateFromPem(certPem2),
        key: forge.pki.privateKeyFromPem(keyPem2),
        certPem: certPem2,
        keyPem: keyPem2
      };
      this.leafKeys = forge.pki.rsa.generateKeyPair(2048);
      return;
    }
    const keys2 = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys2.publicKey;
    cert.serialNumber = "00" + randomHex(8);
    cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1e3);
    cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 24 * 3600 * 1e3);
    const attrs = [
      { name: "commonName", value: "MobileLabKit CA" },
      { name: "organizationName", value: "MobileLabKit" }
    ];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.setExtensions([
      { name: "basicConstraints", cA: true },
      { name: "keyUsage", keyCertSign: true, cRLSign: true, digitalSignature: true }
    ]);
    cert.sign(keys2.privateKey, forge.md.sha256.create());
    const certPem = forge.pki.certificateToPem(cert);
    const keyPem = forge.pki.privateKeyToPem(keys2.privateKey);
    node_fs.mkdirSync(node_path.dirname(certPath), { recursive: true });
    node_fs.writeFileSync(certPath, certPem, "utf8");
    node_fs.writeFileSync(keyPath, keyPem, "utf8");
    this.ca = { cert, key: keys2.privateKey, certPem, keyPem };
    this.leafKeys = forge.pki.rsa.generateKeyPair(2048);
  }
  /** A cached TLS SecureContext serving a leaf cert (CN+SAN=host) signed by CA. */
  secureContextFor(host) {
    const cached2 = this.ctxCache.get(host);
    if (cached2) return cached2;
    this.ensureCa();
    const ca = this.ca;
    const leafKeys = this.leafKeys;
    if (!ca || !leafKeys) throw new Error("CA not ready");
    const cert = forge.pki.createCertificate();
    cert.publicKey = leafKeys.publicKey;
    cert.serialNumber = "00" + randomHex(8);
    cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1e3);
    cert.validity.notAfter = new Date(Date.now() + 5 * 365 * 24 * 3600 * 1e3);
    cert.setSubject([{ name: "commonName", value: host }]);
    cert.setIssuer(ca.cert.subject.attributes);
    const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
    cert.setExtensions([
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
      { name: "extKeyUsage", serverAuth: true },
      { name: "subjectAltName", altNames: [isIp ? { type: 7, ip: host } : { type: 2, value: host }] }
    ]);
    cert.sign(ca.key, forge.md.sha256.create());
    const leafPem = forge.pki.certificateToPem(cert);
    const ctx = tls.createSecureContext({
      key: forge.pki.privateKeyToPem(leafKeys.privateKey),
      cert: leafPem + ca.certPem
    });
    this.ctxCache.set(host, ctx);
    return ctx;
  }
  // --- connection handling --------------------------------------------------
  handleClient(socket) {
    socket.setNoDelay(true);
    socket.on("error", () => safeDestroy(socket));
    const reader = new StreamReader(socket);
    reader.readUntil(CRLFCRLF, STREAM_LIMIT).then((head) => {
      if (head.length === 0) {
        safeDestroy(socket);
        return;
      }
      const [startLine, headers] = parseHead(head);
      const parts = startLine.split(" ");
      if (parts.length < 3) {
        safeDestroy(socket);
        return;
      }
      const method = parts[0];
      const target = parts[1];
      if (method.toUpperCase() === "CONNECT") {
        void this.handleConnect(socket, reader, target);
      } else {
        void this.handleHttp(socket, reader, method, target, headers);
      }
    }).catch(() => safeDestroy(socket));
  }
  async handleHttp(socket, reader, method, target, reqHeaders) {
    const [scheme, host, port, path] = splitUrl(target);
    if (!host) {
      safeDestroy(socket);
      return;
    }
    await this.proxyRequest(reader, socket, method, scheme, host, port, path, reqHeaders, false);
  }
  async handleConnect(socket, reader, target) {
    const colon = target.indexOf(":");
    const host = colon >= 0 ? target.slice(0, colon) : target;
    const portStr = colon >= 0 ? target.slice(colon + 1) : "";
    const port = /^\d+$/.test(portStr) ? parseInt(portStr, 10) : 443;
    const ts = Date.now() / 1e3;
    try {
      await writeAsync(socket, Buffer.from("HTTP/1.1 200 Connection Established\r\n\r\n"));
    } catch {
      safeDestroy(socket);
      return;
    }
    const leftover = reader.detach();
    if (leftover.length > 0) socket.unshift(leftover);
    const peek = await peekSocket(socket, 1e4);
    const sni = peek.length > 0 ? parseSni(peek) : null;
    const hostDisplay = sni || host;
    if (this.decrypt && !this.pinnedHosts.has(hostDisplay)) {
      this.decryptConnect(socket, peek, host, port, hostDisplay, ts);
    } else {
      void this.passthroughConnect(socket, peek, host, port, hostDisplay, ts);
    }
  }
  /** TLS-terminate the client, relay decrypted HTTP over an upstream TLS conn. */
  decryptConnect(socket, peek, host, port, hostDisplay, ts) {
    let ctx;
    try {
      ctx = this.secureContextFor(hostDisplay);
    } catch {
      void this.passthroughConnect(socket, peek, host, port, hostDisplay, ts);
      return;
    }
    if (peek.length > 0) socket.unshift(peek);
    let tlsSocket;
    try {
      tlsSocket = new tls.TLSSocket(socket, { isServer: true, secureContext: ctx, ALPNProtocols: ["http/1.1"] });
    } catch {
      safeDestroy(socket);
      return;
    }
    let established = false;
    tlsSocket.once("secure", () => {
      established = true;
    });
    tlsSocket.on("error", () => {
      if (!established) this.pinnedHosts.add(hostDisplay);
      safeDestroy(tlsSocket);
      safeDestroy(socket);
    });
    void this.handleDecrypted(tlsSocket, hostDisplay, port).catch(() => {
      safeDestroy(tlsSocket);
      safeDestroy(socket);
    });
  }
  async handleDecrypted(tlsSocket, host, port) {
    const reader = new StreamReader(tlsSocket);
    const head = await reader.readUntil(CRLFCRLF, STREAM_LIMIT);
    if (head.length === 0) {
      safeDestroy(tlsSocket);
      return;
    }
    const [startLine, reqHeaders] = parseHead(head);
    const parts = startLine.split(" ");
    if (parts.length < 3) {
      safeDestroy(tlsSocket);
      return;
    }
    const method = parts[0];
    const path = parts[1];
    await this.proxyRequest(reader, tlsSocket, method, "https", host, port, path, reqHeaders, true);
  }
  /** Blind byte relay of a CONNECT tunnel; emits a metadata-only flow. */
  async passthroughConnect(socket, peek, host, port, hostDisplay, ts) {
    let upstream;
    try {
      upstream = net.connect({ host, port });
      await onceWithTimeout(upstream, "connect", 15e3);
    } catch (e) {
      this.emitFlow(
        makeFlow({
          method: "CONNECT",
          scheme: "https",
          host: hostDisplay,
          port,
          path: "",
          status: null,
          bodyCaptured: false,
          note: `connect failed: ${e instanceof Error ? e.message : String(e)}`,
          ts
        })
      );
      safeDestroy(socket);
      return;
    }
    let c2s = 0;
    let s2c = 0;
    try {
      if (peek.length > 0) {
        upstream.write(peek);
        c2s += peek.length;
      }
      const results = await Promise.all([pump(socket, upstream), pump(upstream, socket)]);
      c2s += results[0];
      s2c += results[1];
    } finally {
      safeDestroy(upstream);
      safeDestroy(socket);
    }
    this.emitFlow(
      makeFlow({
        method: "CONNECT",
        scheme: "https",
        host: hostDisplay,
        port,
        path: "",
        status: null,
        reqSize: c2s,
        respSize: s2c,
        durationMs: Math.round((Date.now() / 1e3 - ts) * 1e3),
        bodyCaptured: false,
        note: "encrypted — enable Decrypt HTTPS to see contents",
        ts
      })
    );
  }
  /** Shared request/response relay for plain HTTP and decrypted HTTPS. */
  async proxyRequest(clientReader, clientWritable, method, scheme, host, port, path, reqHeaders, upstreamTls) {
    const ts = Date.now() / 1e3;
    let upstream;
    try {
      upstream = upstreamTls ? tls.connect({ host, port, servername: host, ALPNProtocols: ["http/1.1"], rejectUnauthorized: false }) : net.connect({ host, port });
      await onceWithTimeout(upstream, upstreamTls ? "secureConnect" : "connect", 15e3);
    } catch (e) {
      this.emitFlow(
        makeFlow({
          method,
          scheme,
          host,
          port,
          path,
          status: null,
          reqHeaders,
          note: `upstream error: ${e instanceof Error ? e.message : String(e)}`,
          bodyCaptured: false,
          ts
        })
      );
      safeDestroy(clientWritable);
      return;
    }
    upstream.on("error", () => safeDestroy(upstream));
    const upReader = new StreamReader(upstream);
    const out = [`${method} ${path} HTTP/1.1\r
`];
    let haveHost = false;
    for (const [k, v] of reqHeaders) {
      const lk = k.toLowerCase();
      if (lk === "connection" || lk === "proxy-connection" || lk === "keep-alive") continue;
      if (lk === "host") haveHost = true;
      out.push(`${k}: ${v}\r
`);
    }
    if (!haveHost) {
      const defPort = scheme === "https" ? 443 : 80;
      out.push(`Host: ${port === defPort ? host : `${host}:${port}`}\r
`);
    }
    out.push("Connection: close\r\n\r\n");
    await writeAsync(upstream, Buffer.from(out.join(""), "latin1"));
    const req = await relayBody(clientReader, upstream, reqHeaders, MAX_BODY, false);
    const respHead = await upReader.readUntil(CRLFCRLF, STREAM_LIMIT);
    const [respStart, respHeaders] = parseHead(respHead);
    const status2 = parseStatus(respStart);
    const clientHead = [respStart];
    for (const [k, v] of respHeaders) {
      const lk = k.toLowerCase();
      if (lk === "connection" || lk === "proxy-connection" || lk === "keep-alive") continue;
      clientHead.push(`${k}: ${v}`);
    }
    clientHead.push("Connection: close");
    await writeAsync(clientWritable, Buffer.from(clientHead.join("\r\n") + "\r\n\r\n", "latin1"));
    const hasBody = !(status2 === 204 || status2 === 304 || status2 !== null && status2 >= 100 && status2 < 200);
    const resp = await relayBody(upReader, clientWritable, respHeaders, MAX_BODY, hasBody);
    safeDestroy(upstream);
    safeDestroy(clientWritable);
    this.emitFlow(
      makeFlow({
        method,
        scheme,
        host,
        port,
        path,
        status: status2,
        reqHeaders,
        respHeaders,
        reqSize: req.size,
        respSize: resp.size,
        durationMs: Math.round((Date.now() / 1e3 - ts) * 1e3),
        reqBody: req.body.length > 0 ? req.body : null,
        respBody: resp.body.length > 0 ? resp.body : null,
        reqTruncated: req.truncated,
        respTruncated: resp.truncated,
        bodyCaptured: true,
        ts
      })
    );
  }
  // --- flow store + batched emit --------------------------------------------
  emitFlow(f) {
    this.idCounter += 1;
    f.id = this.idCounter;
    this.flows.push(f);
    this.flowMap.set(f.id, f);
    if (this.flows.length > FLOW_CAP) {
      const drop = this.flows.length - FLOW_CAP + TRIM_CHUNK;
      const removed = this.flows.splice(0, drop);
      for (const r of removed) this.flowMap.delete(r.id);
    }
    this.pending.push(toDisplayFlow(f));
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        const batch = this.pending;
        this.pending = [];
        if (batch.length > 0) this.cb.onFlows(batch);
      }, FLOW_FLUSH_MS);
    }
  }
  // --- detail / save / export (by flow id) ----------------------------------
  detail(id) {
    const f = this.flowMap.get(id);
    if (!f) {
      return {
        found: false,
        url: "",
        method: "",
        scheme: "",
        status: null,
        durationMs: null,
        respSize: 0,
        bodyCaptured: false,
        note: "This flow is no longer available (buffer trimmed).",
        reqHeaders: [],
        respHeaders: [],
        reqBody: "",
        respBody: "",
        reqIsJson: false,
        respIsJson: false,
        curl: ""
      };
    }
    const reqBody = prettyBody(f.reqBody, f.reqHeaders);
    const respBody = f.bodyCaptured ? prettyBody(f.respBody, f.respHeaders) : f.note || "encrypted (metadata only)";
    return {
      found: true,
      url: `${f.scheme}://${f.port === 80 || f.port === 443 ? f.host : `${f.host}:${f.port}`}${f.path}`,
      method: f.method,
      scheme: f.scheme,
      status: f.status,
      durationMs: f.durationMs,
      respSize: f.respSize,
      bodyCaptured: f.bodyCaptured,
      note: f.note,
      reqHeaders: f.reqHeaders,
      respHeaders: f.respHeaders,
      reqBody,
      respBody,
      reqIsJson: looksLikeJson(reqBody),
      respIsJson: f.bodyCaptured && looksLikeJson(respBody),
      curl: flowToCurl(f)
    };
  }
  /** Default filename stem for the response body (mirrors _save_body). */
  bodyFileName(id) {
    const f = this.flowMap.get(id);
    if (!f) return "response.bin";
    const last = f.path.replace(/\/+$/, "").split("/").pop() || "response";
    return `${last}.bin`;
  }
  /** Default filename for a full flow export (mirrors _download_flow). */
  exportFileName(id) {
    const f = this.flowMap.get(id);
    if (!f) return "flow.txt";
    const raw = f.host + f.path.split("?")[0];
    let stem = "";
    for (const ch of raw) stem += /[a-zA-Z0-9._-]/.test(ch) ? ch : "_";
    stem = stem.slice(0, 80).replace(/^_+|_+$/g, "") || "flow";
    return `${stem}.txt`;
  }
  saveBody(id, filePath) {
    const f = this.flowMap.get(id);
    if (!f || !f.respBody) return { ok: false, message: "No captured response body", dir: "" };
    try {
      const data = decodeBody(f.respBody, f.respHeaders);
      node_fs.writeFileSync(filePath, Buffer.from(data ?? Buffer.alloc(0)));
    } catch (e) {
      return { ok: false, message: `Save failed: ${e instanceof Error ? e.message : String(e)}`, dir: "" };
    }
    return {
      ok: true,
      message: `Saved ${filePath.split("/").pop()}`,
      dir: node_path.dirname(filePath)
    };
  }
  downloadFlow(id, filePath) {
    const f = this.flowMap.get(id);
    if (!f) return { ok: false, message: "Flow no longer available", dir: "" };
    try {
      node_fs.writeFileSync(filePath, buildFlowExport(f), "utf8");
    } catch (e) {
      return { ok: false, message: `Download failed: ${e instanceof Error ? e.message : String(e)}`, dir: "" };
    }
    return { ok: true, message: `Downloaded ${filePath.split("/").pop()}`, dir: node_path.dirname(filePath) };
  }
  // --- CA cert install ------------------------------------------------------
  certMarkerPath(serial) {
    const safe = (serial || "device").replace(/[^a-zA-Z0-9]/g, "_");
    return node_path.join(this.caDir(), `.cert-${safe}`);
  }
  maybePromptCert(serial) {
    if (serial && !node_fs.existsSync(this.certMarkerPath(serial))) {
      void this.installCert(serial);
    } else {
      this.cb.onStatus("Decrypting HTTPS — CA cert already set up (click Install CA Cert if bodies do not appear)");
    }
  }
  /** Deliver the CA to the device via its wiring (per platform), remembering the
   *  device so decrypt sessions don't re-nag. */
  async installCert(serial) {
    if (!serial) return { ok: false, message: "Select a device first", dir: "" };
    const wiring = this.wiring && this.wiring.serial === serial ? this.wiring : this.wiringFor(serial);
    if (!wiring) return { ok: false, message: "No adb / go-ios backend for this device", dir: "" };
    let ca;
    try {
      ca = this.caMaterial();
    } catch (e) {
      return { ok: false, message: `Couldn't generate the CA cert: ${e instanceof Error ? e.message : String(e)}`, dir: "" };
    }
    const r = await wiring.installCert(ca);
    if (r.ok) {
      try {
        node_fs.mkdirSync(this.caDir(), { recursive: true });
        node_fs.writeFileSync(this.certMarkerPath(serial), "installed\n", "utf8");
      } catch {
      }
    }
    return r;
  }
  /** The host CA as paths + PEM + base64 DER (for whichever delivery a wiring uses). */
  caMaterial() {
    this.ensureCa();
    const ca = this.ca;
    if (!ca) throw new Error("CA not ready");
    const der = forge.asn1.toDer(forge.pki.certificateToAsn1(ca.cert)).getBytes();
    return { certPath: this.caCertPath(), certPem: ca.certPem, certDerBase64: forge.util.encode64(der) };
  }
}
class AndroidWiring {
  constructor(adb, serial, cb) {
    this.adb = adb;
    this.serial = serial;
    this.cb = cb;
  }
  bindHost = "127.0.0.1";
  autoInstallCertOnStart = true;
  origProxy = "";
  port = DEFAULT_PORT;
  watchdog = null;
  async wire(port) {
    this.port = port;
    this.origProxy = (await run$3(this.adb, null, getProxyArgs(this.serial), 8e3)).stdout.trim();
    const rev = await run$3(this.adb, null, reverseArgs(this.serial, port), 8e3);
    if (rev.code !== 0) {
      const msg = (rev.stderr || rev.stdout || "").trim().split("\n").filter(Boolean).pop();
      return { ok: false, message: "adb reverse failed: " + (msg || "needs Android 5+ / a connected device") };
    }
    await run$3(this.adb, null, setProxyArgs(this.serial, port), 8e3);
    this.startWatchdog();
    return { ok: true, message: "" };
  }
  unwire() {
    this.stopWatchdog();
    for (const args of [restoreProxyArgs(this.serial, this.origProxy), reverseRemoveArgs(this.serial, this.port)]) {
      void run$3(this.adb, null, args, 5e3).catch(() => {
      });
    }
  }
  async installCert(ca) {
    for (const name of ["androidlab-ca.cer", "androidlab-ca.crt"]) {
      const r = await run$3(this.adb, null, ["-s", this.serial, "push", ca.certPath, `/sdcard/Download/${name}`], 2e4);
      if (r.code !== 0) {
        const blob = (r.stderr || r.stdout || "").trim().split("\n").filter(Boolean).pop();
        return { ok: false, message: "adb push failed: " + (blob || "unknown"), dir: "" };
      }
    }
    void run$3(this.adb, this.serial, ["shell", "input", "keyevent", "KEYCODE_WAKEUP"], 6e3).catch(() => {
    });
    void run$3(this.adb, this.serial, ["shell", "am", "start", "-a", "android.settings.SECURITY_SETTINGS"], 8e3).catch(
      () => {
      }
    );
    return {
      ok: true,
      message: "Pushed androidlab-ca.cer to the device Download folder — install it as a user CA in Settings",
      dir: "/sdcard/Download"
    };
  }
  startWatchdog() {
    this.stopWatchdog();
    if (!this.adb || !this.serial) return;
    const wd = node_child_process.spawn(this.adb, ["-s", this.serial, "shell", proxyWatchdogScript(this.origProxy)]);
    wd.on("close", () => {
      if (this.watchdog === wd) {
        this.watchdog = null;
        this.cb.onStatus("Device disconnected — intercept stopped; device proxy restored on-device");
        this.cb.onDisconnect();
      }
    });
    wd.on("error", () => {
    });
    this.watchdog = wd;
  }
  stopWatchdog() {
    const wd = this.watchdog;
    this.watchdog = null;
    if (!wd) return;
    wd.removeAllListeners("close");
    try {
      wd.stdin.write("\n");
      wd.stdin.end();
    } catch {
    }
    const killTimer = setTimeout(() => {
      try {
        wd.kill("SIGKILL");
      } catch {
      }
    }, 1500);
    wd.on("close", () => clearTimeout(killTimer));
  }
}
function randomHex(nBytes) {
  let s = "";
  for (let i = 0; i < nBytes; i++) s += Math.floor(Math.random() * 256).toString(16).padStart(2, "0");
  return s;
}
function looksLikeJson(text2) {
  const t = (text2 || "").trim();
  if (!t || t[0] !== "{" && t[0] !== "[") return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}
function runGoIos(bin, args, timeoutMs = 3e4) {
  return new Promise((resolve) => {
    node_child_process.execFile(bin, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      resolve({
        stdout: stdout ?? "",
        stderr: stderr ?? "",
        code: err && typeof err.code === "number" ? err.code : err ? 1 : 0
      });
    });
  });
}
function lastLine(stderr, stdout, fallback) {
  const out = (stderr || stdout || "").trim();
  if (!out) return fallback;
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? fallback;
}
function hostLanIp() {
  const ifaces = node_os.networkInterfaces();
  const prefer = ifaces["en0"] ? ["en0"] : [];
  const order = [...prefer, ...Object.keys(ifaces).filter((k) => k !== "en0")];
  for (const name of order) {
    for (const i of ifaces[name] ?? []) {
      if (i.family === "IPv4" && !i.internal) return i.address;
    }
  }
  return "";
}
const PROXY_STEPS = (hostPort) => `Set the iPhone's Wi-Fi proxy to ${hostPort} — Settings ▸ Wi-Fi ▸ (i) ▸ Configure Proxy ▸ Manual.`;
class IosWiring {
  // the CA needs manual approve + trust
  // The go-ios wiring never needs to push status or signal a drop (no watchdog,
  // no live proxy state), so it ignores the WiringCallbacks AndroidWiring uses —
  // the ctor still accepts them so the wiringFor factory builds both the same way.
  constructor(bin, serial, _cb) {
    this.bin = bin;
    this.serial = serial;
  }
  bindHost = "0.0.0.0";
  // reachable from the iPhone over the LAN
  autoInstallCertOnStart = false;
  async wire(port) {
    const ip = hostLanIp();
    if (!ip) {
      return {
        ok: true,
        message: `Connect the iPhone to the same Wi-Fi as this Mac, then set its Wi-Fi proxy to this Mac's IP : ${port}.`
      };
    }
    return { ok: true, message: PROXY_STEPS(`${ip}:${port}`) };
  }
  /** No programmatic proxy to undo (it's a manual Wi-Fi setting). The CA profile
   *  is left installed on purpose so future sessions don't re-prompt. */
  unwire() {
  }
  async installCert(ca) {
    const dir = node_fs.mkdtempSync(node_path.join(node_os.tmpdir(), "androidlab-ca-"));
    const file = node_path.join(dir, "androidlabkit-ca.mobileconfig");
    try {
      node_fs.writeFileSync(file, caMobileconfig(ca.certDerBase64), "utf8");
      const r = await runGoIos(this.bin, profileAddArgs(this.serial, file), 3e4);
      if (r.code !== 0) {
        return { ok: false, message: `Couldn't send the CA profile: ${lastLine(r.stderr, r.stdout, "profile add failed")}`, dir: "" };
      }
      return {
        ok: true,
        message: `Sent the ${CA_PROFILE_NAME} profile — on the iPhone: approve it (Settings ▸ General ▸ VPN & Device Management), then TRUST it (Settings ▸ General ▸ About ▸ Certificate Trust Settings).`,
        dir: ""
      };
    } catch (e) {
      return { ok: false, message: `Couldn't build the CA profile: ${e instanceof Error ? e.message : String(e)}`, dir: "" };
    } finally {
      try {
        node_fs.rmSync(dir, { recursive: true, force: true });
      } catch {
      }
    }
  }
}
async function installApks(adb, serial, paths) {
  const apks = paths.filter((p) => p.toLowerCase().endsWith(".apk"));
  if (apks.length === 0) {
    return { ok: false, message: "No .apk files selected", output: "", names: "" };
  }
  const names = apks.map((p) => node_path.basename(p)).join(", ");
  const verb = apks.length === 1 ? "install" : "install-multiple";
  const r = await run$3(adb, serial, [verb, "-r", "-d", ...apks], 18e4);
  const out = (r.stdout + "\n" + r.stderr).trim();
  if (r.code === 0 && out.includes("Success")) {
    return { ok: true, message: `Installed ${names}`, output: out, names };
  }
  const reason = out.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? `adb exited with code ${r.code}`;
  return { ok: false, message: `Install failed: ${reason}`, output: out, names };
}
const API = "https://api.appledb.dev/device";
const IMG = "https://img.appledb.dev/device@256";
function cacheDir() {
  const dir = node_path.join(electron.app.getPath("userData"), "ios-device-images");
  node_fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function toDataUri(buf) {
  return `data:image/png;base64,${buf.toString("base64")}`;
}
async function deviceImage(identifier) {
  const empty = { front: null, colorHex: null, colorName: null };
  if (!identifier || !/^[A-Za-z0-9,.\-_]+$/.test(identifier)) return empty;
  const dir = cacheDir();
  const pngFile = node_path.join(dir, `${identifier}.png`);
  const colorFile = node_path.join(dir, `${identifier}.color.json`);
  let front = null;
  let colorHex = null;
  let colorName = null;
  if (node_fs.existsSync(colorFile)) {
    try {
      const m = JSON.parse(node_fs.readFileSync(colorFile, "utf8"));
      colorHex = typeof m.colorHex === "string" ? m.colorHex : null;
      colorName = typeof m.colorName === "string" ? m.colorName : null;
    } catch {
    }
  }
  if (node_fs.existsSync(pngFile)) {
    try {
      front = toDataUri(node_fs.readFileSync(pngFile));
    } catch {
    }
  }
  if (front && colorHex !== null) return { front, colorHex, colorName };
  try {
    const metaRes = await fetch(`${API}/${encodeURIComponent(identifier)}.json`, {
      signal: AbortSignal.timeout(8e3)
    });
    if (!metaRes.ok) return { front, colorHex, colorName };
    const meta = await metaRes.json();
    const c0 = meta.colors?.[0];
    const color = c0?.key ?? c0?.name ?? null;
    colorHex = c0?.hex ?? colorHex;
    colorName = c0?.name ?? c0?.key ?? colorName;
    if (colorHex !== null || colorName !== null) {
      try {
        node_fs.writeFileSync(colorFile, JSON.stringify({ colorHex, colorName }));
      } catch {
      }
    }
    if (!front && color) {
      const key2 = meta.imageKey ?? identifier;
      const imgRes = await fetch(`${IMG}/${encodeURIComponent(key2)}/${encodeURIComponent(color)}.png`, {
        signal: AbortSignal.timeout(8e3)
      });
      if (imgRes.ok) {
        const buf = Buffer.from(await imgRes.arrayBuffer());
        if (buf.length > 0) {
          try {
            node_fs.writeFileSync(pngFile, buf);
          } catch {
          }
          front = toDataUri(buf);
        }
      }
    }
    return { front, colorHex, colorName };
  } catch {
    return { front, colorHex, colorName };
  }
}
async function openLog(win) {
  const res = await electron.dialog.showOpenDialog(win, {
    title: "Open a saved logcat file",
    defaultPath: node_path.join(node_os.homedir(), "Downloads"),
    properties: ["openFile"],
    filters: [
      { name: "Log files", extensions: ["txt", "log"] },
      { name: "All files", extensions: ["*"] }
    ]
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  const path = res.filePaths[0];
  const content = node_fs.readFileSync(path, "utf8");
  return { path, content };
}
function timestamp() {
  const d = /* @__PURE__ */ new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
async function exportLog(win, kind, text2, lineCount) {
  const defaultPath = node_path.join(node_os.homedir(), "Downloads", `logcat-${kind}-${timestamp()}.txt`);
  const res = await electron.dialog.showSaveDialog(win, {
    title: `Export ${kind} log (${lineCount.toLocaleString()} lines)`,
    defaultPath,
    filters: [{ name: "Log files", extensions: ["txt", "log"] }]
  });
  if (res.canceled || !res.filePath) {
    return { ok: false, message: "cancelled", dir: "" };
  }
  try {
    node_fs.writeFileSync(res.filePath, text2, "utf8");
  } catch (exc) {
    return { ok: false, message: `Export failed: ${exc instanceof Error ? exc.message : exc}`, dir: "" };
  }
  const base = res.filePath.split("/").pop() ?? res.filePath;
  return {
    ok: true,
    message: `${lineCount.toLocaleString()} lines → ${base}`,
    dir: node_path.dirname(res.filePath)
  };
}
const PRESETS_FILE = "filter_presets.json";
function presetsPath() {
  return node_path.join(electron.app.getPath("userData"), PRESETS_FILE);
}
function loadPresets() {
  try {
    const data = JSON.parse(node_fs.readFileSync(presetsPath(), "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}
function savePresets(presets) {
  const path = presetsPath();
  try {
    node_fs.mkdirSync(node_path.dirname(path), { recursive: true });
    const sorted = {};
    for (const k of Object.keys(presets).sort()) sorted[k] = presets[k];
    node_fs.writeFileSync(path, JSON.stringify(sorted, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}
function registerIpc(getWindow2) {
  let reader = null;
  let monitor = null;
  let leak = null;
  let db = null;
  let iosDb = null;
  let files = null;
  let toolbox = null;
  let prefs = null;
  let crash = null;
  let appmgr = null;
  let mockloc = null;
  let mirrorSvc = null;
  let iosMirrorSvc = null;
  let iosAirplaySvc = null;
  const shellSessions = /* @__PURE__ */ new Map();
  let intercept = null;
  let lastDevices = [];
  const isIos = (serial) => lastDevices.some((d) => d.serial === serial && d.platform === "ios");
  const send = (channel, ...args) => {
    const win = getWindow2();
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
  };
  const broadcast = (channel, ...args) => {
    for (const w of electron.BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(channel, ...args);
    }
  };
  const mirrorWin = new MirrorWindowManager(() => send(IPC.mirrorPopoutClosed));
  const ensureReader = (adb) => {
    if (!reader) {
      reader = new LogcatReader(adb, {
        onLines: (lines) => send(IPC.logcatLines, lines),
        onState: (state) => send(IPC.logcatState, state),
        onError: (message) => send(IPC.logcatError, message)
      });
    }
    return reader;
  };
  electron.ipcMain.handle(IPC.adbFind, () => ({ path: findAdb() }));
  const wifiReady = /* @__PURE__ */ new Set();
  const autoEnableWifi = (bin, devices) => {
    const s = loadSettings();
    if (!s.autoWifi) return;
    for (const d of devices) {
      if (d.platform !== "ios" || !d.transports.includes("usb")) continue;
      if (wifiReady.has(d.serial) || s.wifiOptOut.includes(d.serial)) continue;
      void wifiConnections(bin, d.serial, "enable").then((r) => {
        if (r.ok) {
          wifiReady.add(d.serial);
          console.error(`[wifi] auto-enabled Wi-Fi connections for ${d.serial}`);
        }
      }).catch(() => {
      });
    }
  };
  const buildDeviceList = async () => {
    const adb = findAdb();
    const android = adb ? await listDevices$1(adb) : [];
    const iosBin = findGoIos();
    const ios = iosBin ? await listDevices(iosBin).catch(() => []) : [];
    if (iosBin) {
      autoEnableWifi(iosBin, ios);
      if (ios.length > 0 && loadSettings().autoTunnel) {
        void ensureAgentRunning(iosBin).catch(() => {
        });
      }
    }
    return [...android, ...ios];
  };
  electron.ipcMain.handle(IPC.adbListDevices, async () => {
    lastDevices = await buildDeviceList();
    return lastDevices;
  });
  const deviceSig = (list2) => list2.map((d) => `${d.serial}:${d.state}:${d.online}`).sort().join("|");
  let building = false;
  let pending2 = false;
  const rebuildDevices = async () => {
    if (building) {
      pending2 = true;
      return;
    }
    building = true;
    try {
      do {
        pending2 = false;
        const list2 = await buildDeviceList();
        if (deviceSig(list2) !== deviceSig(lastDevices)) {
          lastDevices = list2;
          send(IPC.devicesChanged, list2);
        }
      } while (pending2);
    } finally {
      building = false;
    }
  };
  const deviceWatcher = new DeviceWatcher({
    findAdb,
    findGoIos,
    onChange: () => void rebuildDevices()
  });
  deviceWatcher.start();
  electron.ipcMain.handle(IPC.adbListApps, async (_e, serial) => {
    const adb = findAdb();
    if (!adb || !serial) return { apps: [] };
    return { apps: await listApps$1(adb, serial) };
  });
  electron.ipcMain.handle(IPC.adbResolvePids, async (_e, serial, pkg) => {
    const adb = findAdb();
    if (!adb || !serial || !pkg) return [];
    return await resolvePids(adb, serial, pkg);
  });
  electron.ipcMain.handle(IPC.adbForceCrash, async (_e, serial, pkg, pids) => {
    const adb = findAdb();
    if (!adb || !serial) return [];
    return await forceCrash(adb, serial, pkg, pids);
  });
  electron.ipcMain.handle(IPC.adbDeviceInfo, async (_e, serial) => {
    const adb = findAdb();
    if (!adb || !serial) return null;
    return await readDeviceInfo(adb, serial);
  });
  electron.ipcMain.handle(IPC.logcatStart, (_e, serial, clearFirst) => {
    if (!serial) return false;
    if (isIos(serial)) {
      const bin = findGoIos();
      if (!bin) return false;
      return syslogStart(
        bin,
        serial,
        (lines) => send(IPC.logcatLines, lines),
        (s) => send(IPC.logcatState, s)
      );
    }
    const adb = findAdb();
    if (!adb) return false;
    ensureReader(adb).start(serial, clearFirst);
    return true;
  });
  electron.ipcMain.handle(IPC.logcatStop, () => {
    reader?.stop();
    syslogStop();
    return true;
  });
  electron.ipcMain.handle(IPC.logcatRunning, () => (reader?.running ?? false) || syslogRunning());
  const ensureShell = (id, adb) => {
    let s = shellSessions.get(id);
    if (!s) {
      s = new ShellSession(adb, {
        onData: (text2) => send(IPC.shellData, id, text2),
        onState: (state) => send(IPC.shellState, id, state)
      });
      shellSessions.set(id, s);
    }
    return s;
  };
  electron.ipcMain.handle(
    IPC.shellStart,
    (_e, id, kind, serial, cols, rows) => {
      const adb = findAdb();
      if (kind === "device" && (!adb || !serial)) return false;
      ensureShell(id, adb ?? "").start(kind, serial, cols, rows);
      return true;
    }
  );
  electron.ipcMain.handle(IPC.shellWrite, (_e, id, data) => {
    shellSessions.get(id)?.write(data);
    return true;
  });
  electron.ipcMain.handle(IPC.shellResize, (_e, id, cols, rows) => {
    shellSessions.get(id)?.resize(cols, rows);
    return true;
  });
  electron.ipcMain.handle(IPC.shellStop, (_e, id) => {
    const s = shellSessions.get(id);
    if (s) {
      s.stop();
      shellSessions.delete(id);
    }
    return true;
  });
  electron.ipcMain.handle(IPC.shellRunning, (_e, id) => shellSessions.get(id)?.running ?? false);
  const ensureMonitor = (adb) => {
    if (!monitor) {
      monitor = new MonitorService(adb, {
        onSample: (sample) => send(IPC.monitorSample, sample),
        onFailed: (message) => send(IPC.monitorFailed, message)
      });
    }
    return monitor;
  };
  electron.ipcMain.handle(
    IPC.monitorStart,
    (_e, serial, pkg, intervalMs) => {
      if (!serial) return false;
      if (isIos(serial)) {
        const bin = findGoIos();
        if (!bin) return false;
        void monitorStart(
          bin,
          serial,
          intervalMs,
          (s) => send(IPC.monitorSample, s),
          (m) => send(IPC.monitorFailed, m)
        );
        return true;
      }
      const adb = findAdb();
      if (!adb) return false;
      ensureMonitor(adb).start(serial, pkg, intervalMs);
      return true;
    }
  );
  electron.ipcMain.handle(IPC.monitorStop, () => {
    monitor?.stop();
    monitorStop();
    return true;
  });
  const ensureLeak = (adb) => {
    if (!leak) {
      leak = new LeakDetectService(adb, {
        onProgress: (message) => send(IPC.leakProgress, message),
        onDone: (ok, report, hprofPath, pkg) => send(IPC.leakDone, { ok, report, hprofPath, pkg })
      });
    }
    return leak;
  };
  electron.ipcMain.handle(IPC.leakStart, (_e, serial, pkg) => {
    const adb = findAdb();
    if (!adb || !serial || !pkg) return false;
    return ensureLeak(adb).start(serial, pkg);
  });
  electron.ipcMain.handle(IPC.leakCancel, () => {
    leak?.cancel();
    return true;
  });
  electron.ipcMain.handle(IPC.leakSaveReport, async (_e, html, pkg) => {
    const win = getWindow2();
    if (!win) return { ok: false, message: "no window", dir: "" };
    const safe = (pkg || "app").replace(/[^a-zA-Z0-9._-]/g, "_");
    const res = await electron.dialog.showSaveDialog(win, {
      title: "Save leak report",
      defaultPath: node_path.join(node_os.homedir(), "Downloads", `leak-report-${safe}.html`),
      filters: [
        { name: "HTML", extensions: ["html"] },
        { name: "All files", extensions: ["*"] }
      ]
    });
    if (res.canceled || !res.filePath) return { ok: false, message: "cancelled", dir: "" };
    try {
      node_fs.writeFileSync(res.filePath, html, "utf8");
    } catch (e) {
      return { ok: false, message: `Couldn't save: ${e instanceof Error ? e.message : String(e)}`, dir: "" };
    }
    return { ok: true, message: `Leak report saved to ${res.filePath.split("/").pop()}`, dir: node_path.dirname(res.filePath) };
  });
  electron.ipcMain.handle(IPC.inspectCapture, async (_e, serial) => {
    const adb = findAdb();
    if (!adb || !serial) {
      return { ok: false, message: "no device selected", pngBase64: "", xml: "" };
    }
    return await captureInspect(adb, serial);
  });
  const ensureMirror = (adb) => {
    if (!mirrorSvc) {
      mirrorSvc = new MirrorService(adb, {
        onFrame: (base64) => broadcast(IPC.mirrorFrame, base64),
        onH264: (chunk) => broadcast(IPC.mirrorH264, chunk),
        onControlReady: (ready) => broadcast(IPC.mirrorControlReady, ready),
        onFailed: (kind, message) => broadcast(IPC.mirrorFailed, { kind, message })
      });
      mirrorSvc.onRecordDone((result) => broadcast(IPC.mirrorRecordDone, result));
    }
    return mirrorSvc;
  };
  electron.ipcMain.handle(IPC.mirrorStartH264, (_e, serial) => {
    const adb = findAdb();
    if (!adb || !serial) return false;
    ensureMirror(adb).startH264(serial);
    return true;
  });
  electron.ipcMain.handle(IPC.mirrorStartScrcpy, (_e, serial) => {
    const adb = findAdb();
    if (!adb || !serial) return false;
    ensureMirror(adb).startScrcpy(serial);
    return true;
  });
  electron.ipcMain.handle(IPC.mirrorStartPoller, (_e, serial, displayId) => {
    const adb = findAdb();
    if (!adb || !serial) return false;
    ensureMirror(adb).startPoller(serial, displayId);
    return true;
  });
  electron.ipcMain.handle(IPC.mirrorStop, (_e, immediate) => {
    mirrorSvc?.stopFeed(immediate);
    return true;
  });
  electron.ipcMain.handle(IPC.mirrorInput, (_e, serial, logicalId, args) => {
    const adb = findAdb();
    if (adb && serial) ensureMirror(adb).input(serial, logicalId, args);
  });
  electron.ipcMain.handle(IPC.mirrorControl, (_e, data) => {
    mirrorSvc?.control(data);
  });
  electron.ipcMain.handle(
    IPC.mirrorScreenshot,
    async (_e, serial, displayId, logicalId) => {
      const adb = findAdb();
      if (!adb || !serial) return { ok: false, message: "Mirror not connected", dir: "" };
      return await ensureMirror(adb).screenshot(serial, displayId, logicalId);
    }
  );
  electron.ipcMain.handle(IPC.mirrorRecordStart, (_e, serial) => {
    const adb = findAdb();
    if (!adb || !serial) return false;
    return ensureMirror(adb).startRecord(serial);
  });
  electron.ipcMain.handle(IPC.mirrorRecordStop, () => mirrorSvc?.stopRecord() ?? false);
  electron.ipcMain.handle(IPC.mirrorListDisplays, async (_e, serial) => {
    const adb = findAdb();
    if (!adb || !serial) return [];
    return await ensureMirror(adb).listDisplays(serial);
  });
  electron.ipcMain.handle(IPC.mirrorIsEmulator, async (_e, serial) => {
    const adb = findAdb();
    if (!adb || !serial) return false;
    return await ensureMirror(adb).isEmulator(serial);
  });
  electron.ipcMain.handle(IPC.mirrorScrcpyAvailable, () => {
    const adb = findAdb();
    return adb ? ensureMirror(adb).scrcpyPath() !== null : false;
  });
  electron.ipcMain.handle(IPC.mirrorLaunchScrcpy, (_e, serial, logicalId) => {
    const adb = findAdb();
    if (adb && serial) ensureMirror(adb).launchScrcpy(serial, logicalId);
  });
  electron.ipcMain.handle(IPC.mirrorPopoutOpen, (_e, info) => mirrorWin.open(info));
  electron.ipcMain.handle(IPC.mirrorPopoutClose, (_e, redock) => mirrorWin.close(redock));
  electron.ipcMain.handle(IPC.mirrorPopoutUpdate, (_e, info) => mirrorWin.update(info));
  electron.ipcMain.handle(IPC.mirrorPopoutInfo, () => mirrorWin.getInfo());
  electron.ipcMain.handle(IPC.mirrorPopoutFullscreen, () => mirrorWin.toggleFullScreen());
  electron.ipcMain.handle(IPC.controlsRead, async (_e, serial, pkg) => {
    const adb = findAdb();
    if (!adb || !serial) return { ok: false, message: "no device selected", state: null };
    return await readControlsState(adb, serial, pkg);
  });
  electron.ipcMain.handle(
    IPC.controlsApply,
    async (_e, serial, argvs, label) => {
      const adb = findAdb();
      if (!adb || !serial) return { ok: false, message: "no device selected" };
      return await applyControls(adb, serial, argvs, label);
    }
  );
  electron.ipcMain.handle(IPC.wirelessEnable, async (_e, serial) => {
    const adb = findAdb();
    if (!adb || !serial) return { ok: false, message: "no device selected" };
    return await enableWirelessDebug(adb, serial);
  });
  electron.ipcMain.handle(IPC.wirelessIosGet, async (_e, udid) => {
    const bin = findGoIos();
    if (!bin || !udid) return { ok: false, enabled: false, message: "no device selected" };
    return await wifiConnections(bin, udid, "get");
  });
  electron.ipcMain.handle(IPC.wirelessIosSet, async (_e, udid, enabled) => {
    const bin = findGoIos();
    if (!bin || !udid) return { ok: false, enabled: false, message: "no device selected" };
    const r = await wifiConnections(bin, udid, enabled ? "enable" : "disable");
    if (r.ok) {
      const s = loadSettings();
      const optOut = new Set(s.wifiOptOut);
      if (enabled) {
        optOut.delete(udid);
        wifiReady.add(udid);
      } else {
        optOut.add(udid);
        wifiReady.delete(udid);
      }
      saveSettings({ wifiOptOut: [...optOut] });
    }
    return r;
  });
  electron.ipcMain.handle(IPC.settingsGet, () => loadSettings());
  electron.ipcMain.handle(IPC.settingsSet, (_e, patch) => saveSettings(patch));
  const ensureMockloc = (adb) => {
    if (!mockloc) mockloc = new MockLocationService(adb);
    return mockloc;
  };
  electron.ipcMain.handle(IPC.mocklocSetup, async (_e, serial) => {
    if (!serial) return { ok: false, message: "No device selected" };
    if (isIos(serial)) {
      const bin = findGoIos();
      return bin ? await mockSetup(bin, serial) : { ok: false, message: "go-ios not found" };
    }
    const adb = findAdb();
    if (!adb) return { ok: false, message: "No device selected" };
    return await ensureMockloc(adb).setup(serial);
  });
  electron.ipcMain.handle(
    IPC.mocklocSet,
    async (_e, serial, lat, lng, acc, alt) => {
      if (!serial) return { ok: false, message: "No device selected" };
      if (isIos(serial)) {
        const bin = findGoIos();
        return bin ? await setLocation(bin, serial, lat, lng) : { ok: false, message: "go-ios not found" };
      }
      const adb = findAdb();
      if (!adb) return { ok: false, message: "No device selected" };
      return await ensureMockloc(adb).set(serial, lat, lng, acc ?? null, alt ?? null);
    }
  );
  electron.ipcMain.handle(IPC.mocklocStop, async (_e, serial) => {
    if (!serial) return { ok: false, message: "No device selected" };
    if (isIos(serial)) {
      const bin = findGoIos();
      return bin ? await resetLocation() : { ok: false, message: "go-ios not found" };
    }
    const adb = findAdb();
    if (!adb) return { ok: false, message: "No device selected" };
    return await ensureMockloc(adb).stop(serial);
  });
  const ensureDb = (adb) => {
    if (!db) db = new DbService(adb);
    return db;
  };
  const iosDbFor = (serial) => {
    if (!isIos(serial)) return null;
    const bin = findGoIos();
    if (!bin) return null;
    if (!iosDb) iosDb = new IosDbService(bin);
    return iosDb;
  };
  electron.ipcMain.handle(IPC.dbList, async (_e, serial, pkg) => {
    if (!serial || !pkg) {
      return { ok: false, dbs: [], message: "no device / app selected", usedSu: false, hasSqlite3: false };
    }
    const ios = iosDbFor(serial);
    if (ios) return await ios.list(serial, pkg);
    const adb = findAdb();
    if (!adb) return { ok: false, dbs: [], message: "no device / app selected", usedSu: false, hasSqlite3: false };
    return await ensureDb(adb).list(serial, pkg);
  });
  electron.ipcMain.handle(IPC.dbOpen, async (_e, serial, pkg, name, force) => {
    if (!serial || !pkg) return { ok: false, name, tables: [], message: "no device / app selected" };
    const ios = iosDbFor(serial);
    if (ios) return await ios.open(serial, pkg, name, force);
    const adb = findAdb();
    if (!adb) return { ok: false, name, tables: [], message: "no device / app selected" };
    return await ensureDb(adb).open(serial, pkg, name, force);
  });
  electron.ipcMain.handle(
    IPC.dbReadTable,
    async (_e, serial, pkg, name, table, limit, offset) => {
      if (!serial || !pkg) {
        return { ok: false, cols: [], rows: [], total: -1, truncated: false, rowids: null, message: "no device" };
      }
      const ios = iosDbFor(serial);
      if (ios) return await ios.readTable(serial, pkg, name, table, limit, offset);
      const adb = findAdb();
      if (!adb) {
        return { ok: false, cols: [], rows: [], total: -1, truncated: false, rowids: null, message: "no device" };
      }
      return await ensureDb(adb).readTable(serial, pkg, name, table, limit, offset);
    }
  );
  electron.ipcMain.handle(IPC.dbQuery, async (_e, serial, pkg, name, sql) => {
    if (!serial || !pkg) {
      return { ok: false, cols: [], rows: [], total: -1, truncated: false, rowids: null, message: "no device" };
    }
    const ios = iosDbFor(serial);
    if (ios) return await ios.runQuery(serial, pkg, name, sql);
    const adb = findAdb();
    if (!adb) {
      return { ok: false, cols: [], rows: [], total: -1, truncated: false, rowids: null, message: "no device" };
    }
    return await ensureDb(adb).runQuery(serial, pkg, name, sql);
  });
  electron.ipcMain.handle(
    IPC.dbEdit,
    async (_e, serial, pkg, name, table, col, rowid, value, setNull) => {
      if (!serial || !pkg) return { ok: false, message: "no device / app selected" };
      if (isIos(serial)) return { ok: false, message: "Editing iOS databases is not supported yet (read-only)." };
      const adb = findAdb();
      if (!adb) return { ok: false, message: "no device / app selected" };
      return await ensureDb(adb).edit(serial, pkg, name, table, col, rowid, value, setNull);
    }
  );
  electron.ipcMain.handle(IPC.dbExport, async (_e, serial, pkg, name, suggested) => {
    const win = getWindow2();
    if (!serial || !pkg || !win) return { ok: false, message: "no device / app selected", dir: "" };
    const res = await electron.dialog.showSaveDialog(win, {
      title: `Export '${name}' as a .db file`,
      defaultPath: node_path.join(node_os.homedir(), "Downloads", suggested),
      filters: [
        { name: "SQLite database", extensions: ["db"] },
        { name: "All files", extensions: ["*"] }
      ]
    });
    if (res.canceled || !res.filePath) return { ok: false, message: "cancelled", dir: "" };
    const ios = iosDbFor(serial);
    if (ios) return await ios.exportDb(serial, pkg, name, res.filePath);
    const adb = findAdb();
    if (!adb) return { ok: false, message: "no device / app selected", dir: "" };
    return await ensureDb(adb).exportDb(serial, pkg, name, res.filePath);
  });
  electron.ipcMain.handle(IPC.dbExportCsv, async (_e, text2, suggested, rowCount) => {
    const adb = findAdb();
    const win = getWindow2();
    if (!win) return { ok: false, message: "no window", dir: "" };
    const res = await electron.dialog.showSaveDialog(win, {
      title: "Export results as CSV",
      defaultPath: node_path.join(node_os.homedir(), "Downloads", suggested),
      filters: [
        { name: "CSV files", extensions: ["csv"] },
        { name: "All files", extensions: ["*"] }
      ]
    });
    if (res.canceled || !res.filePath) return { ok: false, message: "cancelled", dir: "" };
    return ensureDb(adb ?? "").saveCsv(text2, res.filePath, rowCount);
  });
  const ensureFiles = (adb) => {
    if (!files) files = new FilesService(adb);
    return files;
  };
  const iosFilesBin = (serial) => isIos(serial) ? findGoIos() : null;
  const IOS_FILES_READONLY = "iOS containers are read-only here — upload/new-folder/rename/delete aren’t supported yet.";
  electron.ipcMain.handle(IPC.filesList, async (_e, serial, path, pkg, rootMode) => {
    if (!serial) return { ok: false, path, entries: [], error: "No device selected", usedSu: false };
    const bin = iosFilesBin(serial);
    if (bin) {
      if (!pkg) return { ok: false, path, entries: [], error: "Select an app to browse its container", usedSu: false };
      return await list(bin, serial, pkg, path);
    }
    const adb = findAdb();
    if (!adb) return { ok: false, path, entries: [], error: "No device selected", usedSu: false };
    return await ensureFiles(adb).listDir(serial, path, pkg, rootMode);
  });
  electron.ipcMain.handle(
    IPC.filesPull,
    async (_e, serial, path, pkg, rootMode, items, destDir) => {
      if (!serial) return { ok: false, message: "No device selected", dir: "" };
      const bin = iosFilesBin(serial);
      if (bin) {
        if (!pkg) return { ok: false, message: "Select an app to browse its container", dir: "" };
        return await pull(bin, serial, pkg, path, items, destDir);
      }
      const adb = findAdb();
      if (!adb) return { ok: false, message: "No device selected", dir: "" };
      return await ensureFiles(adb).pull(serial, path, pkg, rootMode, items, destDir);
    }
  );
  electron.ipcMain.handle(
    IPC.filesPush,
    async (_e, serial, path, pkg, rootMode, sources) => {
      if (isIos(serial)) return { ok: false, message: IOS_FILES_READONLY, dir: "" };
      const adb = findAdb();
      if (!adb || !serial) return { ok: false, message: "No device selected", dir: "" };
      return await ensureFiles(adb).push(serial, path, pkg, rootMode, sources);
    }
  );
  electron.ipcMain.handle(
    IPC.filesMkdir,
    async (_e, serial, path, pkg, rootMode, name) => {
      if (isIos(serial)) return { ok: false, message: IOS_FILES_READONLY };
      const adb = findAdb();
      if (!adb || !serial) return { ok: false, message: "No device selected" };
      return await ensureFiles(adb).mkdir(serial, path, pkg, rootMode, name);
    }
  );
  electron.ipcMain.handle(
    IPC.filesRename,
    async (_e, serial, path, pkg, rootMode, oldName, newName) => {
      if (isIos(serial)) return { ok: false, message: IOS_FILES_READONLY };
      const adb = findAdb();
      if (!adb || !serial) return { ok: false, message: "No device selected" };
      return await ensureFiles(adb).rename(serial, path, pkg, rootMode, oldName, newName);
    }
  );
  electron.ipcMain.handle(
    IPC.filesDelete,
    async (_e, serial, path, pkg, rootMode, names) => {
      if (isIos(serial)) return { ok: false, message: IOS_FILES_READONLY };
      const adb = findAdb();
      if (!adb || !serial) return { ok: false, message: "No device selected" };
      return await ensureFiles(adb).delete(serial, path, pkg, rootMode, names);
    }
  );
  electron.ipcMain.handle(
    IPC.filesOpen,
    async (_e, serial, path, pkg, rootMode, name, kind) => {
      if (!serial) return { ok: false, message: "No device selected", localPath: "" };
      const bin = iosFilesBin(serial);
      if (bin) {
        if (!pkg) return { ok: false, message: "Select an app to browse its container", localPath: "" };
        return await openEntry(bin, serial, pkg, path, name);
      }
      const adb = findAdb();
      if (!adb) return { ok: false, message: "No device selected", localPath: "" };
      return await ensureFiles(adb).openEntry(serial, path, pkg, rootMode, name, kind);
    }
  );
  electron.ipcMain.handle(IPC.filesChoosePullDir, async () => {
    const win = getWindow2();
    if (!win) return null;
    const res = await electron.dialog.showOpenDialog(win, {
      title: "Download to…",
      defaultPath: node_path.join(node_os.homedir(), "Downloads"),
      properties: ["openDirectory", "createDirectory"]
    });
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0];
  });
  electron.ipcMain.handle(IPC.filesChoosePush, async () => {
    const win = getWindow2();
    if (!win) return [];
    const res = await electron.dialog.showOpenDialog(win, {
      title: "Upload file(s) to the device",
      defaultPath: node_os.homedir(),
      properties: ["openFile", "multiSelections"]
    });
    return res.canceled ? [] : res.filePaths;
  });
  electron.ipcMain.handle(IPC.apkInstall, async (_e, serial, paths) => {
    const adb = findAdb();
    if (!adb || !serial) return { ok: false, message: "No device selected", output: "", names: "" };
    return await installApks(adb, serial, paths);
  });
  const ensureToolbox = (adb) => {
    if (!toolbox) {
      toolbox = new ToolboxService(adb, {
        onMonkeyLine: (line) => send(IPC.toolboxMonkeyLine, line),
        onMonkeyDone: (ok, summary) => send(IPC.toolboxMonkeyDone, { ok, summary }),
        onPerfettoProgress: (message) => send(IPC.toolboxPerfettoProgress, message),
        onPerfettoDone: (ok, message, path, dir) => send(IPC.toolboxPerfettoDone, { ok, message, path, dir }),
        onBugreportProgress: (pct) => send(IPC.toolboxBugreportProgress, pct),
        onBugreportDone: (ok, message, dir) => send(IPC.toolboxBugreportDone, { ok, message, dir })
      });
    }
    return toolbox;
  };
  electron.ipcMain.handle(IPC.toolboxRunIntent, async (_e, serial, spec) => {
    const adb = findAdb();
    if (!adb || !serial) return { ok: false, output: "Intents: no device selected" };
    return await ensureToolbox(adb).runIntent(serial, spec);
  });
  electron.ipcMain.handle(IPC.toolboxListNotifs, async (_e, serial) => {
    const adb = findAdb();
    if (!adb || !serial) return { ok: false, message: "Notifications: no device selected", items: [] };
    return await ensureToolbox(adb).listNotifications(serial);
  });
  electron.ipcMain.handle(
    IPC.toolboxMonkeyStart,
    (_e, serial, pkg, events, seed, throttleMs) => {
      const adb = findAdb();
      if (!adb || !serial || !pkg) return false;
      ensureToolbox(adb).startMonkey(serial, pkg, events, seed, throttleMs);
      return true;
    }
  );
  electron.ipcMain.handle(IPC.toolboxMonkeyStop, () => {
    toolbox?.stopMonkey();
    return true;
  });
  electron.ipcMain.handle(
    IPC.toolboxPerfettoStart,
    (_e, serial, durationS, categories) => {
      const adb = findAdb();
      if (!adb || !serial) return false;
      ensureToolbox(adb).capturePerfetto(serial, durationS, categories);
      return true;
    }
  );
  electron.ipcMain.handle(IPC.toolboxPerfettoCancel, () => {
    toolbox?.cancelPerfetto();
    return true;
  });
  electron.ipcMain.handle(IPC.toolboxBugreportStart, (_e, serial) => {
    const adb = findAdb();
    if (!adb || !serial) return false;
    ensureToolbox(adb).startBugreport(serial);
    return true;
  });
  electron.ipcMain.handle(IPC.toolboxBugreportCancel, () => {
    toolbox?.cancelBugreport();
    return true;
  });
  const ensurePrefs = (adb) => {
    if (!prefs) prefs = new PrefsService(adb);
    return prefs;
  };
  const iosPrefsBin = (serial) => isIos(serial) ? findGoIos() : null;
  electron.ipcMain.handle(IPC.prefsList, async (_e, serial, pkg) => {
    if (!serial || !pkg) return { ok: false, files: [], error: "no device / app selected", usedSu: false };
    const bin = iosPrefsBin(serial);
    if (bin) return await iosPrefsList(bin, serial, pkg);
    const adb = findAdb();
    if (!adb) return { ok: false, files: [], error: "no device / app selected", usedSu: false };
    return await ensurePrefs(adb).list(serial, pkg);
  });
  electron.ipcMain.handle(IPC.prefsLoad, async (_e, serial, pkg, fname) => {
    if (!serial || !pkg) return { ok: false, error: "no device / app selected", fname, prefs: [] };
    const bin = iosPrefsBin(serial);
    if (bin) return await iosPrefsLoad(bin, serial, pkg, fname);
    const adb = findAdb();
    if (!adb) return { ok: false, error: "no device / app selected", fname, prefs: [] };
    return await ensurePrefs(adb).load(serial, pkg, fname);
  });
  electron.ipcMain.handle(IPC.prefsSave, async (_e, serial, pkg, fname, values) => {
    if (!serial || !pkg) return { ok: false, error: "no device / app selected" };
    if (isIos(serial)) return { ok: false, error: "Editing iOS preferences is not supported yet (read-only)." };
    const adb = findAdb();
    if (!adb) return { ok: false, error: "no device / app selected" };
    return await ensurePrefs(adb).save(serial, pkg, fname, values);
  });
  electron.ipcMain.handle(IPC.prefsForceStop, async (_e, serial, pkg) => {
    if (!serial || !pkg) return false;
    if (isIos(serial)) {
      const bin = findGoIos();
      if (!bin) return false;
      return (await kill(bin, serial, pkg)).ok;
    }
    const adb = findAdb();
    if (!adb) return false;
    return await ensurePrefs(adb).forceStop(serial, pkg);
  });
  const ensureCrash = (adb) => {
    if (!crash) crash = new CrashService(adb);
    return crash;
  };
  electron.ipcMain.handle(IPC.crashScan, async (_e, serial) => {
    if (!serial) return { ok: false, message: "no device selected", items: [] };
    if (isIos(serial)) {
      const bin = findGoIos();
      if (!bin) return { ok: false, message: "go-ios binary not found", items: [] };
      return await crashReports(bin, serial);
    }
    const adb = findAdb();
    if (!adb) return { ok: false, message: "no device selected", items: [] };
    return await ensureCrash(adb).scan(serial);
  });
  electron.ipcMain.handle(IPC.crashRetrace, (_e, text2) => {
    const adb = findAdb();
    return ensureCrash(adb ?? "").retrace(text2);
  });
  electron.ipcMain.handle(IPC.crashLoadMapping, async (_e, path) => {
    const adb = findAdb();
    return await ensureCrash(adb ?? "").loadMapping(path);
  });
  electron.ipcMain.handle(IPC.crashLastMapping, () => {
    const adb = findAdb();
    return ensureCrash(adb ?? "").lastMappingPath();
  });
  electron.ipcMain.handle(IPC.crashChooseMapping, async () => {
    const win = getWindow2();
    if (!win) return null;
    const res = await electron.dialog.showOpenDialog(win, {
      title: "Load R8/ProGuard mapping",
      defaultPath: node_os.homedir(),
      properties: ["openFile"],
      filters: [
        { name: "Mapping files", extensions: ["txt", "map"] },
        { name: "All files", extensions: ["*"] }
      ]
    });
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0];
  });
  electron.ipcMain.handle(IPC.crashSave, async (_e, text2, suggested) => {
    const win = getWindow2();
    if (!win) return { ok: false, message: "no window", dir: "" };
    const res = await electron.dialog.showSaveDialog(win, {
      title: "Save crash record",
      defaultPath: node_path.join(node_os.homedir(), "Downloads", suggested),
      filters: [
        { name: "Text", extensions: ["txt"] },
        { name: "All files", extensions: ["*"] }
      ]
    });
    if (res.canceled || !res.filePath) return { ok: false, message: "cancelled", dir: "" };
    try {
      node_fs.writeFileSync(res.filePath, text2, "utf8");
    } catch (e) {
      return { ok: false, message: `Couldn't save: ${e instanceof Error ? e.message : String(e)}`, dir: "" };
    }
    return { ok: true, message: `Crash record saved to ${res.filePath.split("/").pop()}`, dir: node_path.dirname(res.filePath) };
  });
  const ensureAppmgr = (adb) => {
    if (!appmgr) appmgr = new AppMgrService(adb);
    return appmgr;
  };
  electron.ipcMain.handle(IPC.appmgrList, async (_e, serial) => {
    const adb = findAdb();
    if (!adb || !serial) return { ok: false, apps: [], error: "No device selected" };
    return await ensureAppmgr(adb).list(serial);
  });
  electron.ipcMain.handle(IPC.appmgrDetail, async (_e, serial, pkg, apkPath) => {
    const adb = findAdb();
    if (!adb || !serial || !pkg) return { ok: false, detail: null, error: "No device / app selected" };
    return await ensureAppmgr(adb).detail(serial, pkg, apkPath);
  });
  electron.ipcMain.handle(IPC.appmgrAction, async (_e, serial, argv, okMsg) => {
    const adb = findAdb();
    if (!adb || !serial) return { ok: false, message: "No device selected" };
    return await ensureAppmgr(adb).action(argv, okMsg);
  });
  electron.ipcMain.handle(IPC.appmgrClearCache, async (_e, serial, pkg) => {
    const adb = findAdb();
    if (!adb || !serial || !pkg) return { ok: false, message: "No device / app selected" };
    return await ensureAppmgr(adb).clearCache(serial, pkg);
  });
  electron.ipcMain.handle(IPC.appmgrBulkPerms, async (_e, serial, pkg, perms, grant) => {
    const adb = findAdb();
    if (!adb || !serial || !pkg) return { ok: false, message: "No device / app selected" };
    return await ensureAppmgr(adb).bulkPerms(serial, pkg, perms, grant);
  });
  electron.ipcMain.handle(IPC.appmgrIcon, async (_e, serial, pkg, apkPath) => {
    const adb = findAdb();
    if (!adb || !serial || !pkg) return { dataUrl: null, unavailable: false };
    return await ensureAppmgr(adb).icon(serial, pkg, apkPath);
  });
  electron.ipcMain.handle(IPC.appmgrExtractApk, async (_e, serial, pkg) => {
    const adb = findAdb();
    if (!adb || !serial || !pkg) return { ok: false, message: "No device / app selected", dir: "" };
    return await ensureAppmgr(adb).extractApk(serial, pkg);
  });
  electron.ipcMain.handle(IPC.iosDeviceInfo, async (_e, udid) => {
    const bin = findGoIos();
    if (!bin || !udid) return null;
    return await deviceInfo(bin, udid);
  });
  electron.ipcMain.handle(IPC.iosDeviceIp, async (_e, udid) => {
    const bin = findGoIos();
    if (!bin || !udid) return null;
    return await deviceIp(bin, udid);
  });
  electron.ipcMain.handle(IPC.iosDeviceImage, (_e, identifier) => deviceImage(identifier));
  electron.ipcMain.handle(IPC.iosListApps, async (_e, udid) => {
    const bin = findGoIos();
    if (!bin) return { ok: false, apps: [], error: "go-ios binary not found" };
    if (!udid) return { ok: false, apps: [], error: "No device selected" };
    return await listApps(bin, udid);
  });
  electron.ipcMain.handle(IPC.iosAppIcon, async (_e, udid, bundleId) => {
    const bin = findGoIos();
    if (!bin || !udid || !bundleId) return { dataUrl: null, unavailable: false };
    return await appIcon(bin, udid, bundleId);
  });
  electron.ipcMain.handle(IPC.iosChooseIpa, async () => {
    const win = getWindow2();
    if (!win) return null;
    const res = await electron.dialog.showOpenDialog(win, {
      title: "Select an .ipa to install",
      defaultPath: node_os.homedir(),
      properties: ["openFile"],
      filters: [
        { name: "iOS app packages", extensions: ["ipa"] },
        { name: "All files", extensions: ["*"] }
      ]
    });
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0];
  });
  electron.ipcMain.handle(IPC.iosInstall, async (_e, udid, ipaPath) => {
    const bin = findGoIos();
    if (!bin || !udid || !ipaPath) return { ok: false, message: "No device / file selected" };
    return await install(bin, udid, ipaPath);
  });
  electron.ipcMain.handle(IPC.iosUninstall, async (_e, udid, bundleId) => {
    const bin = findGoIos();
    if (!bin || !udid || !bundleId) return { ok: false, message: "No device / app selected" };
    return await uninstall(bin, udid, bundleId);
  });
  electron.ipcMain.handle(IPC.iosTunnelStatus, async (_e, udid) => {
    const bin = findGoIos();
    if (!bin || !udid) return { ready: false };
    return await getTunnelStatus(bin, udid);
  });
  electron.ipcMain.handle(IPC.iosTunnelStart, async (_e, udid) => {
    const bin = findGoIos();
    if (!bin || !udid) return { ok: false, message: "No device selected" };
    return await startTunnel(bin, udid);
  });
  electron.ipcMain.handle(IPC.iosTunnelStop, () => {
    stopTunnel();
    return true;
  });
  electron.ipcMain.handle(IPC.iosProcesses, async (_e, udid, appsOnly) => {
    const bin = findGoIos();
    if (!bin || !udid) return { ok: false, processes: [], error: "No device selected" };
    return await processes(bin, udid, appsOnly);
  });
  electron.ipcMain.handle(IPC.iosLaunch, async (_e, udid, bundleId) => {
    const bin = findGoIos();
    if (!bin || !udid || !bundleId) return { ok: false, message: "No device / app selected" };
    return await launch(bin, udid, bundleId);
  });
  electron.ipcMain.handle(IPC.iosKill, async (_e, udid, bundleId) => {
    const bin = findGoIos();
    if (!bin || !udid || !bundleId) return { ok: false, message: "No device / app selected" };
    return await kill(bin, udid, bundleId);
  });
  const ensureIosMirror = (bin) => {
    if (!iosMirrorSvc) {
      iosMirrorSvc = new IosMirrorService(bin, {
        onH264: (chunk) => broadcast(IPC.iosMirrorH264, chunk),
        onState: (state) => broadcast(IPC.iosMirrorState, state),
        onFailed: (message) => broadcast(IPC.iosMirrorFailed, message)
      });
    }
    return iosMirrorSvc;
  };
  const ensureIosAirplay = () => {
    if (!iosAirplaySvc) {
      iosAirplaySvc = new IosAirplayService({
        onH264: (chunk) => broadcast(IPC.iosMirrorH264, chunk),
        onState: (state) => broadcast(IPC.iosMirrorState, state),
        onFailed: (message) => broadcast(IPC.iosMirrorFailed, message)
      });
    }
    return iosAirplaySvc;
  };
  electron.ipcMain.handle(
    IPC.iosMirrorStart,
    (_e, udid, mode, resolution) => {
      if (mode === "airplay") {
        iosMirrorSvc?.stopFeed(true);
        ensureIosAirplay().start(resolution);
        return true;
      }
      iosAirplaySvc?.stop(true);
      const bin = findGoIos();
      if (!bin || !udid) return false;
      ensureIosMirror(bin).start(udid);
      return true;
    }
  );
  electron.ipcMain.handle(IPC.iosMirrorStop, (_e, immediate) => {
    iosMirrorSvc?.stopFeed(immediate);
    iosAirplaySvc?.stop(immediate);
    return true;
  });
  electron.ipcMain.handle(IPC.iosMirrorSetMuted, (_e, muted) => {
    iosMirrorSvc?.setMuted(muted);
    iosAirplaySvc?.setMuted(muted);
    return muted;
  });
  electron.ipcMain.handle(IPC.iosMirrorGetMuted, () => iosMirrorSvc?.getMuted() ?? iosAirplaySvc?.getMuted() ?? false);
  electron.ipcMain.handle(IPC.iosMirrorSaveFrame, (_e, pngBase64) => {
    const b64 = pngBase64.replace(/^data:image\/png;base64,/, "");
    if (!b64) return { ok: false, message: "No frame to save", dir: "" };
    const dl = node_path.join(node_os.homedir(), "Downloads");
    const d = /* @__PURE__ */ new Date();
    const p = (n) => String(n).padStart(2, "0");
    const stamp2 = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    const dest = node_path.join(dl, `screenshot-ios-${stamp2}.png`);
    try {
      node_fs.writeFileSync(dest, Buffer.from(b64, "base64"));
      return { ok: true, message: `Saved ${dest.split("/").pop()}`, dir: dl };
    } catch (e) {
      return { ok: false, message: `Cannot save screenshot: ${e instanceof Error ? e.message : String(e)}`, dir: "" };
    }
  });
  electron.ipcMain.handle(IPC.iosInputGetConfig, () => loadConfig());
  electron.ipcMain.handle(IPC.iosInputSetConfig, (_e, cfg) => saveConfig(cfg));
  electron.ipcMain.handle(IPC.iosInputChooseKey, (_e, kind) => chooseFile(getWindow2(), kind));
  electron.ipcMain.handle(IPC.iosInputProvision, async (_e, udid, cfg) => {
    const bin = findGoIos();
    if (!bin || !udid) return { ok: false, message: "go-ios or device unavailable" };
    const result = await provision(bin, udid, cfg, (line) => send(IPC.iosInputProgress, line));
    send(IPC.iosInputDone, result);
    return result;
  });
  electron.ipcMain.handle(IPC.iosInputCancel, () => {
    cancelProvision();
    return true;
  });
  electron.ipcMain.handle(IPC.iosInputStatus, async (_e, udid) => {
    const bin = findGoIos();
    if (!bin || !udid) return false;
    return status(bin, udid);
  });
  electron.ipcMain.handle(IPC.iosInputSize, async (_e, udid) => {
    const bin = findGoIos();
    if (!bin || !udid) return null;
    return size(bin, udid);
  });
  electron.ipcMain.handle(IPC.iosInputTap, (_e, udid, x, y) => {
    const bin = findGoIos();
    if (bin && udid) tap(bin, udid, x, y);
    return true;
  });
  electron.ipcMain.handle(IPC.iosInputSwipe, (_e, udid, x1, y1, x2, y2, durationSec) => {
    const bin = findGoIos();
    if (bin && udid) swipe(bin, udid, x1, y1, x2, y2, durationSec);
    return true;
  });
  electron.ipcMain.handle(IPC.iosInputGesture, (_e, udid, points) => {
    const bin = findGoIos();
    if (bin && udid && Array.isArray(points)) gesture(bin, udid, points);
    return true;
  });
  electron.ipcMain.handle(
    IPC.iosInputDrag,
    (_e, udid, phase, x, y, flick) => {
      const bin = findGoIos();
      if (!bin || !udid) return true;
      if (phase === "start") dragStart(bin, udid, x, y);
      else if (phase === "move") dragMove(bin, udid, x, y);
      else dragEnd(bin, udid, x, y, flick);
      return true;
    }
  );
  electron.ipcMain.handle(IPC.iosInputType, (_e, udid, text2) => {
    const bin = findGoIos();
    if (bin && udid) type(bin, udid, text2);
    return true;
  });
  electron.ipcMain.handle(IPC.iosInputKey, (_e, udid, domKey, modifiers) => {
    const bin = findGoIos();
    if (bin && udid && domKey) key(bin, udid, domKey, Array.isArray(modifiers) ? modifiers : []);
    return true;
  });
  electron.ipcMain.handle(IPC.iosInputButton, (_e, udid, name) => {
    const bin = findGoIos();
    if (bin && udid) button(bin, udid, name);
    return true;
  });
  const wiringFor = (serial) => {
    const cb = {
      onStatus: (message) => send(IPC.interceptStatus, message),
      onDisconnect: () => intercept?.stop()
    };
    if (isIos(serial)) {
      const bin = findGoIos();
      return bin ? new IosWiring(bin, serial, cb) : null;
    }
    const adb = findAdb();
    return adb ? new AndroidWiring(adb, serial, cb) : null;
  };
  const ensureIntercept = () => {
    if (!intercept) {
      intercept = new InterceptService(wiringFor, {
        onFlows: (flows) => send(IPC.interceptFlows, flows),
        onStarted: (port) => send(IPC.interceptStarted, port),
        onStatus: (message) => send(IPC.interceptStatus, message),
        onFailed: (message) => send(IPC.interceptFailed, message)
      });
    }
    return intercept;
  };
  electron.ipcMain.handle(IPC.interceptStart, async (_e, serial, port, decrypt) => {
    if (!serial) {
      send(IPC.interceptFailed, "No device selected");
      return false;
    }
    await ensureIntercept().start(serial, port, decrypt);
    return true;
  });
  electron.ipcMain.handle(IPC.interceptStop, () => {
    intercept?.stop();
    return true;
  });
  electron.ipcMain.handle(IPC.interceptSetDecrypt, (_e, on) => {
    intercept?.setDecrypt(on);
    return true;
  });
  electron.ipcMain.handle(IPC.interceptInstallCert, async (_e, serial) => {
    if (!serial) return { ok: false, message: "No device selected", dir: "" };
    return await ensureIntercept().installCert(serial);
  });
  electron.ipcMain.handle(IPC.interceptDetail, (_e, id) => {
    return ensureIntercept().detail(id);
  });
  electron.ipcMain.handle(IPC.interceptSaveBody, async (_e, id) => {
    const win = getWindow2();
    if (!win || !intercept) return { ok: false, message: "Intercept not running", dir: "" };
    const res = await electron.dialog.showSaveDialog(win, {
      title: "Save response body",
      defaultPath: node_path.join(node_os.homedir(), "Downloads", ensureIntercept().bodyFileName(id))
    });
    if (res.canceled || !res.filePath) return { ok: false, message: "cancelled", dir: "" };
    return intercept.saveBody(id, res.filePath);
  });
  electron.ipcMain.handle(IPC.interceptDownloadFlow, async (_e, id) => {
    const win = getWindow2();
    if (!win || !intercept) return { ok: false, message: "Intercept not running", dir: "" };
    const res = await electron.dialog.showSaveDialog(win, {
      title: "Download request + response",
      defaultPath: node_path.join(node_os.homedir(), "Downloads", ensureIntercept().exportFileName(id)),
      filters: [
        { name: "Text", extensions: ["txt"] },
        { name: "All files", extensions: ["*"] }
      ]
    });
    if (res.canceled || !res.filePath) return { ok: false, message: "cancelled", dir: "" };
    return intercept.downloadFlow(id, res.filePath);
  });
  electron.ipcMain.handle(IPC.logfileOpen, async () => {
    const win = getWindow2();
    return win ? await openLog(win) : null;
  });
  electron.ipcMain.handle(
    IPC.logfileExport,
    async (_e, kind, text2, count) => {
      const win = getWindow2();
      if (!win) return { ok: false, message: "no window", dir: "" };
      return await exportLog(win, kind, text2, count);
    }
  );
  electron.ipcMain.handle(IPC.presetsLoad, () => loadPresets());
  electron.ipcMain.handle(IPC.presetsSave, (_e, map) => savePresets(map));
  electron.ipcMain.handle(IPC.systemOpenPath, async (_e, p) => {
    if (p) await electron.shell.openPath(p);
  });
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    mirrorWin.destroy();
    deviceWatcher.stop();
    reader?.stop();
    for (const s of shellSessions.values()) s.shutdown();
    shellSessions.clear();
    monitor?.stop();
    leak?.shutdown();
    db?.shutdown();
    files?.shutdown();
    toolbox?.shutdown();
    mockloc?.shutdown();
    mirrorSvc?.shutdown();
    iosMirrorSvc?.shutdown();
    iosAirplaySvc?.shutdown();
    shutdown();
    intercept?.shutdown();
    iosDb?.shutdown();
    shutdown$1();
    shutdownMock();
    monitorStop();
    syslogStop();
    stopTunnel();
    stop();
  };
  getWindow2()?.on("closed", cleanup);
  electron.app.on("before-quit", cleanup);
}
function buildAppMenu(getWindow2) {
  const isMac = process.platform === "darwin";
  const send = (action) => {
    const win = getWindow2();
    if (win && !win.isDestroyed()) win.webContents.send(IPC.menuAction, action);
  };
  const aboutItem = {
    label: `About ${electron.app.name}`,
    click: () => send("about")
  };
  const template = [];
  if (isMac) {
    template.push({
      label: electron.app.name,
      submenu: [
        aboutItem,
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" }
      ]
    });
  }
  template.push({
    label: "File",
    submenu: [
      { label: "Open Log File…", accelerator: "CmdOrCtrl+O", click: () => send("open-log") },
      {
        label: "Export Filtered Log…",
        accelerator: "CmdOrCtrl+E",
        click: () => send("export-filtered")
      },
      { label: "Export Entire Log…", click: () => send("export-entire") },
      { type: "separator" },
      isMac ? { role: "close" } : { role: "quit" }
    ]
  });
  template.push({
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
      { type: "separator" },
      { label: "Find", accelerator: "CmdOrCtrl+F", click: () => send("find") }
    ]
  });
  template.push({
    label: "View",
    submenu: [
      { label: "Clear Log", accelerator: "CmdOrCtrl+K", click: () => send("clear-log") },
      { type: "separator" },
      { role: "reload" },
      { role: "toggleDevTools" },
      { type: "separator" },
      { role: "togglefullscreen" }
    ]
  });
  template.push({
    role: "window",
    submenu: [{ role: "minimize" }, { role: "zoom" }, ...isMac ? [{ role: "front" }] : []]
  });
  template.push({
    role: "help",
    submenu: isMac ? [] : [aboutItem]
  });
  electron.Menu.setApplicationMenu(electron.Menu.buildFromTemplate(template));
}
electron.app.setName("MobileLabKit");
electron.app.setAboutPanelOptions({
  applicationName: "MobileLabKit",
  applicationVersion: electron.app.getVersion(),
  copyright: "Copyright © 2026 Mahmoud Alghraibeh"
});
const iconPath = node_path.join(electron.app.getAppPath(), "build", "icon.png");
let mainWindow = null;
const getWindow = () => mainWindow;
function createWindow() {
  mainWindow = new electron.BrowserWindow({
    width: 1180,
    height: 720,
    minWidth: 900,
    minHeight: 560,
    show: false,
    backgroundColor: "#16171c",
    title: "MobileLabKit",
    icon: iconPath,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: node_path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      // Location tab hosts the MapLibre map in an isolated <webview> guest with
      // its OWN CSP (set in map.html), so the strict main-window CSP stays intact.
      webviewTag: true
    }
  });
  mainWindow.on("ready-to-show", () => mainWindow?.show());
  mainWindow.webContents.on("did-finish-load", () => {
    void mainWindow?.webContents.setVisualZoomLevelLimits(1, 1);
    mainWindow?.webContents.setZoomFactor(1);
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void electron.shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(node_path.join(__dirname, "../renderer/index.html"));
  }
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  if (process.env.ANDROIDLAB_SMOKE === "inspector") runInspectorSmoke(mainWindow);
  else if (process.env.ANDROIDLAB_SMOKE) runSmoke(mainWindow);
}
function runInspectorSmoke(win) {
  const errors = [];
  const watchdog = setTimeout(() => {
    console.log("INSP TIMEOUT");
    electron.app.exit(2);
  }, 3e4);
  electron.app.on("before-quit", () => clearTimeout(watchdog));
  win.webContents.on("console-message", (_e, level, message) => {
    if (level >= 2) errors.push(message);
  });
  const js = (code) => win.webContents.executeJavaScript(code);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const canvasH = () => js(
    `Math.round((document.querySelector('.insp-view canvas')||{getBoundingClientRect:()=>({height:0})}).getBoundingClientRect().height)`
  );
  win.webContents.on("did-finish-load", async () => {
    await sleep(1e3);
    await js(`[...document.querySelectorAll('.tab')].find(t=>t.textContent.trim()==='Inspector')?.click()`);
    await sleep(400);
    const winH = await js("window.innerHeight");
    const heights = [await canvasH()];
    await js(`document.querySelector('.insp-bar button')?.click()`);
    let nodes = 0;
    for (let i = 0; i < 40; i++) {
      await sleep(200);
      nodes = await js(`document.querySelectorAll('.insp-node').length`);
      if (nodes > 0) break;
    }
    await sleep(500);
    heights.push(await canvasH());
    const snap = () => js(
      `JSON.stringify(['toolbar','tabbar','insp-view','insp-bar','insp-split','insp-canvas-wrap','insp-right','status-bar'].map(c=>{const e=document.querySelector('.'+c);return [c, e?Math.round(e.getBoundingClientRect().height):-1]}).concat([['docScrollTop',Math.round(document.documentElement.scrollTop)],['bodyH',Math.round(document.body.getBoundingClientRect().height)]]))`
    );
    console.log("INSP snap pre-click: " + await snap());
    for (let i = 0; i < 3; i++) {
      await js(`(()=>{const c=document.querySelector('.insp-view canvas');if(!c)return;const r=c.getBoundingClientRect();c.dispatchEvent(new MouseEvent('click',{clientX:r.left+r.width/2,clientY:r.top+r.height*0.4,bubbles:true}));})()`);
      await sleep(400);
      heights.push(await canvasH());
    }
    console.log("INSP snap post-click: " + await snap());
    const selected = await js(`document.querySelectorAll('.insp-node.selected').length`);
    const maxJump = heights.slice(1).reduce((m, h, i) => Math.max(m, h - heights[i]), 0);
    const stable = maxJump <= 2 && heights[heights.length - 1] < winH && heights[0] > 0;
    console.log(`INSP winH=${winH} heights=${heights.join(",")} nodes=${nodes} selected=${selected} errors=${errors.length}`);
    console.log(stable && nodes > 0 ? "INSP PASS" : "INSP FAIL");
    electron.app.exit(stable && nodes > 0 ? 0 : 1);
  });
}
function runSmoke(win) {
  const errors = [];
  const watchdog = setTimeout(() => {
    console.log("SMOKE TIMEOUT (window never finished loading)");
    console.log("SMOKE FAIL");
    electron.app.exit(2);
  }, 15e3);
  electron.app.on("before-quit", () => clearTimeout(watchdog));
  win.webContents.on("console-message", (_e, level, message) => {
    if (level >= 2) errors.push(message);
    console.log(`[renderer] ${message}`);
  });
  win.webContents.on("render-process-gone", (_e, d) => errors.push(`render-process-gone: ${d.reason}`));
  win.webContents.on("did-fail-load", (_e, code, desc) => errors.push(`did-fail-load ${code} ${desc}`));
  const sample = [
    "07-09 14:23:01.123  1234  1250 D BActivityThread: smoke debug line",
    "07-09 14:23:01.200  1234  1250 I System.out: hello from smoke",
    "07-09 14:23:01.300  1234  1250 W ActivityManager: a warning",
    "07-09 14:23:01.400  1234  1250 E AndroidRuntime: an error line",
    "--------- beginning of crash"
  ];
  const monitorSample = {
    cpu: 50,
    mem: [3e6, 8e6],
    load: [1.2, 1, 0.8],
    cores: 2,
    coresPct: [40, 60],
    battery: { level: 80, tempC: 30, powered: false },
    gfx: null,
    app: null
  };
  win.webContents.on("did-finish-load", () => {
    setTimeout(() => {
      win.webContents.send(IPC.logcatLines, sample);
      setTimeout(async () => {
        const rows = await win.webContents.executeJavaScript(
          `document.querySelectorAll('.log-row').length`
        );
        const first = await win.webContents.executeJavaScript(
          `(document.querySelector('.log-row .cell.msg')||{}).textContent || ''`
        );
        await win.webContents.executeJavaScript(
          `[...document.querySelectorAll('.tab')].find(t=>t.textContent.trim()==='Monitor')?.click()`
        );
        await new Promise((r) => setTimeout(r, 200));
        win.webContents.send(IPC.monitorSample, monitorSample);
        await new Promise((r) => setTimeout(r, 400));
        const monCpu = await win.webContents.executeJavaScript(
          `(document.querySelector('.mon-value')||{}).textContent || ''`
        );
        const hasSpark = await win.webContents.executeJavaScript(
          `document.querySelectorAll('canvas.spark').length`
        );
        await win.webContents.executeJavaScript(
          `[...document.querySelectorAll('.tab')].find(t=>t.textContent.trim()==='Inspector')?.click()`
        );
        let inspReady = 0;
        for (let i = 0; i < 15; i++) {
          await new Promise((r) => setTimeout(r, 150));
          inspReady = await win.webContents.executeJavaScript(
            `document.querySelectorAll('.insp-view canvas').length`
          );
          if (inspReady >= 1) break;
        }
        const h1 = await win.webContents.executeJavaScript(
          `Math.round((document.querySelector('.insp-view canvas')||{getBoundingClientRect:()=>({height:0})}).getBoundingClientRect().height)`
        );
        await new Promise((r) => setTimeout(r, 500));
        const h2 = await win.webContents.executeJavaScript(
          `Math.round((document.querySelector('.insp-view canvas')||{getBoundingClientRect:()=>({height:0})}).getBoundingClientRect().height)`
        );
        const winH = await win.webContents.executeJavaScript(`window.innerHeight`);
        const inspStable = h1 > 0 && Math.abs(h1 - h2) <= 1 && h1 < winH;
        await win.webContents.executeJavaScript(
          `[...document.querySelectorAll('.tab')].find(t=>t.textContent.trim()==='Controls')?.click()`
        );
        await new Promise((r) => setTimeout(r, 200));
        const ctrlSwitches = await win.webContents.executeJavaScript(
          `document.querySelectorAll('.ctrl-view .switch').length`
        );
        await win.webContents.executeJavaScript(
          `[...document.querySelectorAll('.tab')].find(t=>t.textContent.trim()==='Databases')?.click()`
        );
        await new Promise((r) => setTimeout(r, 200));
        const dbReady = await win.webContents.executeJavaScript(
          `document.querySelectorAll('.db-view').length`
        );
        await win.webContents.executeJavaScript(
          `[...document.querySelectorAll('.tab')].find(t=>t.textContent.trim()==='Files')?.click()`
        );
        await new Promise((r) => setTimeout(r, 200));
        const filesReady = await win.webContents.executeJavaScript(
          `document.querySelectorAll('.files-cmdbar').length`
        );
        await win.webContents.executeJavaScript(
          `[...document.querySelectorAll('.tab')].find(t=>t.textContent.trim()==='Toolbox')?.click()`
        );
        await new Promise((r) => setTimeout(r, 200));
        const toolboxReady = await win.webContents.executeJavaScript(
          `document.querySelectorAll('.tb-view').length`
        );
        await win.webContents.executeJavaScript(
          `[...document.querySelectorAll('.tab')].find(t=>t.textContent.trim().replace(/\\s*●$/,'')==='Apps')?.click()`
        );
        await new Promise((r) => setTimeout(r, 250));
        const appsReady = await win.webContents.executeJavaScript(
          `document.querySelectorAll('.am-view').length`
        );
        await win.webContents.executeJavaScript(
          `[...document.querySelectorAll('.am-tabs .tab')].find(t=>t.textContent.trim().startsWith('Prefs'))?.click()`
        );
        await new Promise((r) => setTimeout(r, 200));
        const prefsReady = await win.webContents.executeJavaScript(
          `document.querySelectorAll('.prefs-view').length`
        );
        await win.webContents.executeJavaScript(
          `[...document.querySelectorAll('.am-tabs .tab')].find(t=>t.textContent.trim().startsWith('Crashes'))?.click()`
        );
        await new Promise((r) => setTimeout(r, 200));
        const crashReady = await win.webContents.executeJavaScript(
          `document.querySelectorAll('.crash-view').length`
        );
        await win.webContents.executeJavaScript(
          `[...document.querySelectorAll('.tab')].find(t=>t.textContent.trim()==='Location')?.click()`
        );
        await new Promise((r) => setTimeout(r, 300));
        const locReady = await win.webContents.executeJavaScript(
          `document.querySelectorAll('.loc-view .loc-bar').length && document.querySelectorAll('.loc-view .loc-input').length>=2 ? 1 : 0`
        );
        await win.webContents.executeJavaScript(
          `[...document.querySelectorAll('.tab')].find(t=>t.textContent.trim()==='Shell')?.click()`
        );
        await new Promise((r) => setTimeout(r, 300));
        const shellReady = await win.webContents.executeJavaScript(
          `document.querySelectorAll('.shell-view .shell-term .xterm').length`
        );
        await win.webContents.executeJavaScript(`document.querySelector('.shell-tab-add')?.click()`);
        await new Promise((r) => setTimeout(r, 300));
        const shellPanes = await win.webContents.executeJavaScript(
          `document.querySelectorAll('.shell-view .shell-panes .shell-pane .xterm').length`
        );
        const shellTabs = await win.webContents.executeJavaScript(
          `document.querySelectorAll('.shell-view .shell-tabs .shell-tab').length`
        );
        await win.webContents.executeJavaScript(
          `document.querySelector('.shell-view .shell-tab')?.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`
        );
        await new Promise((r) => setTimeout(r, 150));
        await win.webContents.executeJavaScript(`
          (() => {
            const inp = document.querySelector('.shell-view .shell-tab .rename');
            if (!inp) return;
            const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
            set.call(inp, 'Renamed');
            inp.dispatchEvent(new Event('input',{bubbles:true}));
            inp.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
          })()
        `);
        await new Promise((r) => setTimeout(r, 150));
        const shellRenamed = await win.webContents.executeJavaScript(
          `(document.querySelector('.shell-view .shell-tab .label')||{}).textContent === 'Renamed' ? 1 : 0`
        );
        await win.webContents.executeJavaScript(
          `[...document.querySelectorAll('.tab')].find(t=>t.textContent.trim()==='Network HTTP')?.click()`
        );
        await new Promise((r) => setTimeout(r, 300));
        const networkReady = await win.webContents.executeJavaScript(
          `document.querySelectorAll('.net-view .net-filter').length && document.querySelectorAll('.net-view .net-table').length && document.querySelectorAll('.net-view .net-enable').length ? 1 : 0`
        );
        console.log(
          `SMOKE rows=${rows} first=${JSON.stringify(first)} monCpu=${JSON.stringify(monCpu)} sparks=${hasSpark} insp=${inspReady} stable=${inspStable} ctrl=${ctrlSwitches} db=${dbReady} files=${filesReady} toolbox=${toolboxReady} apps=${appsReady} prefs=${prefsReady} crash=${crashReady} location=${locReady} shell=${shellReady} shellPanes=${shellPanes} shellTabs=${shellTabs} shellRenamed=${shellRenamed} network=${networkReady} errors=${errors.length}`
        );
        if (errors.length) console.log("SMOKE ERRORS:\n" + errors.join("\n"));
        const ok = rows === 4 && first.length > 0 && monCpu.includes("50%") && hasSpark >= 4 && inspReady >= 1 && inspStable && ctrlSwitches >= 10 && dbReady >= 1 && filesReady >= 1 && toolboxReady >= 1 && appsReady >= 1 && prefsReady >= 1 && crashReady >= 1 && shellReady >= 1 && shellPanes >= 2 && shellTabs >= 2 && shellRenamed === 1 && networkReady >= 1 && errors.length === 0;
        console.log(ok ? "SMOKE PASS" : "SMOKE FAIL");
        electron.app.exit(ok ? 0 : 1);
      }, 800);
    }, 400);
  });
}
if (!electron.app.requestSingleInstanceLock()) {
  electron.app.quit();
} else {
  electron.app.on("second-instance", () => {
    const win = getWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  electron.app.whenReady().then(() => {
    if (process.platform === "darwin" && !electron.app.isPackaged) {
      const img = electron.nativeImage.createFromPath(iconPath);
      if (!img.isEmpty()) electron.app.dock?.setIcon(img);
    }
    registerIpc(getWindow);
    buildAppMenu(getWindow);
    createWindow();
    electron.app.on("activate", () => {
      if (electron.BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") electron.app.quit();
});
