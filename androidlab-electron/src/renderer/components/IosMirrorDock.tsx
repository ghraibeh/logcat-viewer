/**
 * iOS screen mirror dock (macOS) — the go-ios counterpart to MirrorDock.tsx.
 *
 * The main process streams raw Annex-B H.264 from the native capture helper (the
 * QuickTime/CoreMediaIO path — see services/iosmirror.ts). This decodes it with
 * WebCodecs exactly like the Android scrcpy mirror: AnnexBDemuxer → VideoDecoder →
 * canvas, with a rAF present loop and keyframe-resync backpressure. The helper also
 * plays the device audio on this Mac (rail has a mute toggle; the preference lives
 * in main so it survives dock<->popout). View-only without a provisioned agent;
 * rail = full screen, rotate, touch/type, nav, volume, mute, screenshot, close.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { AnnexBDemuxer } from '@core/mirror'
import { computeFlick } from '@core/iosinput'
import type { IosMirrorState, SaveResult } from '@shared/types'
import { Icon } from './Icon'

const HAS_WEBCODECS = typeof (globalThis as { VideoDecoder?: unknown }).VideoDecoder !== 'undefined'
const MAX_DECODE_QUEUE = 6

// AirPlay advertised-display presets (the phone mirrors at up to this resolution).
// An iPhone panel is ~1290×2796, so 1440p already exceeds what it can source —
// there's no 4K option because asking for more than the device's native produces an
// oversized stream the hardware decoder can't handle (a black screen), not a sharper
// picture. 1080p is the safe default; 1440p is the sharpest useful setting.
type Resolution = { label: string; width: number; height: number }
const RES_PRESETS: Resolution[] = [
  { label: '720p', width: 1280, height: 720 },
  { label: '1080p', width: 1920, height: 1080 },
  { label: '1440p', width: 2560, height: 1440 }
]
const RES_STORAGE_KEY = 'ios-airplay-resolution'
function loadResolution(): Resolution {
  try {
    const w = Number(localStorage.getItem(RES_STORAGE_KEY))
    const found = RES_PRESETS.find((r) => r.width === w)
    if (found) return found
  } catch {
    /* ignore */
  }
  return RES_PRESETS[1] // 1080p default
}

type Fit = { x: number; y: number; w: number; h: number }

/** Owns the canvas + WebCodecs decoder for the H.264 feed. Kept outside React so
 *  frames never trigger re-renders. Trimmed port of MirrorDock's MirrorEngine. */
