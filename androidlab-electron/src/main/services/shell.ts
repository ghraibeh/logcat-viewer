/**
 * Interactive `adb -s <serial> shell` session over a real PTY (node-pty).
 * node-pty gives adb a local pseudo-terminal, so adb allocates a REMOTE pty on
 * the device — a genuine interactive shell: the device's own prompt, ANSI colors,
 * job control, working Ctrl-C, tab-completion, and full-screen programs (top,
 * vi). Keystrokes from the renderer's xterm are written straight to the pty and
 * output streams back verbatim (no synthetic prompt, no line buffering). Window
 * size is forwarded so the remote pty (SIGWINCH) matches the terminal.
 *
 * node-pty is a native module; it is loaded lazily + guarded so a missing/unbuilt
 * binary degrades to an error message instead of crashing the whole app. Rebuild
 * it for Electron with `npm run rebuild`.
 */
import type * as NodePty from 'node-pty'
import type { LogcatState } from '@shared/types'

let ptyMod: typeof NodePty | null | undefined

function loadPty(): typeof NodePty | null {
  if (ptyMod !== undefined) return ptyMod
  try {
    // Externalized by electron-vite; resolved from node_modules at runtime.
    ptyMod = require('node-pty') as typeof NodePty
  } catch {
    ptyMod = null
  }
  return ptyMod
}

/** 'device' = `adb shell` (remote pty); 'local' = this Mac's login shell. */
export type ShellKind = 'device' | 'local'

export interface ShellCallbacks {
  onData: (data: string) => void
  onState: (state: LogcatState) => void
}

export class ShellSession {
  private proc: NodePty.IPty | null = null

  constructor(
    private readonly adb: string,
    private readonly cb: ShellCallbacks
  ) {}

  get running(): boolean {
    return this.proc !== null
  }

  start(kind: ShellKind, serial: string, cols: number, rows: number): void {
    this.stop()
    const p = loadPty()
    if (!p) {
      this.cb.onData(
        '\r\n\x1b[31m[shell unavailable: node-pty failed to load — run `npm run rebuild`]\x1b[0m\r\n'
      )
      this.cb.onState('error')
      return
    }
    // Device: a controlling pty makes `adb shell` open an interactive remote shell.
    // Local: this Mac's own login shell (run adb/git/etc. right here).
    const [file, args] =
      kind === 'local'
        ? [process.env.SHELL || '/bin/zsh', ['-l']]
        : [this.adb, ['-s', serial, 'shell']]
    const proc = p.spawn(file, args, {
      name: 'xterm-256color',
      cols: cols > 0 ? cols : 80,
      rows: rows > 0 ? rows : 24,
      cwd: process.env.HOME,
      env: process.env as { [key: string]: string }
    })
    this.proc = proc
    this.cb.onState('started')
    proc.onData((d) => this.cb.onData(d))
    proc.onExit(() => {
      if (this.proc === proc) this.proc = null
      this.cb.onState('stopped')
    })
  }

  /** Forward raw keystrokes (incl. Ctrl-C = \x03, arrows, etc.) to the pty. */
  write(data: string): void {
    this.proc?.write(data)
  }

  resize(cols: number, rows: number): void {
    if (this.proc && cols > 0 && rows > 0) {
      try {
        this.proc.resize(cols, rows)
      } catch {
        /* pty may have already exited */
      }
    }
  }

  stop(): void {
    if (this.proc !== null) {
      const proc = this.proc
      this.proc = null
      try {
        proc.kill()
      } catch {
        /* already gone */
      }
      this.cb.onState('stopped')
    }
  }

  shutdown(): void {
    this.stop()
  }
}
