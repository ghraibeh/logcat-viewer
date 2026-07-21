/**
 * Build the Android Auto head-unit helper (vendor/aa-headunit, GPLv3, kept at arm's length) and
 * stage it into resources/aa-headunit/ for packaging: the compiled JS (dist/src/*.js) + the
 * head-unit TLS credential (assets/*.pem) + LICENSE/PROVENANCE. The main process forks
 * resources/aa-headunit/electron-helper.js via utilityProcess when packaged.
 */
const { execFileSync } = require('node:child_process')
const { cpSync, mkdirSync, rmSync, readdirSync, existsSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')
const pkg = join(root, 'vendor', 'aa-headunit')
const out = join(root, 'resources', 'aa-headunit')

function run(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: 'inherit' })
}

console.log('[aa-headunit] installing + building the helper package…')
if (!existsSync(join(pkg, 'node_modules'))) run('npm', ['install', '--no-fund', '--no-audit'], pkg)
run('npm', ['run', 'build'], pkg)

console.log('[aa-headunit] staging into resources/aa-headunit/…')
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

// Flatten dist/src/*.js to resources/aa-headunit/*.js so electron-helper.js's relative
// requires ('./crypto' etc.) resolve alongside it.
const distSrc = join(pkg, 'dist', 'src')
for (const f of readdirSync(distSrc)) {
  if (f.endsWith('.js')) cpSync(join(distSrc, f), join(out, f))
}
cpSync(join(pkg, 'assets'), join(out, 'assets'), { recursive: true })
for (const doc of ['LICENSE', 'PROVENANCE.md']) {
  if (existsSync(join(pkg, doc))) cpSync(join(pkg, doc), join(out, doc))
}

console.log('[aa-headunit] done ->', out)
