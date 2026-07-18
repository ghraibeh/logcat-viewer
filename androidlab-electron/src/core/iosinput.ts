/**
 * iOS UI automation (touch/keyboard forwarding) over go-ios — pure argv builders +
 * parsers, kept side-effect-free for tests. The renderer's iOS mirror is view-only
 * until an on-device automation agent (WebDriverAgent or go-ios DeviceKit) is signed
 * and installed; that needs an Apple signing identity, which the user supplies as an
 * App Store Connect API key (Key ID + Issuer ID + a `.p8` private key). go-ios then
 * exposes `ui tap|swipe|type|button|size` for injection.
 *
 * Flow: `sign provision appstoreconnect` (ASC key -> P12 + provisioning profile) ->
 * `ui install (devicekit|wda)` (sign + install the agent) -> start the tunnel + agent
 * -> `ui tap/swipe/type` while mirroring. macOS/usbmux is the transport (go-ios).
 */

/** Which on-device automation agent to sign + install. DeviceKit is go-ios's own
 *  (richer button set); WebDriverAgent is the Appium standard (home button only). */
export type IosAgent = 'devicekit' | 'wda'

/** How the user supplies their Apple signing identity:
 *  - 'manual': they already have a signing certificate (`.p12`) + a provisioning
 *    profile (`.mobileprovision`) — e.g. from Xcode automatic signing or the
 *    Developer portal. Works for any team member (no Account-Holder / ASC access).
 *  - 'asc': an App Store Connect API key (Key ID + Issuer ID + `.p8`); go-ios
 *    generates the P12 + profile. Requires ASC API access (Account Holder only). */
export type IosSignMethod = 'manual' | 'asc'

/** ASC API signing identity. The `.p8` is a PRIVATE KEY — referenced by path only. */
export interface IosSigning {
  keyId: string
  issuerId: string
  p8Path: string
  bundleId: string
  agent: IosAgent
}

/** Persisted config. Safe to write to disk: identifiers + file paths, NO key material
 *  (the `.p8`/`.p12` stay on disk; the P12 password is never persisted — see service). */
export interface IosInputConfig {
  method: IosSignMethod
  agent: IosAgent
  // manual route — a signing cert + a device-scoped provisioning profile
  p12Path: string
  /** In-memory only while the modal is open; never written to the config file. */
  p12Password: string
  profilePath: string
  // ASC-API route
  keyId: string
  issuerId: string
  p8Path: string
  bundleId: string
  /** Best-effort flag: the agent has been provisioned + installed at least once. */
  provisioned: boolean
}

export const DEFAULT_BUNDLE_ID = 'com.androidlabkit.uiagent'

export function defaultConfig(): IosInputConfig {
  return {
    method: 'manual',
    // WDA is the wired runtime: go-ios can LAUNCH it (`runwda`) and we forward its
    // port. DeviceKit has no exposed launcher in go-ios, so `ui` can't reach it.
    agent: 'wda',
    p12Path: '',
    p12Password: '',
    profilePath: '',
    keyId: '',
    issuerId: '',
    p8Path: '',
    bundleId: DEFAULT_BUNDLE_ID,
    provisioned: false
  }
}

/** Enough to run the ASC provisioning flow (all identity fields present). */
export function ascReady(c: Pick<IosInputConfig, 'keyId' | 'issuerId' | 'p8Path' | 'bundleId'>): boolean {
  return !!(c.keyId.trim() && c.issuerId.trim() && c.p8Path.trim() && c.bundleId.trim())
}

/** Enough to install directly (a cert + a profile). */
export function manualReady(c: Pick<IosInputConfig, 'p12Path' | 'profilePath'>): boolean {
  return !!(c.p12Path.trim() && c.profilePath.trim())
}

/** Whether the currently-selected method has everything it needs. */
export function methodReady(c: IosInputConfig): boolean {
  return c.method === 'asc' ? ascReady(c) : manualReady(c)
}

// --- provisioning + install --------------------------------------------------

/** `ios sign provision appstoreconnect …` → writes a P12 + `.mobileprovision`. */
export function provisionArgs(
  udid: string,
  s: IosSigning,
  p12Out: string,
  profileOut: string,
  profileName = 'MobileLabKit UI Agent'
): string[] {
  return [
    'sign',
    'provision',
    'appstoreconnect',
    `--bundleid=${s.bundleId}`,
    `--asc-key-id=${s.keyId}`,
    `--asc-issuer-id=${s.issuerId}`,
    `--asc-private-key=${s.p8Path}`,
    `--p12-output=${p12Out}`,
    `--profile-output=${profileOut}`,
    `--profile-name=${profileName}`,
    `--udid=${udid}`
  ]
}

