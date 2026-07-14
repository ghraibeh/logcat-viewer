/**
 * Shell tab — a set of independent interactive terminals (xterm.js), each wired
 * to its own PTY-backed `adb shell` (or local shell) in the main process. You
 * can open multiple concurrent sessions as sub-tabs (like several terminal
 * windows): keystrokes are forwarded verbatim to that tab's remote pty and its
 * output streams straight back, so the device's own prompt, ANSI colors, Ctrl-C,
 * tab-completion, and full-screen programs (top, vi) all work.
 *
 * Each pane owns a session `id`; the main process keys one pty per id and tags
 * its output with that id, so panes never cross-talk. All panes stay mounted
 * while the Shell tab is open (so scrollback + the live pty survive sub-tab
 * switches); every pty is killed when its tab is closed or the Shell tab is left.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { Controller } from '../state/useAppController'
import { Icon } from './Icon'

// Terminal palette — matches the app's dark theme (theme.css custom props).
const THEME = {
  background: '#121318',
  foreground: '#e9ebf3',
  cursor: '#6e7bff',
  cursorAccent: '#121318',
  selectionBackground: 'rgba(110, 123, 255, 0.30)',
  black: '#16171c',
  red: '#f25a52',
  green: '#31c96e',
  yellow: '#e3a812',
  blue: '#6e7bff',
  magenta: '#b98bff',
  cyan: '#3fc7d4',
  white: '#e9ebf3',
  brightBlack: '#7e8595'
}

type ShellKind = 'device' | 'local'

const MAX_SESSIONS = 12

interface Session {
  id: string
  n: number
  /** user-set tab name (double-click to rename); falls back to `Shell {n}`. */
  name?: string
}

