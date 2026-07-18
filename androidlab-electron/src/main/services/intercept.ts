/**
 * Network Intercept engine — the two-tier proxy of intercept.py, reimplemented
 * natively in Node (no external mitmproxy, no Python).
 *
 *  Tier 1 — a built-in TCP proxy on 127.0.0.1:port (net.createServer). Plain
 *  HTTP is captured in full (method/url/headers/bodies, framing-preserving relay
 *  of chunked / content-length / read-until-EOF); CONNECT is blind-tunnelled
 *  (SNI sniffed, metadata-only flow). Faithful port of serve / _handle_http /
 *  _handle_connect / _relay_body.
 *
 *  Tier 2 — HTTPS decryption via a native TLS-MITM (node-forge). A self-signed
 *  root CA is generated + persisted on first use; per-host leaf certs are minted
 *  on demand and cached; the client connection is TLS-terminated (ALPN pinned to
 *  http/1.1), the decrypted inner HTTP relayed to an upstream TLS connection,
 *  bodies captured. A pinned/untrusting app that rejects our cert is remembered
 *  and its connections fall back to a blind byte relay so it stays online.
 *
 * Device wiring is pluggable via DeviceWiring so ONE proxy/MITM engine serves
 * both platforms. AndroidWiring (below) is the adb path — CLAUDE.md hard rule #3:
 * the device's original http_proxy is snapshotted before wiring and restored on
 * EVERY exit path; a device-side watchdog (held-open adb shell trapping SIGHUP)
 * self-heals the proxy if the link drops without a clean teardown. IosWiring
 * (services/interceptIos.ts) is the go-ios path: the CA ships as a config profile
 * and the device is pointed at the Mac's LAN proxy manually (non-supervised iOS
 * can't be force-proxied). shutdown() unwires + kills the server.
 */
import net from 'node:net'
import tls from 'node:tls'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Duplex, Writable } from 'node:stream'
import { app } from 'electron'
import forge from 'node-forge'
import { run } from './adb'
import {
  DEFAULT_PORT,
  MAX_BODY,
  FLOW_CAP,
  PEEK_BYTES,
  RELAY_CHUNK,
  STREAM_LIMIT,
  getProxyArgs,
  headerGet,
  makeFlow,
  parseHead,
  parseSni,
  parseStatus,
  proxyWatchdogScript,
  restoreProxyArgs,
  reverseArgs,
  reverseRemoveArgs,
  setProxyArgs,
  splitUrl,
  toDisplayFlow,
  type DisplayFlow,
  type Flow
} from '@core/intercept'
import { buildFlowExport, decodeBody, flowToCurl, prettyBody } from '@core/interceptBody'
import type { SaveResult } from '@shared/types'

const FLOW_FLUSH_MS = 100
const TRIM_CHUNK = 500
const CRLFCRLF = Buffer.from('\r\n\r\n')
const LF = Buffer.from('\n')

export interface InterceptCallbacks {
  onFlows: (flows: DisplayFlow[]) => void
  onStarted: (port: number) => void
  onStatus: (message: string) => void
  onFailed: (message: string) => void
}

/** Presentation payload for the detail pane (decoded/pretty, curl included). */
export interface FlowDetailData {
  found: boolean
  url: string
  method: string
  scheme: string
  status: number | null
  durationMs: number | null
  respSize: number
  bodyCaptured: boolean
  note: string
  reqHeaders: Array<[string, string]>
  respHeaders: Array<[string, string]>
  reqBody: string
  respBody: string
  reqIsJson: boolean
  respIsJson: boolean
  curl: string
}

export interface CertPushResult {
  ok: boolean
  message: string
  dir: string
}

/** Host CA material handed to a wiring so it can deliver the cert to the device. */
export interface CaMaterial {
  certPath: string
  certPem: string
  certDerBase64: string
}

/** Callbacks a wiring uses to surface a status line / a device drop to the engine. */
export interface WiringCallbacks {
  onStatus: (message: string) => void
  onDisconnect: () => void
}

/**
 * Per-platform device wiring — everything that differs between routing an Android
 * device (adb reverse + global http_proxy + watchdog) and an iOS device (a CA
 * config profile + a manual Wi-Fi proxy to the Mac). The proxy/MITM engine
 * (InterceptService) is platform-agnostic and drives a DeviceWiring.
 */
export interface DeviceWiring {
  readonly serial: string
  /** Interface the proxy binds to: loopback (Android reverse tunnel) vs all
   *  interfaces (iOS reaches the Mac over the LAN). */
  readonly bindHost: string
  /** Whether the engine auto-installs the CA on start (Android), or leaves it to
   *  the explicit button (iOS — the user must also approve + trust it on-device). */
  readonly autoInstallCertOnStart: boolean
  /** Route the device through the host proxy on `port`. A non-empty `message` is
   *  shown after "Intercept on" (e.g. the iOS manual-proxy instruction). */
  wire(port: number): Promise<{ ok: boolean; message: string }>
  /** Undo the wiring (best-effort; must never strand the device). */
  unwire(): void
  /** Deliver the CA to the device (Android: push .crt + open Settings; iOS:
   *  install the mobileconfig via go-ios). */
  installCert(ca: CaMaterial): Promise<CertPushResult>
}

