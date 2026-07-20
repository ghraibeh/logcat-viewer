# MobileLabKit Mirror — Android → Android screen mirroring

A **standalone Android app that mirrors one Android phone onto another** over Wi-Fi — **screen,
audio, and (optionally) touch control**. Install it on both devices: run **Cast this screen** on
the source and **Receive a screen** on the target. The source's screen + audio appear on the
target in real time, and the target can drive the source back with taps and swipes.

## Why this exists (and why it's a separate app from the receivers)

We looked at making a homebrew Android device receive the phone's **native** cast, and every
native path is walled for a non-privileged app:

| Native path | Discovery | Receive video | Blocked by |
|---|---|---|---|
| **Chromecast** (`android-chromecast`) | ✅ open mDNS | ❌ | Google-signed device cert (CASTV2 device-auth) |
| **Miracast** | ❌ | ✅ (easy) | `CONFIGURE_WIFI_DISPLAY` — a `signature`/system permission to advertise the WFD IE |
| **AirPlay** (`android-airplay`) | ✅ open mDNS | ✅ | nothing — FairPlay is software-only (Apple senders only) |

AirPlay cleanly covers **iOS/macOS → Android**, but Android has **no native AirPlay sender**, so
it can't do **Android → Android**. Rather than fight a wall, this app **owns both ends**: it does
not touch the OS cast picker at all. Discovery is our own mDNS service (`_mlkmirror._tcp`) and the
transport is a plain TCP stream between two copies of this app — so there is nothing to
authenticate and no privileged permission to hold. The only consent involved is the standard
`MediaProjection` "Start recording/casting?" dialog, and (for touch control) the user enabling our
accessibility service — both available to any app.

## How it works

```
 SENDER phone                                          RECEIVER phone
 ────────────                                          ──────────────
 MediaProjection ─► VirtualDisplay ─► ScreenEncoder     ServerSocket ◄── _mlkmirror._tcp (mDNS)
   (screen)          (AUTO_MIRROR)    (H.264, realtime)      │  fixed port 8899
 AudioPlaybackCapture ─► AudioCapturer                       ▼
   (playback mix)        (48k stereo PCM)              readHeader → readUnit loop
                                   │                          │
                            ScreenCaptureService              ├─► VideoDecoder (MediaCodec) ─► SurfaceView
                             (foreground svc)                 └─► AudioPlayer (AudioTrack)
                                   │  framed units
                                   │  TCP  ───────────────────►
                                   ▲
             MirrorAccessibility  │  ◄─────────────────────── touch events (reverse channel)
             .dispatchGesture ◄───┘                            captured from the SurfaceView
             (taps/swipes)
```

- **Video**: `MediaProjection → VirtualDisplay(AUTO_MIRROR) → MediaCodec` H.264 encoder emits an
  Annex-B byte stream, which the shared `VideoDecoder` (MediaCodec → Surface) renders full-screen.
- **Audio**: `AudioPlaybackCapture` (the sender's playback mix, tied to the same MediaProjection —
  **no mic**) → raw 48 kHz stereo 16-bit PCM → `AudioTrack` on the receiver.
- **Touch** (optional): the receiver captures touches on its SurfaceView and streams them back over
  the same socket; the sender's `MirrorAccessibilityService` replays them with `dispatchGesture`.

### Wire protocol

[MirrorProtocol.kt](app/src/main/java/com/mobilelabkit/mirror/MirrorProtocol.kt) — big-endian,
because we own both ends there is nothing to negotiate:

```
stream  := header  unit*                                      (sender → receiver)
header  := magic(4)="MLK1"  capW(i32) capH(i32)  realW(i32) realH(i32)
unit    := len(i32)  kind(i8: 0=video, 1=config SPS/PPS, 2=audio PCM)  payload[len]

touch   := type(i8=1)  action(i8: 0=down,1=move,2=up,3=cancel)  x(i32) y(i32)  dtMs(i32)
                                                              (receiver → sender, same socket)
```

`capW/capH` are the (downscaled) encode size — advisory decoder hints; the decoder derives its true
video size from the SPS. `realW/realH` are the sender's **real** display pixels — the coordinate
space `dispatchGesture` injects into, so the receiver maps its touch `(x,y)` into it. `dtMs` is the
gap since the previous touch event, used to pace the injected stroke to the real finger's speed.

