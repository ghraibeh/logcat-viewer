/**
 * iOS screen mirror dock (macOS) — the go-ios counterpart to MirrorDock.tsx.
 *
 * The main process streams raw Annex-B H.264 from the native capture helper (the
 * QuickTime/CoreMediaIO path — see services/iosmirror.ts). This decodes it with
 * WebCodecs exactly like the Android scrcpy mirror: AnnexBDemuxer → VideoDecoder →
 * canvas, with a rAF present loop and keyframe-resync backpressure. View-only (no
 * input injection on iOS without WebDriverAgent); rail = full screen, screenshot,
 * close, plus a status chip.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { AnnexBDemuxer } from '@core/mirror'
import type { IosMirrorState, SaveResult } from '@shared/types'
import { Icon } from './Icon'

const HAS_WEBCODECS = typeof (globalThis as { VideoDecoder?: unknown }).VideoDecoder !== 'undefined'
const MAX_DECODE_QUEUE = 6

type Fit = { x: number; y: number; w: number; h: number }

/** Owns the canvas + WebCodecs decoder for the H.264 feed. Kept outside React so
 *  frames never trigger re-renders. Trimmed port of MirrorDock's MirrorEngine. */
class H264Engine {
  private canvas: HTMLCanvasElement | null = null
  private demuxer = new AnnexBDemuxer()
  private decoder: VideoDecoder | null = null
  private configured = false
  private ts = 0
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private pending: { frame: VideoFrame; w: number; h: number } | null = null
  private rafId = 0
  private running = false
  srcW = 0
  srcH = 0
  scale = 1
  rotation = 0 // view rotation in degrees (0/90/180/270), portrait <-> landscape
  fit: Fit | null = null
  onFail: ((message: string) => void) | null = null

  setRotation(deg: number): void {
    this.rotation = ((deg % 360) + 360) % 360
  }

  attach(canvas: HTMLCanvasElement | null): void {
    this.canvas = canvas
    if (this.running) return
    this.running = true
    const tick = (): void => {
      if (!this.running) return
      this.paintPending()
      this.rafId = requestAnimationFrame(tick)
    }
    this.rafId = requestAnimationFrame(tick)
  }

