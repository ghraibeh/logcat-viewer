/** Pill-style tab bar — port of the QTabWidget/QTabBar in ui.py. */
export interface TabDef {
  id: string
  label: string
  /** show a ● dot (e.g. the Apps tab after a live crash pings in). */
  badge?: boolean
}

export function TabBar({
  tabs,
  current,
  onSelect
}: {
  tabs: TabDef[]
  current: string
  onSelect: (id: string) => void
}) {
  return (
    <div className="tabbar" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={t.id === current}
          className={`tab${t.id === current ? ' selected' : ''}`}
          onClick={() => onSelect(t.id)}
        >
          {t.label}
          {t.badge ? <span className="dot">●</span> : null}
        </button>
      ))}
    </div>
  )
}
