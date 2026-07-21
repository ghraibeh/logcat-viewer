/**
 * Mac→Android screen-cast SENDER — the reverse of mlkmirror.ts. The renderer captures the
 * Mac screen (desktopCapturer) and H.264-encodes it with WebCodecs (Annex-B); this service
 * connects to the MobileLabKit Mirror Android app (running "Receive a screen", advertising
 * `_mlkmirror._tcp`) and streams the same wire protocol the Android caster uses:
 *
 *   header := "MLK1" + capW + capH + realW + realH   (big-endian int32s)
 *   unit   := len(int32) · kind(int8: 0=video, 1=config SPS/PPS) · payload
 *
 * The encoder hands us whole Annex-B chunks; we split each into its parameter-set NALs
 * (SPS/PPS → a KIND_CONFIG unit) and the rest (→ a KIND_VIDEO unit), because the Android
 * receiver configures its decoder from a dedicated config unit. We also re-send the cached
 * SPS/PPS ahead of any keyframe that arrived without them, so the receiver can always
 * (re)configure — the same "self-arming keyframe" guarantee the receiver side relies on.
 * Video-only for now (no audio, no reverse touch).
 */
import { Socket } from 'node:net'
import { MlkBrowser, type DiscoveredReceiver } from './mlkmdns'

const MAGIC = Buffer.from('MLK1', 'ascii')
const KIND_VIDEO = 0
const KIND_CONFIG = 1

export interface MlkCastCallbacks {
  onState: (state: { message: string; casting: boolean }) => void
  onFailed: (message: string) => void
}

/** Split an Annex-B buffer into its parameter-set NALs (SPS type 7 / PPS type 8) and the
 *  rest (slices), keeping each NAL's start code. Either side may be null. */
function splitAnnexB(buf: Buffer): { config: Buffer | null; video: Buffer | null } {
  // Byte offsets of every `00 00 01` start-code prefix (covers 3- and 4-byte codes).
  const sc: number[] = []
  for (let i = 0; i + 2 < buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) sc.push(i)
  }
  if (sc.length === 0) return { config: null, video: buf.length ? buf : null }
  const cfg: Buffer[] = []
  const vid: Buffer[] = []
  for (let k = 0; k < sc.length; k++) {
    const start = sc[k]
    const end = k + 1 < sc.length ? sc[k + 1] : buf.length
    const type = buf[start + 3] & 0x1f // NAL header byte follows the 00 00 01
    const nal = buf.subarray(start, end)
    if (type === 7 || type === 8) cfg.push(nal)
    else vid.push(nal)
  }
  return {
    config: cfg.length ? Buffer.concat(cfg) : null,
    video: vid.length ? Buffer.concat(vid) : null
  }
}

export class MlkCastService {
  private sock: Socket | null = null
  private connected = false
  private lastConfig: Buffer | null = null
  private browser: MlkBrowser | null = null

  constructor(private readonly cb: MlkCastCallbacks) {}

  /** Browse the LAN for phones in "Receive a screen" mode (advertising _mlkmirror._tcp). */
  startBrowse(onList: (list: DiscoveredReceiver[]) => void): void {
    if (!this.browser) this.browser = new MlkBrowser()
    this.browser.start(onList)
  }

  stopBrowse(): void {
    this.browser?.stop()
    this.browser = null
  }

  /** Connect to a receiver and send the stream header. Resolves true on success. */
  connect(host: string, port: number, width: number, height: number): Promise<boolean> {
    this.stop()
    return new Promise((resolve) => {
      const sock = new Socket()
      sock.setNoDelay(true)
      let settled = false
      const fail = (message: string): void => {
        if (settled) return
        settled = true
        this.cb.onFailed(message)
        try {
          sock.destroy()
        } catch {
          /* ignore */
        }
        if (this.sock === sock) this.sock = null
        resolve(false)
      }
      sock.once('error', (e: NodeJS.ErrnoException) =>
        fail(`Couldn't connect to ${host}:${port} — ${e.message}`)
      )
      sock.connect(port, host, () => {
        if (settled) return
        settled = true
        this.sock = sock
        this.connected = true
        this.lastConfig = null
        // header: MLK1 + capW capH realW realH. realW/H mirror capW/H (no reverse-touch target).
        const header = Buffer.alloc(4 + 16)
        MAGIC.copy(header, 0)
        header.writeInt32BE(width, 4)
        header.writeInt32BE(height, 8)
        header.writeInt32BE(width, 12)
        header.writeInt32BE(height, 16)
        try {
          sock.write(header)
        } catch (e) {
          return fail(`Couldn't send header: ${e instanceof Error ? e.message : String(e)}`)
        }
        console.log(`[mlk-cast] streaming ${width}x${height} to ${host}:${port}`)
        this.cb.onState({ message: `Casting to ${host}`, casting: true })
        resolve(true)
      })
      sock.on('close', () => {
        if (this.sock !== sock) return
        this.sock = null
        this.connected = false
        this.cb.onState({ message: 'Cast ended — the receiver closed the connection.', casting: false })
      })
    })
  }

  /** Frame + write one encoded Annex-B chunk. */
  push(chunk: Uint8Array, key: boolean): void {
    const sock = this.sock
    if (!sock || !this.connected || sock.destroyed) return
    const buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    const { config, video } = splitAnnexB(buf)
    try {
      if (config) {
        this.lastConfig = config
        this.writeUnit(sock, config, KIND_CONFIG)
      } else if (key && this.lastConfig) {
        // Keyframe without inline SPS/PPS → re-arm it so the receiver can (re)configure.
        this.writeUnit(sock, this.lastConfig, KIND_CONFIG)
      }
      if (video) this.writeUnit(sock, video, KIND_VIDEO)
    } catch {
      /* socket went away between the check and the write */
    }
  }

  private writeUnit(sock: Socket, payload: Buffer, kind: number): void {
    const head = Buffer.alloc(5)
    head.writeInt32BE(payload.length, 0)
    head.writeInt8(kind, 4)
    sock.write(head)
    sock.write(payload)
  }

  stop(): void {
    if (this.sock) {
      try {
        this.sock.destroy()
      } catch {
        /* already gone */
      }
      this.sock = null
    }
    this.connected = false
    this.lastConfig = null
  }

  shutdown(): void {
    this.stopBrowse()
    this.stop()
  }
}
