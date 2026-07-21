# Android Auto head unit in the Electron app — implementation plan

Goal: an **Android Auto tab** in AndroidLab — plug in (or adb-connect) an Android phone and the
Mac renders the phone's projected car UI (Maps / media / assistant) with touch + audio, like a
software head unit. This ports the protocol stack already built in
[`android-headunit/`](../android-headunit/) (Kotlin, ~2.5k lines) to TypeScript, reusing the
Electron app's existing H.264 → WebCodecs mirror pipeline.

## Why this is feasible

- Android Auto's head-unit side is **pure software**: TLS + protobuf, no MFi-style hardware gate
  (see `android-headunit/PROVENANCE.md`).
- The protocol is **byte-identical over TCP** — `android-headunit`'s `SocketLink.kt` already runs
  the same stack over a plain socket for wireless AA. So we don't need USB AOAP on macOS at all.
- The Electron app already has the hard client pieces: an Annex-B H.264 → WebCodecs render path
  (`MirrorEngine` in `src/renderer/components/MirrorDock.tsx`, `AnnexBDemuxer` in
  `src/core/mirror.ts`), bundled adb + `adb forward` plumbing, and a proven arm's-length
  helper-process supervision pattern (`src/main/services/iosmirror.ts`, `goios.ts`).

## Transport decision: TCP via `adb forward` (the DHU trick)

Google's own Desktop Head Unit works this way and it's the natural fit for a dev tool:

1. On the phone: Android Auto app → developer mode (tap the version 10×) → menu →
   **Start head unit server** (listens on `tcp:5277` on the phone).
2. On the Mac: `adb -s <serial> forward tcp:<local> tcp:5277`, connect a socket, speak the
   AA (GAL) protocol over it. Head unit = TLS client, same JVC Kenwood cert.

No `node-usb`, no Bluetooth, no new native deps. USB AOAP is a possible later phase (§Phase 7);
wireless AA (BT RFCOMM bootstrap) is out of scope on macOS.

## Architecture: GPL-contained helper process

The protocol/protos/cert derive from **aasdk + headunit-revived (GPLv3)**. To keep the main app
uncontaminated, all protocol code lives in a standalone helper, spawned at arm's length —
mirroring the `vendor/go-ios` / `native/macos/airplay` precedent:

```
vendor/aa-headunit/          # GPLv3 — own LICENSE + PROVENANCE.md
  src/
    frame.ts                 # AA frame codec + multi-frame reassembly   (port of AapTransport.kt, 202 ln)
    crypto.ts                # TLS-over-messages                          (port of AapCrypto.kt, 163 ln)
    proto.ts                 # minimal hand-written protobuf messages     (see below)
    control.ts               # version → TLS → auth → service discovery   (port of ControlChannel.kt, 153 ln)
    discovery.ts             # our service-discovery response             (port of DiscoveryResponse.kt, 127 ln)
    video.ts                 # video channel: open/AV-setup/focus/ack     (port of VideoChannel logic)
    input.ts                 # touchscreen advert + InputEventIndication  (port of InputChannel.kt, 48 ln)
    audio.ts                 # media/guidance/speech channels → PCM out   (port of MediaChannel.kt/AudioSink.kt)
    sensors.ts               # driving status / night mode                (port of SensorChannel.kt, 69 ln)
    cli.ts                   # standalone entry: connect, log, dump streams
    helper.ts                # app entry: framed stdio protocol to Electron main
  assets/headunit_cert.pem + headunit_key.pem   # copied from android-headunit/app/src/main/assets/
```

- Runs via **`utilityProcess.fork()`** from Electron main (a Node child, no extra binary to
  build/sign). Note the workspace quirk: unset `ELECTRON_RUN_AS_NODE` where relevant.
- Helper ↔ main speaks a thin **length-prefixed binary protocol over stdio**: out = `h264` /
  `pcm` / `event(json)` frames; in = `start(config)` / `touch` / `key` / `stop`. Modeled on
  `iosairplay.ts`'s stdin-control contract (portable, no signals).
- Main-side supervisor `src/main/services/aaheadunit.ts` copies the `IosMirrorService` template:
  spawn, stream demux → callbacks, liveness flag, respawn, `shutdown()`.

### Protobuf strategy

The repo has **no `.proto` sources** — only headunit-revived's pre-generated Java (8 files).
The head unit only touches ~20 message types (version, SSL handshake wrapper, auth complete,
service discovery req/resp, channel open, AV setup/start/stop/ack, video focus, audio focus,
input event, sensor, ping). Hand-write exactly that subset as `protobufjs` definitions in
`proto.ts`, field numbers cross-checked against the vendored Java
(`com/andrerinas/headunitrevived/aap/protocol/proto/*.java`) and headunit-revived upstream.
Do **not** try to port all 96 aasdk protos.

