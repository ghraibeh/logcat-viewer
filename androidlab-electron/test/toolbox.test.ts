/**
 * Toolbox parity tests — TS equivalents of the toolbox checks in tests/smoke.py:
 * am arg building (incl. typed extras), monkey args + device-kill, perfetto
 * args/presets, notification parsing (incl. dedupe), and bugreport progress.
 */
import { describe, expect, it } from 'vitest'
import {
  KILL_MONKEY,
  REMOTE_TRACE,
  PERFETTO_PRESETS,
  buildAmArgs,
  intentLooksBad,
  isMonkeyCrash,
  monkeyArgs,
  parseBugreportProgress,
  parseNotifications,
  perfettoArgs,
  pullTraceArgs
} from '@core/toolbox'

describe('buildAmArgs', () => {
  it('start waits (-W) and carries action/data/typed extras', () => {
    const args = buildAmArgs({
      verb: 'start',
      action: 'android.intent.action.VIEW',
      data: 'myapp://x',
      extras: [
        { type: 'string', key: 's', value: 'hi' },
        { type: 'int', key: 'n', value: '7' },
        { type: 'boolean', key: 'b', value: 'true' }
      ]
    })
    expect(args.slice(0, 4)).toEqual(['shell', 'am', 'start', '-W'])
    expect(args).toContain('-a')
    expect(args).toContain('android.intent.action.VIEW')
    expect(args).toContain('-d')
    expect(args).toContain('myapp://x')
    // typed-extra flags map string/int/boolean -> --es/--ei/--ez
    expect(args.join(' ')).toContain('--es s hi')
    expect(args.join(' ')).toContain('--ei n 7')
    expect(args.join(' ')).toContain('--ez b true')
  })

  it('broadcast does not wait', () => {
    expect(buildAmArgs({ verb: 'broadcast', action: 'a.b' })).not.toContain('-W')
  })

  it('start/service pass a component via -n', () => {
    const args = buildAmArgs({ verb: 'startservice', component: 'com.x/.Svc' })
    expect(args.slice(-2)).toEqual(['-n', 'com.x/.Svc'])
  })

  it('skips extras with an empty key or unknown flag', () => {
    const args = buildAmArgs({ verb: 'start', extras: [{ type: 'string', key: '', value: 'v' }] })
    expect(args).not.toContain('--es')
  })
})

describe('intentLooksBad', () => {
  it('flags am errors reported on stdout, or a non-zero code', () => {
    expect(intentLooksBad('Starting: Intent { ... }\nStatus: ok', 0)).toBe(false)
    expect(intentLooksBad('Error: Activity class does not exist', 0)).toBe(true)
    expect(intentLooksBad('Activity not started, unable to resolve Intent', 0)).toBe(true)
    expect(intentLooksBad('java.lang.SecurityException', 0)).toBe(true)
    expect(intentLooksBad('ok', 1)).toBe(true)
  })
})

describe('monkey', () => {
  it('monkeyArgs builds the seeded/throttled stress command', () => {
    const a = monkeyArgs('com.x', 500, 42, 100)
    expect(a).toContain('monkey')
    expect(a).toContain('-p')
    expect(a).toContain('com.x')
    expect(a[a.length - 1]).toBe('500') // event count is last
    expect(a).toContain('--throttle')
    expect(a).toContain('--ignore-security-exceptions')
    expect(a.join(' ')).toContain('-s 42')
  })
  it('exposes a device-side kill and crash detection', () => {
    expect(KILL_MONKEY).toContain('com.android.commands.monkey')
    expect(isMonkeyCrash('   // CRASH: com.x')).toBe(true)
    expect(isMonkeyCrash('// NOT RESPONDING: com.x')).toBe(true)
    expect(isMonkeyCrash(':Sending Touch (ACTION_DOWN)')).toBe(false)
  })
})

describe('perfetto', () => {
  it('perfettoArgs builds the capture command', () => {
    const a = perfettoArgs(10, ['sched', 'gfx'])
    expect(a).toContain('perfetto')
    expect(a).toContain('-o')
    expect(a).toContain(REMOTE_TRACE)
    expect(a).toContain('-t')
    expect(a).toContain('10s')
    expect(a).toContain('gfx')
  })
  it('pullTraceArgs pulls the remote trace', () => {
    expect(pullTraceArgs('/tmp/x')).toEqual(['pull', REMOTE_TRACE, '/tmp/x'])
  })
  it('ships category presets', () => {
    expect(PERFETTO_PRESETS.length).toBeGreaterThanOrEqual(4)
    expect(PERFETTO_PRESETS[0][1]).toContain('gfx')
  })
})

const NOTIF_DUMP =
  '  NotificationRecord(0x1234: pkg=com.foo user=UserHandle{0} id=101 ...)\n' +
  '      android.title=String (Hello)\n      android.text=String (World)\n' +
  "      mChannel= NotificationChannel{mId='alerts', mName=Alerts}\n" +
  '      key=0|com.foo|101|null|10123\n      when=+2m30s ago\n' +
  '  NotificationRecord(0x9999: pkg=com.bar user=UserHandle{0} id=7 ...)\n' +
  '      key=0|com.bar|7|null|10456\n'

describe('parseNotifications', () => {
  it('splits records by package', () => {
    const items = parseNotifications(NOTIF_DUMP)
    expect(items.length).toBe(2)
    expect(items[0].pkg).toBe('com.foo')
    expect(items[1].pkg).toBe('com.bar')
  })
  it('reads title / text / channel', () => {
    const [foo] = parseNotifications(NOTIF_DUMP)
    expect(foo.title).toBe('Hello')
    expect(foo.text).toBe('World')
    expect(foo.channel).toBe('alerts')
  })
  it('dedupes repeated records by key', () => {
    expect(parseNotifications(NOTIF_DUMP + NOTIF_DUMP).length).toBe(2)
  })
})

describe('parseBugreportProgress', () => {
  it('parses a [ NN%/100%] progress line, else null', () => {
    expect(parseBugreportProgress('[ 55%/100%] /path')).toBe(55)
    expect(parseBugreportProgress('[100%] done')).toBe(100)
    expect(parseBugreportProgress('Ok, saved report')).toBeNull()
    expect(parseBugreportProgress('[999%]')).toBe(100) // clamped
  })
})
