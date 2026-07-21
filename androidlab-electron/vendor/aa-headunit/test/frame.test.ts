import { test } from 'node:test';
import * as assert from 'node:assert';
import { AapTransport } from '../src/frame';
import type { AapLink } from '../src/link';
import type { AapCrypto } from '../src/crypto';
import * as C from '../src/consts';

/** In-memory link pair: whatever A writes arrives at B (optionally chopped small). */
class TestLink implements AapLink {
  peer: TestLink | undefined;
  chop = 0; // deliver in chunks of this size (0 = whole writes)
  private dataCb: ((chunk: Buffer) => void) | undefined;
  private closeCb: ((reason: string) => void) | undefined;
  readonly written: Buffer[] = [];

  write(data: Buffer): void {
    this.written.push(data);
    const deliver = (buf: Buffer) => this.peer?.dataCb?.(buf);
    if (this.chop > 0) {
      for (let i = 0; i < data.length; i += this.chop) deliver(data.subarray(i, i + this.chop));
    } else {
      deliver(data);
    }
  }
  onData(cb: (chunk: Buffer) => void): void {
    this.dataCb = cb;
  }
  onClose(cb: (reason: string) => void): void {
    this.closeCb = cb;
  }
  close(): void {
    this.closeCb?.('closed');
  }
}

/** Reversible stub "TLS": byte-wise XOR — split-tolerant like a real cipher stream, since
 *  multi-frame messages are encrypted once and THEN split across frames. */
const xor = (b: Buffer) => Buffer.from(b.map((v) => v ^ 0x5a));
const stubCrypto = {
  encrypt: async (plain: Buffer) => xor(plain),
  decrypt: async (cipher: Buffer) => xor(cipher),
} as unknown as AapCrypto;

type Msg = { channel: number; encrypted: boolean; messageId: number; content: Buffer };

function pair(): { a: AapTransport; b: AapTransport; linkA: TestLink; got: Msg[] } {
  const linkA = new TestLink();
  const linkB = new TestLink();
  linkA.peer = linkB;
  linkB.peer = linkA;
  const got: Msg[] = [];
  const a = new AapTransport(linkA, stubCrypto, () => {});
  const b = new AapTransport(linkB, stubCrypto, (channel, encrypted, messageId, content) => {
    got.push({ channel, encrypted, messageId, content: Buffer.from(content) });
  });
  a.start();
  b.start();
  return { a, b, linkA, got };
}

const ticks = async (n = 5) => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r));
};

test('single BULK frame roundtrip (plain)', async () => {
  const { a, b, linkA, got } = pair();
  await a.sendMessage(C.CH_CONTROL, C.VERSION_REQUEST, Buffer.from([0, 1, 0, 2]), false);
  await ticks();
  assert.equal(got.length, 1);
  assert.deepEqual(got[0], {
    channel: C.CH_CONTROL,
    encrypted: false,
    messageId: C.VERSION_REQUEST,
    content: Buffer.from([0, 1, 0, 2]),
  });
  // wire shape: [ch][flags=BULK|PLAIN|SPECIFIC][size:2][msgId:2][body]
  const raw = linkA.written[0];
  assert.equal(raw[0], C.CH_CONTROL);
  assert.equal(raw[1], C.FRAME_BULK);
  assert.equal(C.readU16(raw, 2), 6);
  a.stop();
  b.stop();
});

test('large message splits FIRST/MIDDLE/LAST with total-size header and reassembles', async () => {
  const { a, b, linkA, got } = pair();
  const body = Buffer.alloc(C.MAX_FRAME_PAYLOAD * 2 + 100);
  for (let i = 0; i < body.length; i++) body[i] = i & 0xff;
  await a.sendMessage(C.CH_VIDEO, 0x8001, body, true);
  await ticks();
  assert.equal(got.length, 1);
  assert.equal(got[0].messageId, 0x8001);
  assert.ok(got[0].content.equals(body));
  // 3 frames; first has the 8-byte header with u32 total (= body + 2-byte msgId)
  assert.equal(linkA.written.length, 3);
  const first = linkA.written[0];
  assert.equal(first[1] & C.FRAME_TYPE_MASK, C.FRAME_FIRST);
  assert.equal(first.readUInt32BE(4), body.length + 2);
  assert.equal(linkA.written[1][1] & C.FRAME_TYPE_MASK, C.FRAME_MIDDLE);
  assert.equal(linkA.written[2][1] & C.FRAME_TYPE_MASK, C.FRAME_LAST);
  for (const f of linkA.written) assert.ok(C.readU16(f, 2) <= C.MAX_FRAME_PAYLOAD);
  a.stop();
  b.stop();
});

