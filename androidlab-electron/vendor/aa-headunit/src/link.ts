import type * as net from 'node:net';

/**
 * Byte-transport abstraction for the Android Auto link (port of AapLink.kt, adapted to
 * Node's push-style sockets). The AA protocol sits entirely above this and is identical
 * over TCP (adb-forwarded head-unit server, wireless) or any future USB/AOAP transport.
 */
export interface AapLink {
  write(data: Buffer): void;
  onData(cb: (chunk: Buffer) => void): void;
  /** Fires once, on EOF or error. */
  onClose(cb: (reason: string) => void): void;
  close(): void;
}

/** TCP implementation (port of SocketLink.kt). */
export class SocketLink implements AapLink {
  private closed = false;
  private closeCb: ((reason: string) => void) | undefined;

  constructor(private readonly sock: net.Socket) {
    sock.setNoDelay(true);
    // TCP keep-alive so a truly dead peer is detected at the OS level in addition to the
    // transport's app-level stall watchdog. Matches SocketLink.kt / headunit-revived.
    sock.setKeepAlive(true, 5000);
    sock.on('error', (err) => this.emitClose(`socket error: ${err.message}`));
    sock.on('close', () => this.emitClose('socket closed'));
    sock.on('end', () => this.emitClose('socket EOF'));
  }

  write(data: Buffer): void {
    this.sock.write(data);
  }

  onData(cb: (chunk: Buffer) => void): void {
    this.sock.on('data', cb);
  }

  onClose(cb: (reason: string) => void): void {
    this.closeCb = cb;
  }

  close(): void {
    this.closed = true;
    this.sock.destroy();
  }

  private emitClose(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCb?.(reason);
  }
}
