/**
 * Android Auto head-unit tab. The Mac runs the AA protocol as a wireless head-unit server (main
 * process + an arm's-length helper) and triggers the selected phone to project its car UI to us
 * over Wi-Fi. This view decodes the incoming H.264 with WebCodecs (reusing the mirror's
 * AnnexBDemuxer) and forwards canvas pointer events back to the phone as touches.
 *
 * Prereqs shown to the user: phone + Mac on the same Wi-Fi; Android Auto developer mode on.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Controller } from '../state/useAppController'
import { AnnexBDemuxer } from '@core/mirror'

const HAS_WEBCODECS = typeof (globalThis as unknown as { VideoDecoder?: unknown }).VideoDecoder !== 'undefined'
const MAX_DECODE_QUEUE = 8

// AA PointerAction (Input.TouchEvent.PointerAction) — must match proto.ts.
const ACTION_DOWN = 0
const ACTION_UP = 1
const ACTION_MOVE = 2

/**
 * Streams the phone's PCM audio out the Mac's speakers. Each AA audio channel (media / guidance /
 * system) plays on its own gapless timeline scheduled ahead of the clock, all mixed through one
 * master gain (the mute control). Web Audio resamples 16 kHz mono → the device rate for us.
 */
class PcmPlayer {
  private ctx: AudioContext | null = null
  private gain: GainNode | null = null
  private readonly next = new Map<number, number>()
  private muted = false

  /** Create/resume the context — must be called from a user gesture (autoplay policy). */
  resume(): void {
    if (!this.ctx) {
      this.ctx = new AudioContext()
      this.gain = this.ctx.createGain()
      this.gain.gain.value = this.muted ? 0 : 1
      this.gain.connect(this.ctx.destination)
    }
    void this.ctx.resume()
  }

  push(channel: number, rate: number, channels: number, bytes: Uint8Array): void {
    const ctx = this.ctx
    const gain = this.gain
    if (!ctx || !gain || bytes.byteLength < 2) return
    // Copy so the Int16 view is 2-byte aligned regardless of the IPC buffer's offset.
    const copy = bytes.slice()
    const i16 = new Int16Array(copy.buffer, 0, copy.byteLength >> 1)
    const frames = Math.floor(i16.length / channels)
    if (frames === 0) return
    const buf = ctx.createBuffer(channels, frames, rate)
    for (let c = 0; c < channels; c++) {
      const cd = buf.getChannelData(c)
      for (let i = 0; i < frames; i++) cd[i] = i16[i * channels + c] / 32768
    }
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.connect(gain)
    const now = ctx.currentTime
    let t = this.next.get(channel) ?? 0
    // Underran (or first chunk): resync with ~80ms lead so scheduling stays ahead of the clock.
    if (t < now + 0.02) t = now + 0.08
    src.start(t)
    this.next.set(channel, t + buf.duration)
  }

  setMuted(muted: boolean): void {
    this.muted = muted
    if (this.gain && this.ctx) this.gain.gain.setValueAtTime(muted ? 0 : 1, this.ctx.currentTime)
  }

  reset(): void {
    this.next.clear()
  }

  close(): void {
    this.next.clear()
    if (this.ctx) {
      void this.ctx.close()
      this.ctx = null
      this.gain = null
    }
  }
}

/**
 * Captures the Mac's microphone while the phone has the mic open (Assistant / voice search),
 * resampling to the 16 kHz mono 16-bit PCM the AA mic sink expects and handing each chunk to the
 * caller (which ships it to the phone). Echo/noise processing on; monitored output is muted so it
 * never plays back on the Mac.
 */
class MicCapture {
  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private node: ScriptProcessorNode | null = null
  private src: MediaStreamAudioSourceNode | null = null
  private sink: GainNode | null = null
  private carry = 0
  active = false

  async start(onChunk: (bytes: Uint8Array) => void): Promise<void> {
    if (this.active) return
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    })
    const ctx = new AudioContext()
    this.ctx = ctx
    this.src = ctx.createMediaStreamSource(this.stream)
    const node = ctx.createScriptProcessor(4096, 1, 1)
    this.node = node
    const ratio = ctx.sampleRate / 16000
    this.carry = 0
    node.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0)
      const outLen = Math.floor((input.length - this.carry) / ratio)
      if (outLen <= 0) return
      const out = new Int16Array(outLen)
      let pos = this.carry
      for (let i = 0; i < outLen; i++) {
        const idx = Math.floor(pos)
        const frac = pos - idx
        const s = idx + 1 < input.length ? input[idx] * (1 - frac) + input[idx + 1] * frac : input[idx]
        out[i] = Math.max(-32768, Math.min(32767, Math.round(s * 32768)))
        pos += ratio
      }
      this.carry = pos - input.length
      onChunk(new Uint8Array(out.buffer.slice(0)))
    }
    // ScriptProcessor only fires while connected to the graph; route through a muted gain
    // so the captured audio never plays back on the Mac's speakers.
    this.sink = ctx.createGain()
    this.sink.gain.value = 0
    this.src.connect(node)
    node.connect(this.sink)
    this.sink.connect(ctx.destination)
    this.active = true
  }

  stop(): void {
    this.active = false
    if (this.node) {
      this.node.onaudioprocess = null
      try {
        this.node.disconnect()
      } catch {
        /* ignore */
      }
      this.node = null
    }
    try {
      this.src?.disconnect()
      this.sink?.disconnect()
    } catch {
      /* ignore */
    }
    this.src = null
    this.sink = null
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    if (this.ctx) {
      void this.ctx.close()
      this.ctx = null
    }
  }
}

