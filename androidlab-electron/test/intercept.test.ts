/**
 * Network Intercept parity tests — TS equivalents of the intercept checks in
 * tests/smoke.py: TLS SNI parsing, HTTP head/url/status parsing, the flow
 * filter (method / status-class / substring / regex + invalid-regex error),
 * curl + export formatting, gzip body decode, the proxy-restore / watchdog
 * command builders, and human-size formatting.
 */
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  FlowFilterSpec,
  clearProxyArgs,
  headerGet,
  humanSize,
  makeFlow,
  parseHead,
  parseSni,
  parseStatus,
  proxyRestoreCmd,
  proxyWatchdogScript,
  realProxy,
  restoreProxyArgs,
  reverseArgs,
  setProxyArgs,
  splitUrl,
  type FlowMatchable
} from '@core/intercept'
import { buildFlowExport, decodeBody, flowToCurl, prettyBody } from '@core/interceptBody'

/** Craft a minimal TLS ClientHello record carrying `host` as the SNI. */
function clientHelloWithSni(host: string): Buffer {
  const name = Buffer.from(host, 'latin1')
  // server_name extension data: list_len(2) name_type(1) name_len(2) name
  const entry = Buffer.concat([Buffer.from([0x00]), u16(name.length), name])
  const extData = Buffer.concat([u16(entry.length), entry])
  const ext = Buffer.concat([u16(0x0000), u16(extData.length), extData]) // type=server_name
  const extensions = ext
  const body = Buffer.concat([
    Buffer.from([0x03, 0x03]), // client version
    Buffer.alloc(32), // random
    Buffer.from([0x00]), // session id length = 0
    u16(2),
    Buffer.from([0x00, 0x2f]), // cipher suites (one)
    Buffer.from([0x01, 0x00]), // compression methods (one: null)
    u16(extensions.length),
    extensions
  ])
  const handshake = Buffer.concat([Buffer.from([0x01]), u24(body.length), body]) // ClientHello
  return Buffer.concat([Buffer.from([0x16, 0x03, 0x01]), u16(handshake.length), handshake])
}
function u16(n: number): Buffer {
  return Buffer.from([(n >> 8) & 0xff, n & 0xff])
}
function u24(n: number): Buffer {
  return Buffer.from([(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff])
}

describe('parseSni', () => {
  it('extracts the SNI host from a ClientHello', () => {
    expect(parseSni(clientHelloWithSni('example.com'))).toBe('example.com')
    expect(parseSni(clientHelloWithSni('api.github.com'))).toBe('api.github.com')
  })
  it('returns null for non-TLS / short / malformed input', () => {
    expect(parseSni(Buffer.alloc(0))).toBeNull()
    expect(parseSni(Buffer.from('GET / HTTP/1.1\r\n\r\n'))).toBeNull()
    expect(parseSni(Buffer.from([0x16, 0x03, 0x01, 0x00, 0x05, 0x02]))).toBeNull() // not a ClientHello
  })
})

describe('parseHead', () => {
  it('splits the start-line and headers', () => {
    const raw = Buffer.from('GET /a HTTP/1.1\r\nHost: x\r\nAccept: */*\r\n\r\nbodybytes')
    const [start, headers] = parseHead(raw)
    expect(start).toBe('GET /a HTTP/1.1')
    expect(headers).toEqual([
      ['Host', 'x'],
      ['Accept', '*/*']
    ])
  })
  it('headerGet is case-insensitive and first-match', () => {
    const headers: Array<[string, string]> = [
      ['Content-Type', 'application/json'],
      ['content-type', 'text/plain']
    ]
    expect(headerGet(headers, 'CONTENT-TYPE')).toBe('application/json')
    expect(headerGet(headers, 'missing')).toBeNull()
  })
})

describe('splitUrl', () => {
  it('parses absolute-form proxy targets', () => {
    expect(splitUrl('http://example.com/foo')).toEqual(['http', 'example.com', 80, '/foo'])
    expect(splitUrl('https://a.b:8443/x/y')).toEqual(['https', 'a.b', 8443, '/x/y'])
    expect(splitUrl('http://h')).toEqual(['http', 'h', 80, '/'])
    expect(splitUrl('example.com/y')).toEqual(['http', 'example.com', 80, '/y'])
  })
  it('drops userinfo and defaults the port by scheme', () => {
    expect(splitUrl('http://user:pw@host/p')).toEqual(['http', 'host', 80, '/p'])
    expect(splitUrl('https://host/p')).toEqual(['https', 'host', 443, '/p'])
  })
})

describe('parseStatus', () => {
  it('reads the numeric status, else null', () => {
    expect(parseStatus('HTTP/1.1 200 OK')).toBe(200)
    expect(parseStatus('HTTP/1.1 404 Not Found')).toBe(404)
    expect(parseStatus('HTTP/1.1 xyz')).toBeNull()
    expect(parseStatus('')).toBeNull()
  })
})

describe('FlowFilterSpec.match', () => {
  const mk = (method: string, status: number | null, search: string): FlowMatchable => ({ method, status, search })

  it('filters by method (case-insensitive, ""=any)', () => {
    const spec = new FlowFilterSpec({ method: 'post' }).compile()
    expect(spec.match(mk('POST', 200, 'x /a'))).toBe(true)
    expect(spec.match(mk('GET', 200, 'x /a'))).toBe(false)
    expect(new FlowFilterSpec({ method: '' }).compile().match(mk('GET', 200, 'x'))).toBe(true)
  })
  it('filters by status class (2/3/4/5)', () => {
    const spec = new FlowFilterSpec({ statusClass: 4 }).compile()
    expect(spec.match(mk('GET', 404, 'x'))).toBe(true)
    expect(spec.match(mk('GET', 200, 'x'))).toBe(false)
    expect(spec.match(mk('GET', null, 'x'))).toBe(false)
  })
  it('filters by substring over host+path', () => {
    const spec = new FlowFilterSpec({ textQuery: 'API' }).compile()
    expect(spec.match(mk('GET', 200, 'api.example.com /v1'))).toBe(true)
    expect(spec.match(mk('GET', 200, 'cdn.example.com /img'))).toBe(false)
  })
  it('filters by regex (IGNORECASE)', () => {
    const spec = new FlowFilterSpec({ textQuery: '/v\\d+/users', textRegex: true }).compile()
    expect(spec.hasError('text')).toBe(false)
    expect(spec.match(mk('GET', 200, 'api.x /v2/users'))).toBe(true)
    expect(spec.match(mk('GET', 200, 'api.x /v/users'))).toBe(false)
  })
  it('flags an invalid regex and keeps the stream flowing', () => {
    const spec = new FlowFilterSpec({ textQuery: '(', textRegex: true }).compile()
    expect(spec.hasError('text')).toBe(true)
    // invalid regex => text field inactive => everything matches
    expect(spec.match(mk('GET', 200, 'anything'))).toBe(true)
  })
})

describe('flowToCurl', () => {
  it('emits method/url/headers and inlines a UTF-8 body', () => {
    const f = makeFlow({
      method: 'POST',
      scheme: 'https',
      host: 'api.x',
      port: 443,
      path: '/v',
      reqHeaders: [
        ['Content-Type', 'application/json'],
        ['Content-Length', '2']
      ],
      reqBody: Buffer.from('{}')
    })
    const curl = flowToCurl(f)
    expect(curl).toContain("curl -X POST 'https://api.x/v'")
    expect(curl).toContain("-H 'Content-Type: application/json'")
    expect(curl).not.toContain('Content-Length') // stripped
    expect(curl).toContain("--data-raw '{}'")
  })
})

describe('buildFlowExport', () => {
  it('dumps request + response with headers and bodies', () => {
    const f = makeFlow({
      method: 'GET',
      scheme: 'http',
      host: 'h',
      port: 80,
      path: '/p',
      status: 200,
      reqHeaders: [['Accept', '*/*']],
      respHeaders: [['Content-Type', 'text/plain']],
      respBody: Buffer.from('hello'),
      durationMs: 12,
      respSize: 5,
      bodyCaptured: true
    })
    const text = buildFlowExport(f)
    expect(text).toContain('# GET http://h/p')
    expect(text).toContain('===== REQUEST =====')
    expect(text).toContain('Accept: */*')
    expect(text).toContain('===== RESPONSE =====')
    expect(text).toContain('HTTP 200')
    expect(text).toContain('hello')
  })
  it('notes an un-captured (encrypted) response', () => {
    const f = makeFlow({
      method: 'CONNECT',
      scheme: 'https',
      host: 'h',
      port: 443,
      path: '',
      bodyCaptured: false,
      note: 'encrypted — enable Decrypt HTTPS to see contents'
    })
    expect(buildFlowExport(f)).toContain('encrypted — enable Decrypt HTTPS to see contents')
  })
})

describe('decodeBody / prettyBody', () => {
  it('round-trips a gzip-encoded body', () => {
    const original = JSON.stringify({ hello: 'world', n: 7 })
    const gz = gzipSync(Buffer.from(original))
    const headers: Array<[string, string]> = [
      ['Content-Encoding', 'gzip'],
      ['Content-Type', 'application/json']
    ]
    const decoded = decodeBody(gz, headers)
    expect(Buffer.from(decoded ?? Buffer.alloc(0)).toString('utf8')).toBe(original)
    // pretty_body decompresses AND pretty-prints JSON
    expect(prettyBody(gz, headers)).toBe(JSON.stringify(JSON.parse(original), null, 2))
  })
  it('leaves plain bodies untouched and marks binary', () => {
    const plain = Buffer.from('just text')
    expect(Buffer.from(decodeBody(plain, []) ?? Buffer.alloc(0)).toString()).toBe('just text')
    const bin = Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80])
    expect(prettyBody(bin, [])).toMatch(/bytes binary/)
  })
})

