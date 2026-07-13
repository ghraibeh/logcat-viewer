/**
 * SharedPreferences editor pure helpers. Faithful, Qt-free port of prefs.py's
 * layer: the adb command builders (run-as + rooted `su` variants), the listing
 * classifier, the SharedPreferences XML parser/builder (the exact shape Android
 * writes — string-sets flatten to a read-only comma view), and the typed-value
 * validator. DOM-/adb-/fs-free so it is unit-tested directly; the device I/O
 * lives in main/services/prefs.ts.
 *
 * Every builder returns adb args WITH the leading `-s <serial>` (mirroring
 * files.py / dbinspect.py: the service passes serial=null to adb.run).
 */
import { XMLParser } from 'fast-xml-parser'

export const PREFS_DIR = 'shared_prefs'

/** One typed SharedPreferences entry. `value` is the display/edit string
 *  ("a, b" for string-sets). */
export interface Pref {
  key: string
  /** string | int | long | float | boolean | set */
  type: string
  value: string
}

// --- pure adb command builders ------------------------------------------------
function prefix(su: boolean, pkg: string): string[] {
  return su ? ['su', '-c'] : ['run-as', pkg]
}

export function lsPrefsArgs(serial: string, pkg: string, su = false): string[] {
  const d = su ? `/data/data/${pkg}/${PREFS_DIR}` : PREFS_DIR
  return ['-s', serial, 'shell', ...prefix(su, pkg), 'ls', d]
}

export function catPrefArgs(serial: string, pkg: string, fname: string, su = false): string[] {
  const d = su ? `/data/data/${pkg}/${PREFS_DIR}/${fname}` : `${PREFS_DIR}/${fname}`
  return ['-s', serial, 'exec-out', ...prefix(su, pkg), 'cat', d]
}

export function writePrefArgs(serial: string, pkg: string, fname: string, su = false): string[] {
  const d = su ? `/data/data/${pkg}/${PREFS_DIR}/${fname}` : `${PREFS_DIR}/${fname}`
  return ['-s', serial, 'shell', ...prefix(su, pkg), 'dd', `of=${d}`]
}

/** Classify a `ls shared_prefs` result (mirrors PrefListWorker._ls). */
export interface PrefsListing {
  ok: boolean
  files: string[]
  error: string
}

export function classifyPrefsList(code: number, stdout: string, stderr: string): PrefsListing {
  const combo = (stdout + stderr).toLowerCase()
  const bad =
    code !== 0 ||
    combo.includes('not debuggable') ||
    combo.includes('no such') ||
    stderr.toLowerCase().includes('denied')
  const files = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.endsWith('.xml'))
  return { ok: !bad, files, error: (stderr || stdout).trim() }
}

// --- SharedPreferences XML parse (order-preserving) ---------------------------
const PREFS_XML = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  processEntities: true,
  preserveOrder: true,
  trimValues: false,
  textNodeName: '#text'
})

type OrderedNode = Record<string, unknown> & { ':@'?: Record<string, string> }

function textOf(kids: unknown): string {
  if (!Array.isArray(kids)) return ''
  const t = kids.find((k) => k && typeof k === 'object' && '#text' in (k as object))
  return t ? String((t as Record<string, unknown>)['#text']) : ''
}

/** SharedPreferences XML -> typed rows. String-sets flatten to a comma view
 *  (read-only in the editor). Mirrors prefs.parse_prefs_xml; never throws. */
export function parsePrefsXml(text: string): Pref[] {
  const start = text.indexOf('<')
  if (start < 0) return []
  let parsed: OrderedNode[]
  try {
    parsed = PREFS_XML.parse(text.slice(start)) as OrderedNode[]
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const mapNode = parsed.find((n) => n && typeof n === 'object' && 'map' in n)
  const children = mapNode ? (mapNode.map as OrderedNode[]) : null
  if (!Array.isArray(children)) return []

  const out: Pref[] = []
  for (const child of children) {
    const tag = Object.keys(child).find((k) => k !== ':@' && k !== '#text')
    if (!tag) continue
    const attrs = child[':@'] ?? {}
    const key = attrs['@_name'] ?? ''
    if (tag === 'string') {
      out.push({ key, type: 'string', value: textOf(child.string) })
    } else if (tag === 'int' || tag === 'long' || tag === 'float' || tag === 'boolean') {
      out.push({ key, type: tag, value: String(attrs['@_value'] ?? '') })
    } else if (tag === 'set') {
      const kids = Array.isArray(child.set) ? (child.set as OrderedNode[]) : []
      const vals = kids
        .filter((k) => 'string' in k)
        .map((k) => textOf(k.string))
      out.push({ key, type: 'set', value: vals.join(', ') })
    }
  }
  return out
}

// --- SharedPreferences XML build (matches xml.sax.saxutils escape/quoteattr) ---
function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Faithful port of xml.sax.saxutils.quoteattr: escape &/</> plus \n\t\r, then
 *  wrap in the appropriate quote char. */
function quoteAttr(s: string): string {
  let data = escapeText(s).replace(/\n/g, '&#10;').replace(/\t/g, '&#9;').replace(/\r/g, '&#13;')
  if (data.includes('"')) {
    if (data.includes("'")) data = `"${data.replace(/"/g, '&quot;')}"`
    else data = `'${data}'`
  } else {
    data = `"${data}"`
  }
  return data
}

/** Rows -> SharedPreferences XML (the exact shape Android writes). Mirrors
 *  prefs.build_prefs_xml. */
export function buildPrefsXml(prefs: Pref[]): string {
  const lines = ["<?xml version='1.0' encoding='utf-8' standalone='yes' ?>", '<map>']
  for (const p of prefs) {
    const name = quoteAttr(p.key)
    if (p.type === 'string') {
      lines.push(`    <string name=${name}>${escapeText(p.value)}</string>`)
    } else if (p.type === 'set') {
      lines.push(`    <set name=${name}>`)
      for (const v of p.value.split(',').map((s) => s.trim()).filter(Boolean)) {
        lines.push(`        <string>${escapeText(v)}</string>`)
      }
      lines.push('    </set>')
    } else {
      lines.push(`    <${p.type} name=${name} value=${quoteAttr(p.value)} />`)
    }
  }
  lines.push('</map>')
  return lines.join('\n') + '\n'
}

/** null if `value` fits the type, else a human error. Mirrors validate_pref_value. */
export function validatePrefValue(type: string, value: string): string | null {
  if (type === 'int') {
    if (!/^[+-]?\d+$/.test(value.trim())) return 'not a valid int'
    const v = Number(value)
    if (!(v >= -(2 ** 31) && v < 2 ** 31)) return 'int out of 32-bit range'
  } else if (type === 'long') {
    if (!/^[+-]?\d+$/.test(value.trim())) return 'not a valid long'
  } else if (type === 'float') {
    if (value.trim() === '' || Number.isNaN(Number(value))) return 'not a valid float'
  } else if (type === 'boolean') {
    if (value !== 'true' && value !== 'false') return 'boolean must be true or false'
  }
  return null
}