// --- one terminal bound to one main-process pty session ----------------------
function ShellPane({
  id,
  c,
  active,
  onMode
}: {
  id: string
  c: Controller
  active: boolean
  onMode: (id: string, mode: ShellKind) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const [running, setRunning] = useState(false)
  const [mode, setMode] = useState<ShellKind>('device')
  const serialRef = useRef<string | null>(c.serial)
  serialRef.current = c.serial
  const modeRef = useRef<ShellKind>(mode)
  modeRef.current = mode

  useEffect(() => onMode(id, mode), [id, mode, onMode])

  // Build the terminal once; wire keystrokes <-> this session's pty, filtering
  // the shared data/state streams down to our own id.
  useEffect(() => {
    const term = new Terminal({
      fontFamily: '"SF Mono", Menlo, monospace',
      fontSize: 12,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 5000,
      theme: THEME
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    termRef.current = term
    fitRef.current = fit
    if (hostRef.current) term.open(hostRef.current)
    try {
      fit.fit()
    } catch {
      /* container not laid out yet — the ResizeObserver will fix it */
    }

    const onKey = term.onData((data) => void window.androidlab.shell.write(id, data))
    const offData = window.androidlab.shell.onData((eid, data) => {
      if (eid === id) term.write(data)
    })
    const offState = window.androidlab.shell.onState((eid) => {
      if (eid === id) void window.androidlab.shell.running(id).then(setRunning)
    })

    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        /* ignore transient zero-size (hidden pane) */
      }
      void window.androidlab.shell.resize(id, term.cols, term.rows)
    })
    if (hostRef.current) ro.observe(hostRef.current)

    return () => {
      onKey.dispose()
      offData()
      offState()
      ro.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [id])

  // Start / restart the pty whenever the target changes. The key is constant in
  // local mode (so switching devices doesn't kill your local session) and
  // device-serial-scoped in device mode (so it reconnects on device change).
  const targetKey = mode === 'local' ? 'local' : `device:${c.serial ?? ''}`
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    if (mode === 'device' && !c.serial) {
      void window.androidlab.shell.stop(id)
      setRunning(false)
      term.clear()
      term.writeln('\x1b[90mNo device selected. Pick a device in the toolbar.\x1b[0m')
      return
    }
    try {
      fitRef.current?.fit()
    } catch {
      /* ignore */
    }
    term.clear()
    term.writeln(
      mode === 'local'
        ? '\x1b[90mLocal shell — this Mac …\x1b[0m'
        : `\x1b[90mConnecting to ${c.serial} …\x1b[0m`
    )
    void window.androidlab.shell.start(id, mode, c.serial ?? '', term.cols, term.rows)
    if (active) term.focus()
    return () => {
      void window.androidlab.shell.stop(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey])

  // When this pane becomes visible again, re-fit (it may have been display:none)
  // and take focus so typing lands here.
  useEffect(() => {
    if (!active) return
    const term = termRef.current
    if (!term) return
    try {
      fitRef.current?.fit()
    } catch {
      /* ignore */
    }
    void window.androidlab.shell.resize(id, term.cols, term.rows)
    term.focus()
  }, [active, id])

  const restart = (): void => {
    const term = termRef.current
    if (!term) return
    const kind = modeRef.current
    const s = serialRef.current
    if (kind === 'device' && !s) return
    term.clear()
    term.writeln('\x1b[90mRestarting shell …\x1b[0m')
    void window.androidlab.shell.start(id, kind, s ?? '', term.cols, term.rows)
    term.focus()
  }

  return (
    <div className="shell-pane" style={{ display: active ? 'flex' : 'none' }}>
      <div className="shell-bar">
        <div className="shell-seg" role="tablist" title="Switch between the device shell and this Mac's shell">
          <button
            className={mode === 'device' ? 'on' : ''}
            role="tab"
            aria-selected={mode === 'device'}
            onClick={() => setMode('device')}
          >
            <Icon name="phone" size={15} />
            Device
          </button>
          <button
            className={mode === 'local' ? 'on' : ''}
            role="tab"
            aria-selected={mode === 'local'}
            onClick={() => setMode('local')}
          >
            <Icon name="laptop" size={15} />
            PC
          </button>
        </div>
        <span className={`shell-dot${running ? ' on' : ''}`} title={running ? 'shell running' : 'shell not running'} />
        <span className="shell-target">
          {mode === 'local'
            ? 'local shell (this Mac)'
            : c.serial
              ? `adb -s ${c.serial} shell`
              : 'no device selected'}
        </span>
        <span className="grow" />
        <button
          className="toggle"
          title="Kill and reopen the shell"
          disabled={mode === 'device' && !c.serial}
          onClick={restart}
        >
          <Icon name="refresh" size={15} />
          Restart
        </button>
        <button className="toggle" title="Clear the terminal" onClick={() => termRef.current?.clear()}>
          Clear
        </button>
      </div>
      <div className="shell-term" ref={hostRef} onClick={() => termRef.current?.focus()} />
    </div>
  )
}

// --- container: the session tab-strip over all mounted panes -----------------
export function ShellView({ c }: { c: Controller }) {
  const nextId = useRef(2) // first session is sh-1
  const [sessions, setSessions] = useState<Session[]>([{ id: 'sh-1', n: 1 }])
  const [activeId, setActiveId] = useState('sh-1')
  const [modes, setModes] = useState<Record<string, ShellKind>>({})
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  const onMode = useCallback((id: string, mode: ShellKind) => {
    setModes((m) => (m[id] === mode ? m : { ...m, [id]: mode }))
  }, [])

  const tabName = (s: Session): string => s.name?.trim() || `Shell ${s.n}`

  const beginRename = (s: Session): void => {
    setEditingId(s.id)
    setDraft(tabName(s))
  }
  const commitRename = (): void => {
    if (editingId === null) return
    const id = editingId
    const next = draft.trim()
    setSessions((prev) =>
      prev.map((s) => (s.id === id ? { ...s, name: next || undefined } : s))
    )
    setEditingId(null)
  }

  const addSession = useCallback(() => {
    setSessions((prev) => {
      if (prev.length >= MAX_SESSIONS) return prev
      const n = nextId.current++
      const s = { id: `sh-${n}`, n }
      setActiveId(s.id)
      return [...prev, s]
    })
  }, [])

  const closeSession = useCallback((id: string) => {
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id)
      if (next.length > 0) return next
      // never leave zero tabs — replace with a fresh one
      const n = nextId.current++
      return [{ id: `sh-${n}`, n }]
    })
    setModes((m) => {
      if (!(id in m)) return m
      const copy = { ...m }
      delete copy[id]
      return copy
    })
  }, [])

  // Heal the active id if the current one was closed → jump to the last tab.
  useEffect(() => {
    if (sessions.length && !sessions.some((s) => s.id === activeId)) {
      setActiveId(sessions[sessions.length - 1].id)
    }
  }, [sessions, activeId])

  const effectiveActive = sessions.some((s) => s.id === activeId) ? activeId : sessions[0]?.id

  return (
    <div className="shell-view">
      <div className="shell-tabs" role="tablist">
        {sessions.map((s) => (
          <div
            key={s.id}
            className={`shell-tab${s.id === effectiveActive ? ' on' : ''}`}
            role="tab"
            aria-selected={s.id === effectiveActive}
            onClick={() => setActiveId(s.id)}
            onDoubleClick={() => beginRename(s)}
            title="Double-click to rename"
          >
            <span className="ico">
              {modes[s.id] === 'local' ? <Icon name="laptop" size={14} /> : <Icon name="phone" size={14} />}
            </span>
            {editingId === s.id ? (
              <input
                className="rename"
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onFocus={(e) => e.target.select()}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename()
                  else if (e.key === 'Escape') setEditingId(null)
                }}
              />
            ) : (
              <span className="label">{tabName(s)}</span>
            )}
            <button
              className="close"
              title="Close this shell"
              onClick={(e) => {
                e.stopPropagation()
                closeSession(s.id)
              }}
            >
              <Icon name="close" size={13} />
            </button>
          </div>
        ))}
        <button
          className="shell-tab-add"
          title="New shell session"
          disabled={sessions.length >= MAX_SESSIONS}
          onClick={addSession}
        >
          <Icon name="plus" size={15} />
        </button>
      </div>
      <div className="shell-panes">
        {sessions.map((s) => (
          <ShellPane key={s.id} id={s.id} c={c} active={s.id === effectiveActive} onMode={onMode} />
        ))}
      </div>
    </div>
  )
}
