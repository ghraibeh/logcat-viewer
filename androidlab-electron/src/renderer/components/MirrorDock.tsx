/**
 * Screen mirror — port of mirror.py's MirrorView + _ScreenCanvas as a right-side
 * dock. The live feed is either the low-latency H.264 stream decoded in-page with
 * WebCodecs (PyAV's job in Python) or the screencap PNG poller fallback; clicks/
 * drags map back to device pixels and are forwarded via `input`. A control rail
 * carries nav keys, screenshot, MP4 record, clipboard paste / type, fullscreen,
 * a display picker, and scrcpy hand-off.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { AnnexBDemuxer, KEY_BACK, KEY_HOME, KEY_RECENTS, escapeInputText, isApkPath } from '@core/mirror'
import type { DisplayInfo } from '@core/mirror'
import type { SaveResult } from '@shared/types'
import type { Controller } from '../state/useAppController'
import { PALETTE } from '../theme'

const HAS_WEBCODECS = typeof (globalThis as { VideoDecoder?: unknown }).VideoDecoder !== 'undefined'

type Fit = { x: number; y: number; w: number; h: number }
type OverlayKind = 'installing' | 'success' | 'error' | 'recording' | 'capturing'

const OVERLAY_ICON: Record<OverlayKind, string> = {
  installing: '●',
  success: '✓',
  error: '✗',
  recording: '⏺',
  capturing: '◉'
}
const OVERLAY_COLOR: Record<OverlayKind, string> = {
  installing: PALETTE.ACCENT,
  success: PALETTE.GREEN,
  error: PALETTE.RED,
  recording: PALETTE.RED,
  capturing: PALETTE.ACCENT
}

/**
 * Owns the canvas drawing + the WebCodecs decoder. Kept outside React so frames
 * (30-60fps) never trigger re-renders; the component just forwards IPC payloads.
 */
class MirrorEngine {
  private canvas: HTMLCanvasElement | null = null
  private demuxer = new AnnexBDemuxer()
  private decoder: VideoDecoder | null = null
  private configured = false
  private ts = 0
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private lastImage: HTMLImageElement | null = null
  /** Device-pixel size of the current frame + the letterbox rect it's drawn in. */
  srcW = 0
  srcH = 0
  fit: Fit | null = null
  onFail: ((message: string) => void) | null = null

  attach(canvas: HTMLCanvasElement | null): void {
    this.canvas = canvas
  }

  /** New stream / display switch: forget decoder + pending bytes. */
  reset(): void {
    this.demuxer.reset()
    this.configured = false
    this.ts = 0
    this.lastImage = null
    if (this.decoder) {
      try {
        this.decoder.close()
      } catch {
        /* already closed */
      }
      this.decoder = null
    }
  }

  // --- PNG path (poller + H.264 prime frame) ------------------------------
  drawPng(base64: string): void {
    const img = new Image()
    img.onload = () => {
      this.lastImage = img
      this.drawSource(img, img.naturalWidth, img.naturalHeight)
    }
    img.src = `data:image/png;base64,${base64}`
  }

