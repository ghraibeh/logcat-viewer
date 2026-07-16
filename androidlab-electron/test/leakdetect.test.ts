/**
 * Memory-leak detection parity tests — TS equivalents of leakdetect.py's pure
 * helpers: the Shark jar set / Maven + Adoptium URL builders, the dumpheap-
 * failed heuristic, the one-line summary, the metadata / block parsers, and the
 * text-report → visual-HTML renderer (banner, tiles, colorized traces, cards).
 */
import { describe, expect, it } from 'vitest'
import * as L from '@core/leakdetect'

// A realistic shark-cli `analyze` report: one block per section, with the leak
// trace living inside the "APPLICATION LEAKS" block (joined by blank lines).
const LEAK_REPORT = [
  '====================================',
  'HEAP ANALYSIS RESULT',
  '====================================',
  '1 APPLICATION LEAKS',
  '',
  'References underlined with "~~~" are likely causes.',
  'Learn more at https://squ.re/leaks.',
  '',
  '45677 bytes retained by leaking objects',
  'Signature: abc123def456aaaaaaaa',
  '┬───',
  '│ GC Root: System class',
  '│',
  '├─ com.example.app.MyApp instance',
  '│    Leaking: NO (Application is a singleton)',
  '│    ↓ MyApp.leakedActivity',
  '│               ~~~~~~~~~~~~~',
  '╰→ com.example.app.LeakyActivity instance',
  '     Leaking: YES (Activity#mDestroyed is true)',
  '====================================',
  '0 LIBRARY LEAKS',
  '',
  'Library leaks are leaks caused by a known bug in 3rd party code.',
  '====================================',
  '0 UNREACHABLE OBJECTS',
  '====================================',
  'METADATA',
  '',
  'Build.VERSION.SDK_INT: 33',
  'Build.MANUFACTURER: samsung',
  'Analysis duration: 5.30 s',
  'Heap total bytes: 45000000',
  'Instance count: 123456',
  'Class count: 4567',
  'Thread count: 42',
  'Bitmap count: 12',
  'Bitmap total bytes: 3000000',
  '===================================='
].join('\n')

const CLEAN_REPORT = [
  '====================================',
  'HEAP ANALYSIS RESULT',
  '====================================',
  '0 APPLICATION LEAKS',
  '====================================',
  '0 LIBRARY LEAKS',
  '====================================',
  'METADATA',
  '',
  'Build.VERSION.SDK_INT: 30',
  'Heap total bytes: 12000000',
  '===================================='
].join('\n')

describe('Shark jar set + URL builders', () => {
  it('pins the analyze-path jar set (neo4j/interactive omitted)', () => {
    const arts = L.SHARK_JARS.map(([, a]) => a)
    expect(arts).toContain('shark-cli')
    expect(arts).toContain('shark-android')
    expect(arts).toContain('kotlin-stdlib')
    expect(arts).not.toContain('neo4j')
    expect(L.SHARK_JARS.length).toBe(12)
  })

  it('builds a Maven Central jar URL + local filename', () => {
    const jar = L.SHARK_JARS[0] // shark-cli
    expect(L.jarFilename('shark-cli', L.SHARK_VERSION)).toBe(`shark-cli-${L.SHARK_VERSION}.jar`)
    expect(L.jarUrl(jar)).toBe(
      `${L.MAVEN}/com/squareup/leakcanary/shark-cli/${L.SHARK_VERSION}/shark-cli-${L.SHARK_VERSION}.jar`
    )
  })

  it('picks the Adoptium JRE binary for the CPU', () => {
    expect(L.adoptiumUrl('arm64')).toContain('/mac/aarch64/jre/hotspot/normal/eclipse')
    expect(L.adoptiumUrl('aarch64')).toContain('/mac/aarch64/')
    expect(L.adoptiumUrl('x64')).toContain('/mac/x64/')
    expect(L.adoptiumUrl('x86_64')).toContain('/mac/x64/')
    expect(L.adoptiumUrl('arm64')).toContain('api.adoptium.net/v3/binary/latest/21/ga')
  })
})

