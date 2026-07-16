// Compile the native iOS screen-capture helper (macOS only). It's the QuickTime /
// CoreMediaIO path used by the iOS screen mirror: AVFoundation capture →
// VideoToolbox H.264 → Annex-B on stdout. The compiled binary lands at
// resources/iosscreen (committed) and is bundled via electron-builder
// extraResources. On non-macOS hosts this is a no-op (the helper can't run there).
const { execFileSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join } = require('node:path')

if (process.platform !== 'darwin') {
  console.log('[iosscreen] skipped — macOS only')
  process.exit(0)
}
const src = join(__dirname, '..', 'native', 'macos', 'iosscreen.swift')
const out = join(__dirname, '..', 'resources', 'iosscreen')
if (!existsSync(src)) {
  console.log('[iosscreen] source not found, skipping:', src)
  process.exit(0)
}
try {
  execFileSync('swiftc', ['-O', src, '-o', out], { stdio: 'inherit' })
  console.log('[iosscreen] compiled ->', out)
} catch (e) {
  // Don't hard-fail the build if the Swift toolchain is missing; the committed
  // binary (if present) is used as-is.
  console.warn('[iosscreen] compile failed (using committed binary if present):', e.message)
}
