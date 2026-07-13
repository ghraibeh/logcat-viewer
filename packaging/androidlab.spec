# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for AndroidLab (macOS .app bundle)."""
from __future__ import annotations

from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_submodules

ROOT = Path(SPECPATH).resolve().parent
STAGING = ROOT / "packaging" / "staging"
ASSETS = ROOT / "logcat_viewer" / "assets"
PT = STAGING / "platform-tools"

if not ASSETS.is_dir():
    raise SystemExit(f"missing assets dir: {ASSETS}")
if not (PT / "adb").is_file():
    raise SystemExit(
        f"missing staged adb at {PT / 'adb'} — run packaging/build.sh first"
    )

datas: list[tuple[str, str]] = [
    (str(ASSETS), "assets"),
    (str(PT), "platform-tools"),
]
binaries: list[tuple[str, str]] = []
hiddenimports: list[str] = []

for pkg in (
    "PyQt6",
    "PyQt6.QtCore",
    "PyQt6.QtGui",
    "PyQt6.QtWidgets",
    "PyQt6.QtWebEngineWidgets",
    "PyQt6.QtWebEngineCore",
):
    tmp = collect_all(pkg)
    datas += tmp[0]
    binaries += tmp[1]
    hiddenimports += tmp[2]

hiddenimports += collect_submodules("logcat_viewer")

try:
    import av  # noqa: F401
    tmp = collect_all("av")
    datas += tmp[0]
    binaries += tmp[1]
    hiddenimports += tmp[2]
except Exception:
    pass

a = Analysis(
    [str(ROOT / "logcat_viewer" / "main.py")],
    pathex=[str(ROOT)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[str(ROOT / "packaging" / "runtime_hook.py")],
    excludes=[],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="AndroidLab",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="AndroidLab",
)

app = BUNDLE(
    coll,
    name="AndroidLab.app",
    icon=None,
    bundle_identifier="com.androidlab.app",
    info_plist={
        "CFBundleName": "AndroidLab",
        "CFBundleDisplayName": "AndroidLab",
        "CFBundleExecutable": "AndroidLab",
        "CFBundleShortVersionString": "0.1.0",
        "NSHighResolutionCapable": True,
        "LSMinimumSystemVersion": "12.0",
    },
)
