"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.AapTransport = void 0;
const C = __importStar(require("./consts"));
class AapTransport {
    link;
    crypto;
    handler;
    onError;
    onLog;
    running = false;
    failed = false;
    rx = Buffer.alloc(0);
    assembling = new Map();
    rxQueue = [];
    pumping = false;
    txChain = Promise.resolve();
    lastRxMs = Date.now();
    stallTimer;
    constructor(link, crypto, handler) {
        this.link = link;
        this.crypto = crypto;
        this.handler = handler;
    }
    start() {
        if (this.running)
            return;
        this.running = true;
        this.lastRxMs = Date.now();
        this.link.onData((chunk) => {
            if (!this.running)
                return;
            this.lastRxMs = Date.now();
            this.rx = this.rx.length === 0 ? chunk : Buffer.concat([this.rx, chunk]);
            this.drainFrames();
        });
        this.link.onClose((reason) => {
            if (this.running)
                this.fail(`link disconnected (${reason})`);
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
    stop() {
        this.running = false;
        if (this.stallTimer)
            clearInterval(this.stallTimer);
        this.stallTimer = undefined;
    }
    /** Send a message on a channel. `content` is the message body (without the id); we
     *  prepend the 2-byte message id, encrypt if requested, then frame + write. Sends are
     *  serialized so TLS records leave in write order. */
    sendMessage(channel, messageId, content, encrypted) {
        const p = this.txChain.then(async () => {
            if (!this.running)
                return;
            this.onLog?.(`TX ${C.channelName(channel).padEnd(12)} id=0x${messageId.toString(16).padStart(4, '0')} enc=${encrypted} len=${content.length}`);
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
                const msgFlag = channel !== C.CH_CONTROL && messageId >= 1 && messageId <= 26 ? C.MSG_CONTROL : C.MSG_SPECIFIC;
                const header = [channel & 0xff, frameType | enc | msgFlag, (n >>> 8) & 0xff, n & 0xff];
                const parts = [Buffer.from(header)];
                if (frameType === C.FRAME_FIRST)
                    parts.push(C.u32be(total));
                parts.push(body.subarray(off, off + n));
                try {
                    this.link.write(Buffer.concat(parts));
                }
                catch (e) {
                    this.fail(`link write failed: ${e.message}`);
                    return;
                }
                off += n;
            }
        });
        this.txChain = p.catch(() => { });
        return p;
    }
    /** Parse every complete frame currently in rx, leaving any partial tail; queue them for
     *  in-order (async) decryption + dispatch. */
    drainFrames() {
        let pos = 0;
        for (;;) {
            if (this.rx.length - pos < 4)
                break;
            const channel = this.rx[pos];
            const flags = this.rx[pos + 1];
            const frameType = flags & C.FRAME_TYPE_MASK;
            const headerLen = frameType === C.FRAME_FIRST ? 8 : 4;
            if (this.rx.length - pos < headerLen)
                break;
            const frameSize = C.readU16(this.rx, pos + 2);
            const frameEnd = pos + headerLen + frameSize;
            if (this.rx.length < frameEnd)
                break; // wait for the rest of this frame
            // Copy (not subarray): rx is reassigned below and payloads may be held across ticks.
            const payload = Buffer.from(this.rx.subarray(pos + headerLen, frameEnd));
            pos = frameEnd;
            this.rxQueue.push({ channel, flags, frameType, payload });
        }
        this.rx = pos === 0 ? this.rx : Buffer.from(this.rx.subarray(pos));
        void this.pump();
    }
    async pump() {
        if (this.pumping)
            return;
        this.pumping = true;
        try {
            for (;;) {
                const frame = this.rxQueue.shift();
                if (!frame)
                    break;
                await this.handleFrame(frame);
            }
        }
        finally {
            this.pumping = false;
        }
    }
    async handleFrame(f) {
        if (!this.running)
            return;
        const encrypted = (f.flags & C.ENC_ENCRYPTED) !== 0;
        // CRITICAL: decrypt EACH frame here, in receive order. TLS is one ordered record stream,
        // and the phone interleaves frames across channels (e.g. an audio frame slotted between a
        // large video keyframe's fragments). Decrypting per-frame in receive order keeps TLS in
        // sync; reassembly then happens on the PLAINTEXT. (See AapTransport.kt for the war story.)
        let plain;
        if (encrypted) {
            try {
                plain = await this.crypto.decrypt(f.payload);
            }
            catch (e) {
                this.onLog?.(`decrypt failed on ${C.channelName(f.channel)}: ${e.message}`);
                return;
            }
        }
        else {
            plain = f.payload;
        }
        let complete;
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
                if (!acc)
                    return;
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
    async dispatch(channel, encrypted, plain) {
        if (plain.length < 2)
            return;
        const messageId = C.readU16(plain, 0);
        const content = plain.subarray(2);
        this.onLog?.(`RX ${C.channelName(channel).padEnd(12)} id=0x${messageId.toString(16).padStart(4, '0')} enc=${encrypted} len=${content.length}`);
        try {
            await this.handler(channel, encrypted, messageId, content);
        }
        catch (e) {
            this.onLog?.(`handler error: ${e.stack ?? e}`);
        }
    }
    fail(msg) {
        if (this.failed)
            return;
        this.failed = true;
        this.stop();
        this.onError?.(msg);
    }
}
exports.AapTransport = AapTransport;
const STALL_TIMEOUT_MS = 30000;
