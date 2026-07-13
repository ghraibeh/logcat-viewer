/**
 * File Explorer parity tests — TS equivalents of the files.py checks in
 * tests/smoke.py: the adb command builders (plain / run-as / rooted su), the
 * `ls -lHA` line parser + listing classifier, accessFor + path helpers, the
 * human-size formatter, and the drawn-icon extension grouping.
 */
import { describe, expect, it } from 'vitest'
import * as F from '@core/files'
import type { FileEntry } from '@core/files'

const SERIAL = 'R5CX22ZBQYJ'
const PKG = 'com.example.app'
const PRIV = `/data/data/${PKG}`

const RUNAS: F.Access = { runAs: PKG, su: false }
const SU: F.Access = { runAs: null, su: true }

describe('adb command builders', () => {
  it('ls -lHA: plain vs run-as vs su', () => {
    expect(F.lsArgs(SERIAL, '/sdcard')).toEqual(['-s', SERIAL, 'shell', 'ls', '-lHA', '/sdcard'])
    expect(F.lsArgs(SERIAL, `${PRIV}/files`, RUNAS)).toEqual([
      '-s', SERIAL, 'shell', 'run-as', PKG, 'ls', '-lHA', `${PRIV}/files`
    ])
    expect(F.lsArgs(SERIAL, '/data/misc', SU)).toEqual([
      '-s', SERIAL, 'shell', 'su', '-c', 'ls', '-lHA', '/data/misc'
    ])
  })
  it('cat streams via exec-out (binary-clean)', () => {
    expect(F.catArgs(SERIAL, '/sdcard/x.bin')).toEqual(['-s', SERIAL, 'exec-out', 'cat', '/sdcard/x.bin'])
    expect(F.catArgs(SERIAL, `${PRIV}/f`, RUNAS)).toEqual([
      '-s', SERIAL, 'exec-out', 'run-as', PKG, 'cat', `${PRIV}/f`
    ])
    expect(F.catArgs(SERIAL, '/data/f', SU)).toEqual(['-s', SERIAL, 'exec-out', 'su', '-c', 'cat', '/data/f'])
  })
  it('mkdir -p / mv / rm -rf', () => {
    expect(F.mkdirArgs(SERIAL, '/sdcard/New')).toEqual(['-s', SERIAL, 'shell', 'mkdir', '-p', '/sdcard/New'])
    expect(F.renameArgs(SERIAL, '/sdcard/a', '/sdcard/b')).toEqual(['-s', SERIAL, 'shell', 'mv', '/sdcard/a', '/sdcard/b'])
    expect(F.deleteArgs(SERIAL, ['/sdcard/a', '/sdcard/b'])).toEqual([
      '-s', SERIAL, 'shell', 'rm', '-rf', '/sdcard/a', '/sdcard/b'
    ])
    expect(F.deleteArgs(SERIAL, [`${PRIV}/c`], RUNAS)).toEqual([
      '-s', SERIAL, 'shell', 'run-as', PKG, 'rm', '-rf', `${PRIV}/c`
    ])
  })
})

describe('accessFor', () => {
  it('public paths use a plain shell', () => {
    expect(F.accessFor('/sdcard', null)).toEqual({ runAs: null, su: false })
    expect(F.accessFor('/sdcard', PKG)).toEqual({ runAs: null, su: false })
  })
  it('app-private paths use run-as <pkg>', () => {
    expect(F.accessFor(PRIV, PKG)).toEqual({ runAs: PKG, su: false })
    expect(F.accessFor(`${PRIV}/databases`, PKG)).toEqual({ runAs: PKG, su: false })
  })
  it("another app's private dir is not run-as-able for this pkg", () => {
    expect(F.accessFor('/data/data/com.other', PKG)).toEqual({ runAs: null, su: false })
  })
  it('Root (su) mode wraps everything in su, even private paths', () => {
    expect(F.accessFor('/sdcard', null, true)).toEqual({ runAs: null, su: true })
    expect(F.accessFor(PRIV, PKG, true)).toEqual({ runAs: null, su: true })
  })
})

describe('path helpers', () => {
  it('joinPath handles the root and trailing slashes', () => {
    expect(F.joinPath('/', 'sdcard')).toBe('/sdcard')
    expect(F.joinPath('/sdcard', 'DCIM')).toBe('/sdcard/DCIM')
    expect(F.joinPath('/sdcard/', 'DCIM')).toBe('/sdcard/DCIM')
  })
  it('parentPath climbs one level, bottoms out at /', () => {
    expect(F.parentPath('/sdcard/DCIM')).toBe('/sdcard')
    expect(F.parentPath('/sdcard')).toBe('/')
    expect(F.parentPath('/')).toBe('/')
    expect(F.parentPath('foo')).toBe('/')
    expect(F.parentPath('/sdcard/DCIM/')).toBe('/sdcard')
  })
  it('isAppPrivate respects the package boundary', () => {
    expect(F.isAppPrivate(PRIV, PKG)).toBe(true)
    expect(F.isAppPrivate(`${PRIV}/files`, PKG)).toBe(true)
    expect(F.isAppPrivate(`${PRIV}x`, PKG)).toBe(false) // prefix but not a boundary
    expect(F.isAppPrivate('/sdcard', PKG)).toBe(false)
    expect(F.isAppPrivate(PRIV, null)).toBe(false)
  })
})