function safeDestroy(s: Duplex | undefined | null): void {
  try {
    if (s && !s.destroyed) s.destroy()
  } catch {
    /* ignore */
  }
}

/** Write a buffer, awaiting drain on backpressure; resolves on close/error too. */
function writeAsync(dst: Writable, buf: Buffer): Promise<void> {
  if (!buf || buf.length === 0 || dst.destroyed || !dst.writable) return Promise.resolve()
  return new Promise<void>((resolve) => {
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      dst.off('drain', finish)
      dst.off('close', finish)
      dst.off('error', finish)
      resolve()
    }
    const ok = dst.write(buf)
    if (ok) {
      finish()
      return
    }
    dst.once('drain', finish)
    dst.once('close', finish)
    dst.once('error', finish)
  })
}

/** Resolve on `event`; reject on 'error' or after `timeoutMs`. */
function onceWithTimeout(emitter: Duplex, event: string, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer)
      emitter.off(event, onOk)
      emitter.off('error', onErr)
    }
    const onOk = (): void => {
      cleanup()
      resolve()
    }
    const onErr = (e: Error): void => {
      cleanup()
      reject(e)
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('timeout'))
    }, timeoutMs)
    emitter.once(event, onOk)
    emitter.once('error', onErr)
  })
}

/**
 * Async buffered reader over a Duplex — the Node analogue of asyncio's
 * StreamReader used by _read_head / _readexactly / _relay_body.
 */
class StreamReader {
  private chunks: Buffer[] = []
  private size = 0
  private ended = false
  private waiter: (() => void) | null = null

  private readonly onData = (c: Buffer): void => {
    this.chunks.push(c)
    this.size += c.length
    this.wake()
  }
  private readonly onEnd = (): void => {
    this.ended = true
    this.wake()
  }

  constructor(private readonly stream: Duplex) {
    stream.on('data', this.onData)
    stream.on('end', this.onEnd)
    stream.on('close', this.onEnd)
    stream.on('error', this.onEnd)
  }

  private wake(): void {
    const w = this.waiter
    this.waiter = null
    if (w) w()
  }
  private wait(): Promise<void> {
    return new Promise<void>((res) => {
      this.waiter = res
    })
  }
  private merged(): Buffer {
    if (this.chunks.length === 0) return Buffer.alloc(0)
    if (this.chunks.length > 1) this.chunks = [Buffer.concat(this.chunks)]
    return this.chunks[0]
  }
  private take(n: number): Buffer {
    const b = this.merged()
    const cut = Math.min(n, b.length)
    const out = Buffer.from(b.subarray(0, cut))
    this.chunks = cut < b.length ? [Buffer.from(b.subarray(cut))] : []
    this.size -= cut
    return out
  }

  /** Bytes up to AND including `delim`; on EOF / over `limit` returns what's buffered. */
  async readUntil(delim: Buffer, limit: number): Promise<Buffer> {
    for (;;) {
      const b = this.merged()
      const idx = b.indexOf(delim)
      if (idx >= 0) return this.take(idx + delim.length)
      if (this.ended || this.size > limit) return this.take(this.size)
      await this.wait()
    }
  }
  /** Exactly `n` bytes, or the remainder on EOF (mirrors _readexactly's partial). */
  async readExactly(n: number): Promise<Buffer> {
    while (this.size < n && !this.ended) await this.wait()
    return this.take(n)
  }
  /** One line incl. the trailing LF, or '' on EOF (mirrors StreamReader.readline). */
  async readLine(): Promise<Buffer> {
    return this.readUntil(LF, STREAM_LIMIT)
  }
  /** Up to `n` bytes (waits for at least one), '' on EOF (mirrors reader.read(n)). */
  async read(n: number): Promise<Buffer> {
    while (this.size === 0 && !this.ended) await this.wait()
    return this.take(n)
  }
  /** Detach listeners and return any buffered leftover (for CONNECT hand-off). */
  detach(): Buffer {
    this.stream.off('data', this.onData)
    this.stream.off('end', this.onEnd)
    this.stream.off('close', this.onEnd)
    this.stream.off('error', this.onEnd)
    const leftover = this.merged()
    this.chunks = []
    this.size = 0
    return leftover
  }
}

/**
 * Relay a message body from `reader` to `dst` verbatim (framing preserved),
 * capturing up to `cap` bytes. Faithful port of _relay_body.
 */