/** Minimal decode + letterbox-present engine (a focused subset of MirrorDock's MirrorEngine). */
class DecodeEngine {
  private canvas: HTMLCanvasElement | null = null
  private demuxer = new AnnexBDemuxer()
  private decoder: VideoDecoder | null = null
  private configured = false
  private lastSpsGen = -1
  private ts = 0
  private pending: VideoFrame | null = null
  private raf = 0
  private running = false
  /** Decoded frame size + the CSS-px rect it's drawn in — used to map touches back. */
  srcW = 0
  srcH = 0
  drawRect = { x: 0, y: 0, w: 0, h: 0 }
  onFail: ((message: string) => void) | null = null

  attach(canvas: HTMLCanvasElement | null): void {
    this.canvas = canvas
    if (canvas && !this.running) {
      this.running = true
      const tick = (): void => {
        if (!this.running) return
        this.paint()
        this.raf = requestAnimationFrame(tick)
      }
      this.raf = requestAnimationFrame(tick)
    }
  }

  push(chunk: Uint8Array): void {
    if (!HAS_WEBCODECS) return
    for (const au of this.demuxer.push(chunk)) this.feed(au.data, au.key)
  }

  private ensureDecoder(): VideoDecoder | null {
    if (this.decoder) return this.decoder
    try {
      this.decoder = new VideoDecoder({
        output: (frame) => {
          this.pending?.close()
          this.pending = frame
          this.srcW = frame.displayWidth
          this.srcH = frame.displayHeight
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
    // Bounded latency: drop the backlog and resync at the next keyframe under load.
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
      if (!key || !codec) return // wait for a keyframe + its SPS
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

  private paint(): void {
    const canvas = this.canvas
    const frame = this.pending
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const cw = Math.max(1, Math.round(canvas.clientWidth * dpr))
    const ch = Math.max(1, Math.round(canvas.clientHeight * dpr))
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw
      canvas.height = ch
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = '#0d0f13'
    ctx.fillRect(0, 0, cw, ch)
    if (!frame) return
    const scale = Math.min(cw / frame.displayWidth, ch / frame.displayHeight)
    const w = frame.displayWidth * scale
    const h = frame.displayHeight * scale
    const x = (cw - w) / 2
    const y = (ch - h) / 2
    ctx.drawImage(frame, x, y, w, h)
    this.drawRect = { x: x / dpr, y: y / dpr, w: w / dpr, h: h / dpr }
  }

  /** Map a pointer (client coords relative to the canvas) to device pixels, or null if outside. */
  toDevice(offsetX: number, offsetY: number): { x: number; y: number } | null {
    const r = this.drawRect
    if (!this.srcW || !this.srcH || r.w <= 0 || r.h <= 0) return null
    const nx = (offsetX - r.x) / r.w
    const ny = (offsetY - r.y) / r.h
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return null
    return { x: Math.round(nx * this.srcW), y: Math.round(ny * this.srcH) }
  }

  reset(): void {
    this.demuxer.reset()
    this.configured = false
    this.lastSpsGen = -1
    this.ts = 0
    this.pending?.close()
    this.pending = null
    if (this.decoder) {
      try {
        this.decoder.close()
      } catch {
        /* already closed */
      }
      this.decoder = null
    }
    this.srcW = 0
    this.srcH = 0
  }

  destroy(): void {
    this.running = false
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
    this.reset()
    this.canvas = null
  }

  private fail(message: string): void {
    this.reset()
    this.onFail?.(message)
  }
}

export function AndroidAutoView({ c }: { c: Controller }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const engineRef = useRef<DecodeEngine | null>(null)
  const playerRef = useRef<PcmPlayer | null>(null)
  const micRef = useRef<MicCapture | null>(null)
  const [running, setRunning] = useState(false)
  const [streaming, setStreaming] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [muted, setMuted] = useState(false)
  const [micActive, setMicActive] = useState(false)
  const pressing = useRef(false)

  if (!engineRef.current) engineRef.current = new DecodeEngine()
  if (!playerRef.current) playerRef.current = new PcmPlayer()
  if (!micRef.current) micRef.current = new MicCapture()

  // Wire the event streams once; they persist across start/stop.
  useEffect(() => {
    const aa = window.androidlab.androidAuto
    const eng = engineRef.current!
    eng.onFail = (m) => setError(m)
    const unsubs = [
      aa.onH264((chunk) => eng.push(chunk)),
      aa.onPcm((channel, rate, channels, chunk) => playerRef.current?.push(channel, rate, channels, chunk)),
      aa.onMicOpen((open) => {
        if (open) {
          micRef.current
            ?.start((bytes) => void window.androidlab.androidAuto.micData(bytes))
            .then(() => setMicActive(true))
            .catch((e: Error) => setStatus(`Mic unavailable: ${e.message}`))
        } else {
          micRef.current?.stop()
          setMicActive(false)
        }
      }),
      aa.onStatus((m) => setStatus(m)),
      aa.onStreaming(() => setStreaming(true)),
      aa.onEnded((reason) => {
        setStreaming(false)
        setRunning(false)
        setStatus(`Session ended: ${reason}`)
        eng.reset()
        playerRef.current?.reset()
        micRef.current?.stop()
        setMicActive(false)
      }),
      aa.onFailed((m) => {
        setError(m)
        setStreaming(false)
        setRunning(false)
      })
    ]
    return () => {
      for (const u of unsubs) u()
    }
  }, [])

  // Stop cleanly when the tab unmounts or the device changes.
  useEffect(() => {
    return () => {
      void window.androidlab.androidAuto.stop()
      engineRef.current?.destroy()
      playerRef.current?.close()
      micRef.current?.stop()
    }
  }, [])

  const start = useCallback(async () => {
    const serial = c.serial
    if (!serial) return
    setError(null)
    setStatus('Starting…')
    setRunning(true)
    setStreaming(false)
    engineRef.current?.reset()
    playerRef.current?.reset()
    playerRef.current?.resume() // Start is a user gesture → unlock/resume audio
    const r = await window.androidlab.androidAuto.start(serial)
    if (!r.ok) {
      setError(r.message)
      setRunning(false)
    }
  }, [c.serial])

  const stop = useCallback(async () => {
    await window.androidlab.androidAuto.stop()
    setRunning(false)
    setStreaming(false)
    setStatus('Stopped.')
    engineRef.current?.reset()
    playerRef.current?.reset()
    micRef.current?.stop()
    setMicActive(false)
  }, [])

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      const next = !m
      playerRef.current?.setMuted(next)
      return next
    })
  }, [])

  const sendTouch = useCallback((action: number, e: React.PointerEvent<HTMLCanvasElement>) => {
    const eng = engineRef.current
    if (!eng) return
    const rect = e.currentTarget.getBoundingClientRect()
    const d = eng.toDevice(e.clientX - rect.left, e.clientY - rect.top)
    if (!d) return
    void window.androidlab.androidAuto.touch(action, d.x, d.y)
  }, [])

  return (
    <div className="aa-root">
      {/* Slim status bar only while a session is live — keeps the projection full-bleed. */}
      {streaming ? (
        <div className="aa-bar">
          <span className="aa-live-dot" />
          <span className={`aa-status${error ? ' err' : ''}`}>
            {error ? `⚠ ${error}` : status || 'Casting live — click or drag to control'}
          </span>
          {micActive ? (
            <span className="aa-mic-dot" title="Microphone live (Assistant is listening)">
              🎤
            </span>
          ) : null}
          <button className="aa-btn" onClick={toggleMute} title={muted ? 'Unmute' : 'Mute'}>
            {muted ? '🔇' : '🔊'}
          </button>
          <button className="aa-btn" onClick={stop}>
            Stop
          </button>
        </div>
      ) : null}

      <div className="aa-stage">
        <canvas
          ref={(el) => {
            canvasRef.current = el
            engineRef.current?.attach(el)
          }}
          className={`aa-canvas${streaming ? ' live' : ''}`}
          onPointerDown={(e) => {
            if (!streaming) return
            e.currentTarget.setPointerCapture(e.pointerId)
            pressing.current = true
            sendTouch(ACTION_DOWN, e)
          }}
          onPointerMove={(e) => {
            if (!streaming || !pressing.current) return
            sendTouch(ACTION_MOVE, e)
          }}
          onPointerUp={(e) => {
            if (!streaming || !pressing.current) return
            pressing.current = false
            sendTouch(ACTION_UP, e)
          }}
          onPointerCancel={(e) => {
            if (!pressing.current) return
            pressing.current = false
            sendTouch(ACTION_UP, e)
          }}
        />

        {!streaming ? (
          <div className="aa-placeholder">
            {running ? (
              <div className="aa-connecting">
                <div className="aa-spinner" />
                <div className="aa-connecting-msg">{status || 'Waiting for Android Auto to connect…'}</div>
                <button className="aa-btn" onClick={stop}>
                  Cancel
                </button>
              </div>
            ) : (
              <>
                <div className="aa-hero-icon">🚗</div>
                <div className="aa-hero-title">Android Auto head unit</div>
                <div className="aa-hero-desc">
                  Project the phone&apos;s Android Auto car UI onto this Mac and drive it with your
                  mouse. Make sure the phone and this Mac are on the <b>same Wi-Fi</b> and Android
                  Auto <b>developer mode</b> is on.
                </div>
                <button className="aa-start-btn" onClick={start} disabled={!c.serial}>
                  ▶  Start Android Auto
                </button>
                {!c.serial ? (
                  <div className="aa-hint-note">Select an Android device first.</div>
                ) : null}
                {error ? <div className="aa-err-note">⚠ {error}</div> : null}
              </>
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}
