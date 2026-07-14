/**
 * Screen-mirror core tests — TS parity for mirror.py's escape_input_text and
 * build_display_list, plus the new Annex-B H.264 demuxer that replaces PyAV.
 */
import { describe, expect, it } from 'vitest'
import {
  AnnexBDemuxer,
  buildDisplayList,
  escapeInputText,
  isEmulatorProps,
  parseScrcpyVersion,
  safeSerial,
  screencapArgs,
  screenrecordH264Args,
  scrcpyReverseArgs,
  scrcpyServerArgs,
  scrcpyKeycodeMsg,
  scrcpyTextMsg,
  scrcpyTouchMsg,
  SC_ACTION_DOWN,
  SC_ACTION_UP,
  SCRCPY_DEVICE_SERVER_PATH
} from '@core/mirror'

describe('escapeInputText', () => {
  it('turns spaces into %s', () => {
    expect(escapeInputText('hello world')).toBe('hello%sworld')
  })
  it('escapes shell/input specials', () => {
    expect(escapeInputText('a&b')).toBe('a\\&b')
    expect(escapeInputText('$(x)')).toBe('\\$\\(x\\)')
  })
  it('flattens newlines/tabs to spaces', () => {
    expect(escapeInputText('a\r\nb\tc')).toBe('a%sb%sc')
  })
})

describe('safeSerial', () => {
  it('keeps alphanumerics, replaces the rest', () => {
    expect(safeSerial('R5CX22ZBQYJ')).toBe('R5CX22ZBQYJ')
    expect(safeSerial('192.168.0.5:5555')).toBe('192_168_0_5_5555')
    expect(safeSerial(null)).toBe('device')
  })
})

describe('command builders', () => {
  it('screencapArgs targets a display when given', () => {
    expect(screencapArgs('S')).toEqual(['-s', 'S', 'exec-out', 'screencap', '-p'])
    expect(screencapArgs('S', '4619827259845275680')).toEqual([
      '-s',
      'S',
      'exec-out',
      'screencap',
      '-d',
      '4619827259845275680',
      '-p'
    ])
  })
  it('screenrecordH264Args streams to stdout', () => {
    expect(screenrecordH264Args('S', '8M')).toEqual([
      '-s',
      'S',
      'exec-out',
      'screenrecord',
      '--output-format=h264',
      '--time-limit',
      '180',
      '--bit-rate',
      '8M',
      '-'
    ])
  })
})

describe('buildDisplayList', () => {
  const sf = [
    'Display 4619827259835644672 (HWC display 0): port=0 pnpId=SAM displayName="samsung lcd"',
    'Display 4619827259845275680 (Virtual display): displayName="Overlay #1"'
  ].join('\n')
  const dp = [
    "DisplayViewport{type=INTERNAL, valid=true, displayId=0, uniqueId='local:4619827259835644672', ...}",
    "DisplayViewport{type=VIRTUAL, valid=true, displayId=14, uniqueId='overlay:1', ...}"
  ].join('\n')

  it('joins SF capture ids with logical viewport ids, physical first', () => {
    const list = buildDisplayList(sf, dp)
    expect(list).toHaveLength(2)
    expect(list[0].virtual).toBe(false)
    expect(list[0].logical).toBe(0)
    expect(list[1].virtual).toBe(true)
    expect(list[1].name).toBe('Overlay #1')
    expect(list[1].logical).toBe(14)
  })

  it('tolerates empty input', () => {
    expect(buildDisplayList('', '')).toEqual([])
  })
})

describe('isEmulatorProps', () => {
  it('flags ro.kernel.qemu=1 (the attached emulator)', () => {
    expect(isEmulatorProps('K=1 B= H=vbox86 M=Nexus 4')).toBe(true)
  })
  it('flags known emulator hardware', () => {
    expect(isEmulatorProps('K= B= H=ranchu M=sdk_gphone64_arm64')).toBe(true)
    expect(isEmulatorProps('K= B= H=goldfish M=Android SDK built for x86')).toBe(true)
  })
  it('does NOT flag a physical device (incl. wireless-adb ip:port serials)', () => {
    expect(isEmulatorProps('K= B= H=qcom M=SM-A556E')).toBe(false)
    expect(isEmulatorProps('K=0 B=0 H=exynos M=Pixel 8')).toBe(false)
  })
})

// --- Annex-B H.264 demuxer ----------------------------------------------------

const START4 = [0, 0, 0, 1]
const START3 = [0, 0, 1]
// SPS: nal type 7, profile 0x42 constraint 0x00 level 0x1e (baseline 3.0).
const SPS = [0x67, 0x42, 0x00, 0x1e, 0xaa]
const PPS = [0x68, 0xce, 0x3c, 0x80]
// IDR slice (type 5) + first_mb_in_slice==0 (top bit of the next byte set).
const IDR = [0x65, 0x88, 0x11, 0x22, 0x33]
// non-IDR slice (type 1), also first_mb==0.
const P = [0x41, 0x9a, 0x44, 0x55]

function bytes(...groups: number[][]): Uint8Array {
  return Uint8Array.from(groups.flat())
}

