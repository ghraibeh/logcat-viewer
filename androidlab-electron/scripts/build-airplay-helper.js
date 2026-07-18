// Compile the native AirPlay screen-mirror receiver (macOS only). This is the Wi-Fi
// counterpart to build-ios-helper.js's iosscreen (the USB CoreMediaIO path): it links
// the vendored RPiPlay core (native/macos/airplay/*.c, GPL-3.0) with our stdout-based
// main (airplayscreen.m) into resources/airplayscreen (committed) and is bundled via
// electron-builder extraResources. On non-macOS hosts this is a no-op.
//
// Deps (Homebrew): openssl@3 (libcrypto — FairPlay/AES/RSA) and libplist (AirPlay
// plist bodies). Bonjour (dns_sd) is part of macOS. The committed binary links these
// dylibs by their Homebrew paths; packaging for other machines is a follow-up
// (static-link or bundle the dylibs) tracked separately.
const { execFileSync, execSync } = require('node:child_process')
const { existsSync, readdirSync } = require('node:fs')
const { join } = require('node:path')

if (process.platform !== 'darwin') {
  console.log('[airplayscreen] skipped — macOS only')
  process.exit(0)
}

const root = join(__dirname, '..', 'native', 'macos', 'airplay')
const main = join(root, 'airplayscreen.m')
const out = join(__dirname, '..', 'resources', 'airplayscreen')
if (!existsSync(main)) {
  console.log('[airplayscreen] source not found, skipping:', main)
  process.exit(0)
}

// Resolve Homebrew dep prefixes (Apple Silicon + Intel fallbacks).
function brewPrefix(pkg, ...fallbacks) {
  try {
    return execSync(`brew --prefix ${pkg}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    for (const f of fallbacks) if (existsSync(f)) return f
    return null
  }
}
const openssl = brewPrefix('openssl@3', '/opt/homebrew/opt/openssl@3', '/usr/local/opt/openssl@3')
const plist = brewPrefix('libplist', '/opt/homebrew/opt/libplist', '/usr/local/opt/libplist')
if (!openssl || !plist) {
  console.warn('[airplayscreen] missing openssl@3 / libplist (brew install openssl@3 libplist); using committed binary if present')
  process.exit(0)
}

// Every vendored .c (recursively) + our main. llhttp and playfair are subdirs.
function csources(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...csources(join(dir, e.name)))
    else if (e.name.endsWith('.c')) out.push(join(dir, e.name))
  }
  return out
}

const args = [
  '-O2',
  '-fobjc-arc',
  '-o', out,
  main,
  ...csources(root),
  `-I${root}`,
  `-I${join(root, 'llhttp')}`,
  `-I${join(root, 'playfair')}`,
  `-I${join(openssl, 'include')}`,
  `-I${join(plist, 'include')}`,
  `-L${join(openssl, 'lib')}`,
  `-L${join(plist, 'lib')}`,
  '-lcrypto',
  '-lplist-2.0',
  '-framework', 'Foundation',
  // AudioToolbox: AAC-ELD decode (AudioConverter) + playback (AudioQueue) for the
  // AirPlay audio stream.
  '-framework', 'AudioToolbox',
  // macOS shims for the vendored core's Linux socket names (keeps the tree pristine
  // for re-syncing upstream): SOL_TCP→IPPROTO_TCP, TCP_KEEPIDLE→TCP_KEEPALIVE. The
  // other keepalive constants (TCP_KEEPINTVL/TCP_KEEPCNT) exist on macOS as-is.
  '-DSOL_TCP=IPPROTO_TCP',
  '-DTCP_KEEPIDLE=TCP_KEEPALIVE',
  // Silence the vendored core's own warnings — it's third-party, we don't police it.
  '-Wno-everything'
]

try {
  execFileSync('clang', args, { stdio: 'inherit' })
  console.log('[airplayscreen] compiled ->', out)
} catch (e) {
  console.warn('[airplayscreen] compile failed (using committed binary if present):', e.message)
}