async function relayBody(
  reader: StreamReader,
  dst: Writable,
  headers: ReadonlyArray<readonly [string, string]>,
  cap: number,
  readUntilEof: boolean
): Promise<{ size: number; body: Buffer; truncated: boolean }> {
  const te = (headerGet(headers, 'Transfer-Encoding') || '').toLowerCase()
  const cl = headerGet(headers, 'Content-Length')
  const captured: Buffer[] = []
  let capLen = 0
  let total = 0
  let truncated = false
  const capBytes = (chunk: Buffer): void => {
    if (capLen < cap) {
      const room = cap - capLen
      const slice = chunk.subarray(0, room)
      captured.push(Buffer.from(slice))
      capLen += slice.length
      if (chunk.length > room) truncated = true
    }
  }
  try {
    if (te.includes('chunked')) {
      for (;;) {
        const sizeLine = await reader.readLine()
        if (sizeLine.length === 0) break
        await writeAsync(dst, sizeLine)
        const hexStr = sizeLine.toString('latin1').split(';')[0].trim() || '0'
        if (!/^[0-9a-fA-F]+$/.test(hexStr)) break
        const size = parseInt(hexStr, 16)
        if (size === 0) {
          // relay trailers up to the blank line
          for (;;) {
            const t = await reader.readLine()
            if (t.length === 0) break
            await writeAsync(dst, t)
            const s = t.toString('latin1')
            if (s === '\r\n' || s === '\n') break
          }
          break
        }
        const chunk = await reader.readExactly(size)
        await writeAsync(dst, chunk)
        await writeAsync(dst, await reader.readExactly(2)) // trailing CRLF
        total += chunk.length
        capBytes(chunk)
      }
    } else if (cl !== null && /^\d+$/.test(cl.trim())) {
      let remaining = parseInt(cl.trim(), 10)
      while (remaining > 0) {
        const chunk = await reader.read(Math.min(RELAY_CHUNK, remaining))
        if (chunk.length === 0) break
        remaining -= chunk.length
        total += chunk.length
        await writeAsync(dst, chunk)
        capBytes(chunk)
      }
    } else if (readUntilEof) {
      for (;;) {
        const chunk = await reader.read(RELAY_CHUNK)
        if (chunk.length === 0) break
        total += chunk.length
        await writeAsync(dst, chunk)
        capBytes(chunk)
      }
    }
  } catch {
    /* ignore — best-effort relay */
  }
  return { size: total, body: Buffer.concat(captured), truncated }
}

/** Blindly copy src → dst until EOF, returning bytes moved (mirrors _pump). */
function pump(src: Duplex, dst: Duplex): Promise<number> {
  return new Promise<number>((resolve) => {
    let total = 0
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      src.off('data', onData)
      dst.off('drain', onDrain)
      src.off('end', finish)
      src.off('close', finish)
      src.off('error', finish)
      try {
        if (dst.writable && !dst.destroyed) dst.end()
      } catch {
        /* ignore */
      }
      resolve(total)
    }
    const onData = (c: Buffer): void => {
      total += c.length
      if (!dst.write(c)) src.pause()
    }
    const onDrain = (): void => {
      src.resume()
    }
    src.on('data', onData)
    dst.on('drain', onDrain)
    src.on('end', finish)
    src.on('close', finish)
    src.on('error', finish)
  })
}

/** Peek the first chunk (up to PEEK_BYTES) then pause; '' on timeout/EOF. */
function peekSocket(socket: net.Socket, timeoutMs: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve) => {
    let done = false
    const finish = (buf: Buffer): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('end', onEnd)
      socket.off('error', onEnd)
      socket.pause()
      resolve(buf)
    }
    const onData = (c: Buffer): void => finish(c.subarray(0, PEEK_BYTES))
    const onEnd = (): void => finish(Buffer.alloc(0))
    const timer = setTimeout(() => finish(Buffer.alloc(0)), timeoutMs)
    socket.on('data', onData)
    socket.on('end', onEnd)
    socket.on('error', onEnd)
  })
}

export class InterceptService {
  private server: net.Server | null = null
  private running = false
  private decrypt = false
  private wiring: DeviceWiring | null = null
  private activePort = DEFAULT_PORT

  private idCounter = 0
  private readonly flows: Flow[] = []
  private readonly flowMap = new Map<number, Flow>()
  private pending: DisplayFlow[] = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  // Tier-2 CA + per-host leaf material (all lazy — nothing at construction).
  private ca: {
    cert: forge.pki.Certificate
    key: forge.pki.rsa.PrivateKey
    certPem: string
    keyPem: string
  } | null = null
  private leafKeys: forge.pki.rsa.KeyPair | null = null
  private readonly ctxCache = new Map<string, tls.SecureContext>()
  private readonly pinnedHosts = new Set<string>()

  constructor(
    private readonly wiringFor: (serial: string) => DeviceWiring | null,
    private readonly cb: InterceptCallbacks
  ) {}

