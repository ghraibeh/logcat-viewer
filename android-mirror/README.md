# MobileLabKit Mirror — Android → Android screen mirroring

A **standalone Android app that mirrors one Android phone's screen onto another** over Wi-Fi.
Install it on both devices: run **Cast this screen** on the source and **Receive a screen** on
the target. The source's screen (video only) appears on the target in real time.

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
transport is a plain TCP H.264 stream between two copies of this app — so there is nothing to
authenticate and no privileged permission to hold. The only consent involved is the standard
`MediaProjection` "Start recording/casting?" dialog, which is available to any app.

## How it works

```
 SENDER phone                                          RECEIVER phone
 ────────────                                          ──────────────
 MediaProjection ─► VirtualDisplay ─► MediaCodec        ServerSocket ◄── _mlkmirror._tcp (mDNS)
   (screen)          (AUTO_MIRROR)     H.264 encoder          │
                                          │ Annex-B           ▼
                                   ScreenCaptureService   DataInputStream
                                    (foreground svc)           │
                                          │ TCP  ───────────►  VideoDecoder (MediaCodec)
                                     framed units                  │
                                                                   ▼
                                                            SurfaceView (full screen)
```

Wire format ([MirrorProtocol.kt](app/src/main/java/com/mobilelabkit/mirror/MirrorProtocol.kt)):
`magic "MLK1" + width + height`, then repeated `len(int32) · kind(int8: 0=video frame,
1=video SPS/PPS, 2=audio PCM) · payload`. The Android AVC encoder emits an Annex-B byte stream,
which is exactly what the shared
[VideoDecoder](app/src/main/java/com/mobilelabkit/mirror/VideoDecoder.kt) (ported from
`android-chromecast` / `android-airplay`) consumes. **Audio** is captured with
`AudioPlaybackCapture` (the sender's playback mix, tied to the same MediaProjection — no mic),
streamed as raw 48 kHz stereo 16-bit PCM, and played on the receiver via `AudioTrack`.

| Piece | File |
|---|---|
| Role picker (Cast / Receive) | [HomeActivity.kt](app/src/main/java/com/mobilelabkit/mirror/HomeActivity.kt) |
| Receiver: advertise + TCP server + decode → SurfaceView | [ReceiverActivity.kt](app/src/main/java/com/mobilelabkit/mirror/ReceiverActivity.kt) |
| Sender: browse receivers, capture consent, hand off | [SenderActivity.kt](app/src/main/java/com/mobilelabkit/mirror/SenderActivity.kt) |
| Foreground service that owns one cast session | [ScreenCaptureService.kt](app/src/main/java/com/mobilelabkit/mirror/ScreenCaptureService.kt) |
| MediaProjection → VirtualDisplay → H.264 encoder | [ScreenEncoder.kt](app/src/main/java/com/mobilelabkit/mirror/ScreenEncoder.kt) |
| H.264 Annex-B → Surface decoder (shared) | [VideoDecoder.kt](app/src/main/java/com/mobilelabkit/mirror/VideoDecoder.kt) |
| mDNS advertise (receiver) + browse/resolve (sender) | [MirrorDiscovery.kt](app/src/main/java/com/mobilelabkit/mirror/MirrorDiscovery.kt) |
| Wire framing | [MirrorProtocol.kt](app/src/main/java/com/mobilelabkit/mirror/MirrorProtocol.kt) |

**Dependency-light on purpose** — pure platform APIs (MediaProjection, MediaCodec, NsdManager,
TCP sockets), zero third-party libraries, same ethos as the sibling receivers.

## Supported Android versions

`minSdk 26`, `target/compileSdk 34`.

| Capability | Requires | Notes |
|---|---|---|
| Install / run | **Android 8.0 (API 26)** | minimum; NsdManager + MediaProjection + MediaCodec |
| Screen mirroring (video) | **Android 8.0+** | both roles |
| **Audio forwarding** | **Android 10 (API 29)+ on the sender** | `AudioPlaybackCapture` is API 29; on 8–9 the sender is video-only (code gates on API ≥ 29) |
| Receiver | **Android 8.0+** | only decodes video + plays PCM — no audio-capture API needed |

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

1. Put both phones on the **same Wi-Fi** (a normal home/office AP — not guest isolation).
2. On the **target**: open MobileLabKit Mirror ▸ **Receive a screen**. It shows "Waiting…" with the
   receiver name (`<model> (Mirror)`) and its IP.
3. On the **source**: open MobileLabKit Mirror ▸ **Cast this screen**, wait for the target to appear
   in the list, tap it, and accept the **Start casting** consent dialog.
4. The source screen appears on the target. Tap **Stop casting** on the source to end.

## Known limitations / notes (v1)

- **One-way, no input back-channel** — the receiver shows the screen + plays audio but sends
  nothing back (same view-only model as the AirPlay receiver).
- **Audio plays on BOTH devices by default.** `AudioPlaybackCapture` copies the sender's audio mix
  without muting it, so the caster keeps playing out loud while the receiver plays the forwarded
  copy (slight echo if they're in the same room). The sender screen has a **"Mute this phone while
  casting"** toggle (default on): when audio is being forwarded it silences the caster's media
  volume for the session and restores it on stop — capture is volume-independent, so the receiver
  keeps full audio. Uncheck it to hear audio on both. (Muting is skipped if audio isn't being
  forwarded, and may be blocked by a Do-Not-Disturb policy that locks volume.)
- **Some apps' audio can't be captured.** Apps that set `allowAudioPlaybackCapture=false` or use
  `FLAG_SECURE` (many DRM/streaming apps) produce silence over the audio path; the video still
  mirrors. Audio requires the sender granting the mic permission (playback capture uses
  `AudioRecord`); denied → video-only.
- **Scaled to fill.** The receiver's SurfaceView stretches to the screen; a portrait source on a
  different-shaped target can look stretched. Aspect-fit / letterbox is a follow-up.
- **Long edge capped at 1280 px** with drop-oldest backpressure to stay live on a busy link.
- **Fixed orientation per session.** The VirtualDisplay is sized once at cast start; rotating the
  source mid-cast isn't re-negotiated yet.
- **Same-subnet Wi-Fi only** — mDNS doesn't cross routed VLANs / client isolation. A
  `MulticastLock` is held (Android drops inbound multicast otherwise).
- **Android 14**: screen capture runs in a `mediaProjection` foreground service; the projection
  callback is registered and `getMediaProjection()` is called only after entering the foreground,
  per the Android 14 contract.

## Status

Builds clean (`assembleDebug`) and **verified end-to-end on hardware**: casting a **Galaxy A55
(Android 16, sender)** onto a **Huawei NAM-LX9 (Android 12, receiver)** over Wi-Fi — hardware H.264
encode (`c2.exynos.h264.encoder`) → decode (`c2.qti.avc.decoder`) with the screen mirroring live,
plus the playback-audio path running on both ends (`AudioPlaybackCapture` → `AudioTrack`).