/** `ios ui install (devicekit|wda) --p12file --profile [--p12password]` → signs +
 *  installs the agent (downloads the agent IPA itself when `--path` is omitted). */
export function uiInstallArgs(udid: string, agent: IosAgent, p12: string, profile: string, p12password?: string): string[] {
  const a = ['ui', 'install', agent, `--p12file=${p12}`, `--profile=${profile}`]
  if (p12password) a.push(`--p12password=${p12password}`)
  a.push(`--udid=${udid}`)
  return a
}

// --- agent runtime (launch + reach the on-device agent) ----------------------
// The `ui` injection commands don't launch the agent — they connect to one that's
// already listening locally (DeviceKit on :12004, WebDriverAgent on :8100). For WDA
// that means: (1) launch the XCUITest runner with `runwda` (long-lived), and (2)
// `forward` the device's 8100 to localhost so `ui --driver=wda --wda-url` can reach
// it. go-ios installs its own WDA fork, so `runwda`'s Facebook-bundle-id default is
// wrong — discover the real bundle id from the installed apps.

/** Local port WebDriverAgent's HTTP server is forwarded to. */
export const WDA_PORT = 8100
export const WDA_LOCAL_URL = `http://127.0.0.1:${WDA_PORT}`
/** The `.xctest` config name inside go-ios's WDA runner. */
export const WDA_XCTEST_CONFIG = 'WebDriverAgentRunner.xctest'

/** Which backend `ui` talks to + where it listens. WDA is the wired runtime (it has a
 *  launcher: `runwda`); DeviceKit has no exposed launcher in go-ios. */
export interface UiDriverOpts {
  driver: IosAgent
  wdaUrl?: string
  devicekitUrl?: string
}

/** `--driver` (+ matching `--*-url`) flags, appended to every `ui` invocation so it
 *  targets the agent we actually launched rather than the default DeviceKit/:12004. */
export function uiDriverFlags(d?: UiDriverOpts): string[] {
  if (!d) return []
  const f = [`--driver=${d.driver}`]
  if (d.driver === 'wda' && d.wdaUrl) f.push(`--wda-url=${d.wdaUrl}`)
  if (d.driver === 'devicekit' && d.devicekitUrl) f.push(`--devicekit-url=${d.devicekitUrl}`)
  return f
}

/** `ios runwda …` — launch the WDA XCUITest runner (blocks; run as a long-lived child).
 *  All three ids must be the INSTALLED runner's bundle id (go-ios's fork rebrands it). */
export function runWdaArgs(udid: string, bundleId: string): string[] {
  return [
    'runwda',
    `--bundleid=${bundleId}`,
    `--testrunnerbundleid=${bundleId}`,
    `--xctestconfig=${WDA_XCTEST_CONFIG}`,
    `--udid=${udid}`
  ]
}

/** `ios forward <hostPort> <devicePort>` — expose a device port on localhost (blocks). */
export function forwardArgs(udid: string, hostPort: number, devicePort: number): string[] {
  return ['forward', String(hostPort), String(devicePort), `--udid=${udid}`]
}

/** `ios apps --list` — one `"<bundleId> <name> <version>"` line per installed app. */
export function appsListArgs(udid: string): string[] {
  return ['apps', '--list', `--udid=${udid}`]
}

/** Find the installed WebDriverAgent runner's bundle id from `apps --list` output
 *  (go-ios signs it as e.g. `com.deviceboxhq.goios.WebDriverAgentRunner.xctrunner`). */
export function findWdaBundleId(appsListStdout: string): string | null {
  for (const line of appsListStdout.split('\n')) {
    const id = line.trim().split(/\s+/)[0]
    if (/WebDriverAgentRunner\.xctrunner$/i.test(id)) return id
  }
  return null
}

// --- DeviceKit agent (WebSocket JSON-RPC, live-gesture path) ------------------
// DeviceKit (mobile-next) is the other installable agent. Unlike WDA it exposes a
// persistent **WebSocket** (`ws://127.0.0.1:12004/ws`) speaking JSON-RPC 2.0, plus a
// `device.io.gesture` method that takes a full press→move…→release path — so a drag can
// be replayed as the user's ACTUAL finger motion (correct curve + momentum) over one
// live socket, instead of a crude 2-point swipe. (Both agents still bottom out in iOS's
// XCTest event synthesis, ~360ms/gesture — that floor is the device's, not the transport's.)
export const DEVICEKIT_PORT = 12004
export const DEVICEKIT_WS_PATH = '/ws'
export const DEVICEKIT_LOCAL_WS = `ws://127.0.0.1:${DEVICEKIT_PORT}${DEVICEKIT_WS_PATH}`
export const DEVICEKIT_XCTEST_CONFIG = 'devicekit-iosUITests.xctest'

