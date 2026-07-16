/** IPC channel names — single source of truth for main + preload. */
export const IPC = {
  // adb queries (invoke/handle)
  adbFind: 'adb:find',
  adbListDevices: 'adb:list-devices',
  adbListApps: 'adb:list-apps',
  adbResolvePids: 'adb:resolve-pids',
  adbForceCrash: 'adb:force-crash',
  adbDeviceInfo: 'adb:device-info',

  // logcat stream control (invoke/handle)
  logcatStart: 'logcat:start',
  logcatStop: 'logcat:stop',
  logcatRunning: 'logcat:running',
  // logcat stream events (main -> renderer)
  logcatLines: 'logcat:lines',
  logcatState: 'logcat:state',
  logcatError: 'logcat:error',

  // interactive adb shell over a PTY (control invoke/handle + event streams)
  shellStart: 'shell:start',
  shellWrite: 'shell:write',
  shellResize: 'shell:resize',
  shellStop: 'shell:stop',
  shellRunning: 'shell:running',
  shellData: 'shell:data',
  shellState: 'shell:state',

  // performance monitor (invoke/handle + events)
  monitorStart: 'monitor:start',
  monitorStop: 'monitor:stop',
  monitorSample: 'monitor:sample',
  monitorFailed: 'monitor:failed',

  // memory-leak detection (control invoke/handle + event streams)
  leakStart: 'leak:start',
  leakCancel: 'leak:cancel',
  leakProgress: 'leak:progress',
  leakDone: 'leak:done',
  leakSaveReport: 'leak:save-report',

  // layout inspector (invoke/handle)
  inspectCapture: 'inspect:capture',

  // screen mirror (invoke/handle + event streams)
  mirrorStartH264: 'mirror:start-h264',
  mirrorStartScrcpy: 'mirror:start-scrcpy',
  mirrorStartPoller: 'mirror:start-poller',
  mirrorStop: 'mirror:stop',
  mirrorInput: 'mirror:input',
  mirrorControl: 'mirror:control',
  mirrorScreenshot: 'mirror:screenshot',
  mirrorRecordStart: 'mirror:record-start',
  mirrorRecordStop: 'mirror:record-stop',
  mirrorListDisplays: 'mirror:list-displays',
  mirrorIsEmulator: 'mirror:is-emulator',
  mirrorScrcpyAvailable: 'mirror:scrcpy-available',
  mirrorLaunchScrcpy: 'mirror:launch-scrcpy',
  // detached mirror window (Android Studio-style pop-out) — invoke/handle
  mirrorPopoutOpen: 'mirror:popout-open', // main-window renderer -> main: open the window
  mirrorPopoutClose: 'mirror:popout-close', // -> main: close the window (arg: redock?)
  mirrorPopoutUpdate: 'mirror:popout-update', // -> main: push a new device to the window
  mirrorPopoutInfo: 'mirror:popout-info', // popout renderer -> main: which device to mirror
  mirrorPopoutFullscreen: 'mirror:popout-fullscreen', // popout renderer -> main: toggle OS-window fullscreen
  // mirror events (main -> renderer)
  mirrorFrame: 'mirror:frame',
  mirrorH264: 'mirror:h264',
  mirrorControlReady: 'mirror:control-ready',
  mirrorFailed: 'mirror:failed',
  mirrorRecordDone: 'mirror:record-done',
  mirrorPopoutInfoEvent: 'mirror:popout-info-event', // main -> popout: device changed
  mirrorPopoutClosed: 'mirror:popout-closed', // main -> main window: popout closed, re-dock
  mirrorPopoutFullscreenEvent: 'mirror:popout-fullscreen-event', // main -> popout: OS-window fullscreen changed

  // device controls (invoke/handle)
  controlsRead: 'controls:read',
  controlsApply: 'controls:apply',

  // wireless adb (invoke/handle)
  wirelessEnable: 'wireless:enable',

  // mock GPS location (invoke/handle)
  mocklocSetup: 'mockloc:setup',
  mocklocSet: 'mockloc:set',
  mocklocStop: 'mockloc:stop',

  // database inspector (invoke/handle)
  dbList: 'db:list',
  dbOpen: 'db:open',
  dbReadTable: 'db:read-table',
  dbQuery: 'db:query',
  dbEdit: 'db:edit',
  dbExport: 'db:export',
  dbExportCsv: 'db:export-csv',

  // file explorer (invoke/handle)
  filesList: 'files:list',
  filesPull: 'files:pull',
  filesPush: 'files:push',
  filesMkdir: 'files:mkdir',
  filesRename: 'files:rename',
  filesDelete: 'files:delete',
  filesOpen: 'files:open',
  filesChoosePullDir: 'files:choose-pull-dir',
  filesChoosePush: 'files:choose-push',

  // apk install (invoke/handle)
  apkInstall: 'apk:install',

  // log file open/export (invoke/handle)
  logfileOpen: 'logfile:open',
  logfileExport: 'logfile:export',

  // filter presets (invoke/handle)
  presetsLoad: 'presets:load',
  presetsSave: 'presets:save',

  // toolbox: intents + notifications (invoke/handle)
  toolboxRunIntent: 'toolbox:run-intent',
  toolboxListNotifs: 'toolbox:list-notifs',
  // toolbox: monkey (control invoke/handle + event streams)
  toolboxMonkeyStart: 'toolbox:monkey-start',
  toolboxMonkeyStop: 'toolbox:monkey-stop',
  toolboxMonkeyLine: 'toolbox:monkey-line',
  toolboxMonkeyDone: 'toolbox:monkey-done',
  // toolbox: perfetto (control invoke/handle + event streams)
  toolboxPerfettoStart: 'toolbox:perfetto-start',
  toolboxPerfettoCancel: 'toolbox:perfetto-cancel',
  toolboxPerfettoProgress: 'toolbox:perfetto-progress',
  toolboxPerfettoDone: 'toolbox:perfetto-done',
  // toolbox: bugreport (control invoke/handle + event streams)
  toolboxBugreportStart: 'toolbox:bugreport-start',
  toolboxBugreportCancel: 'toolbox:bugreport-cancel',
  toolboxBugreportProgress: 'toolbox:bugreport-progress',
  toolboxBugreportDone: 'toolbox:bugreport-done',

  // SharedPreferences editor (Apps ▸ Prefs sub-tab)
  prefsList: 'prefs:list',
  prefsLoad: 'prefs:load',
  prefsSave: 'prefs:save',
  prefsForceStop: 'prefs:force-stop',

  // crash & ANR viewer (Apps ▸ Crashes sub-tab)
  crashScan: 'crash:scan',
  crashRetrace: 'crash:retrace',
  crashLoadMapping: 'crash:load-mapping',
  crashChooseMapping: 'crash:choose-mapping',
  crashLastMapping: 'crash:last-mapping',
  crashSave: 'crash:save',

  // app manager (Apps tab)
  appmgrList: 'appmgr:list',
  appmgrDetail: 'appmgr:detail',
  appmgrAction: 'appmgr:action',
  appmgrClearCache: 'appmgr:clear-cache',
  appmgrBulkPerms: 'appmgr:bulk-perms',
  appmgrIcon: 'appmgr:icon',
  appmgrExtractApk: 'appmgr:extract-apk',

  // iOS Apps tab (go-ios backend)
  iosDeviceInfo: 'ios:device-info',
  iosDeviceIp: 'ios:device-ip',
  iosDeviceImage: 'ios:device-image',
  iosListApps: 'ios:list-apps',
  iosChooseIpa: 'ios:choose-ipa',
  iosInstall: 'ios:install',
  iosUninstall: 'ios:uninstall',
  // iOS developer tier: userspace tunnel + process control
  iosTunnelStatus: 'ios:tunnel-status',
  iosTunnelStart: 'ios:tunnel-start',
  iosTunnelStop: 'ios:tunnel-stop',
  iosProcesses: 'ios:processes',
  iosLaunch: 'ios:launch',
  iosKill: 'ios:kill',
  // iOS screen mirror (macOS native AVFoundation/VideoToolbox H.264 helper)
  iosMirrorStart: 'ios-mirror:start',
  iosMirrorStop: 'ios-mirror:stop',
  iosMirrorSaveFrame: 'ios-mirror:save-frame', // save a canvas PNG to ~/Downloads
  iosMirrorH264: 'ios-mirror:h264', // event: raw Annex-B H.264 bytes (main -> renderer)
  iosMirrorState: 'ios-mirror:state', // event: status message
  iosMirrorFailed: 'ios-mirror:failed', // event: feed could not produce frames

  // network HTTP intercept (control invoke/handle + event streams)
  interceptStart: 'intercept:start',
  interceptStop: 'intercept:stop',
  interceptSetDecrypt: 'intercept:set-decrypt',
  interceptInstallCert: 'intercept:install-cert',
  interceptDetail: 'intercept:detail',
  interceptSaveBody: 'intercept:save-body',
  interceptDownloadFlow: 'intercept:download-flow',
  // intercept events (main -> renderer)
  interceptFlows: 'intercept:flows',
  interceptStarted: 'intercept:started',
  interceptStatus: 'intercept:status',
  interceptFailed: 'intercept:failed',

  // system helpers
  systemOpenPath: 'system:open-path',

  // native menu -> renderer
  menuAction: 'menu:action'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
