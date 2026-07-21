#!/usr/bin/env node
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AapCrypto } from './crypto';
import { SocketLink } from './link';
import { AaSession } from './session';
import { makeConfig } from './discovery';
import { ResolutionKey, Resolution } from './proto';
import * as C from './consts';
import { addForward, removeForward, listDevices } from './adb';

/**
 * Standalone Phase-1/2 CLI: connect to the phone's Android Auto head-unit server through
 * an adb forward and run the head-unit protocol. Milestones: TLS + discovery + channel
 * opens printed; with --dump, the raw H.264 car-UI stream is written to a file.
 *
 * Phone-side prerequisites (one-time):
 *   1. Android Auto app → tap "Version" 10× to enable developer mode.
 *   2. Overflow menu → "Start head unit server".
 */

interface Args {
  serial?: string;
  devicePort: number;
  res: ResolutionKey;
  density: number;
  dump?: string;
  verbose: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { devicePort: 5277, res: '1280x720', density: 240, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--serial' || v === '-s') a.serial = argv[++i];
    else if (v === '--device-port') a.devicePort = parseInt(argv[++i], 10);
    else if (v === '--res') {
      const r = argv[++i] as ResolutionKey;
      if (!(r in Resolution)) fail(`--res must be one of: ${Object.keys(Resolution).join(', ')}`);
      a.res = r;
    } else if (v === '--density') a.density = parseInt(argv[++i], 10);
    else if (v === '--dump') a.dump = argv[++i];
    else if (v === '--verbose' || v === '-v') a.verbose = true;
    else if (v === '--help' || v === '-h') {
      console.log(
        'usage: aa-headunit [--serial S] [--device-port 5277] [--res 1280x720] [--density 240] [--dump out.h264] [--verbose]',
      );
      process.exit(0);
    } else fail(`unknown argument: ${v}`);
  }
  return a;
}

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

const ts = () => new Date().toISOString().slice(11, 23);
const log = (msg: string) => console.log(`[${ts()}] ${msg}`);

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let serial = args.serial;
  if (!serial) {
    const devices = await listDevices();
    if (devices.length === 0) fail('no adb device connected');
    if (devices.length > 1) fail(`multiple devices, pick one with --serial: ${devices.join(', ')}`);
    serial = devices[0];
  }

  const localPort = await addForward(serial, args.devicePort);
  log(`adb forward tcp:${localPort} → tcp:${args.devicePort} (${serial})`);

  const assets = path.join(__dirname, '..', '..', 'assets');
  const cert = fs.readFileSync(path.join(assets, 'headunit_cert.pem'));
  const key = fs.readFileSync(path.join(assets, 'headunit_key.pem'));

  const dumpStream = args.dump ? fs.createWriteStream(args.dump) : undefined;
  let videoFrames = 0;
  let videoBytes = 0;
  const opened = new Set<number>();

  const cleanup = async (code: number, reason?: string) => {
    if (reason) log(reason);
    if (dumpStream) {
      dumpStream.end();
      log(`dumped ${videoFrames} video payloads / ${videoBytes} bytes to ${args.dump}`);
    }
    await removeForward(serial, localPort);
    process.exit(code);
  };

  const sock = net.connect({ host: '127.0.0.1', port: localPort });
  sock.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET') {
      console.error(
        `\nCould not reach the head unit server on the phone (${e.code}).\n` +
          'On the phone: Android Auto app → tap "Version" 10× to enable developer mode,\n' +
          'then overflow menu → "Start head unit server", and re-run this command.\n',
      );
    }
    void cleanup(1, `socket error: ${e.message}`);
  });

  sock.on('connect', () => {
    log('connected — starting AA handshake');
    const crypto = new AapCrypto(cert, key);
    const session = new AaSession(
      new SocketLink(sock),
      crypto,
      makeConfig(args.res, args.density),
      {
        status: (m) => log(`· ${m}`),
        phoneInfo: (name, brand) => log(`phone: ${name} (${brand})`),
        channelOpened: (ch) => {
          opened.add(ch);
          log(`channel OPEN: ${C.channelName(ch)}  [${[...opened].map(C.channelName).join(', ')}]`);
        },
        streaming: () => log('★ VIDEO STREAMING — car UI is live'),
        videoData: (payload, codecConfig) => {
          videoFrames++;
          videoBytes += payload.length;
          dumpStream?.write(payload);
          if (codecConfig) log(`video codec-config (${payload.length} bytes, SPS/PPS)`);
          else if (videoFrames <= 3 || videoFrames % 100 === 0)
            log(`video: ${videoFrames} payloads, ${(videoBytes / 1024).toFixed(0)} KiB total`);
        },
        ended: (reason) => void cleanup(0, `session ended: ${reason}`),
      },
      args.verbose ? (line) => log(line) : undefined,
    );

    process.on('SIGINT', () => {
      session.stop();
      void cleanup(0, 'interrupted');
    });
    process.on('SIGTERM', () => {
      session.stop();
      void cleanup(0, 'terminated');
    });

    void session.start().catch((e) => cleanup(1, `handshake failed: ${e.message}`));

    // Progress hint if the phone never answers the version request.
    setTimeout(() => {
      if (opened.size === 0 && !crypto.finished) {
        log('no TLS yet after 20s — is Android Auto set up on the phone? (check --verbose)');
      }
    }, 20000).unref();
  });
}

void main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
