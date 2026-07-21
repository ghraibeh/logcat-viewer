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

/**
 * Wireless head-unit server (the VERIFIED reference path — port of WirelessServer.kt): listen on
 * a TCP port; when Android Auto is triggered to connect (see AaTrigger — the phone becomes the TCP
 * client), run the head-unit protocol over the accepted socket. The AA protocol is byte-identical
 * to USB from here; the head unit still sends the version request first.
 *
 * Trigger (over adb, no helper APK needed for the direct-IP path):
 *   am broadcast -n com.google.android.projection.gearhead/\
 *     com.google.android.apps.auto.wireless.setup.receiver.WirelessStartupReceiver \
 *     -a com.google.android.apps.auto.wireless.setup.receiver.wirelessstartup.START \
 *     --es ip_address <THIS_MAC_IP> --ei projection_port <PORT>
 */

interface Args {
  port: number;
  res: ResolutionKey;
  density: number;
  dump?: string;
  verbose: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { port: 5288, res: '1280x720', density: 240, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--port') a.port = parseInt(argv[++i], 10);
    else if (v === '--res') {
      const r = argv[++i] as ResolutionKey;
      if (!(r in Resolution)) fail(`--res must be one of: ${Object.keys(Resolution).join(', ')}`);
      a.res = r;
    } else if (v === '--density') a.density = parseInt(argv[++i], 10);
    else if (v === '--dump') a.dump = argv[++i];
    else if (v === '--verbose' || v === '-v') a.verbose = true;
    else if (v === '--help' || v === '-h') {
      console.log('usage: aa-headunit-server [--port 5288] [--res 1280x720] [--density 240] [--dump out.h264] [--verbose]');
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

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const assets = path.join(__dirname, '..', '..', 'assets');
  const cert = fs.readFileSync(path.join(assets, 'headunit_cert.pem'));
  const key = fs.readFileSync(path.join(assets, 'headunit_key.pem'));

  let busy = false;

  const server = net.createServer((sock) => {
    const peer = `${sock.remoteAddress}:${sock.remotePort}`;
    if (busy) {
      log(`refusing second connection from ${peer} (session active)`);
      sock.destroy();
      return;
    }
    busy = true;
    log(`★ phone connected from ${peer} — starting AA handshake`);

    const dumpStream = args.dump ? fs.createWriteStream(args.dump) : undefined;
    let videoFrames = 0;
    let videoBytes = 0;
    const opened = new Set<number>();

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
        streaming: () => log('★★★ VIDEO STREAMING — car UI is live'),
        videoData: (payload, codecConfig) => {
          videoFrames++;
          videoBytes += payload.length;
          dumpStream?.write(payload);
          if (codecConfig) log(`video codec-config (${payload.length} bytes, SPS/PPS)`);
          else if (videoFrames <= 3 || videoFrames % 100 === 0)
            log(`video: ${videoFrames} payloads, ${(videoBytes / 1024).toFixed(0)} KiB`);
        },
        ended: (reason) => {
          if (dumpStream) {
            dumpStream.end();
            log(`dumped ${videoFrames} video payloads / ${videoBytes} bytes to ${args.dump}`);
          }
          log(`session ended: ${reason}`);
          busy = false;
        },
      },
      args.verbose ? (line) => log(line) : undefined,
    );
    void session.start().catch((e) => log(`handshake failed: ${e.message}`));
  });

  server.on('error', (e) => fail(`server error: ${e.message}`));
  server.listen(args.port, '0.0.0.0', () => {
    log(`head-unit server listening on 0.0.0.0:${args.port} — waiting for Android Auto to connect`);
    log('trigger it with the AaTrigger broadcast pointing at this Mac\'s LAN IP.');
  });
}

main();
