/**
 * Screen-mirror pure helpers — port of the pure parts of logcat_viewer/mirror.py:
 * adb command builders, `input text` escaping, the SurfaceFlinger↔display-viewport
 * join for the display picker, and an Annex-B H.264 demuxer that turns the raw
 * `screenrecord --output-format=h264` byte stream into access units for the
 * renderer's WebCodecs VideoDecoder (the low-latency path; PyAV's job in Python).
 *
 * No adb / DOM / Node calls here so it is unit-testable in isolation.
 */

// Android keyevent codes.
export const KEY_BACK = 4
export const KEY_HOME = 3
export const KEY_RECENTS = 187
export const KEY_VOLUME_UP = 24
export const KEY_VOLUME_DOWN = 25
export const KEY_POWER = 26

// H.264 stream bitrate (device-side encoder). 8 Mbit is crisp at 1080p while
// staying small enough to transfer with little latency.
export const H264_BITRATE = '8M'

// Number of staggered screencap capture loops for the poller fallback: screencap
// serializes only partially, so overlapping N round-trips raises the frame rate.
// (A warm screencap is ~150-220ms, so 3 in flight ≈ 12-18fps.)
export const CAPTURE_THREADS = 3

/** A demuxed H.264 access unit (one picture), Annex-B framed. */
export interface AccessUnit {
  data: Uint8Array
  key: boolean
}

// --- adb command builders (each returns a full argv tail incl. `-s <serial>`) --

/** `screencap -p` (PNG) for the poller / prime frame; displayId = SurfaceFlinger
 *  capture id (a 64-bit value that overflows a JS number, so it's kept as text). */
export function screencapArgs(serial: string, displayId: string | null = null): string[] {
  const d = displayId != null ? ['-d', displayId] : []
  return ['-s', serial, 'exec-out', 'screencap', ...d, '-p']
}

/** Continuous H.264 elementary stream to stdout (capped at 180s; caller reconnects). */
export function screenrecordH264Args(serial: string, bitrate: string = H264_BITRATE): string[] {
  return [
    '-s',
    serial,
    'exec-out',
    'screenrecord',
    '--output-format=h264',
    '--time-limit',
    '180',
    '--bit-rate',
    bitrate,
    '-'
  ]
}

/** On-device `screenrecord <remote.mp4>` for MP4 recording (main display only). */
export function screenrecordFileArgs(serial: string, remote: string): string[] {
  return ['-s', serial, 'shell', 'screenrecord', remote]
}

/** `input …` routed to a display via `-d <logical id>` when mirroring a secondary. */
export function inputArgs(serial: string, logicalId: number | null, rest: string[]): string[] {
  const d = logicalId != null ? ['-d', String(logicalId)] : []
  return ['-s', serial, 'shell', 'input', ...d, ...rest]
}

/** Kill any on-device screenrecord (single display encoder; a straggler stalls the next). */
export function pkillScreenrecordArgs(serial: string, signal: string | null = null): string[] {
  const sig = signal ? [`-${signal}`] : []
  return ['-s', serial, 'shell', 'pkill', ...sig, 'screenrecord']
}

export function pullArgs(serial: string, remote: string, dest: string): string[] {
  return ['-s', serial, 'pull', remote, dest]
}

export function rmArgs(serial: string, remote: string): string[] {
  return ['-s', serial, 'shell', 'rm', '-f', remote]
}

export function surfaceFlingerDisplaysArgs(serial: string): string[] {
  return ['-s', serial, 'shell', 'dumpsys', 'SurfaceFlinger', '--display-id']
}

export function dumpsysDisplayArgs(serial: string): string[] {
  return ['-s', serial, 'shell', 'dumpsys', 'display']
}

/** Serial → filesystem-safe token (for capture file names). */
export function safeSerial(serial: string | null): string {
  return [...(serial || 'device')].map((c) => (/[a-zA-Z0-9]/.test(c) ? c : '_')).join('')
}

export function isApkPath(path: string): boolean {
  return path.toLowerCase().endsWith('.apk')
}

