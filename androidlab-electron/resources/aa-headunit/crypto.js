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
exports.AapCrypto = void 0;
const tls = __importStar(require("node:tls"));
const node_stream_1 = require("node:stream");
/**
 * TLS for the Android Auto link (port of AapCrypto.kt). The head unit is the TLS **client**
 * (aasdk uses TLSv1_2_client_method) and presents the head-unit certificate; the phone
 * verifies it. We do NOT verify the phone (trust-all → rejectUnauthorized: false).
 *
 * The handshake bytes are exchanged inside AA `SSL_HANDSHAKE` control messages, so instead
 * of Kotlin's SSLEngine memory BIOs we run a real `tls.TLSSocket` over an in-memory Duplex
 * ("wire"): ciphertext the TLS stack wants to send lands in the wire's write buffer for us
 * to frame; inbound ciphertext is fed into the wire's readable side. OpenSSL processes
 * synchronously once bytes are delivered, but stream delivery is tick-based — so every
 * operation settles by yielding to the event loop until the activity counter goes quiet,
 * then drains its output. All operations are serialized on one promise chain: TLS is a
 * single ordered record stream in each direction.
 */
/** In-memory wire the TLSSocket believes is the network. */
class WirePipe extends node_stream_1.Duplex {
    out = [];
    onActivity;
    _write(chunk, _enc, cb) {
        this.out.push(Buffer.from(chunk));
        this.onActivity?.();
        cb();
    }
    _read() {
        /* push-driven via feed() */
    }
    feed(data) {
        this.push(data);
    }
}
class AapCrypto {
    wire = new WirePipe();
    sock;
    plain = [];
    activity = 0;
    err;
    handshakeDone = false;
    chain = Promise.resolve();
    get finished() {
        return this.handshakeDone;
    }
    constructor(certPem, keyPem) {
        this.wire.onActivity = () => {
            this.activity++;
        };
        this.sock = tls.connect({
            socket: this.wire,
            cert: certPem,
            key: keyPem,
            rejectUnauthorized: false,
            minVersion: 'TLSv1.2',
            maxVersion: 'TLSv1.2',
        });
        this.sock.on('secureConnect', () => {
            this.handshakeDone = true;
            this.activity++;
        });
        this.sock.on('data', (d) => {
            this.plain.push(d);
            this.activity++;
        });
        this.sock.on('error', (e) => {
            this.err = e;
            this.activity++;
        });
    }
    /** Begin the handshake and return the first bytes to send (ClientHello). */
    startHandshake() {
        return this.run(async () => {
            await this.settle();
            return this.drainWire();
        });
    }
    /** Feed one inbound SSL_HANDSHAKE message; resolve with the next bytes to send (may be
     *  empty if we're only consuming). When `finished` flips true the handshake is complete. */
    processHandshake(incoming) {
        return this.run(async () => {
            this.wire.feed(incoming);
            await this.settle();
            return this.drainWire();
        });
    }
    /** Encrypt an application payload into TLS record(s). */
    encrypt(plain) {
        return this.run(async () => {
            this.sock.write(plain);
            await this.settle();
            const out = this.drainWire();
            if (out.length === 0)
                throw new Error(this.err?.message ?? 'tls: encrypt produced no records');
            return out;
        });
    }
    /** Decrypt inbound TLS record(s) into the application payload. May resolve empty when the
     *  input ends mid-record (leftover ciphertext is buffered inside OpenSSL, like Kotlin's
     *  `pending`) — the frame layer tolerates that. */
    decrypt(cipher) {
        return this.run(async () => {
            this.wire.feed(cipher);
            await this.settle();
            return this.drainPlain();
        });
    }
    destroy() {
        this.sock.destroy();
        this.wire.destroy();
    }
    // --- plumbing ---------------------------------------------------------------
    /** Serialize operations: TLS record order must match call order in each direction. */
    run(fn) {
        const p = this.chain.then(fn);
        this.chain = p.catch(() => { });
        return p;
    }
    /** Yield to the event loop until the TLS state machine stops producing output
     *  (activity counter stable for 2 consecutive macrotasks). */
    async settle() {
        let last = -1;
        let stable = 0;
        for (let i = 0; i < 200 && stable < 2; i++) {
            await new Promise((r) => setImmediate(r));
            if (this.err)
                throw this.err;
            if (this.activity === last)
                stable++;
            else {
                stable = 0;
                last = this.activity;
            }
        }
    }
    drainWire() {
        const out = Buffer.concat(this.wire.out);
        this.wire.out.length = 0;
        return out;
    }
    drainPlain() {
        const out = Buffer.concat(this.plain);
        this.plain.length = 0;
        return out;
    }
}
exports.AapCrypto = AapCrypto;
