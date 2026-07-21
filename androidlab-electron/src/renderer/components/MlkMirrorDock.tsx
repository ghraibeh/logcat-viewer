/**
 * Android→Mac mirror RECEIVER dock. The main process (services/mlkmirror.ts) advertises
 * `_mlkmirror._tcp` and runs a TCP server; the MobileLabKit Mirror Android app casts to
 * it. This decodes the incoming Annex-B H.264 with WebCodecs (same AnnexBDemuxer path as
 * the iOS/scrcpy mirrors) and plays the 48kHz stereo PCM audio via Web Audio — the one
 * mirror whose audio arrives as data (the iOS/AirPlay helpers play audio natively).
 * View-only for now. Full-screen canvas + a waiting card showing the receiver name.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { AnnexBDemuxer } from '@core/mirror'
import type { MlkMirrorState } from '@shared/types'
import { Icon } from './Icon'
import { AppQr } from './AppQr'

const HAS_WEBCODECS = typeof (globalThis as { VideoDecoder?: unknown }).VideoDecoder !== 'undefined'
const MAX_DECODE_QUEUE = 6
// Input still arriving but no decoded frame for this long ⇒ the decoder wedged; rebuild it.
const STALL_MS = 2000

/** Canvas + WebCodecs decoder for the Annex-B feed. Android MediaCodec H.264 is
 *  limited-range like the iOS USB path, so no full-range colour correction is needed. */
class VideoView {
  private canvas: HTMLCanvasElement | null = null
  private demuxer = new AnnexBDemuxer()
  private decoder: VideoDecoder | null = null
  private configured = false
  private lastSpsGen = -1
  private ts = 0
  private pending: VideoFrame | null = null
  private raf = 0
  private running = false
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private lastDecodeMs = 0
  private lastOutputMs = 0
  private errCount = 0
  private errWindow = 0
  onFail: ((m: string) => void) | null = null
  onFirstFrame: (() => void) | null = null

  attach(canvas: HTMLCanvasElement | null): void {
    this.canvas = canvas
    if (this.running) return
    this.running = true
    const tick = (): void => {
      if (!this.running) return
      this.paint()
      this.raf = requestAnimationFrame(tick)
    }
    this.raf = requestAnimationFrame(tick)
  }