/** One shell round-trip that echoes the emulator-telltale props on a single line. */
export function emulatorProbeArgs(serial: string): string[] {
  return [
    '-s',
    serial,
    'shell',
    'echo "K=$(getprop ro.kernel.qemu) B=$(getprop ro.boot.qemu) H=$(getprop ro.hardware) M=$(getprop ro.product.model)"'
  ]
}

/**
 * Decide whether a device is an emulator from `emulatorProbeArgs` output — its
 * `screenrecord` H.264 encoder is software and buffers ~1s, so the mirror
 * defaults to the low-latency screencap poller instead. Physical devices (incl.
 * wireless-adb `ip:port` serials) are NOT emulators, so serial shape can't be used.
 */
export function isEmulatorProps(text: string): boolean {
  const val = (key: string): string => new RegExp(`(?:^|\\s)${key}=(\\S*)`).exec(text)?.[1] ?? ''
  if (val('K') === '1' || val('B') === '1') return true // ro.kernel/boot.qemu
  if (/goldfish|ranchu|vbox|ttvm|nox|windroy|cuttlefish|gce|android_x86/.test(val('H').toLowerCase())) return true
  const model = (/(?:^|\s)M=(.*)$/m.exec(text)?.[1] ?? '').toLowerCase()
  return /sdk|emulator|android sdk built/.test(model)
}

// --- `input text` escaping ----------------------------------------------------

// Characters the device shell would eat when `adb shell input text …` re-parses
// the command line. `input` itself needs spaces sent as %s.
const INPUT_SPECIALS = new Set("\\\"'`&|;<>()*~$#?[]{}".split(''))

/** Make arbitrary text safe for `adb shell input text <arg>`. */
export function escapeInputText(text: string): string {
  const flat = text.replace(/\r\n/g, ' ').replace(/[\n\t]/g, ' ')
  let out = ''
  for (const ch of flat) {
    if (ch === ' ') out += '%s'
    else if (INPUT_SPECIALS.has(ch)) out += '\\' + ch
    else out += ch
  }
  return out
}

// --- display picker (SurfaceFlinger ids ↔ logical viewport ids) ---------------

export interface DisplayInfo {
  /** SurfaceFlinger capture id (for `screencap -d`); a 64-bit value kept as text. */
  sfId: string
  name: string
  virtual: boolean
  /** Logical display id (for `input -d`); null if it couldn't be matched. */
  logical: number | null
}

/**
 * Join `dumpsys SurfaceFlinger --display-id` (capture ids) with `dumpsys display`
 * viewports (logical ids for `input -d`). Physical displays sort first.
 * Faithful port of mirror.py's build_display_list.
 */
export function buildDisplayList(sfText: string, displayText: string): DisplayInfo[] {
  const viewports = new Map<string, number>()
  const vpRe = /DisplayViewport\{[^}]*?displayId=(\d+),[^}]*?uniqueId='([^']+)'/g
  let m: RegExpExecArray | null
  while ((m = vpRe.exec(displayText || '')) !== null) {
    viewports.set(m[2], parseInt(m[1], 10))
  }

  const out: DisplayInfo[] = []
  for (const rawLine of (sfText || '').split('\n')) {
    const line = rawLine.trim()
    const dm = /^Display (\d+) \(([^)]*)\)/.exec(line)
    if (!dm) continue
    const sfId = dm[1] // keep as text — 64-bit ids overflow a JS number
    const kind = dm[2]
    const nm = /displayName="([^"]*)"/.exec(line)
    const name = (nm ? nm[1].trim() : '') || kind
    const virtual = kind.toLowerCase().includes('virtual')
    let logical: number | null
    if (virtual) {
      const onum = /#(\d+)/.exec(name)
      logical = onum ? viewports.get(`overlay:${onum[1]}`) ?? null : null
    } else {
      logical = viewports.get(`local:${sfId}`) ?? null
    }
    out.push({ sfId, name, virtual, logical })
  }
  // stable: physical (non-virtual) first
  out.sort((a, b) => Number(a.virtual) - Number(b.virtual))
  return out
}

// --- H.264 Annex-B demuxer ----------------------------------------------------

function hex2(n: number): string {
  return n.toString(16).padStart(2, '0')
}