| Piece | File |
|---|---|
| Role picker (Cast / Receive) | [HomeActivity.kt](app/src/main/java/com/mobilelabkit/mirror/HomeActivity.kt) |
| Receiver: advertise + TCP server + decode + audio + touch capture | [ReceiverActivity.kt](app/src/main/java/com/mobilelabkit/mirror/ReceiverActivity.kt) |
| Sender: browse receivers, capture consent, mute/touch options, hand off | [SenderActivity.kt](app/src/main/java/com/mobilelabkit/mirror/SenderActivity.kt) |
| Foreground service owning one cast session (encode + stream + backpressure + mute + touch relay) | [ScreenCaptureService.kt](app/src/main/java/com/mobilelabkit/mirror/ScreenCaptureService.kt) |
| MediaProjection → VirtualDisplay → H.264 encoder | [ScreenEncoder.kt](app/src/main/java/com/mobilelabkit/mirror/ScreenEncoder.kt) |
| H.264 Annex-B → Surface decoder | [VideoDecoder.kt](app/src/main/java/com/mobilelabkit/mirror/VideoDecoder.kt) |
| System-audio capture (`AudioPlaybackCapture`) | [AudioCapturer.kt](app/src/main/java/com/mobilelabkit/mirror/AudioCapturer.kt) |
| PCM playback on the receiver (`AudioTrack`) | [AudioPlayer.kt](app/src/main/java/com/mobilelabkit/mirror/AudioPlayer.kt) |
| Touch injection on the sender (`dispatchGesture`) | [MirrorAccessibilityService.kt](app/src/main/java/com/mobilelabkit/mirror/MirrorAccessibilityService.kt) |
| mDNS advertise (receiver) + browse/resolve (sender) | [MirrorDiscovery.kt](app/src/main/java/com/mobilelabkit/mirror/MirrorDiscovery.kt) |
| Wire framing | [MirrorProtocol.kt](app/src/main/java/com/mobilelabkit/mirror/MirrorProtocol.kt) |

**Dependency-light on purpose** — pure platform APIs (MediaProjection, MediaCodec, NsdManager, TCP
sockets, AccessibilityService), zero third-party libraries, same ethos as the sibling receivers.

## Features

### 1. Screen mirroring (video)
Hardware H.264 both ends. Long edge is capped at **960 px** and bitrate at **1.5–4 Mbps**
(`w·h·30·0.15`, clamped) — deliberately modest to keep latency low on a busy Wi-Fi link.

### 2. Audio forwarding
System playback mix only (no mic). **Audio plays on BOTH devices by default** — `AudioPlaybackCapture`
copies the mix without silencing it. The sender screen has a **"Mute this phone while casting"**
toggle (default **on**): it silences the caster's media volume for the session and restores it on
stop (capture is volume-independent, so the receiver keeps full audio). Uncheck to hear both.

### 3. Touch control (remote input) — optional, opt-in
The receiver can drive the sender: touches on the receiver's SurfaceView stream back and are
replayed on the sender via `AccessibilityService.dispatchGesture`. Enabled with the **"Enable touch
control"** checkbox on the sender, which deep-links to Settings (an app can't flip its own
accessibility switch). View-only if left off — same model as the AirPlay receiver.

## The latency & correctness engineering (hard-won — don't regress)

The first cut had multi-second lag and corruption. The fixes, all still in place:

- **Shallow queues (depth 6) on both ends.** Buffer depth ÷ fps *is* the latency floor; deep queues
  (the original 90/120) buy nothing but lag. See `queue` in
  [ScreenCaptureService.kt](app/src/main/java/com/mobilelabkit/mirror/ScreenCaptureService.kt) and
  [VideoDecoder.kt](app/src/main/java/com/mobilelabkit/mirror/VideoDecoder.kt).
- **Never drop a mid-GOP P-frame silently** — TCP is in-order/reliable, so a drop that skips a P-frame
  corrupts the picture until the next keyframe. On sender-side overflow we `queue.clear()`,
  `encoder.requestKeyFrame()`, and set `droppingUntilKeyframe` so we resume cleanly at the next IDR.
  Config units (SPS/PPS) go to the **front** of the queue (`putFirst`) and are never dropped.
- **Receiver blocks, doesn't drop.** The decoder input `offer`s with a 2 s timeout before a
  last-resort drop — pushing the drop decision back to the sender (which can resync with a keyframe)
  instead of corrupting locally.
- **Realtime encoder**: `KEY_I_FRAME_INTERVAL=1` (1 s keyframes), `KEY_PRIORITY=0` (realtime),
  `KEY_LATENCY=1`, VBR. Decoder sets `low-latency=1`. 128 KB socket send buffer.
- **Fixed listen port 8899 + `SO_REUSEADDR`** (ephemeral fallback) so a reconnect doesn't hit
  `ECONNREFUSED` after the receiver restarts.

### Touch-injection design (also easy to regress)

- **Dispatch ONE _complete_ down→up stroke on finger-up**, built from the accumulated points — a
  complete stroke is what apps recognise as a real click/scroll. A held/"continued" stroke reads as
  a long-press or an unfinished gesture and **never fires the view's click handler** (the "it looks
  clicked but nothing happens" bug).
- **Zero accessibility events.** The service sets `eventTypes = 0` (and the config requests none) —
  it *only* injects. A `typeAllMask` service makes the system generate + dispatch every UI event to
  us, stealing CPU from the capture/encode pipeline and adding mirror latency.
- **Coordinates in real display pixels** via `getRealMetrics()` — the exact space MediaProjection
  captures and `dispatchGesture` injects into (fixes a ~50 px offset).
- **Enable the service _after_ the cast is running** (so the process is alive to bind), and
  **re-enable it after any reinstall/force-stop** — Android disables an accessibility service on
  force-stop.

## Connectivity — what works, and the Bluetooth question