describe('proxy command builders', () => {
  it('reverseArgs / setProxyArgs / clearProxyArgs target the serial', () => {
    expect(reverseArgs('S1', 8099)).toEqual(['-s', 'S1', 'reverse', 'tcp:8099', 'tcp:8099'])
    expect(setProxyArgs('S1', 8099)).toEqual([
      '-s',
      'S1',
      'shell',
      'settings',
      'put',
      'global',
      'http_proxy',
      '127.0.0.1:8099'
    ])
    expect(clearProxyArgs('S1').slice(-1)).toEqual([':0'])
  })

  it('realProxy keeps a genuine prior proxy, discards ours / null / :0 / unsafe', () => {
    expect(realProxy('10.0.0.1:8080')).toBe('10.0.0.1:8080')
    expect(realProxy('')).toBe('')
    expect(realProxy('null')).toBe('')
    expect(realProxy(':0')).toBe('')
    expect(realProxy('127.0.0.1:8099')).toBe('')
    expect(realProxy('evil;rm -rf')).toBe('') // shell metacharacters rejected
  })

  it('restoreProxyArgs restores verbatim or disables with :0', () => {
    expect(restoreProxyArgs('S1', '10.0.0.1:8080').slice(-1)).toEqual(['10.0.0.1:8080'])
    expect(restoreProxyArgs('S1', '').slice(-1)).toEqual([':0']) // no prior proxy => clear
    expect(proxyRestoreCmd('10.0.0.1:8080')).toBe('settings put global http_proxy 10.0.0.1:8080')
    expect(proxyRestoreCmd('')).toBe('settings put global http_proxy :0')
  })

  it('proxyWatchdogScript restores on SIGHUP AND on stdin-EOF (unclean drop), but not on a clean read', () => {
    const s = proxyWatchdogScript('10.0.0.1:8080')
    const restore = 'settings put global http_proxy 10.0.0.1:8080'
    // signal path: trap restores then exits so it can't double-run the || branch
    expect(s).toContain(`trap '${restore}; exit 0' HUP INT TERM`)
    // EOF path: read failure (no PTY ⇒ no SIGHUP, only EOF) runs the restore
    expect(s).toContain(`read _ 2>/dev/null || ${restore}`)
    // the buggy disarm form must be gone — it left the proxy dangling on drop
    expect(s).not.toContain('trap - HUP INT TERM')
  })
})

describe('humanSize', () => {
  it('formats B / KB / MB', () => {
    expect(humanSize(512)).toBe('512 B')
    expect(humanSize(2048)).toBe('2.0 KB')
    expect(humanSize(3 * 1024 * 1024)).toBe('3.0 MB')
  })
})
