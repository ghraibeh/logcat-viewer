/**
 * Crash & ANR viewer pure helpers. Faithful, Qt-free port of crash.py's layer:
 * the adb arg builders, the crash-buffer / dropbox block splitters, crash
 * grouping (×N badges), trace-line classification, the themed-HTML renderer
 * (fold/unfold framework runs, Caused-by chain links, app-frame highlight,
 * obfuscation banner), the R8/ProGuard mapping parser + retracer, and the
 * obfuscation heuristic. DOM-/adb-/fs-free so it is unit-tested directly; the
 * device I/O + mapping persistence live in main/services/crash.ts.
 *
 * Every arg builder returns adb args WITH the leading `-s <serial>` (mirroring
 * the sibling core modules; the service passes serial=null to adb.run).
 */
import { parseLine } from './parser'

// Palette (mirrors logcat_viewer/theme.py — kept local so this core stays
// renderer-agnostic and testable without importing the renderer theme).
const C = {
  BG: '#16171c',
  SURFACE: '#1c1e24',
  SURFACE_2: '#252831',
  TEXT: '#e9ebf3',
  TEXT_DIM: '#7e8595',
  ACCENT: '#6e7bff',
  ACCENT_H: '#8b96ff',
  GREEN: '#31c96e',
  RED: '#f25a52',
  AMBER: '#e3a812'
} as const

// Dropbox tags that hold crash-ish records.
export const CRASH_TAGS = [
  'data_app_crash',
  'data_app_anr',
  'data_app_wtf',
  'data_app_native_crash',
  'system_app_crash',
  'system_app_anr',
  'system_app_wtf',
  'system_server_crash'
] as const

export const KIND_COLOR: Record<string, string> = {
  crash: C.RED,
  anr: C.AMBER,
  native: '#c678dd',
  wtf: C.TEXT_DIM
}
export const KIND_LABEL: Record<string, string> = { crash: 'CRASH', anr: 'ANR', native: 'NATIVE', wtf: 'WTF' }
export const KIND_GLYPH: Record<string, string> = { crash: '💥', anr: '⏳', native: '🧨', wtf: '⚠️' }

// Runs of more than this many consecutive framework frames fold behind a link.
export const FOLD_THRESHOLD = 3

/** One crash/ANR record. */
export interface CrashItem {
  kind: string // "crash" | "anr" | "native" | "wtf"
  when: string
  process: string
  title: string
  text: string
  source: string // "crash buffer" | dropbox tag
  plain: string // messages only (no threadtime prefixes) — what we render
}

/** A group of identical crashes (×N). */
export interface CrashGroup {
  sig: string
  item: CrashItem
  count: number
  items: CrashItem[]
}

// --- pure adb arg builders ----------------------------------------------------
export function crashBufferArgs(serial: string): string[] {
  return ['-s', serial, 'logcat', '-b', 'crash', '-v', 'threadtime', '-d']
}

export function dropboxPrintArgs(serial: string, tag: string): string[] {
  return ['-s', serial, 'shell', 'dumpsys', 'dropbox', '--print', tag]
}

// --- mimic Python str.splitlines() (drops a single trailing line break) -------
function splitLines(s: string): string[] {
  if (s === '') return []
  const parts = s.split(/\r\n|\r|\n/)
  if (parts.length > 0 && parts[parts.length - 1] === '' && /(\r\n|\r|\n)$/.test(s)) parts.pop()
  return parts
}

/** strip leading/trailing chars in `chars` (mirrors Python str.strip(set)). */
function pyStrip(s: string, chars: string): string {
  let i = 0
  let j = s.length
  while (i < j && chars.includes(s[i])) i++
  while (j > i && chars.includes(s[j - 1])) j--
  return s.slice(i, j)
}

// --- headline + block splitting -----------------------------------------------
const PROCESS_RE = /Process:\s*(\S+?),?\s+PID:/
const PKG_LINE_RE = /^(?:Package|Process):\s*(\S+?)(?:\s|,|$)/m
const ANR_RE = /ANR in (\S+)/
const EXC_RE = /^([\w.$]+(?:Exception|Error|Throwable|Death)[\w.$]*)(?::\s*(.*))?$/

function headline(body: string): string {
  const anr = ANR_RE.exec(body)
  if (anr) return `ANR in ${anr[1]}`
  for (const raw of splitLines(body)) {
    const line = raw.trim()
    if (EXC_RE.test(line)) return line.slice(0, 200)
  }
  return ''
}

/** Split `logcat -b crash -d` output into per-crash blocks. Mirrors
 *  crash.split_crash_blocks. */