  // --- H.264 path ---------------------------------------------------------
  pushH264(chunk: Uint8Array): void {
    if (!HAS_WEBCODECS) return
    for (const au of this.demuxer.push(chunk)) this.feed(au.data, au.key)
    // Start-code framing can't emit a picture until the NEXT one begins, so the
    // freshest frame is always pending. Flush it ~one display frame after the
    // bytes arrive instead of waiting for the next screenrecord chunk — this is
    // the main latency knob. During motion, chunks arrive faster than this and
    // keep resetting the timer, so the flush only fires in the gaps.
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => {
      for (const au of this.demuxer.flush()) this.feed(au.data, au.key)
    }, 16)
  }

  private ensureDecoder(): VideoDecoder | null {
    if (this.decoder) return this.decoder
    try {
      this.decoder = new VideoDecoder({
        output: (frame) => {
          this.drawSource(frame, frame.displayWidth, frame.displayHeight)
          frame.close()
        },
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
    if (!this.configured) {
      const codec = this.demuxer.codecString()
      if (!key || !codec) return // wait for a keyframe (+ its SPS) to configure
      try {
        // No hardwareAcceleration hint: at phone resolutions the software H.264
        // decoder honors optimizeForLatency better — HW paths (VideoToolbox on
        // macOS) buffer several frames in the GPU pipeline, adding latency.
        dec.configure({ codec, optimizeForLatency: true })
        this.configured = true
      } catch (e) {
        this.fail(e instanceof Error ? e.message : String(e))
        return
      }
    }
    try {
      dec.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: this.ts, data }))
      this.ts += 33333 // ~30fps nominal; the decoder only needs monotonic stamps
    } catch (e) {
      this.fail(e instanceof Error ? e.message : String(e))
    }
  }

  private fail(message: string): void {
    this.reset()
    this.onFail?.(message)
  }

  // --- shared canvas draw -------------------------------------------------
  /** Redraw the last PNG frame (used on container resize). */
  redraw(): void {
    if (this.lastImage) this.drawSource(this.lastImage, this.lastImage.naturalWidth, this.lastImage.naturalHeight)
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
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = '#0d0f13'
    ctx.fillRect(0, 0, cw, ch)
    const scale = Math.min(cw / sw, ch / sh)
    const w = sw * scale
    const h = sh * scale
    const x = (cw - w) / 2
    const y = (ch - h) / 2
    ctx.imageSmoothingEnabled = true
    ctx.drawImage(src, x, y, w, h)
    this.srcW = sw
    this.srcH = sh
    this.fit = { x, y, w, h }
  }

  close(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.reset()
    this.canvas = null
  }
}

