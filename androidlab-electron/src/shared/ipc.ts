/** IPC channel names — single source of truth for main + preload. */
export const IPC = {
  // adb queries (invoke/handle)
  adbFind: 'adb:find',
  adbListDevices: 'adb:list-devices',
  adbListApps: 'adb:list-apps',
  adbResolvePids: 'adb:resolve-pids',
  adbForceCrash: 'adb:force-crash',

  // logcat stream control (invoke/handle)
  logcatStart: 'logcat:start',
  logcatStop: 'logcat:stop',
  logcatRunning: 'logcat:running',
  // logcat stream events (main -> renderer)
  logcatLines: 'logcat:lines',
  logcatState: 'logcat:state',
  logcatError: 'logcat:error',

  // performance monitor (invoke/handle + events)
  monitorStart: 'monitor:start',
  monitorStop: 'monitor:stop',
  monitorSample: 'monitor:sample',
  monitorFailed: 'monitor:failed',

  // layout inspector (invoke/handle)
  inspectCapture: 'inspect:capture',

  // device controls (invoke/handle)
  controlsRead: 'controls:read',
  controlsApply: 'controls:apply',

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
  apkChoose: 'apk:choose',
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

  // system helpers
  systemOpenPath: 'system:open-path',

  // native menu -> renderer
  menuAction: 'menu:action'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
