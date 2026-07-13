/**
 * Core-pipeline parity tests — the TS equivalents of the parser/filter/model
 * checks in tests/smoke.py. These lock the ported logic to the Python behavior.
 */
import { describe, expect, it } from 'vitest'
import { parseLine } from '@core/parser'
import { PRIORITY } from '@core/priorities'
import { FilterSpec } from '@core/filters'
import { tagColor } from '@core/colors'
import { entryLine, exportText } from '@core/logtools'
import { LogStore } from '@core/logStore'

const LINE = '07-09 14:23:01.123  1234  1250 D BActivityThread: message text'

describe('parseLine', () => {
  it('parses a threadtime line into fields', () => {
    const e = parseLine(LINE)!
    expect(e).not.toBeNull()
    expect(e.time).toBe('07-09 14:23:01.123')
    expect(e.pid).toBe(1234)
    expect(e.tid).toBe(1250)
    expect(e.level).toBe('D')
    expect(e.priority).toBe(PRIORITY.D)
    expect(e.tag).toBe('BActivityThread')
    expect(e.msg).toBe('message text')
    expect(e.raw).toBe(LINE)
    expect(e.search).toBe('bactivitythread message text')
  })

  it('returns null for dividers and blank lines', () => {
    expect(parseLine('--------- beginning of main')).toBeNull()
    expect(parseLine('')).toBeNull()
  })

  it('keeps malformed lines as Verbose-priority with the raw text', () => {
    const e = parseLine('not a threadtime line')!
    expect(e.level).toBe('?')
    expect(e.priority).toBe(PRIORITY.V)
    expect(e.msg).toBe('not a threadtime line')
    expect(e.tag).toBe('')
  })

  it('right-strips trailing whitespace from the tag', () => {
    const e = parseLine('07-09 14:23:01.123  1  1 I Tag  : hi')!
    expect(e.tag).toBe('Tag')
    expect(e.msg).toBe('hi')
  })

  it('handles an empty message after the colon', () => {
    const e = parseLine('07-09 14:23:01.123  1  1 I Tag:')!
    expect(e.tag).toBe('Tag')
    expect(e.msg).toBe('')
  })
})

function e(level: string, pid: number, tag: string, msg: string) {
  return parseLine(`07-09 00:00:00.000  ${pid}  ${pid} ${level} ${tag}: ${msg}`)!
}

