#!/usr/bin/env bash
#
# Build the patched go-ios `ios` binary from the vendored source tree at
# vendor/go-ios (upstream main@274bc43 + our patches, tracked in this repo —
# see vendor/go-ios/PROVENANCE.md). No network clone: the vendored tree is the
# authoritative source; patches/goios-androidlab.patch is a frozen snapshot of
# the delta vs upstream from vendoring time.
#
# What the patches do (details in PROVENANCE.md):
#
# Upstream go-ios (v1.2.0) sends EPRO/ESEC=false in its TSS personalization
# request because it never evaluates the BuildManifest's RestoreRequestRules,
# so Apple's TSS server rejects it with status 94 ("device isn't eligible").
# patches/goios-androidlab.patch ports pymobiledevice3's rule
# evaluation into ios/imagemounter (see the memory note "go-ios DDI mount fix").
# The same patch also enriches `ios sysmontap` to emit per-core CPU + RAM
# (per_cpu / mem_total_kb / mem_used_kb), which the CLI otherwise discards —
# feeding the iOS Monitor tab — and rewrites `ios ip` so the Device Info tab's
# IP-address lookup is reliable (identifies the device's Wi-Fi IP from the pcapd
# stream without matching the hardware MAC — which iOS's default Private Wi-Fi
# Address randomises — and returns within a bounded timeout instead of hanging).
# It also adds `ios wificonnections (enable|disable|get)` — the lockdown value
# behind Finder's "Show this iPhone when on Wi-Fi" — powering the app's cable-free
# iOS connection flow; makes device-by-udid resolution prefer the USB usbmuxd
# entry when the same device is also visible over Wi-Fi; and hardens
# `ios list --details` so one unreachable (e.g. stale Wi-Fi) entry degrades to
# empty fields instead of failing the whole listing. Finally, it lets the
# developer tunnel come up over Wi-Fi: upstream's tunnel agent hard-skips every
# "Network" device (assuming they can't tunnel), but the CoreDeviceProxy tunnel
# rides the same usbmux Connect that classic services already use over Wi-Fi and
# works cable-free — verified on-device. Setting GOIOS_NETWORK_TUNNEL=1 (which the
# app does) enables the attempt; unset preserves exact upstream behavior.
#
# go-ios is pure Go (CGO disabled), so by default this cross-compiles ALL
# supported platforms and drops each into node_modules/go-ios/dist/<triple>/ —
# keeping the whole app multiplatform (macOS/Linux/Windows hosts) from a single
# build host. Set GOIOS_HOST_ONLY=1 to build just this host's binary.
# findGoIos() picks up whichever matches the running host. Requires Go >= 1.26
# (GOTOOLCHAIN=auto will fetch it).
#
# Usage:  bash scripts/build-goios.sh            # all platforms
#         GOIOS_HOST_ONLY=1 bash scripts/build-goios.sh   # this host only
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$HERE/vendor/go-ios"

[ -f "$SRC/go.mod" ] || { echo "vendored go-ios source not found at $SRC"; exit 1; }

# Build one GOOS/GOARCH -> its npm dist triple. Pure Go, so CGO is disabled and
# cross-compilation needs no C toolchain.
build_one() {
  local goos="$1" goarch="$2" triple="$3"
  local bin="ios"; [ "$goos" = "windows" ] && bin="ios.exe"
  local dest="$HERE/node_modules/go-ios/dist/$triple/$bin"
  if [ -f "$dest" ] && [ ! -f "$dest.orig" ]; then cp "$dest" "$dest.orig"; fi
  mkdir -p "$(dirname "$dest")"
  rm -f "$dest" # go build refuses to overwrite a non-object file (the npm binary)
  echo "==> building $goos/$goarch"
  ( cd "$SRC" && CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" go build -o "$dest" . )
  chmod +x "$dest"
  echo "    installed -> $dest"
}

echo "==> building ios binary (Go $(go version | awk '{print $3}'); may fetch a newer toolchain)"
if [ "${GOIOS_HOST_ONLY:-0}" = "1" ]; then
  case "$(go env GOOS)-$(go env GOARCH)" in
    darwin-arm64)  build_one darwin  arm64 go-ios-darwin-arm64_darwin_arm64;;
    darwin-amd64)  build_one darwin  amd64 go-ios-darwin-amd64_darwin_amd64;;
    linux-arm64)   build_one linux   arm64 go-ios-linux-arm64_linux_arm64;;
    linux-amd64)   build_one linux   amd64 go-ios-linux-amd64_linux_amd64;;
    windows-amd64) build_one windows amd64 go-ios-windows-amd64_windows_amd64;;
    *) echo "unsupported platform $(go env GOOS)-$(go env GOARCH)"; exit 1;;
  esac
else
  build_one darwin  arm64 go-ios-darwin-arm64_darwin_arm64
  build_one darwin  amd64 go-ios-darwin-amd64_darwin_amd64
  build_one linux   arm64 go-ios-linux-arm64_linux_arm64
  build_one linux   amd64 go-ios-linux-amd64_linux_amd64
  build_one windows amd64 go-ios-windows-amd64_windows_amd64
fi

echo "==> done"
HOSTBIN="$HERE/node_modules/go-ios/dist/go-ios-$(go env GOOS)-$(go env GOARCH)_$(go env GOOS)_$(go env GOARCH)/ios"
"$HOSTBIN" version 2>/dev/null | tail -1 || true
