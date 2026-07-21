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
/**
 * utilityProcess entry for the AndroidLab Electron app (arm's-length GPL boundary — the main app
 * spawns this as a separate Node process and never imports the protocol code). Communicates over
 * Electron's `process.parentPort` MessagePort with a small JSON protocol:
 *
 *   parent → child : { type: 'start', port, res, density, certPem, keyPem }
 *                     { type: 'touch', action, x, y }
 *                     { type: 'stop' }
 *   child → parent : { type: 'listening', port }
 *                     { type: 'status', message } | { type: 'phoneInfo', name, brand }
 *                     { type: 'channel', channel } | { type: 'streaming' }
 *                     { type: 'h264', data } (Uint8Array, incl. codec-config NALs, in order)
 *                     { type: 'pcm', channel, data } (Uint8Array)
 *                     { type: 'ended', reason } | { type: 'error', message }
 *
 * `process.parentPort` is injected by Electron's utilityProcess; typed loosely so this package
 * keeps zero dependency on electron and stays runnable standalone (cli.ts / server.ts).
 */
const net = __importStar(require("node:net"));
const crypto_1 = require("./crypto");
const link_1 = require("./link");
const session_1 = require("./session");
const discovery_1 = require("./discovery");
const proto_1 = require("./proto");
const consts_1 = require("./consts");
/** PCM format per audio channel — matches what discovery.ts advertises (16-bit throughout). */
const AUDIO_FORMAT = {
    [consts_1.CH_AUDIO_SPEECH]: { rate: 16000, channels: 1 },
    [consts_1.CH_AUDIO_SYSTEM]: { rate: 16000, channels: 1 },
    [consts_1.CH_AUDIO_MEDIA]: { rate: 48000, channels: 2 },
};
const parentPort = process.parentPort;
if (!parentPort) {
    console.error('aa electron-helper: no parentPort (must run under Electron utilityProcess)');
    process.exit(1);
}
const post = (msg) => parentPort.postMessage(msg);
let server = null;
let session = null;
let busy = false;
function onStart(msg) {
    const res = (msg.res && msg.res in proto_1.Resolution ? msg.res : '1280x720');
    const density = msg.density ?? 240;
    const cert = Buffer.from(msg.certPem, 'utf8');
    const key = Buffer.from(msg.keyPem, 'utf8');
    const srv = net.createServer((sock) => {
        if (busy) {
            sock.destroy();
            return;
        }
        busy = true;
        post({ type: 'status', message: `phone connected from ${sock.remoteAddress}:${sock.remotePort}` });
        const crypto = new crypto_1.AapCrypto(cert, key);
        session = new session_1.AaSession(new link_1.SocketLink(sock), crypto, (0, discovery_1.makeConfig)(res, density), {
            status: (m) => post({ type: 'status', message: m }),
            phoneInfo: (name, brand) => post({ type: 'phoneInfo', name, brand }),
            channelOpened: (channel) => post({ type: 'channel', channel }),
            streaming: () => post({ type: 'streaming' }),
            videoData: (payload) => post({ type: 'h264', data: new Uint8Array(payload) }),
            audioData: (channel, payload) => {
                const fmt = AUDIO_FORMAT[channel] ?? { rate: 48000, channels: 2 };
                post({ type: 'pcm', channel, rate: fmt.rate, channels: fmt.channels, data: new Uint8Array(payload) });
            },
            micOpen: (open) => post({ type: 'micOpen', open }),
            ended: (reason) => {
                busy = false;
                session = null;
                post({ type: 'ended', reason });
            },
        }, msg.verbose ? (line) => post({ type: 'status', message: line }) : undefined);
        void session.start().catch((e) => post({ type: 'error', message: `handshake failed: ${e.message}` }));
    });
    server = srv;
    srv.on('error', (e) => post({ type: 'error', message: `server error: ${e.message}` }));
    srv.listen(msg.port && msg.port > 0 ? msg.port : 0, '0.0.0.0', () => {
        const addr = srv.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        post({ type: 'listening', port });
    });
}
function shutdown() {
    try {
        session?.stop();
    }
    catch {
        /* ignore */
    }
    session = null;
    busy = false;
    if (server) {
        try {
            server.close();
        }
        catch {
            /* not listening */
        }
        server = null;
    }
}
parentPort.on('message', (e) => {
    const msg = e.data;
    switch (msg.type) {
        case 'start':
            onStart(msg);
            break;
        case 'touch':
            void session?.sendTouch(msg.action, msg.x, msg.y).catch(() => { });
            break;
        case 'micData':
            void session?.sendMic(Buffer.from(msg.data)).catch(() => { });
            break;
        case 'stop':
            shutdown();
            break;
    }
});
parentPort.start?.();
