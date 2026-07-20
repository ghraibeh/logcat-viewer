/**
 * mDNS / DNS-SD advertiser for ONE service — enough for Android's NsdManager to
 * discover this Mac as a `_mlkmirror._tcp` mirror receiver.
 *
 * On macOS we register via the OS mDNSResponder (`/usr/bin/dns-sd -R`). This is the
 * RELIABLE path: a raw socket can't be discovered on a Mac because mDNSResponder owns
 * UDP 5353 and incoming queries route to it, not to a second socket (verified — a raw
 * responder answered nothing while `dns-sd -R` was found instantly). dns-sd -R stays
 * alive holding the registration; we kill it to stop. Elsewhere (Windows/Linux, where
 * there may be no system responder) we fall back to a dependency-free raw `dgram`
 * responder on 224.0.0.251:5353 that answers queries with the full record set.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createSocket, type Socket } from 'node:dgram'
import { networkInterfaces } from 'node:os'

const MDNS_ADDR = '224.0.0.251'
const MDNS_PORT = 5353
const TTL = 120
const TYPE_A = 1
const TYPE_PTR = 12
const TYPE_TXT = 16
const TYPE_SRV = 33
const TYPE_ANY = 255
const CLASS_IN = 1
const CACHE_FLUSH = 0x8000 // set on unique records (A/SRV/TXT) in responses

/** All non-internal IPv4 addresses of this host (the phone picks a reachable one). */
function localIPv4s(): string[] {
  const out: string[] = []
  const ifaces = networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const a of ifaces[name] ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address)
    }
  }
  return out
}

/** Encode a dotted DNS name (e.g. "_mlkmirror._tcp.local") as length-prefixed labels. */
function encodeName(name: string): Buffer {
  const parts = name.replace(/\.$/, '').split('.')
  const bufs: Buffer[] = []
  for (const p of parts) {
    const label = Buffer.from(p, 'utf8')
    bufs.push(Buffer.from([label.length]), label)
  }
  bufs.push(Buffer.from([0]))
  return Buffer.concat(bufs)
}

/** One resource record: name, type, class, ttl, rdata. */
function record(name: string, type: number, cls: number, ttl: number, rdata: Buffer): Buffer {
  const head = Buffer.concat([encodeName(name), Buffer.alloc(10)])
  head.writeUInt16BE(type, head.length - 10)
  head.writeUInt16BE(cls, head.length - 8)
  head.writeUInt32BE(ttl, head.length - 6)
  head.writeUInt16BE(rdata.length, head.length - 2)
  return Buffer.concat([head, rdata])
}

function txtRdata(pairs: Record<string, string>): Buffer {
  const bufs: Buffer[] = []
  for (const [k, v] of Object.entries(pairs)) {
    const s = Buffer.from(`${k}=${v}`, 'utf8')
    bufs.push(Buffer.from([s.length]), s)
  }
  if (bufs.length === 0) bufs.push(Buffer.from([0]))
  return Buffer.concat(bufs)
}

function srvRdata(port: number, target: string): Buffer {
  const head = Buffer.alloc(6) // priority, weight, port
  head.writeUInt16BE(port, 4)
  return Buffer.concat([head, encodeName(target)])
}

function ipv4Rdata(ip: string): Buffer {
  return Buffer.from(ip.split('.').map((n) => parseInt(n, 10) & 0xff))
}

/** The public advertiser: dns-sd -R on macOS, raw dgram responder elsewhere. */
export class MlkAdvertiser {
  private proc: ChildProcess | null = null
  private raw: RawMdnsAdvertiser | null = null

  start(name: string, port: number, txt: Record<string, string> = {}): void {
    this.stop()
    if (process.platform === 'darwin') {
      const txtArgs = Object.entries(txt).map(([k, v]) => `${k}=${v}`)
      try {
        // dns-sd -R "<name>" _mlkmirror._tcp . <port> [key=value ...]
        const p = spawn(
          '/usr/bin/dns-sd',
          ['-R', name, '_mlkmirror._tcp', '.', String(port), ...txtArgs],
          { stdio: 'ignore' }
        )
        this.proc = p
        p.on('error', () => {
          if (this.proc === p) this.proc = null
          this.startRaw(name, port, txt)
        })
        return
      } catch {
        /* fall through to the raw responder */
      }
    }
    this.startRaw(name, port, txt)
  }

  private startRaw(name: string, port: number, txt: Record<string, string>): void {
    this.raw = new RawMdnsAdvertiser()
    this.raw.start(name, port, txt)
  }

  stop(): void {
    if (this.proc) {
      try {
        this.proc.kill()
      } catch {
        /* already gone */
      }
      this.proc = null
    }
    if (this.raw) {
      this.raw.stop()
      this.raw = null
    }
  }
}

/** Dependency-free raw mDNS responder (non-macOS fallback). */
class RawMdnsAdvertiser {
  private sock: Socket | null = null
  private serviceType = '_mlkmirror._tcp.local'
  private instance = ''
  private host = 'mobilelabkit-mirror.local'
  private port = 0
  private txt: Record<string, string> = {}
  private announceTimer: ReturnType<typeof setTimeout> | null = null

