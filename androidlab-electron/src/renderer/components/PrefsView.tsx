/**
 * SharedPreferences editor — port of prefs.py's PrefsView, embedded as the
 * Apps ▸ Prefs sub-tab. File list on the left, a typed key/value table on the
 * right with inline edit + revert-on-invalid, Save to device, and Force-stop
 * (apps cache prefs in memory). Follows the app selected in the Apps list.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { validatePrefValue, type Pref } from '@core/prefs'

interface PrefsViewProps {
  serial: string | null
  pkg: string | null
  active: boolean
  onStatus: (msg: string) => void
  onFailed: (msg: string) => void
}

function ValueCell({ pref, onCommit }: { pref: Pref; onCommit: (val: string) => boolean }) {
  const [draft, setDraft] = useState(pref.value)
  useEffect(() => setDraft(pref.value), [pref.value])
  if (pref.type === 'set') return <span className="prefs-val ro">{pref.value}</span>
  const commit = (): void => {
    if (draft === pref.value) return
    if (!onCommit(draft)) setDraft(pref.value)
  }
  return (
    <input
      className="prefs-val"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
    />
  )
}

export function PrefsView({ serial, pkg, active, onStatus, onFailed }: PrefsViewProps) {
  const [files, setFiles] = useState<string[]>([])
  const [fname, setFname] = useState<string | null>(null)
  const [prefs, setPrefs] = useState<Pref[]>([])
  const [dirty, setDirty] = useState(false)
  const [info, setInfo] = useState('Pick an app in the App box')
  const [busy, setBusy] = useState(false)
  const loadSeq = useRef(0)

  const reload = useCallback(async () => {
    if (!serial || !pkg) return
    setBusy(true)
    const r = await window.androidlab.prefs.list(serial, pkg)
    setBusy(false)
    setFiles([])
    setPrefs([])
    setFname(null)
    setDirty(false)
    if (!r.ok) {
      setInfo(`${pkg}: ${r.error}`)
      onFailed(`Prefs: ${r.error}`)
      return
    }
    setFiles(r.files)
    setInfo(`${pkg}   ·   ${r.files.length} file(s)   ·   ${r.usedSu ? 'root' : 'run-as'}`)
    if (r.files.length > 0) void pick(r.files[0])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serial, pkg, onFailed])

  const pick = useCallback(
    async (name: string) => {
      if (!serial || !pkg) return
      setFname(name)
      const seq = ++loadSeq.current
      const r = await window.androidlab.prefs.load(serial, pkg, name)
      if (seq !== loadSeq.current) return // stale
      if (!r.ok) {
        onFailed(`Prefs: ${r.error}`)
        return
      }
      setPrefs(r.prefs)
      setDirty(false)
    },
    [serial, pkg, onFailed]
  )

  // Clear + (re)load when the device/app changes while active.
  useEffect(() => {
    setFiles([])
    setPrefs([])
    setFname(null)
    setDirty(false)
    setInfo(pkg ? pkg : 'Pick an app in the App box')
    if (active && serial && pkg) void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serial, pkg])

  // Lazy-load when the sub-tab is first shown (showEvent equivalent).
  useEffect(() => {
    if (active && pkg && files.length === 0 && !busy) void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  const commitValue = useCallback(
    (i: number, val: string): boolean => {
      const p = prefs[i]
      const err = validatePrefValue(p.type, val)
      if (err) {
        onFailed(`Prefs: ${p.key}: ${err}`)
        return false
      }
      setPrefs((prev) => prev.map((q, j) => (j === i ? { ...q, value: val } : q)))
      setDirty(true)
      return true
    },
    [prefs, onFailed]
  )

  const save = useCallback(async () => {
    if (!dirty || !fname || !serial || !pkg) return
    setDirty(false)
    const r = await window.androidlab.prefs.save(serial, pkg, fname, prefs)
    if (r.ok) {
      onStatus(`✓ ${fname} written — force-stop the app to apply`)
    } else {
      setDirty(true)
      onFailed(`Prefs: ${r.error}`)
    }
  }, [dirty, fname, serial, pkg, prefs, onStatus, onFailed])

  const forceStop = useCallback(async () => {
    if (!serial || !pkg) return
    await window.androidlab.prefs.forceStop(serial, pkg)
    onStatus(`✓ force-stopped ${pkg}`)
  }, [serial, pkg, onStatus])

  return (
    <div className="prefs-view">
      <div className="prefs-bar">
        <button disabled={busy || !pkg} onClick={() => void reload()}>
          ⟳  Reload
        </button>
        <button disabled={!dirty} onClick={() => void save()}>
          💾  Save to device
        </button>
        <button
          disabled={!pkg}
          title="The app caches prefs in memory — force-stop so the next launch re-reads the edited file"
          onClick={() => void forceStop()}
        >
          Force-stop app
        </button>
        <span className="grow" />
        <span className="prefs-info">{info}</span>
      </div>
      <div className="prefs-split">
        <div className="prefs-files">
          {files.map((f) => (
            <div
              key={f}
              className={`prefs-file${f === fname ? ' selected' : ''}`}
              onClick={() => void pick(f)}
            >
              {f}
            </div>
          ))}
        </div>
        <div className="prefs-table-wrap">
          <table className="prefs-table">
            <thead>
              <tr>
                <th>key</th>
                <th>type</th>
                <th>value</th>
              </tr>
            </thead>
            <tbody>
              {prefs.map((p, i) => (
                <tr key={`${p.key}|${i}`}>
                  <td className="k">{p.key}</td>
                  <td className="t">{p.type}</td>
                  <td className="v">
                    <ValueCell pref={p} onCommit={(val) => commitValue(i, val)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
