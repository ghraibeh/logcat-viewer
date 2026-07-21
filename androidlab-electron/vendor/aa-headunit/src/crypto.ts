import * as tls from 'node:tls';
import { Duplex } from 'node:stream';

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
class WirePipe extends Duplex {
  readonly out: Buffer[] = [];
  onActivity: (() => void) | undefined;

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
    this.out.push(Buffer.from(chunk));
    this.onActivity?.();
    cb();
  }

  override _read(): void {
    /* push-driven via feed() */
  }

  feed(data: Buffer): void {
    this.push(data);
  }
}

export class AapCrypto {
  private readonly wire = new WirePipe();
  private readonly sock: tls.TLSSocket;
  private readonly plain: Buffer[] = [];
  private activity = 0;
  private err: Error | undefined;
  private handshakeDone = false;
  private chain: Promise<unknown> = Promise.resolve();

  get finished(): boolean {
    return this.handshakeDone;
  }

  constructor(certPem: Buffer, keyPem: Buffer) {
    this.wire.onActivity = () => {
      this.activity++;
    };
    this.sock = tls.connect({
      socket: this.wire as unknown as tls.ConnectionOptions['socket'],
      cert: certPem,
      key: keyPem,
      rejectUnauthorized: false,
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.2',
    } as tls.ConnectionOptions);
    this.sock.on('secureConnect', () => {
      this.handshakeDone = true;
      this.activity++;
    });
    this.sock.on('data', (d: Buffer) => {
      this.plain.push(d);
      this.activity++;
    });
    this.sock.on('error', (e: Error) => {
      this.err = e;
      this.activity++;
    });
  }

  /** Begin the handshake and return the first bytes to send (ClientHello). */
  startHandshake(): Promise<Buffer> {
    return this.run(async () => {
      await this.settle();
      return this.drainWire();
    });
  }

  /** Feed one inbound SSL_HANDSHAKE message; resolve with the next bytes to send (may be
   *  empty if we're only consuming). When `finished` flips true the handshake is complete. */
  processHandshake(incoming: Buffer): Promise<Buffer> {
    return this.run(async () => {
      this.wire.feed(incoming);
      await this.settle();
      return this.drainWire();
    });
  }

  /** Encrypt an application payload into TLS record(s). */
  encrypt(plain: Buffer): Promise<Buffer> {
    return this.run(async () => {
      this.sock.write(plain);
      await this.settle();
      const out = this.drainWire();
      if (out.length === 0) throw new Error(this.err?.message ?? 'tls: encrypt produced no records');
      return out;
    });
  }

  /** Decrypt inbound TLS record(s) into the application payload. May resolve empty when the
   *  input ends mid-record (leftover ciphertext is buffered inside OpenSSL, like Kotlin's
   *  `pending`) — the frame layer tolerates that. */
  decrypt(cipher: Buffer): Promise<Buffer> {
    return this.run(async () => {
      this.wire.feed(cipher);
      await this.settle();
      return this.drainPlain();
    });
  }

  destroy(): void {
    this.sock.destroy();
    this.wire.destroy();
  }

  // --- plumbing ---------------------------------------------------------------

  /** Serialize operations: TLS record order must match call order in each direction. */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn);
    this.chain = p.catch(() => {});
    return p;
  }

  /** Yield to the event loop until the TLS state machine stops producing output
   *  (activity counter stable for 2 consecutive macrotasks). */
  private async settle(): Promise<void> {
    let last = -1;
    let stable = 0;
    for (let i = 0; i < 200 && stable < 2; i++) {
      await new Promise<void>((r) => setImmediate(r));
      if (this.err) throw this.err;
      if (this.activity === last) stable++;
      else {
        stable = 0;
        last = this.activity;
      }
    }
  }

  private drainWire(): Buffer {
    const out = Buffer.concat(this.wire.out);
    this.wire.out.length = 0;
    return out;
  }

  private drainPlain(): Buffer {
    const out = Buffer.concat(this.plain);
    this.plain.length = 0;
    return out;
  }
}