  pushH264(chunk: Uint8Array): void {
    if (!HAS_WEBCODECS) return
    for (const au of this.demuxer.push(chunk)) this.feed(au.data, au.key)
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => {
      for (const au of this.demuxer.flush()) this.feed(au.data, au.key)
    }, 16)
  }

  private ensureDecoder(): VideoDecoder | null {
    if (this.decoder) return this.decoder
    try {
      this.decoder = new VideoDecoder({
        output: (frame) => this.setPending(frame),
        error: (e) => this.fail(e.message || 'decode error')
      })
    } catch (e) {
      this.fail(e instanceof Error ? e.message : String(e))
      return null
    }
    return this.decoder
  }

  private feed(data: Uint8Array, key: boolean): void {
    const dec = this.ensureDecoder()
    if (!dec || dec.state === 'closed') return
    if (this.configured && dec.decodeQueueSize > MAX_DECODE_QUEUE) {
      try {
        dec.reset()
      } catch {
        /* ignore */
      }
      this.configured = false
      return
    }
    if (!this.configured) {
      const codec = this.demuxer.codecString()
      if (!key || !codec) return // wait for a keyframe + its SPS to configure
      try {
        dec.configure({ codec, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' })
        this.configured = true
      } catch (e) {
        this.fail(e instanceof Error ? e.message : String(e))
        return
      }
    }
    try {
      dec.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: this.ts, data }))
      this.ts += 33333
    } catch (e) {
      this.fail(e instanceof Error ? e.message : String(e))
    }
  }

  private setPending(frame: VideoFrame): void {
    if (this.pending) {
      try {
        this.pending.frame.close()
      } catch {
        /* already closed */
      }
    }
    this.pending = { frame, w: frame.displayWidth, h: frame.displayHeight }
  }

  private paintPending(): void {
    const p = this.pending
    if (!p) return
    this.pending = null
    this.drawSource(p.frame, p.w, p.h)
    try {
      p.frame.close()
    } catch {
      /* already closed */
    }
  }

  private drawSource(src: CanvasImageSource, sw: number, sh: number): void {
    const canvas = this.canvas
    const parent = canvas?.parentElement
    if (!canvas || !parent || sw === 0 || sh === 0) return
    const cw = parent.clientWidth
    const ch = parent.clientHeight
    if (cw === 0 || ch === 0) return
    const dpr = window.devicePixelRatio || 1
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
      canvas.width = Math.round(cw * dpr)
      canvas.height = Math.round(ch * dpr)
      canvas.style.width = `${cw}px`
      canvas.style.height = `${ch}px`
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    // Rotate the view about the canvas centre: at 90/270 the fit box swaps W/H, so a
    // portrait phone fills the pane horizontally (and vice-versa).
    const rot = ((this.rotation % 360) + 360) % 360
    const swap = rot === 90 || rot === 270
    const effW = swap ? sh : sw
    const effH = swap ? sw : sh
    const scale = Math.min(cw / effW, ch / effH)
    const dw = sw * scale
    const dh = sh * scale
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = '#0d0f13'
    ctx.fillRect(0, 0, cw, ch)
    ctx.translate(cw / 2, ch / 2)
    ctx.rotate((rot * Math.PI) / 180)
    ctx.imageSmoothingEnabled = true
    ctx.drawImage(src, -dw / 2, -dh / 2, dw, dh)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    this.srcW = sw
    this.srcH = sh
    this.scale = scale
    const boxW = effW * scale
    const boxH = effH * scale
    this.fit = { x: (cw - boxW) / 2, y: (ch - boxH) / 2, w: boxW, h: boxH }
  }

  /** PNG data URL of just the mirrored content (letterbox cropped out), or null. */
  snapshot(): string | null {
    const canvas = this.canvas
    if (!canvas || !this.fit || this.srcW === 0) return null
    const dpr = window.devicePixelRatio || 1
    const sx = Math.round(this.fit.x * dpr)
    const sy = Math.round(this.fit.y * dpr)
    const sw = Math.round(this.fit.w * dpr)
    const sh = Math.round(this.fit.h * dpr)
    const off = document.createElement('canvas')
    off.width = sw
    off.height = sh
    const ctx = off.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh)
    return off.toDataURL('image/png')
  }

  reset(): void {
    this.demuxer.reset()
    this.configured = false
    this.ts = 0
    if (this.pending) {
      try {
        this.pending.frame.close()
      } catch {
        /* ignore */
      }
      this.pending = null
    }
    if (this.decoder) {
      try {
        this.decoder.close()
      } catch {
        /* ignore */
      }
      this.decoder = null
    }
  }

  /** Blank the canvas to the mirror background (device switch) so no stale frame
   *  lingers behind the loader; also drops stale fit/size so snapshot is disabled. */
  clear(): void {
    const canvas = this.canvas
    if (canvas && canvas.width && canvas.height) {
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.fillStyle = '#0d0f13'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
      }
    }
    this.srcW = 0
    this.srcH = 0
    this.fit = null
  }

  private fail(message: string): void {
    this.reset()
    this.onFail?.(message)
  }

  close(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.running = false
    if (this.rafId) cancelAnimationFrame(this.rafId)
    this.rafId = 0
    this.reset()
    this.canvas = null
  }
}