  push(chunk: Uint8Array): void {
    if (!HAS_WEBCODECS) return
    // Watchdog: bytes still arriving but the decoder stopped emitting frames → it wedged
    // (lost sync, or bound state went bad). Rebuild it; the next keyframe now carries its
    // SPS/PPS (demuxer re-arm), so it resyncs within ~1s instead of freezing for good.
    const now = performance.now()
    if (this.configured && this.lastDecodeMs && now - this.lastOutputMs > STALL_MS && now - this.lastDecodeMs < STALL_MS) {
      this.recover('decode stalled')
    }
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
        error: (e) => this.recover(e.message || 'decode error')
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
    if (this.configured && dec.decodeQueueSize > MAX_DECODE_QUEUE) {
      try {
        dec.reset()
      } catch {
        /* ignore */
      }
      this.configured = false
      return // resync on the next keyframe
    }
    if (!this.configured) {
      const codec = this.demuxer.codecString()
      if (!key || !codec) return // wait for a keyframe + its SPS
      try {
        dec.configure({ codec, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' })
        this.configured = true
        this.lastOutputMs = performance.now() // arm the stall watchdog from configure time
      } catch (e) {
        this.recover(e instanceof Error ? e.message : String(e))
        return
      }
    }
    try {
      dec.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: this.ts, data }))
      this.ts += 33333
      this.lastDecodeMs = performance.now()
    } catch (e) {
      this.recover(e instanceof Error ? e.message : String(e))
    }
  }

  private setPending(frame: VideoFrame): void {
    if (this.pending) {
      try {
        this.pending.close()
      } catch {
        /* already closed */
      }
    }
    this.pending = frame
    this.lastOutputMs = performance.now()
    if (this.onFirstFrame) {
      this.onFirstFrame()
      this.onFirstFrame = null
    }
  }

  private paint(): void {
    const frame = this.pending
    if (!frame) return
    this.pending = null
    const canvas = this.canvas
    if (canvas) {
      const parent = canvas.parentElement
      const cw = parent?.clientWidth ?? frame.displayWidth
      const ch = parent?.clientHeight ?? frame.displayHeight
      const dpr = window.devicePixelRatio || 1
      if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
        canvas.width = Math.round(cw * dpr)
        canvas.height = Math.round(ch * dpr)
      }
      const ctx = canvas.getContext('2d')
      if (ctx) {
        const sw = frame.displayWidth
        const sh = frame.displayHeight
        const scale = Math.min(canvas.width / sw, canvas.height / sh)
        const w = sw * scale
        const h = sh * scale
        const x = (canvas.width - w) / 2
        const y = (canvas.height - h) / 2
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        try {
          ctx.drawImage(frame, x, y, w, h)
        } catch {
          /* frame not drawable */
        }
      }
    }
    try {
      frame.close()
    } catch {
      /* already closed */
    }
  }

  /** Transient decode error / stall: tear the decoder down and resync at the next keyframe
   *  (self-decodable now that the demuxer re-arms keyframes with SPS/PPS). Only surface a hard
   *  failure if errors storm, i.e. the stream is genuinely unrecoverable. */
  private recover(reason: string): void {
    try {
      this.decoder?.close()
    } catch {
      /* already closed */
    }
    this.decoder = null
    this.configured = false
    this.lastDecodeMs = 0
    const now = performance.now()
    if (now - this.errWindow > 5000) {
      this.errWindow = now
      this.errCount = 0
    }
    if (++this.errCount > 10) this.fail(reason)
  }

  private fail(m: string): void {
    this.onFail?.(m)
  }

  destroy(): void {
    this.running = false
    if (this.raf) cancelAnimationFrame(this.raf)
    if (this.flushTimer) clearTimeout(this.flushTimer)
    if (this.pending) {
      try {
        this.pending.close()
      } catch {
        /* ignore */
      }
      this.pending = null
    }
    if (this.decoder && this.decoder.state !== 'closed') {
      try {
        this.decoder.close()
      } catch {
        /* ignore */
      }
    }
    this.decoder = null
  }
}

/** Plays raw 48kHz stereo 16-bit interleaved PCM by scheduling AudioBuffers back-to-back. */
class PcmPlayer {
  private ctx: AudioContext | null = null
  private gain: GainNode | null = null
  private nextTime = 0
  private muted = false
  private readonly rate = 48000
  private readonly channels = 2

  push(bytes: Uint8Array): void {
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: this.rate })
      this.gain = this.ctx.createGain()
      this.gain.gain.value = this.muted ? 0 : 1
      this.gain.connect(this.ctx.destination)
      this.nextTime = 0
    }
    const ctx = this.ctx
    const gain = this.gain!
    // Copy to guarantee 2-byte alignment for the Int16 view.
    const copy = bytes.slice()
    const i16 = new Int16Array(copy.buffer, copy.byteOffset, copy.byteLength >> 1)
    const frames = Math.floor(i16.length / this.channels)
    if (frames === 0) return
    const buf = ctx.createBuffer(this.channels, frames, this.rate)
    const l = buf.getChannelData(0)
    const r = buf.getChannelData(1)
    for (let i = 0; i < frames; i++) {
      l[i] = i16[i * 2] / 32768
      r[i] = i16[i * 2 + 1] / 32768
    }
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.connect(gain)
    const now = ctx.currentTime
    // If we've fallen behind (underrun) resync with a small buffer to stay live.
    if (this.nextTime < now + 0.02) this.nextTime = now + 0.06
    src.start(this.nextTime)
    this.nextTime += buf.duration
  }

  setMuted(m: boolean): void {
    this.muted = m
    if (this.gain) this.gain.gain.value = m ? 0 : 1
  }

  close(): void {
    if (this.ctx) {
      this.ctx.close().catch(() => {})
      this.ctx = null
      this.gain = null
    }
  }
}

