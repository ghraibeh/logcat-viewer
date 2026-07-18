// Compile the native AirPlay screen-mirror receiver — cross-platform (macOS/Windows/
// Linux). Drives the CMake build in native/macos/airplay (which links the vendored
// RPiPlay core + the bundled mDNS advertiser + the portable main into
// resources/airplayscreen[.exe], committed and bundled via electron-builder).
//
// Build deps (per platform, resolved by CMake with the hints below):
//   - OpenSSL libcrypto  (FairPlay AES/RSA)
//   - libplist-2.0       (AirPlay plist bodies)
//   - fdk-aac            (AAC-ELD audio decode)
// mDNS/Bonjour is NOT a dependency — the receiver advertises itself (bonjour_shim).
//
//   macOS : brew install openssl@3 libplist fdk-aac cmake
//   Linux : apt install cmake libssl-dev libplist-dev libfdk-aac-dev
//   Windows: vcpkg install openssl libplist fdk-aac  (+ set CMAKE_TOOLCHAIN_FILE or
//            VCPKG_ROOT so CMake finds them)
//
// On any platform, if cmake or a dependency is missing we warn and keep the committed
// binary (so `npm run dist` still works from the checked-in artifact).
const { execFileSync, execSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join } = require('node:path')

const srcDir = join(__dirname, '..', 'native', 'macos', 'airplay')
// Out-of-source build tree (kept OUT of srcDir so the CMake glob can't sweep up
// generated .c files). Sibling dir, gitignored.
const buildDir = join(__dirname, '..', 'native', 'macos', 'airplay-build')
const isWin = process.platform === 'win32'
const isMac = process.platform === 'darwin'

if (!existsSync(join(srcDir, 'airplayscreen.c'))) {
  console.log('[airplayscreen] source not found, skipping')
  process.exit(0)
}

function have(cmd) {
  try {
    execSync(isWin ? `where ${cmd}` : `command -v ${cmd}`, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

if (!have('cmake')) {
  console.warn('[airplayscreen] cmake not found — keeping committed binary. Install cmake to rebuild.')
  process.exit(0)
}

// Homebrew keg-only deps aren't on the default CMake search path; hand CMake the prefixes.
function brewPrefix(pkg) {
  try {
    return execSync(`brew --prefix ${pkg}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return null
  }
}

const cfg = ['-S', srcDir, '-B', buildDir, '-DCMAKE_BUILD_TYPE=Release']
if (isMac) {
  const openssl = brewPrefix('openssl@3')
  const plist = brewPrefix('libplist')
  const fdk = brewPrefix('fdk-aac')
  if (!openssl || !plist || !fdk) {
    console.warn('[airplayscreen] missing brew deps (brew install openssl@3 libplist fdk-aac) — keeping committed binary')
    process.exit(0)
  }
  cfg.push(`-DOPENSSL_ROOT_DIR=${openssl}`, `-DPLIST_ROOT=${plist}`, `-DFDKAAC_ROOT=${fdk}`)
} else if (isWin) {
  // Prefer a vcpkg toolchain if the environment points at one.
  const vcpkg = process.env.CMAKE_TOOLCHAIN_FILE ||
    (process.env.VCPKG_ROOT && join(process.env.VCPKG_ROOT, 'scripts', 'buildsystems', 'vcpkg.cmake'))
  if (vcpkg && existsSync(vcpkg)) cfg.push(`-DCMAKE_TOOLCHAIN_FILE=${vcpkg}`)
}
// Linux: rely on system packages found via find_package/find_library.

try {
  execFileSync('cmake', cfg, { stdio: 'inherit' })
  execFileSync('cmake', ['--build', buildDir, '--config', 'Release', '-j', '4'], { stdio: 'inherit' })
  const out = join(__dirname, '..', 'resources', isWin ? 'airplayscreen.exe' : 'airplayscreen')
  console.log('[airplayscreen] compiled ->', out)
} catch (e) {
  console.warn('[airplayscreen] build failed (keeping committed binary if present):', e.message)
}