  // --- lifecycle ------------------------------------------------------------
  /** Wire the device + bind the proxy. Emits onStarted / onFailed / onStatus. */
  async start(serial: string, port: number, decrypt: boolean): Promise<void> {
    if (this.running) this.stop()
    this.decrypt = decrypt
    this.activePort = port

    const wiring = this.wiringFor(serial)
    if (!wiring) {
      this.cb.onFailed('No adb / go-ios backend for this device')
      return
    }
    this.wiring = wiring

    // 1) wire the device (Android: reverse + proxy + watchdog; iOS: manual-proxy hint).
    let wired: { ok: boolean; message: string }
    try {
      wired = await wiring.wire(port)
    } catch (e) {
      this.wiring = null
      this.cb.onFailed(`device wiring failed: ${e instanceof Error ? e.message : String(e)}`)
      return
    }
    if (!wired.ok) {
      this.wiring = null
      this.cb.onFailed(wired.message)
      return
    }

    // 2) bind the proxy (CA is generated lazily here when decrypt is on).
    try {
      if (decrypt) this.ensureCa()
    } catch (e) {
      wiring.unwire()
      this.wiring = null
      this.cb.onFailed(`CA generation failed: ${e instanceof Error ? e.message : String(e)}`)
      return
    }

    const server = net.createServer((socket) => this.handleClient(socket))
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (!this.running) {
        // failed to bind — undo the device wiring so nothing dangles.
        wiring.unwire()
        this.wiring = null
        this.cb.onFailed(`port ${port} unavailable (${err.message})`)
      }
    })
    server.listen(port, wiring.bindHost, () => {
      this.running = true
      this.server = server
      this.cb.onStarted(port)
      this.cb.onStatus(
        `Intercept on — ${decrypt ? 'decrypting HTTPS' : 'capturing'} · port ${port} · ${serial}`
      )
      if (wired.message) this.cb.onStatus(wired.message)
      if (decrypt && wiring.autoInstallCertOnStart) this.maybePromptCert(serial)
    })
  }

  /** Toggle HTTPS decryption on the running session (new connections honor it). */
  setDecrypt(on: boolean): void {
    this.decrypt = on
    if (this.running && this.wiring) {
      if (on) {
        try {
          this.ensureCa()
        } catch {
          /* surfaced on first handshake */
        }
        if (this.wiring.autoInstallCertOnStart) this.maybePromptCert(this.wiring.serial)
      }
      this.cb.onStatus(
        `Intercept on — ${on ? 'decrypting HTTPS' : 'capturing'} · port ${this.activePort} · ${this.wiring.serial}`
      )
    }
  }

  /** Stop capture + unwire the device (restore proxy / drop tunnel, per platform). */
  stop(): void {
    this.running = false
    if (this.server) {
      try {
        this.server.close()
      } catch {
        /* ignore */
      }
      this.server = null
    }
    if (this.wiring) {
      this.wiring.unwire()
      this.wiring = null
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
  }

  /** App-close hook — no dangling proxy may outlive the app (CLAUDE.md #3). */
  shutdown(): void {
    this.stop()
  }

  // --- Tier-2 CA + leaf certs (node-forge) ----------------------------------
  private caDir(): string {
    return join(app.getPath('userData'), 'intercept')
  }
  private caCertPath(): string {
    return join(this.caDir(), 'androidlab-ca.crt')
  }
  private caKeyPath(): string {
    return join(this.caDir(), 'androidlab-ca.key')
  }

  /** Load the persisted CA, or generate + persist one (RSA 2048, cA:true). */
  private ensureCa(): void {
    if (this.ca) return
    const certPath = this.caCertPath()
    const keyPath = this.caKeyPath()
    if (existsSync(certPath) && existsSync(keyPath)) {
      const certPem = readFileSync(certPath, 'utf8')
      const keyPem = readFileSync(keyPath, 'utf8')
      this.ca = {
        cert: forge.pki.certificateFromPem(certPem),
        key: forge.pki.privateKeyFromPem(keyPem) as forge.pki.rsa.PrivateKey,
        certPem,
        keyPem
      }
      this.leafKeys = forge.pki.rsa.generateKeyPair(2048)
      return
    }
    const keys = forge.pki.rsa.generateKeyPair(2048)
    const cert = forge.pki.createCertificate()
    cert.publicKey = keys.publicKey
    cert.serialNumber = '00' + randomHex(8)
    cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000)
    cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 24 * 3600 * 1000)
    const attrs = [
      { name: 'commonName', value: 'AndroidLabKit CA' },
      { name: 'organizationName', value: 'AndroidLabKit' }
    ]
    cert.setSubject(attrs)
    cert.setIssuer(attrs)
    cert.setExtensions([
      { name: 'basicConstraints', cA: true },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true }
    ])
    cert.sign(keys.privateKey, forge.md.sha256.create())
    const certPem = forge.pki.certificateToPem(cert)
    const keyPem = forge.pki.privateKeyToPem(keys.privateKey)
    mkdirSync(dirname(certPath), { recursive: true })
    writeFileSync(certPath, certPem, 'utf8')
    writeFileSync(keyPath, keyPem, 'utf8')
    this.ca = { cert, key: keys.privateKey, certPem, keyPem }
    this.leafKeys = forge.pki.rsa.generateKeyPair(2048)
  }

  /** A cached TLS SecureContext serving a leaf cert (CN+SAN=host) signed by CA. */
  private secureContextFor(host: string): tls.SecureContext {
    const cached = this.ctxCache.get(host)
    if (cached) return cached
    this.ensureCa()
    const ca = this.ca
    const leafKeys = this.leafKeys
    if (!ca || !leafKeys) throw new Error('CA not ready')
    const cert = forge.pki.createCertificate()
    cert.publicKey = leafKeys.publicKey
    cert.serialNumber = '00' + randomHex(8)
    cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000)
    cert.validity.notAfter = new Date(Date.now() + 5 * 365 * 24 * 3600 * 1000)
    cert.setSubject([{ name: 'commonName', value: host }])
    cert.setIssuer(ca.cert.subject.attributes)
    const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')
    cert.setExtensions([
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [isIp ? { type: 7, ip: host } : { type: 2, value: host }] }
    ])
    cert.sign(ca.key, forge.md.sha256.create())
    const leafPem = forge.pki.certificateToPem(cert)
    const ctx = tls.createSecureContext({
      key: forge.pki.privateKeyToPem(leafKeys.privateKey),
      cert: leafPem + ca.certPem
    })
    this.ctxCache.set(host, ctx)
    return ctx
  }

  // --- connection handling --------------------------------------------------
  private handleClient(socket: net.Socket): void {
    socket.setNoDelay(true)
    socket.on('error', () => safeDestroy(socket))
    const reader = new StreamReader(socket)
    reader
      .readUntil(CRLFCRLF, STREAM_LIMIT)
      .then((head) => {
        if (head.length === 0) {
          safeDestroy(socket)
          return
        }
        const [startLine, headers] = parseHead(head)
        const parts = startLine.split(' ')
        if (parts.length < 3) {
          safeDestroy(socket)
          return
        }
        const method = parts[0]
        const target = parts[1]
        if (method.toUpperCase() === 'CONNECT') {
          void this.handleConnect(socket, reader, target)
        } else {
          void this.handleHttp(socket, reader, method, target, headers)
        }
      })
      .catch(() => safeDestroy(socket))
  }

  private async handleHttp(
    socket: net.Socket,
    reader: StreamReader,
    method: string,
    target: string,
    reqHeaders: Array<[string, string]>
  ): Promise<void> {
    const [scheme, host, port, path] = splitUrl(target)
    if (!host) {
      safeDestroy(socket)
      return
    }
    await this.proxyRequest(reader, socket, method, scheme, host, port, path, reqHeaders, false)
  }

  private async handleConnect(socket: net.Socket, reader: StreamReader, target: string): Promise<void> {
    const colon = target.indexOf(':')
    const host = colon >= 0 ? target.slice(0, colon) : target
    const portStr = colon >= 0 ? target.slice(colon + 1) : ''
    const port = /^\d+$/.test(portStr) ? parseInt(portStr, 10) : 443
    const ts = Date.now() / 1000

    try {
      await writeAsync(socket, Buffer.from('HTTP/1.1 200 Connection Established\r\n\r\n'))
    } catch {
      safeDestroy(socket)
      return
    }
    // Hand the raw socket back for TLS bytes (unshift any buffered leftover).
    const leftover = reader.detach()
    if (leftover.length > 0) socket.unshift(leftover)

    const peek = await peekSocket(socket, 10000)
    const sni = peek.length > 0 ? parseSni(peek) : null
    const hostDisplay = sni || host

    if (this.decrypt && !this.pinnedHosts.has(hostDisplay)) {
      this.decryptConnect(socket, peek, host, port, hostDisplay, ts)
    } else {
      void this.passthroughConnect(socket, peek, host, port, hostDisplay, ts)
    }
  }

  /** TLS-terminate the client, relay decrypted HTTP over an upstream TLS conn. */
  private decryptConnect(
    socket: net.Socket,
    peek: Buffer,
    host: string,
    port: number,
    hostDisplay: string,
    ts: number
  ): void {
    let ctx: tls.SecureContext
    try {
      ctx = this.secureContextFor(hostDisplay)
    } catch {
      void this.passthroughConnect(socket, peek, host, port, hostDisplay, ts)
      return
    }
    if (peek.length > 0) socket.unshift(peek)
    let tlsSocket: tls.TLSSocket
    try {
      tlsSocket = new tls.TLSSocket(socket, { isServer: true, secureContext: ctx, ALPNProtocols: ['http/1.1'] })
    } catch {
      safeDestroy(socket)
      return
    }
    let established = false
    tlsSocket.once('secure', () => {
      established = true
    })
    tlsSocket.on('error', () => {
      if (!established) this.pinnedHosts.add(hostDisplay) // pinned app → passthrough on retry
      safeDestroy(tlsSocket)
      safeDestroy(socket)
    })
    void this.handleDecrypted(tlsSocket, hostDisplay, port).catch(() => {
      safeDestroy(tlsSocket)
      safeDestroy(socket)
    })
  }

  private async handleDecrypted(tlsSocket: tls.TLSSocket, host: string, port: number): Promise<void> {
    const reader = new StreamReader(tlsSocket)
    const head = await reader.readUntil(CRLFCRLF, STREAM_LIMIT)
    if (head.length === 0) {
      safeDestroy(tlsSocket)
      return
    }
    const [startLine, reqHeaders] = parseHead(head)
    const parts = startLine.split(' ')
    if (parts.length < 3) {
      safeDestroy(tlsSocket)
      return
    }
    const method = parts[0]
    const path = parts[1] // origin-form path (client speaks to us as the origin)
    await this.proxyRequest(reader, tlsSocket, method, 'https', host, port, path, reqHeaders, true)
  }

  /** Blind byte relay of a CONNECT tunnel; emits a metadata-only flow. */
  private async passthroughConnect(
    socket: net.Socket,
    peek: Buffer,
    host: string,
    port: number,
    hostDisplay: string,
    ts: number
  ): Promise<void> {
    let upstream: net.Socket
    try {
      upstream = net.connect({ host, port })
      await onceWithTimeout(upstream, 'connect', 15000)
    } catch (e) {
      this.emitFlow(
        makeFlow({
          method: 'CONNECT',
          scheme: 'https',
          host: hostDisplay,
          port,
          path: '',
          status: null,
          bodyCaptured: false,
          note: `connect failed: ${e instanceof Error ? e.message : String(e)}`,
          ts
        })
      )
      safeDestroy(socket)
      return
    }
    let c2s = 0
    let s2c = 0
    try {
      if (peek.length > 0) {
        upstream.write(peek)
        c2s += peek.length
      }
      const results = await Promise.all([pump(socket, upstream), pump(upstream, socket)])
      c2s += results[0]
      s2c += results[1]
    } finally {
      safeDestroy(upstream)
      safeDestroy(socket)
    }
    this.emitFlow(
      makeFlow({
        method: 'CONNECT',
        scheme: 'https',
        host: hostDisplay,
        port,
        path: '',
        status: null,
        reqSize: c2s,
        respSize: s2c,
        durationMs: Math.round((Date.now() / 1000 - ts) * 1000),
        bodyCaptured: false,
        note: 'encrypted — enable Decrypt HTTPS to see contents',
        ts
      })
    )
  }

  /** Shared request/response relay for plain HTTP and decrypted HTTPS. */
  private async proxyRequest(
    clientReader: StreamReader,
    clientWritable: Duplex,
    method: string,
    scheme: string,
    host: string,
    port: number,
    path: string,
    reqHeaders: Array<[string, string]>,
    upstreamTls: boolean
  ): Promise<void> {
    const ts = Date.now() / 1000
    let upstream: Duplex
    try {
      upstream = upstreamTls
        ? tls.connect({ host, port, servername: host, ALPNProtocols: ['http/1.1'], rejectUnauthorized: false })
        : net.connect({ host, port })
      await onceWithTimeout(upstream, upstreamTls ? 'secureConnect' : 'connect', 15000)
    } catch (e) {
      this.emitFlow(
        makeFlow({
          method,
          scheme,
          host,
          port,
          path,
          status: null,
          reqHeaders,
          note: `upstream error: ${e instanceof Error ? e.message : String(e)}`,
          bodyCaptured: false,
          ts
        })
      )
      safeDestroy(clientWritable)
      return
    }
    upstream.on('error', () => safeDestroy(upstream))
    const upReader = new StreamReader(upstream)

    // Rewrite the request line to origin-form + strip hop-by-hop headers.
    const out: string[] = [`${method} ${path} HTTP/1.1\r\n`]
    let haveHost = false
    for (const [k, v] of reqHeaders) {
      const lk = k.toLowerCase()
      if (lk === 'connection' || lk === 'proxy-connection' || lk === 'keep-alive') continue
      if (lk === 'host') haveHost = true
      out.push(`${k}: ${v}\r\n`)
    }
    if (!haveHost) {
      const defPort = scheme === 'https' ? 443 : 80
      out.push(`Host: ${port === defPort ? host : `${host}:${port}`}\r\n`)
    }
    out.push('Connection: close\r\n\r\n')
    await writeAsync(upstream as Writable, Buffer.from(out.join(''), 'latin1'))

    const req = await relayBody(clientReader, upstream as Writable, reqHeaders, MAX_BODY, false)

    const respHead = await upReader.readUntil(CRLFCRLF, STREAM_LIMIT)
    const [respStart, respHeaders] = parseHead(respHead)
    const status = parseStatus(respStart)

    const clientHead: string[] = [respStart]
    for (const [k, v] of respHeaders) {
      const lk = k.toLowerCase()
      if (lk === 'connection' || lk === 'proxy-connection' || lk === 'keep-alive') continue
      clientHead.push(`${k}: ${v}`)
    }
    clientHead.push('Connection: close')
    await writeAsync(clientWritable as Writable, Buffer.from(clientHead.join('\r\n') + '\r\n\r\n', 'latin1'))

    const hasBody = !(status === 204 || status === 304 || (status !== null && status >= 100 && status < 200))
    const resp = await relayBody(upReader, clientWritable as Writable, respHeaders, MAX_BODY, hasBody)

    safeDestroy(upstream)
    safeDestroy(clientWritable)

    this.emitFlow(
      makeFlow({
        method,
        scheme,
        host,
        port,
        path,
        status,
        reqHeaders,
        respHeaders,
        reqSize: req.size,
        respSize: resp.size,
        durationMs: Math.round((Date.now() / 1000 - ts) * 1000),
        reqBody: req.body.length > 0 ? req.body : null,
        respBody: resp.body.length > 0 ? resp.body : null,
        reqTruncated: req.truncated,
        respTruncated: resp.truncated,
        bodyCaptured: true,
        ts
      })
    )
  }

  // --- flow store + batched emit --------------------------------------------
  private emitFlow(f: Flow): void {
    this.idCounter += 1
    f.id = this.idCounter
    this.flows.push(f)
    this.flowMap.set(f.id, f)
    if (this.flows.length > FLOW_CAP) {
      const drop = this.flows.length - FLOW_CAP + TRIM_CHUNK
      const removed = this.flows.splice(0, drop)
      for (const r of removed) this.flowMap.delete(r.id)
    }
    this.pending.push(toDisplayFlow(f))
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null
        const batch = this.pending
        this.pending = []
        if (batch.length > 0) this.cb.onFlows(batch)
      }, FLOW_FLUSH_MS)
    }
  }

  // --- detail / save / export (by flow id) ----------------------------------
  detail(id: number): FlowDetailData {
    const f = this.flowMap.get(id)
    if (!f) {
      return {
        found: false,
        url: '',
        method: '',
        scheme: '',
        status: null,
        durationMs: null,
        respSize: 0,
        bodyCaptured: false,
        note: 'This flow is no longer available (buffer trimmed).',
        reqHeaders: [],
        respHeaders: [],
        reqBody: '',
        respBody: '',
        reqIsJson: false,
        respIsJson: false,
        curl: ''
      }
    }
    const reqBody = prettyBody(f.reqBody, f.reqHeaders)
    const respBody = f.bodyCaptured
      ? prettyBody(f.respBody, f.respHeaders)
      : f.note || 'encrypted (metadata only)'
    return {
      found: true,
      url: `${f.scheme}://${f.port === 80 || f.port === 443 ? f.host : `${f.host}:${f.port}`}${f.path}`,
      method: f.method,
      scheme: f.scheme,
      status: f.status,
      durationMs: f.durationMs,
      respSize: f.respSize,
      bodyCaptured: f.bodyCaptured,
      note: f.note,
      reqHeaders: f.reqHeaders,
      respHeaders: f.respHeaders,
      reqBody,
      respBody,
      reqIsJson: looksLikeJson(reqBody),
      respIsJson: f.bodyCaptured && looksLikeJson(respBody),
      curl: flowToCurl(f)
    }
  }

  /** Default filename stem for the response body (mirrors _save_body). */
  bodyFileName(id: number): string {
    const f = this.flowMap.get(id)
    if (!f) return 'response.bin'
    const last = f.path.replace(/\/+$/, '').split('/').pop() || 'response'
    return `${last}.bin`
  }

  /** Default filename for a full flow export (mirrors _download_flow). */
  exportFileName(id: number): string {
    const f = this.flowMap.get(id)
    if (!f) return 'flow.txt'
    const raw = f.host + f.path.split('?')[0]
    let stem = ''
    for (const ch of raw) stem += /[a-zA-Z0-9._-]/.test(ch) ? ch : '_'
    stem = stem.slice(0, 80).replace(/^_+|_+$/g, '') || 'flow'
    return `${stem}.txt`
  }

  saveBody(id: number, filePath: string): SaveResult {
    const f = this.flowMap.get(id)
    if (!f || !f.respBody) return { ok: false, message: 'No captured response body', dir: '' }
    try {
      const data = decodeBody(f.respBody, f.respHeaders)
      writeFileSync(filePath, Buffer.from(data ?? Buffer.alloc(0)))
    } catch (e) {
      return { ok: false, message: `Save failed: ${e instanceof Error ? e.message : String(e)}`, dir: '' }
    }
    return {
      ok: true,
      message: `Saved ${filePath.split('/').pop()}`,
      dir: dirname(filePath)
    }
  }

  downloadFlow(id: number, filePath: string): SaveResult {
    const f = this.flowMap.get(id)
    if (!f) return { ok: false, message: 'Flow no longer available', dir: '' }
    try {
      writeFileSync(filePath, buildFlowExport(f), 'utf8')
    } catch (e) {
      return { ok: false, message: `Download failed: ${e instanceof Error ? e.message : String(e)}`, dir: '' }
    }
    return { ok: true, message: `Downloaded ${filePath.split('/').pop()}`, dir: dirname(filePath) }
  }

  // --- CA cert install ------------------------------------------------------
  private certMarkerPath(serial: string): string {
    const safe = (serial || 'device').replace(/[^a-zA-Z0-9]/g, '_')
    return join(this.caDir(), `.cert-${safe}`)
  }

  private maybePromptCert(serial: string): void {
    if (serial && !existsSync(this.certMarkerPath(serial))) {
      void this.installCert(serial) // first time on this device → push + guide
    } else {
      this.cb.onStatus('Decrypting HTTPS — CA cert already set up (click Install CA Cert if bodies do not appear)')
    }
  }

  /** Deliver the CA to the device via its wiring (per platform), remembering the
   *  device so decrypt sessions don't re-nag. */
  async installCert(serial: string): Promise<CertPushResult> {
    if (!serial) return { ok: false, message: 'Select a device first', dir: '' }
    const wiring = this.wiring && this.wiring.serial === serial ? this.wiring : this.wiringFor(serial)
    if (!wiring) return { ok: false, message: 'No adb / go-ios backend for this device', dir: '' }
    let ca: CaMaterial
    try {
      ca = this.caMaterial()
    } catch (e) {
      return { ok: false, message: `Couldn't generate the CA cert: ${e instanceof Error ? e.message : String(e)}`, dir: '' }
    }
    const r = await wiring.installCert(ca)
    if (r.ok) {
      try {
        mkdirSync(this.caDir(), { recursive: true })
        writeFileSync(this.certMarkerPath(serial), 'installed\n', 'utf8')
      } catch {
        /* ignore */
      }
    }
    return r
  }

  /** The host CA as paths + PEM + base64 DER (for whichever delivery a wiring uses). */
  private caMaterial(): CaMaterial {
    this.ensureCa()
    const ca = this.ca
    if (!ca) throw new Error('CA not ready')
    const der = forge.asn1.toDer(forge.pki.certificateToAsn1(ca.cert)).getBytes()
    return { certPath: this.caCertPath(), certPem: ca.certPem, certDerBase64: forge.util.encode64(der) }
  }
}