  /** Start advertising `<name>._mlkmirror._tcp.local` on `port`. Best-effort. */
  start(name: string, port: number, txt: Record<string, string> = {}): void {
    this.stop()
    this.instance = `${name}.${this.serviceType}`
    this.port = port
    this.txt = txt
    const sock = createSocket({ type: 'udp4', reuseAddr: true })
    this.sock = sock
    sock.on('error', () => this.stop())
    sock.on('message', (msg) => this.onQuery(msg))
    sock.bind(MDNS_PORT, () => {
      try {
        sock.addMembership(MDNS_ADDR)
      } catch {
        /* membership may already exist / interface busy — announcements still go out */
      }
      try {
        sock.setMulticastTTL(255)
        sock.setMulticastLoopback(false)
      } catch {
        /* non-fatal */
      }
      // Gratuitous announcements so the phone sees us even if it isn't querying yet.
      this.announce()
      this.announceTimer = setTimeout(() => this.announce(), 400)
    })
  }

  stop(): void {
    if (this.announceTimer) {
      clearTimeout(this.announceTimer)
      this.announceTimer = null
    }
    if (this.sock) {
      try {
        this.sock.close()
      } catch {
        /* already closed */
      }
      this.sock = null
    }
  }

  /** The full answer set (PTR + SRV + TXT + A[]) as one DNS response packet. */
  private buildResponse(): Buffer {
    const answers: Buffer[] = []
    // PTR: service type -> our instance (shared record, no cache-flush).
    answers.push(record(this.serviceType, TYPE_PTR, CLASS_IN, TTL, encodeName(this.instance)))
    // DNS-SD service enumeration (so `_services._dns-sd._udp` browsers see the type).
    answers.push(
      record('_services._dns-sd._udp.local', TYPE_PTR, CLASS_IN, TTL, encodeName(this.serviceType))
    )
    // SRV + TXT (unique records -> cache-flush).
    answers.push(record(this.instance, TYPE_SRV, CLASS_IN | CACHE_FLUSH, TTL, srvRdata(this.port, this.host)))
    answers.push(record(this.instance, TYPE_TXT, CLASS_IN | CACHE_FLUSH, TTL, txtRdata(this.txt)))
    // A records for every LAN IPv4 (unique -> cache-flush).
    for (const ip of localIPv4s()) {
      answers.push(record(this.host, TYPE_A, CLASS_IN | CACHE_FLUSH, TTL, ipv4Rdata(ip)))
    }
    const header = Buffer.alloc(12)
    header.writeUInt16BE(0x8400, 2) // flags: response, authoritative
    header.writeUInt16BE(answers.length, 6) // ancount
    return Buffer.concat([header, ...answers])
  }

  private send(packet: Buffer): void {
    if (this.sock) {
      try {
        this.sock.send(packet, 0, packet.length, MDNS_PORT, MDNS_ADDR)
      } catch {
        /* interface went away */
      }
    }
  }

  private announce(): void {
    this.send(this.buildResponse())
  }

  /** Respond to any query that concerns our service/instance/host/meta. */
  private onQuery(msg: Buffer): void {
    if (msg.length < 12) return
    const flags = msg.readUInt16BE(2)
    if ((flags & 0x8000) !== 0) return // it's a response, not a query
    const qd = msg.readUInt16BE(4)
    let off = 12
    let relevant = false
    for (let i = 0; i < qd && off < msg.length; i++) {
      const parsed = this.readName(msg, off)
      if (!parsed) break
      off = parsed.off
      if (off + 4 > msg.length) break
      const qtype = msg.readUInt16BE(off)
      off += 4 // qtype + qclass
      const nameLc = parsed.name.toLowerCase()
      if (
        nameLc === this.serviceType ||
        nameLc === this.instance.toLowerCase() ||
        nameLc === this.host ||
        nameLc === '_services._dns-sd._udp.local'
      ) {
        if (
          qtype === TYPE_PTR ||
          qtype === TYPE_SRV ||
          qtype === TYPE_TXT ||
          qtype === TYPE_A ||
          qtype === TYPE_ANY
        ) {
          relevant = true
        }
      }
    }
    if (relevant) this.send(this.buildResponse())
  }

  /** Decode a (possibly compressed) DNS name; returns the dotted name + next offset. */
  private readName(msg: Buffer, start: number): { name: string; off: number } | null {
    const labels: string[] = []
    let off = start
    let jumped = false
    let afterPointer = start
    let guard = 0
    while (off < msg.length && guard++ < 128) {
      const len = msg[off]
      if (len === 0) {
        off++
        break
      }
      if ((len & 0xc0) === 0xc0) {
        // compression pointer
        if (off + 1 >= msg.length) return null
        const ptr = ((len & 0x3f) << 8) | msg[off + 1]
        if (!jumped) afterPointer = off + 2
        off = ptr
        jumped = true
        continue
      }
      off++
      if (off + len > msg.length) return null
      labels.push(msg.toString('utf8', off, off + len))
      off += len
    }
    return { name: labels.join('.'), off: jumped ? afterPointer : off }
  }
}
