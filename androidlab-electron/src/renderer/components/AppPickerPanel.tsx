/**
 * Left-hand click-to-pick app list — port of ui.py's AppPickerPanel: a filter
 * box + a list of "All apps" + VA clones (marked) + device apps. Picking drives
 * the shared App selection (which every tab follows).
 */
import { useMemo, useState } from 'react'
import type { Controller } from '../state/useAppController'
import { AppIcon } from './AppIcon'

export function AppPickerPanel({ c, width }: { c: Controller; width: number }) {
  const [needle, setNeedle] = useState('')

  const items = useMemo(() => {
    const n = needle.trim().toLowerCase()
    return c.apps.filter((a) => {
      const text = a.clone ? `${a.pkg}   (clone)` : a.pkg
      return !n || text.toLowerCase().includes(n)
    })
  }, [c.apps, needle])

  const selected = c.appPkg

  return (
    <div className="app-panel" style={{ width }}>
      <div className="app-panel-bar">
        <input
          type="text"
          placeholder="Filter apps…"
          value={needle}
          onChange={(e) => setNeedle(e.target.value)}
        />
      </div>
      {c.appsLoading ? <div className="app-panel-busy" /> : null}
      <div className="app-list">
        <div
          className={`app-item${selected === null ? ' selected' : ''}`}
          onClick={() => void c.selectApp(null)}
        >
          <AppIcon pkg="all" all size={22} />
          <span className="name">All apps</span>
        </div>
        {items.map((a) => (
          <div
            key={a.pkg}
            className={`app-item${selected === a.pkg ? ' selected' : ''}`}
            title={a.clone ? `${a.pkg}  (VA clone)` : a.pkg}
            onClick={() => void c.selectApp(a.pkg)}
          >
            <AppIcon pkg={a.pkg} size={22} />
            <span className="name">{a.pkg}</span>
            {a.clone ? <span className="badge-clone">(clone)</span> : null}
          </div>
        ))}
      </div>
    </div>
  )
}