/**
 * Android device wiring: an adb reverse tunnel + the global http_proxy, plus a
 * device-side watchdog that self-heals the proxy on an unclean drop
 * (CLAUDE.md #3). The original proxy is snapshotted on wire() and restored on
 * unwire(). installCert pushes the CA to /sdcard/Download and opens Settings.
 */
export class AndroidWiring implements DeviceWiring {
  readonly bindHost = '127.0.0.1'
  readonly autoInstallCertOnStart = true
  private origProxy = ''
  private port = DEFAULT_PORT
  private watchdog: ChildProcessWithoutNullStreams | null = null

  constructor(
    private readonly adb: string,
    readonly serial: string,
    private readonly cb: WiringCallbacks
  ) {}

  async wire(port: number): Promise<{ ok: boolean; message: string }> {
    this.port = port
    // snapshot the device's original proxy BEFORE we overwrite it.
    this.origProxy = (await run(this.adb, null, getProxyArgs(this.serial), 8000)).stdout.trim()
    // reverse tunnel — never set the proxy if this fails (would strand it).
    const rev = await run(this.adb, null, reverseArgs(this.serial, port), 8000)
    if (rev.code !== 0) {
      const msg = (rev.stderr || rev.stdout || '').trim().split('\n').filter(Boolean).pop()
      return { ok: false, message: 'adb reverse failed: ' + (msg || 'needs Android 5+ / a connected device') }
    }
    await run(this.adb, null, setProxyArgs(this.serial, port), 8000)
    this.startWatchdog()
    return { ok: true, message: '' }
  }

