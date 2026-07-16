/**
 * iOS `.ips` crash-report parser tests — the adapter that turns Apple crash
 * reports into the same CrashItem shape the shared Android CrashView renders.
 * Fixtures mirror the real formats seen on-device (JetsamEvent JSON body,
 * *.cpu_resource text body, modern app-crash JSON, analytics that must be
 * filtered out).
 */
import { describe, expect, it } from 'vitest'
import { parseIpsReport } from '@core/ipscrash'

const ips = (header: object, body: string): string => `${JSON.stringify(header)}\n${body}`

describe('parseIpsReport', () => {
  it('summarizes a JetsamEvent (JSON body) as a native/OOM item', () => {
    const raw = ips(
      { bug_type: '298', os_version: 'iPhone OS 18.6.2', timestamp: '2026-07-09 10:52:11.00 +0300' },
      JSON.stringify({
        largestProcess: 'Maps',
        memoryStatus: { pageSize: 16384, memoryPages: { active: 1, free: 2, wired: 3 } },
        processes: [
          { name: 'small', pid: 1, rpages: 100 },
          { name: 'big', pid: 2, rpages: 500 }
        ]
      })
    )
    const it0 = parseIpsReport('JetsamEvent-2026-07-09-105211.000.ips', raw)!
    expect(it0.kind).toBe('native')
    expect(it0.title).toMatch(/Jetsam/i)
    expect(it0.plain).toContain('Largest process: Maps')
    // sorted by resident pages desc → "big" listed before "small"
    expect(it0.plain.indexOf('big (pid 2)')).toBeLessThan(it0.plain.indexOf('small (pid 1)'))
  })

  it('keeps a *.cpu_resource text body verbatim as an anr item', () => {
    const raw = ips(
      { bug_type: '202', name: 'spotlightknowledged', timestamp: '2026-07-09 10:56:35.00 +0300' },
      'Date/Time:        2026-07-09 10:54:34.995 +0300\nOS Version:       iPhone OS 18.6.2'
    )
    const it0 = parseIpsReport('spotlightknowledged.cpu_resource-2026-07-09-105635.ips', raw)!
    expect(it0.kind).toBe('anr')
    expect(it0.source).toBe('cpu_resource')
    expect(it0.title).toContain('spotlightknowledged')
    expect(it0.plain).toContain('Date/Time:')
  })

  it('renders a modern app crash (exception + faulting thread) with bundle id', () => {
    const raw = ips(
      { bug_type: '309', name: 'MyApp', bundleID: 'com.x.myapp', timestamp: '2026-07-15 10:10:10.00 +0300' },
      JSON.stringify({
        exception: { type: 'EXC_BAD_ACCESS', signal: 'SIGSEGV', subtype: 'KERN_INVALID_ADDRESS' },
        termination: { namespace: 'SIGNAL', indicator: 'Segmentation fault: 11' },
        faultingThread: 0,
        usedImages: [{ name: 'MyApp' }],
        threads: [{ triggered: true, frames: [{ imageIndex: 0, imageOffset: 1234 }] }]
      })
    )
    const it0 = parseIpsReport('MyApp-2026-07-15-101010.ips', raw)!
    expect(it0.kind).toBe('crash')
    expect(it0.process).toBe('com.x.myapp') // enables the "This app" filter
    expect(it0.plain).toContain('EXC_BAD_ACCESS')
    expect(it0.plain).toContain('MyApp + 1234')
  })

  it('filters out analytics / diagnostics (not crashes)', () => {
    expect(parseIpsReport('Analytics-2026-07-13-030627.ips.ca.synced', ips({ bug_type: '211' }, '{}'))).toBeNull()
    expect(parseIpsReport('SFA-ckks.json-2026-07-09-105210.ips', ips({ bug_type: '292' }, '{}'))).toBeNull()
    expect(parseIpsReport('proactive_event_tracker-2026-07-09.ips', ips({ bug_type: '327' }, '{}'))).toBeNull()
    // JSON-header diagnostic with no crash signal → skipped
    expect(parseIpsReport('some-diag-2026-07-09.ips', ips({ bug_type: '211' }, '{"foo":1}'))).toBeNull()
  })
})
