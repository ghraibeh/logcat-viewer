/**
 * A capped log buffer with an incremental filtered view — the data model.
 * Faithful port of logcat_viewer/model.py's LogTableModel (the data side only;
 * Qt roles/painting are handled by the React table). Pure/DOM-free so it lives
 * in core and is unit-tested directly; the renderer exposes it as an external
 * store (useSyncExternalStore) and reads rows by index, never copying 200k
 * entries into React state.
 */
import type { LogEntry } from '@core/parser'
import { FilterSpec } from '@core/filters'

export class LogStore {
  private entries: LogEntry[] = [] // full ring buffer
  private visible: number[] = [] // indices into entries that pass the filter
  private spec: FilterSpec = new FilterSpec().compile()

  private version = 0
  private listeners = new Set<() => void>()

  constructor(
    private readonly maxEntries = 200_000,
    private readonly trimChunk = 20_000
  ) {}

  // --- external-store interface (useSyncExternalStore) -------------------
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  getSnapshot = (): number => this.version
  private emit(): void {
    this.version++
    for (const l of this.listeners) l()
  }

  // --- read --------------------------------------------------------------
  rowCount(): number {
    return this.visible.length
  }
  totalCount(): number {
    return this.entries.length
  }
  entryAt(row: number): LogEntry {
    return this.entries[this.visible[row]]
  }
  /** The filtered entries, in order (for export). */
  visibleEntries(): LogEntry[] {
    return this.visible.map((i) => this.entries[i])
  }
  /** Every buffered entry (for "export entire"). */
  allEntries(): LogEntry[] {
    return this.entries
  }

  // --- data flow ---------------------------------------------------------
  appendBatch(newEntries: LogEntry[]): void {
    if (newEntries.length === 0) return
    const base = this.entries.length
    for (const e of newEntries) this.entries.push(e)
    let added = false
    for (let off = 0; off < newEntries.length; off++) {
      if (this.spec.match(newEntries[off])) {
        this.visible.push(base + off)
        added = true
      }
    }
    if (this.entries.length > this.maxEntries) {
      this.trim()
      added = true
    }
    if (added) this.emit()
  }

  setFilter(spec: FilterSpec): void {
    this.spec = spec
    this.rebuildVisible()
    this.emit()
  }

  clear(): void {
    this.entries = []
    this.visible = []
    this.emit()
  }

  // --- internals ---------------------------------------------------------
  private rebuildVisible(): void {
    const out: number[] = []
    for (let i = 0; i < this.entries.length; i++) {
      if (this.spec.match(this.entries[i])) out.push(i)
    }
    this.visible = out
  }

  private trim(): void {
    const drop = this.entries.length - this.maxEntries + this.trimChunk
    this.entries = this.entries.slice(drop)
    this.rebuildVisible()
  }
}
