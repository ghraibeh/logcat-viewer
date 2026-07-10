"""Resolve bundled data files in development and in a PyInstaller build."""
from __future__ import annotations

import sys
from pathlib import Path

_PKG = Path(__file__).resolve().parent


def is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"))


def _frozen_search_roots() -> list[Path]:
    """Candidate roots for bundled ``assets/`` and ``platform-tools/``."""
    me = Path(sys._MEIPASS)  # type: ignore[attr-defined]
    roots = [me]
    # macOS .app: PyInstaller puts datas under Contents/Resources and/or Frameworks.
    if me.name == "Frameworks":
        res = me.parent / "Resources"
        if res.is_dir():
            roots.append(res)
    elif me.name == "Resources":
        fw = me.parent / "Frameworks"
        if fw.is_dir():
            roots.append(fw)
    return roots


def bundle_root() -> Path:
    if is_frozen():
        for root in _frozen_search_roots():
            if (root / "assets").is_dir() or (root / "platform-tools").is_dir():
                return root
        return Path(sys._MEIPASS)  # type: ignore[attr-defined]
    return _PKG


def asset_path(name: str) -> Path:
    """Path to a file under ``logcat_viewer/assets/``."""
    return bundle_root() / "assets" / name


def bundled_adb() -> str | None:
    """Shipped ``adb`` binary when running from a packaged build."""
    if not is_frozen():
        return None
    for root in _frozen_search_roots():
        adb = root / "platform-tools" / "adb"
        if adb.is_file():
            return str(adb)
    return None
