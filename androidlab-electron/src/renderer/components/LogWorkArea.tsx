/**
 * The Logs tab work area: either the virtualized LogTable or, when the filtered
 * view is empty, the guided LogsEmptyState. Subscribes to the log store (like
 * StatusBar) so it flips between the two live as lines arrive / filters change —
 * isolating that high-frequency re-render here instead of in App.
 */
import { useSyncExternalStore } from 'react'
import { LogTable, type LogTableProps } from './LogTable'
import { LogsEmptyState } from './LogsEmptyState'

export function LogWorkArea({ onOpenLog, ...props }: LogTableProps & { onOpenLog: () => void }) {
  const { c } = props
  useSyncExternalStore(c.store.subscribe, c.store.getSnapshot)
  if (c.store.rowCount() === 0) return <LogsEmptyState c={c} onOpenLog={onOpenLog} />
  return <LogTable {...props} />
}