describe('humanSize', () => {
  it('bytes are integer + no decimal; KB and up carry one decimal', () => {
    expect(F.humanSize(null)).toBe('')
    expect(F.humanSize(0)).toBe('0 B')
    expect(F.humanSize(512)).toBe('512 B')
    expect(F.humanSize(1024)).toBe('1.0 KB')
    expect(F.humanSize(1536)).toBe('1.5 KB')
    expect(F.humanSize(1048576)).toBe('1.0 MB')
    expect(F.humanSize(5 * 1024 * 1024 * 1024)).toBe('5.0 GB')
  })
})

describe('parseLsLine', () => {
  it('parses a directory (folders keep their ls size)', () => {
    const e = F.parseLsLine('drwxrwx--x 4 u0_a123 u0_a123 4096 2024-01-02 03:04 files')
    expect(e).toEqual<FileEntry>({
      name: 'files',
      kind: 'dir',
      size: 4096,
      mode: 'drwxrwx--x',
      linkTarget: null,
      modified: '2024-01-02 03:04'
    })
  })
  it('parses a file (extension + type derived later)', () => {
    const e = F.parseLsLine('-rw-rw---- 1 u0_a1 u0_a1 128 2024-05-06 07:08 config.json')!
    expect(e.kind).toBe('file')
    expect(e.size).toBe(128)
    expect(e.name).toBe('config.json')
    expect(F.ext(e)).toBe('json')
    expect(F.typeLabel(e)).toBe('JSON file')
  })
  it('parses a symlink into name + target', () => {
    const e = F.parseLsLine('lrwxrwxrwx 1 root root 21 2009-01-01 00:00 sdcard -> /storage/self/primary')!
    expect(e.kind).toBe('link')
    expect(e.name).toBe('sdcard')
    expect(e.linkTarget).toBe('/storage/self/primary')
    expect(F.typeLabel(e)).toBe('Shortcut')
  })
  it('parses a char device node (size field is "major, minor")', () => {
    const e = F.parseLsLine('crw-rw-rw- 1 root root 10, 59 2024-01-02 03:04 null')!
    expect(e.kind).toBe('other')
    expect(e.size).toBeNull()
    expect(e.name).toBe('null')
    expect(e.modified).toBe('2024-01-02 03:04')
    expect(F.typeLabel(e)).toBe('System file')
  })
  it('keeps spaces in filenames; a leading-dot file has no extension', () => {
    const spaced = F.parseLsLine('-rw-rw---- 1 u0 u0 10 2024-01-01 00:00 my file.txt')!
    expect(spaced.name).toBe('my file.txt')
    expect(F.ext(spaced)).toBe('txt')
    const dot = F.parseLsLine('-rw------- 1 u0 u0 5 2024-01-01 00:00 .bashrc')!
    expect(dot.name).toBe('.bashrc')
    expect(F.ext(dot)).toBe('')
    expect(F.typeLabel(dot)).toBe('File')
  })
  it('ignores blanks and the "total" header', () => {
    expect(F.parseLsLine('')).toBeNull()
    expect(F.parseLsLine('total 24')).toBeNull()
    expect(F.parseLsLine('nonsense')).toBeNull()
  })
})

describe('classifyListing', () => {
  const dirLine = 'drwxr-xr-x 2 u0 u0 4096 2024-01-01 00:00 Zed'
  const fileLine = '-rw-rw---- 1 u0 u0 12 2024-01-01 00:00 apple.txt'

  it('sorts directories first, then case-insensitively by name', () => {
    const r = F.classifyListing(0, `${fileLine}\n${dirLine}\n`, '')
    expect(r.error).toBeNull()
    expect(r.entries!.map((e) => e.name)).toEqual(['Zed', 'apple.txt'])
  })
  it('maps a missing path / not-a-directory to "not found"', () => {
    expect(F.classifyListing(1, '', 'ls: /foo: No such file or directory').error).toBe('not found')
    expect(F.classifyListing(1, '', 'ls: /f/x: Not a directory').error).toBe('not found')
  })
  it("flags run-as refusal as 'blocked'", () => {
    expect(F.classifyListing(1, '', "run-as: package not debuggable: com.example.app").error).toBe('blocked')
  })
  it("maps permission errors to 'denied'", () => {
    expect(F.classifyListing(1, '', 'ls: /data: Permission denied').error).toBe('denied')
    expect(F.classifyListing(1, '', 'Operation not permitted').error).toBe('denied')
  })
  it('surfaces any other error text', () => {
    const r = F.classifyListing(1, '', 'some other failure')
    expect(r.entries).toBeNull()
    expect(r.error).toBe('some other failure')
  })
})

describe('extGroup + tintFor (drawn-icon grouping)', () => {
  const mk = (name: string, kind: F.FileKind = 'file'): FileEntry => ({
    name,
    kind,
    size: 1,
    mode: '-rw-rw----',
    linkTarget: null,
    modified: ''
  })
  it('groups extensions', () => {
    expect(F.extGroup('png')).toBe('img')
    expect(F.extGroup('mp4')).toBe('media')
    expect(F.extGroup('apk')).toBe('archive')
    expect(F.extGroup('json')).toBe('code')
    expect(F.extGroup('xyz')).toBeNull()
  })
  it('tints files by group; folders / links / untyped files get no tint', () => {
    expect(F.tintFor(mk('photo.PNG'))).toBe(F.TINTS.img)
    expect(F.tintFor(mk('clip.mp4'))).toBe(F.TINTS.media)
    expect(F.tintFor(mk('data.bin'))).toBeNull()
    expect(F.tintFor(mk('folder', 'dir'))).toBeNull()
    expect(F.tintFor(mk('link', 'link'))).toBeNull()
  })
})