### TLS-over-messages (the riskiest port)

AA runs the TLS handshake and per-message encryption *inside* protocol frames, not on the raw
socket. Node approach: an in-memory duplex pair — `tls.connect({ socket: sideA, cert, key,
rejectUnauthorized: false, maxVersion/minVersion: 'TLSv1.2' })`; ciphertext appears on `sideB`,
gets framed as `SSL_HANDSHAKE` / encrypted-channel payloads; incoming payload bytes are written
to `sideB` and plaintext emerges from the TLSSocket. Two known sharp edges:

1. **Write alignment** — each plaintext message must map to a contiguous ciphertext run for one
   AA frame. Serialize writes through a queue and collect `sideB` output per write before
   framing the next.
2. If Node's stream timing makes (1) unreliable, fall back to porting the explicit
   pump-loop shape `AapCrypto.kt` already implements with `SSLEngine` (wrap/unwrap with
   explicit buffers) using a small WASM/forge TLS. Try the duplex-pair approach first.

## Phases

### Phase 0 — protocol truth on the Android rig (recommended, can run in parallel)

The Kotlin receiver currently connects and opens all 9 channels **but video never renders**
(paused mid-debug 2026-07-19). That failure is either protocol-side (will reproduce in TS) or
`MediaCodec`-side (won't — WebCodecs path is proven). Before or alongside Phase 2, spend a
bounded effort on the Android rig capturing a **byte-level log of the video channel-open /
AV-setup / first-frames exchange** (and compare against headunit-revived on the same phone).
Deliverable: a known-good message trace to port against, or a confirmed "decoder-side" verdict.

### Phase 1 — helper CLI: transport + handshake ✅ exit = channel list

- `vendor/aa-headunit` scaffold (own `package.json`, `tsconfig`, GPLv3 LICENSE, PROVENANCE.md).
- `frame.ts` (codec + reassembly), `crypto.ts` (TLS), `proto.ts` (subset), `control.ts`,
  `discovery.ts`.
- `cli.ts`: given a serial → `adb forward tcp:0 tcp:5277` → connect → version handshake → TLS →
  auth complete → receive the phone's service discovery request → respond → print the offered
  channels. Remove the forward on exit.
- **Milestone (real device):** phone shows the "connected to car" state; CLI prints the channel
  list — parity with where the Kotlin app is today.

### Phase 2 — video channel in the CLI ✅ exit = playable H.264 file

- `video.ts`: advertise a display in the discovery response (start 800×480@30 or 1280×720,
  match `HeadUnitConfig.kt`), answer channel-open + AV-setup, grant video focus, ack every
  frame (the phone stops sending without acks — the Kotlin code has a video-focus watchdog;
  port it).
- CLI `--dump video.h264` writes the raw Annex-B stream; verify with `ffprobe` / mpv.
- **Milestone:** a playable capture of the phone's car UI. This is the phase where Phase 0's
  trace pays off.

### ✅ PHASE 4 DONE (2026-07-21) — audio path

Audio now plays through the tab. The helper tags each PCM chunk with its format
(`{channel, rate, channels, data}` — media 48 kHz stereo, speech/system 16 kHz mono, from the
sinks `discovery.ts` advertises), main relays it on a new `aa:pcm` channel, and
`AndroidAutoView` plays it with a **new Web Audio path** (`PcmPlayer`): per-channel gapless
scheduling ahead of the clock, all mixed through one master gain = the **🔊/🔇 mute button** in
the live bar. Audio is unlocked on the Start click (autoplay policy). No new deps, no AudioWorklet
needed.

**Verified:** typecheck (node+web) + build clean; a headless harness against the A55 received
**511 PCM chunks / 4.2 MB on the media channel at the correct 48 kHz stereo** — the helper format
map, IPC relay, and message shape all confirmed data-flowing. (PCM streams as soon as the media
sink channel is set up.) The audible check (real speakers) is the remaining human step.

**Mic upstream (Assistant / voice — added after touch was confirmed working):** the phone opens
the MIC channel when Assistant/voice is invoked in the projected UI; the head unit answers, then
streams the Mac's mic as `MEDIA_DATA` (`[ts:8 BE µs][pcm]`, 16 kHz mono 16-bit — the advertised
mic sink). Path: `channels.ts` `MediaChannel.sendMicData` + `onMic` callback → `session.ts`
`sendMic()` + `micOpen` event → helper relays `micOpen` up / takes `micData` down → main
`aa:mic-open` event + `aa:mic-data` handler → `AndroidAutoView` `MicCapture` (getUserMedia →
resample to 16 kHz mono Int16 → `micData`), with a pulsing 🎤 indicator in the live bar. Main
grants the renderer `media` permission (`index.ts`); `NSMicrophoneUsageDescription` added for
packaged builds. **Verified:** 2 new unit tests (mic framing + request→response→`onMic`), 14/14
passing. The getUserMedia capture + audible Assistant loop is a human test (needs a real mic +
the macOS mic-permission grant on first use; tap the Assistant/mic button in the projected UI).