export function splitCrashBlocks(text: string): CrashItem[] {
  const blocks: CrashItem[] = []
  let curPid: number | null = null
  let curLines: string[] = []
  let curMsgs: string[] = []
  let curWhen = ''

  const flush = (): void => {
    if (curLines.length === 0) return
    const body = curLines.join('\n')
    const msgs = curMsgs.join('\n')
    let proc = ''
    const m = PROCESS_RE.exec(msgs) ?? ANR_RE.exec(msgs)
    if (m) proc = m[1]
    const firstLine = msgs.split('\n')[0] ?? ''
    const kind =
      msgs.includes('ANR in ')
        ? 'anr'
        : msgs.includes('*** ***') || firstLine.includes('signal ')
          ? 'native'
          : 'crash'
    blocks.push({
      kind,
      when: curWhen,
      process: proc,
      title: headline(msgs) || '(crash)',
      text: body,
      source: 'crash buffer',
      plain: msgs
    })
  }

  for (const raw of splitLines(text)) {
    const e = parseLine(raw)
    if (e === null) continue
    const startsNew = e.msg.startsWith('FATAL EXCEPTION') || e.msg.startsWith('ANR in ')
    if (e.pid !== curPid || startsNew) {
      flush()
      curLines = []
      curMsgs = []
      curPid = e.pid
      curWhen = e.time
    }
    curLines.push(
      `${e.time} ${String(e.pid).padStart(5)} ${String(e.tid).padStart(5)} ${e.level} ${e.tag}: ${e.msg}`
    )
    curMsgs.push(e.msg)
  }
  flush()
  return blocks
}

const DROP_HEAD_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (\S+) \(([^)]*)\)\s*$/gm

/** Split a `dumpsys dropbox --print <tag>` dump into entries. Mirrors
 *  crash.split_dropbox_print. */
export function splitDropboxPrint(text: string, tag: string): CrashItem[] {
  const items: CrashItem[] = []
  const heads = [...text.matchAll(DROP_HEAD_RE)]
  const low = tag.toLowerCase()
  const kind =
    tag.includes('anr')
      ? 'anr'
      : tag.includes('native') || low.includes('tombstone')
        ? 'native'
        : tag.includes('wtf')
          ? 'wtf'
          : 'crash'
  for (let i = 0; i < heads.length; i++) {
    const start = (heads[i].index ?? 0) + heads[i][0].length
    const end = i + 1 < heads.length ? (heads[i + 1].index ?? text.length) : text.length
    let body = text.slice(start, end)
    body = pyStrip(pyStrip(body, '\n='), '\n')
    if (!body) continue
    const pm = PKG_LINE_RE.exec(body)
    items.push({
      kind,
      when: heads[i][1],
      process: pm ? pm[1] : '',
      title: headline(body) || tag,
      text: body,
      source: tag,
      plain: body
    })
  }
  return items
}

// --- grouping -----------------------------------------------------------------
export function crashSignature(item: CrashItem): string {
  return `${item.kind}|${item.process}|${item.title}`
}

/** Collapse identical crashes into groups (input order preserved — pass
 *  newest-first). Mirrors crash.group_crashes. */
export function groupCrashes(items: CrashItem[]): CrashGroup[] {
  const groups = new Map<string, CrashGroup>()
  const order: CrashGroup[] = []
  for (const it of items) {
    const sig = crashSignature(it)
    let g = groups.get(sig)
    if (g === undefined) {
      g = { sig, item: it, count: 0, items: [] }
      groups.set(sig, g)
      order.push(g)
    }
    g.count += 1
    g.items.push(it)
  }
  return order
}

// --- trace-line classification ------------------------------------------------
const AT_RE = /^\s*at\s+([\w.$]+)\.([\w$<>]+)\((.*)\)\s*$/

export function isAppFrame(clsName: string, appPkg: string | null): boolean {
  if (!appPkg) return false
  const base = appPkg.split(':', 1)[0]
  return clsName === base || clsName.startsWith(base + '.')
}

export type TraceLineKind = 'exception' | 'cause' | 'frame-app' | 'frame' | 'text'

export function classifyTraceLine(line: string, appPkg: string | null = null): TraceLineKind {
  const s = line.trim()
  const m = AT_RE.exec(s)
  if (m) return isAppFrame(m[1], appPkg) ? 'frame-app' : 'frame'
  if (s.startsWith('Caused by:')) return 'cause'
  if (EXC_RE.test(s)) return 'exception'
  return 'text'
}

