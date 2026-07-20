#!/usr/bin/env bash
# Make resources/airplayscreen self-contained for redistribution: copy the Homebrew
# dylibs it links (OpenSSL/libplist/fdk-aac) next to it and rewrite the load paths to
# @loader_path so the packaged .app needs no Homebrew install. Idempotent; ad-hoc signs.
#
# Run after build:airplayhelper (which links against /opt/homebrew) and before packaging.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
RES="$HERE/resources"
BIN="$RES/airplayscreen"

[ -f "$BIN" ] || { echo "no airplayscreen at $BIN — run build:airplayhelper first"; exit 0; }

# Resolve each Homebrew dylib the binary references, copy it in, repoint to @loader_path.
for ref in $(otool -L "$BIN" | awk '/opt\/homebrew/ {print $1}'); do
  base="$(basename "$ref")"
  src="$ref"
  [ -f "$src" ] || src="$(brew --prefix 2>/dev/null)/lib/$base"
  cp -f "$src" "$RES/$base"
  chmod u+w "$RES/$base"
  install_name_tool -id "@loader_path/$base" "$RES/$base" 2>/dev/null || true
  codesign -f -s - "$RES/$base" 2>/dev/null || true
  chmod u+w "$BIN"
  install_name_tool -change "$ref" "@loader_path/$base" "$BIN" 2>/dev/null || true
  echo "bundled $base"
done
codesign -f -s - "$BIN" 2>/dev/null || true

if otool -L "$BIN" | grep -q "opt/homebrew"; then
  echo "!! airplayscreen still references Homebrew" >&2; exit 1
fi
echo "airplayscreen is self-contained (@loader_path only)."
