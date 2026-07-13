/**
 * App Manager parity tests — TS equivalents of the appmgr.py checks: the adb
 * command builders, the `pm list` / `dumpsys package` / `cmd appops` parsers,
 * the running-services parser, the launcher-icon picker, and helpers.
 */
import { describe, expect, it } from 'vitest'
import * as A from '@core/appmgr'

const SERIAL = 'R5CX22ZBQYJ'
const PKG = 'com.example.app'

describe('appmgr command builders', () => {
  it('list packages (with/without uid)', () => {
    expect(A.listPackagesArgs(SERIAL)).toEqual([
      '-s', SERIAL, 'shell', 'pm', 'list', 'packages', '-f', '-i', '--show-versioncode', '-U'
    ])
    expect(A.listPackagesArgs(SERIAL, false)).toEqual([
      '-s', SERIAL, 'shell', 'pm', 'list', 'packages', '-f', '-i', '--show-versioncode'
    ])
  })
  it('state-changing ops', () => {
    expect(A.launchArgs(SERIAL, PKG)).toEqual([
      '-s', SERIAL, 'shell', 'monkey', '-p', PKG, '-c', 'android.intent.category.LAUNCHER', '1'
    ])
    expect(A.disableArgs(SERIAL, PKG)).toEqual(['-s', SERIAL, 'shell', 'pm', 'disable-user', '--user', '0', PKG])
    expect(A.uninstallArgs(SERIAL, PKG)).toEqual(['-s', SERIAL, 'uninstall', PKG])
    expect(A.componentArgs(SERIAL, PKG, '.MainActivity', 'disable')).toEqual([
      '-s', SERIAL, 'shell', 'pm', 'disable', `${PKG}/.MainActivity`
    ])
    expect(A.appopsSetArgs(SERIAL, PKG, 'CAMERA', 'deny')).toEqual([
      '-s', SERIAL, 'shell', 'cmd', 'appops', 'set', PKG, 'CAMERA', 'deny'
    ])
  })
})

describe('parsePkgListLine', () => {
  it('splits the base64-y install path on the LAST "=" and reads extras', () => {
    const line =
      'package:/data/app/~~abc==/com.example.app-xyz==/base.apk=com.example.app ' +
      'versionCode:123 uid:10234 installer:com.android.vending'
    const d = A.parsePkgListLine(line)
    expect(d).toEqual({
      package: 'com.example.app',
      apkPath: '/data/app/~~abc==/com.example.app-xyz==/base.apk',
      versionCode: '123',
      uid: '10234',
      installer: 'com.android.vending'
    })
  })
  it('nulls out a null installer and handles a bare package', () => {
    const d = A.parsePkgListLine('package:com.foo installer:null')
    expect(d?.package).toBe('com.foo')
    expect(d?.apkPath).toBe('')
    expect(d?.installer).toBe('')
    expect(A.parsePkgListLine('not-a-package-line')).toBeNull()
  })
})

describe('buildAppList', () => {
  it('marks system/disabled and sorts', () => {
    const detailed = 'package:/a=com.zeta uid:1\npackage:/b=com.alpha uid:2\n'
    const apps = A.buildAppList(detailed, new Set(['com.zeta']), new Set(['com.alpha']))
    expect(apps.map((a) => a.package)).toEqual(['com.alpha', 'com.zeta'])
    expect(apps.find((a) => a.package === 'com.zeta')?.system).toBe(true)
    expect(apps.find((a) => a.package === 'com.alpha')?.enabled).toBe(false)
  })
})

describe('parsePermissions', () => {
  it('extracts requested/install/runtime with grant state', () => {
    const dump = [
      '    requested permissions:',
      '      android.permission.CAMERA',
      '      android.permission.INTERNET',
      '    install permissions:',
      '      android.permission.INTERNET: granted=true',
      '    runtime permissions:',
      '      android.permission.CAMERA: granted=false'
    ].join('\n')
    const perms = A.parsePermissions(dump)
    expect(perms.map((p) => p.name)).toEqual(['android.permission.CAMERA', 'android.permission.INTERNET'])
    const camera = perms[0]
    expect(camera.granted).toBe(false)
    expect(camera.runtime).toBe(true)
    const internet = perms[1]
    expect(internet.granted).toBe(true)
    expect(internet.runtime).toBe(false)
  })
})

