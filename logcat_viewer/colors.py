"""Android-Studio-style log coloring: subtle per-level message text, solid level
badges, and a distinct stable color per tag."""
from __future__ import annotations

from PyQt6.QtGui import QColor

# Metadata columns (time / pid / tid) — quiet.
META = QColor("#767c88")

# Message text: light and calm; warnings/errors are the ones that grab the eye.
MSG_TEXT = {
    "V": QColor("#8b929e"),
    "D": QColor("#c3cddd"),
    "I": QColor("#cdd6c6"),
    "W": QColor("#e7c86a"),
    "E": QColor("#ff8f88"),
    "F": QColor("#ff8f88"),
    "?": QColor("#c3c9d2"),
}

# Solid level badge (gutter chip) + its letter color.
BADGE = {
    "V": QColor("#565e6b"),
    "D": QColor("#3d6fb0"),
    "I": QColor("#4c8a3f"),
    "W": QColor("#b0851f"),
    "E": QColor("#c1443c"),
    "F": QColor("#d64b43"),
    "?": QColor("#565e6b"),
}
BADGE_TEXT = QColor("#eef2f8")

# Per-tag palette — distinct hues that read well on a dark canvas.
_TAG_PALETTE = [
    QColor("#e0a45e"),  # tan
    QColor("#57c0c0"),  # teal
    QColor("#c58fe0"),  # purple
    QColor("#8fbf6b"),  # green
    QColor("#6f9ff0"),  # blue
    QColor("#ef8f6b"),  # coral
    QColor("#e57fa0"),  # pink
    QColor("#d6c15e"),  # gold
    QColor("#5fb0e0"),  # sky
    QColor("#9fd06b"),  # lime
    QColor("#b08ff0"),  # violet
    QColor("#5fc0a0"),  # mint
    QColor("#e07f7f"),  # salmon
    QColor("#7fb0d0"),  # steel
]

_tag_cache: dict[str, QColor] = {}


def tag_color(tag: str) -> QColor:
    """Deterministic per-tag color (same tag -> same hue across the session)."""
    if not tag:
        return META
    cached = _tag_cache.get(tag)
    if cached is not None:
        return cached
    h = 0
    for ch in tag:
        h = (h * 31 + ord(ch)) & 0xFFFFFFFF
    color = _TAG_PALETTE[h % len(_TAG_PALETTE)]
    _tag_cache[tag] = color
    return color