test('byte-by-byte delivery still parses (partial-frame buffering)', async () => {
  const { a, b, linkA, got } = pair();
  linkA.chop = 1;
  await a.sendMessage(C.CH_SENSOR, 0x8003, Buffer.from('sensor-data'), true);
  await ticks(20);
  assert.equal(got.length, 1);
  assert.equal(got[0].content.toString(), 'sensor-data');
  assert.equal(got[0].encrypted, true);
  a.stop();
  b.stop();
});

test('control-bit flag: control msg ids on non-control channels get 0x04', async () => {
  const { a, b, linkA } = pair();
  await a.sendMessage(C.CH_VIDEO, 8, Buffer.from([0x08, 0x00]), true); // CHANNEL_OPEN_RESPONSE
  await a.sendMessage(C.CH_VIDEO, 0x8008, Buffer.alloc(1), true); // media-specific
  await a.sendMessage(C.CH_CONTROL, 8, Buffer.alloc(1), true); // control channel stays specific
  await ticks();
  assert.equal(linkA.written[0][1] & C.MSG_CONTROL, C.MSG_CONTROL);
  assert.equal(linkA.written[1][1] & C.MSG_CONTROL, 0);
  assert.equal(linkA.written[2][1] & C.MSG_CONTROL, 0);
  a.stop();
  b.stop();
});

test('interleaved channels: BULK frame between another channel’s FIRST and LAST', async () => {
  const linkB = new TestLink();
  const got: Msg[] = [];
  const b = new AapTransport(linkB, stubCrypto, (channel, encrypted, messageId, content) => {
    got.push({ channel, encrypted, messageId, content: Buffer.from(content) });
  });
  b.start();
  // Hand-build frames like the phone would (plain, so no TLS ordering concerns here).
  const mk = (ch: number, type: number, payload: Buffer, total?: number) => {
    const head = Buffer.from([ch, type, (payload.length >>> 8) & 0xff, payload.length & 0xff]);
    return total !== undefined
      ? Buffer.concat([head, C.u32be(total), payload])
      : Buffer.concat([head, payload]);
  };
  const vid1 = Buffer.concat([C.u16be(0x8001), Buffer.from('vid-part1-')]);
  const vid2 = Buffer.from('part2');
  const aud = Buffer.concat([C.u16be(0x8002), Buffer.from('audio')]);
  const link2 = new TestLink();
  link2.peer = linkB;
  link2.write(mk(C.CH_VIDEO, C.FRAME_FIRST, vid1, vid1.length + vid2.length));
  link2.write(mk(C.CH_AUDIO_MEDIA, C.FRAME_BULK, aud));
  link2.write(mk(C.CH_VIDEO, C.FRAME_LAST, vid2));
  await ticks();
  assert.equal(got.length, 2);
  assert.equal(got[0].channel, C.CH_AUDIO_MEDIA);
  assert.equal(got[0].content.toString(), 'audio');
  assert.equal(got[1].channel, C.CH_VIDEO);
  assert.equal(got[1].content.toString(), 'vid-part1-part2');
  b.stop();
});

test('link close reports error once', async () => {
  const linkA = new TestLink();
  const a = new AapTransport(linkA, stubCrypto, () => {});
  const errors: string[] = [];
  a.onError = (m) => errors.push(m);
  a.start();
  linkA.close();
  linkA.close();
  await ticks();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /link disconnected/);
});
