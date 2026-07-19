# MobileLabKit AirPlay — Android receiver

A **standalone Android app that receives AirPlay screen mirroring** from an iPhone/iPad.
Install it on an Android phone or tablet, open it, then on the iOS device pick it in
**Control Center ▸ Screen Mirroring** — the iOS screen mirrors onto the Android device,
with audio.

It is the Android sibling of MobileLabKit's desktop AirPlay receiver
(`androidlab-electron/native/macos/airplay`) and **reuses the exact same vendored RPiPlay
core** — the RAOP + FairPlay handshake, the `bonjour_shim` mDNS advertiser, and the
fdk-aac audio path. Only the platform glue differs: on the desktop the receiver writes
H.264 to stdout for an Electron/WebCodecs view; here it decodes H.264 on the phone's own
hardware decoder (MediaCodec → SurfaceView).

> AirPlay **receiving** is software-only (FairPlay), which is why this is possible on a
> non-Apple device at all — unlike CarPlay, which is gated behind MFi *hardware* auth.

## Architecture

```
 iPhone  ──AirPlay/RAOP over Wi-Fi──►  libairplay.so (this app's JNI lib)
                                        │   vendored RPiPlay core (GPL-3.0)
                                        │   + bonjour_shim mDNS advertiser (no OS Bonjour)
                                        │   + FairPlay (OpenSSL)
                                        │   + AAC-ELD audio ─ fdk-aac ─► miniaudio (AAudio)
                                        │
                        video_process ──┼──► JNI onVideoFrame(Annex-B H.264)
                                        ▼
                              VideoDecoder (MediaCodec) ──► SurfaceView (full screen)
```

| Piece | File |
|---|---|
| JNI bridge (replaces the desktop `airplayscreen.c` main; forwards video, plays audio) | [app/src/main/cpp/jni_bridge.c](app/src/main/cpp/jni_bridge.c) |
| Native build (reuses the core in-place, links the prebuilt deps) | [app/src/main/cpp/CMakeLists.txt](app/src/main/cpp/CMakeLists.txt) |
| Kotlin JNI front door | [app/src/main/java/com/mobilelabkit/airplay/NativeReceiver.kt](app/src/main/java/com/mobilelabkit/airplay/NativeReceiver.kt) |
| H.264 → Surface decoder | [app/src/main/java/com/mobilelabkit/airplay/VideoDecoder.kt](app/src/main/java/com/mobilelabkit/airplay/VideoDecoder.kt) |
| Full-screen Activity + Wi-Fi/multicast locks | [app/src/main/java/com/mobilelabkit/airplay/MainActivity.kt](app/src/main/java/com/mobilelabkit/airplay/MainActivity.kt) |
| Native-deps cross-compile | [deps/build-android-deps.sh](deps/build-android-deps.sh) |

The RPiPlay core itself is **not duplicated** — CMake references it at
`../../../../../androidlab-electron/native/macos/airplay` so the desktop and Android
receivers stay in lockstep (single source of truth).

## Build

Prerequisites: Android SDK + **NDK 26.3.11579264**, CMake 3.22, and a **JDK 17** (Android
Studio's bundled JBR works). Autotools + OpenSSL's build deps are only needed the first
time (to cross-compile the native libs).

```bash
# 1. Cross-compile the native deps (OpenSSL + libplist + fdk-aac) for the phone's ABI.
#    One-time; cached under deps/prebuilt/. Needs network to fetch the pinned tarballs.
deps/build-android-deps.sh                 # arm64-v8a (covers the A55 + arm64 emulators)
# ABIS="arm64-v8a x86_64" deps/build-android-deps.sh   # also Intel emulators

# 2. Build the APK.
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"  # a JDK 17/21
./gradlew :app:assembleDebug
# -> app/build/outputs/apk/debug/app-debug.apk
```

Or just **open `android-airplay/` in Android Studio** and Run (do step 1 in a terminal
first — the Gradle build fails fast with a message if the prebuilt deps are missing).

## Install & use

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

1. Put the Android device and the iPhone on the **same Wi-Fi network**.
2. Launch **MobileLabKit AirPlay** on Android — it shows "Waiting for iPhone…" with the
   name it's advertising (**`MobileLabKit.android`**) and its IP.
3. On the iPhone: **Control Center ▸ Screen Mirroring ▸** pick that name.
4. The iPhone's screen (and audio) appear on the Android device. **Tap** the screen to
   mute/unmute the mirror audio.

## Known limitations / notes

- **Wi-Fi only, same subnet.** mDNS discovery doesn't cross routed VLANs / client
  isolation / most emulator NAT. Use real devices on a normal home/office AP. The app
  holds a `MulticastLock` (required — Android drops inbound multicast otherwise).
- **View-only.** AirPlay carries no input channel back to the iPhone (touch forwarding
  stays on MobileLabKit's USB path).
- **Video is scaled to fill** the screen in v1 (no letterboxing yet); a portrait iPhone on
  a portrait phone looks right, a tablet may stretch. Aspect-fit is a follow-up.
- **AAC-ELD audio** is decoded natively with fdk-aac (same as desktop), so it doesn't
  depend on the device's codec support.
- **Advertised name**: `MobileLabKit.android` (distinct from the desktop's
  "MobileLabKit"). The dot inside the instance name is legal DNS-SD — it's escaped to a
  single wire label via the `mdns.h` `\.` edit (see the desktop PROVENANCE); the shim
  keeps a plain form for query matching.
- **mDNS on Android needs three things** (all handled by the app, documented here for
  posterity): a `MulticastLock` (else inbound multicast is dropped by the Wi-Fi chip),
  `bindProcessToNetwork(wifi)` + `IP_MULTICAST_IF` pinned to the wlan0 IPv4 (else
  outbound multicast never egresses — `sendto` succeeds silently), and multicast TTL 255
  (RFC 6762 §11).
- Port 5353 (mDNS) can occasionally clash with the system resolver on some OEM builds; if
  advertising fails, the app surfaces an error — close other AirPlay apps and reopen.

## License

Because it links the RPiPlay core, the built APK is a **GPL-3.0** work — see
[app/src/main/cpp/../../../../../androidlab-electron/native/macos/airplay/PROVENANCE.md](../androidlab-electron/native/macos/airplay/PROVENANCE.md)
and [PROVENANCE.md](PROVENANCE.md).
