/**
 * Memory-leak detection (LeakCanary/Shark) — pure helpers. Faithful port of the
 * DOM/adb-free parts of logcat_viewer/leakdetect.py: the Shark jar set + Maven /
 * Adoptium URL builders, the heap-dump-failed heuristic, the one-line summary,
 * and the text-report → visual-HTML renderer. The provisioning + capture worker
 * lives in main/services/leakdetect.ts; these are unit-tested directly.
 *
 * No app instrumentation: a **debuggable** app's managed heap is captured with
 * `am dumpheap`, pulled, and analyzed by Shark's `analyze` command — producing
 * the same application-leak traces LeakCanary prints in-app.
 */

export const SHARK_VERSION = '2.14'
export const SHARK_MAIN = 'shark.MainKt'
export const MAVEN = 'https://repo1.maven.org/maven2'

/** Where the managed heap dump is written on the device before we pull it. */
export const REMOTE_HPROF = '/data/local/tmp/androidlab-leak.hprof'

/** One Maven artifact: [group path, artifact id, version]. */
export type SharkJar = readonly [string, string, string]

/**
 * The exact jar set the Shark `analyze` command needs. The neo4j / interactive
 * deps are omitted — they're only class-loaded by the `neo4j` / `interactive`
 * commands we never invoke.
 */
export const SHARK_JARS: readonly SharkJar[] = [
  ['com/squareup/leakcanary', 'shark-cli', SHARK_VERSION],
  ['com/squareup/leakcanary', 'shark-android', SHARK_VERSION],
  ['com/squareup/leakcanary', 'shark', SHARK_VERSION],
  ['com/squareup/leakcanary', 'shark-graph', SHARK_VERSION],
  ['com/squareup/leakcanary', 'shark-hprof', SHARK_VERSION],
  ['com/squareup/leakcanary', 'shark-log', SHARK_VERSION],
  ['org/jetbrains/kotlin', 'kotlin-stdlib', '1.3.72'],
  ['org/jetbrains/kotlin', 'kotlin-reflect', '1.3.72'],
  ['org/jetbrains', 'annotations', '13.0'],
  ['com/squareup/okio', 'okio', '2.2.2'],
  ['com/github/ajalt', 'clikt', '2.3.0'],
  ['jline', 'jline', '2.14.6']
]

/** Local filename a jar is cached under (matches the Maven artifact name). */
export function jarFilename(artifact: string, version: string): string {
  return `${artifact}-${version}.jar`
}

/** Maven Central download URL for one jar. */
export function jarUrl([path, artifact, version]: SharkJar): string {
  return `${MAVEN}/${path}/${artifact}/${version}/${jarFilename(artifact, version)}`
}

/** Adoptium latest-JRE-21 binary URL for this Mac's CPU (mirrors _adoptium_url). */
export function adoptiumUrl(machine: string): string {
  const arch = ['arm64', 'aarch64'].includes(machine.toLowerCase()) ? 'aarch64' : 'x64'
  return `https://api.adoptium.net/v3/binary/latest/21/ga/mac/${arch}/jre/hotspot/normal/eclipse`
}

/**
 * True if `am dumpheap`'s combined stdout+stderr indicates it never produced a
 * dump (app not debuggable / gone / permission denied). Mirrors the Python
 * blob-keyword check.
 */
export function heapDumpFailed(blob: string): boolean {
  const b = blob.toLowerCase()
  return ['not debuggable', 'unknown package', 'no process', 'exception', 'permission deni'].some(
    (k) => b.includes(k)
  )
}

/** One-line headline pulled from Shark's report text (mirrors leak_summary). */
export function leakSummary(report: string): string {
  const m = /(\d+)\s+APPLICATION LEAKS/.exec(report)
  if (m) {
    const n = parseInt(m[1], 10)
    return n === 0 ? 'No application leaks found ✓' : `${n} application leak(s) found`
  }
  return 'Analysis complete'
}

/** A finished Shark report that carries at least the application-leaks section. */
export function isValidReport(report: string): boolean {
  return report.includes('APPLICATION LEAKS')
}

