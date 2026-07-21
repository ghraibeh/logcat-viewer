import type { AapLink } from './link';
import type { AapCrypto } from './crypto';
import * as C from './consts';

/**
 * Android Auto message transport (port of AapTransport.kt).
 *
 * Encodes/decodes AA frames ([channel][flags][size](+totalSize)[payload]), splits large
 * messages into FIRST/MIDDLE/LAST frames and reassembles them, and applies TLS (encrypt on
 * send / decrypt on receive) for frames whose ENCRYPTED flag is set. Complete messages are
 * handed to the handler as (channel, encrypted, messageId, content).
 *
 * Node adaptation: the Kotlin reader thread becomes a push-driven parser; because TLS
 * encrypt/decrypt are async here, receive processing and sends are each serialized on a
 * promise chain to preserve TLS record order.
 */
export type MessageHandler = (
  channel: number,
  encrypted: boolean,
  messageId: number,
  content: Buffer,
) => void | Promise<void>;

interface RawFrame {
  channel: number;
  flags: number;
  frameType: number;
  payload: Buffer;
}

export class AapTransport {
  onError: ((msg: string) => void) | undefined;
  onLog: ((line: string) => void) | undefined;

  private running = false;
  private failed = false;
  private rx: Buffer = Buffer.alloc(0);
  private readonly assembling = new Map<number, Buffer[]>();
  private readonly rxQueue: RawFrame[] = [];
  private pumping = false;
  private txChain: Promise<void> = Promise.resolve();
  private lastRxMs = Date.now();
  private stallTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly link: AapLink,
    private readonly crypto: AapCrypto,
    private readonly handler: MessageHandler,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastRxMs = Date.now();
    this.link.onData((chunk) => {
      if (!this.running) return;
      this.lastRxMs = Date.now();
      this.rx = this.rx.length === 0 ? chunk : Buffer.concat([this.rx, chunk]);
      this.drainFrames();
    });
    this.link.onClose((reason) => {
      if (this.running) this.fail(`link disconnected (${reason})`);
    });
    // AA sends control heartbeats ~1/s; a long total silence means the peer dropped without
    // EOF (left Wi-Fi, crashed). Generous backstop — see AapTransport.kt for rationale.
    this.stallTimer = setInterval(() => {
      if (this.running && Date.now() - this.lastRxMs > STALL_TIMEOUT_MS) {
        this.fail(`link stalled (no data for ${STALL_TIMEOUT_MS}ms)`);
      }
    }, 1000);
    this.stallTimer.unref?.();
  }

  stop(): void {
    this.running = false;
    if (this.stallTimer) clearInterval(this.stallTimer);
    this.stallTimer = undefined;
  }

  /** Send a message on a channel. `content` is the message body (without the id); we
   *  prepend the 2-byte message id, encrypt if requested, then frame + write. Sends are
   *  serialized so TLS records leave in write order. */
  sendMessage(channel: number, messageId: number, content: Buffer, encrypted: boolean): Promise<void> {
    const p = this.txChain.then(async () => {
      if (!this.running) return;
      this.onLog?.(
        `TX ${C.channelName(channel).padEnd(12)} id=0x${messageId.toString(16).padStart(4, '0')} enc=${encrypted} len=${content.length}`,
      );
      const plain = Buffer.concat([C.u16be(messageId), content]);
      const body = encrypted ? await this.crypto.encrypt(plain) : plain;
      const enc = encrypted ? C.ENC_ENCRYPTED : C.ENC_PLAIN;

      const total = body.length;
      let off = 0;
      const chunk = C.MAX_FRAME_PAYLOAD;
      const multi = total > chunk;
      while (off < total) {
        const n = Math.min(chunk, total - off);
        const frameType = !multi
          ? C.FRAME_BULK
          : off === 0
            ? C.FRAME_FIRST
            : off + n >= total
              ? C.FRAME_LAST
              : C.FRAME_MIDDLE;
        // Control-type messages (msgId 1..26, e.g. CHANNEL_OPEN_RESPONSE=8) carried on a
        // NON-control channel must set the 0x04 "control" bit so the phone routes them to
        // its control parser, not the channel's media namespace. Mirrors headunit-revived
        // AapMessage.flags().
        const msgFlag =
          channel !== C.CH_CONTROL && messageId >= 1 && messageId <= 26 ? C.MSG_CONTROL : C.MSG_SPECIFIC;
        const header: number[] = [channel & 0xff, frameType | enc | msgFlag, (n >>> 8) & 0xff, n & 0xff];
        const parts: Buffer[] = [Buffer.from(header)];
        if (frameType === C.FRAME_FIRST) parts.push(C.u32be(total));
        parts.push(body.subarray(off, off + n));
        try {
          this.link.write(Buffer.concat(parts));
        } catch (e) {
          this.fail(`link write failed: ${(e as Error).message}`);
          return;
        }
        off += n;
      }
    });
    this.txChain = p.catch(() => {});
    return p;
  }

  /** Parse every complete frame currently in rx, leaving any partial tail; queue them for
   *  in-order (async) decryption + dispatch. */
  private drainFrames(): void {
    let pos = 0;
    for (;;) {
      if (this.rx.length - pos < 4) break;
      const channel = this.rx[pos];
      const flags = this.rx[pos + 1];
      const frameType = flags & C.FRAME_TYPE_MASK;
      const headerLen = frameType === C.FRAME_FIRST ? 8 : 4;
      if (this.rx.length - pos < headerLen) break;
      const frameSize = C.readU16(this.rx, pos + 2);
      const frameEnd = pos + headerLen + frameSize;
      if (this.rx.length < frameEnd) break; // wait for the rest of this frame
      // Copy (not subarray): rx is reassigned below and payloads may be held across ticks.
      const payload = Buffer.from(this.rx.subarray(pos + headerLen, frameEnd));
      pos = frameEnd;
      this.rxQueue.push({ channel, flags, frameType, payload });
    }
    this.rx = pos === 0 ? this.rx : Buffer.from(this.rx.subarray(pos));
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        const frame = this.rxQueue.shift();
        if (!frame) break;
        await this.handleFrame(frame);
      }
    } finally {
      this.pumping = false;
    }
  }

  private async handleFrame(f: RawFrame): Promise<void> {
    if (!this.running) return;
    const encrypted = (f.flags & C.ENC_ENCRYPTED) !== 0;
    // CRITICAL: decrypt EACH frame here, in receive order. TLS is one ordered record stream,
    // and the phone interleaves frames across channels (e.g. an audio frame slotted between a
    // large video keyframe's fragments). Decrypting per-frame in receive order keeps TLS in
    // sync; reassembly then happens on the PLAINTEXT. (See AapTransport.kt for the war story.)
    let plain: Buffer;
    if (encrypted) {
      try {
        plain = await this.crypto.decrypt(f.payload);
      } catch (e) {
        this.onLog?.(`decrypt failed on ${C.channelName(f.channel)}: ${(e as Error).message}`);
        return;
      }
    } else {
      plain = f.payload;
    }

    let complete: Buffer;
    switch (f.frameType) {
      case C.FRAME_BULK:
        complete = plain;
        break;
      case C.FRAME_FIRST:
        this.assembling.set(f.channel, [plain]);
        return;
      case C.FRAME_MIDDLE:
        this.assembling.get(f.channel)?.push(plain);
        return;
      case C.FRAME_LAST: {
        const acc = this.assembling.get(f.channel);
        if (!acc) return;
        this.assembling.delete(f.channel);
        acc.push(plain);
        complete = Buffer.concat(acc);
        break;
      }
      default:
        return;
    }
    await this.dispatch(f.channel, encrypted, complete);
  }

  /** `plain` is the fully-reassembled DECRYPTED message: [msgId:2 BE][protobuf]. */
  private async dispatch(channel: number, encrypted: boolean, plain: Buffer): Promise<void> {
    if (plain.length < 2) return;
    const messageId = C.readU16(plain, 0);
    const content = plain.subarray(2);
    this.onLog?.(
      `RX ${C.channelName(channel).padEnd(12)} id=0x${messageId.toString(16).padStart(4, '0')} enc=${encrypted} len=${content.length}`,
    );
    try {
      await this.handler(channel, encrypted, messageId, content);
    } catch (e) {
      this.onLog?.(`handler error: ${(e as Error).stack ?? e}`);
    }
  }

  private fail(msg: string): void {
    if (this.failed) return;
    this.failed = true;
    this.stop();
    this.onError?.(msg);
  }
}

const STALL_TIMEOUT_MS = 30000;
