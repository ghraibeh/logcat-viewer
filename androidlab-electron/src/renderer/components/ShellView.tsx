/**
 * Shell tab — a real interactive terminal (xterm.js) wired to a PTY-backed
 * `adb shell` in the main process. You type directly into it: the device's own
 * prompt, ANSI colors, Ctrl-C, tab-completion, and full-screen programs (top, vi)
 * all work, because keystrokes are forwarded verbatim to the remote pty and its
 * output is written straight back. The session auto-starts for the selected
 * device, restarts on device change, resizes with the pane, and is killed on
 * unmount — no orphaned `adb shell` outlives the tab.
 */
import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { Controller } from '../state/useAppController'

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

export function ShellView({ c }: { c: Controller }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const [running, setRunning] = useState(false)
  const [mode, setMode] = useState<ShellKind>('device')
  const serialRef = useRef<string | null>(c.serial)
  serialRef.current = c.serial
  const modeRef = useRef<ShellKind>(mode)
  modeRef.current = mode

  // Build the terminal once; wire keystrokes <-> pty and track resize.
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

    const onKey = term.onData((data) => void window.androidlab.shell.write(data))
    const offData = window.androidlab.shell.onData((data) => term.write(data))
    const offState = window.androidlab.shell.onState(() => {
      void window.androidlab.shell.running().then(setRunning)
    })

    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        /* ignore transient zero-size */
      }
      void window.androidlab.shell.resize(term.cols, term.rows)
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
  }, [])

  // Start / restart the pty whenever the target changes. The key is constant in
  // local mode (so switching devices doesn't kill your local session) and
  // device-serial-scoped in device mode (so it reconnects on device change).
  const targetKey = mode === 'local' ? 'local' : `device:${c.serial ?? ''}`
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    if (mode === 'device' && !c.serial) {
      void window.androidlab.shell.stop()
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
    void window.androidlab.shell.start(mode, c.serial ?? '', term.cols, term.rows)
    term.focus()
    return () => {
      void window.androidlab.shell.stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey])

  const restart = (): void => {
    const term = termRef.current
    if (!term) return
    const kind = modeRef.current
    const s = serialRef.current
    if (kind === 'device' && !s) return
    term.clear()
    term.writeln('\x1b[90mRestarting shell …\x1b[0m')
    void window.androidlab.shell.start(kind, s ?? '', term.cols, term.rows)
    term.focus()
  }

  return (
    <div className="shell-view">
      <div className="shell-bar">
        <div className="shell-seg" role="tablist" title="Switch between the device shell and this Mac's shell">
          <button
            className={mode === 'device' ? 'on' : ''}
            role="tab"
            aria-selected={mode === 'device'}
            onClick={() => setMode('device')}
          >
            📱 Device
          </button>
          <button
            className={mode === 'local' ? 'on' : ''}
            role="tab"
            aria-selected={mode === 'local'}
            onClick={() => setMode('local')}
          >
            💻 PC
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
          ⟳ Restart
        </button>
        <button className="toggle" title="Clear the terminal" onClick={() => termRef.current?.clear()}>
          Clear
        </button>
      </div>
      <div className="shell-term" ref={hostRef} onClick={() => termRef.current?.focus()} />
    </div>
  )
}
