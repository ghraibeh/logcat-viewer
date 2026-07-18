# AirPlay receiver core — third-party provenance

The C sources in this directory (the vendored RPiPlay core, plus the `vendor/`
single-header libraries) are third-party. Our own files are `airplayscreen.c` (the
portable main), `bonjour_shim.c/.h` (the bundled mDNS advertiser), `miniaudio_impl.c`,
`config.h`, `ap_config.h`, `CMakeLists.txt`, and this file.

> Note: despite the `native/macos/` path (historical — it began as a macOS-only
> helper), the receiver is now **cross-platform** (macOS/Windows/Linux). The directory
> may be renamed to `native/airplay/` in a later cleanup.

## RPiPlay core (GPL-3.0)

- Upstream: https://github.com/FD-/RPiPlay
- Vendored subset: RPiPlay's `lib/` (the portable AirPlay/RAOP + FairPlay core,
  including `playfair/` and `llhttp/`). The GStreamer/OpenMAX renderers were **not**
  taken — `airplayscreen.c` replaces the renderer with a stdout H.264 writer.
- License: **GPL-3.0** (see the upstream `LICENSE`). `playfair/` carries its own
  `LICENSE.md`; `llhttp/` is MIT (`llhttp/LICENSE-MIT`).

## vendor/ single-header libraries

- `vendor/miniaudio.h` — cross-platform audio playback (CoreAudio/WASAPI/ALSA/Pulse).
  Upstream: https://github.com/mackron/miniaudio — **public domain / MIT-0**.
  Compiled once via `miniaudio_impl.c`; used by `airplayscreen.c` to play the decoded
  AirPlay audio on the host's default output.
- `vendor/mdns.h` — mjansson's mDNS/DNS-SD library.
  Upstream: https://github.com/mjansson/mdns — **public domain (Unlicense)**.
  `bonjour_shim.c` builds a self-contained mDNS *advertiser* on top of it, so the
  receiver announces `_airplay._tcp` / `_raop._tcp` with **no OS Bonjour/Avahi**.

## External build dependencies (dynamically linked, not vendored)

- **OpenSSL libcrypto** — FairPlay AES/RSA (all platforms).
- **libplist-2.0** — AirPlay plist bodies.
- **fdk-aac** — AAC-ELD audio decode.
  (`brew` on macOS, `apt` on Linux, `vcpkg` on Windows — see `CMakeLists.txt`.)

## Licensing note

Because the core is GPL-3.0, the compiled `airplayscreen[.exe]` binary is a GPL-3.0
work. It is built and shipped as a **standalone subprocess executable** that
MobileLabKit launches and talks to only over stdin/stdout/stderr (no linking into the
Electron app). If MobileLabKit is ever distributed outside the org, the GPL-3.0 terms
for this binary (offer of corresponding source, etc.) must be honored. This was a
deliberate, approved choice — there is no non-GPL implementation of the FairPlay
handshake that AirPlay screen mirroring requires. The added `vendor/` libraries
(public-domain) and fdk-aac (a permissive-with-notice license) are GPL-compatible.

## Local edits to the vendored tree

The RPiPlay core is kept **pristine** for easy re-syncing, with two exceptions:

1. `dnssd.c` — added a `USE_BUNDLED_MDNS` path that points its dns_sd function
   pointers at `bonjour_shim` (instead of the OS Bonjour/Avahi), so the receiver
   needs no system mDNS daemon on any platform. Gated behind the flag; the original
   WIN32/dlopen/macOS paths are untouched.
2. `raop_handlers.h` — the GET /info handler hardcoded the advertised display as
   `1920`/`1080`; those literals now read `ap_display_width`/`ap_display_height`
   (declared in `ap_config.h`, defined + set from a CLI arg in `airplayscreen.c`) so
   the app can pick the AirPlay stream resolution.

The macOS build shims RPiPlay's Linux socket code needs (`SOL_TCP`→`IPPROTO_TCP`,
`TCP_KEEPIDLE`→`TCP_KEEPALIVE`) are supplied as `-D` defines in `CMakeLists.txt`
(APPLE branch), not by editing the sources.
