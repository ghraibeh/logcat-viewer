// electron-builder afterPack hook: deep **ad-hoc** sign the packaged mac .app.
//
// We ship unsigned (no Apple Developer ID), and electron-builder's `identity: null`
// SKIPS signing entirely — which leaves the bundle with an inconsistent signature
// (the base Electron binary is linker-signed but the added extraResources — adb,
// go-ios, dylibs — aren't covered). On Apple Silicon that inconsistency reads as
// "MobileLabKit is damaged and can't be opened."
//
// A single deep ad-hoc signature over the finished bundle makes it consistent, so the
// app opens (via right-click → Open on first launch, or after clearing quarantine:
// `xattr -dr com.apple.quarantine /Applications/MobileLabKit.app`). For distribution
// without any Gatekeeper prompt you still need a Developer ID cert + notarization.
const { execFileSync } = require('node:child_process')
const path = require('node:path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  console.log(`[afterPack] deep ad-hoc signing ${app}`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
  // Sanity: fail the build if the signature doesn't validate.
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
  console.log('[afterPack] signature valid')
}
