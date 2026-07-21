import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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

let cached: string | undefined;

export function findAdb(): string {
  if (cached) return cached;
  const env = process.env.ADB;
  if (env && fs.existsSync(env)) return (cached = env);
  const pathDirs = (process.env.PATH ?? '').split(path.delimiter);
  for (const dir of pathDirs) {
    const p = path.join(dir, 'adb');
    if (dir && fs.existsSync(p)) return (cached = p);
  }
  for (const p of COMMON_ADB) if (fs.existsSync(p)) return (cached = p);
  throw new Error('adb not found ($ADB, PATH, or a common SDK location)');
}

export function runAdb(args: string[], timeoutMs = 10000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(findAdb(), args, { timeout: timeoutMs, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(new Error(`adb ${args.join(' ')}: ${stderr.trim() || err.message}`));
      else resolve(stdout);
    });
  });
}

/** `adb forward tcp:0 tcp:<devicePort>` → the local port adb allocated. */
export async function addForward(serial: string, devicePort: number): Promise<number> {
  const out = await runAdb(['-s', serial, 'forward', 'tcp:0', `tcp:${devicePort}`]);
  const port = parseInt(out.trim(), 10);
  if (!Number.isFinite(port) || port <= 0) throw new Error(`unexpected adb forward output: ${JSON.stringify(out)}`);
  return port;
}

export async function removeForward(serial: string, localPort: number): Promise<void> {
  await runAdb(['-s', serial, 'forward', '--remove', `tcp:${localPort}`]).catch(() => {});
}

/** First connected device serial, or all serials if `all`. */
export async function listDevices(): Promise<string[]> {
  const out = await runAdb(['devices']);
  return out
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l.endsWith('device'))
    .map((l) => l.split(/\s+/)[0]);
}