// --- text report → visual HTML -----------------------------------------------
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function count(report: string, label: string): number {
  const m = new RegExp(`(\\d+)\\s+${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).exec(report)
  return m ? parseInt(m[1], 10) : 0
}

/** Parse the METADATA block into a key→value map (mirrors _parse_metadata). */
export function parseMetadata(report: string): Record<string, string> {
  const md: Record<string, string> = {}
  const i = report.indexOf('METADATA')
  if (i < 0) return md
  for (const line of report.slice(i + 'METADATA'.length).split('\n')) {
    const t = line.trim()
    if (t.length > 0 && /^=+$/.test(t)) break
    const ci = line.indexOf(':')
    if (ci < 0) continue
    const k = line.slice(0, ci).trim()
    const v = line.slice(ci + 1).trim()
    if (k && v) md[k] = v
  }
  return md
}

/** Split the report on Shark's '====' separator lines (mirrors _split_blocks). */
export function splitBlocks(report: string): string[] {
  const blocks: string[] = []
  let cur: string[] = []
  for (const line of report.split('\n')) {
    const t = line.trim()
    if (t.length >= 4 && /^=+$/.test(t)) {
      if (cur.length > 0) {
        blocks.push(cur.join('\n'))
        cur = []
      }
    } else {
      cur.push(line)
    }
  }
  if (cur.length > 0) blocks.push(cur.join('\n'))
  return blocks
}

function isTrace(block: string): boolean {
  return ['Leaking:', 'GC Root:', 'bytes retained'].some((k) => block.includes(k))
}

/**
 * Pull the individual leak traces out of a section block. Real Shark output
 * keeps the "N APPLICATION LEAKS" header, its preamble, and every leak trace in
 * one block (traces are joined by blank lines, not '====' separators), so we
 * split on blank-line runs and keep the paragraphs that look like traces. (The
 * connector lines inside a single trace are "│", never blank, so a trace never
 * gets fragmented.)
 */
function extractTraces(block: string): string[] {
  return block
    .split(/\n[ \t]*\n+/)
    .map((p) => p.replace(/\s+$/, ''))
    .filter((p) => p && isTrace(p))
}

const fmtInt = (v: string): string => {
  const n = parseInt(v, 10)
  return Number.isNaN(n) ? v : n.toLocaleString('en-US')
}
const fmtMb = (v: string): string => {
  const n = parseInt(v, 10)
  return Number.isNaN(n) ? v : `${(n / 1e6).toFixed(1)} MB`
}
const asIs = (v: string): string => v

// (tile label, metadata key, formatter) — mirrors _TILES.
const TILES: Array<[string, string, (v: string) => string]> = [
  ['Heap size', 'Heap total bytes', fmtMb],
  ['Instances', 'Instance count', fmtInt],
  ['Classes', 'Class count', fmtInt],
  ['Threads', 'Thread count', fmtInt],
  ['Bitmaps', 'Bitmap count', fmtInt],
  ['Bitmap memory', 'Bitmap total bytes', fmtMb],
  ['Android SDK', 'Build.VERSION.SDK_INT', asIs],
  ['Manufacturer', 'Build.MANUFACTURER', asIs],
  ['Analysis time', 'Analysis duration', asIs]
]

/** Colorize a leak-trace block line-by-line, preserving the ASCII chain. */
function traceToHtml(block: string): string {
  const rows: string[] = []
  for (const line of block.split('\n')) {
    const e = esc(line) || '&nbsp;'
    let cls = ''
    if (line.includes('~~~')) cls = 'cause'
    else if (line.includes('Leaking: YES')) cls = 'yes'
    else if (line.includes('Leaking: NO')) cls = 'no'
    else if (line.includes('Leaking: UNKNOWN')) cls = 'unknown'
    else if (line.includes('GC Root:')) cls = 'root'
    else if (/^\s*(Signature:|[\d,]+ bytes retained)/.test(line)) cls = 'meta'
    rows.push(`<span class="${cls}">${e}</span>`)
  }
  return rows.join('\n')
}

function leakCard(block: string, index: number, glyph: string): string {
  const retained = /([\d,]+) bytes retained/.exec(block)
  const sig = /Signature:\s*(\w+)/.exec(block)
  const bits = [`Leak #${index}`]
  if (retained) {
    const n = parseInt(retained[1].replace(/,/g, ''), 10)
    if (!Number.isNaN(n)) bits.push(`${(n / 1024).toFixed(1)} KB retained`)
  }
  if (sig) bits.push(`signature ${sig[1].slice(0, 12)}`)
  const head = esc(bits.join('  ·  '))
  return (
    `<div class="card leak"><div class="leak-head">${glyph} ${head}</div>` +
    `<pre class="trace">${traceToHtml(block)}</pre></div>`
  )
}

/** The body HTML of the visual report (classes only) — rendered in-app. */
export function buildReportBody(pkg: string, report: string): string {
  const appLeaks = count(report, 'APPLICATION LEAKS')
  const libLeaks = count(report, 'LIBRARY LEAKS')
  const unreachable = count(report, 'UNREACHABLE OBJECTS')
  const md = parseMetadata(report)

  let section: string | null = null
  const appTraces: string[] = []
  const libTraces: string[] = []
  for (const b of splitBlocks(report)) {
    const head = b.split('\n').find((l) => l.trim()) ?? ''
    if (/^\d+\s+APPLICATION LEAKS/.test(head)) {
      section = 'app'
      appTraces.push(...extractTraces(b))
    } else if (/^\d+\s+LIBRARY LEAKS/.test(head)) {
      section = 'lib'
      libTraces.push(...extractTraces(b))
    } else if (/^\d+\s+UNREACHABLE/.test(head)) {
      section = 'unreach'
    } else if (head.startsWith('METADATA') || head.startsWith('HEAP ANALYSIS')) {
      section = 'meta'
    } else if (isTrace(b)) {
      // A trace in its own block (older / split output) → attach to the section.
      ;(section === 'app' ? appTraces : libTraces).push(b)
    }
  }

  const ok = appLeaks === 0
  const bannerClass = ok ? 'ok' : 'bad'
  const bannerNum = ok ? '0' : String(appLeaks)
  const bannerTxt = ok
    ? 'No application leaks 🎉'
    : `${appLeaks} application leak${appLeaks !== 1 ? 's' : ''} found`

  const tiles = TILES.filter(([, key]) => key in md)
    .map(
      ([label, key, fmt]) =>
        `<div class="tile"><div class="tv">${esc(fmt(md[key]))}</div>` +
        `<div class="tl">${label}</div></div>`
    )
    .join('')

  const sub =
    esc(pkg) +
    (libLeaks ? ` · ${libLeaks} library leaks` : '') +
    (unreachable ? ` · ${unreachable} unreachable objects` : '')

  const parts: string[] = [
    `<div class="banner ${bannerClass}"><div class="bignum">${bannerNum}</div>` +
      `<div><div class="btitle">${esc(bannerTxt)}</div>` +
      `<div class="bsub">${sub}</div></div></div>`
  ]
  if (tiles) parts.push(`<div class="tiles">${tiles}</div>`)
  if (appTraces.length > 0) {
    parts.push('<h2>Application leaks</h2>')
    appTraces.forEach((b, i) => parts.push(leakCard(b, i + 1, '🔴')))
  } else if (ok) {
    parts.push(
      '<div class="card note">No retained objects reached from your app were found in ' +
        'this heap dump. Reproduce the suspected leak (rotate, navigate away, etc.) then ' +
        'run detection again.</div>'
    )
  }
  if (libTraces.length > 0) {
    parts.push('<h2>Library leaks <span class="dim">(known 3rd-party bugs)</span></h2>')
    libTraces.forEach((b, i) => parts.push(leakCard(b, i + 1, '📚')))
  }
  parts.push(
    '<details class="raw"><summary>Raw Shark report</summary>' +
      `<pre>${esc(report)}</pre></details>`
  )
  return parts.join('')
}

/** Palette used to bake concrete colors into the standalone saved document. */
export interface LeakPalette {
  BG: string
  SURFACE: string
  SURFACE_2: string
  BORDER: string
  TEXT: string
  TEXT_DIM: string
  ACCENT: string
  GREEN: string
  RED: string
  AMBER: string
}

/** The report stylesheet, using CSS custom properties so it themes live. */
export const LEAK_REPORT_CSS = `
.leak-report { padding: 20px; font-size: 13px; color: var(--text); }
.leak-report * { box-sizing: border-box; }
.leak-report h2 { font-size: 15px; margin: 22px 4px 10px; font-weight: 600; }
.leak-report h2 .dim { color: var(--text-dim); font-weight: 400; font-size: 12px; }
.leak-report .banner { display: flex; align-items: center; gap: 16px; padding: 18px 20px;
  border-radius: 14px; border: 1px solid var(--border); background: var(--surface); }
.leak-report .banner.ok { border-left: 5px solid var(--green); }
.leak-report .banner.bad { border-left: 5px solid var(--red); }
.leak-report .bignum { font-size: 44px; font-weight: 800; line-height: 1; }
.leak-report .banner.ok .bignum { color: var(--green); }
.leak-report .banner.bad .bignum { color: var(--red); }
.leak-report .btitle { font-size: 17px; font-weight: 700; }
.leak-report .bsub { color: var(--text-dim); margin-top: 3px; font-family: var(--font-mono); font-size: 12px; }
.leak-report .tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 10px; margin-top: 14px; }
.leak-report .tile { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; }
.leak-report .tv { font-size: 20px; font-weight: 700; }
.leak-report .tl { color: var(--text-dim); font-size: 11px; text-transform: uppercase; letter-spacing: .6px; margin-top: 3px; }
.leak-report .card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
  padding: 0; margin: 10px 0; overflow: hidden; }
.leak-report .card.leak { border-left: 5px solid var(--red); }
.leak-report .leak-head { padding: 11px 15px; font-weight: 600; background: var(--surface-2);
  border-bottom: 1px solid var(--border); }
.leak-report .card.note { padding: 15px; color: var(--text-dim); }
.leak-report .trace { margin: 0; padding: 14px 16px; font-family: var(--font-mono); font-size: 12px;
  line-height: 1.5; white-space: pre; overflow-x: auto; }
.leak-report .trace .yes { color: var(--red); font-weight: 600; }
.leak-report .trace .no { color: var(--green); }
.leak-report .trace .unknown { color: var(--text-dim); }
.leak-report .trace .root { color: var(--accent); font-weight: 600; }
.leak-report .trace .cause { color: var(--amber); font-weight: 700; }
.leak-report .trace .meta { color: var(--text-dim); }
.leak-report .raw { margin-top: 22px; color: var(--text-dim); }
.leak-report .raw summary { cursor: pointer; padding: 8px 0; }
.leak-report .raw pre { background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
  padding: 14px; overflow-x: auto; font-family: var(--font-mono); font-size: 11px;
  white-space: pre; color: var(--text-dim); }
`

/**
 * A fully self-contained HTML document (for the "Save report…" affordance):
 * the report body wrapped with an embedded stylesheet whose theme variables are
 * pinned to the supplied palette so the file renders standalone.
 */
export function buildReportDocument(pkg: string, report: string, palette: LeakPalette): string {
  const rootVars =
    `:root{--bg:${palette.BG};--surface:${palette.SURFACE};--surface-2:${palette.SURFACE_2};` +
    `--border:${palette.BORDER};--text:${palette.TEXT};--text-dim:${palette.TEXT_DIM};` +
    `--accent:${palette.ACCENT};--green:${palette.GREEN};--red:${palette.RED};--amber:${palette.AMBER};` +
    `--font-mono:Menlo,monospace;}`
  const css =
    rootVars +
    'body{background:var(--bg);margin:0;font-family:-apple-system,"SF Pro Text","Helvetica Neue",Arial;}' +
    LEAK_REPORT_CSS
  return (
    `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head>` +
    `<body><div class="leak-report">${buildReportBody(pkg, report)}</div></body></html>`
  )
}