export function MlkMirrorDock({ onClose }: { onClose: () => void }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const videoRef = useRef<VideoView | null>(null)
  const audioRef = useRef<PcmPlayer | null>(null)
  const [state, setState] = useState<MlkMirrorState>({
    name: '',
    message: 'Starting receiver…',
    waiting: true
  })
  const [muted, setMuted] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const video = new VideoView()
    const audio = new PcmPlayer()
    videoRef.current = video
    audioRef.current = audio
    video.onFail = (m) => setError(m)
    video.attach(canvasRef.current)

    const offH264 = window.androidlab.mlkMirror.onH264((chunk) => video.push(chunk))
    const offPcm = window.androidlab.mlkMirror.onPcm((chunk) => audio.push(chunk))
    const offState = window.androidlab.mlkMirror.onState((s) => setState(s))
    const offFailed = window.androidlab.mlkMirror.onFailed((m) => setError(m))

    void window.androidlab.mlkMirror.start().then((name) => {
      if (name) setState((s) => ({ ...s, name }))
    })

    return () => {
      offH264()
      offPcm()
      offState()
      offFailed()
      void window.androidlab.mlkMirror.stop()
      video.destroy()
      audio.close()
      videoRef.current = null
      audioRef.current = null
    }
  }, [])

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      const next = !m
      audioRef.current?.setMuted(next)
      return next
    })
  }, [])

  const live = !state.waiting && !error
  return (
    <div className="mlk-mirror-dock">
      <div className="mlk-mirror-rail">
        <span className="mlk-mirror-title">
          <Icon name="receiveScreen" size={14} /> Android Mirror
        </span>
        <span className="mlk-mirror-name" title="Pick this in the phone's Cast list">
          {state.name || '…'}
        </span>
        <span className="mlk-mirror-spacer" />
        <button
          className={`toggle${muted ? ' active' : ''}`}
          title={muted ? 'Unmute' : 'Mute'}
          onClick={toggleMute}
        >
          <Icon name={muted ? 'muted' : 'sound'} size={15} />
        </button>
        <button className="toggle" title="Stop receiving" onClick={onClose}>
          <Icon name="close" size={15} />
        </button>
      </div>
      <div className="mlk-mirror-body">
        <canvas ref={canvasRef} className="mlk-mirror-canvas" style={{ display: live ? 'block' : 'none' }} />
        {!live &&
          (error ? (
            <div className="mlk-cast-scroll" style={{ width: '100%' }}>
              <div className="mlk-cast-hero" style={{ color: 'var(--red)', background: 'color-mix(in srgb, var(--red) 16%, transparent)', boxShadow: '0 0 0 1px color-mix(in srgb, var(--red) 35%, transparent) inset' }}>
                <Icon name="alertTriangle" size={28} />
              </div>
              <div>
                <div className="mlk-cast-title">Couldn’t receive</div>
                <div className="mlk-cast-sub" style={{ marginTop: 5 }}>{error}</div>
              </div>
            </div>
          ) : (
            <div className="mlk-cast-scroll" style={{ width: '100%' }}>
              <div className="mlk-cast-hero searching">
                <Icon name="android" size={30} />
              </div>
              <div>
                <div className="mlk-cast-title">Cast an Android phone here</div>
                <div className="mlk-cast-sub" style={{ marginTop: 5 }}>
                  Show an Android phone’s screen on this Mac over Wi-Fi.
                </div>
              </div>
              <div className="mlk-cast-steps">
                <div className="mlk-cast-step">
                  <span className="mlk-cast-step-n">1</span>
                  <span>Open <b>MobileLabKit Mirror</b> on your phone</span>
                </div>
                <div className="mlk-cast-step">
                  <span className="mlk-cast-step-n">2</span>
                  <span>Tap <b>Cast this screen</b></span>
                </div>
                <div className="mlk-cast-step">
                  <span className="mlk-cast-step-n">3</span>
                  <span>Pick <b>{state.name || 'this Mac'}</b></span>
                </div>
              </div>
              <div className="mlk-cast-searching">
                <span className="mlk-cast-dots">
                  <i />
                  <i />
                  <i />
                </span>
                Waiting for a phone…
              </div>
              <AppQr />
            </div>
          ))}
      </div>
    </div>
  )
}
