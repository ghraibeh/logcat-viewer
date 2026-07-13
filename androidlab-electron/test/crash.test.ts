/**
 * Crash & ANR parity tests — TS equivalents of the crash.py checks: arg builders,
 * crash-buffer / dropbox block splitting, grouping (×N), trace classification,
 * the obfuscation heuristic, HTML rendering (chips + folding), and the
 * R8/ProGuard mapping parse + retrace.
 */
import { describe, expect, it } from 'vitest'
import * as CR from '@core/crash'

const SERIAL = 'R5CX22ZBQYJ'

const CRASH_BUFFER = [
  '07-11 10:00:00.100  4739  4739 E AndroidRuntime: FATAL EXCEPTION: main',
  '07-11 10:00:00.100  4739  4739 E AndroidRuntime: Process: com.example.app, PID: 4739',
  '07-11 10:00:00.100  4739  4739 E AndroidRuntime: java.lang.NullPointerException: boom',
  '07-11 10:00:00.100  4739  4739 E AndroidRuntime: \tat com.example.app.Main.foo(Main.java:10)',
  '07-11 10:00:00.100  4739  4739 E AndroidRuntime: \tat android.os.Handler.dispatchMessage(Handler.java:99)'
].join('\n')

describe('crash arg builders', () => {
  it('crash buffer + dropbox print', () => {
    expect(CR.crashBufferArgs(SERIAL)).toEqual(['-s', SERIAL, 'logcat', '-b', 'crash', '-v', 'threadtime', '-d'])
    expect(CR.dropboxPrintArgs(SERIAL, 'data_app_crash')).toEqual([
      '-s', SERIAL, 'shell', 'dumpsys', 'dropbox', '--print', 'data_app_crash'
    ])
  })
})

describe('splitCrashBlocks', () => {
  it('groups a PID run into one block with headline + process', () => {
    const blocks = CR.splitCrashBlocks(CRASH_BUFFER)
    expect(blocks.length).toBe(1)
    expect(blocks[0].kind).toBe('crash')
    expect(blocks[0].process).toBe('com.example.app')
    expect(blocks[0].title).toContain('NullPointerException')
    expect(blocks[0].source).toBe('crash buffer')
  })
})

describe('splitDropboxPrint', () => {
  it('splits dated entries and tags the kind', () => {
    const dump =
      '2026-07-11 10:00:00 data_app_anr (text, 100 bytes)\n' +
      'Process: com.example.app\nANR in com.example.app\n' +
      '========================================\n' +
      '2026-07-11 09:00:00 data_app_anr (text, 80 bytes)\n' +
      'Process: com.other\nANR in com.other\n'
    const items = CR.splitDropboxPrint(dump, 'data_app_anr')
    expect(items.length).toBe(2)
    expect(items[0].kind).toBe('anr')
    expect(items[0].when).toBe('2026-07-11 10:00:00')
    expect(items[0].process).toBe('com.example.app')
  })
})

describe('grouping', () => {
  it('collapses identical crashes into ×N groups (newest kept)', () => {
    const items = CR.splitCrashBlocks(CRASH_BUFFER)
    const dup = [...items, { ...items[0] }, { ...items[0], process: 'com.other' }]
    const groups = CR.groupCrashes(dup)
    expect(groups.length).toBe(2)
    expect(groups[0].count).toBe(2)
    expect(groups[1].item.process).toBe('com.other')
  })
})

describe('classifyTraceLine + isAppFrame', () => {
  it('classifies app / framework / cause / exception / text', () => {
    expect(CR.classifyTraceLine('  at com.example.app.Main.foo(Main.java:10)', 'com.example.app')).toBe('frame-app')
    expect(CR.classifyTraceLine('  at android.os.Handler.x(Handler.java:1)', 'com.example.app')).toBe('frame')
    expect(CR.classifyTraceLine('Caused by: java.lang.IllegalStateException: x')).toBe('cause')
    expect(CR.classifyTraceLine('java.lang.NullPointerException: boom')).toBe('exception')
    expect(CR.classifyTraceLine('just some text')).toBe('text')
  })
  it('isAppFrame matches the base package', () => {
    expect(CR.isAppFrame('com.example.app.Main', 'com.example.app')).toBe(true)
    expect(CR.isAppFrame('android.os.Handler', 'com.example.app')).toBe(false)
    expect(CR.isAppFrame('com.example.app', 'com.example.app:remote')).toBe(true)
  })
})

describe('looksObfuscated', () => {
  it('detects >=2 short-segment frames', () => {
    expect(CR.looksObfuscated('at a.b.c(x)\nat d.e.f(y)')).toBe(true)
    expect(CR.looksObfuscated('at com.example.Foo.bar(Foo.java:1)')).toBe(false)
  })
})

describe('buildCrashHtml', () => {
  it('renders the kind chip, ×N badge, and folds long framework runs', () => {
    const item: CR.CrashItem = {
      kind: 'crash',
      when: '07-11 10:00',
      process: 'com.example.app',
      title: 'java.lang.NullPointerException: boom',
      text: '',
      source: 'crash buffer',
      plain:
        'java.lang.NullPointerException: boom\n' +
        '\tat com.example.app.Main.foo(Main.java:10)\n' +
        '\tat android.a.A(A.java:1)\n' +
        '\tat android.b.B(B.java:2)\n' +
        '\tat android.c.C(C.java:3)\n' +
        '\tat android.d.D(D.java:4)\n' +
        '\tat android.e.E(E.java:5)'
    }
    const html = CR.buildCrashHtml(item, { appPkg: 'com.example.app', count: 3 })
    expect(html).toContain('CRASH')
    expect(html).toContain('×3')
    expect(html).toContain('framework frames (click to expand)')
    // app frame highlighted (not folded)
    expect(html).toContain('Main.foo')
  })
})

describe('parseMapping + retrace', () => {
  const MAPPING = ['com.example.app.MainActivity -> a.b.c:', '    1:5:void doThing(int):10:14 -> b'].join('\n')

  it('parses class + method mappings', () => {
    const mp = CR.parseMapping(MAPPING)
    expect(mp.classes['a.b.c']).toBe('com.example.app.MainActivity')
    expect(Object.keys(mp.methods)).toContain('a.b.c b')
  })

  it('retraces frames + bare class tokens', () => {
    const mp = CR.parseMapping(MAPPING)
    const trace = '\tat a.b.c.b(SourceFile:3)\nCaused by: a.b.c: null'
    const out = CR.retrace(mp, trace)
    expect(out).toContain('com.example.app.MainActivity.doThing(MainActivity.java:12)')
    expect(out).toContain('Caused by: com.example.app.MainActivity: null')
  })
})
