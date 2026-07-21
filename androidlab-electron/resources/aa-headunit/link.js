"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SocketLink = void 0;
/** TCP implementation (port of SocketLink.kt). */
class SocketLink {
    sock;
    closed = false;
    closeCb;
    constructor(sock) {
        this.sock = sock;
        sock.setNoDelay(true);
        // TCP keep-alive so a truly dead peer is detected at the OS level in addition to the
        // transport's app-level stall watchdog. Matches SocketLink.kt / headunit-revived.
        sock.setKeepAlive(true, 5000);
        sock.on('error', (err) => this.emitClose(`socket error: ${err.message}`));
        sock.on('close', () => this.emitClose('socket closed'));
        sock.on('end', () => this.emitClose('socket EOF'));
    }
    write(data) {
        this.sock.write(data);
    }
    onData(cb) {
        this.sock.on('data', cb);
    }
    onClose(cb) {
        this.closeCb = cb;
    }
    close() {
        this.closed = true;
        this.sock.destroy();
    }
    emitClose(reason) {
        if (this.closed)
            return;
        this.closed = true;
        this.closeCb?.(reason);
    }
}
exports.SocketLink = SocketLink;