export function IosMirrorDock({
  serial,
  onClose,
  onCaptured,
  onPopout,
  popped = false
}: {
  serial: string | null
  onClose: () => void
  onCaptured: (result: SaveResult) => void
  /** Detach into a separate window (docked) or re-dock (popped). Hidden if absent. */
  onPopout?: () => void
  /** True when rendered inside the detached window. */
  popped?: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<H264Engine>(new H264Engine())

  const [hasFrame, setHasFrame] = useState(false)
  const [message, setMessage] = useState('Connecting…')
  const [failed, setFailed] = useState<string | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [rotation, setRotation] = useState(0) // view rotation (0/90/180/270)

  // Attach the canvas + present loop for the component's lifetime.
  useEffect(() => {
    const eng = engineRef.current
    eng.attach(canvasRef.current)
    eng.onFail = (m) => setFailed(m)
    return () => eng.close()
  }, [])

  // Push the view rotation to the engine; the next painted frame applies it.
  useEffect(() => {
    engineRef.current.setRotation(rotation)
  }, [rotation])

  // (Re)start the feed whenever the device changes.
  useEffect(() => {
    if (!serial) {
      setMessage('No device selected')
      return
    }
    setFailed(null)
    setHasFrame(false)
    setMessage('Connecting to device…')
    engineRef.current.reset()
    engineRef.current.clear()
    void window.androidlab.iosMirror.start(serial)
    return () => {
      void window.androidlab.iosMirror.stop()
      engineRef.current.reset()
    }
  }, [serial])

  // IPC subscriptions.
  useEffect(() => {
    const eng = engineRef.current
    const unH264 = window.androidlab.iosMirror.onH264((chunk) => {
      eng.pushH264(chunk)
      setHasFrame(true)
      setFailed(null)
    })
    const unState = window.androidlab.iosMirror.onState((s: IosMirrorState) => setMessage(s.message))
    const unFail = window.androidlab.iosMirror.onFailed((m) => {
      setFailed(m)
      setHasFrame(false)
    })
    return () => {
      unH264()
      unState()
      unFail()
    }
  }, [])

  const doScreenshot = useCallback(async () => {
    const dataUrl = engineRef.current.snapshot()
    if (!dataUrl) return
    setBusy(true)
    const r = await window.androidlab.iosMirror.saveFrame(dataUrl)
    setBusy(false)
    onCaptured(r)
  }, [onCaptured])

  // Fullscreen: detached in its own window, drive the real OS-window fullscreen (a
  // separate window's "full screen" should fill the display, not just this pane).
  // Docked, expand the pane over the app window via the CSS overlay (.mirror-fs).
  const toggleFullscreen = useCallback(() => {
    if (popped) void window.androidlab.mirror.popoutToggleFullscreen()
    else setFullscreen((v) => !v)
  }, [popped])

  // Popout: mirror the OS-window fullscreen state (our button, the green traffic
  // light, or Ctrl+⌘+F) so the icon + overlay stay in sync.
  useEffect(() => {
    if (!popped) return
    return window.androidlab.mirror.onPopoutFullscreen(setFullscreen)
  }, [popped])

  // Esc exits fullscreen.
  useEffect(() => {
    if (!fullscreen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (popped) void window.androidlab.mirror.popoutToggleFullscreen()
      else setFullscreen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fullscreen, popped])

  return (
    <div className={`mirror-dock${fullscreen ? ' mirror-fs' : ''}`}>
      <div className="mirror-canvas-wrap">
        <canvas ref={canvasRef} className="ios-surface" />
        {failed ? (
          <div className="mirror-msg">{failed}</div>
        ) : !hasFrame ? (
          serial ? (
            <div className="mirror-loading">
              <div className="mirror-spinner" />
              <div className="mirror-loading-tx">{message}</div>
            </div>
          ) : (
            <div className="mirror-msg">{message}</div>
          )
        ) : null}
      </div>

      <div className="mirror-rail">
        {/* Close is pinned to the top of the rail (sticky) so it's always reachable. */}
        <button
          className="rail-btn rail-close"
          title={popped ? 'Close mirror window' : 'Close mirror'}
          onClick={onClose}
        >
          <Icon name="close" size={24} />
        </button>

        <div className="rail-div" />

        <button
          className="rail-btn"
          title={fullscreen ? 'Exit full screen (Esc)' : 'Full screen mirror (Esc to exit)'}
          onClick={toggleFullscreen}
        >
          <Icon name={fullscreen ? 'contract' : 'fullscreen'} size={24} />
        </button>
        <button
          className={`rail-btn${rotation ? ' active' : ''}`}
          title="Rotate the mirror 90° (portrait / landscape)"
          onClick={() => setRotation((r) => (r + 90) % 360)}
        >
          <Icon name="rotate" size={24} />
        </button>

        <div className="rail-div" />

        <button
          className="rail-btn"
          title="Save a screenshot to ~/Downloads"
          disabled={!hasFrame || busy}
          onClick={() => void doScreenshot()}
        >
          <Icon name="camera" size={24} />
        </button>

        {onPopout ? (
          <>
            <div className="rail-div" />
            <button
              className="rail-btn"
              title={popped ? 'Dock back into the main window' : 'Open mirror in a separate window'}
              onClick={onPopout}
            >
              <Icon name={popped ? 'popin' : 'popout'} size={24} />
            </button>
          </>
        ) : null}
      </div>
    </div>
  )
}