describe('parseComponents', () => {
  it('reads resolver tables filtered to the package + marks disabled', () => {
    const dump = [
      'Activity Resolver Table:',
      '      com.example.app/.MainActivity filter 0x1',
      'Service Resolver Table:',
      '      com.example.app/.MyService filter 0x2',
      'disabledComponents:',
      '        com.example.app.MainActivity'
    ].join('\n')
    const comps = A.parseComponents(dump, PKG)
    expect(comps.activities.map((c) => c.name)).toEqual(['.MainActivity'])
    expect(comps.activities[0].enabled).toBe(false)
    expect(comps.services.map((c) => c.name)).toEqual(['.MyService'])
    expect(comps.services[0].enabled).toBe(true)
  })
})

describe('parseAppops / parseGeneral / parseSignatures', () => {
  it('parses app ops', () => {
    const ops = A.parseAppops('CAMERA: allow; time=+1h\nRECORD_AUDIO: deny\n')
    expect(ops).toEqual([
      { op: 'CAMERA', mode: 'allow' },
      { op: 'RECORD_AUDIO', mode: 'deny' }
    ])
  })
  it('parses general fields + flags + splits', () => {
    const dump = [
      '    versionName=1.2.3',
      '    versionCode=45 minSdk=21 targetSdk=33',
      '    dataDir=/data/data/com.example.app',
      '    flags=[ DEBUGGABLE HAS_CODE ]',
      '    splits=[base, config.en]'
    ].join('\n')
    const g = A.parseGeneral(dump)
    expect(g.versionName).toBe('1.2.3')
    expect(g.versionCode).toBe('45')
    expect(g.minSdk).toBe('21')
    expect(g.flags).toBe('DEBUGGABLE HAS_CODE')
    expect(g.splits).toBe('base, config.en')
  })
  it('parses signature summary lines', () => {
    const dump = 'signatures=PackageSignatures{...}\nsignatureScheme=V2\n'
    const sig = A.parseSignatures(dump)
    expect(sig).toContain('signatures=PackageSignatures{...}')
    expect(sig).toContain('signatureScheme=V2')
  })
})

describe('parseRunningServices', () => {
  it('reads ServiceRecord blocks (component / pid / process / flags)', () => {
    const dump = [
      '* ServiceRecord{abc123 u0 com.example.app/.MyService c:com.other}',
      '    app=ProcessRecord{def456 4739:com.example.app/u0a123}',
      '    isForeground=true',
      '    startRequested=true'
    ].join('\n')
    const svcs = A.parseRunningServices(dump)
    expect(svcs.length).toBe(1)
    expect(svcs[0]).toEqual({
      component: 'com.example.app/.MyService',
      pid: 4739,
      process: 'com.example.app',
      foreground: true,
      started: true
    })
  })
})

describe('icon picker + helpers', () => {
  it('picks the densest raster ic_launcher, skips adaptive/xml + arbitrary drawables', () => {
    const entries = [
      'res/mipmap-mdpi/ic_launcher.png',
      'res/mipmap-xxxhdpi/ic_launcher.png',
      'res/mipmap-anydpi-v26/ic_launcher.xml',
      'res/drawable/foo.png'
    ]
    expect(A.pickLauncherIcon(entries)).toBe('res/mipmap-xxxhdpi/ic_launcher.png')
    expect(A.pickLauncherIcon(['res/mipmap-anydpi-v26/ic_launcher.xml'])).toBeNull()
  })
  it('parseZipEntries takes the last column', () => {
    expect(A.parseZipEntries('  1234  2026-01-01 00:00   res/x/ic_launcher.png\n')).toEqual([
      'res/x/ic_launcher.png'
    ])
  })
  it('humanBytes formats units', () => {
    expect(A.humanBytes(500)).toBe('500 B')
    expect(A.humanBytes(1024)).toBe('1.0 KB')
    expect(A.humanBytes(1048576)).toBe('1.0 MB')
  })
  it('opOk treats stdout Failure/Failed as failure', () => {
    expect(A.opOk(0, 'Success')).toBe(true)
    expect(A.opOk(0, 'Failure [INSTALL_FAILED]')).toBe(false)
    expect(A.opOk(1, '')).toBe(false)
  })
})