  unwire(): void {
    this.stopWatchdog()
    for (const args of [restoreProxyArgs(this.serial, this.origProxy), reverseRemoveArgs(this.serial, this.port)]) {
      void run(this.adb, null, args, 5000).catch(() => {
        /* ignore */
      })
    }
  }

  async installCert(ca: CaMaterial): Promise<CertPushResult> {
    for (const name of ['androidlab-ca.cer', 'androidlab-ca.crt']) {
      const r = await run(this.adb, null, ['-s', this.serial, 'push', ca.certPath, `/sdcard/Download/${name}`], 20000)
      if (r.code !== 0) {
        const blob = (r.stderr || r.stdout || '').trim().split('\n').filter(Boolean).pop()
        return { ok: false, message: 'adb push failed: ' + (blob || 'unknown'), dir: '' }
      }
    }
    // Jump the device to Security settings to speed up the manual install.
    void run(this.adb, this.serial, ['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'], 6000).catch(() => {})
    void run(this.adb, this.serial, ['shell', 'am', 'start', '-a', 'android.settings.SECURITY_SETTINGS'], 8000).catch(
      () => {}
    )
    return {
      ok: true,
      message: 'Pushed androidlab-ca.cer to the device Download folder — install it as a user CA in Settings',
      dir: '/sdcard/Download'
    }
  }

