"""Log session tools: export the (filtered) buffer to a text file, load a saved
logcat file back into the viewer, and named filter presets persisted as JSON in
the app-support dir. Pure helpers (Qt-free) — the wiring lives in ui.py.
"""
from __future__ import annotations

import json
import os

from .decompile import app_support_dir

PRESETS_FILE = "filter_presets.json"

# Keys the filter bar round-trips through a preset (all strings/bools/int).
PRESET_FIELDS = ("min_priority", "text", "text_regex", "tag", "tag_regex",
                 "pids", "exclude", "exclude_regex")


def entry_line(e) -> str:
    """One threadtime-shaped text line for a LogEntry (raw when we have it, so
    an exported file round-trips through parse_line unchanged)."""
    return e.raw or f"{e.time} {e.pid:>5} {e.tid:>5} {e.level} {e.tag}: {e.msg}"


def export_text(entries) -> str:
    return "\n".join(entry_line(e) for e in entries) + ("\n" if entries else "")


def presets_path() -> str:
    return os.path.join(app_support_dir(), PRESETS_FILE)


def load_presets(path: str | None = None) -> dict:
    """{name: {field: value}} — empty on missing/corrupt file (never raises)."""
    try:
        with open(path or presets_path(), encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_presets(presets: dict, path: str | None = None) -> bool:
    path = path or presets_path()
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(presets, f, indent=2, sort_keys=True)
        return True
    except OSError:
        return False


def clean_preset(values: dict) -> dict:
    """Keep only known fields (forward/backward-compatible preset files)."""
    return {k: values[k] for k in PRESET_FIELDS if k in values}
