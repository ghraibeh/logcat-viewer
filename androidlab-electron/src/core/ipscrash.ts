/**
 * Parse iOS `.ips` crash reports into the SAME CrashItem shape the Android crash
 * viewer renders — so `CrashView` is reused unchanged for iOS (see the
 * unify-the-UI rule). DOM-/fs-free and unit-tested; the device copy + file walk
 * live in main/services/goios.ts.
 *
 * `.ips` layout: line 1 is a small JSON header (bug_type, name/app_name,
 * bundleID, os_version, timestamp); the rest is the body — either a legacy TEXT
 * crash dump (e.g. *.cpu_resource) or a JSON payload (e.g. JetsamEvent, modern
 * app crashes). Pure diagnostics/analytics (.ca.synced, SFA-*, proactive_*, …)
 * are filtered out — they are not crashes.
 */
import type { CrashItem } from './crash'

const MAX_BODY = 40000

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}
function str(o: Record<string, unknown>, key: string): string {
  return typeof o[key] === 'string' ? (o[key] as string) : ''
}
function cap(s: string): string {
  return s.length > MAX_BODY ? s.slice(0, MAX_BODY) + '\n… (truncated)' : s
}
function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p
}
/** Fallback timestamp from a report filename like `Name-2026-07-09-105635.ips`. */
function dateFromName(fn: string): string {
  const m = /(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(fn)
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : ''
}

// Filename prefixes/markers that are analytics/diagnostics, never crashes. Only
// consulted for files that don't match a positive crash category below (so a real
// report like `spotlightknowledged.cpu_resource` is never skipped).
const SKIP_NAME = /(^analytics|^sfa-|^proactive|^xp_amp|app_usage|-dnu|\.ca\.synced|^awd|^summaries)/i

interface Category {
  kind: string
  source: string
  title: (name: string) => string
}

/** Classify by filename suffix (the reliable signal). null = not a crash-y file. */
function categorize(fnLower: string): Category | null {
  if (fnLower.includes('jetsamevent')) return { kind: 'native', source: 'JetsamEvent', title: () => 'Low-memory (Jetsam) termination' }
  if (fnLower.includes('.cpu_resource')) return { kind: 'anr', source: 'cpu_resource', title: (n) => `CPU resource limit — ${n}` }
  if (fnLower.includes('.wakeups_resource')) return { kind: 'anr', source: 'wakeups_resource', title: (n) => `Excessive wakeups — ${n}` }
  if (fnLower.includes('.diskwrites_resource') || fnLower.includes('.disk_resource')) return { kind: 'anr', source: 'disk_resource', title: (n) => `Excessive disk writes — ${n}` }
  if (fnLower.includes('-hang') || fnLower.includes('.hang')) return { kind: 'anr', source: 'hang', title: (n) => `Hang — ${n}` }
  return null
}

// bug_type codes that denote an app/process crash.
const CRASH_BUG_TYPES = new Set(['109', '309', '385', '208', '3', '113'])

function looksLikeCrash(bugType: string, body: string): boolean {
  if (CRASH_BUG_TYPES.has(bugType)) return true
  return /"exception"|"faultingThread"|Exception Type:|Crashed Thread:/.test(body.slice(0, 4000))
}

/** Readable summary for a JSON body (Jetsam memory report or an app crash). */
function summarizeJson(body: string): string {
  let b: Record<string, unknown>
  try {
    const p = JSON.parse(body)
    if (!isObj(p)) return cap(body)
    b = p
  } catch {
    return cap(body)
  }
  const lines: string[] = []
  // Jetsam / memory report.
  if ('largestProcess' in b || 'memoryStatus' in b) {
    if (b.largestProcess) lines.push(`Largest process: ${String(b.largestProcess)}`)
    const ms = isObj(b.memoryStatus) ? b.memoryStatus : null
    if (ms) {
      if (ms.pageSize) lines.push(`Page size: ${String(ms.pageSize)} bytes`)
      if (ms.memoryPages && isObj(ms.memoryPages)) {
        const mp = ms.memoryPages as Record<string, unknown>
        lines.push(`Memory pages — active ${mp.active ?? '?'}, free ${mp.free ?? '?'}, wired ${mp.wired ?? '?'}`)
      }
    }
    if (Array.isArray(b.processes)) {
      const procs = (b.processes as Array<Record<string, unknown>>)
        .filter(isObj)
        .map((p) => ({ name: str(p, 'name'), pid: p.pid, pages: typeof p.rpages === 'number' ? p.rpages : 0 }))
        .sort((x, y) => y.pages - x.pages)
        .slice(0, 12)
      lines.push('', `Top memory users (of ${(b.processes as unknown[]).length} processes):`)
      for (const p of procs) lines.push(`  ${p.name || '?'} (pid ${p.pid ?? '?'}) — ${p.pages} pages`)
    }
    return lines.join('\n')
  }
  // Modern app-crash JSON.
  const exc = isObj(b.exception) ? b.exception : null
  if (exc) lines.push(`Exception: ${str(exc, 'type')} ${str(exc, 'signal')} ${str(exc, 'subtype')}`.trim())
  const term = isObj(b.termination) ? b.termination : null
  if (term) {
    const reasons = Array.isArray(term.reasons) ? (term.reasons as unknown[]).join(' ') : ''
    lines.push(`Termination: ${str(term, 'namespace')} ${str(term, 'indicator')} ${reasons}`.trim())
  }
  const images = Array.isArray(b.usedImages) ? (b.usedImages as Array<Record<string, unknown>>) : []
  const threads = Array.isArray(b.threads) ? (b.threads as Array<Record<string, unknown>>) : []
  const faultIdx = typeof b.faultingThread === 'number' ? b.faultingThread : threads.findIndex((t) => t.triggered === true)
  const ft = faultIdx >= 0 ? threads[faultIdx] : undefined
  if (ft && Array.isArray(ft.frames)) {
    lines.push('', `Crashed thread ${faultIdx}:`)
    for (const f of (ft.frames as Array<Record<string, unknown>>).slice(0, 30)) {
      const img = typeof f.imageIndex === 'number' ? images[f.imageIndex] : undefined
      const imgName = img ? str(img, 'name') : ''
      lines.push(`  ${imgName || '?'} + ${f.imageOffset ?? '?'}`)
    }
  }
  return lines.length ? lines.join('\n') : cap(JSON.stringify(b, null, 2))
}

/** Parse one `.ips`/`.crash` report → CrashItem, or null if it isn't a crash. */
export function parseIpsReport(filename: string, raw: string): CrashItem | null {
  const fn = baseName(filename)
  const fnLower = fn.toLowerCase()

  const nl = raw.indexOf('\n')
  const headText = nl > 0 ? raw.slice(0, nl) : raw
  const body = nl > 0 ? raw.slice(nl + 1).trim() : ''
  let header: Record<string, unknown> = {}
  try {
    const h = JSON.parse(headText)
    if (isObj(h)) header = h
  } catch {
    /* legacy full-text report, handled below */
  }

  // Legacy full-text crash (no JSON header line).
  if (Object.keys(header).length === 0) {
    if (/Incident Identifier|Exception Type:|Crashed Thread:/.test(raw)) {
      return {
        kind: 'crash',
        when: dateFromName(fn),
        process: fn.split('-')[0],
        title: 'Crash',
        text: raw,
        source: 'crash',
        plain: cap(raw)
      }
    }
    return null
  }

  const bugType = header.bug_type != null ? String(header.bug_type) : ''
  const name = str(header, 'name') || str(header, 'app_name') || str(header, 'procName')
  const bundleId = str(header, 'bundleID') || str(header, 'bundle_id')
  const os = str(header, 'os_version')
  const when = str(header, 'timestamp') || dateFromName(fn)

  const cat = categorize(fnLower)
  let kind: string
  let source: string
  let title: string
  if (cat) {
    kind = cat.kind
    source = cat.source
    title = cat.title(name || fn.split('-')[0])
  } else if (!SKIP_NAME.test(fn) && looksLikeCrash(bugType, body)) {
    kind = 'crash'
    source = 'crash'
    title = `Crash — ${name || fn.split('-')[0]}`
  } else {
    return null // diagnostics / analytics with a JSON header but no crash
  }

  const rendered = body.startsWith('{') ? summarizeJson(body) : body || headText
  const metaHead = [
    `Process:  ${name || '?'}${bundleId ? `  (${bundleId})` : ''}`,
    `Type:     ${source}`,
    os ? `OS:       ${os}` : '',
    `Date:     ${when}`
  ]
    .filter(Boolean)
    .join('\n')
  const plain = `${metaHead}\n\n${cap(rendered)}`

  return {
    kind,
    when,
    process: bundleId || name || fn.split('-')[0],
    title,
    text: plain,
    source,
    plain
  }
}