export function MirrorDock({
  c,
  onClose,
  onCaptured
}: {
  c: Controller
  onClose: () => void
  onCaptured: (result: SaveResult) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<MirrorEngine>(new MirrorEngine())

  const [message, setMessage] = useState('Connecting…')
  const [hasFrame, setHasFrame] = useState(false)
  const [overlay, setOverlay] = useState<{ kind: OverlayKind; text: string } | null>(null)
  const [recording, setRecording] = useState(false)
  const [dropHint, setDropHint] = useState(false)
  const [displays, setDisplays] = useState<DisplayInfo[]>([])
  const [scrcpyOk, setScrcpyOk] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [typing, setTyping] = useState(false)
  const [typeText, setTypeText] = useState('')
  // Low-latency preview: force the screencap poller instead of the buffered
  // H.264 encoder. On some devices/emulators screenrecord adds ~1s of encoder
  // latency, while a live screencap snapshot is ~150-220ms (lower fps, but far
  // more responsive) — the path the Python app used without PyAV.
  const [preview, setPreview] = useState(false)
  const previewRef = useRef(false)
  previewRef.current = preview

  // Which display is mirrored: SurfaceFlinger id (screencap -d) + logical id
  // (input -d); null = main. h264Ok is cleared when the video stream fails.
  const displayRef = useRef<{ sf: string | null; logical: number | null }>({ sf: null, logical: null })
  const h264OkRef = useRef(true)
  const recordingRef = useRef(false)
  const overlayTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pressRef = useRef<{ x: number; y: number; t: number } | null>(null)
  const serial = c.serial

  const flashOverlay = useCallback((kind: OverlayKind, text: string, ms = 4000) => {
    if (overlayTimer.current) clearTimeout(overlayTimer.current)
    setOverlay({ kind, text })
    if (ms > 0) overlayTimer.current = setTimeout(() => setOverlay(null), ms)
  }, [])

  // --- feed lifecycle -----------------------------------------------------
  const startFeed = useCallback(() => {
    if (!serial) return
    const eng = engineRef.current
    eng.reset()
    setHasFrame(false)
    setMessage('Connecting…')
    const { sf } = displayRef.current
    if (HAS_WEBCODECS && h264OkRef.current && !recordingRef.current && !previewRef.current && sf === null) {
      void window.androidlab.mirror.startH264(serial)
    } else {
      void window.androidlab.mirror.startPoller(serial, sf)
    }
  }, [serial])

  const toggleFeedMode = useCallback(() => {
    const next = !previewRef.current
    previewRef.current = next
    setPreview(next)
    startFeed()
  }, [startFeed])

  const probeDisplays = useCallback(async () => {
    if (!serial) return
    const list = await window.androidlab.mirror.listDisplays(serial)
    setDisplays(list)
    // If the mirrored secondary display vanished, fall back to main.
    const cur = displayRef.current.sf
    if (cur !== null && !list.some((d) => d.sfId === cur)) {
      displayRef.current = { sf: null, logical: null }
      startFeed()
    }
  }, [serial, startFeed])

  // (Re)start whenever the device changes; stop on unmount.
  useEffect(() => {
    engineRef.current.attach(canvasRef.current)
    engineRef.current.onFail = () => {
      // H.264 failed → drop to the screencap preview for this device.
      h264OkRef.current = false
    }
    if (!serial) {
      setMessage('No device selected')
      return
    }
    h264OkRef.current = true
    displayRef.current = { sf: null, logical: null }
    void window.androidlab.mirror.scrcpyAvailable().then(setScrcpyOk)
    let cancelled = false
    // Emulators buffer ~1s in screenrecord → default to the low-latency preview;
    // physical devices default to smooth H.264. Detect first, then start the feed.
    window.androidlab.mirror
      .isEmulator(serial)
      .then((emu) => {
        if (cancelled) return
        previewRef.current = emu
        setPreview(emu)
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) startFeed()
      })
    void probeDisplays()
    return () => {
      cancelled = true
      void window.androidlab.mirror.stop()
      engineRef.current.reset()
    }
  }, [serial, startFeed, probeDisplays])

  // IPC event subscriptions (frames / h264 bytes / failure / record done).
  useEffect(() => {
    const eng = engineRef.current
    const unFrame = window.androidlab.mirror.onFrame((base64) => {
      eng.drawPng(base64)
      setHasFrame(true)
    })
    const unH264 = window.androidlab.mirror.onH264((chunk) => {
      eng.pushH264(chunk)
      setHasFrame(true)
    })
    const unFail = window.androidlab.mirror.onFailed((f) => {
      if (f.kind === 'h264') {
        h264OkRef.current = false
        startFeed() // silently fall back to the poller
      } else {
        setMessage(f.message)
        setHasFrame(false)
      }
    })
    const unRec = window.androidlab.mirror.onRecordDone((result) => {
      setRecording(false)
      recordingRef.current = false
      flashOverlay(result.ok ? 'success' : 'error', result.message, 6000)
      onCaptured(result)
      // Encoder is free again — resume the low-latency mirror.
      startFeed()
    })
    return () => {
      unFrame()
      unH264()
      unFail()
      unRec()
    }
  }, [startFeed, flashOverlay, onCaptured])

  // Redraw the last PNG frame when the dock is resized.
  useEffect(() => {
    const wrap = canvasRef.current?.parentElement
    if (!wrap) return
    let raf = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => engineRef.current.redraw())
    })
    ro.observe(wrap)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [])

  // --- input --------------------------------------------------------------
  const sendInput = useCallback(
    (args: string[]) => {
      if (serial) void window.androidlab.mirror.input(serial, displayRef.current.logical, args)
    },
    [serial]
  )

  const toDevice = useCallback((clientX: number, clientY: number): { x: number; y: number } | null => {
    const eng = engineRef.current
    const canvas = canvasRef.current
    if (!eng.fit || !canvas || eng.srcW === 0) return null
    const rect = canvas.getBoundingClientRect()
    const px = clientX - rect.left - eng.fit.x
    const py = clientY - rect.top - eng.fit.y
    if (px < 0 || px >= eng.fit.w || py < 0 || py >= eng.fit.h) return null
    return { x: Math.round((px * eng.srcW) / eng.fit.w), y: Math.round((py * eng.srcH) / eng.fit.h) }
  }, [])

  const onCanvasMouseDown = (e: React.MouseEvent): void => {
    const d = toDevice(e.clientX, e.clientY)
    pressRef.current = d ? { ...d, t: e.timeStamp } : null
  }
  const onCanvasMouseUp = (e: React.MouseEvent): void => {
    const press = pressRef.current
    pressRef.current = null
    if (!press) return
    const up = toDevice(e.clientX, e.clientY) ?? { x: press.x, y: press.y }
    if (Math.abs(up.x - press.x) + Math.abs(up.y - press.y) < 12) {
      sendInput(['tap', String(press.x), String(press.y)])
    } else {
      const ms = Math.max(50, Math.round(e.timeStamp - press.t))
      sendInput(['swipe', String(press.x), String(press.y), String(up.x), String(up.y), String(ms)])
    }
  }

  // --- captures -----------------------------------------------------------
  const doScreenshot = useCallback(async () => {
    if (!serial) return flashOverlay('error', 'Mirror not connected')
    flashOverlay('capturing', 'Capturing screenshot…', 0)
    const { sf, logical } = displayRef.current
    const r = await window.androidlab.mirror.screenshot(serial, sf, logical)
    flashOverlay(r.ok ? 'success' : 'error', r.message, 5000)
    onCaptured(r)
  }, [serial, flashOverlay, onCaptured])

  const toggleRecord = useCallback(async () => {
    if (!serial) return flashOverlay('error', 'Mirror not connected')
    if (recordingRef.current) {
      flashOverlay('capturing', 'Finalizing recording…', 0)
      await window.androidlab.mirror.recordStop()
      return
    }
    if (displayRef.current.sf !== null) return flashOverlay('error', 'Recording works on the main display only')
    const ok = await window.androidlab.mirror.recordStart(serial)
    if (!ok) return
    recordingRef.current = true
    setRecording(true)
    // Free the sole display encoder for screenrecord: preview drops to the poller.
    startFeed()
    flashOverlay('recording', 'Recording… (tap Stop to finish)', 0)
  }, [serial, flashOverlay, startFeed])

  const doPaste = useCallback(async () => {
    if (!serial) return flashOverlay('error', 'Mirror not connected')
    try {
      const text = await navigator.clipboard.readText()
      if (text) sendInput(['text', escapeInputText(text)])
    } catch {
      flashOverlay('error', 'Clipboard unavailable')
    }
  }, [serial, sendInput, flashOverlay])

  const submitType = useCallback(() => {
    const text = typeText.trim()
    setTyping(false)
    setTypeText('')
    if (text) sendInput(['text', escapeInputText(text)])
  }, [typeText, sendInput])

  // --- display picker -----------------------------------------------------
  const pickDisplay = useCallback(
    (value: string) => {
      const sf = value === '' ? null : value
      const info = displays.find((d) => d.sfId === sf)
      displayRef.current = { sf, logical: info ? info.logical : null }
      startFeed()
    },
    [displays, startFeed]
  )

  // --- APK drop-to-install ------------------------------------------------
  const onDrop = useCallback(
    (e: React.DragEvent): void => {
      e.preventDefault()
      setDropHint(false)
      const paths: string[] = []
      for (const f of Array.from(e.dataTransfer.files)) {
        const p = window.androidlab.files.pathForFile(f)
        if (p && isApkPath(p)) paths.push(p)
      }
      if (paths.length === 0) return
      flashOverlay('installing', `Installing ${paths.map((p) => p.split('/').pop()).join(', ')}…`, 0)
      void c.install(paths).then((r) => {
        if (r) flashOverlay(r.ok ? 'success' : 'error', r.message, 6000)
      })
    },
    [c, flashOverlay]
  )

  // Esc exits fullscreen.
  useEffect(() => {
    if (!fullscreen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setFullscreen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fullscreen])

  const recBtnEnabled = displayRef.current.sf === null || recording
  const showFrame = hasFrame

  return (
    <div className={`mirror-dock${fullscreen ? ' mirror-fs' : ''}`}>
      <div
        className="mirror-canvas-wrap"
        onMouseDown={onCanvasMouseDown}
        onMouseUp={onCanvasMouseUp}
        onDragOver={(e) => {
          e.preventDefault()
          setDropHint(true)
        }}
        onDragLeave={() => setDropHint(false)}
        onDrop={onDrop}
      >
        <canvas ref={canvasRef} />
        {!showFrame ? <div className="mirror-msg">{message}</div> : null}
        {overlay ? (
          <div className="mirror-overlay">
            <span className="ic" style={{ color: OVERLAY_COLOR[overlay.kind] }}>
              {OVERLAY_ICON[overlay.kind]}
            </span>
            <span className="tx">{overlay.text}</span>
          </div>
        ) : null}
        {dropHint ? <div className="mirror-drop">Drop APK to install</div> : null}
        {typing ? (
          <div className="mirror-type" onMouseDown={(e) => e.stopPropagation()}>
            <input
              autoFocus
              placeholder="Text for the focused field…"
              value={typeText}
              onChange={(e) => setTypeText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitType()
                else if (e.key === 'Escape') {
                  setTyping(false)
                  setTypeText('')
                }
              }}
            />
            <button onClick={submitType}>Send</button>
          </div>
        ) : null}
      </div>

      <div className="mirror-rail">
        <button className="toggle" title="Back" onClick={() => sendInput(['keyevent', String(KEY_BACK)])}>
          ‹
        </button>
        <button className="toggle" title="Home" onClick={() => sendInput(['keyevent', String(KEY_HOME)])}>
          ●
        </button>
        <button className="toggle" title="Recents" onClick={() => sendInput(['keyevent', String(KEY_RECENTS)])}>
          ▭
        </button>
        <button className="toggle" title="Save a screenshot to ~/Downloads" onClick={() => void doScreenshot()}>
          📷
        </button>
        <button
          className={`toggle${recording ? ' rec-on' : ''}`}
          title={recBtnEnabled ? 'Record the screen to an MP4 in ~/Downloads' : 'Recording works on the main display only'}
          disabled={!recBtnEnabled}
          onClick={() => void toggleRecord()}
        >
          {recording ? '⏹' : '⏺'}
        </button>
        <button className="toggle" title="Type the Mac clipboard into the focused field" onClick={() => void doPaste()}>
          📋
        </button>
        <button className="toggle" title="Type text into the focused field" onClick={() => setTyping((v) => !v)}>
          ⌨
        </button>

        <div className="mirror-rail-spacer" />

        <button
          className={`toggle${preview ? ' active' : ''}`}
          title={
            preview
              ? 'Low-latency preview (screencap) — click for smooth H.264 video'
              : 'Smooth H.264 video — click for low-latency preview (less delay, lower fps)'
          }
          onClick={toggleFeedMode}
        >
          {preview ? '⚡' : '🎬'}
        </button>
        {displays.length > 1 ? (
          <select
            className="mirror-display"
            title="Which display to mirror"
            value={displayRef.current.sf ?? ''}
            onChange={(e) => pickDisplay(e.target.value)}
          >
            <option value="">Main</option>
            {displays
              .filter((d) => d.virtual || d.sfId !== displays.find((x) => !x.virtual)?.sfId)
              .map((d) => (
                <option key={d.sfId} value={d.sfId}>
                  {d.name}
                </option>
              ))}
          </select>
        ) : null}
        <button
          className="toggle"
          title={fullscreen ? 'Exit full screen (Esc)' : 'Full screen mirror (Esc to exit)'}
          onClick={() => setFullscreen((v) => !v)}
        >
          ⛶
        </button>
        {scrcpyOk ? (
          <button
            className="toggle"
            title="Open full-quality interactive mirror (scrcpy)"
            onClick={() => serial && window.androidlab.mirror.launchScrcpy(serial, displayRef.current.logical)}
          >
            ⤢
          </button>
        ) : null}
        <button className="toggle mirror-close" title="Close mirror" onClick={onClose}>
          ✕
        </button>
      </div>
    </div>
  )
}