const OBF_FRAME_RE = /\bat\s+[a-zA-Z]\d?\.[a-zA-Z]\d?\./g

export function looksObfuscated(text: string): boolean {
  return (text.match(OBF_FRAME_RE) ?? []).length >= 2
}

// --- HTML rendering (QTextBrowser-compatible markup, rendered via innerHTML) ---
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function chip(label: string, color: string): string {
  return (
    `<span style='background-color:${color}; color:#101218; ` +
    `font-weight:700; font-size:11px'>&nbsp;${esc(label)}&nbsp;</span>`
  )
}

export interface CrashHtmlOptions {
  text?: string
  appPkg?: string | null
  expanded?: ReadonlySet<number>
  count?: number
  hintObfuscated?: boolean
  retraced?: boolean
}

/** Render one crash record as themed HTML. Mirrors crash.build_crash_html. */
export function buildCrashHtml(item: CrashItem, opts: CrashHtmlOptions = {}): string {
  const body = opts.text !== undefined ? opts.text : item.plain || item.text
  const expanded = opts.expanded ?? new Set<number>()
  const count = opts.count ?? 1
  const kcolor = KIND_COLOR[item.kind] ?? C.RED
  const appPkg = opts.appPkg ?? (item.process ? item.process.split(':', 1)[0] : null)

  const lines = splitLines(body)
  const causes: number[] = []
  lines.forEach((l, i) => {
    if (l.trim().startsWith('Caused by:')) causes.push(i)
  })

  // -- header ----------------------------------------------------------------
  const title = esc(item.title || '(crash)')
  let badges = chip(KIND_LABEL[item.kind] ?? 'CRASH', kcolor)
  if (count > 1) badges += '&nbsp;' + chip(`×${count}`, C.ACCENT)
  if (opts.retraced) badges += '&nbsp;' + chip('RETRACED', C.GREEN)
  const meta = [item.process || '(unknown process)', item.when, item.source]
    .filter(Boolean)
    .map(esc)
    .join('&nbsp;&nbsp;·&nbsp;&nbsp;')
  const head =
    `<table width='100%' cellpadding='6' style='background-color:${C.SURFACE}'>` +
    `<tr><td>` +
    `${badges}<br>` +
    `<span style='font-size:15px; font-weight:700; color:${kcolor}'>${title}</span><br>` +
    `<span style='color:${C.TEXT_DIM}; font-size:11px'>${meta}</span>` +
    `</td></tr></table>`

  // -- caused-by chain chips (root cause last in the trace → mark it) --------
  let chain = ''
  if (causes.length > 0) {
    const parts: string[] = []
    causes.forEach((i, n) => {
      const causeTxt = esc(lines[i].trim().slice('Caused by:'.length).trim().slice(0, 60))
      const mark = n === causes.length - 1 ? 'root cause — ' : ''
      parts.push(
        `<a href='#cause${n}' style='color:${C.ACCENT}'>↳ ${mark}${causeTxt}</a>`
      )
    })
    chain = `<div style='margin:6px 2px; color:${C.TEXT_DIM}'>` + parts.join('<br>') + '</div>'
  }

  let hint = ''
  if (opts.hintObfuscated) {
    hint =
      `<div style='background-color:${C.SURFACE_2}; color:${C.AMBER};` +
      ` font-size:12px'>&nbsp;🔒 This trace looks R8/ProGuard-obfuscated —` +
      ` load the build's mapping.txt to retrace it.&nbsp;</div>`
  }

  // -- stack body with framework-frame folding -------------------------------
  const out: string[] = []
  let foldRun: string[] = []
  let foldNo = 0
  let causeNo = 0

  const flushFold = (): void => {
    if (foldRun.length === 0) return
    if (foldRun.length <= FOLD_THRESHOLD || expanded.has(foldNo)) {
      out.push(...foldRun)
    } else {
      out.push(
        `<a href='fold:${foldNo}' style='color:${C.TEXT_DIM}'>` +
          `      ⋯ ${foldRun.length} framework frames (click to expand)</a>`
      )
    }
    foldNo += 1
    foldRun = []
  }

  for (const line of lines) {
    const kind = classifyTraceLine(line, appPkg)
    const e = esc(line)
    if (kind === 'frame') {
      foldRun.push(`<span style='color:${C.TEXT_DIM}'>${e}</span>`)
      continue
    }
    flushFold()
    if (kind === 'frame-app') {
      const m = AT_RE.exec(line.trim())
      if (m) {
        const loc = esc(m[3])
        out.push(
          `<span style='color:${C.TEXT}'>    at ` +
            `<b style='color:${C.ACCENT_H}'>${esc(m[1])}.${esc(m[2])}</b>` +
            `(<span style='color:${C.GREEN}'>${loc}</span>)</span>`
        )
      } else {
        out.push(`<span style='color:${C.ACCENT_H}'>${e}</span>`)
      }
    } else if (kind === 'cause') {
      out.push(`<a name='cause${causeNo}'></a><b style='color:${kcolor}'>${e}</b>`)
      causeNo += 1
    } else if (kind === 'exception') {
      out.push(`<b style='color:${kcolor}'>${e}</b>`)
    } else {
      out.push(`<span style='color:${C.TEXT}'>${e}</span>`)
    }
  }
  flushFold()

  const stack = `<pre style='font-family:Menlo,monospace; font-size:12px'>` + out.join('\n') + '</pre>'
  return `<body style='background-color:${C.BG}; color:${C.TEXT}'>${head}${hint}${chain}${stack}</body>`
}

