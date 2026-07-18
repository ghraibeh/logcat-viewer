/**
 * Root of the detached mirror window (Android Studio-style pop-out).
 *
 * `main.tsx` mounts this instead of <App> when the renderer loads at the
 * `#mirror` route (opened by MirrorWindowManager). It hosts just the mirror
 * dock, tracking whichever device the main window tells it to mirror via the
 * `popoutInfo()` handshake + `onPopoutInfo` updates. The dock's close and
 * dock-back buttons both re-dock (closePopout(true)); closing the OS window
 * does the same through the main-process `closed` handler.
 */
import { useCallback, useEffect, useState } from 'react'
import type { MirrorPopoutInfo, SaveResult } from '@shared/types'
import { MirrorDock } from './MirrorDock'
import { IosMirrorDock } from './IosMirrorDock'

export function MirrorWindow() {
  const [info, setInfo] = useState<MirrorPopoutInfo | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  // Which device to mirror: read once on mount, then follow the main window.
  useEffect(() => {
    void window.androidlab.mirror.popoutInfo().then(setInfo)
    return window.androidlab.mirror.onPopoutInfo(setInfo)
  }, [])

  useEffect(() => {
    if (toast === null) return
    const id = setTimeout(() => setToast(null), 3500)
    return () => clearTimeout(id)
  }, [toast])

  // Re-attach the mirror into the main window.
  const redock = useCallback(() => void window.androidlab.mirror.closePopout(true), [])

  const onCaptured = useCallback((r: SaveResult) => {
    if (r.message && r.message !== 'cancelled') setToast(`${r.ok ? '✓' : '✗'} ${r.message}`)
  }, [])

  const install = useCallback(
    (paths: string[]) =>
      info?.serial ? window.androidlab.apk.install(info.serial, paths) : Promise.resolve(null),
    [info?.serial]
  )

  const serial = info?.serial ?? null
  const platform = info?.platform ?? 'android'

  return (
    <div className="mirror-window">
      {/* Custom title bar: the drag handle for the frameless (hiddenInset) window.
          Left padding clears the macOS traffic lights; the mirror body below is
          explicitly no-drag so interacting with the screen never moves the window. */}
      <div className="mirror-titlebar">
        <span className="mw-title">Screen Mirror</span>
      </div>
      <div className="mirror-window-body">
        {info === null ? (
          <div className="mirror-dock">
            <div className="mirror-canvas-wrap">
              <div className="mirror-msg">Connecting…</div>
            </div>
          </div>
        ) : info?.receiver || platform === 'ios' ? (
          <IosMirrorDock
            serial={serial}
            connection={info?.connection}
            receiver={info?.receiver}
            popped
            onClose={redock}
            onPopout={redock}
            onCaptured={onCaptured}
          />
        ) : (
          <MirrorDock
            serial={serial}
            install={install}
            popped
            onClose={redock}
            onPopout={redock}
            onCaptured={onCaptured}
          />
        )}
      </div>
      {toast ? <div className="mirror-window-toast">{toast}</div> : null}
    </div>
  )
}
