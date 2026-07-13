/**
 * Two-tier live filter bar — port of ui.py's filter bar: a primary row (stream
 * controls · Level · search · presets · Advanced · Clear filters · view
 * controls) and a collapsible Advanced panel (Tag / PID / Exclude).
 */
import type { RefObject } from 'react'
import { LEVEL_OPTIONS, type Controller, type FilterFields } from '../state/useAppController'

const OR_HINT = 'Use | for OR — e.g. error|success matches either. Or enable .* for regex.'

function RegexToggle({
  on,
  onToggle,
  title
}: {
  on: boolean
  onToggle: () => void
  title: string
}) {
  return (
    <button
      className={`toggle${on ? ' checked' : ''}`}
      title={title}
      aria-pressed={on}
      onClick={onToggle}
    >
      .*
    </button>
  )
}

export function FilterBar({
  c,
  searchRef,
  onSavePreset
}: {
  c: Controller
  searchRef: RefObject<HTMLInputElement>
  onSavePreset: () => void
}) {
  const set = c.setFilterField
  const f = c.filter
  const field = <K extends keyof FilterFields>(k: K): FilterFields[K] => f[k]

  return (
    <div className="filter-bar" id="FilterBar">
      {/* Primary row */}
      <div className="filter-row">
        <button
          className={`start${c.streaming ? ' running' : ''}`}
          disabled={!c.serial}
          onClick={() => void c.toggleStream()}
        >
          {c.streaming ? '■  Stop' : '▶  Start'}
        </button>
        <button
          className={`pause${c.paused ? ' checked' : ''}`}
          disabled={!c.streaming}
          onClick={() => c.setPaused(!c.paused)}
        >
          {c.paused ? '▶  Resume' : '⏸  Pause'}
        </button>
        <button onClick={c.clearLog}>✕  Clear</button>

        <div className="filter-sep" />

        <span className="label">Level</span>
        <select
          title="Show this level and above"
          value={f.level}
          onChange={(e) => set('level', Number(e.target.value), true)}
        >
          {LEVEL_OPTIONS.map((o) => (
            <option key={o.name} value={o.priority}>
              {o.name}
            </option>
          ))}
        </select>

        <div className="field-group">
          <input
            ref={searchRef}
            type="text"
            className={c.fieldErrors.text ? 'error' : ''}
            placeholder="🔍  Search tag + message   (error|success)"
            title={`Show lines whose tag or message matches.\n${OR_HINT}`}
            value={field('text')}
            onChange={(e) => set('text', e.target.value)}
          />
          <RegexToggle
            on={f.textRegex}
            onToggle={() => set('textRegex', !f.textRegex, true)}
            title="Treat search as a regular expression"
          />
        </div>

        <select
          title="Apply a saved filter preset"
          style={{ minWidth: 120 }}
          value={c.currentPreset}
          onChange={(e) => c.applyPreset(e.target.value)}
        >
          <option value="">Presets…</option>
          {Object.keys(c.presets)
            .sort()
            .map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
        </select>
        <button className="toggle" title="Save the current filters as a named preset" onClick={onSavePreset}>
          ＋
        </button>
        <button
          className="toggle"
          title="Delete the selected preset"
          onClick={() => void c.deletePreset(c.currentPreset)}
        >
          −
        </button>

        <button
          className={`adv-toggle${c.advancedOpen ? ' checked' : ''}`}
          title="Show tag / PID / exclude filters"
          onClick={() => c.setAdvancedOpen(!c.advancedOpen)}
        >
          {c.advancedHasHiddenActive ? 'Advanced ●' : 'Advanced'}
        </button>
        <button title="Reset every filter on this bar (does not clear the log)" onClick={c.clearFilters}>
          Clear filters
        </button>

        <div className="filter-sep" />

        <label className="checkbox" title="Scroll to newest lines automatically">
          <input
            type="checkbox"
            checked={c.autoscroll}
            onChange={(e) => c.setAutoscroll(e.target.checked)}
          />
          Auto-scroll
        </label>
        <label className="checkbox" title="Wrap long messages across multiple lines">
          <input type="checkbox" checked={c.wrap} onChange={(e) => c.setWrap(e.target.checked)} />
          Wrap
        </label>
        <button className="toggle" title="Decrease text size  (⌘−)" onClick={() => c.bumpFont(-1)}>
          A−
        </button>
        <span className="font-label">{c.fontPt}</span>
        <button className="toggle" title="Increase text size  (⌘+)" onClick={() => c.bumpFont(+1)}>
          A+
        </button>
      </div>

      {/* Advanced panel */}
      {c.advancedOpen ? (
        <div className="filter-row">
          <span className="label">Tag</span>
          <div className="field-group" style={{ flex: 2 }}>
            <input
              type="text"
              className={c.fieldErrors.tag ? 'error' : ''}
              placeholder="tag  (e.g. Activity|View)"
              title={`Show lines whose tag matches.\n${OR_HINT}`}
              value={field('tag')}
              onChange={(e) => set('tag', e.target.value)}
            />
            <RegexToggle
              on={f.tagRegex}
              onToggle={() => set('tagRegex', !f.tagRegex, true)}
              title="Treat tag filter as a regular expression"
            />
          </div>
          <div style={{ width: 6 }} />
          <span className="label">PID</span>
          <input
            type="text"
            className={c.fieldErrors.pid ? 'error' : ''}
            style={{ maxWidth: 140 }}
            placeholder="e.g. 1234, 5678"
            value={field('pids')}
            onChange={(e) => set('pids', e.target.value)}
          />
          <div style={{ width: 6 }} />
          <span className="label">Exclude</span>
          <div className="field-group" style={{ flex: 2 }}>
            <input
              type="text"
              className={c.fieldErrors.exclude ? 'error' : ''}
              placeholder="hide lines matching  (debug|verbose)"
              title={`Hide lines whose tag or message matches.\n${OR_HINT}`}
              value={field('exclude')}
              onChange={(e) => set('exclude', e.target.value)}
            />
            <RegexToggle
              on={f.excludeRegex}
              onToggle={() => set('excludeRegex', !f.excludeRegex, true)}
              title="Treat exclude as a regular expression"
            />
          </div>
        </div>
      ) : null}
    </div>
  )
}