describe('FilterSpec', () => {
  it('filters by minimum priority', () => {
    const spec = new FilterSpec({ minPriority: PRIORITY.W }).compile()
    expect(spec.match(e('I', 1, 'T', 'x'))).toBe(false)
    expect(spec.match(e('W', 1, 'T', 'x'))).toBe(true)
    expect(spec.match(e('E', 1, 'T', 'x'))).toBe(true)
  })

  it('substring OR text search over tag+message', () => {
    const spec = new FilterSpec({ textQuery: 'error|success' }).compile()
    expect(spec.match(e('I', 1, 'Net', 'request error'))).toBe(true)
    expect(spec.match(e('I', 1, 'Net', 'SUCCESS!'))).toBe(true)
    expect(spec.match(e('I', 1, 'Net', 'nothing'))).toBe(false)
  })

  it('regex text search over the raw line', () => {
    const spec = new FilterSpec({ textQuery: 'msg\\d+', textRegex: true }).compile()
    expect(spec.match(e('I', 1, 'T', 'msg42'))).toBe(true)
    expect(spec.match(e('I', 1, 'T', 'msg'))).toBe(false)
    expect(spec.hasError('text')).toBe(false)
  })

  it('invalid regex disables the field and records an error', () => {
    const spec = new FilterSpec({ textQuery: '(', textRegex: true }).compile()
    expect(spec.hasError('text')).toBe(true)
    expect(spec.match(e('I', 1, 'T', 'anything'))).toBe(true) // pass-through
  })

  it('filters by tag (substring OR) and PID list', () => {
    const tagSpec = new FilterSpec({ tagQuery: 'Activity|View' }).compile()
    expect(tagSpec.match(e('I', 1, 'ActivityManager', 'x'))).toBe(true)
    expect(tagSpec.match(e('I', 1, 'Zygote', 'x'))).toBe(false)

    const pidSpec = new FilterSpec({ pids: '10, 20' }).compile()
    expect(pidSpec.match(e('I', 10, 'T', 'x'))).toBe(true)
    expect(pidSpec.match(e('I', 30, 'T', 'x'))).toBe(false)
    const bad = new FilterSpec({ pids: 'abc' }).compile()
    expect(bad.hasError('pid')).toBe(true)
  })

  it('excludes matching lines', () => {
    const spec = new FilterSpec({ excludeQuery: 'debug|verbose' }).compile()
    expect(spec.match(e('I', 1, 'T', 'a debug msg'))).toBe(false)
    expect(spec.match(e('I', 1, 'T', 'clean'))).toBe(true)
  })

  it('restricts to a package pid set', () => {
    const spec = new FilterSpec({ packagePids: new Set([100, 101]) }).compile()
    expect(spec.match(e('I', 100, 'T', 'x'))).toBe(true)
    expect(spec.match(e('I', 999, 'T', 'x'))).toBe(false)
    // empty set matches nothing (an app with no live pids hides its log)
    const empty = new FilterSpec({ packagePids: new Set() }).compile()
    expect(empty.match(e('I', 100, 'T', 'x'))).toBe(false)
    // null == no package filter
    const none = new FilterSpec({ packagePids: null }).compile()
    expect(none.match(e('I', 100, 'T', 'x'))).toBe(true)
  })
})

describe('tagColor', () => {
  it('is deterministic and matches the Python hash algorithm', () => {
    // h*31+ord, ToUint32, % 14 -> palette index 10 (violet) for "Foo"
    expect(tagColor('Foo')).toBe('#b08ff0')
    expect(tagColor('Foo')).toBe(tagColor('Foo'))
    expect(tagColor('')).toBe('#767c88') // META for empty tag
  })
})

describe('LogStore', () => {
  it('appends and filters incrementally', () => {
    const store = new LogStore()
    store.appendBatch([e('I', 1, 'A', 'hello'), e('E', 2, 'B', 'boom'), e('D', 3, 'C', 'noise')])
    expect(store.totalCount()).toBe(3)
    expect(store.rowCount()).toBe(3)

    store.setFilter(new FilterSpec({ minPriority: PRIORITY.E }).compile())
    expect(store.rowCount()).toBe(1)
    expect(store.entryAt(0).msg).toBe('boom')

    store.setFilter(new FilterSpec().compile())
    expect(store.rowCount()).toBe(3)
    store.clear()
    expect(store.totalCount()).toBe(0)
    expect(store.rowCount()).toBe(0)
  })

  it('trims the ring buffer past the cap', () => {
    const store = new LogStore(10, 3) // max 10, trim chunk 3
    const batch = Array.from({ length: 12 }, (_, i) => e('I', i + 1, 'T', `m${i}`))
    store.appendBatch(batch)
    // 12 > 10 -> drop 12-10+3 = 5, leaving 7
    expect(store.totalCount()).toBe(7)
    expect(store.entryAt(0).msg).toBe('m5')
  })
})

describe('logtools', () => {
  it('round-trips a line through entryLine/parseLine', () => {
    const parsed = parseLine(LINE)!
    expect(entryLine(parsed)).toBe(LINE)
    expect(parseLine(entryLine(parsed))!.msg).toBe('message text')
  })

  it('exportText joins with newlines and trailing newline', () => {
    const entries = [e('I', 1, 'A', 'x'), e('I', 2, 'B', 'y')]
    const text = exportText(entries)
    expect(text.endsWith('\n')).toBe(true)
    expect(text.split('\n').filter(Boolean).length).toBe(2)
    expect(exportText([])).toBe('')
  })
})