/**
 * Splits the continuous Annex-B byte stream from `screenrecord --output-format=h264`
 * into access units (one picture each), so each can be fed to a WebCodecs
 * `EncodedVideoChunk`. Tracks SPS to derive the `avc1.PPCCLL` codec string.
 *
 * A completed access unit is only emitted once the *next* one begins (start-code
 * framing can't know a NAL is complete until the following start code arrives);
 * call `flush()` on EOF / a short idle to release the trailing picture.
 */
export class AnnexBDemuxer {
  private leftover: Uint8Array = new Uint8Array(0)
  private curAU: Uint8Array[] = []
  private curHasVcl = false
  private curKey = false
  private codec: string | null = null
  private lastSps: Uint8Array | null = null
  private spsGen = 0

  /** `avc1.PPCCLL` from the most recent SPS, else null. */
  codecString(): string | null {
    return this.codec
  }

  /** Monotonic counter that bumps whenever the SPS changes — i.e. the video
   *  resolution/orientation changed (a device rotation). Consumers re-init the
   *  decoder on a change so new frames aren't decoded with stale geometry. */
  spsGeneration(): number {
    return this.spsGen
  }

  push(chunk: Uint8Array): AccessUnit[] {
    const data =
      this.leftover.length === 0 ? chunk : concat(this.leftover, chunk)
    // Indices where an Annex-B start code (00 00 01) begins.
    const starts = findStartCodes(data)
    if (starts.length === 0) {
      this.leftover = data
      return []
    }
    const emitted: AccessUnit[] = []
    // Each NAL runs from just after its start code to the next start code.
    for (let i = 0; i < starts.length; i++) {
      const scStart = starts[i]
      const scLen = data[scStart + 2] === 1 ? 3 : 4 // 00 00 01 vs 00 00 00 01
      const payloadStart = scStart + scLen
      const isLast = i === starts.length - 1
      if (isLast) {
        // Keep the final (possibly incomplete) NAL as leftover for the next push.
        this.leftover = data.subarray(scStart)
        break
      }
      const nalEnd = starts[i + 1]
      const nalWithSc = data.subarray(scStart, nalEnd)
      const payload = data.subarray(payloadStart, nalEnd)
      this.consumeNal(payload, nalWithSc, emitted)
    }
    return emitted
  }

  /**
   * Release the trailing picture(s) — call on EOF or after a short idle gap.
   * A bare start-code sentinel terminates the leftover NAL so push() can consume
   * it (start-code framing otherwise can't know that NAL is complete), then the
   * pending access unit is emitted.
   */
  flush(): AccessUnit[] {
    const out = this.push(new Uint8Array([0, 0, 1]))
    this.leftover = new Uint8Array(0) // drop the sentinel
    if (this.curAU.length > 0 && this.curHasVcl) {
      const au = this.finishAU()
      if (au) out.push(au)
    }
    return out
  }

  reset(): void {
    this.leftover = new Uint8Array(0)
    this.curAU = []
    this.curHasVcl = false
    this.curKey = false
    // keep codec across screenrecord reconnects
  }

  private consumeNal(payload: Uint8Array, nalWithSc: Uint8Array, out: AccessUnit[]): void {
    if (payload.length === 0) return
    const type = payload[0] & 0x1f
    const isVcl = type >= 1 && type <= 5

    let boundary = false
    if (type === 9) {
      // Access-Unit Delimiter always starts a new AU.
      boundary = this.curAU.length > 0
    } else if (type === 7 && this.curHasVcl) {
      // A parameter set after slice data → next picture.
      boundary = true
    } else if (isVcl && this.curHasVcl) {
      // New VCL slice with first_mb_in_slice == 0 (top bit of the byte after the
      // NAL header, Exp-Golomb 0) marks a new picture.
      const firstMbZero = payload.length > 1 && (payload[1] & 0x80) !== 0
      if (firstMbZero) boundary = true
    }

    if (boundary) {
      const au = this.finishAU()
      if (au) out.push(au)
    }

    if (type === 7 && payload.length >= 4) {
      // Refresh the codec string from the latest SPS, and bump the generation when the
      // SPS bytes change (new resolution/orientation) so decoders can re-initialise.
      this.codec = `avc1.${hex2(payload[1])}${hex2(payload[2])}${hex2(payload[3])}`
      if (this.lastSps === null || !bytesEqual(this.lastSps, payload)) {
        this.lastSps = payload.slice()
        this.spsGen++
      }
    }

    this.curAU.push(nalWithSc)
    if (isVcl) this.curHasVcl = true
    if (type === 5) this.curKey = true
  }

