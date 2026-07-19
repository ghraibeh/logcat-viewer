# Android AirPlay receiver — provenance & licensing

This module builds an Android APK on top of the **same vendored RPiPlay core** the desktop
receiver uses. See the full third-party breakdown in
[`../androidlab-electron/native/macos/airplay/PROVENANCE.md`](../androidlab-electron/native/macos/airplay/PROVENANCE.md).

## What's ours (in this module)

- `app/src/main/cpp/jni_bridge.c` — Android JNI entry points; replaces the desktop
  `airplayscreen.c` main. Forwards H.264 to Kotlin; keeps the desktop's fdk-aac→miniaudio
  audio path verbatim.
- `app/src/main/cpp/CMakeLists.txt` — NDK build that reuses the core in-place.
- The Kotlin app (`NativeReceiver`, `VideoDecoder`, `MainActivity`) and Gradle project.
- `deps/build-android-deps.sh` — cross-compiles the native deps for the NDK.

## Reused as-is (not copied here)

- The RPiPlay core (`raop*.c`, `crypto.c`, `httpd.c`, `pairing.c`, `playfair/`, `llhttp/`,
  `dnssd.c`, `bonjour_shim.c`, `raop_handlers.h`, …) — referenced across the tree from
  `androidlab-electron/native/macos/airplay/`. **GPL-3.0.**
- `vendor/miniaudio.h` (public domain / MIT-0) and `vendor/mdns.h` (public domain) from the
  same directory.

## Native dependencies (cross-compiled by `deps/build-android-deps.sh`, statically linked)

- **OpenSSL libcrypto** 3.0.15 — FairPlay AES/RSA. Apache-2.0.
- **libplist** 2.2.0 — AirPlay plist bodies. LGPL-2.1.
- **fdk-aac** 2.0.3 — AAC-ELD decode. FDK-AAC license (permissive, with notice).

## Licensing

The RPiPlay core is **GPL-3.0**, so the compiled `libairplay.so` — and therefore the APK
that ships it — is a **GPL-3.0** work. If distributed outside the org, honor the GPL-3.0
terms (offer of corresponding source, etc.). This mirrors the deliberate, approved choice
made for the desktop receiver: there is no non-GPL implementation of the FairPlay handshake
that AirPlay screen mirroring requires. The added libraries above are GPL-compatible.

## Local edits to the shared core

None beyond what the desktop already carries (the `USE_BUNDLED_MDNS` and
`raop_handlers.h` display-size edits documented in the desktop PROVENANCE). The Android
build sets `-DSOL_TCP=IPPROTO_TCP` (bionic lacks the glibc constant) via CMake, not by
editing sources.
