#!/usr/bin/env node
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
const net = __importStar(require("node:net"));
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const crypto_1 = require("./crypto");
const link_1 = require("./link");
const session_1 = require("./session");
const discovery_1 = require("./discovery");
const proto_1 = require("./proto");
const C = __importStar(require("./consts"));
const adb_1 = require("./adb");
function parseArgs(argv) {
    const a = { devicePort: 5277, res: '1280x720', density: 240, verbose: false };
    for (let i = 0; i < argv.length; i++) {
        const v = argv[i];
        if (v === '--serial' || v === '-s')
            a.serial = argv[++i];
        else if (v === '--device-port')
            a.devicePort = parseInt(argv[++i], 10);
        else if (v === '--res') {
            const r = argv[++i];
            if (!(r in proto_1.Resolution))
                fail(`--res must be one of: ${Object.keys(proto_1.Resolution).join(', ')}`);
            a.res = r;
        }
        else if (v === '--density')
            a.density = parseInt(argv[++i], 10);
        else if (v === '--dump')
            a.dump = argv[++i];
        else if (v === '--verbose' || v === '-v')
            a.verbose = true;
        else if (v === '--help' || v === '-h') {
            console.log('usage: aa-headunit [--serial S] [--device-port 5277] [--res 1280x720] [--density 240] [--dump out.h264] [--verbose]');
            process.exit(0);
        }
        else
            fail(`unknown argument: ${v}`);
    }
    return a;
}
function fail(msg) {
    console.error(`error: ${msg}`);
    process.exit(1);
}
const ts = () => new Date().toISOString().slice(11, 23);
const log = (msg) => console.log(`[${ts()}] ${msg}`);
async function main() {
    const args = parseArgs(process.argv.slice(2));
    let serial = args.serial;
    if (!serial) {
        const devices = await (0, adb_1.listDevices)();
        if (devices.length === 0)
            fail('no adb device connected');
        if (devices.length > 1)
            fail(`multiple devices, pick one with --serial: ${devices.join(', ')}`);
        serial = devices[0];
    }
    const localPort = await (0, adb_1.addForward)(serial, args.devicePort);
    log(`adb forward tcp:${localPort} → tcp:${args.devicePort} (${serial})`);
    const assets = path.join(__dirname, '..', '..', 'assets');
    const cert = fs.readFileSync(path.join(assets, 'headunit_cert.pem'));
    const key = fs.readFileSync(path.join(assets, 'headunit_key.pem'));
    const dumpStream = args.dump ? fs.createWriteStream(args.dump) : undefined;
    let videoFrames = 0;
    let videoBytes = 0;
    const opened = new Set();
    const cleanup = async (code, reason) => {
        if (reason)
            log(reason);
        if (dumpStream) {
            dumpStream.end();
            log(`dumped ${videoFrames} video payloads / ${videoBytes} bytes to ${args.dump}`);
        }
        await (0, adb_1.removeForward)(serial, localPort);
        process.exit(code);
    };
    const sock = net.connect({ host: '127.0.0.1', port: localPort });
    sock.on('error', (e) => {
        if (e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET') {
            console.error(`\nCould not reach the head unit server on the phone (${e.code}).\n` +
                'On the phone: Android Auto app → tap "Version" 10× to enable developer mode,\n' +
                'then overflow menu → "Start head unit server", and re-run this command.\n');
        }
        void cleanup(1, `socket error: ${e.message}`);
    });
    sock.on('connect', () => {
        log('connected — starting AA handshake');
        const crypto = new crypto_1.AapCrypto(cert, key);
        const session = new session_1.AaSession(new link_1.SocketLink(sock), crypto, (0, discovery_1.makeConfig)(args.res, args.density), {
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
                if (codecConfig)
                    log(`video codec-config (${payload.length} bytes, SPS/PPS)`);
                else if (videoFrames <= 3 || videoFrames % 100 === 0)
                    log(`video: ${videoFrames} payloads, ${(videoBytes / 1024).toFixed(0)} KiB total`);
            },
            ended: (reason) => void cleanup(0, `session ended: ${reason}`),
        }, args.verbose ? (line) => log(line) : undefined);
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
