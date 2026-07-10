"""PyInstaller runtime hook — Qt WebEngine + macOS .app paths."""
from __future__ import annotations

import os
import sys
from pathlib import Path


def _frameworks_dir() -> Path | None:
    if not getattr(sys, "frozen", False):
        return None
    exe = Path(sys.executable).resolve()
    # .../Logcat Viewer.app/Contents/MacOS/LogcatViewer
    fw = exe.parent.parent / "Frameworks"
    return fw if fw.is_dir() else None


fw = _frameworks_dir()
if fw is not None:
    proc = (
        fw
        / "PyQt6/Qt6/lib/QtWebEngineCore.framework/Versions/A/Helpers"
        / "QtWebEngineProcess.app/Contents/MacOS/QtWebEngineProcess"
    )
    if proc.is_file():
        os.environ["QTWEBENGINEPROCESS_PATH"] = str(proc)
    res = fw / "PyQt6/Qt6/resources"
    if res.is_dir():
        os.environ.setdefault("QTWEBENGINE_RESOURCES_PATH", str(res))
    locales = fw / "PyQt6/Qt6/translations/qtwebengine_locales"
    if locales.is_dir():
        os.environ.setdefault("QTWEBENGINE_LOCALES_PATH", str(locales))

    # Ensure Qt finds bundled frameworks when launched from Finder (no shell PATH).
    os.environ.setdefault("QT_PLUGIN_PATH", str(fw / "PyQt6/Qt6/plugins"))
