#!/usr/bin/env bash
#
# Build a patched go-ios that can mount the iOS 17+ Developer Disk Image.
#
# Upstream go-ios (v1.2.0) sends EPRO/ESEC=false in its TSS personalization
# request because it never evaluates the BuildManifest's RestoreRequestRules,
# so Apple's TSS server rejects it with status 94 ("device isn't eligible").
# patches/goios-restore-request-rules.patch ports pymobiledevice3's rule
# evaluation into ios/imagemounter (see the memory note "go-ios DDI mount fix").
#
# This clones go-ios, applies the patch, builds the `ios` binary for the host
# platform, and drops it into node_modules/go-ios/dist/<triple>/ so findGoIos()
# picks it up. Requires Go >= 1.26 (GOTOOLCHAIN=auto will fetch it).
#
# Usage:  bash scripts/build-goios.sh
set -euo pipefail

GOIOS_REF="${GOIOS_REF:-main}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
PATCH="$HERE/patches/goios-restore-request-rules.patch"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> cloning go-ios ($GOIOS_REF)"
git clone --depth 1 --branch "$GOIOS_REF" https://github.com/danielpaulus/go-ios "$WORK/src" 2>/dev/null \
  || git clone --depth 1 https://github.com/danielpaulus/go-ios "$WORK/src"

echo "==> applying patch"
git -C "$WORK/src" apply "$PATCH"

echo "==> building ios binary (Go $(go version | awk '{print $3}'); may fetch a newer toolchain)"
BIN="ios"; case "$(go env GOOS)" in windows) BIN="ios.exe";; esac
( cd "$WORK/src" && go build -o "$WORK/$BIN" . )

# Map GOOS/GOARCH to the go-ios npm dist triple.
GOOS="$(go env GOOS)"; GOARCH="$(go env GOARCH)"
case "$GOOS-$GOARCH" in
  darwin-arm64) TRIPLE="go-ios-darwin-arm64_darwin_arm64";;
  darwin-amd64) TRIPLE="go-ios-darwin-amd64_darwin_amd64";;
  linux-arm64)  TRIPLE="go-ios-linux-arm64_linux_arm64";;
  linux-amd64)  TRIPLE="go-ios-linux-amd64_linux_amd64";;
  windows-amd64) TRIPLE="go-ios-windows-amd64_windows_amd64";;
  *) echo "unsupported platform $GOOS-$GOARCH"; exit 1;;
esac

DEST="$HERE/node_modules/go-ios/dist/$TRIPLE/$BIN"
if [ -f "$DEST" ] && [ ! -f "$DEST.orig" ]; then cp "$DEST" "$DEST.orig"; fi
mkdir -p "$(dirname "$DEST")"
cp "$WORK/$BIN" "$DEST"
chmod +x "$DEST"
echo "==> installed patched go-ios -> $DEST"
"$DEST" version 2>/dev/null | tail -1 || true
