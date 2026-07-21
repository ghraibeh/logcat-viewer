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
exports.findAdb = findAdb;
exports.runAdb = runAdb;
exports.addForward = addForward;
exports.removeForward = removeForward;
exports.listDevices = listDevices;
const node_child_process_1 = require("node:child_process");
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
/**
 * Minimal standalone adb plumbing for the head-unit helper. Deliberately does NOT import
 * from the main app (GPL arm's-length boundary) — resolution mirrors the app's findAdb:
 * $ADB → PATH → common SDK locations.
 */
const COMMON_ADB = [
    path.join(os.homedir(), 'Library/Android/sdk/platform-tools/adb'),
    path.join(os.homedir(), 'Android/Sdk/platform-tools/adb'),
    '/usr/local/bin/adb',
    '/opt/homebrew/bin/adb',
];
let cached;
function findAdb() {
    if (cached)
        return cached;
    const env = process.env.ADB;
    if (env && fs.existsSync(env))
        return (cached = env);
    const pathDirs = (process.env.PATH ?? '').split(path.delimiter);
    for (const dir of pathDirs) {
        const p = path.join(dir, 'adb');
        if (dir && fs.existsSync(p))
            return (cached = p);
    }
    for (const p of COMMON_ADB)
        if (fs.existsSync(p))
            return (cached = p);
    throw new Error('adb not found ($ADB, PATH, or a common SDK location)');
}
function runAdb(args, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        (0, node_child_process_1.execFile)(findAdb(), args, { timeout: timeoutMs, encoding: 'utf8' }, (err, stdout, stderr) => {
            if (err)
                reject(new Error(`adb ${args.join(' ')}: ${stderr.trim() || err.message}`));
            else
                resolve(stdout);
        });
    });
}
/** `adb forward tcp:0 tcp:<devicePort>` → the local port adb allocated. */
async function addForward(serial, devicePort) {
    const out = await runAdb(['-s', serial, 'forward', 'tcp:0', `tcp:${devicePort}`]);
    const port = parseInt(out.trim(), 10);
    if (!Number.isFinite(port) || port <= 0)
        throw new Error(`unexpected adb forward output: ${JSON.stringify(out)}`);
    return port;
}
async function removeForward(serial, localPort) {
    await runAdb(['-s', serial, 'forward', '--remove', `tcp:${localPort}`]).catch(() => { });
}
/** First connected device serial, or all serials if `all`. */
async function listDevices() {
    const out = await runAdb(['devices']);
    return out
        .split('\n')
        .slice(1)
        .map((l) => l.trim())
        .filter((l) => l.endsWith('device'))
        .map((l) => l.split(/\s+/)[0]);
}
