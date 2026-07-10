#!/bin/bash
# Build the Mock Location Helper APK with the raw SDK build-tools (no Gradle/AGP,
# so no JDK-version headaches). Produces a tiny, debug-signed APK and copies it
# into the Python package so the app can auto-install it.
#
# Usage: ./build.sh            (auto-detects the SDK + newest build-tools/platform)
set -euo pipefail
cd "$(dirname "$0")"

PKG=com.logcatviewer.mocklocation
OUT_APK=../logcat_viewer/assets/mocklocation.apk

# --- locate the SDK ----------------------------------------------------------
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
[ -d "$SDK" ] || { echo "No Android SDK at '$SDK' (set \$ANDROID_HOME)"; exit 1; }

# newest build-tools that actually has aapt2/d8/apksigner
BT=""
for d in $(ls -1 "$SDK/build-tools" | sort -Vr); do
  if [ -x "$SDK/build-tools/$d/aapt2" ] && [ -x "$SDK/build-tools/$d/d8" ] \
     && [ -x "$SDK/build-tools/$d/apksigner" ]; then BT="$SDK/build-tools/$d"; break; fi
done
[ -n "$BT" ] || { echo "No build-tools with aapt2+d8+apksigner under $SDK/build-tools"; exit 1; }

# newest installed platform android.jar
PLAT_JAR=""
for p in $(ls -1 "$SDK/platforms" | sed 's/android-//' | sort -nr); do
  if [ -f "$SDK/platforms/android-$p/android.jar" ]; then
    PLAT_JAR="$SDK/platforms/android-$p/android.jar"; break; fi
done
[ -n "$PLAT_JAR" ] || { echo "No android.jar under $SDK/platforms"; exit 1; }

echo "SDK          : $SDK"
echo "build-tools  : $BT"
echo "android.jar  : $PLAT_JAR"

BUILD=build
rm -rf "$BUILD"; mkdir -p "$BUILD/classes"

# --- 1. compile Java --------------------------------------------------------
echo "==> javac"
javac --release 11 -classpath "$PLAT_JAR" -d "$BUILD/classes" \
  $(find src -name '*.java')

# --- 2. dex -----------------------------------------------------------------
echo "==> d8"
"$BT/d8" --release --min-api 21 --lib "$PLAT_JAR" --output "$BUILD" \
  $(find "$BUILD/classes" -name '*.class')

# --- 3. package resources + manifest (no res/ dir → truly minimal) ----------
echo "==> aapt2 link"
"$BT/aapt2" link \
  -I "$PLAT_JAR" \
  --manifest AndroidManifest.xml \
  --min-sdk-version 21 --target-sdk-version 35 \
  -o "$BUILD/base.apk"

# --- 4. add classes.dex to the apk (must live at the archive root) ----------
echo "==> add classes.dex"
( cd "$BUILD" && zip -q -j base.apk classes.dex )

# --- 5. align ---------------------------------------------------------------
echo "==> zipalign"
"$BT/zipalign" -f -p 4 "$BUILD/base.apk" "$BUILD/aligned.apk"

# --- 6. sign (debug keystore, generated once) -------------------------------
KS=debug.keystore
if [ ! -f "$KS" ]; then
  echo "==> generating debug keystore"
  keytool -genkeypair -keystore "$KS" -storepass android -keypass android \
    -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=Logcat Viewer Debug,O=LogcatViewer,C=US" >/dev/null 2>&1
fi
echo "==> apksigner"
"$BT/apksigner" sign \
  --ks "$KS" --ks-pass pass:android --key-pass pass:android \
  --out "$BUILD/mocklocation.apk" "$BUILD/aligned.apk"

mkdir -p ../logcat_viewer/assets
cp "$BUILD/mocklocation.apk" "$OUT_APK"
SZ=$(du -h "$OUT_APK" | cut -f1)
echo
echo "✓ built $OUT_APK ($SZ)  package=$PKG"
"$BT/apksigner" verify --print-certs "$OUT_APK" >/dev/null && echo "✓ signature OK"
