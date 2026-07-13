/**
 * Toolbox pure builders/parsers. Faithful, Qt-free port of the five small
 * dev-tool modules:
 *   - intents.py   -> buildAmArgs (+ AM_MODES / EXTRA_TYPES)
 *   - stress.py    -> monkeyArgs + KILL_MONKEY (+ isMonkeyCrash)
 *   - perfetto.py  -> perfettoArgs / pullTraceArgs (+ PERFETTO_PRESETS/DURATIONS)
 *   - notifs.py    -> parseNotifications (+ NotifItem)
 *   - bugreport.py -> parseBugreportProgress
 *
 * Every builder returns adb args WITHOUT the leading `-s <serial>` (the service
 * prepends it via adb.run, mirroring the controls.ts setter convention).
 */

// --- Intents (intents.py) ---------------------------------------------------
export type AmVerb = 'start' | 'broadcast' | 'startservice'

export const AM_MODES: Array<[string, AmVerb]> = [
  ['Start activity', 'start'],
  ['Send broadcast', 'broadcast'],
  ['Start service', 'startservice']
]

export const EXTRA_TYPES = ['string', 'int', 'long', 'float', 'boolean'] as const
export type ExtraType = (typeof EXTRA_TYPES)[number]

const EXTRA_FLAG: Record<ExtraType, string> = {
  string: '--es',
  int: '--ei',
  long: '--el',
  float: '--ef',
  boolean: '--ez'
}

/** One typed extra for an `am` invocation. */
export interface IntentExtra {
  type: ExtraType
  key: string
  value: string
}

/** A composed intent: verb + optional action/data/mime/component + extras. */
export interface IntentSpec {
  verb: AmVerb
  action?: string
  data?: string
  mime?: string
  component?: string
  extras?: IntentExtra[]
}

/** adb args for one `am` invocation. `start` waits (-W) so the resolver
 *  result (or error) comes back. Mirrors intents.build_am_args. */
export function buildAmArgs(spec: IntentSpec): string[] {
  const cmd = ['shell', 'am', spec.verb]
  if (spec.verb === 'start') cmd.push('-W')
  if (spec.action) cmd.push('-a', spec.action)
  if (spec.data) cmd.push('-d', spec.data)
  if (spec.mime) cmd.push('-t', spec.mime)
  if (spec.component) cmd.push('-n', spec.component)
  for (const e of spec.extras ?? []) {
    const flag = EXTRA_FLAG[e.type]
    if (flag && e.key) cmd.push(flag, e.key, e.value)
  }
  return cmd
}

/** `am` reports bad intents on stdout — mirrors AmWorker's heuristic. */
export function intentLooksBad(output: string, code: number | null): boolean {
  return (
    output.includes('Error') ||
    output.includes('Exception') ||
    output.includes('does not exist') ||
    output.includes('Activity not started') ||
    (code !== null && code !== 0)
  )
}

// --- Monkey (stress.py) -----------------------------------------------------
/** Kill any monkey left on the device (its cmdline is the am jar invocation). */
export const KILL_MONKEY = 'kill -9 $(pgrep -f com.android.commands.monkey) 2>/dev/null; true'

export function monkeyArgs(pkg: string, events: number, seed: number, throttleMs: number): string[] {
  return [
    'shell',
    'monkey',
    '-p',
    pkg,
    '-s',
    String(seed),
    '--throttle',
    String(throttleMs),
    '--ignore-security-exceptions',
    '-v',
    String(events)
  ]
}

/** A monkey line that means the app crashed or ANR'd. */
export function isMonkeyCrash(line: string): boolean {
  return line.includes('// CRASH') || line.includes('// NOT RESPONDING')
}

// --- Perfetto (perfetto.py) -------------------------------------------------
export const REMOTE_TRACE = '/data/misc/perfetto-traces/logcatviewer.perfetto-trace'

export const PERFETTO_PRESETS: Array<[string, string[]]> = [
  ['UI / jank', ['gfx', 'view', 'wm', 'am', 'input', 'sched', 'freq']],
  ['Scheduling', ['sched', 'freq', 'idle', 'binder_driver']],
  ['Memory', ['am', 'dalvik', 'memory', 'sched']],
  [
    'Everything',
    ['gfx', 'view', 'wm', 'am', 'input', 'sched', 'freq', 'idle', 'binder_driver', 'dalvik', 'memory', 'hal', 'res']
  ]
]

export const PERFETTO_DURATIONS: Array<[string, number]> = [
  ['5 s', 5],
  ['10 s', 10],
  ['30 s', 30],
  ['60 s', 60]
]

export function perfettoArgs(durationS: number, categories: string[]): string[] {
  return ['shell', 'perfetto', '-o', REMOTE_TRACE, '-t', `${durationS}s`, ...categories]
}

export function pullTraceArgs(dest: string): string[] {
  return ['pull', REMOTE_TRACE, dest]
}

// --- Notifications (notifs.py) ----------------------------------------------
/** One active notification pulled from `dumpsys notification --noredact`. */
export interface NotifItem {
  pkg: string
  channel: string
  title: string
  text: string
  when: string
  key: string
}

const REC_RE = /NotificationRecord\([^)]*pkg=(\S+?)[\s)]/g
const FIELD_RES: Array<[Exclude<keyof NotifItem, 'pkg'>, RegExp]> = [
  ['title', /android\.title=(?:String\s*)?\((.*?)\)/],
  ['text', /android\.text=(?:String\s*)?\((.*?)\)/],
  ['channel', /NotificationChannel\{[^}]*?m?[Ii]d='([^']+)'/],
  ['when', /when=(\S+)/],
  ['key', /key=(\S+)/]
]

/** Split the dump into NotificationRecord blocks and pull the fields we can
 *  rely on across Android versions. Deduped by `key` (the dump repeats records
 *  across several sections). Mirrors notifs.parse_notifications. */
export function parseNotifications(text: string): NotifItem[] {
  const heads = [...text.matchAll(REC_RE)]
  const items: NotifItem[] = []
  const seen = new Set<string>()
  for (let i = 0; i < heads.length; i++) {
    const start = heads[i].index ?? 0
    const end = i + 1 < heads.length ? (heads[i + 1].index ?? text.length) : text.length
    const block = text.slice(start, end)
    const it: NotifItem = { pkg: heads[i][1], channel: '', title: '', text: '', when: '', key: '' }
    for (const [name, rx] of FIELD_RES) {
      const fm = rx.exec(block)
      if (fm) it[name] = fm[1]
    }
    if (it.key && seen.has(it.key)) continue
    seen.add(it.key || `${it.pkg}/${items.length}`)
    items.push(it)
  }
  return items
}

// --- Bugreport (bugreport.py) -----------------------------------------------
const PCT_RE = /(\d+)[%/]/

/** Parse a `[ 55%/100%]`-style adb progress line to 0..100, or null. */
export function parseBugreportProgress(line: string): number | null {
  const m = PCT_RE.exec(line)
  return m ? Math.min(100, parseInt(m[1], 10)) : null
}