  private startWatchdog(): void {
    this.stopWatchdog()
    if (!this.adb || !this.serial) return
    const wd = spawn(this.adb, ['-s', this.serial, 'shell', proxyWatchdogScript(this.origProxy)])
    wd.on('close', () => {
      // Reached only when the watchdog dies on its own (device dropped). Its
      // on-device trap has already restored the proxy; tell the engine to stop.
      if (this.watchdog === wd) {
        this.watchdog = null
        this.cb.onStatus('Device disconnected — intercept stopped; device proxy restored on-device')
        this.cb.onDisconnect()
      }
    })
    wd.on('error', () => {
      /* watchdog couldn't spawn — non-fatal */
    })
    this.watchdog = wd
  }

  private stopWatchdog(): void {
    const wd = this.watchdog
    this.watchdog = null
    if (!wd) return
    wd.removeAllListeners('close') // deliberate stop → not a disconnect
    try {
      wd.stdin.write('\n') // release the on-device `read` → trap disarmed, no restore
      wd.stdin.end()
    } catch {
      /* ignore */
    }
    const killTimer = setTimeout(() => {
      try {
        wd.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    }, 1500)
    wd.on('close', () => clearTimeout(killTimer))
  }
}

// --- small helpers ------------------------------------------------------------
function randomHex(nBytes: number): string {
  let s = ''
  for (let i = 0; i < nBytes; i++) s += Math.floor(Math.random() * 256).toString(16).padStart(2, '0')
  return s
}

function looksLikeJson(text: string): boolean {
  const t = (text || '').trim()
  if (!t || (t[0] !== '{' && t[0] !== '[')) return false
  try {
    JSON.parse(t)
    return true
  } catch {
    return false
  }
}
