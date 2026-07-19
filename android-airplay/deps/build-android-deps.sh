#!/usr/bin/env bash
#
# Cross-compile the AirPlay receiver's native C dependencies for the Android NDK.
#
#   - OpenSSL libcrypto  (FairPlay AES/RSA)
#   - libplist-2.0       (AirPlay plist request/response bodies — raop_handlers.h)
#   - fdk-aac            (AAC-ELD mirror-audio decode)
#
# Output: prebuilt/<abi>/{include,lib}/*  — static (.a) libs + headers that the app's
# CMake build (app/src/main/cpp/CMakeLists.txt) links against. The header-only
# miniaudio.h / mdns.h in the desktop receiver's vendor/ need no build.
#
# This mirrors the desktop receiver's `brew install openssl@3 libplist fdk-aac` — the
# same three libraries, just cross-compiled for the phone instead of the host. Run it
# once before the first Gradle build (results are cached; re-run only to bump versions
# or add an ABI). Requires network to fetch the pinned source tarballs.
#
#   ./build-android-deps.sh                 # arm64-v8a (covers the A55 + arm64 emulators)
#   ABIS="arm64-v8a x86_64" ./build-android-deps.sh
#
set -euo pipefail
cd "$(dirname "$0")"

ABIS="${ABIS:-arm64-v8a}"                 # space-separated
API="${API:-26}"                          # min API (matches app minSdk; AAudio needs 26)
OPENSSL_VER="${OPENSSL_VER:-3.0.15}"
LIBPLIST_VER="${LIBPLIST_VER:-2.2.0}"
FDKAAC_VER="${FDKAAC_VER:-2.0.3}"

# --- locate the NDK ---------------------------------------------------------
NDK="${ANDROID_NDK_ROOT:-${ANDROID_NDK_HOME:-}}"
if [ -z "$NDK" ]; then
  SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/sdk}}"
  # Prefer the pinned NDK the Gradle build uses; else newest installed.
  if [ -d "$SDK/ndk/26.3.11579264" ]; then
    NDK="$SDK/ndk/26.3.11579264"
  elif [ -d "$SDK/ndk" ]; then
    NDK="$SDK/ndk/$(ls -1 "$SDK/ndk" | sort -V | tail -1)"
  fi
fi
[ -n "$NDK" ] && [ -d "$NDK" ] || { echo "NDK not found (set ANDROID_NDK_ROOT)"; exit 1; }

HOSTTAG="$(ls -1 "$NDK/toolchains/llvm/prebuilt" | head -1)"   # darwin-x86_64 / linux-x86_64
TOOLS="$NDK/toolchains/llvm/prebuilt/$HOSTTAG/bin"
[ -d "$TOOLS" ] || { echo "no LLVM toolchain under $NDK"; exit 1; }
export PATH="$TOOLS:$PATH"
export AR="$TOOLS/llvm-ar" RANLIB="$TOOLS/llvm-ranlib" STRIP="$TOOLS/llvm-strip"
export ANDROID_NDK_ROOT="$NDK" ANDROID_NDK_HOME="$NDK"
echo "NDK    : $NDK"
echo "tools  : $TOOLS"

WORK="$(pwd)/.work"
mkdir -p "$WORK" prebuilt
PREFIX_ROOT="$(pwd)/prebuilt"

fetch() { # url outfile
  if [ ! -f "$WORK/$2" ]; then
    echo ">>> fetch $2"
    curl -fL --retry 3 --connect-timeout 20 -o "$WORK/$2" "$1"
  fi
}

abi_triple() { case "$1" in
  arm64-v8a)   echo aarch64-linux-android;;
  armeabi-v7a) echo armv7a-linux-androideabi;;
  x86_64)      echo x86_64-linux-android;;
  x86)         echo i686-linux-android;;
  *) echo "unknown ABI: $1" >&2; return 1;; esac; }

openssl_target() { case "$1" in
  arm64-v8a)   echo android-arm64;;
  armeabi-v7a) echo android-arm;;
  x86_64)      echo android-x86_64;;
  x86)         echo android-x86;;
  esac; }

