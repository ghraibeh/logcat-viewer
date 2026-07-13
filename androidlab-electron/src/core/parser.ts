/**
 * Parse `adb logcat -v threadtime` output lines into structured entries.
 * Faithful port of logcat_viewer/parser.py.
 */
import { PRIORITY, UNKNOWN_PRIORITY } from './priorities'

/** One parsed logcat line. */
export interface LogEntry {
  time: string
  pid: number
  tid: number
  level: string
  priority: number
  tag: string
  msg: string
  raw: string
  /** Precomputed lowercase haystack for case-insensitive substring filtering. */
  search: string
}

// 07-09 14:23:01.123  1234  1250 D BActivityThread: message text
const THREADTIME =
  /^(?<time>\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+)\s+(?<pid>\d+)\s+(?<tid>\d+)\s+(?<level>[VDIWEFS])\s+(?<tag>[\s\S]*?): ?(?<msg>[\s\S]*)$/

function makeEntry(
  time: string,
  pid: number,
  tid: number,
  level: string,
  priority: number,
  tag: string,
  msg: string,
  raw: string
): LogEntry {
  return {
    time,
    pid,
    tid,
    level,
    priority,
    tag,
    msg,
    raw,
    search: (tag + ' ' + msg).toLowerCase()
  }
}

/** Return a LogEntry, or null for lines that carry no log content (dividers/blank). */
export function parseLine(line: string): LogEntry | null {
  if (!line || line.startsWith('--------- ')) {
    return null
  }
  const m = THREADTIME.exec(line)
  if (m && m.groups) {
    const level = m.groups.level
    return makeEntry(
      m.groups.time,
      parseInt(m.groups.pid, 10),
      parseInt(m.groups.tid, 10),
      level,
      PRIORITY[level] ?? UNKNOWN_PRIORITY,
      m.groups.tag.replace(/\s+$/, ''), // Python .rstrip()
      m.groups.msg,
      line
    )
  }
  // Non-threadtime line (rare malformed output): keep it, don't lose data.
  return makeEntry('', 0, 0, '?', UNKNOWN_PRIORITY, '', line, line)
}
