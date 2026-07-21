/**
 * Mac→Android cast SENDER dock. Captures this Mac's screen (desktopCapturer → getUserMedia),
 * H.264-encodes it in-page with WebCodecs (Annex-B, ~1s keyframes, no B-frames for low
 * latency), and streams the chunks to the main process (services/mlkcast.ts), which frames
 * them onto the `_mlkmirror._tcp` wire protocol the MobileLabKit Mirror Android app receives.
 *
 * v1 is video-only and connects by IP (the Android "Receive a screen" screen shows its IP);
 * mDNS auto-discovery is a natural follow-up. macOS needs the Screen Recording permission —
 * the first capture triggers the prompt.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MlkCastState, MlkCastReceiver, MlkScreen } from '@shared/types'
import { Icon } from './Icon'
import { AppQr } from './AppQr'

// MediaStreamTrackProcessor isn't in the standard DOM lib types (it lives in a separate
// @types package). Electron 33's Chromium has it — declare the minimal surface we use.
declare global {
  interface MediaStreamTrackProcessorInit {
    track: MediaStreamTrack
  }
  // eslint-disable-next-line no-var
  var MediaStreamTrackProcessor: {
    new (init: MediaStreamTrackProcessorInit): { readonly readable: ReadableStream<VideoFrame> }
  }
}

const HAS_ENCODER = typeof (globalThis as { VideoEncoder?: unknown }).VideoEncoder !== 'undefined'
const HAS_PROCESSOR = typeof (globalThis as { MediaStreamTrackProcessor?: unknown }).MediaStreamTrackProcessor !== 'undefined'
// Capture-resolution presets (long-edge cap). "Max" grabs the display's native resolution.
// Screen content compresses well, so even native stays reasonable over Wi-Fi; the phone
// decodes it comfortably. Default to the sharpest.
// Capture-resolution presets as real aspect boxes (not a square cap — a square box made
// getSettings report e.g. 3840×3840, whose coded area exceeds H.264 level 5.1). The capture
// fits inside the box preserving the display's aspect. "Max" is 4K, comfortably within L5.1.
const QUALITY: { label: string; w: number; h: number }[] = [
  { label: '1080p', w: 1920, h: 1080 },
  { label: '1440p', w: 2560, h: 1440 },
  { label: 'Max', w: 3840, h: 2160 }
]
const FPS = 30
const KEY_EVERY = 30 // force a keyframe ~every second so the receiver can (re)sync fast
const ALL_SCREENS = '__all__' // screen-picker sentinel: composite every display into one stream
const MAX_AREA = 8_294_400 // 4K (3840×2160) — keep the encoded frame within H.264 level 5.1

const evenDown = (n: number): number => Math.max(2, Math.floor(n / 2) * 2)

// Prefer High profile (best quality for screen/text), then fall back down. Level 5.1 covers
// up to 4K, so it's safe for any capture size. Returns a supported config's codec, or null.
async function chooseCodec(width: number, height: number, bitrate: number): Promise<string | null> {
  const candidates = ['avc1.640033', 'avc1.4D0033', 'avc1.42E033', 'avc1.42E028']
  for (const codec of candidates) {
    try {
      const cfg = {
        codec,
        width,
        height,
        bitrate,
        framerate: FPS,
        latencyMode: 'realtime',
        avc: { format: 'annexb' }
      } as unknown as VideoEncoderConfig
      const sup = await VideoEncoder.isConfigSupported(cfg)
      if (sup.supported) return sup.config?.codec ?? codec
    } catch {
      /* try the next candidate */
    }
  }
  return null
}