class H264Engine {
  private canvas: HTMLCanvasElement | null = null
  private demuxer = new AnnexBDemuxer()
  private decoder: VideoDecoder | null = null
  private configured = false
  private lastSpsGen = -1
  private ts = 0
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private pending: { frame: VideoFrame; w: number; h: number } | null = null
  private rafId = 0
  private running = false
  private retagGen = 0
  // The AirPlay feed's H.264 is FULL-range (color_range=pc) BT.709/sRGB, but the
  // WebCodecs decoder doesn't propagate that flag, so the canvas renders it as
  // limited-range (16-235) and the colors crush/over-contrast. When true, re-tag each
  // decoded frame as full-range so drawImage converts it correctly. The USB feed is
  // genuinely limited-range and renders fine as-is, so this stays off for it.
  fullRange = false
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
    // AirPlay full-range correction: the decoded frame's colorSpace lost the pc flag,
    // so rebuild it with an explicit full-range BT.709/sRGB colorSpace. Skip if the
    // frame is already full-range (correction unnecessary). Async (copyTo) — the rAF
    // loop paints whatever's pending, so the corrected frame lands a beat later.
    if (this.fullRange && frame.colorSpace?.fullRange !== true) {
      void this.retagFullRange(frame)
      return
    }
    this.storePending(frame)
  }

  private storePending(frame: VideoFrame): void {
    if (this.pending) {
      try {
        this.pending.frame.close()
      } catch {
        /* already closed */
      }
    }
    this.pending = { frame, w: frame.displayWidth, h: frame.displayHeight }
  }

  private async retagFullRange(frame: VideoFrame): Promise<void> {
    const gen = this.retagGen
    try {
      const size = frame.allocationSize()
      const buf = new Uint8Array(size)
      const layout = await frame.copyTo(buf)
      const init: VideoFrameBufferInit = {
        format: frame.format as VideoPixelFormat,
        codedWidth: frame.codedWidth,
        codedHeight: frame.codedHeight,
        timestamp: frame.timestamp,
        visibleRect: {
          x: frame.visibleRect?.x ?? 0,
          y: frame.visibleRect?.y ?? 0,
          width: frame.visibleRect?.width ?? frame.codedWidth,
          height: frame.visibleRect?.height ?? frame.codedHeight
        },
        displayWidth: frame.displayWidth,
        displayHeight: frame.displayHeight,
        layout,
        colorSpace: { primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'bt709', fullRange: true }
      }
      frame.close()
      // The engine was reset/closed mid-copy — drop this frame.
      if (gen !== this.retagGen || !this.running) return
      this.storePending(new VideoFrame(buf, init))
    } catch {
      // Correction failed — fall back to the raw frame rather than dropping video.
      try {
        this.storePending(frame)
      } catch {
        /* frame already closed */
      }
    }
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

  // The single source of truth for pane geometry: source-pixels → CSS-px scale + the
  // letterboxed fit box, for the CURRENT pane size + view rotation. Both the painter
  // (drawSource) and the click→device mapping read this — like Apple's iPhone Mirroring
  // keeps one `coordinateTransform` (CGAffineTransform) that maps host coords → device
  // coords, so paint and hit-testing can never disagree.
  private computeFit(cw: number, ch: number): { scale: number; fit: Fit } {
    // At 90/270 the fit box swaps W/H, so a portrait phone fills the pane horizontally.
    const rot = ((this.rotation % 360) + 360) % 360
    const swap = rot === 90 || rot === 270
    const effW = swap ? this.srcH : this.srcW
    const effH = swap ? this.srcW : this.srcH
    const scale = Math.min(cw / effW, ch / effH)
    const boxW = effW * scale
    const boxH = effH * scale
    return { scale, fit: { x: (cw - boxW) / 2, y: (ch - boxH) / 2, w: boxW, h: boxH } }
  }

  /** Recompute scale/fit for the CURRENT pane size from the last frame's dimensions,
   *  WITHOUT waiting for the next decoded frame. Called on resize / rotation so the
   *  click→device mapping stays correct the instant the layout changes — the stream may
   *  not repaint for a frame or two (or at all, on a static screen), and hit-testing must
   *  not lag it. No-op until the first frame has set srcW/srcH. */
  relayout(): void {
    const canvas = this.canvas
    const parent = canvas?.parentElement
    if (!canvas || !parent || this.srcW === 0 || this.srcH === 0) return
    const cw = parent.clientWidth
    const ch = parent.clientHeight
    if (cw === 0 || ch === 0) return
    const { scale, fit } = this.computeFit(cw, ch)
    this.scale = scale
    this.fit = fit
  }

  private drawSource(src: CanvasImageSource, sw: number, sh: number): void {
    const canvas = this.canvas
    const parent = canvas?.parentElement
    if (!canvas || !parent || sw === 0 || sh === 0) return
    const cw = parent.clientWidth
    const ch = parent.clientHeight
    if (cw === 0 || ch === 0) return
    this.srcW = sw
    this.srcH = sh
    const dpr = window.devicePixelRatio || 1
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
      canvas.width = Math.round(cw * dpr)
      canvas.height = Math.round(ch * dpr)
      canvas.style.width = `${cw}px`
      canvas.style.height = `${ch}px`
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const rot = ((this.rotation % 360) + 360) % 360
    const { scale, fit } = this.computeFit(cw, ch)
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
    this.scale = scale
    this.fit = fit
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
    this.retagGen++ // drop any in-flight full-range corrections
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
  connection,
  onClose,
  onCaptured,
  onPopout,
  popped = false,
  receiver = false
}: {
  serial: string | null
  /** How the device is reached. A Wi-Fi-only device can't be captured over USB
   *  CoreMediaIO, so the mirror defaults to the AirPlay path (shows the connect
   *  hint) instead of a USB spinner that would never resolve. */
  connection?: 'usb' | 'wifi'
  onClose: () => void
  onCaptured: (result: SaveResult) => void
  /** Detach into a separate window (docked) or re-dock (popped). Hidden if absent. */
  onPopout?: () => void
  /** True when rendered inside the detached window. */
  popped?: boolean
  /** Standalone AirPlay-receiver mode (top-bar toggle): always the AirPlay path,
   *  independent of any selected device — the USB toggle is hidden and no serial is
   *  needed. Any phone that picks "AndroidLab" on the network shows up here. */
  receiver?: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<H264Engine>(new H264Engine())

  const [hasFrame, setHasFrame] = useState(false)
  const [message, setMessage] = useState('Connecting…')
  const [failed, setFailed] = useState<string | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [rotation, setRotation] = useState(0) // view rotation (0/90/180/270)
  // Feed path: 'usb' (CoreMediaIO, low-latency, supports touch) or 'airplay' (Wi-Fi,
  // phone-initiated, view-only). Toggled on the rail; changing it restarts the feed.
  // Default from the transport: a cable-free (Wi-Fi) device has no USB screen device
  // to capture, so start it on AirPlay — showing the connect hint, not a dead spinner.
  // Receiver mode is always AirPlay (there's no device to capture over USB).
  const [mode, setMode] = useState<'usb' | 'airplay'>(() =>
    receiver || connection === 'wifi' ? 'airplay' : 'usb'
  )
  const [waiting, setWaiting] = useState(false) // airplay: advertised, phone not yet connected
  // AirPlay stream resolution (persisted). Changing it restarts the receiver.
  const [resolution, setResolution] = useState<Resolution>(loadResolution)
  const [streamSettingsOpen, setStreamSettingsOpen] = useState(false)
  // The popover is positioned `fixed` to the viewport (anchored to the gear) so the
  // rail's `overflow-y:auto` — which also clips horizontally — can't hide it.
  const gearRef = useRef<HTMLButtonElement>(null)
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null)
  // Device-audio mute. The preference lives in the main process (the helper plays
  // audio on the Mac's output), so a freshly mounted view reads it back — a dock<->
  // popout remount must not silently flip the sound back on.
  const [muted, setMuted] = useState(false)
  // Touch/keyboard forwarding (needs a provisioned agent — see IosInputSettingsModal).
  const [inputOn, setInputOn] = useState(false)
  const [inputMsg, setInputMsg] = useState<string | null>(null)
  const [typing, setTyping] = useState(false)
  const [typeText, setTypeText] = useState('')
  const uiSizeRef = useRef<{ width: number; height: number } | null>(null)
  const pressRef = useRef<{ x: number; y: number; t: number } | null>(null)
  // A synthetic touch indicator that tracks the cursor INSTANTLY (client-side, zero
  // latency) so a press/drag feels responsive even though the device injects on release.
  const wrapRef = useRef<HTMLDivElement>(null)
  const dotRef = useRef<HTMLDivElement>(null)

  // Attach the canvas + present loop for the component's lifetime.
  useEffect(() => {
    const eng = engineRef.current
    eng.attach(canvasRef.current)
    eng.onFail = (m) => setFailed(m)
    return () => eng.close()
  }, [])

  // Push the view rotation to the engine; the next painted frame applies it. Recompute
  // the fit immediately too so click→device mapping is correct before that frame lands.
  useEffect(() => {
    engineRef.current.setRotation(rotation)
    engineRef.current.relayout()
  }, [rotation])

  // The AirPlay feed is full-range H.264; the USB feed is limited-range. Tell the
  // engine which so it only applies the full-range colour correction to AirPlay.
  useEffect(() => {
    engineRef.current.fullRange = mode === 'airplay'
  }, [mode])

  // Keep the hit-test geometry in lockstep with the pane's actual size. drawSource only
  // recomputes scale/fit when a frame paints; a resize (window drag, fullscreen, popout)
  // or a stalled stream would otherwise leave taps mapped against the old geometry. This
  // is the layout-driven recompute Apple's iPhone Mirroring does for its coordinateTransform.
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => engineRef.current.relayout())
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [])

  // On a device switch (or a transport change — e.g. the cable is unplugged but the
  // device stays reachable over Wi-Fi), reset the feed path to the transport default.
  // A manual rail toggle sticks because this only re-runs when serial/connection change.
  // Receiver mode is pinned to AirPlay regardless.
  useEffect(() => {
    setMode(receiver || connection === 'wifi' ? 'airplay' : 'usb')
  }, [serial, connection, receiver])

  // (Re)start the feed whenever the device — or the feed path (USB/AirPlay) — changes.
  // AirPlay is phone-initiated and doesn't need a cabled serial, so it can start
  // without one; USB requires the selected device.
  useEffect(() => {
    if (mode === 'usb' && !serial) {
      setMessage('No device selected')
      return
    }
    setFailed(null)
    setHasFrame(false)
    setWaiting(mode === 'airplay')
    setMessage(mode === 'airplay' ? 'Starting AirPlay receiver…' : 'Connecting to device…')
    // A new device/path needs its own agent check — drop input state.
    setInputOn(false)
    setInputMsg(null)
    uiSizeRef.current = null
    engineRef.current.reset()
    engineRef.current.clear()
    void window.androidlab.iosMirror.start(
      serial ?? '',
      mode,
      mode === 'airplay' ? { width: resolution.width, height: resolution.height } : undefined
    )
    return () => {
      void window.androidlab.iosMirror.stop()
      engineRef.current.reset()
    }
  }, [serial, mode, resolution])

  // IPC subscriptions.
  useEffect(() => {
    const eng = engineRef.current
    const unH264 = window.androidlab.iosMirror.onH264((chunk) => {
      eng.pushH264(chunk)
      setHasFrame(true)
      setFailed(null)
    })
    const unState = window.androidlab.iosMirror.onState((s: IosMirrorState) => {
      setMessage(s.message)
      setWaiting(Boolean(s.waiting))
    })
    const unFail = window.androidlab.iosMirror.onFailed((m) => {
      setFailed(m)
      setHasFrame(false)
    })
    void window.androidlab.iosMirror.getMuted().then(setMuted)
    return () => {
      unH264()
      unState()
      unFail()
    }
  }, [])

  const toggleMute = useCallback(() => {
    void window.androidlab.iosMirror.setMuted(!muted).then(setMuted)
  }, [muted])

  const pickResolution = useCallback((r: Resolution) => {
    setResolution(r)
    setStreamSettingsOpen(false)
    try {
      localStorage.setItem(RES_STORAGE_KEY, String(r.width))
    } catch {
      /* ignore */
    }
  }, [])

  const toggleStreamSettings = useCallback(() => {
    setStreamSettingsOpen((v) => {
      if (!v && gearRef.current) {
        const r = gearRef.current.getBoundingClientRect()
        setMenuPos({ top: r.top, right: window.innerWidth - r.left + 8 })
      }
      return !v
    })
  }, [])

  // Close the stream-settings popover on any outside click.
  useEffect(() => {
    if (!streamSettingsOpen) return
    const onDown = (e: MouseEvent): void => {
      const t = e.target as HTMLElement
      if (!t.closest('.stream-settings') && !t.closest('.rail-gear')) setStreamSettingsOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [streamSettingsOpen])

  const doScreenshot = useCallback(async () => {
    const dataUrl = engineRef.current.snapshot()
    if (!dataUrl) return
    setBusy(true)
    const r = await window.androidlab.iosMirror.saveFrame(dataUrl)
    setBusy(false)
    onCaptured(r)
  }, [onCaptured])

  // --- touch/keyboard forwarding ------------------------------------------
  // Enable input: bring up the agent (confirm it's reachable), then read the device size
  // (the points `ui tap/swipe` expect) so canvas clicks can be mapped. Returns success.
  const enableInput = useCallback(async (): Promise<boolean> => {
    if (!serial) return false
    setInputMsg('Checking touch agent…')
    const up = await window.androidlab.iosInput.status(serial)
    if (!up) {
      setInputMsg('Touch agent not set up — open the ⚙ iOS touch input settings and provision it.')
      return false
    }
    const sz = await window.androidlab.iosInput.size(serial)
    if (!sz) {
      setInputMsg('Agent is up but the device size could not be read.')
      return false
    }
    uiSizeRef.current = sz
    setInputOn(true)
    setInputMsg(null)
    return true
  }, [serial])

  const toggleInput = useCallback(async () => {
    if (inputOn) {
      setInputOn(false)
      setInputMsg(null)
      return
    }
    await enableInput()
  }, [inputOn, enableInput])

  // Auto-enable touch once the mirror is live — but only if the agent is already
  // provisioned (otherwise stay view-only; provisioning is a deliberate ⚙ step). One
  // attempt per device so a manual disable isn't fought, and re-armed on device switch.
  const autoTriedRef = useRef<string | null>(null)
  useEffect(() => {
    if (mode === 'airplay' || !serial || !hasFrame || inputOn) return
    if (autoTriedRef.current === serial) return
    autoTriedRef.current = serial
    void (async () => {
      const cfg = await window.androidlab.iosInput.getConfig()
      if (cfg?.provisioned) void enableInput()
    })()
  }, [serial, hasFrame, inputOn, enableInput, mode])

  // Canvas client point → device POINTS: invert the view rotation + scale to device
  // PIXELS (same as the Android mapping), then scale pixels→points via `ui size`. With
  // `clamp`, a point in the letterbox (or past the pane edge) is pinned to the nearest
  // device pixel instead of rejected — so an in-progress drag that runs off the edge
  // (swipe-up-for-home, pull-down Control Center, edge-swipe back) keeps tracking to the
  // screen bound. A fresh press (clamp off) still requires landing on the screen itself.
  const toDevicePoints = useCallback(
    (clientX: number, clientY: number, clamp = false): { x: number; y: number } | null => {
      const eng = engineRef.current
      const canvas = canvasRef.current
      const sz = uiSizeRef.current
      if (!canvas || eng.srcW === 0 || !eng.scale || !sz) return null
      const rect = canvas.getBoundingClientRect()
      const X = clientX - (rect.left + rect.width / 2)
      const Y = clientY - (rect.top + rect.height / 2)
      const rad = (-eng.rotation * Math.PI) / 180
      const c = Math.cos(rad)
      const s = Math.sin(rad)
      const ux = X * c - Y * s
      const uy = X * s + Y * c
      let pxX = ux / eng.scale + eng.srcW / 2
      let pxY = uy / eng.scale + eng.srcH / 2
      if (pxX < 0 || pxX >= eng.srcW || pxY < 0 || pxY >= eng.srcH) {
        if (!clamp) return null
        pxX = Math.min(Math.max(pxX, 0), eng.srcW - 1)
        pxY = Math.min(Math.max(pxY, 0), eng.srcH - 1)
      }
      return { x: (pxX * sz.width) / eng.srcW, y: (pxY * sz.height) / eng.srcH }
    },
    []
  )

  // Touch indicator: a finger-sized ring positioned relative to the canvas wrapper.
  // Driven straight through the DOM (no React re-render) so it tracks the cursor 1:1.
  const TOUCH_DOT_R = 21
  const moveDot = useCallback((clientX: number, clientY: number): void => {
    const wrap = wrapRef.current
    const dot = dotRef.current
    if (!wrap || !dot) return
    const rect = wrap.getBoundingClientRect()
    dot.style.transform = `translate(${clientX - rect.left - TOUCH_DOT_R}px, ${clientY - rect.top - TOUCH_DOT_R}px)`
  }, [])
  const showDot = useCallback(
    (clientX: number, clientY: number): void => {
      moveDot(clientX, clientY)
      const dot = dotRef.current
      if (!dot) return
      dot.classList.remove('press') // retrigger the press pulse
      void dot.offsetWidth
      dot.classList.add('show', 'press')
    },
    [moveDot]
  )
  const hideDot = useCallback((): void => dotRef.current?.classList.remove('show', 'press'), [])

  const movedRef = useRef(false)
  // Recent finger samples (device points + ms timestamps), used only to compute the RELEASE
  // velocity so a flick can carry momentum. iOS can't stream touch (every injected gesture is
  // one atomic XCTest event that lifts the finger — verified on-device), so the drag is a
  // HYBRID: while the mouse moves we stream short swipe segments (content tracks live, but
  // coarse ~2-3 steps/sec — the XCTest floor), and on release we hand the service a projected
  // `flick` so a fast release keeps scrolling with native momentum. The touch-dot follows the
  // cursor 1:1 for instant visual feedback throughout.
  const pathRef = useRef<Array<{ x: number; y: number; t: number }>>([])
  const onCanvasDown = useCallback(
    (e: React.MouseEvent) => {
      if (!inputOn) return
      const p = toDevicePoints(e.clientX, e.clientY)
      pressRef.current = p ? { ...p, t: e.timeStamp } : null
      movedRef.current = false
      pathRef.current = p ? [{ x: p.x, y: p.y, t: e.timeStamp }] : []
      if (p) {
        wrapRef.current?.focus() // capture the keyboard for live forwarding
        showDot(e.clientX, e.clientY)
        // Anchor the streamed drag at the press point (no injection until it moves).
        if (serial) void window.androidlab.iosInput.drag(serial, 'start', p.x, p.y)
      }
    },
    [inputOn, serial, toDevicePoints, showDot]
  )
  // Stream the move to the device as it happens so content tracks live, and record the sample
  // for the release-velocity calc. The dot follows the cursor instantly regardless.
  const onCanvasMove = useCallback(
    (e: React.MouseEvent) => {
      if (!inputOn || !pressRef.current) return
      moveDot(e.clientX, e.clientY)
      const p = toDevicePoints(e.clientX, e.clientY, true)
      if (!p) return
      const press = pressRef.current
      if (Math.abs(p.x - press.x) + Math.abs(p.y - press.y) >= 8) movedRef.current = true
      pathRef.current.push({ x: p.x, y: p.y, t: e.timeStamp })
      if (pathRef.current.length > 64) pathRef.current.shift() // keep it bounded; we only need the tail
      if (serial) void window.androidlab.iosInput.drag(serial, 'move', p.x, p.y)
    },
    [inputOn, serial, toDevicePoints, moveDot]
  )
  // A short press (never moved) = tap; otherwise end the streamed drag, adding a velocity-matched
  // momentum flick from the release point so a fast flick keeps scrolling.
  const onCanvasUp = useCallback(
    (e: React.MouseEvent) => {
      hideDot()
      if (!inputOn || !serial) return
      const press = pressRef.current
      const moved = movedRef.current
      const path = pathRef.current
      pressRef.current = null
      movedRef.current = false
      pathRef.current = []
      if (!press) return
      const up = toDevicePoints(e.clientX, e.clientY, true) ?? { x: press.x, y: press.y }
      const dist = Math.abs(up.x - press.x) + Math.abs(up.y - press.y)
      if (!moved && dist < 8) {
        void window.androidlab.iosInput.drag(serial, 'end', press.x, press.y) // clears the anchor
        void window.androidlab.iosInput.tap(serial, press.x, press.y)
      } else {
        void window.androidlab.iosInput.drag(serial, 'end', up.x, up.y, computeFlick(path, up, uiSizeRef.current))
      }
    },
    [inputOn, serial, toDevicePoints, hideDot]
  )

  // Live keyboard forwarding: while the mirror is focused + touch is on, each physical
  // keystroke goes to the device (chars, Enter/Backspace/arrows/…, and ⌘/⌃ combos).
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!inputOn || !serial) return
      if (typing) return // the on-screen type box owns the keyboard while it's open
      const k = e.key
      if (k === 'Shift' || k === 'Control' || k === 'Alt' || k === 'Meta' || k === 'CapsLock') return
      const mods: string[] = []
      if (e.metaKey) mods.push('command')
      if (e.ctrlKey) mods.push('control')
      if (e.altKey) mods.push('option')
      if (e.shiftKey && k.length > 1) mods.push('shift') // a char already encodes its own case
      e.preventDefault()
      void window.androidlab.iosInput.key(serial, k, mods)
    },
    [inputOn, serial, typing]
  )

  const submitType = useCallback(() => {
    const text = typeText
    setTyping(false)
    setTypeText('')
    if (text && serial) void window.androidlab.iosInput.type(serial, text)
  }, [typeText, serial])

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
      <div
        ref={wrapRef}
        className={`mirror-canvas-wrap${inputOn ? ' ios-input-on' : ''}`}
        tabIndex={inputOn ? 0 : undefined}
        onMouseDown={onCanvasDown}
        onMouseMove={onCanvasMove}
        onMouseUp={onCanvasUp}
        onMouseLeave={onCanvasUp}
        onKeyDown={onKeyDown}
      >
        <canvas ref={canvasRef} className="ios-surface" />
        {inputOn ? <div ref={dotRef} className="ios-touch-dot" aria-hidden /> : null}
        {failed ? (
          <div className="mirror-msg">{failed}</div>
        ) : !hasFrame ? (
          mode === 'airplay' && waiting ? (
            <div className="mirror-loading ios-airplay-wait">
              <Icon name="airplay" size={40} />
              <div className="mirror-loading-tx">{message}</div>
            </div>
          ) : mode === 'airplay' || serial ? (
            <div className="mirror-loading">
              <div className="mirror-spinner" />
              <div className="mirror-loading-tx">{message}</div>
            </div>
          ) : (
            <div className="mirror-msg">{message}</div>
          )
        ) : null}
        {inputMsg ? <div className="ios-input-hint">{inputMsg}</div> : null}
        {typing ? (
          <div className="mirror-type" onMouseDown={(e) => e.stopPropagation()}>
            <input
              autoFocus
              placeholder="Type into the focused field…"
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
        {receiver ? null : (
          <button
            className={`rail-btn${mode === 'airplay' ? ' active' : ''}`}
            title={
              mode === 'airplay'
                ? 'AirPlay (Wi-Fi) — click for USB capture'
                : 'Mirror over Wi-Fi via AirPlay (view-only; the phone connects to “AndroidLab”)'
            }
            onClick={() => setMode((m) => (m === 'airplay' ? 'usb' : 'airplay'))}
          >
            <Icon name="airplay" size={24} />
          </button>
        )}
        <button
          ref={gearRef}
          className={`rail-btn rail-gear${streamSettingsOpen ? ' active' : ''}`}
          title="Stream settings (resolution)"
          onClick={toggleStreamSettings}
        >
          <Icon name="settings" size={24} />
        </button>
        {streamSettingsOpen ? (
          <div
            className="stream-settings"
            style={menuPos ? { top: menuPos.top, right: menuPos.right } : undefined}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="stream-settings-hd">Resolution</div>
            {mode === 'airplay' ? (
              RES_PRESETS.map((r) => (
                <button
                  key={r.label}
                  className={`stream-opt${r.width === resolution.width ? ' sel' : ''}`}
                  onClick={() => pickResolution(r)}
                >
                  <span>{r.label}</span>
                  <span className="stream-opt-dim">
                    {r.width}×{r.height}
                  </span>
                </button>
              ))
            ) : (
              <div className="stream-note">USB mirrors at the device’s native resolution.</div>
            )}
          </div>
        ) : null}

        <div className="rail-div" />

        <button
          className={`rail-btn${inputOn ? ' active' : ''}`}
          title={
            mode === 'airplay'
              ? 'Touch forwarding needs the USB path (switch off AirPlay)'
              : inputOn
                ? 'Touch forwarding ON — click to disable'
                : 'Forward touches to the device (needs a provisioned agent)'
          }
          disabled={!hasFrame || mode === 'airplay'}
          onClick={() => void toggleInput()}
        >
          <Icon name="touch" size={24} />
        </button>
        <button
          className={`rail-btn${typing ? ' active' : ''}`}
          title={inputOn ? 'Type text into the focused field' : 'Enable touch forwarding first'}
          disabled={!inputOn}
          onClick={() => setTyping((v) => !v)}
        >
          <Icon name="keyboard" size={24} />
        </button>

        <div className="rail-div" />

        {/* navigation — home/switcher go through WebDriverAgent, which the main process
            brings up on demand (no need to enable touch forwarding first). */}
        <button
          className="rail-btn"
          title="Home — background all apps, go to the home screen"
          disabled={!serial || mode === 'airplay'}
          onClick={() => serial && void window.androidlab.iosInput.button(serial, 'home')}
        >
          <Icon name="home" size={24} />
        </button>
        <button
          className="rail-btn"
          title="App Switcher — show the running-app stack"
          disabled={!serial || mode === 'airplay'}
          onClick={() => serial && void window.androidlab.iosInput.button(serial, 'appswitcher')}
        >
          <Icon name="recents" size={24} />
        </button>

        <div className="rail-div" />

        {/* hardware volume keys */}
        <button
          className="rail-btn"
          title="Volume up"
          disabled={!serial || mode === 'airplay'}
          onClick={() => serial && void window.androidlab.iosInput.button(serial, 'volumeup')}
        >
          <Icon name="volUp" size={24} />
        </button>
        <button
          className="rail-btn"
          title="Volume down"
          disabled={!serial || mode === 'airplay'}
          onClick={() => serial && void window.androidlab.iosInput.button(serial, 'volumedown')}
        >
          <Icon name="volDown" size={24} />
        </button>
        <button
          className={`rail-btn${muted ? ' active' : ''}`}
          title={
            muted
              ? 'Unmute — play the device audio on this Mac'
              : 'Mute the device audio played on this Mac'
          }
          onClick={toggleMute}
        >
          <Icon name={muted ? 'muted' : 'sound'} size={24} />
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