### ✅ PHASE 3 DONE (2026-07-21) — Android Auto tab wired into the Electron app

The **Android Auto tab** is built and integrated (android-only, gated in `capabilities.ts`):

- `vendor/aa-headunit/src/electron-helper.ts` — arm's-length `utilityProcess` entry (kept
  electron-free; talks over `process.parentPort` with a small JSON protocol). Runs the `:5288`
  server + `AaSession`; streams `h264`/`pcm`/`status`/`streaming`/`ended` up, takes `start`/
  `touch`/`stop` down.
- `src/main/services/aaheadunit.ts` — `AaHeadUnitService`: forks the helper, waits for its
  ephemeral port, fires the gearhead wireless-startup broadcast via the bundled adb (this Mac's
  LAN IPv4 + that port), relays frames/status to the renderer and touches back down. Registered in
  `ipc.ts` (`aa:*` channels + `cleanup()`), exposed via preload/`api.ts` as `window.androidlab.androidAuto`.
- `src/renderer/components/AndroidAutoView.tsx` — decodes the H.264 with WebCodecs (reusing the
  mirror's `AnnexBDemuxer`), letterbox-presents on a canvas, forwards pointer down/move/up as AA
  touches (device coords). Start/Stop + status line + a first-run Wi-Fi/dev-mode hint.
- Packaging: `scripts/build-aa-headunit.js` stages the compiled helper + certs into
  `resources/aa-headunit/`; wired into `npm run dist` and `electron-builder.yml` extraResources.

**Verified:** full typecheck + production build clean. A headless Electron harness exercised the
exact runtime mechanism (`utilityProcess.fork` + `parentPort` + adb-fired trigger from main) live
against the A55 → full handshake → **video streaming, 200 frames relayed through the IPC path**.
The renderer decode reuses the already-proven mirror pipeline. Remaining: a human click-through of
the GUI tab (launch app → Android Auto tab → Start → watch + touch).

Next: Phase 4 audio (`onPcm` is relayed to the service but not yet decoded in the renderer — needs
an AudioWorklet path; none exists today).

### ✅ VERIFIED END-TO-END (2026-07-21) — wireless trigger, video streaming

**The head unit works.** Live on the Galaxy A55 (AA 17.1): the Mac ran the `:5288` head-unit
**server** (`src/server.ts`), a single adb broadcast fired the wireless trigger, the phone
connected to the Mac, and the full session completed:

```
version 1.7 negotiated → TLS established → auth complete → service discovery answered →
phone opened all 9 channels (SENSOR, VIDEO, INPUT, 3×AUDIO, MIC, MEDIA_PB, NAV) →
video focus PROJECTED → ★ VIDEO STREAMING
```

Captured 2.5 MB / 1107 frames of **H.264 1280×720 yuv420p**, ffmpeg-decoded to a PNG showing the
real Android Auto car UI (Google Maps + Home suggestion + media widget + dock + clock). This is
the milestone the Kotlin `android-headunit/` never reached ("no video").

**The correct transport is the wireless trigger, roles reversed from DHU: the phone connects to
US.** The Mac runs a TCP server; we fire Google's hidden wireless-startup broadcast at the phone
(port of `helper/AaTrigger.kt`), pointing it at the Mac's LAN IP:port. No node-usb, no AOAP, no
5277. The trigger works **directly over adb** — the helper APK is not required for the direct-IP
path:

```
adb -s <serial> shell am broadcast \
  -n com.google.android.projection.gearhead/com.google.android.apps.auto.wireless.setup.receiver.WirelessStartupReceiver \
  -a com.google.android.apps.auto.wireless.setup.receiver.wirelessstartup.START \
  --es ip_address <MAC_LAN_IP> --ei projection_port 5288
```

Prereqs that held: phone + Mac on the same Wi-Fi subnet; AA developer mode on; Mac firewall not
blocking inbound 5288. The whole ported protocol stack ran unchanged over the accepted socket —
`SocketLink` works as a server-accepted connection exactly as it did as a client.

**Superseded:** the 5277/DHU-client analysis below and the AOAP pivot are both moot — kept only as
a record of why the wireless-server path is the right one.

<details><summary>Earlier (superseded) transport finding — 5277/DHU dead end</summary>

### ⚠️ Transport finding (2026-07-21) — the 5277/DHU choice is wrong; use AOAP

Live testing against the A55 (AA 17.1) invalidated this plan's core transport decision. With the
phone's head-unit server started (5277 confirmed listening, `0x149D`), the socket **connects and
stays open**, but the phone **ignores everything we send** — the AA version request at every
protocol version (1.1/1.2/1.4/1.6/1.7), every frame-flags byte (0x01/03/05/07/0b/0f), and a raw
transport-level TLS ClientHello all get **zero bytes back**. It is not our framing: the bytes are
byte-identical to what `AapTransport.kt` emits.

Root cause: **none of the reference implementations are 5277 *clients*.** aasdk, headunit-revived,
and this repo's `android-headunit/` are all the *head-unit role that the phone connects TO* — over
USB/AOAP (head unit = USB **host**, triggers AA via AOAP identity strings in `UsbAoap.kt`) or
wireless (phone connects to the head unit's `:5288` server, `WirelessServer.kt`). The git history
confirms the **verified** working path is AOAP (`f3c9218 working video projection`). Connecting to
the phone's 5277 head-unit server as a GAL client — this plan's assumption — was never part of the
reference and does not speak the plain version-request-first protocol on modern AA. Getting 5277 to
work would need ground-truth bytes from Google's own Desktop Head Unit (not on this machine, and
guessing has not converged).

**Revised transport: AOAP with the Mac as USB host** (this plan's old Phase 6, now the *primary*
path — it is the direct analog of the verified `UsbAoap.kt`). Node side: `usb`/`node-usb`
(libusb) does `getProtocol` → 6 identity strings (manufacturer `Android`, model `Android Auto`) →
`ACC_REQ_START`; the phone re-enumerates as an AOAP accessory (VID `0x18D1`, PID `0x2D0x`); claim
the bulk IN/OUT endpoints and drive the **existing** protocol stack over them.

**What survives unchanged:** the entire ported stack (`frame`/`crypto`/`proto`/`discovery`/
`control`/`channels`/`session`, 12 tests incl. real TLS) sits above the `AapLink` interface exactly
as the Kotlin does. The pivot is a **new `AapLink` implementation only** (`UsbAoapLink` replacing
`SocketLink`) — no protocol changes. Tradeoffs to weigh: `node-usb` is a native dep; AOAP takes the
phone's USB away from adb (it re-enumerates as an accessory); macOS USB access + a phone-side
"allow Android Auto accessory" prompt apply.

</details>

### Implementation status (2026-07-21)

The `vendor/aa-headunit/` helper is **built and passing 12 offline tests**, including a real
TLS-over-messages handshake against a Node TLS server standing in for the phone (the riskiest
port). Modules: `pb.ts`/`proto.ts` (hand-written proto2 subset), `frame.ts` (AapTransport port),
`crypto.ts` (TLS-over-messages), `discovery.ts`, `control.ts`, `channels.ts`, `session.ts`,
`adb.ts`, `cli.ts`.

**Live check against the Galaxy A55 (192.168.68.101, AA 17.1) — blocked on phone-side state, not
our code.** adb-forward + socket connect work; the version request transmits with correct
framing. But the phone's head-unit server **accepts the TCP connection then sends FIN after
~155ms even when we send zero bytes** — so it is not rejecting our protocol, it is refusing the
session outright. Root cause: the DHU-style head-unit server (AA dev settings → "Start head unit
server") behaves as a one-shot — my initial liveness probe was accepted as "the session", and
once that socket dropped the server stopped accepting new connections until re-armed by tapping
the phone. The A55 is a headless Wi-Fi adb device (nobody present to tap), and the re-arm is a
manual developer-settings toggle with no adb/`am` entry point (screen was confirmed on+unlocked;
guessed `HeadUnitServer` activity does not exist). **To finish Phase 1/2:** someone taps "Start
head unit server" on the phone immediately before `node dist/src/cli.js --serial <s> --verbose
--dump out.h264`, and does NOT let anything else connect first. Do not run a throwaway probe
against 5277 — it consumes the one-shot.

### Phase 3 — Electron integration: tab + rendering + touch ✅ exit = interactive head unit

Follow the standard 5-touch-point tab pattern (see the Location tab / `add-device-tool` skill):

- `src/main/services/aaheadunit.ts` — supervisor (utilityProcess fork, stdio demux, respawn,
  `shutdown()`); owns the `adb forward` lifecycle (create on start, **always remove** on stop).
- Channels in `src/shared/ipc.ts` (`aa:*`), handlers in `src/main/ipc.ts`
  (broadcast `aa:h264` like `mirror:h264` at ipc.ts:404), preload + `src/shared/api.ts` types.
- `src/renderer/components/AndroidAutoView.tsx` — reuse `MirrorEngine` + `AnnexBDemuxer`
  verbatim for decode/present; canvas pointer events → display coords → `aa:touch` →
  helper → `InputEventIndication` (PRESS/DRAG/RELEASE, multi-touch later).
- Tab registration in `App.tsx` `TABS` + switch, `tabSupported` = android-only.
- **UX:** the tab needs a first-run guide (enable AA developer mode → Start head unit server)
  with a Start/Stop button and clear status line (per the always-handle-loaders rule). Detect
  "connection refused" → show "head unit server not running" guidance.
- Register the service in `ipc.ts cleanup()` (window closed + before-quit): kill helper,
  remove forward — no orphaned forwards/processes (CLAUDE.md rule 3/4 ethos).
- **Milestone (real device):** Maps renders in the tab, taps navigate.

### Phase 4 — audio ✅ exit = music + navigation prompts audible

- `audio.ts`: media (48 kHz stereo s16) + guidance (16 kHz mono) + speech channels; audio focus
  grants; PCM frames out over the helper protocol.
- **New renderer path (none exists today):** `AudioContext` + `AudioWorklet` ring buffer per
  stream, mixed; mute button. If PCM-over-IPC jitters, fall back to playing in the helper via
  a tiny native dep — but try the renderer path first (zero new deps).
- Mic upstream (assistant voice input) is **out of scope** for this phase; revisit later
  (`MicRecorder.kt` is the map).

### Phase 5 — robustness + ship polish

- Sensors channel: driving status, **night mode** (follow macOS appearance), required
  periodic sensor batches.
- Ping/keepalive + stall watchdog; auto-reconnect on socket drop; multi-device correctness
  (follow the selected serial; stop cleanly on device switch).
- Byte-frame unit tests for `frame.ts`/`proto.ts` fixtures (captured from Phase 1/2 traces)
  in the helper package.
- Packaging: bundle the helper build into `resources/`; GPL notice — PROVENANCE.md +
  "this component is GPLv3" note in the app's about/licenses; keep the arm's-length process
  boundary documented.

### Phase 6 (optional, later) — USB AOAP transport

For phones without developer mode: `node-usb` (libusb) AOAP accessory-start (port of
`UsbAoap.kt`) inside the helper; everything above the link layer is unchanged (`AapLink`
abstraction already proves this). New native dep + macOS USB permission surface — only do it
if the adb-forward path proves too fiddly for real use. **Wireless AA: not planned** (needs
Bluetooth RFCOMM bootstrap; hostile on macOS from Node).

## Risks

| Risk | Mitigation |
|---|---|
| TLS-over-frames alignment in Node streams | Serialized write queue; fallback to explicit wrap/unwrap pump (§above) |
| Old JVC Kenwood cert rejected by newer AA builds | Known OpenAuto-era caveat; test early on the A55 (Phase 1 proves it); document min/max AA versions |
| Head-unit-server (5277) protocol differs subtly from USB | It's what DHU uses — same GAL protocol; Phase 1 CLI verifies before any UI work |
| Hand-written proto subset has wrong field numbers | Cross-check against vendored generated Java; fixtures from real traces in tests |
| Video bug inherited from the Kotlin project | Phase 0 trace; WebCodecs path is independently proven, so a decoder-side cause vanishes |
| PCM audio over IPC jitters | AudioWorklet ring buffer; helper-side native playback as fallback |

## Test rig

Phone with Android Auto set up (Galaxy A55 / SM-A556E, serial `R5CX22ZBQYJ`) + AA developer
mode + "Start head unit server". Every phase milestone is verified against the real device —
smoke/compile passing is not "working" (CLAUDE.md rule 5).

## Effort shape

The Kotlin protocol core relevant to phases 1–4 is ~1,300 lines (transport 202, crypto 163,
control 153, discovery 127, media 119, input/sensors/config ~350) with the message flow already
debugged once — this is a port, not a reverse-engineering effort. The genuinely new work is the
TLS-over-streams plumbing, the proto subset, and the audio path.