/** `ios runtest …` — launch the DeviceKit XCUITest runner (blocks; long-lived child).
 *  It serves JSON-RPC (HTTP `/rpc` + WS `/ws`) on device port 12004. */
export function runDeviceKitArgs(udid: string, bundleId: string): string[] {
  return ['runtest', `--test-runner-bundle-id=${bundleId}`, `--xctest-config=${DEVICEKIT_XCTEST_CONFIG}`, `--udid=${udid}`]
}

/** Find the installed DeviceKit runner bundle id (`com.mobilenext.devicekit-iosUITests.xctrunner`). */
export function findDeviceKitBundleId(appsListStdout: string): string | null {
  for (const line of appsListStdout.split('\n')) {
    const id = line.trim().split(/\s+/)[0]
    if (/devicekit-iosUITests\.xctrunner$/i.test(id)) return id
  }
  return null
}

/** One `device.io.gesture` action (matches DeviceKit's Codable — all fields required). */
export interface DkAction {
  type: 'press' | 'move' | 'release'
  duration: number // seconds
  x: number
  y: number
  button: number // finger index
}

/** A captured drag sample: device POINTS + a millisecond timestamp. */
export interface DkPathPoint {
  x: number
  y: number
  t: number
}

/** JSON-RPC 2.0 request envelope. */
export function dkRpc(id: number, method: string, params: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: '2.0', id, method, params }
}

export function dkTapParams(x: number, y: number): Record<string, unknown> {
  return { x: Math.round(x), y: Math.round(y), deviceId: 'any' }
}
export function dkTextParams(text: string): Record<string, unknown> {
  return { text, deviceId: 'any' }
}
export function dkButtonParams(name: string): Record<string, unknown> {
  return { button: name, deviceId: 'any' }
}
export function dkGestureParams(actions: DkAction[]): Record<string, unknown> {
  return { actions, deviceId: 'any' }
}

/** A key + held modifiers for `device.io.keys` (DeviceKit). */
export interface DkKeyCombo {
  key: string
  modifiers: string[]
}
export function dkKeysParams(keys: DkKeyCombo[]): Record<string, unknown> {
  return { keys, deviceId: 'any' }
}

// --- keyboard forwarding: DOM key -> agent key -------------------------------
/** DOM `KeyboardEvent.key` → DeviceKit `device.io.keys` identifier. A literal character
 *  is passed through (its case already encodes Shift); named keys map to DeviceKit's set;
 *  returns null for keys DeviceKit can't take (bare modifiers, etc.). */
const DK_NAMED: Record<string, string> = {
  Enter: 'return',
  Backspace: 'backspace',
  Delete: 'forwarddelete',
  Tab: 'tab',
  Escape: 'escape',
  ' ': 'space',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown'
}
export function deviceKitKey(domKey: string): string | null {
  if (DK_NAMED[domKey]) return DK_NAMED[domKey]
  if (domKey.length === 1) return domKey // a literal character
  if (/^F([1-9]|1[0-2])$/.test(domKey)) return domKey.toLowerCase()
  return null
}

/** DOM `KeyboardEvent.key` → WebDriverAgent `/wda/keys` value(s) (W3C key codes for
 *  special keys, the literal char otherwise). Used only on the WDA fallback path. */
const WDA_NAMED: Record<string, string> = {
  Enter: '',
  Backspace: '',
  Delete: '',
  Tab: '',
  Escape: '',
  ' ': ' ',
  ArrowUp: '',
  ArrowDown: '',
  ArrowLeft: '',
  ArrowRight: '',
  Home: '',
  End: '',
  PageUp: '',
  PageDown: ''
}
export function wdaKeyValue(domKey: string): string[] | null {
  if (WDA_NAMED[domKey]) return [WDA_NAMED[domKey]]
  if (domKey.length === 1) return [domKey]
  return null
}

/** Max gesture samples we send — DeviceKit synthesizes them into one event record, so keep
 *  it bounded (a fast drag can fire 100+ mousemoves; ~40 preserves the curve cheaply). */
export const MAX_GESTURE_POINTS = 40

/** Max waypoints for the WebDriverAgent W3C path — kept SMALL on purpose. WDA's W3C→XCTest
 *  synthesizer has a large per-waypoint cost (~150ms/point measured on-device), and worse: at
 *  many points it stretches the playback into a slow crawl that loses the flick's velocity, so
 *  a 40-point drag both lags (~7s) AND barely momentum-scrolls. A handful of points keeps the
 *  gesture fast (~1–1.5s) with strong native momentum — measured best around here. (DeviceKit
 *  builds the path in one native synthesize with no per-point tax, so it keeps MAX_GESTURE_POINTS.) */