export function MlkCastDock({ onClose }: { onClose: () => void }): JSX.Element {
  const [host, setHost] = useState('')
  const [port, setPort] = useState('8899')
  const [state, setState] = useState<MlkCastState>({
    message: 'Enter the IP shown on the phone’s “Receive a screen”, then Start.',
    casting: false
  })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [receivers, setReceivers] = useState<MlkCastReceiver[]>([])
  const [manual, setManual] = useState(false)
  const [quality, setQuality] = useState('')
  const [box, setBox] = useState(QUALITY[2]) // default Max
  const boxRef = useRef(box)
  boxRef.current = box
  const [screens, setScreens] = useState<MlkScreen[]>([])
  const [screenId, setScreenId] = useState<string | null>(null)
  const screenIdRef = useRef<string | null>(null)
  screenIdRef.current = screenId
  const screensRef = useRef<MlkScreen[]>([])
  screensRef.current = screens

  const streamRef = useRef<MediaStream | null>(null)
  const encoderRef = useRef<VideoEncoder | null>(null)
  const codecRef = useRef<string | null>(null) // remember the codec that worked (see startCast)
  // Composite ("All screens") path: extra capture streams + the rAF draw loop to tear down.
  const extraStreamsRef = useRef<MediaStream[]>([])
  const rafRef = useRef(0)
  const readerRef = useRef<ReadableStreamDefaultReader<VideoFrame> | null>(null)
  const runningRef = useRef(false)

  const stopCast = useCallback(async () => {
    runningRef.current = false
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
    }
    try {
      await readerRef.current?.cancel()
    } catch {
      /* ignore */
    }
    readerRef.current = null
    // Composite path's extra display captures.
    for (const s of extraStreamsRef.current) s.getTracks().forEach((t) => t.stop())
    extraStreamsRef.current = []
    if (encoderRef.current && encoderRef.current.state !== 'closed') {
      try {
        encoderRef.current.close()
      } catch {
        /* ignore */
      }
    }
    encoderRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    void window.androidlab.mlkCast.stop()
    setBusy(false)
    // Return to the picker immediately. Main tears down the socket (its 'close' may not
    // re-notify on a manual stop), so reset here — which also re-arms discovery, since the
    // browse effect keys off state.casting.
    setState((prev) => ({ ...prev, casting: false }))
  }, [])

  useEffect(() => {
    const offState = window.androidlab.mlkCast.onState((s) => {
      setState(s)
      if (!s.casting) void stopCast()
    })
    const offFailed = window.androidlab.mlkCast.onFailed((m) => {
      setError(m)
      void stopCast()
    })
    return () => {
      offState()
      offFailed()
      void stopCast()
    }
  }, [stopCast])

  // Discover phones in "Receive a screen" mode over mDNS while the picker is open.
  useEffect(() => {
    if (state.casting) return
    const stop = window.androidlab.mlkCast.browse(setReceivers)
    return stop
  }, [state.casting])

  // List this Mac's displays with preview thumbnails, refreshed for a live-ish preview while
  // the picker is open. Default the selection to the primary display.
  useEffect(() => {
    if (state.casting) return
    let alive = true
    const load = async (): Promise<void> => {
      const list = await window.androidlab.mlkCast.getScreens()
      if (!alive) return
      setScreens(list)
      setScreenId((cur) => cur ?? list[0]?.id ?? null)
    }
    void load()
    const t = setInterval(() => void load(), 2000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [state.casting])

  // "All screens": capture every display and composite them side-by-side into one encoded
  // stream (macOS has no single all-displays source, so we draw each to a canvas and encode
  // that). Scaled to fit the quality box width and the H.264 level's coded-area limit.
  const captureComposite = useCallback(async (h: string, p: number) => {
    const list = screensRef.current
    const b = boxRef.current
    const videos: { el: HTMLVideoElement; w: number; h: number }[] = []
    for (let i = 0; i < list.length; i++) {
      await window.androidlab.mlkCast.setSource(list[i].id)
      const stream = await navigator.mediaDevices.getDisplayMedia({
        audio: false,
        video: { frameRate: { ideal: FPS, max: FPS }, width: { max: b.w }, height: { max: b.h } }
      })
      if (i === 0) streamRef.current = stream
      else extraStreamsRef.current.push(stream)
      const el = document.createElement('video')
      el.srcObject = stream
      el.muted = true
      el.playsInline = true
      await el.play().catch(() => {})
      if (!el.videoWidth) {
        await new Promise<void>((res) => {
          el.onloadedmetadata = () => res()
          setTimeout(res, 1500)
        })
      }
      stream.getVideoTracks()[0]?.addEventListener('ended', () => void stopCast())
      videos.push({ el, w: el.videoWidth || b.w, h: el.videoHeight || b.h })
    }
    if (videos.length === 0) {
      setError('No screens to capture.')
      void stopCast()
      return
    }

    // Equal columns (half-and-half for two displays). Column width = the widest display, canvas
    // height = the tallest — then scale the whole thing to the box width + the level's area cap.
    const colW = Math.max(...videos.map((v) => v.w))
    const rowH = Math.max(...videos.map((v) => v.h))
    const rawW = colW * videos.length
    const scale = Math.min(1, b.w / rawW, Math.sqrt(MAX_AREA / (rawW * rowH)))
    const cw = evenDown(rawW * scale)
    const ch = evenDown(rowH * scale)
    const colWpx = cw / videos.length // each display gets an equal share of the width
    setQuality(`${cw}×${ch} · ${videos.length} screens`)

    const canvas = document.createElement('canvas')
    canvas.width = cw
    canvas.height = ch
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      setError('Could not create the compositing canvas.')
      void stopCast()
      return
    }

    const bitrate = Math.min(40_000_000, Math.max(6_000_000, Math.round(cw * ch * FPS * 0.22)))
    let codec = codecRef.current
    if (!codec) codec = await chooseCodec(cw, ch, bitrate)
    if (!codec) codec = 'avc1.42E033'
    codecRef.current = codec
    const encoder = new VideoEncoder({
      output: (chunk) => {
        const buf = new Uint8Array(chunk.byteLength)
        chunk.copyTo(buf)
        window.androidlab.mlkCast.push(buf, chunk.type === 'key')
      },
      error: (e) => {
        setError(e.message || 'encoder error')
        void stopCast()
      }
    })
    encoder.configure({
      codec,
      width: cw,
      height: ch,
      bitrate,
      framerate: FPS,
      latencyMode: 'realtime',
      avc: { format: 'annexb' }
    } as unknown as VideoEncoderConfig)
    encoderRef.current = encoder

    const ok = await window.androidlab.mlkCast.connect(h, p, cw, ch)
    if (!ok) return

    runningRef.current = true
    let n = 0
    let lastMs = 0
    const draw = (): void => {
      if (!runningRef.current) return
      const enc = encoderRef.current
      const now = performance.now()
      // Gate to ~FPS (rAF may fire at 60/120Hz) and don't outrun the encoder.
      if (enc && enc.state === 'configured' && enc.encodeQueueSize < 4 && now - lastMs >= 1000 / FPS - 2) {
        lastMs = now
        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, cw, ch)
        for (let i = 0; i < videos.length; i++) {
          const v = videos[i]
          // Fit (contain) into this display's column, preserving aspect; center it both ways.
          const s = Math.min(colWpx / v.w, ch / v.h)
          const dw = v.w * s
          const dh = v.h * s
          const x = i * colWpx + (colWpx - dw) / 2
          const y = (ch - dh) / 2
          try {
            ctx.drawImage(v.el, x, y, dw, dh)
          } catch {
            /* frame not ready */
          }
        }
        const vf = new VideoFrame(canvas, { timestamp: Math.round(now * 1000) })
        try {
          enc.encode(vf, { keyFrame: n % KEY_EVERY === 0 })
          n++
        } catch {
          /* ignore */
        }
        vf.close()
      }
      rafRef.current = requestAnimationFrame(draw)
    }
    rafRef.current = requestAnimationFrame(draw)
  }, [stopCast])

  const startCast = useCallback(async (h: string, p: number) => {
    setError(null)
    if (!h) {
      setError('Enter the IP address shown on the Android app.')
      return
    }
    if (!HAS_ENCODER || !HAS_PROCESSOR) {
      setError('This build lacks the WebCodecs encoder needed to cast.')
      return
    }
    setBusy(true)
    setHost(h) // reflect the chosen target in the casting label
    // Never let a previous encoder keep holding the HW encoder session.
    if (encoderRef.current) {
      try {
        if (encoderRef.current.state !== 'closed') encoderRef.current.close()
      } catch {
        /* already closed */
      }
      encoderRef.current = null
    }
    try {
      // "All screens" → composite every display into one stream (separate path).
      if (screenIdRef.current === ALL_SCREENS && screensRef.current.length > 1) {
        await captureComposite(h, p)
        return
      }
      // Tell main which display to hand getDisplayMedia (the one picked in our screen picker).
      await window.androidlab.mlkCast.setSource(screenIdRef.current)
      // Modern capture path — captures at the display's real resolution, unlike the legacy
      // chromeMediaSource=desktop constraint which downscaled it to a blur.
      const b = boxRef.current
      const stream = await navigator.mediaDevices.getDisplayMedia({
        audio: false,
        video: {
          frameRate: { ideal: FPS, max: FPS },
          width: { max: b.w },
          height: { max: b.h }
        }
      })
      streamRef.current = stream
      const track = stream.getVideoTracks()[0]
      if (!track || track.readyState === 'ended') {
        setError('Screen capture didn’t start — try again.')
        void stopCast()
        return
      }
      // Build the frame reader NOW, while the track is live. Constructing it later (after the
      // codec/connect awaits) risks "Input track cannot be ended" if the track ends meanwhile.
      const processor = new MediaStreamTrackProcessor({ track })
      const reader = processor.readable.getReader()
      readerRef.current = reader
      // If the user stops sharing from the OS bar (or the display reconfigures), end the cast.
      track.addEventListener('ended', () => void stopCast())

      // Take the real capture size from the FIRST frame — track.getSettings() can report the
      // constraint box (e.g. a square) instead of the actual frame, which then overruns the
      // H.264 level. The first frame is authoritative and even-sized for screen capture.
      const first = await reader.read()
      if (first.done || !first.value) {
        setError('No frames from the screen capture — try again.')
        void stopCast()
        return
      }
      const w = first.value.displayWidth
      const hgt = first.value.displayHeight
      setQuality(`${w}×${hgt}`)

      // ~0.22 bit/px/frame keeps text sharp; clamp generously so high-res stays crisp on Wi-Fi.
      const bitrate = Math.min(40_000_000, Math.max(6_000_000, Math.round(w * hgt * FPS * 0.22)))
      // Reuse the codec that worked on the first cast. Re-running isConfigSupported right after
      // a previous encoder closed can transiently report "unsupported" (that's the second-cast
      // failure) — caching sidesteps it. Fall back to Baseline L5.1 (covers up to 4K) rather
      // than dead-ending, so the cast never fails with a false "not supported".
      let codec = codecRef.current
      if (!codec) codec = await chooseCodec(w, hgt, bitrate)
      if (!codec) codec = 'avc1.42E033'
      codecRef.current = codec
      const encoder = new VideoEncoder({
        output: (chunk) => {
          const buf = new Uint8Array(chunk.byteLength)
          chunk.copyTo(buf)
          window.androidlab.mlkCast.push(buf, chunk.type === 'key')
        },
        error: (e) => {
          setError(e.message || 'encoder error')
          void stopCast()
        }
      })
      encoder.configure({
        codec,
        width: w,
        height: hgt,
        bitrate,
        framerate: FPS,
        latencyMode: 'realtime',
        avc: { format: 'annexb' }
      } as unknown as VideoEncoderConfig)
      encoderRef.current = encoder

      const ok = await window.androidlab.mlkCast.connect(h, p, w, hgt)
      if (!ok) {
        try {
          first.value.close()
        } catch {
          /* already closed */
        }
        return
      }

      // Encode the first captured frame as the opening keyframe, then stream the rest.
      runningRef.current = true
      try {
        if (encoder.state === 'configured') encoder.encode(first.value, { keyFrame: true })
      } catch {
        /* ignore */
      }
      try {
        first.value.close()
      } catch {
        /* already closed */
      }
      let n = 1
      const pump = async (): Promise<void> => {
        while (runningRef.current) {
          const { value: frame, done } = await reader.read()
          if (done || !frame) break
          const enc = encoderRef.current
          if (enc && enc.state === 'configured' && enc.encodeQueueSize < 4) {
            enc.encode(frame, { keyFrame: n % KEY_EVERY === 0 })
            n++
          }
          frame.close()
        }
      }
      void pump()
    } catch (e) {
      // getUserMedia on macOS rejects until Screen Recording is granted — hint at it.
      const msg = e instanceof Error ? e.message : String(e)
      setError(/permission|denied|NotAllowed/i.test(msg) ? `${msg} — grant Screen Recording to this app in System Settings ▸ Privacy & Security.` : msg)
      void stopCast()
    }
  }, [stopCast, captureComposite])

  const casting = state.casting && !error

  return (
    <div className="mlk-mirror-dock">
      <div className="mlk-mirror-rail">
        <span className="mlk-mirror-title">
          <Icon name="laptop" size={14} /> Cast this Mac
        </span>
        <span className="mlk-mirror-spacer" />
        {casting ? (
          <button className="toggle active" title="Stop casting" onClick={() => void stopCast()}>
            <Icon name="stop" size={15} />
          </button>
        ) : null}
        <button className="toggle" title="Close" onClick={onClose}>
          <Icon name="close" size={15} />
        </button>
      </div>
      <div className="mlk-cast-body">
        {casting ? (
          <div className="mlk-cast-live">
            <div className="mlk-cast-live-badge">
              <Icon name="laptop" size={30} />
            </div>
            <div>
              <div className="mlk-cast-title">
                <span className="mlk-cast-live-dot" />
                Casting live
              </div>
              <div className="mlk-cast-sub" style={{ marginTop: 4 }}>
                Your Mac screen is showing on <b>{host}</b>
                {quality ? <> · {quality}</> : null}.
              </div>
            </div>
            <button className="mlk-cast-stop" onClick={() => void stopCast()}>
              Stop casting
            </button>
          </div>
        ) : (
          <div className="mlk-cast-scroll">
            <div className={`mlk-cast-hero${receivers.length === 0 && !busy ? ' searching' : ''}`}>
              <Icon name="laptop" size={30} />
            </div>
            <div>
              <div className="mlk-cast-title">Cast this Mac to a phone</div>
              <div className="mlk-cast-sub" style={{ marginTop: 5 }}>
                Show your Mac’s screen on an Android phone over Wi-Fi.
              </div>
            </div>

            {screens.length > 1 ? (
              <div className="mlk-cast-screens-wrap">
                <div className="mlk-cast-section-label">Which screen?</div>
                <div className="mlk-cast-screens">
                  {screens.map((sc) => (
                    <button
                      key={sc.id}
                      className={`mlk-cast-screen${screenId === sc.id ? ' active' : ''}`}
                      onClick={() => setScreenId(sc.id)}
                      disabled={busy}
                      title={sc.name}
                    >
                      {sc.thumbnail ? (
                        <img src={sc.thumbnail} alt={sc.name} draggable={false} />
                      ) : (
                        <span className="mlk-cast-screen-blank">
                          <Icon name="monitor" size={20} />
                        </span>
                      )}
                      <span className="mlk-cast-screen-name">{sc.name}</span>
                    </button>
                  ))}
                  <button
                    className={`mlk-cast-screen${screenId === ALL_SCREENS ? ' active' : ''}`}
                    onClick={() => setScreenId(ALL_SCREENS)}
                    disabled={busy}
                    title="Cast all displays together, side by side"
                  >
                    <span className="mlk-cast-screen-blank">
                      <Icon name="grid" size={20} />
                    </span>
                    <span className="mlk-cast-screen-name">All screens</span>
                  </button>
                </div>
              </div>
            ) : null}

            <div className="mlk-cast-quality" role="group" aria-label="Quality">
              {QUALITY.map((q) => (
                <button
                  key={q.label}
                  className={`mlk-cast-quality-pill${box.label === q.label ? ' active' : ''}`}
                  onClick={() => setBox(q)}
                  disabled={busy}
                  title={q.label === 'Max' ? 'Up to 4K (sharpest)' : `Cap at ${q.label}`}
                >
                  {q.label}
                </button>
              ))}
            </div>

            {receivers.length === 0 && !busy ? (
              <>
                <div className="mlk-cast-steps">
                  <div className="mlk-cast-step">
                    <span className="mlk-cast-step-n">1</span>
                    <span>Open <b>MobileLabKit Mirror</b> on your phone</span>
                  </div>
                  <div className="mlk-cast-step">
                    <span className="mlk-cast-step-n">2</span>
                    <span>Tap <b>Receive a screen</b></span>
                  </div>
                  <div className="mlk-cast-step">
                    <span className="mlk-cast-step-n">3</span>
                    <span>It shows up here — pick it to start</span>
                  </div>
                </div>
                <div className="mlk-cast-searching">
                  <span className="mlk-cast-dots"><i /><i /><i /></span>
                  Looking for your phone…
                </div>
              </>
            ) : (
              <div className="mlk-cast-list">
                {receivers.map((r) => (
                  <button
                    key={`${r.host}:${r.port}`}
                    className="mlk-cast-device"
                    disabled={busy}
                    onClick={() => void startCast(r.host, r.port)}
                  >
                    <span className="mlk-cast-device-ic">
                      <Icon name="android" size={20} />
                    </span>
                    <span className="mlk-cast-device-meta">
                      <span className="mlk-cast-device-name">{r.name}</span>
                      <span className="mlk-cast-device-ip">{r.host}</span>
                    </span>
                    <span className="mlk-cast-device-go">
                      {busy ? 'Starting…' : 'Cast'} <Icon name="chevronRight" size={14} />
                    </span>
                  </button>
                ))}
              </div>
            )}

            {manual ? (
              <div className="mlk-cast-form">
                <input
                  className="mlk-cast-input"
                  placeholder="192.168.x.x"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !busy) void startCast(host.trim(), parseInt(port, 10) || 8899)
                  }}
                  style={{ width: 140 }}
                  disabled={busy}
                />
                <input
                  className="mlk-cast-input"
                  placeholder="8899"
                  value={port}
                  onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ''))}
                  style={{ width: 60 }}
                  disabled={busy}
                />
                <button
                  className="mlk-cast-btn"
                  onClick={() => void startCast(host.trim(), parseInt(port, 10) || 8899)}
                  disabled={busy}
                >
                  {busy ? 'Starting…' : 'Start'}
                </button>
              </div>
            ) : (
              <button className="mlk-cast-manual-link" onClick={() => setManual(true)}>
                Phone not showing up? Enter its IP manually
              </button>
            )}
            {error ? <div className="mlk-cast-err">{error}</div> : null}
            <AppQr />
          </div>
        )}
      </div>
    </div>
  )
}
