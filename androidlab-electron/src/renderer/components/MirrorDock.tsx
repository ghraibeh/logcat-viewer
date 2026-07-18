/**
 * Screen mirror — port of mirror.py's MirrorView + _ScreenCanvas as a right-side
 * dock. The live feed is either the low-latency H.264 stream decoded in-page with
 * WebCodecs (PyAV's job in Python) or the screencap PNG poller fallback; clicks/
 * drags map back to device pixels and are forwarded via `input`. A control rail
 * carries nav keys, screenshot, MP4 record, clipboard paste / type, fullscreen,
 * a display picker, and scrcpy hand-off.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AnnexBDemuxer,
  KEY_BACK,
  KEY_HOME,
  KEY_RECENTS,
  KEY_VOLUME_UP,
  KEY_VOLUME_DOWN,
  KEY_POWER,
  SC_ACTION_DOWN,
  SC_ACTION_MOVE,
  SC_ACTION_UP,
  scrcpyKeycodeMsg,
  scrcpyTextMsg,
  scrcpyTouchMsg,
  escapeInputText,
  isApkPath
} from '@core/mirror'
import type { DisplayInfo } from '@core/mirror'
import type { InstallResult, SaveResult } from '@shared/types'
import { PALETTE } from '../theme'
import { Icon, type IconName } from './Icon'

const HAS_WEBCODECS = typeof (globalThis as { VideoDecoder?: unknown }).VideoDecoder !== 'undefined'

// Max frames allowed to sit in the WebCodecs decode queue before we treat the
// decoder as "behind" and resync at the next keyframe. This only guards against
// the *decoder* falling behind; the rAF present loop already drops intermediate
// frames at paint time (scrcpy/Studio style), so it can stay forgiving. A resync
// is costly on the scrcpy feed (its keyframes are ~10s apart, so a reset freezes
// until the next IDR), and hardware decode keeps the queue near zero anyway — so
// trip this only on sustained real backlog, never on a one-frame hiccup.
const MAX_DECODE_QUEUE = 6

// Touch pointer ids for the two-finger gestures. scrcpy maps arbitrary ids to
// MotionEvent slots, so distinct ids = distinct fingers. Primary = the cursor
// finger (drag + pinch); Second = the mirrored/virtual finger (pinch + rotate).
const PTR_PRIMARY = 0
const PTR_SECOND = 1

// Non-printable keys → Android keycodes, injected via scrcpy's control channel.
// Printable characters go through INJECT_TEXT instead (handles unicode + layouts).
const ANDROID_KEYS: Record<string, number> = {
  Enter: 66,
  Backspace: 67,
  Tab: 61,
  Escape: 111,
  ArrowUp: 19,
  ArrowDown: 20,
  ArrowLeft: 21,
  ArrowRight: 22,
  Delete: 112,
  Home: 122,
  End: 123,
  PageUp: 92,
  PageDown: 93
}

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

// The control rail uses the shared monochrome line-icon set (components/Icon.tsx)
// at rail scale (24px) so it stays in lock-step with the icons used everywhere
// else in the app. Icons inherit the rail button's color / hover / active states.
function RailIcon({ name }: { name: IconName }) {
  return <Icon name={name} size={24} />
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
  private lastSpsGen = -1
  private ts = 0
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private lastImage: HTMLImageElement | null = null
  /** Newest frame awaiting the rAF present loop; VideoFrames are freed once painted. */
  private pending: { src: CanvasImageSource; w: number; h: number; isFrame: boolean } | null = null
  private rafId = 0
  private running = false
  /** Device-pixel size of the current frame + the letterbox rect it's drawn in. */
  srcW = 0
  srcH = 0
  /** Device-px → CSS-px scale + the view rotation (0/90/180/270); used for both the
   *  draw transform and the inverse (canvas → device) mapping for touch input. */
  scale = 1
  rotation = 0
  fit: Fit | null = null
  onFail: ((message: string) => void) | null = null

  /** Set the view rotation and immediately repaint the last PNG frame (the H.264 path
   *  applies it on its next decoded frame). */
  setRotation(deg: number): void {
    this.rotation = ((deg % 360) + 360) % 360
    this.redraw()
  }

  attach(canvas: HTMLCanvasElement | null): void {
    this.canvas = canvas
    this.startLoop()
  }

  // --- rAF present loop ---------------------------------------------------
  // Decode and paint are decoupled: the decoder / PNG callbacks stash the freshest
  // frame in `pending`, and this self-scheduling rAF loop draws the latest one every
  // vsync. Painting inside rAF (instead of straight from the decode callback) is what
  // keeps Chromium presenting at full cadence when the pointer is idle — without it the
  // compositor throttles canvas updates until an input event wakes it, which is why the
  // mirror looked smooth only while you were touching it. It also drops intermediate
  // frames at the present stage, so a burst of decodes never queues up as latency.
  private startLoop(): void {
    if (this.running) return
    this.running = true
    const tick = (): void => {
      if (!this.running) return
      this.paintPending()
      this.rafId = requestAnimationFrame(tick)
    }
    this.rafId = requestAnimationFrame(tick)
  }

  private stopLoop(): void {
    this.running = false
    if (this.rafId) cancelAnimationFrame(this.rafId)
    this.rafId = 0
  }

  /** Stash the newest frame for the loop; a superseded VideoFrame is freed now. */
  private setPending(src: CanvasImageSource, w: number, h: number, isFrame: boolean): void {
    this.dropPending()
    this.pending = { src, w, h, isFrame }
  }

  /** Release a pending VideoFrame without painting it (superseded / teardown). */
  private dropPending(): void {
    if (this.pending?.isFrame) {
      try {
        (this.pending.src as VideoFrame).close()
      } catch {
        /* already closed */
      }
    }
    this.pending = null
  }

  private paintPending(): void {
    const p = this.pending
    if (!p) return
    this.pending = null
    this.drawSource(p.src, p.w, p.h)
    if (p.isFrame) {
      try {
        (p.src as VideoFrame).close()
      } catch {
        /* already closed */
      }
    }
  }

  /** New stream / display switch: forget decoder + pending bytes. */
  reset(): void {
    this.demuxer.reset()
    this.configured = false
    this.ts = 0
    this.lastImage = null
    this.dropPending()
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
      this.setPending(img, img.naturalWidth, img.naturalHeight, false)
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
          // Hand the frame to the present loop; it draws the freshest and frees the rest.
          this.setPending(frame, frame.displayWidth, frame.displayHeight, true)
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
    // The SPS changed (device rotated → new resolution/orientation): re-init the
    // decoder so frames aren't decoded with the old geometry (stretched / wrong way).
    const gen = this.demuxer.spsGeneration()
    if (gen !== this.lastSpsGen) {
      this.lastSpsGen = gen
      if (this.configured) {
        try {
          dec.reset()
        } catch {
          /* ignore */
        }
        this.configured = false
      }
    }
    // Backpressure — the real low-latency knob. If the decoder can't drain as
    // fast as frames arrive, its queue (and therefore latency) grows until the
    // pipeline stalls, which reads as "smooth, then lagging, then frozen".
    // Instead, drop the backlog and resync at the next keyframe so latency stays
    // bounded — how scrcpy / Studio stay live under load.
    if (this.configured && dec.decodeQueueSize > MAX_DECODE_QUEUE) {
      try {
        dec.reset() // clears the queued backlog; must reconfigure before decoding
      } catch {
        /* ignore */
      }
      this.configured = false // wait for the next keyframe to reconfigure
      return
    }
    if (!this.configured) {
      const codec = this.demuxer.codecString()
      if (!key || !codec) return // wait for a keyframe (+ its SPS) to configure
      try {
        // Prefer hardware decode (VideoToolbox on macOS): software-decoding
        // 1080p/8Mbit can't sustain realtime and falls progressively behind,
        // which is what causes the lag-then-freeze. optimizeForLatency keeps HW
        // frame-reordering minimal and the backpressure above caps the queue, so
        // HW latency stays low while never falling behind. prefer-hardware
        // silently uses software when no HW decoder exists; onFail drops to the
        // screencap poller if it errors outright.
        dec.configure({ codec, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' })
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

  /** Blank the canvas to the mirror background (device / display switch) so no
   *  stale frame lingers behind the loader; drops fit/size so input is disabled. */
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
    this.lastImage = null
    this.srcW = 0
    this.srcH = 0
    this.fit = null
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
    // Rotate the view about the canvas centre; at 90/270 the fit box swaps W/H so a
    // portrait phone fills the pane horizontally (and vice-versa). toDevice() applies
    // the inverse rotation so taps still land correctly.
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

  close(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.stopLoop()
    this.reset()
    this.canvas = null
  }
}

export function MirrorDock({
  serial,
  install,
  onClose,
  onCaptured,
  onPopout,
  popped = false,
  secondaryReq = 0
}: {
  serial: string | null
  install: (paths: string[]) => Promise<InstallResult | null>
  onClose: () => void
  onCaptured: (result: SaveResult) => void
  /** Detach into a separate window (docked) or re-dock (popped). Hidden if absent. */
  onPopout?: () => void
  /** True when rendered inside the detached window — flips the pop-out button to dock-back. */
  popped?: boolean
  /** Bumped by the Controls "👁 View" button to auto-switch to the secondary display. */
  secondaryReq?: number
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<MirrorEngine>(new MirrorEngine())

  const [message, setMessage] = useState('Connecting…')
  const [hasFrame, setHasFrame] = useState(false)
  // True only when the feed reported a hard failure (device asleep/gone) — keeps
  // the loader spinner (a transient "connecting" state) distinct from an error.
  const [failed, setFailed] = useState(false)
  const [overlay, setOverlay] = useState<{ kind: OverlayKind; text: string } | null>(null)
  const [recording, setRecording] = useState(false)
  const [dropHint, setDropHint] = useState(false)
  const [displays, setDisplays] = useState<DisplayInfo[]>([])
  const [scrcpyOk, setScrcpyOk] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [rotation, setRotation] = useState(0) // view rotation (0/90/180/270)
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
  // scrcpy control channel: when up, mouse/keyboard inject live touch/key events
  // (interactive drag + typing); when down, we fall back to one-shot `adb input`.
  const controlReadyRef = useRef(false)
  // Active mouse gesture: single-finger 'drag', or 'pinch' (Ctrl/⌘+drag → a second
  // finger mirrored about the screen centre, giving pinch-zoom AND rotation).
  const gestureRef = useRef<'drag' | 'pinch' | null>(null)

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
    eng.clear() // blank the previous device's frame so the loader isn't over a frozen image
    controlReadyRef.current = false // a fresh feed re-establishes (or drops) control
    gestureRef.current = null
    setHasFrame(false)
    setFailed(false)
    setMessage('Connecting…')
    const { sf } = displayRef.current
    if (HAS_WEBCODECS && h264OkRef.current && !recordingRef.current && !previewRef.current && sf === null) {
      // scrcpy's server keeps the stream warm (screenrecord stalls on a static
      // screen); main falls back to the screenrecord H.264 loop if the jar is absent.
      void window.androidlab.mirror.startScrcpy(serial)
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

  // One-click "view the secondary display": probe briefly (the display may still
  // be booting after it was just enabled) and switch to the first one found —
  // port of mirror.py's show_secondary + _on_displays retry loop.
  const showSecondary = useCallback(async () => {
    if (!serial) return
    for (let attempt = 0; attempt < 8; attempt++) {
      const list = await window.androidlab.mirror.listDisplays(serial)
      setDisplays(list)
      const sec = list.find((d) => d.virtual) ?? (list.length > 1 ? list[1] : undefined)
      if (sec) {
        displayRef.current = { sf: sec.sfId, logical: sec.logical }
        startFeed()
        return
      }
      await new Promise((r) => setTimeout(r, 600))
    }
    flashOverlay('error', 'no secondary display found')
  }, [serial, startFeed, flashOverlay])

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

  // Attach the canvas + run the present loop for the component's lifetime; tearing
  // it down here (not in the per-serial effect) keeps the loop alive across device
  // switches and stops it exactly once, on unmount.
  useEffect(() => {
    const eng = engineRef.current
    eng.attach(canvasRef.current)
    return () => eng.close()
  }, [])

  // Apply the view rotation (repaints the last frame immediately for the PNG path).
  useEffect(() => {
    engineRef.current.setRotation(rotation)
  }, [rotation])

  // (Re)start whenever the device changes; stop on unmount.
  useEffect(() => {
    engineRef.current.onFail = () => {
      // The decoder errored (bad stream, or it fell too far behind) — drop to
      // the screencap poller for this device instead of freezing on the last
      // frame. Bytes keep streaming from the main process, so without this the
      // mirror would silently die (the renderer never reached the main-process
      // h264 fallback path).
      h264OkRef.current = false
      startFeed()
    }
    if (!serial) {
      setMessage('No device selected')
      setFailed(false)
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
    const unCtrl = window.androidlab.mirror.onControlReady((ready) => {
      controlReadyRef.current = ready
      if (!ready) gestureRef.current = null
    })
    const unFail = window.androidlab.mirror.onFailed((f) => {
      if (f.kind === 'h264') {
        h264OkRef.current = false
        startFeed() // silently fall back to the poller
      } else {
        setMessage(f.message)
        setHasFrame(false)
        setFailed(true)
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
      unCtrl()
      unFail()
      unRec()
    }
  }, [startFeed, flashOverlay, onCaptured])

  // Controls "👁 View" handoff: each bump of secondaryReq auto-switches to the
  // secondary display (skip the initial 0 and duplicate values).
  const lastSecondaryReq = useRef(0)
  useEffect(() => {
    if (secondaryReq > 0 && secondaryReq !== lastSecondaryReq.current) {
      lastSecondaryReq.current = secondaryReq
      void showSecondary()
    }
  }, [secondaryReq, showSecondary])

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

  // Map a canvas client point back to device pixels, undoing the view rotation +
  // scale about the canvas centre (inverse of drawSource's transform). Returns raw
  // coords (may be out of bounds); callers reject or clamp.
  const canvasToDevice = useCallback((clientX: number, clientY: number): { x: number; y: number } | null => {
    const eng = engineRef.current
    const canvas = canvasRef.current
    if (!canvas || eng.srcW === 0 || !eng.scale) return null
    const rect = canvas.getBoundingClientRect()
    const X = clientX - (rect.left + rect.width / 2)
    const Y = clientY - (rect.top + rect.height / 2)
    const rad = (-eng.rotation * Math.PI) / 180
    const c = Math.cos(rad)
    const s = Math.sin(rad)
    const ux = X * c - Y * s
    const uy = X * s + Y * c
    return { x: ux / eng.scale + eng.srcW / 2, y: uy / eng.scale + eng.srcH / 2 }
  }, [])

  const toDevice = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } | null => {
      const eng = engineRef.current
      const d = canvasToDevice(clientX, clientY)
      if (!d || d.x < 0 || d.x >= eng.srcW || d.y < 0 || d.y >= eng.srcH) return null
      return { x: Math.round(d.x), y: Math.round(d.y) }
    },
    [canvasToDevice]
  )

  // Like toDevice but clamps to the screen edge instead of returning null, so a drag
  // that runs past the canvas (edge swipes, fast flings) keeps tracking.
  const toDeviceClamped = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } | null => {
      const eng = engineRef.current
      const d = canvasToDevice(clientX, clientY)
      if (!d) return null
      return {
        x: Math.round(Math.max(0, Math.min(eng.srcW - 1, d.x))),
        y: Math.round(Math.max(0, Math.min(eng.srcH - 1, d.y)))
      }
    },
    [canvasToDevice]
  )

  const sendControl = useCallback((data: Uint8Array) => {
    void window.androidlab.mirror.control(data)
  }, [])

  const sendTouch = useCallback(
    (action: number, x: number, y: number, pointerId = -1) => {
      const eng = engineRef.current
      if (eng.srcW && eng.srcH) sendControl(scrcpyTouchMsg(action, x, y, eng.srcW, eng.srcH, pointerId))
    },
    [sendControl]
  )

  const clampDev = useCallback((x: number, y: number): { x: number; y: number } => {
    const eng = engineRef.current
    return {
      x: Math.max(0, Math.min(eng.srcW - 1, Math.round(x))),
      y: Math.max(0, Math.min(eng.srcH - 1, Math.round(y)))
    }
  }, [])

  // Point-symmetric to `d` about the screen centre — the "second finger" for the
  // Ctrl/⌘+drag gesture. Dragging radially pinches; dragging tangentially rotates.
  const mirrorAboutCenter = useCallback(
    (d: { x: number; y: number }): { x: number; y: number } => {
      const eng = engineRef.current
      return clampDev(eng.srcW - 1 - d.x, eng.srcH - 1 - d.y)
    },
    [clampDev]
  )

  // A gesture can leave the canvas, so once it starts we track move/up on the window.
  const onWindowMove = useCallback(
    (e: MouseEvent) => {
      const g = gestureRef.current
      if (!g) return
      const d = toDeviceClamped(e.clientX, e.clientY)
      if (!d) return
      sendTouch(SC_ACTION_MOVE, d.x, d.y, PTR_PRIMARY)
      if (g === 'pinch') {
        const m = mirrorAboutCenter(d)
        sendTouch(SC_ACTION_MOVE, m.x, m.y, PTR_SECOND)
      }
    },
    [toDeviceClamped, sendTouch, mirrorAboutCenter]
  )
  const onWindowUp = useCallback(
    (e: MouseEvent) => {
      const g = gestureRef.current
      if (!g) return
      gestureRef.current = null
      const d = toDeviceClamped(e.clientX, e.clientY)
      if (d) {
        sendTouch(SC_ACTION_UP, d.x, d.y, PTR_PRIMARY)
        if (g === 'pinch') {
          const m = mirrorAboutCenter(d)
          sendTouch(SC_ACTION_UP, m.x, m.y, PTR_SECOND)
        }
      }
      window.removeEventListener('mousemove', onWindowMove)
      window.removeEventListener('mouseup', onWindowUp)
    },
    [toDeviceClamped, sendTouch, mirrorAboutCenter]
  )
  useEffect(() => {
    // Detach any in-flight gesture listeners + pinch timer on unmount.
    return () => {
      window.removeEventListener('mousemove', onWindowMove)
      window.removeEventListener('mouseup', onWindowUp)
      if (pinchEndRef.current) clearTimeout(pinchEndRef.current)
    }
  }, [onWindowMove, onWindowUp])

  const onCanvasMouseDown = (e: React.MouseEvent): void => {
    const d = toDevice(e.clientX, e.clientY)
    if (controlReadyRef.current) {
      if (!d) return
      // A modifier held → two-finger pinch+rotate (second finger mirrors about
      // centre); otherwise a single-finger drag. ⌘/⌥/Ctrl all count so it works with
      // a Magic Mouse (no pinch gesture) — on macOS Ctrl+click is a right-click, hence
      // the onContextMenu suppression on the canvas. Both track move/up on the window.
      const pinch = e.ctrlKey || e.metaKey || e.altKey
      gestureRef.current = pinch ? 'pinch' : 'drag'
      sendTouch(SC_ACTION_DOWN, d.x, d.y, PTR_PRIMARY)
      if (pinch) {
        const m = mirrorAboutCenter(d)
        sendTouch(SC_ACTION_DOWN, m.x, m.y, PTR_SECOND)
      }
      window.addEventListener('mousemove', onWindowMove)
      window.addEventListener('mouseup', onWindowUp)
    } else {
      // Poller / secondary display: remember the press for a one-shot tap/swipe on up.
      pressRef.current = d ? { ...d, t: e.timeStamp } : null
    }
  }
  const onCanvasMouseUp = (e: React.MouseEvent): void => {
    if (controlReadyRef.current) return // handled by onWindowUp
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

  // Keyboard → device, when the mirror is focused and control is live. Printable
  // characters go as text (unicode-safe); named keys map to Android keycodes.
  const onCanvasKeyDown = (e: React.KeyboardEvent): void => {
    if (!controlReadyRef.current) return
    const kc = ANDROID_KEYS[e.key]
    if (kc !== undefined) {
      e.preventDefault()
      sendControl(scrcpyKeycodeMsg(SC_ACTION_DOWN, kc))
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      sendControl(scrcpyTextMsg(e.key))
    }
  }
  const onCanvasKeyUp = (e: React.KeyboardEvent): void => {
    if (!controlReadyRef.current) return
    const kc = ANDROID_KEYS[e.key]
    if (kc !== undefined) {
      e.preventDefault()
      sendControl(scrcpyKeycodeMsg(SC_ACTION_UP, kc))
    }
  }

  // --- pinch-to-zoom ------------------------------------------------------
  // Trackpad pinch (macOS Chromium fires wheel + ctrlKey) drives two virtual fingers
  // spreading/closing around the cursor — a natural pinch for maps/photos. (Mice have
  // no pinch gesture; they use the Ctrl/⌘+drag path above, which also rotates.) Wheel
  // events are discrete with no "end", so a debounce lifts the fingers on a pause.
  const pinchRef = useRef<{ cx: number; cy: number; radius: number } | null>(null)
  const pinchEndRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const endPinch = useCallback(() => {
    const p = pinchRef.current
    if (!p) return
    pinchRef.current = null
    const a = clampDev(p.cx, p.cy - p.radius)
    const b = clampDev(p.cx, p.cy + p.radius)
    sendTouch(SC_ACTION_UP, a.x, a.y, PTR_PRIMARY)
    sendTouch(SC_ACTION_UP, b.x, b.y, PTR_SECOND)
  }, [clampDev, sendTouch])

  const onWheel = useCallback(
    (e: WheelEvent) => {
      if (!controlReadyRef.current || !e.ctrlKey) return // pinch (trackpad / Ctrl+scroll) only
      e.preventDefault()
      const eng = engineRef.current
      if (!eng.srcW || !eng.srcH) return
      let p = pinchRef.current
      if (!p) {
        const at = toDevice(e.clientX, e.clientY)
        if (!at) return
        p = { cx: at.x, cy: at.y, radius: Math.max(40, Math.round(eng.srcH * 0.05)) }
        pinchRef.current = p
        const a = clampDev(p.cx, p.cy - p.radius)
        const b = clampDev(p.cx, p.cy + p.radius)
        sendTouch(SC_ACTION_DOWN, a.x, a.y, PTR_PRIMARY)
        sendTouch(SC_ACTION_DOWN, b.x, b.y, PTR_SECOND)
      } else {
        // deltaY < 0 (spread / zoom-in on macOS) grows the gap; cap per-event change
        // so a chunky mouse wheel isn't wildly faster than a smooth trackpad pinch.
        const step = Math.sign(-e.deltaY) * Math.min(60, Math.abs(e.deltaY) * 3)
        p.radius = Math.max(20, Math.min(Math.round(eng.srcH / 2), p.radius + step))
        const a = clampDev(p.cx, p.cy - p.radius)
        const b = clampDev(p.cx, p.cy + p.radius)
        sendTouch(SC_ACTION_MOVE, a.x, a.y, PTR_PRIMARY)
        sendTouch(SC_ACTION_MOVE, b.x, b.y, PTR_SECOND)
      }
      if (pinchEndRef.current) clearTimeout(pinchEndRef.current)
      pinchEndRef.current = setTimeout(endPinch, 140)
    },
    [toDevice, clampDev, sendTouch, endPinch]
  )

  // wheel must be a non-passive listener so preventDefault suppresses page zoom.
  useEffect(() => {
    const wrap = canvasRef.current?.parentElement
    if (!wrap) return
    wrap.addEventListener('wheel', onWheel, { passive: false })
    return () => wrap.removeEventListener('wheel', onWheel)
  }, [onWheel])

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

  // Ordered display cycle: Main → each secondary → back to Main. Replaces the
  // native <select> so the rail stays a clean monochrome icon strip.
  const displayOrder = [null as string | null].concat(
    displays.filter((d) => d.virtual || d.sfId !== displays.find((x) => !x.virtual)?.sfId).map((d) => d.sfId)
  )
  const curName = displays.find((d) => d.sfId === displayRef.current.sf)?.name ?? 'Main'
  const cycleDisplay = useCallback(() => {
    const idx = displayOrder.indexOf(displayRef.current.sf)
    pickDisplay(displayOrder[(idx + 1) % displayOrder.length] ?? '')
  }, [displayOrder, pickDisplay])

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
      void install(paths).then((r) => {
        if (r) flashOverlay(r.ok ? 'success' : 'error', r.message, 6000)
      })
    },
    [install, flashOverlay]
  )

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

  const recBtnEnabled = displayRef.current.sf === null || recording
  const showFrame = hasFrame

  return (
    <div className={`mirror-dock${fullscreen ? ' mirror-fs' : ''}`}>
      <div
        className="mirror-canvas-wrap"
        tabIndex={0}
        onMouseDown={onCanvasMouseDown}
        onMouseUp={onCanvasMouseUp}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={onCanvasKeyDown}
        onKeyUp={onCanvasKeyUp}
        onDragOver={(e) => {
          e.preventDefault()
          setDropHint(true)
        }}
        onDragLeave={() => setDropHint(false)}
        onDrop={onDrop}
      >
        <canvas ref={canvasRef} />
        {!showFrame ? (
          serial && !failed ? (
            <div className="mirror-loading">
              <div className="mirror-spinner" />
              <div className="mirror-loading-tx">{message}</div>
            </div>
          ) : (
            <div className="mirror-msg">{message}</div>
          )
        ) : null}
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
        {/* Close is pinned to the top of the rail (sticky) so it's always reachable,
            even when the tall rail scrolls on a short dock. */}
        <button
          className="rail-btn rail-close"
          title={popped ? 'Close mirror window' : 'Close mirror'}
          onClick={onClose}
        >
          <RailIcon name="close" />
        </button>

        <div className="rail-div" />

        {/* view controls */}
        <button
          className="rail-btn"
          title={fullscreen ? 'Exit full screen (Esc)' : 'Full screen mirror (Esc to exit)'}
          onClick={toggleFullscreen}
        >
          <RailIcon name={fullscreen ? 'contract' : 'fullscreen'} />
        </button>
        <button
          className={`rail-btn${rotation ? ' active' : ''}`}
          title="Rotate the mirror 90° (portrait / landscape)"
          onClick={() => setRotation((r) => (r + 90) % 360)}
        >
          <RailIcon name="rotate" />
        </button>
        <button
          className={`rail-btn${preview ? ' active' : ''}`}
          title={
            preview
              ? 'Low-latency preview (screencap) — click for smooth H.264 video'
              : 'Smooth H.264 video — click for low-latency preview (less delay, lower fps)'
          }
          onClick={toggleFeedMode}
        >
          <RailIcon name={preview ? 'bolt' : 'film'} />
        </button>
        {displays.length > 1 ? (
          <button className="rail-btn" title={`Display: ${curName} — click to switch`} onClick={cycleDisplay}>
            <RailIcon name="monitor" />
          </button>
        ) : null}

        <div className="rail-div" />

        {/* navigation */}
        <button className="rail-btn" title="Back" onClick={() => sendInput(['keyevent', String(KEY_BACK)])}>
          <RailIcon name="back" />
        </button>
        <button className="rail-btn" title="Home" onClick={() => sendInput(['keyevent', String(KEY_HOME)])}>
          <RailIcon name="home" />
        </button>
        <button className="rail-btn" title="Recents" onClick={() => sendInput(['keyevent', String(KEY_RECENTS)])}>
          <RailIcon name="recents" />
        </button>

        <div className="rail-div" />

        {/* hardware keys */}
        <button className="rail-btn" title="Volume up" onClick={() => sendInput(['keyevent', String(KEY_VOLUME_UP)])}>
          <RailIcon name="volUp" />
        </button>
        <button className="rail-btn" title="Volume down" onClick={() => sendInput(['keyevent', String(KEY_VOLUME_DOWN)])}>
          <RailIcon name="volDown" />
        </button>
        <button className="rail-btn" title="Power (screen on/off)" onClick={() => sendInput(['keyevent', String(KEY_POWER)])}>
          <RailIcon name="power" />
        </button>

        <div className="rail-div" />

        {/* capture & input */}
        <button className="rail-btn" title="Save a screenshot to ~/Downloads" onClick={() => void doScreenshot()}>
          <RailIcon name="camera" />
        </button>
        <button
          className={`rail-btn${recording ? ' rec-on' : ''}`}
          title={recBtnEnabled ? 'Record the screen to an MP4 in ~/Downloads' : 'Recording works on the main display only'}
          disabled={!recBtnEnabled}
          onClick={() => void toggleRecord()}
        >
          <RailIcon name={recording ? 'stop' : 'record'} />
        </button>
        <button className="rail-btn" title="Type the Mac clipboard into the focused field" onClick={() => void doPaste()}>
          <RailIcon name="clipboard" />
        </button>
        <button className="rail-btn" title="Type text into the focused field" onClick={() => setTyping((v) => !v)}>
          <RailIcon name="keyboard" />
        </button>

        <div className="rail-div" />

        {/* handoff */}
        {scrcpyOk ? (
          <button
            className="rail-btn"
            title="Open full-quality interactive mirror (scrcpy)"
            onClick={() => serial && window.androidlab.mirror.launchScrcpy(serial, displayRef.current.logical)}
          >
            <RailIcon name="external" />
          </button>
        ) : null}
        {onPopout ? (
          <button
            className="rail-btn"
            title={popped ? 'Dock back into the main window' : 'Open mirror in a separate window'}
            onClick={onPopout}
          >
            <RailIcon name={popped ? 'popin' : 'popout'} />
          </button>
        ) : null}
      </div>
    </div>
  )
}