export const MAX_POINTER_ACTION_POINTS = 6

/** Build a press→move…→release action list from a captured finger path (device points +
 *  ms timestamps). Each move's `duration` = time since the previous kept point, so the
 *  gesture replays at the user's real speed (giving natural scroll velocity/momentum).
 *  Downsamples evenly to MAX_GESTURE_POINTS while preserving cumulative timing. */
export function pathToGestureActions(points: DkPathPoint[], button = 0): DkAction[] {
  if (points.length === 0) return []
  if (points.length === 1) {
    const p = points[0]
    return [
      { type: 'press', duration: 0, x: Math.round(p.x), y: Math.round(p.y), button },
      { type: 'release', duration: 0, x: Math.round(p.x), y: Math.round(p.y), button }
    ]
  }
  // Downsample the middle, always keeping first + last.
  let kept = points
  if (points.length > MAX_GESTURE_POINTS) {
    kept = []
    const step = (points.length - 1) / (MAX_GESTURE_POINTS - 1)
    for (let i = 0; i < MAX_GESTURE_POINTS; i++) kept.push(points[Math.round(i * step)])
    kept[kept.length - 1] = points[points.length - 1]
  }
  const actions: DkAction[] = [{ type: 'press', duration: 0, x: Math.round(kept[0].x), y: Math.round(kept[0].y), button }]
  for (let i = 1; i < kept.length; i++) {
    const dtSec = Math.max(0, (kept[i].t - kept[i - 1].t) / 1000)
    actions.push({ type: 'move', duration: dtSec, x: Math.round(kept[i].x), y: Math.round(kept[i].y), button })
  }
  const last = kept[kept.length - 1]
  actions.push({ type: 'release', duration: 0, x: Math.round(last.x), y: Math.round(last.y), button })
  return actions
}

/** One item in a W3C Actions pointer sequence (WebDriverAgent `/session/:id/actions`). */
export interface W3CPointerItem {
  type: 'pointerMove' | 'pointerDown' | 'pointerUp' | 'pause'
  duration?: number
  x?: number
  y?: number
  button?: number
}

/** Build a W3C pointer-action sequence that replays a captured finger path FAITHFULLY —
 *  pointerDown at the first point, one `pointerMove` per kept waypoint whose `duration` is
 *  the real inter-sample delay, then pointerUp. Reproducing the per-segment timing preserves
 *  the drag's velocity, so a flick carries iOS momentum-scroll (the whole reason we send the
 *  full path, not just first→last). Downsamples to MAX_GESTURE_POINTS like `pathToGestureActions`.
 *  This is the WebDriverAgent equivalent of DeviceKit's `device.io.gesture` full-path replay —
 *  everything still lands in ONE atomic XCTest event (iOS can't stream touch; see the mirror
 *  input notes), but a single faithful gesture feels far smoother than repeated lifting swipes.
 *  `maxPoints` is deliberately small (see MAX_POINTER_ACTION_POINTS) — WDA's per-waypoint cost
 *  makes a big path both slow and worse for momentum. */
export function pathToPointerActions(points: DkPathPoint[], maxPoints = MAX_POINTER_ACTION_POINTS): W3CPointerItem[] {
  if (points.length === 0) return []
  const round = (p: DkPathPoint): { x: number; y: number } => ({ x: Math.round(p.x), y: Math.round(p.y) })
  if (points.length === 1) {
    const p = round(points[0])
    return [
      { type: 'pointerMove', duration: 0, x: p.x, y: p.y },
      { type: 'pointerDown', button: 0 },
      { type: 'pointerUp', button: 0 }
    ]
  }
  let kept = points
  if (points.length > maxPoints) {
    kept = []
    const step = (points.length - 1) / (maxPoints - 1)
    for (let i = 0; i < maxPoints; i++) kept.push(points[Math.round(i * step)])
    kept[kept.length - 1] = points[points.length - 1]
  }
  const first = round(kept[0])
  const items: W3CPointerItem[] = [
    { type: 'pointerMove', duration: 0, x: first.x, y: first.y },
    { type: 'pointerDown', button: 0 }
  ]
  for (let i = 1; i < kept.length; i++) {
    const p = round(kept[i])
    const dtMs = Math.max(0, Math.round(kept[i].t - kept[i - 1].t))
    items.push({ type: 'pointerMove', duration: dtMs, x: p.x, y: p.y })
  }
  items.push({ type: 'pointerUp', button: 0 })
  return items
}

