# MobileLabKit HeadUnit — Android Auto receiver (head unit)

Turn an Android device into a **software Android Auto head unit**: plug an Android phone
into it and the phone projects its Android Auto UI (Maps / media / messaging), with touch
handled by this device. Unlike CarPlay, Android Auto has **no MFi hardware gate** — the
head-unit side is a TLS + protobuf protocol that's been reverse-engineered, so a
pure-software receiver is possible.

This is built from the spec in **[aasdk](https://github.com/f1xpl/aasdk)** / **OpenAuto**
(the reference C++ head-unit stack), reimplemented natively for an Android APK:

| Piece | aasdk (reference) | This APK |
|---|---|---|
| USB transport | libusb + AOAP | **Android USB Host API** (`UsbManager`, control + bulk) |
| TLS | OpenSSL + head-unit cert | `SSLEngine` + the same head-unit cert (Phase 2) |
| Messages | protobuf C++ | **protobuf-javalite** from the aasdk `.proto` (Phase 2) |
| Video | GStreamer | **MediaCodec → Surface** (Phase 3) |
| Audio | Qt audio | **AudioTrack** (Phase 5) |
| Touch → phone | InputEventIndication | same, over the input channel (Phase 4) |

> **Scope note:** Android Auto is **Android-source only** (never iPhones) and projects the
> *car UI*, not a mirror of the phone screen. For general Android phone mirroring + touch,
> use scrcpy (already in the Electron app) — it's simpler and full-screen. This module is
> specifically an Android Auto **head unit**.

## Status — phased build

- **Phase 1 ✓ (this commit): USB / AOAP transport.** Host-side AOAP accessory-start
  (`getProtocol` → 6 identity strings → `start`); the phone re-enumerates as an AOAP
  accessory (VID `0x18D1` / PID `0x2D00`|`0x2D01`) and we open its bulk IN/OUT link.
  Files: [UsbAoap.kt](app/src/main/java/com/mobilelabkit/headunit/UsbAoap.kt),
  [MainActivity.kt](app/src/main/java/com/mobilelabkit/headunit/MainActivity.kt).
- **Phase 2 ✓ (implemented, compile-verified; live handshake needs the rig):** frame
  codec + multi-frame reassembly ([AapTransport.kt](app/src/main/java/com/mobilelabkit/headunit/AapTransport.kt)),
  TLSv1.2 client with the head-unit cert driven over `SSL_HANDSHAKE` messages
  ([AapCrypto.kt](app/src/main/java/com/mobilelabkit/headunit/AapCrypto.kt)), and the
  control-channel handshake — version → TLS → auth-complete → service discovery
  ([ControlChannel.kt](app/src/main/java/com/mobilelabkit/headunit/ControlChannel.kt)).
  The 96 aasdk `.proto` are compiled to protobuf-lite. On success the screen lists the
  phone's offered channels. **Not yet verified against a real phone** — the TLS
  handshake-over-messages is the most likely thing to need tuning on the rig.
- **Phase 3 ✓ (implemented, compile-verified; live stream needs the rig):** the video
  channel. The head unit is the *responder* — it advertises a display (480p) in the
  service-discovery response, then answers the phone's channel-open + AV-setup, grants
  video focus, and feeds the incoming H.264 to `MediaCodec` → the full-screen `SurfaceView`
  (inline SPS/PPS extracted for codec config), acking each frame.
  ([VideoChannel.kt](app/src/main/java/com/mobilelabkit/headunit/VideoChannel.kt),
  [VideoDecoder.kt](app/src/main/java/com/mobilelabkit/headunit/VideoDecoder.kt)).
  Fixed a Phase-2 direction bug in the same pass: **the phone sends the service-discovery
  request and the head unit answers** (not the other way around).
- **Phase 4 ✓ (implemented, compile-verified; live input needs the rig):** the input
  channel — the touch-forwarding path. Advertises a touchscreen sized to the display,
  answers channel-open + key-binding, and forwards `InputEventIndication` touch events
  (PRESS/DRAG/RELEASE, mapped into display coordinates) to the phone as you touch the
  head-unit surface. ([InputChannel.kt](app/src/main/java/com/mobilelabkit/headunit/InputChannel.kt))
- **Phase 5:** audio (media + guidance + speech) via `AudioTrack`.
- **Phase 6:** wireless (Bluetooth RFCOMM bootstrap + Wi-Fi TCP).

## Build

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"  # a JDK 17/21
./gradlew :app:assembleDebug     # -> app/build/outputs/apk/debug/app-debug.apk
```

## Test rig (Phase 1)

You need **two devices**:
1. **Receiver** — the device running this app, acting as **USB host**. Most modern phones
   support USB host / OTG.
2. **Source** — an Android phone with **Android Auto installed and set up**
   (Settings ▸ Connected devices ▸ Android Auto, "Add a car / allow while USB").

Cable them **USB-C ↔ USB-C** (or source phone → OTG adapter → receiver). Open the app on
the receiver, then plug in the source phone:

- Allow the USB-permission prompt on the receiver.
- The app sends the AOAP start sequence; the source phone should show "Android Auto
  starting" and reconnect in accessory mode.
- Success screen: **"✓ Android Auto link open"** — the bulk endpoints are ready. Phase 2
  is what turns that link into a live car UI.

`adb logcat -s headunit headunit-usb` shows the handshake (AOAP protocol version, each
string, START, then the bulk-link open).

### Known risks
- Some phones only start AA over USB after a first-time in-car pairing / "allow Android
  Auto while locked" toggle. If START is accepted but nothing reconnects, check the phone's
  Android Auto USB settings.
- The reference head-unit certificate (Phase 2) can be rejected by newer Android Auto
  builds — a long-standing OpenAuto caveat.

## Provenance / licensing

See [PROVENANCE.md](PROVENANCE.md). The protocol spec, `.proto` files, and head-unit
certificate come from aasdk (**GPLv3**); this receiver is therefore a GPLv3 work.
