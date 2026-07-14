/**
 * A capped flow buffer with an incremental filtered view — the data side of
 * intercept.py's FlowTableModel, in the same shape as logStore.ts. Pure/DOM-free
 * so the renderer exposes it as an external store (useSyncExternalStore) and
 * reads rows by index; flows arrive as batched IPC events from the proxy engine.
 */
import { FLOW_CAP, FlowFilterSpec, type DisplayFlow } from '@core/intercept'

export class FlowStore {
  private flows: DisplayFlow[] = []
  private visible: number[] = []
  private spec: FlowFilterSpec = new FlowFilterSpec().compile()

  private version = 0
  private listeners = new Set<() => void>()

  constructor(
    private readonly maxEntries = FLOW_CAP,
    private readonly trimChunk = 500
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
    return this.flows.length
  }
  flowAt(row: number): DisplayFlow | undefined {
    const i = this.visible[row]
    return i === undefined ? undefined : this.flows[i]
  }

  // --- data flow ---------------------------------------------------------
  appendBatch(newFlows: DisplayFlow[]): void {
    if (newFlows.length === 0) return
    const base = this.flows.length
    for (const f of newFlows) this.flows.push(f)
    let changed = false
    for (let off = 0; off < newFlows.length; off++) {
      if (this.spec.match(newFlows[off])) {
        this.visible.push(base + off)
        changed = true
      }
    }
    if (this.flows.length > this.maxEntries) {
      this.trim()
      changed = true
    }
    if (changed) this.emit()
  }

  setFilter(spec: FlowFilterSpec): void {
    this.spec = spec
    this.rebuildVisible()
    this.emit()
  }

  clear(): void {
    this.flows = []
    this.visible = []
    this.emit()
  }

  // --- internals ---------------------------------------------------------
  private rebuildVisible(): void {
    const out: number[] = []
    for (let i = 0; i < this.flows.length; i++) {
      if (this.spec.match(this.flows[i])) out.push(i)
    }
    this.visible = out
  }

  private trim(): void {
    const drop = this.flows.length - this.maxEntries + this.trimChunk
    this.flows = this.flows.slice(drop)
    this.rebuildVisible()
  }
}