// --- R8 / ProGuard retrace (best-effort) --------------------------------------
const MAP_CLASS_RE = /^([\w.$]+) -> ([\w.$]+):$/
const MAP_METHOD_RE =
  /^\s+(?:(\d+):(\d+):)?[\w.$[\]]+ ([\w$<>]+)\([^)]*\)(?::(\d+))?(?::(\d+))? -> ([\w$<>]+)$/

type MethodEntry = [number | null, number | null, string, number | null]

export interface Mapping {
  classes: Record<string, string> // obf class -> original class
  methods: Record<string, MethodEntry[]> // "obfClass obfMethod" -> entries
}

const methodKey = (cls: string, method: string): string => `${cls} ${method}`

export function parseMapping(text: string): Mapping {
  const mp: Mapping = { classes: {}, methods: {} }
  let curObf: string | null = null
  for (const line of splitLines(text)) {
    if (line.startsWith('#')) continue
    const cm = MAP_CLASS_RE.exec(line)
    if (cm) {
      mp.classes[cm[2]] = cm[1]
      curObf = cm[2]
      continue
    }
    if (curObf === null) continue
    const mm = MAP_METHOD_RE.exec(line)
    if (mm) {
      const [, start, end, origName, origStart, , obfMethod] = mm
      const key = methodKey(curObf, obfMethod)
      ;(mp.methods[key] ??= []).push([
        start ? parseInt(start, 10) : null,
        end ? parseInt(end, 10) : null,
        origName,
        origStart ? parseInt(origStart, 10) : null
      ])
    }
  }
  return mp
}

const FRAME_RE = /(\bat\s+)([\w.$]+)\.([\w$<>]+)\(([^():]*)(?::(\d+))?\)/
const FRAME_RE_G = new RegExp(FRAME_RE.source, 'g')
const TOKEN_RE_G = /[\w.$]{2,}/g

function mapFrame(
  mp: Mapping,
  atPrefix: string,
  obfCls: string,
  obfM: string,
  filePart: string,
  lineS: string | undefined
): string {
  const cls = mp.classes[obfCls] ?? obfCls
  const line = lineS ? parseInt(lineS, 10) : null
  let name = obfM
  let outLine = line
  for (const [start, end, origName, origStart] of mp.methods[methodKey(obfCls, obfM)] ?? []) {
    if (line === null || start === null || (start <= line && line <= (end || start))) {
      name = origName
      if (line !== null && origStart !== null && start !== null) outLine = origStart + (line - start)
      else if (origStart !== null) outLine = origStart
      if (line !== null && start !== null) break
    }
  }
  const src =
    cls !== obfCls && (filePart === '' || filePart === 'SourceFile' || filePart === 'Unknown Source')
      ? cls.split('.').pop()!.split('$', 1)[0] + '.java'
      : filePart
  const tail = outLine !== null ? `(${src}:${outLine})` : `(${src})`
  return `${atPrefix}${cls}.${name}${tail}`
}

/** De-obfuscate stack frames + bare obfuscated class tokens. Mirrors crash.retrace. */
export function retrace(mp: Mapping, text: string): string {
  const out: string[] = []
  for (const rawLine of splitLines(text)) {
    let line = rawLine
    if (FRAME_RE.test(line)) {
      line = line.replace(FRAME_RE_G, (_full, p1, p2, p3, p4, p5) =>
        mapFrame(mp, p1, p2, p3, p4, p5)
      )
    } else {
      line = line.replace(TOKEN_RE_G, (tok) => mp.classes[tok] ?? tok)
    }
    out.push(line)
  }
  return out.join('\n')
}