for ABI in $ABIS; do
  TRIPLE="$(abi_triple "$ABI")"
  PREFIX="$PREFIX_ROOT/$ABI"
  # NDK unified clang wrappers embed the API level in the name.
  export CC="$TOOLS/${TRIPLE}${API}-clang"
  export CXX="$TOOLS/${TRIPLE}${API}-clang++"
  export CPP="$CC -E"
  [ -x "$CC" ] || { echo "no compiler $CC (bad ABI/API?)"; exit 1; }
  echo "======================================================================"
  echo "ABI $ABI   triple=$TRIPLE   CC=$(basename "$CC")   -> $PREFIX"
  echo "======================================================================"
  mkdir -p "$PREFIX"

  # --- OpenSSL (libcrypto only) --------------------------------------------
  if [ ! -f "$PREFIX/lib/libcrypto.a" ]; then
    fetch "https://github.com/openssl/openssl/releases/download/openssl-$OPENSSL_VER/openssl-$OPENSSL_VER.tar.gz" "openssl-$OPENSSL_VER.tar.gz"
    SRC="$WORK/openssl-$OPENSSL_VER-$ABI"
    rm -rf "$SRC"; mkdir -p "$SRC"
    tar xf "$WORK/openssl-$OPENSSL_VER.tar.gz" -C "$SRC" --strip-components=1
    # OpenSSL's android target derives the compiler itself from ANDROID_NDK_ROOT+PATH;
    # a stray CC/CXX would fight that, so clear them for this sub-build only.
    ( unset CC CXX CPP; cd "$SRC"
      ./Configure "$(openssl_target "$ABI")" "-D__ANDROID_API__=$API" \
        no-shared no-tests no-asm no-engine --prefix="$PREFIX" --openssldir="$PREFIX/ssl"
      make -j"$(sysctl -n hw.ncpu 2>/dev/null || echo 4)" build_libs
      make install_dev )                       # headers + static libs, no docs/man
    echo "<<< OpenSSL $OPENSSL_VER built for $ABI"
  else
    echo "--- OpenSSL cached"
  fi

  # --- libplist ------------------------------------------------------------
  if [ ! -f "$PREFIX/lib/libplist-2.0.a" ]; then
    fetch "https://github.com/libimobiledevice/libplist/releases/download/$LIBPLIST_VER/libplist-$LIBPLIST_VER.tar.bz2" "libplist-$LIBPLIST_VER.tar.bz2"
    SRC="$WORK/libplist-$LIBPLIST_VER-$ABI"
    rm -rf "$SRC"; mkdir -p "$SRC"
    tar xf "$WORK/libplist-$LIBPLIST_VER.tar.bz2" -C "$SRC" --strip-components=1
    # --with-pic: emit position-independent objects even in the static lib — it gets
    # linked into libairplay.so, so non-PIC objects fail the .so link.
    ( cd "$SRC"
      ./configure --host="$TRIPLE" --prefix="$PREFIX" \
        --without-cython --disable-shared --enable-static --with-pic
      make -j"$(sysctl -n hw.ncpu 2>/dev/null || echo 4)"
      make install )
    echo "<<< libplist $LIBPLIST_VER built for $ABI"
  else
    echo "--- libplist cached"
  fi

  # --- fdk-aac -------------------------------------------------------------
  if [ ! -f "$PREFIX/lib/libfdk-aac.a" ]; then
    fetch "https://downloads.sourceforge.net/opencore-amr/fdk-aac-$FDKAAC_VER.tar.gz" "fdk-aac-$FDKAAC_VER.tar.gz"
    SRC="$WORK/fdk-aac-$FDKAAC_VER-$ABI"
    rm -rf "$SRC"; mkdir -p "$SRC"
    tar xf "$WORK/fdk-aac-$FDKAAC_VER.tar.gz" -C "$SRC" --strip-components=1
    # fdk-aac 2.x's SBR decoder does `#include "log/log.h"` + android_errorWriteLog()
    # under __ANDROID__ — that's an Android *platform* header the NDK doesn't ship.
    # Provide a no-op stub on the include path (we don't need the security log).
    STUB="$WORK/fdkaac-stub"; mkdir -p "$STUB/log"
    cat > "$STUB/log/log.h" <<'EOF'
#ifndef _MLK_FDKAAC_LOG_STUB_H
#define _MLK_FDKAAC_LOG_STUB_H
/* Stub for the NDK: fdk-aac only calls android_errorWriteLog() as a CVE audit hook. */
static inline int android_errorWriteLog(int tag, const char *subTag) {
  (void)tag; (void)subTag; return 0;
}
#endif
EOF
    ( cd "$SRC"
      ./configure --host="$TRIPLE" --prefix="$PREFIX" \
        --disable-shared --enable-static --with-pic \
        CFLAGS="-O2 -fPIC -I$STUB" CXXFLAGS="-O2 -fPIC -I$STUB"
      make -j"$(sysctl -n hw.ncpu 2>/dev/null || echo 4)"
      make install )
    echo "<<< fdk-aac $FDKAAC_VER built for $ABI"
  else
    echo "--- fdk-aac cached"
  fi

  echo "=== $ABI complete -> $PREFIX"
done

# --- verify every expected artifact exists (a failed sub-build must fail us) ---
MISSING=0
for ABI in $ABIS; do
  for lib in libcrypto.a libplist-2.0.a libfdk-aac.a; do
    if [ ! -f "$PREFIX_ROOT/$ABI/lib/$lib" ]; then
      echo "MISSING: prebuilt/$ABI/lib/$lib"; MISSING=1
    fi
  done
done
[ "$MISSING" = 0 ] || { echo "!!! some deps failed to build (see log above)"; exit 1; }

echo
echo "All deps built. prebuilt/ layout:"
find prebuilt -maxdepth 2 -type d | sort