describe('AnnexBDemuxer', () => {
  it('groups SPS+PPS+IDR into one keyframe access unit and derives the codec', () => {
    const d = new AnnexBDemuxer()
    // A full stream: [SPS][PPS][IDR] then [P] → a keyframe AU and a delta AU.
    const stream = bytes(START4, SPS, START4, PPS, START3, IDR, START3, P)
    const all = [...d.push(stream), ...d.flush()]
    expect(d.codecString()).toBe('avc1.42001e')
    expect(all).toHaveLength(2)
    expect(all[0].key).toBe(true)
    expect(all[1].key).toBe(false)
    // The keyframe AU carries the SPS+PPS+IDR bytes (start codes preserved).
    expect(all[0].data.length).toBeGreaterThan(SPS.length + PPS.length + IDR.length)
  })

  it('reassembles across chunk boundaries split mid-NAL', () => {
    const d = new AnnexBDemuxer()
    const stream = bytes(START4, SPS, START4, PPS, START3, IDR, START3, P)
    // Split at an awkward offset inside the IDR NAL.
    const cut = 14
    const out1 = d.push(stream.subarray(0, cut))
    const out2 = d.push(stream.subarray(cut))
    const total = [...out1, ...out2, ...d.flush()]
    expect(total).toHaveLength(2)
    expect(total[0].key).toBe(true)
    expect(total[1].key).toBe(false)
    // The keyframe AU carries the SPS+PPS+IDR bytes (start codes preserved).
    expect(total[0].data.length).toBeGreaterThan(SPS.length + PPS.length + IDR.length)
  })

  it('flush() releases a lone trailing picture (static-screen tap)', () => {
    const d = new AnnexBDemuxer()
    // Prime a keyframe first so the decoder is configured, then one P frame.
    d.push(bytes(START4, SPS, START4, PPS, START3, IDR))
    const afterKey = d.flush()
    expect(afterKey).toHaveLength(1)
    expect(afterKey[0].key).toBe(true)
    // A single delta frame arrives and then the stream idles.
    const mid = d.push(bytes(START3, P))
    expect(mid).toHaveLength(0)
    const flushed = d.flush()
    expect(flushed).toHaveLength(1)
    expect(flushed[0].key).toBe(false)
  })
})

// --- scrcpy server protocol ---------------------------------------------------

describe('parseScrcpyVersion', () => {
  it('parses the version token scrcpy --version prints', () => {
    expect(parseScrcpyVersion('scrcpy 4.0 <https://github.com/Genymobile/scrcpy>')).toBe('4.0')
    expect(parseScrcpyVersion('scrcpy 2.7')).toBe('2.7')
    expect(parseScrcpyVersion('scrcpy 3.1.1')).toBe('3.1.1')
  })
  it('returns null on unrelated text', () => {
    expect(parseScrcpyVersion('adb version 1.0.41')).toBeNull()
  })
})

describe('scrcpy command builders', () => {
  it('reverse-maps the scid-named abstract socket to a host port', () => {
    expect(scrcpyReverseArgs('S', 'deadbeef', 5037)).toEqual([
      '-s',
      'S',
      'reverse',
      'localabstract:scrcpy_deadbeef',
      'tcp:5037'
    ])
  })
  it('launches the server: video + control, raw_stream, matching scid', () => {
    const a = scrcpyServerArgs('S', 'deadbeef', '4.0')
    expect(a.slice(0, 8)).toEqual([
      '-s',
      'S',
      'shell',
      `CLASSPATH=${SCRCPY_DEVICE_SERVER_PATH}`,
      'app_process',
      '/',
      'com.genymobile.scrcpy.Server',
      '4.0'
    ])
    expect(a).toContain('scid=deadbeef')
    expect(a).toContain('video=true')
    expect(a).toContain('audio=false')
    expect(a).toContain('control=true')
    expect(a).toContain('raw_stream=true')
    expect(a).toContain('max_fps=60')
    // reverse tunnel is the default → no tunnel_forward; no version-fragile options.
    expect(a.some((x) => x.startsWith('tunnel_forward'))).toBe(false)
    expect(a.some((x) => x.startsWith('send_'))).toBe(false)
    expect(a.some((x) => x.startsWith('video_bit_rate'))).toBe(false)
  })
})

describe('scrcpy control messages', () => {
  const hex = (u: Uint8Array): string => Buffer.from(u).toString('hex')

  it('encodes a keycode message (14 bytes, big-endian)', () => {
    // type=0, action=DOWN(0), keycode=3 (HOME), repeat=0, metastate=0
    const m = scrcpyKeycodeMsg(SC_ACTION_DOWN, 3)
    expect(m.length).toBe(14)
    expect(hex(m)).toBe('0000000000030000000000000000')
  })
  it('encodes a text message (type, u32 length, utf-8)', () => {
    const m = scrcpyTextMsg('Ab')
    expect(m[0]).toBe(1) // type = INJECT_TEXT
    expect([m[1], m[2], m[3], m[4]]).toEqual([0, 0, 0, 2]) // length = 2 (BE)
    expect(hex(m.subarray(5))).toBe('4162') // "Ab"
  })
  it('encodes a touch message (32 bytes; pressure/buttons drop on UP)', () => {
    const down = scrcpyTouchMsg(SC_ACTION_DOWN, 100, 200, 1080, 2340)
    expect(down.length).toBe(32)
    expect(down[0]).toBe(2) // type = INJECT_TOUCH_EVENT
    expect(down[1]).toBe(SC_ACTION_DOWN)
    const dv = new DataView(down.buffer)
    expect(dv.getInt32(10)).toBe(100) // x
    expect(dv.getInt32(14)).toBe(200) // y
    expect(dv.getUint16(18)).toBe(1080) // screen w
    expect(dv.getUint16(20)).toBe(2340) // screen h
    expect(dv.getUint16(22)).toBe(0xffff) // pressure while pressed
    expect(dv.getInt32(28)).toBe(1) // primary button while pressed
    const up = scrcpyTouchMsg(SC_ACTION_UP, 100, 200, 1080, 2340)
    const dvUp = new DataView(up.buffer)
    expect(dvUp.getUint16(22)).toBe(0) // pressure 0 on release
    expect(dvUp.getInt32(28)).toBe(0) // no buttons on release
  })
})