describe('heapDumpFailed', () => {
  it('flags the not-debuggable / gone / denied blobs', () => {
    expect(L.heapDumpFailed('Unknown package: com.foo')).toBe(true)
    expect(L.heapDumpFailed('Package not debuggable: com.foo')).toBe(true)
    expect(L.heapDumpFailed('No process found for: com.foo')).toBe(true)
    expect(L.heapDumpFailed('java.lang.SecurityException: Permission denied')).toBe(true)
    expect(L.heapDumpFailed('')).toBe(false)
    expect(L.heapDumpFailed('Dumping to /data/local/tmp/x.hprof')).toBe(false)
  })
})

describe('leakSummary + isValidReport', () => {
  it('headlines the application-leak count', () => {
    expect(L.leakSummary(LEAK_REPORT)).toBe('1 application leak(s) found')
    expect(L.leakSummary(CLEAN_REPORT)).toBe('No application leaks found ✓')
    expect(L.leakSummary('garbage')).toBe('Analysis complete')
  })
  it('recognizes a finished report', () => {
    expect(L.isValidReport(LEAK_REPORT)).toBe(true)
    expect(L.isValidReport('Shark crashed: OutOfMemoryError')).toBe(false)
  })
})

describe('parseMetadata + splitBlocks', () => {
  it('parses key: value pairs from the METADATA block', () => {
    const md = L.parseMetadata(LEAK_REPORT)
    expect(md['Build.VERSION.SDK_INT']).toBe('33')
    expect(md['Build.MANUFACTURER']).toBe('samsung')
    expect(md['Heap total bytes']).toBe('45000000')
    expect(md['Instance count']).toBe('123456')
    // lines before METADATA aren't captured
    expect(md['1 APPLICATION LEAKS']).toBeUndefined()
  })
  it('splits on ==== separator lines', () => {
    const blocks = L.splitBlocks(LEAK_REPORT)
    expect(blocks.some((b) => b.trim().startsWith('1 APPLICATION LEAKS'))).toBe(true)
    expect(blocks.some((b) => b.trim().startsWith('METADATA'))).toBe(true)
  })
})

describe('buildReportBody', () => {
  it('renders the leak banner + metadata tiles + a colorized trace card', () => {
    const html = L.buildReportBody('com.example.app', LEAK_REPORT)
    // banner: leaks found
    expect(html).toContain('class="banner bad"')
    expect(html).toContain('1 application leak found')
    // metadata tiles (formatted)
    expect(html).toContain('45.0 MB') // Heap total bytes -> MB
    expect(html).toContain('123,456') // Instance count -> grouped
    expect(html).toContain('>Android SDK<')
    // a leak card with a colorized YES / cause line
    expect(html).toContain('class="card leak"')
    expect(html).toContain('KB retained')
    expect(html).toContain('<span class="yes">')
    expect(html).toContain('<span class="cause">')
    // raw report is always available
    expect(html).toContain('Raw Shark report')
  })

  it('renders the clean banner + the reproduce note when there are no leaks', () => {
    const html = L.buildReportBody('com.example.app', CLEAN_REPORT)
    expect(html).toContain('class="banner ok"')
    expect(html).toContain('No application leaks')
    expect(html).toContain('class="card note"')
    expect(html).not.toContain('class="card leak"')
  })

  it('escapes the package name / report text', () => {
    const html = L.buildReportBody('com.evil<script>', CLEAN_REPORT)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })
})

describe('buildReportDocument', () => {
  const palette: L.LeakPalette = {
    BG: '#111',
    SURFACE: '#222',
    SURFACE_2: '#333',
    BORDER: '#444',
    TEXT: '#eee',
    TEXT_DIM: '#999',
    ACCENT: '#66f',
    GREEN: '#3c6',
    RED: '#f55',
    AMBER: '#ea1'
  }
  it('is a self-contained document with the palette baked into :root', () => {
    const doc = L.buildReportDocument('com.example.app', LEAK_REPORT, palette)
    expect(doc.startsWith('<!doctype html>')).toBe(true)
    expect(doc).toContain('--red:#f55')
    expect(doc).toContain('--green:#3c6')
    expect(doc).toContain('<style>')
    expect(doc).toContain('class="leak-report"')
    expect(doc).toContain('1 application leak found')
  })
})
