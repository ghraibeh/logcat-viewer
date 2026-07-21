import { test } from 'node:test';
import * as assert from 'node:assert';
import * as tls from 'node:tls';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Duplex } from 'node:stream';
import { AapCrypto } from '../src/crypto';

/**
 * Full message-level TLS handshake against a Node TLS *server* standing in for the phone,
 * using the real head-unit credential on both ends. This exercises exactly the path the
 * AA link uses: discrete handshake "messages" (flights) in both directions, then
 * per-message encrypt/decrypt of application data.
 */

const cert = fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'headunit_cert.pem'));
const key = fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'headunit_key.pem'));

class Pipe extends Duplex {
  readonly out: Buffer[] = [];
  override _write(chunk: Buffer, _e: BufferEncoding, cb: () => void): void {
    this.out.push(Buffer.from(chunk));
    cb();
  }
  override _read(): void {}
  feed(data: Buffer): void {
    this.push(data);
  }
  drain(): Buffer {
    const b = Buffer.concat(this.out);
    this.out.length = 0;
    return b;
  }
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
};

test('TLS handshake-over-messages + app-data encrypt/decrypt vs a phone-side TLS server', async () => {
  const serverPipe = new Pipe();
  const serverSock = new tls.TLSSocket(serverPipe as unknown as import('node:net').Socket, {
    isServer: true,
    secureContext: tls.createSecureContext({ cert, key }),
    requestCert: true,
    rejectUnauthorized: false,
  } as tls.TLSSocketOptions);
  const serverGot: Buffer[] = [];
  serverSock.on('data', (d: Buffer) => serverGot.push(d));
  let serverSecure = false;
  serverSock.on('secure', () => {
    serverSecure = true;
  });
  serverSock.on('error', () => {});

  const crypto = new AapCrypto(cert, key);

  // Handshake as discrete message flights, like SSL_HANDSHAKE control messages.
  let flights = 0;
  let out = await crypto.startHandshake();
  assert.ok(out.length > 0, 'ClientHello expected');
  for (let i = 0; i < 8 && !crypto.finished; i++) {
    if (out.length > 0) {
      serverPipe.feed(out);
      flights++;
    }
    await settle();
    const resp = serverPipe.drain();
    assert.ok(resp.length > 0, `server flight ${i} expected`);
    out = await crypto.processHandshake(resp);
  }
  assert.ok(crypto.finished, 'client handshake must finish');
  if (out.length > 0) serverPipe.feed(out); // client Finished flight
  await settle();
  assert.ok(serverSecure, 'server handshake must finish');
  assert.ok(flights >= 1);

  // head unit → phone
  const rec = await crypto.encrypt(Buffer.from('hello from head unit'));
  assert.ok(rec.length > 20, 'expected TLS record overhead');
  serverPipe.feed(rec);
  await settle();
  assert.equal(Buffer.concat(serverGot).toString(), 'hello from head unit');

  // phone → head unit (two writes → two decrypt calls, order preserved)
  serverSock.write('first');
  await settle();
  const p1 = await crypto.decrypt(serverPipe.drain());
  serverSock.write('second');
  await settle();
  const p2 = await crypto.decrypt(serverPipe.drain());
  assert.equal(p1.toString(), 'first');
  assert.equal(p2.toString(), 'second');

  // split record: feed half a record → empty, rest → full plaintext (Kotlin `pending` behavior)
  serverSock.write('split-record-payload');
  await settle();
  const cipher = serverPipe.drain();
  const half = Math.floor(cipher.length / 2);
  const d1 = await crypto.decrypt(cipher.subarray(0, half));
  const d2 = await crypto.decrypt(cipher.subarray(half));
  assert.equal(Buffer.concat([d1, d2]).toString(), 'split-record-payload');

  crypto.destroy();
  serverSock.destroy();
});