**Requires both phones on the same Layer-2 Wi-Fi subnet** — mDNS discovery doesn't cross routed
VLANs or client isolation, and a `MulticastLock` is held (Android drops inbound multicast otherwise).

- ✅ **Same Wi-Fi AP** (normal home/office, no guest isolation) — the standard path.
- ✅ **Phone hotspot, no router needed today, zero code changes:** make one phone a Wi-Fi hotspot and
  join the other to it — same subnet, mDNS works, full Wi-Fi bandwidth. (The hotspot phone has no
  internet meanwhile.)
- ❌ **Bluetooth — no.** Not a permission wall (we own both ends); a **bandwidth** wall. The stream is
  ~**3.5–7.5 Mbps** (video 1.5–4 Mbps + **raw PCM audio ~1.5 Mbps**), while Bluetooth PAN sustains
  only ~**1–2 Mbps** — the raw audio alone exceeds the whole Bluetooth budget. Our TCP stream *could*
  ride a Bluetooth PAN interface, but fitting it would mean gutting video to ~500 kbps and dropping
  or re-encoding audio, and Bluetooth's latency/jitter would wreck the low latency above. Not worth
  building.
- 🔜 **Wi-Fi Direct (Wi-Fi P2P) — the right router-free path, not yet implemented.** Full Wi-Fi
  bandwidth + low latency, direct device-to-device, public `WifiP2pManager` API (group owner at a
  known `192.168.49.1`, so we could skip mDNS). Bluetooth/BLE could still serve as the discovery /
  tap-to-pair handshake, with the stream over Wi-Fi Direct.

## Supported Android versions

`minSdk 26`, `target/compileSdk 34`.

| Capability | Requires | Notes |
|---|---|---|
| Install / run | **Android 8.0 (API 26)** | NsdManager + MediaProjection + MediaCodec |
| Screen mirroring (video) | **Android 8.0+** | both roles |
| **Audio forwarding** | **Android 10 (API 29)+ on the sender** | `AudioPlaybackCapture` is API 29; on 8–9 the sender is video-only (code gates on API ≥ 29) |
| **Touch control** | **Android 8.0+** | `dispatchGesture` is API 24; needs the user to enable the accessibility service |
| Receiver | **Android 8.0+** | decodes video + plays PCM + captures touch — no capture API needed |

Version-specific handling built in: runtime `POST_NOTIFICATIONS` on API 33+, typed foreground
service (`mediaProjection`|`microphone`) + projection-callback-before-`getMediaProjection()` on
API 34+. The two ends may run different Android versions (verified Android 16 sender → Android 12
receiver).

## Build

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"  # a JDK 17–21
./gradlew :app:assembleDebug
# -> app/build/outputs/apk/debug/app-debug.apk
```

Gradle 8.7 · AGP 8.5.2 · Kotlin 1.9.24 · compileSdk/targetSdk 34 · minSdk 26.

## Install & use

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk   # on BOTH phones
```

1. Put both phones on the **same Wi-Fi** (or one phone's **hotspot** with the other joined).
2. On the **target**: MobileLabKit Mirror ▸ **Receive a screen** → shows "Waiting…" with the
   receiver name (`<model> (Mirror)`) and its IP.
3. On the **source**: MobileLabKit Mirror ▸ **Cast this screen**, wait for the target to appear, tap
   it, accept the **Start casting** consent. (Optional: tick **Mute this phone while casting** /
   **Enable touch control** first.)
4. The source screen + audio appear on the target. If touch control is on, tap/swipe on the target
   to drive the source. Tap **Stop casting** on the source to end.

## Known limitations / notes

- **Scaled to fill.** The receiver's SurfaceView stretches to the screen; a portrait source on a
  differently-shaped target can look stretched. Aspect-fit / letterbox is a follow-up.
- **Long edge capped at 960 px** (drop-oldest + keyframe-resync backpressure) to stay live and
  low-latency — a quality/latency trade, not a hard limit.
- **Fixed orientation per session.** The VirtualDisplay is sized once at cast start; rotating the
  source mid-cast isn't re-negotiated yet.
- **Some apps' audio can't be captured.** Apps that set `allowAudioPlaybackCapture=false` or use
  `FLAG_SECURE` (many DRM/streaming apps) produce silence on the audio path; video still mirrors.
  Audio also needs the mic permission granted (playback capture uses `AudioRecord`); denied → video-only.
- **Touch control is opt-in and OS-gated** — the user must enable the accessibility service, and
  re-enable it after any reinstall/force-stop.
- **Same-subnet Wi-Fi only** (see Connectivity). Bluetooth transport isn't supported by design.

## Status

Builds clean (`assembleDebug`) and **verified end-to-end on hardware**: a **Galaxy A55 (Android 16)**
casting to a **Huawei NAM-LX9 (Android 12)** over Wi-Fi — hardware H.264 encode
(`c2.exynos.h264.encoder`) → decode (`c2.qti.avc.decoder`), screen live, playback audio on both
ends (`AudioPlaybackCapture` → `AudioTrack`), and remote touch control driving the caster (swipe
opened the app drawer, tap opened Settings). Latency confirmed good after the queue/keyframe/backpressure
tuning above.
