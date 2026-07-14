/**
 * Toolbox tab — port of toolbox.py's ToolboxView: a pill sub-tab strip hosting
 * the five small dev tools (Intents / Monkey / Perfetto / Notifications /
 * Bugreport). Monkey + Perfetto follow the shared App picker via the Controller.
 *
 * All five panels stay mounted while the Toolbox tab is open (so their state and
 * live subscriptions survive sub-tab switches); leaving the tab unmounts them,
 * which stops the monkey and cancels any perfetto / bugreport capture — no
 * orphaned device-side child outlives the view.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Controller } from '../state/useAppController'
import {
  AM_MODES,
  EXTRA_TYPES,
  PERFETTO_DURATIONS,
  PERFETTO_PRESETS,
  buildAmArgs,
  type AmVerb,
  type ExtraType,
  type IntentExtra,
  type IntentSpec,
  type NotifItem
} from '@core/toolbox'
import { MessageBox, type MessageBoxSpec } from './dialogs'
import { Icon } from './Icon'

type SubTab = 'intents' | 'monkey' | 'perfetto' | 'notifs' | 'bugreport'
const SUBTABS: Array<[SubTab, string]> = [
  ['intents', 'Intents'],
  ['monkey', 'Monkey'],
  ['perfetto', 'Perfetto'],
  ['notifs', 'Notifications'],
  ['bugreport', 'Bugreport']
]

// --- Intents ----------------------------------------------------------------
function IntentsPanel({ c }: { c: Controller }) {
  const [link, setLink] = useState('')
  const [verb, setVerb] = useState<AmVerb>('start')
  const [action, setAction] = useState('')
  const [data, setData] = useState('')
  const [mime, setMime] = useState('')
  const [component, setComponent] = useState('')
  const [extras, setExtras] = useState<IntentExtra[]>([])
  const [out, setOut] = useState('')
  const [busy, setBusy] = useState(false)
  const outRef = useRef<HTMLDivElement>(null)

  const append = (text: string): void => setOut((prev) => (prev ? `${prev}\n${text}` : text))
  useEffect(() => {
    const el = outRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [out])

  const fire = async (spec: IntentSpec): Promise<void> => {
    if (!c.serial) {
      append('✗ Intents: no device selected')
      return
    }
    if (busy) {
      append('… an intent is already in flight')
      return
    }
    setBusy(true)
    append(`$ adb ${['-s', c.serial, ...buildAmArgs(spec)].join(' ')}`)
    const r = await window.androidlab.toolbox.runIntent(c.serial, spec)
    setBusy(false)
    append(`${r.output}\n${r.ok ? '✓ Intent sent' : '✗ Intent failed — see the am output'}`)
  }

  const fireLink = (): void => {
    const uri = link.trim()
    if (!uri) {
      append('Enter a deep link first')
      return
    }
    void fire({ verb: 'start', action: 'android.intent.action.VIEW', data: uri })
  }

  const fireFull = (): void => {
    void fire({
      verb,
      action: action.trim(),
      data: data.trim(),
      mime: mime.trim(),
      component: component.trim(),
      extras: extras.filter((e) => e.key.trim()).map((e) => ({ ...e, key: e.key.trim() }))
    })
  }

  const setExtra = (i: number, patch: Partial<IntentExtra>): void =>
    setExtras((prev) => prev.map((e, j) => (j === i ? { ...e, ...patch } : e)))
  const addExtra = (): void => setExtras((prev) => [...prev, { type: 'string', key: '', value: '' }])
  const rmExtra = (i: number): void => setExtras((prev) => prev.filter((_, j) => j !== i))

  return (
    <>
      <div className="tb-row">
        <span className="label">Deep link</span>
        <input
          className="line-edit grow"
          type="text"
          value={link}
          placeholder="myapp://path/to/screen   or   https://example.com/…"
          onChange={(e) => setLink(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') fireLink()
          }}
        />
        <button title="am start -W -a android.intent.action.VIEW -d <uri>" onClick={fireLink}>
          Open  (VIEW)
        </button>
      </div>

      <div className="tb-grid">
        <span className="label">Mode</span>
        <select value={verb} onChange={(e) => setVerb(e.target.value as AmVerb)}>
          {AM_MODES.map(([label, v]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
        <span className="label">Action</span>
        <input className="line-edit" type="text" value={action} placeholder="android.intent.action.VIEW" onChange={(e) => setAction(e.target.value)} />
        <span className="label">Data</span>
        <input className="line-edit" type="text" value={data} placeholder="data URI  (geo:0,0?q=cafe, content://…, https://…)" onChange={(e) => setData(e.target.value)} />
        <span className="label">Type</span>
        <input className="line-edit" type="text" value={mime} placeholder="mime type  (text/plain)" onChange={(e) => setMime(e.target.value)} />
        <span className="label">Component</span>
        <input className="line-edit" type="text" value={component} placeholder="component  com.pkg/.MainActivity  (optional)" onChange={(e) => setComponent(e.target.value)} />
      </div>

      <div className="tb-row">
        <span className="label">Extras</span>
        <button className="toggle" title="Add an extra" onClick={addExtra}>
          <Icon name="plus" size={16} />
        </button>
        <span className="grow" />
        <button className="start" onClick={fireFull} disabled={busy}>
          <Icon name="send" size={15} />
          Send intent
        </button>
      </div>

      {extras.length > 0 ? (
        <div className="tb-extras">
          {extras.map((e, i) => (
            <div className="tb-extra-row" key={i}>
              <select value={e.type} onChange={(ev) => setExtra(i, { type: ev.target.value as ExtraType })}>
                {EXTRA_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <input className="line-edit" type="text" value={e.key} placeholder="key" onChange={(ev) => setExtra(i, { key: ev.target.value })} />
              <input className="line-edit" type="text" value={e.value} placeholder="value" onChange={(ev) => setExtra(i, { value: ev.target.value })} />
              <button className="toggle" title="Remove this extra" onClick={() => rmExtra(i)}>
                <Icon name="minus" size={16} />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="tb-log grow" ref={outRef}>
        {out || 'am output appears here…'}
      </div>
    </>
  )
}

// --- Monkey -----------------------------------------------------------------
function MonkeyPanel({ c }: { c: Controller }) {
  const [events, setEvents] = useState(500)
  const [seed, setSeed] = useState(42)
  const [throttle, setThrottle] = useState(100)
  const [running, setRunning] = useState(false)
  const [lines, setLines] = useState<string[]>([])
  const [status, setStatus] = useState('')
  const outRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const offLine = window.androidlab.toolbox.onMonkeyLine((line) =>
      setLines((prev) => [...prev, line].slice(-2000))
    )
    const offDone = window.androidlab.toolbox.onMonkeyDone(({ ok, summary }) => {
      setRunning(false)
      setLines((prev) => [...prev, `— ${summary}`].slice(-2000))
      setStatus(ok ? `✓ ${summary}` : `✗ ${summary}`)
    })
    // Unmount (leaving the Toolbox tab) always kills the on-device monkey.
    return () => {
      offLine()
      offDone()
      void window.androidlab.toolbox.monkeyStop()
    }
  }, [])

  useEffect(() => {
    const el = outRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])

  const toggle = (): void => {
    if (running) {
      void window.androidlab.toolbox.monkeyStop()
      return
    }
    if (!c.serial) {
      setStatus('✗ Monkey: no device selected')
      return
    }
    if (!c.appPkg) {
      setStatus('✗ Monkey: pick an app in the App box first')
      return
    }
    setLines([])
    setStatus(`Monkey → ${c.appPkg}`)
    setRunning(true)
    void window.androidlab.toolbox.monkeyStart(c.serial, c.appPkg, events, seed, throttle)
  }

  return (
    <>
      <div className="tb-row">
        <span className={c.appPkg ? 'tb-pkg' : 'label'}>{c.appPkg ?? 'Pick an app in the App box'}</span>
        <span className="tb-gap" />
        <span className="label">Events</span>
        <input className="tb-num" type="number" min={10} max={1000000} value={events} disabled={running} onChange={(e) => setEvents(Number(e.target.value))} />
        <span className="label">Seed</span>
        <input className="tb-num" type="number" min={0} max={1000000} value={seed} disabled={running} title="Same seed → same event sequence (reproducible crashes)" onChange={(e) => setSeed(Number(e.target.value))} />
        <span className="label">Throttle ms</span>
        <input className="tb-num" type="number" min={0} max={5000} value={throttle} disabled={running} onChange={(e) => setThrottle(Number(e.target.value))} />
        <span className="grow" />
        {status ? <span className="tb-status">{status}</span> : null}
        <button className={`start${running ? ' running' : ''}`} onClick={toggle}>
          {running ? (
            <>
              <Icon name="stop" size={15} />
              Stop
            </>
          ) : (
            <>
              <Icon name="play" size={15} />
              Start monkey
            </>
          )}
        </button>
      </div>
      <div className="tb-log grow" ref={outRef}>
        {lines.length > 0
          ? lines.join('\n')
          : 'Random UI stress events are injected into the selected app.\nSame seed = same sequence, so crashes are reproducible.'}
      </div>
    </>
  )
}

// --- Perfetto ---------------------------------------------------------------
function PerfettoPanel({ c, onSaved }: { c: Controller; onSaved: (spec: MessageBoxSpec) => void }) {
  const [presetIdx, setPresetIdx] = useState(0)
  const [durIdx, setDurIdx] = useState(1)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState('')
  const [status, setStatus] = useState('')

  useEffect(() => {
    const offP = window.androidlab.toolbox.onPerfettoProgress((m) => setProgress(m))
    const offD = window.androidlab.toolbox.onPerfettoDone(({ ok, message, dir }) => {
      setRunning(false)
      setProgress('')
      if (ok) {
        setStatus(`✓ ${message}`)
        onSaved({ title: 'Perfetto trace saved', body: `✓  ${message}`, dir })
      } else {
        setStatus(`✗ Perfetto: ${message}`)
      }
    })
    // Leaving the tab only unsubscribes — perfetto self-terminates and saves to
    // ~/Downloads on its own; the Cancel button + shutdown() still kill it.
    return () => {
      offP()
      offD()
    }
  }, [onSaved])

  const toggle = (): void => {
    if (running) {
      void window.androidlab.toolbox.perfettoCancel()
      return
    }
    if (!c.serial) {
      setStatus('✗ Perfetto: no device selected')
      return
    }
    const dur = PERFETTO_DURATIONS[durIdx][1]
    setRunning(true)
    setStatus(`Recording ${dur}s perfetto trace…`)
    void window.androidlab.toolbox.perfettoStart(c.serial, dur, PERFETTO_PRESETS[presetIdx][1])
  }

  return (
    <>
      <div className="tb-row">
        <span className="label">Categories</span>
        <select value={presetIdx} disabled={running} onChange={(e) => setPresetIdx(Number(e.target.value))}>
          {PERFETTO_PRESETS.map(([name], i) => (
            <option key={name} value={i}>
              {name}
            </option>
          ))}
        </select>
        <span className="label">Duration</span>
        <select value={durIdx} disabled={running} onChange={(e) => setDurIdx(Number(e.target.value))}>
          {PERFETTO_DURATIONS.map(([label], i) => (
            <option key={label} value={i}>
              {label}
            </option>
          ))}
        </select>
        <button className={`start${running ? ' running' : ''}`} onClick={toggle}>
          {running ? (
            <>
              <Icon name="stop" size={15} />
              Stop
            </>
          ) : (
            <>
              <Icon name="record" size={15} />
              Record trace
            </>
          )}
        </button>
        <button title="Open the trace viewer — drag the saved file in" onClick={() => window.open('https://ui.perfetto.dev')}>
          Open ui.perfetto.dev
        </button>
        <span className="grow" />
        {progress ? <span className="tb-status">{progress}</span> : status ? <span className="tb-status">{status}</span> : null}
      </div>
      <div className="tb-info">
        Captures a system trace (scheduling, frames, binder, memory…) with the device&apos;s built-in perfetto
        (Android 9+). The trace saves to ~/Downloads; inspect it in ui.perfetto.dev.
      </div>
    </>
  )
}

// --- Notifications ----------------------------------------------------------
function NotifsPanel({ c }: { c: Controller }) {
  const [items, setItems] = useState<NotifItem[]>([])
  const [count, setCount] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setItems([])
    setCount('')
  }, [c.serial])

  const refresh = async (): Promise<void> => {
    if (!c.serial) {
      setCount('✗ Notifications: no device selected')
      return
    }
    if (busy) return
    setBusy(true)
    const r = await window.androidlab.toolbox.listNotifs(c.serial)
    setBusy(false)
    if (!r.ok) {
      setCount(`✗ ${r.message}`)
      return
    }
    setItems(r.items)
    setCount(r.message)
  }

  return (
    <>
      <div className="tb-row">
        <button disabled={busy} onClick={() => void refresh()}>
          <Icon name="refresh" size={15} />
          Refresh
        </button>
        {count ? <span className="tb-status">{count}</span> : null}
      </div>
      <div className="tb-table-wrap grow">
        <table className="tb-table">
          <thead>
            <tr>
              <th>package</th>
              <th>channel</th>
              <th>title</th>
              <th>text</th>
              <th>when</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, i) => (
              <tr key={`${it.key}|${i}`}>
                <td>{it.pkg}</td>
                <td>{it.channel}</td>
                <td>{it.title}</td>
                <td>{it.text}</td>
                <td>{it.when}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

// --- Bugreport --------------------------------------------------------------
function BugreportPanel({ c, onSaved }: { c: Controller; onSaved: (spec: MessageBoxSpec) => void }) {
  const [running, setRunning] = useState(false)
  const [pct, setPct] = useState(0)
  const [status, setStatus] = useState('')

  useEffect(() => {
    const offP = window.androidlab.toolbox.onBugreportProgress((p) => setPct(p))
    const offD = window.androidlab.toolbox.onBugreportDone(({ ok, message, dir }) => {
      setRunning(false)
      if (ok) {
        setStatus(`✓ ${message}`)
        onSaved({ title: 'Bugreport saved', body: `✓  ${message}`, dir })
      } else {
        setStatus(`✗ ${message}`)
      }
    })
    // Leaving the tab only unsubscribes — the bugreport completes and saves on
    // its own; the Cancel button + shutdown() still kill it.
    return () => {
      offP()
      offD()
    }
  }, [onSaved])

  const toggle = (): void => {
    if (running) {
      void window.androidlab.toolbox.bugreportCancel()
      return
    }
    if (!c.serial) {
      setStatus('✗ Bugreport: no device selected')
      return
    }
    setRunning(true)
    setPct(0)
    setStatus('Generating bugreport…')
    void window.androidlab.toolbox.bugreportStart(c.serial)
  }

  return (
    <>
      <div className="tb-row">
        <button className={`start${running ? ' running' : ''}`} onClick={toggle}>
          {running ? (
            <>
              <Icon name="stop" size={15} />
              Cancel
            </>
          ) : (
            <>
              <Icon name="report" size={15} />
              Generate bugreport
            </>
          )}
        </button>
        {running ? (
          <div className="tb-progress">
            <div className="tb-progress-fill" style={{ width: `${pct}%` }} />
            <span className="tb-progress-label">{pct}%</span>
          </div>
        ) : null}
        {status ? <span className="tb-status">{status}</span> : null}
      </div>
      <div className="tb-info">
        Full device bugreport (dumpstate + dumpsys + logs) zipped to ~/Downloads. Takes a minute or two.
      </div>
    </>
  )
}

// --- Host -------------------------------------------------------------------
export function ToolboxView({ c }: { c: Controller }) {
  const [active, setActive] = useState<SubTab>('intents')
  const [msg, setMsg] = useState<MessageBoxSpec | null>(null)
  // Stable so the panel subscription effects run once.
  const onSaved = useCallback((spec: MessageBoxSpec) => setMsg(spec), [])

  const panel = (id: SubTab): React.CSSProperties => ({ display: active === id ? 'flex' : 'none' })

  return (
    <div className="tb-view">
      <div className="tb-tabs">
        {SUBTABS.map(([id, label]) => (
          <button key={id} className={`tab${active === id ? ' selected' : ''}`} onClick={() => setActive(id)}>
            {label}
          </button>
        ))}
      </div>

      <div className="tb-scroll" style={panel('intents')}>
        <IntentsPanel c={c} />
      </div>
      <div className="tb-scroll" style={panel('monkey')}>
        <MonkeyPanel c={c} />
      </div>
      <div className="tb-scroll" style={panel('perfetto')}>
        <PerfettoPanel c={c} onSaved={onSaved} />
      </div>
      <div className="tb-scroll" style={panel('notifs')}>
        <NotifsPanel c={c} />
      </div>
      <div className="tb-scroll" style={panel('bugreport')}>
        <BugreportPanel c={c} onSaved={onSaved} />
      </div>

      {msg ? <MessageBox spec={msg} onClose={() => setMsg(null)} /> : null}
    </div>
  )
}
