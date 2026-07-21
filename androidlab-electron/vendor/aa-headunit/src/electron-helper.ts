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
import * as net from 'node:net';
import { AapCrypto } from './crypto';
import { SocketLink } from './link';
import { AaSession } from './session';
import { makeConfig } from './discovery';
import { ResolutionKey, Resolution } from './proto';
import { CH_AUDIO_SPEECH, CH_AUDIO_SYSTEM, CH_AUDIO_MEDIA } from './consts';

/** PCM format per audio channel — matches what discovery.ts advertises (16-bit throughout). */
const AUDIO_FORMAT: Record<number, { rate: number; channels: number }> = {
  [CH_AUDIO_SPEECH]: { rate: 16000, channels: 1 },
  [CH_AUDIO_SYSTEM]: { rate: 16000, channels: 1 },
  [CH_AUDIO_MEDIA]: { rate: 48000, channels: 2 },
};

interface StartMsg {
  type: 'start';
  port?: number;
  res?: string;
  density?: number;
  certPem: string;
  keyPem: string;
  verbose?: boolean;
}
type InMsg =
  | StartMsg
  | { type: 'touch'; action: number; x: number; y: number }
  | { type: 'micData'; data: Uint8Array }
  | { type: 'stop' };

interface ParentPort {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (e: { data: InMsg }) => void): void;
  start?(): void;
}

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (!parentPort) {
  console.error('aa electron-helper: no parentPort (must run under Electron utilityProcess)');
  process.exit(1);
}

const post = (msg: unknown): void => parentPort.postMessage(msg);

let server: net.Server | null = null;
let session: AaSession | null = null;
let busy = false;

function onStart(msg: StartMsg): void {
  const res: ResolutionKey = (msg.res && msg.res in Resolution ? msg.res : '1280x720') as ResolutionKey;
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
    const crypto = new AapCrypto(cert, key);
    session = new AaSession(
      new SocketLink(sock),
      crypto,
      makeConfig(res, density),
      {
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
      },
      msg.verbose ? (line) => post({ type: 'status', message: line }) : undefined,
    );
    void session.start().catch((e: Error) => post({ type: 'error', message: `handshake failed: ${e.message}` }));
  });
  server = srv;
  srv.on('error', (e: Error) => post({ type: 'error', message: `server error: ${e.message}` }));
  srv.listen(msg.port && msg.port > 0 ? msg.port : 0, '0.0.0.0', () => {
    const addr = srv.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    post({ type: 'listening', port });
  });
}

function shutdown(): void {
  try {
    session?.stop();
  } catch {
    /* ignore */
  }
  session = null;
  busy = false;
  if (server) {
    try {
      server.close();
    } catch {
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
      void session?.sendTouch(msg.action, msg.x, msg.y).catch(() => {});
      break;
    case 'micData':
      void session?.sendMic(Buffer.from(msg.data)).catch(() => {});
      break;
    case 'stop':
      shutdown();
      break;
  }
});
parentPort.start?.();
