#!/usr/bin/env node
/**
 * Dev-only: make `npm run dev` show "AndroidLab" instead of "Electron".
 *
 * When running unpackaged (`electron .`), macOS takes the bold menu-bar title
 * from the running bundle's Info.plist — which is node_modules' Electron.app —
 * so `app.setName()` alone can't change it. This patches CFBundleName /
 * CFBundleDisplayName of the local dev Electron bundle to "AndroidLab".
 *
 * macOS-only, idempotent, and safe to re-run: it never touches
 * CFBundleExecutable (the actual binary name). node_modules is gitignored and
 * recreated by `npm install`, so this runs as the `predev` hook. A packaged
 * build is unaffected — it uses productName from electron-builder.yml.
 */
const { execFileSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join } = require('node:path')

if (process.platform !== 'darwin') process.exit(0)

const APP_NAME = 'AndroidLab'
const PB = '/usr/libexec/PlistBuddy'
const plist = join(
  __dirname,
  '..',
  'node_modules',
  'electron',
  'dist',
  'Electron.app',
  'Contents',
  'Info.plist'
)

if (!existsSync(plist) || !existsSync(PB)) {
  // Electron not installed yet, or non-macOS toolchain — nothing to do.
  process.exit(0)
}

const pb = (cmd) => execFileSync(PB, ['-c', cmd, plist], { stdio: 'pipe' })

try {
  pb(`Set :CFBundleName ${APP_NAME}`)
  try {
    pb(`Set :CFBundleDisplayName ${APP_NAME}`)
  } catch {
    pb(`Add :CFBundleDisplayName string ${APP_NAME}`)
  }
  console.log(`[patch-dev-name] dev Electron bundle named "${APP_NAME}"`)
} catch (err) {
  // Non-fatal: dev still runs, the menu just says "Electron".
  console.warn('[patch-dev-name] skipped:', err.message)
}
