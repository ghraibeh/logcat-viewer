/**
 * Bottom status line — port of MainWindow._update_status: shown/total, rate,
 * stream state, selected-app pids, paused buffer, and dropped-backlog count.
 */
import { useSyncExternalStore } from 'react'
import type { Controller } from '../state/useAppController'

export function StatusBar({ c }: { c: Controller }) {
  // Re-render when the store changes so shown/total stay live.
  useSyncExternalStore(c.store.subscribe, c.store.getSnapshot)
  const shown = c.store.rowCount()
  const total = c.store.totalCount()

  const parts: string[] = [
    `${shown.toLocaleString()}/${total.toLocaleString()} shown`,
    `${c.rate}/s`,
    c.streaming ? 'running' : 'stopped'
  ]
  if (c.appPkg) {
    const n = c.appPids ? c.appPids.size : 0
    parts.push(`app: ${c.appPkg} (${n === 0 ? 'not running' : `${n} pid${n !== 1 ? 's' : ''}`})`)
  }
  if (c.paused) parts.push(`PAUSED · ${c.buffered.toLocaleString()} buffered`)
  if (c.dropped) parts.push(`${c.dropped.toLocaleString()} dropped (backlog cap)`)

  return <div className="status-bar">{parts.join('   ·   ')}</div>
}
