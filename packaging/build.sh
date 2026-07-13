#!/bin/bash
# Build a self-contained macOS .app — no Python/venv/adb install required.
#
# Usage:
#   ./packaging/build.sh
#
# Output:
#   dist/AndroidLab.app
#   dist/AndroidLab-macOS.zip   (drag-and-drop portable archive)
set -euo pipefail
cd "$(dirname "$0")/.."

APP_NAME="AndroidLab"
STAGING="packaging/staging"
PT_ZIP="$STAGING/platform-tools.zip"
PT_DIR="$STAGING/platform-tools"
VENV=".venv"

echo "==> ensuring Python venv"
if [ ! -x "$VENV/bin/python" ]; then
  uv venv --python 3.12 "$VENV"
fi
uv pip install --python "$VENV/bin/python" -q -r requirements.txt -r packaging/requirements-build.txt

echo "==> staging Android platform-tools (adb)"
mkdir -p "$STAGING"
if [ ! -x "$PT_DIR/adb" ]; then
  if [ -x "${ANDROID_HOME:-}/platform-tools/adb" ]; then
    echo "    copying from \$ANDROID_HOME"
    rm -rf "$PT_DIR"
    cp -R "${ANDROID_HOME}/platform-tools" "$PT_DIR"
  elif [ -x "$HOME/Library/Android/sdk/platform-tools/adb" ]; then
    echo "    copying from ~/Library/Android/sdk"
    rm -rf "$PT_DIR"
    cp -R "$HOME/Library/Android/sdk/platform-tools" "$PT_DIR"
  else
    echo "    downloading platform-tools-latest-darwin.zip"
    curl -fsSL -o "$PT_ZIP" \
      "https://dl.google.com/android/repository/platform-tools-latest-darwin.zip"
    rm -rf "$PT_DIR"
    unzip -q -o "$PT_ZIP" -d "$STAGING"
    rm -f "$PT_ZIP"
  fi
fi
chmod +x "$PT_DIR/adb"

if [ ! -f logcat_viewer/assets/mocklocation.apk ]; then
  echo "==> building mock-location helper APK"
  if [ -x android-helper/build.sh ]; then
    android-helper/build.sh
  else
    echo "WARN: mocklocation.apk missing and android-helper/build.sh not found"
  fi
fi

echo "==> running PyInstaller"
rm -rf build dist
"$VENV/bin/pyinstaller" --noconfirm packaging/androidlab.spec

APP_PATH="dist/$APP_NAME.app"
echo "==> ad-hoc signing (so double-click launch works without Gatekeeper drama)"
xattr -cr "$APP_PATH" 2>/dev/null || true
codesign --force --deep --sign - "$APP_PATH"

ZIP="dist/AndroidLab-macOS.zip"
rm -f "$ZIP"
ditto -c -k --sequesterRsrc --keepParent "dist/$APP_NAME.app" "$ZIP"

SZ=$(du -sh "dist/$APP_NAME.app" | cut -f1)
echo
echo "✓ built dist/$APP_NAME.app ($SZ)"
echo "✓ zip   $ZIP"
echo
echo "Install: unzip and double-click AndroidLab.app."
echo "First open: if macOS blocks it, right-click → Open once."