/** A momentum flick for the mirror's hybrid drag: a target projected from the release point
 *  along the release velocity, plus the swipe duration to play it over. */
export interface FlickSpec {
  x: number
  y: number
  durMs: number
}

/** From the tail of a captured drag path (device points + ms timestamps), compute a momentum
 *  flick for the release: project a target from `up` along the release velocity over
 *  FLICK_PROJECT_MS (so the swipe's velocity ≈ the finger's), clamped to the device bounds.
 *  Returns undefined for a slow release (below FLICK_MIN_SPEED) so the drag just settles at `up`.
 *  Pure so the renderer can feed it straight into `iosInput.drag('end', …, flick)`. */
export function computeFlick(
  path: Array<{ x: number; y: number; t: number }>,
  up: { x: number; y: number },
  size: { width: number; height: number } | null
): FlickSpec | undefined {
  if (path.length < 2) return undefined
  const FLICK_WINDOW_MS = 90 // velocity measured over the last ~90ms of motion
  const FLICK_PROJECT_MS = 90 // ...and projected forward this long → swipe velocity ≈ release velocity
  const FLICK_MIN_SPEED = 300 // device points/sec below which it's a settle, not a flick
  const last = path[path.length - 1]
  let i = path.length - 1
  while (i > 0 && last.t - path[i - 1].t <= FLICK_WINDOW_MS) i--
  const a = path[i]
  const dt = (last.t - a.t) / 1000
  if (dt <= 0) return undefined
  const vx = (last.x - a.x) / dt
  const vy = (last.y - a.y) / dt
  const speed = Math.hypot(vx, vy)
  if (speed < FLICK_MIN_SPEED) return undefined
  let x = up.x + (vx * FLICK_PROJECT_MS) / 1000
  let y = up.y + (vy * FLICK_PROJECT_MS) / 1000
  if (size) {
    x = Math.min(Math.max(x, 0), size.width - 1)
    y = Math.min(Math.max(y, 0), size.height - 1)
  }
  return { x, y, durMs: FLICK_PROJECT_MS }
}

// --- input injection (agent must be running) ---------------------------------

export function uiStatusArgs(udid: string, d?: UiDriverOpts): string[] {
  return ['ui', 'status', `--udid=${udid}`, ...uiDriverFlags(d)]
}

export function uiSizeArgs(udid: string, d?: UiDriverOpts): string[] {
  return ['ui', 'size', `--udid=${udid}`, ...uiDriverFlags(d)]
}

export function uiTapArgs(udid: string, x: number, y: number, d?: UiDriverOpts): string[] {
  return ['ui', 'tap', `--x=${Math.round(x)}`, `--y=${Math.round(y)}`, `--udid=${udid}`, ...uiDriverFlags(d)]
}

/** duration in seconds (go-ios `--duration=<seconds>`); omit for a default flick. */
export function uiSwipeArgs(
  udid: string,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  durationSec?: number,
  d?: UiDriverOpts
): string[] {
  const a = [
    'ui',
    'swipe',
    `--from-x=${Math.round(fromX)}`,
    `--from-y=${Math.round(fromY)}`,
    `--to-x=${Math.round(toX)}`,
    `--to-y=${Math.round(toY)}`
  ]
  if (durationSec && durationSec > 0) a.push(`--duration=${durationSec}`)
  a.push(`--udid=${udid}`)
  a.push(...uiDriverFlags(d))
  return a
}

export function uiTypeArgs(udid: string, text: string, d?: UiDriverOpts): string[] {
  return ['ui', 'type', `--text=${text}`, `--udid=${udid}`, ...uiDriverFlags(d)]
}

/** Presses a hardware button. DeviceKit: home/lock/volumeup/volumedown/… ; WDA: home. */
export function uiButtonArgs(udid: string, button: string, d?: UiDriverOpts): string[] {
  return ['ui', 'button', button, `--udid=${udid}`, ...uiDriverFlags(d)]
}

/** Parse `ui size` JSON → device points. Tolerant of key casing / nesting. */
export function parseUiSize(stdout: string): { width: number; height: number } | null {
  const num = (re: RegExp): number | null => {
    const m = re.exec(stdout)
    return m ? Number(m[1]) : null
  }
  const w = num(/"width"\s*:\s*(\d+(?:\.\d+)?)/i)
  const h = num(/"height"\s*:\s*(\d+(?:\.\d+)?)/i)
  if (w == null || h == null || w <= 0 || h <= 0) return null
  return { width: Math.round(w), height: Math.round(h) }
}
