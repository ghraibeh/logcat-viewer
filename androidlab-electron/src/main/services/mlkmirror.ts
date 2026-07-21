/**
 * Android→Mac screen-mirror RECEIVER. This Mac advertises a private `_mlkmirror._tcp`
 * service over mDNS and runs a TCP server; the "MobileLabKit Mirror" Android app
 * (../../../android-mirror) casts its screen + audio to us. We parse the tiny wire
 * protocol and hand H.264 (Annex-B) and PCM up to the renderer, which decodes/plays them
 * — reusing the same AnnexBDemuxer + WebCodecs path as the iOS/AirPlay mirrors.
 *
 * Wire format (MirrorProtocol.kt): header `"MLK1" + capW + capH + realW + realH`
 * (big-endian int32s), then units `len(int32) · kind(int8) · payload`, kind 0=video,
 * 1=config(SPS/PPS), 2=audio(48kHz stereo 16-bit PCM). Video + config are both Annex-B
 * NALs, so both go to onH264 in order; the demuxer reconstructs the stream. View-only
 * for now (the protocol has a reverse touch channel we don't drive yet). Same service
 * shape as iosairplay.ts: runToken guards stale async, start/stop/shutdown.
 */
import { createServer, type Server, type Socket } from 'node:net'
import type { MlkMirrorState } from '@shared/types'
import { MlkAdvertiser } from './mlkmdns'
import { deviceLabel } from '../deviceName'

const MAGIC = Buffer.from('MLK1', 'ascii')
const HEADER_LEN = 4 + 16 // magic + capW,capH,realW,realH
const DEFAULT_PORT = 8899
const KIND_VIDEO = 0
const KIND_CONFIG = 1
const KIND_AUDIO = 2
const MAX_UNIT = 8 << 20

export interface MlkMirrorCallbacks {
  onH264: (chunk: Uint8Array) => void
  onPcm: (chunk: Uint8Array) => void
  onState: (state: MlkMirrorState) => void
  onFailed: (message: string) => void
}


/** Reassembles the framed TCP stream into header + units. */
class FrameParser {
  private buf: Buffer = Buffer.alloc(0)
  private gotHeader = false

  constructor(
    private readonly onUnit: (kind: number, payload: Buffer) => void,
    private readonly onError: (message: string) => void
  ) {}

  push(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    if (!this.gotHeader) {
      if (this.buf.length < HEADER_LEN) return
      if (!this.buf.subarray(0, 4).equals(MAGIC)) {
        this.onError('Not a MobileLabKit Mirror stream (bad header).')
        return
      }
      this.buf = this.buf.subarray(HEADER_LEN) // capW/capH/realW/realH are advisory
      this.gotHeader = true
    }
    // units: len(int32) + kind(int8) + payload(len)
    while (this.buf.length >= 5) {
      const len = this.buf.readInt32BE(0)
      if (len <= 0 || len > MAX_UNIT) {
        this.onError(`Bad unit length ${len}.`)
        return
      }
      if (this.buf.length < 5 + len) break // wait for the rest of this unit
      const kind = this.buf.readInt8(4)
      // Copy out now — the backing buffer is reassigned on the next line / next push.
      this.onUnit(kind, Buffer.from(this.buf.subarray(5, 5 + len)))
      this.buf = this.buf.subarray(5 + len)
    }
  }
}

export class MlkMirrorService {
  private server: Server | null = null
  private sock: Socket | null = null
  private readonly advertiser = new MlkAdvertiser()
  private runToken = 0
  private name = ''
  private connected = false

  constructor(private readonly cb: MlkMirrorCallbacks) {}

  /** Start advertising + listening. Returns the receiver name the phone will see. */
  start(): string {
    this.stop()
    const token = ++this.runToken
    this.name = deviceLabel()
    const server = createServer((sock) => this.onConnection(sock, token))
    this.server = server
    server.on('error', (e: NodeJS.ErrnoException) => {
      if (token !== this.runToken) return
      if (e.code === 'EADDRINUSE') {
        // Fixed port taken — fall back to an ephemeral one (advertised via mDNS anyway).
        server.listen(0, '0.0.0.0', () => this.onListening(token))
      } else {
        this.cb.onFailed(`Mirror receiver could not start: ${e.message}`)
      }
    })
    server.listen(DEFAULT_PORT, '0.0.0.0', () => this.onListening(token))
    return this.name
  }

  private onListening(token: number): void {
    if (token !== this.runToken || !this.server) return
    const addr = this.server.address()
    const port = typeof addr === 'object' && addr ? addr.port : DEFAULT_PORT
    this.advertiser.start(this.name, port, { v: '1' })
    this.cb.onState({
      name: this.name,
      message: `Waiting — on the phone, open MobileLabKit Mirror ▸ Cast, pick “${this.name}”.`,
      waiting: true
    })
  }

  private onConnection(sock: Socket, token: number): void {
    if (token !== this.runToken) {
      sock.destroy()
      return
    }
    if (this.sock) {
      // One caster at a time — drop the previous.
      try {
        this.sock.destroy()
      } catch {
        /* gone */
      }
    }
    this.sock = sock
    this.connected = false
    sock.setNoDelay(true)
    const parser = new FrameParser(
      (kind, payload) => {
        if (token !== this.runToken) return
        if (!this.connected) {
          this.connected = true
          this.cb.onState({ name: this.name, message: 'Casting live', waiting: false })
        }
        if (kind === KIND_VIDEO || kind === KIND_CONFIG) this.cb.onH264(new Uint8Array(payload))
        else if (kind === KIND_AUDIO) this.cb.onPcm(new Uint8Array(payload))
      },
      (message) => {
        if (token === this.runToken) this.cb.onFailed(message)
        sock.destroy()
      }
    )
    sock.on('data', (chunk: Buffer) => {
      if (token === this.runToken) parser.push(chunk)
    })
    const onEnd = (): void => {
      if (token !== this.runToken) return
      if (this.sock === sock) this.sock = null
      this.connected = false
      this.cb.onState({
        name: this.name,
        message: `Ended — waiting for a phone to cast to “${this.name}”.`,
        waiting: true
      })
    }
    sock.on('close', onEnd)
    sock.on('error', onEnd)
  }

  /** Stop advertising + close any active stream. Idempotent. */
  stop(): void {
    this.runToken++
    this.advertiser.stop()
    if (this.sock) {
      try {
        this.sock.destroy()
      } catch {
        /* gone */
      }
      this.sock = null
    }
    if (this.server) {
      try {
        this.server.close()
      } catch {
        /* not listening */
      }
      this.server = null
    }
    this.connected = false
  }

  shutdown(): void {
    this.stop()
  }
}
