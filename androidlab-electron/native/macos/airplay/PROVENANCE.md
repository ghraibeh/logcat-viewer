# AirPlay receiver core — third-party provenance

The C sources in this directory (everything **except** `airplayscreen.m` and this
file) are vendored from **RPiPlay** — an open-source AirPlay mirroring receiver:

- Upstream: https://github.com/FD-/RPiPlay
- Vendored subset: RPiPlay's `lib/` (the portable AirPlay/RAOP + FairPlay core,
  including `playfair/` and `llhttp/`). The GStreamer/OpenMAX renderers were **not**
  taken — our `airplayscreen.m` replaces the renderer with a stdout H.264 writer.
- License: **GPL-3.0** (see the upstream `LICENSE`). `playfair/` carries its own
  `LICENSE.md`; `llhttp/` is MIT (`llhttp/LICENSE-MIT`).

## Licensing note

Because this core is GPL-3.0, the compiled `airplayscreen` binary is a GPL-3.0 work.
It is built and shipped as a **standalone subprocess executable** that AndroidLab
launches and talks to only over stdout/stderr + signals (no linking into the Electron
app). If AndroidLab is ever distributed outside the org, the GPL-3.0 terms for this
binary (offer of corresponding source, etc.) must be honored. This was a deliberate,
approved choice — there is no non-GPL implementation of the FairPlay handshake that
AirPlay screen mirroring requires.

## Local edits

The vendored tree is kept **pristine** for easy re-syncing. The two macOS build
shims RPiPlay's Linux socket code needs (`SOL_TCP`→`IPPROTO_TCP`,
`TCP_KEEPIDLE`→`TCP_KEEPALIVE`) are supplied as `-D` defines in
`scripts/build-airplay-helper.js`, not by editing the sources. Added files:
`config.h` (a minimal stand-in for RPiPlay's CMake-generated one) and `ap_config.h`.

One small source edit: `raop_handlers.h`'s GET /info handler hardcoded the advertised
display as `1920`/`1080`; those four literals now read `ap_display_width`/
`ap_display_height` (declared in `ap_config.h`, defined + set from a CLI arg in
`airplayscreen.m`) so the app can pick the AirPlay stream resolution.