  private finishAU(): AccessUnit | null {
    if (this.curAU.length === 0) {
      this.curHasVcl = false
      this.curKey = false
      return null
    }
    const au: AccessUnit = { data: concatAll(this.curAU), key: this.curKey }
    this.curAU = []
    this.curHasVcl = false
    this.curKey = false
    return au
  }
}

/** Byte offsets of every `00 00 01` start-code prefix in `data`. */
function findStartCodes(data: Uint8Array): number[] {
  const idx: number[] = []
  const n = data.length
  for (let i = 0; i + 2 < n; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      // A leading extra 0 (00 00 00 01) is part of the same start code; record
      // the position of the last leading zero so the 4-byte form is handled.
      idx.push(i > 0 && data[i - 1] === 0 ? i - 1 : i)
      i += 2
    }
  }
  return idx
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

function concatAll(parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

// --- scrcpy server protocol ---------------------------------------------------
//
// The embedded mirror's low-latency source. Unlike `screenrecord` (which starves
// the stream when the screen is static — max ~1.8s gaps, measured on an A55), scrcpy
// configures the encoder with KEY_REPEAT_PREVIOUS_FRAME_AFTER, so the stream stays
// warm even on a still screen (~247ms max gap, measured) — that's why scrcpy stays
// responsive. We push its server jar and run it video-only (taps still go via
// `adb shell input`) with `raw_stream=true`, which disables ALL of scrcpy's own
// framing (dummy byte / device+codec+frame meta) and emits a plain Annex-B H.264
// elementary stream — byte-for-byte like `screenrecord --output-format=h264`, so the
// renderer reuses the same AnnexBDemuxer. Only the pure command builders live here.

/** On-device path scrcpy's server is pushed to (matches scrcpy's own default). */
export const SCRCPY_DEVICE_SERVER_PATH = '/data/local/tmp/scrcpy-server.jar'

/** `scrcpy --version` → the version token the server jar must be launched with
 *  (the server refuses to start unless it matches the jar's own version). */
export function parseScrcpyVersion(text: string): string | null {
  const m = /scrcpy\s+([0-9][0-9.]*[0-9]|[0-9])/i.exec(text || '')
  return m ? m[1] : null
}

export function scrcpyPushArgs(serial: string, localJar: string): string[] {
  return ['-s', serial, 'push', localJar, SCRCPY_DEVICE_SERVER_PATH]
}

/** Kill a straggler server (holds the sole encoder, like screenrecord). */
export function scrcpyKillArgs(serial: string): string[] {
  return ['-s', serial, 'shell', 'pkill', '-f', 'com.genymobile.scrcpy']
}

/**
 * Launch args for scrcpy's device server (v2.0+ `key=value` form). Video + control
 * (no audio); `raw_stream=true` gives a bare Annex-B video stream while the control
 * socket carries injected touch / key / text.
 *
 * `max_fps` is the critical knob: uncapped, scrcpy streams at the panel's native
 * refresh (~97fps measured on a 120Hz A55), which floods the IPC → JS-demux →
 * WebCodecs → canvas pipeline past what a 60Hz display can present — frames pile up
 * as latency and eventually trip a decode-queue reset that stalls on scrcpy's sparse
 * keyframe. Capping at the display rate keeps the pipeline real-time. Codec/bitrate
 * stay at scrcpy's defaults (h264, 8 Mbps) — a bad/renamed option name aborts the
 * whole server, so we only send options verified on scrcpy 4.0.
 */
export const SCRCPY_MAX_FPS = 60

/** `adb reverse` maps the device's abstract socket back to a host port we listen on;
 *  the server then connects to us (video socket first, then control) only once it is
 *  fully up — deterministic ordering with no connect race (unlike tunnel_forward). */
export function scrcpyReverseArgs(serial: string, scid: string, port: number): string[] {
  return ['-s', serial, 'reverse', `localabstract:scrcpy_${scid}`, `tcp:${port}`]
}

export function scrcpyReverseRemoveArgs(serial: string, scid: string): string[] {
  return ['-s', serial, 'reverse', '--remove', `localabstract:scrcpy_${scid}`]
}

export function scrcpyServerArgs(serial: string, scid: string, version: string): string[] {
  const kv: Record<string, string> = {
    scid,
    log_level: 'error',
    video: 'true',
    audio: 'false',
    control: 'true', // second socket for injecting touch / key / text
    max_fps: String(SCRCPY_MAX_FPS),
    raw_stream: 'true', // bare Annex-B video (reverse tunnel = default, no tunnel_forward)
    cleanup: 'true'
  }
  return [
    '-s',
    serial,
    'shell',
    `CLASSPATH=${SCRCPY_DEVICE_SERVER_PATH}`,
    'app_process',
    '/',
    'com.genymobile.scrcpy.Server',
    version,
    ...Object.entries(kv).map(([k, v]) => `${k}=${v}`)
  ]
}

// --- scrcpy control messages (client → device over the control socket) --------
//
// Binary wire format for scrcpy's INJECT_* messages, verified against scrcpy 4.0
// (keycode 14 bytes, touch 32 bytes, big-endian). Injecting touch DOWN/MOVE/UP is
// what enables interactive dragging, and keycode/text give real keyboard input —
// neither is possible with one-shot `adb shell input`.

export const SC_MSG_KEYCODE = 0
export const SC_MSG_TEXT = 1
export const SC_MSG_TOUCH = 2

/** Android MotionEvent / KeyEvent actions (also used as our touch phase). */
export const SC_ACTION_DOWN = 0
export const SC_ACTION_UP = 1
export const SC_ACTION_MOVE = 2

/** Default pointer id for a single touch point (scrcpy maps arbitrary ids to slots,
 *  so a two-finger pinch is just two touches with distinct ids, e.g. 0 and 1). */
export const SC_POINTER_ID = -1

/** INJECT_KEYCODE: type, action, keycode, repeat, metastate. */
export function scrcpyKeycodeMsg(action: number, keycode: number, metastate = 0, repeat = 0): Uint8Array {
  const b = new Uint8Array(14)
  const dv = new DataView(b.buffer)
  dv.setUint8(0, SC_MSG_KEYCODE)
  dv.setUint8(1, action)
  dv.setInt32(2, keycode) // big-endian (DataView default)
  dv.setInt32(6, repeat)
  dv.setInt32(10, metastate)
  return b
}

/** INJECT_TEXT: type, length (u32), UTF-8 bytes. */
export function scrcpyTextMsg(text: string): Uint8Array {
  const utf8 = new TextEncoder().encode(text)
  const b = new Uint8Array(5 + utf8.length)
  const dv = new DataView(b.buffer)
  dv.setUint8(0, SC_MSG_TEXT)
  dv.setUint32(1, utf8.length)
  b.set(utf8, 5)
  return b
}

/**
 * INJECT_TOUCH_EVENT: type, action, pointerId (i64), x (i32), y (i32),
 * screenW (u16), screenH (u16), pressure (u16 fixed-point, 0xffff = 1.0),
 * actionButton (i32), buttons (i32). x/y are device pixels in the (w,h) space.
 */
export function scrcpyTouchMsg(
  action: number,
  x: number,
  y: number,
  w: number,
  h: number,
  pointerId: number = SC_POINTER_ID
): Uint8Array {
  const b = new Uint8Array(32)
  const dv = new DataView(b.buffer)
  dv.setUint8(0, SC_MSG_TOUCH)
  dv.setUint8(1, action)
  dv.setBigInt64(2, BigInt(pointerId))
  dv.setInt32(10, Math.round(x))
  dv.setInt32(14, Math.round(y))
  dv.setUint16(18, w)
  dv.setUint16(20, h)
  dv.setUint16(22, action === SC_ACTION_UP ? 0 : 0xffff) // pressure
  dv.setInt32(24, 0) // action button
  dv.setInt32(28, action === SC_ACTION_UP ? 0 : 1) // buttons: primary while pressed
  return b
}
