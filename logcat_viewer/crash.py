"""Crash & ANR viewer: the logcat crash buffer + `dumpsys dropbox` records,
visualized Crashlytics-style — identical crashes are grouped with an ×N badge,
the stack trace renders as structured HTML (exception headline card, app frames
highlighted, long framework runs folded behind a click, Caused-by chain chips
that jump to the root cause), with best-effort local R8/ProGuard retrace from a
mapping.txt (auto-reloaded across sessions) and a live "new crash" ping wired
from the log stream.

Everything visual is built by pure, Qt-free helpers (`split_crash_blocks`,
`group_crashes`, `classify_trace_line`, `build_crash_html`, `parse_mapping`,
`retrace`, `looks_obfuscated`) covered by tests/smoke.py; device I/O runs on
QThread workers (`CrashScanWorker`, `MappingLoadWorker`).
"""
from __future__ import annotations

import html as _htmllib
import json
import os
import re
import subprocess
from dataclasses import dataclass, field

from PyQt6.QtCore import Qt, QThread, QTimer, pyqtSignal
from PyQt6.QtGui import QColor, QGuiApplication
from PyQt6.QtWidgets import (
    QFileDialog, QHBoxLayout, QLabel, QLineEdit, QListWidget, QListWidgetItem,
    QPushButton, QSplitter, QTextBrowser, QVBoxLayout, QWidget,
)

from . import theme
from .decompile import app_support_dir
from .parser import parse_line

# Dropbox tags that hold crash-ish records. (SYSTEM_TOMBSTONE is binary on many
# builds; text output is still useful when present.)
CRASH_TAGS = (
    "data_app_crash", "data_app_anr", "data_app_wtf", "data_app_native_crash",
    "system_app_crash", "system_app_anr", "system_app_wtf", "system_server_crash",
)

_KIND_COLOR = {"crash": theme.RED, "anr": theme.AMBER,
               "native": "#c678dd", "wtf": theme.TEXT_DIM}
_KIND_LABEL = {"crash": "CRASH", "anr": "ANR", "native": "NATIVE", "wtf": "WTF"}
_KIND_GLYPH = {"crash": "💥", "anr": "⏳", "native": "🧨", "wtf": "⚠️"}

# Runs of more than this many consecutive framework frames fold behind a link.
FOLD_THRESHOLD = 3

_SETTINGS_FILE = "crash_settings.json"


# --- pure adb arg builders -----------------------------------------------------
def crash_buffer_args(serial: str) -> list[str]:
    """Dump (and exit) the dedicated crash log buffer."""
    return ["-s", serial, "logcat", "-b", "crash", "-v", "threadtime", "-d"]


def dropbox_print_args(serial: str, tag: str) -> list[str]:
    return ["-s", serial, "shell", "dumpsys", "dropbox", "--print", tag]


# --- crash records (Qt-free) -----------------------------------------------------
@dataclass
class CrashItem:
    kind: str            # "crash" | "anr" | "native" | "wtf"
    when: str            # display timestamp
    process: str         # package / process name ("" if unknown)
    title: str           # exception headline
    text: str            # full block, as captured (timestamps kept for export)
    source: str          # "crash buffer" | dropbox tag
    plain: str = ""      # messages only (no threadtime prefixes) — what we render


_PROCESS_RE = re.compile(r"Process:\s*(\S+?),?\s+PID:", re.M)
_PKG_LINE_RE = re.compile(r"^(?:Package|Process):\s*(\S+?)(?:\s|,|$)", re.M)
_ANR_RE = re.compile(r"ANR in (\S+)")
_EXC_RE = re.compile(r"^([\w.$]+(?:Exception|Error|Throwable|Death)[\w.$]*)(?::\s*(.*))?$")


def _headline(body: str) -> str:
    """First exception-looking line (or ANR reason) in a crash block."""
    m = _ANR_RE.search(body)
    if m:
        return f"ANR in {m.group(1)}"
    for line in body.splitlines():
        line = line.strip()
        m = _EXC_RE.match(line)
        if m:
            return line[:200]
    return ""


def split_crash_blocks(text: str) -> list[CrashItem]:
    """Split `logcat -b crash -d` output into per-crash blocks. A block is the
    run of consecutive lines sharing one PID; a new `FATAL EXCEPTION` / `ANR in`
    from the same PID also starts a fresh block."""
    blocks: list[CrashItem] = []
    cur_pid = None
    cur_lines: list[str] = []
    cur_msgs: list[str] = []      # bare messages — headline/render text
    cur_when = ""

    def flush():
        if not cur_lines:
            return
        body = "\n".join(cur_lines)
        msgs = "\n".join(cur_msgs)
        proc = ""
        m = _PROCESS_RE.search(msgs) or _ANR_RE.search(msgs)
        if m:
            proc = m.group(1)
        kind = "anr" if "ANR in " in msgs else (
            "native" if "*** ***" in msgs or "signal " in msgs.split("\n", 3)[0] else "crash")
        blocks.append(CrashItem(kind, cur_when, proc,
                                _headline(msgs) or "(crash)", body, "crash buffer",
                                plain=msgs))

    for raw in text.splitlines():
        e = parse_line(raw)
        if e is None:
            continue
        starts_new = e.msg.startswith("FATAL EXCEPTION") or e.msg.startswith("ANR in ")
        if e.pid != cur_pid or starts_new:
            flush()
            cur_lines = []
            cur_msgs = []
            cur_pid = e.pid
            cur_when = e.time
        cur_lines.append(f"{e.time} {e.pid:>5} {e.tid:>5} {e.level} {e.tag}: {e.msg}")
        cur_msgs.append(e.msg)
    flush()
    return blocks


# Header lines inside `dumpsys dropbox --print <tag>` output:
#   "========================================"
#   "2026-07-11 10:00:00 data_app_crash (text, 4739 bytes)"
_DROP_HEAD_RE = re.compile(
    r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (\S+) \(([^)]*)\)\s*$", re.M)


def split_dropbox_print(text: str, tag: str) -> list[CrashItem]:
    """Split a `dumpsys dropbox --print <tag>` dump into entries."""
    items: list[CrashItem] = []
    heads = list(_DROP_HEAD_RE.finditer(text))
    for i, m in enumerate(heads):
        body = text[m.end():heads[i + 1].start() if i + 1 < len(heads) else len(text)]
        body = body.strip("\n=").strip("\n")
        if not body:
            continue
        pm = _PKG_LINE_RE.search(body)
        kind = ("anr" if "anr" in tag else
                "native" if "native" in tag or "tombstone" in tag.lower() else
                "wtf" if "wtf" in tag else "crash")
        items.append(CrashItem(kind, m.group(1), pm.group(1) if pm else "",
                               _headline(body) or tag, body, tag, plain=body))
    return items


# --- grouping (Qt-free) ------------------------------------------------------------
def crash_signature(item: CrashItem) -> str:
    """Identity used to group repeated occurrences of the same crash."""
    return f"{item.kind}|{item.process}|{item.title}"


def group_crashes(items: list[CrashItem]) -> list[dict]:
    """Collapse identical crashes into groups (input order preserved — pass
    newest-first). Each group: {'item': newest, 'count': N, 'items': [...]}."""
    groups: dict[str, dict] = {}
    order: list[dict] = []
    for it in items:
        sig = crash_signature(it)
        g = groups.get(sig)
        if g is None:
            g = {"sig": sig, "item": it, "count": 0, "items": []}
            groups[sig] = g
            order.append(g)
        g["count"] += 1
        g["items"].append(it)
    return order


# --- trace-line classification (Qt-free) ---------------------------------------------
_AT_RE = re.compile(r"^\s*at\s+([\w.$]+)\.([\w$<>]+)\((.*)\)\s*$")


def is_app_frame(cls_name: str, app_pkg: str | None) -> bool:
    if not app_pkg:
        return False
    base = app_pkg.split(":", 1)[0]
    return cls_name == base or cls_name.startswith(base + ".")


def classify_trace_line(line: str, app_pkg: str | None = None) -> str:
    """'exception' | 'cause' | 'frame-app' | 'frame' | 'text'."""
    s = line.strip()
    m = _AT_RE.match(s)
    if m:
        return "frame-app" if is_app_frame(m.group(1), app_pkg) else "frame"
    if s.startswith("Caused by:"):
        return "cause"
    if _EXC_RE.match(s):
        return "exception"
    return "text"


# Obfuscated frames look like "at a.b.c.d(SourceFile:3)" — several 1–2 letter
# package segments in a row.
_OBF_FRAME_RE = re.compile(r"\bat\s+[a-zA-Z]\d?\.[a-zA-Z]\d?\.")


def looks_obfuscated(text: str) -> bool:
    return len(_OBF_FRAME_RE.findall(text)) >= 2


# --- HTML rendering (Qt-free; QTextBrowser-compatible markup only) --------------------
def _esc(s: str) -> str:
    return _htmllib.escape(s, quote=False)


def _chip(label: str, color: str) -> str:
    return (f"<span style='background-color:{color}; color:#101218; "
            f"font-weight:700; font-size:11px'>&nbsp;{_esc(label)}&nbsp;</span>")


def build_crash_html(item: CrashItem, text: str | None = None,
                     app_pkg: str | None = None,
                     expanded: frozenset | set = frozenset(),
                     count: int = 1,
                     hint_obfuscated: bool = False,
                     retraced: bool = False) -> str:
    """Render one crash record as themed HTML for a QTextBrowser.

    * header card: kind chip, ×N occurrence badge, process, time, source
    * Caused-by chain chips linking down to each cause (root cause = last)
    * stack: app frames bright, framework frames dim, runs of >FOLD_THRESHOLD
      framework frames folded behind a `fold:<n>` link (`expanded` reopens them)
    """
    body = text if text is not None else (item.plain or item.text)
    kcolor = _KIND_COLOR.get(item.kind, theme.RED)
    app_pkg = app_pkg or (item.process.split(":", 1)[0] if item.process else None)

    lines = body.splitlines()
    causes = [i for i, l in enumerate(lines) if l.strip().startswith("Caused by:")]

    # -- header -------------------------------------------------------------
    title = _esc(item.title or "(crash)")
    badges = _chip(_KIND_LABEL.get(item.kind, "CRASH"), kcolor)
    if count > 1:
        badges += "&nbsp;" + _chip(f"×{count}", theme.ACCENT)
    if retraced:
        badges += "&nbsp;" + _chip("RETRACED", theme.GREEN)
    meta = "&nbsp;&nbsp;·&nbsp;&nbsp;".join(
        _esc(x) for x in (item.process or "(unknown process)", item.when, item.source) if x)
    head = (
        f"<table width='100%' cellpadding='6' style='background-color:{theme.SURFACE}'>"
        f"<tr><td>"
        f"{badges}<br>"
        f"<span style='font-size:15px; font-weight:700; color:{kcolor}'>{title}</span><br>"
        f"<span style='color:{theme.TEXT_DIM}; font-size:11px'>{meta}</span>"
        f"</td></tr></table>")

    # -- caused-by chain chips (root cause last in the trace → mark it) -------
    chain = ""
    if causes:
        parts = []
        for n, i in enumerate(causes):
            cause_txt = _esc(lines[i].strip()[len("Caused by:"):].strip()[:60])
            mark = "root cause — " if n == len(causes) - 1 else ""
            parts.append(f"<a href='#cause{n}' style='color:{theme.ACCENT}'>"
                         f"↳ {mark}{cause_txt}</a>")
        chain = ("<div style='margin:6px 2px; color:" + theme.TEXT_DIM + "'>"
                 + "<br>".join(parts) + "</div>")

    hint = ""
    if hint_obfuscated:
        hint = (f"<div style='background-color:{theme.SURFACE_2}; color:{theme.AMBER};"
                f" font-size:12px'>&nbsp;🔒 This trace looks R8/ProGuard-obfuscated —"
                f" load the build's mapping.txt to retrace it.&nbsp;</div>")

    # -- stack body with framework-frame folding ------------------------------
    out: list[str] = []
    fold_run: list[str] = []
    fold_no = 0
    cause_no = 0

    def flush_fold():
        nonlocal fold_no
        if not fold_run:
            return
        if len(fold_run) <= FOLD_THRESHOLD or fold_no in expanded:
            out.extend(fold_run)
        else:
            out.append(f"<a href='fold:{fold_no}' style='color:{theme.TEXT_DIM}'>"
                       f"      ⋯ {len(fold_run)} framework frames (click to expand)</a>")
        fold_no += 1
        fold_run.clear()

    for i, line in enumerate(lines):
        kind = classify_trace_line(line, app_pkg)
        e = _esc(line)
        if kind == "frame":
            fold_run.append(f"<span style='color:{theme.TEXT_DIM}'>{e}</span>")
            continue
        flush_fold()
        if kind == "frame-app":
            m = _AT_RE.match(line.strip())
            loc = _esc(m.group(3)) if m else ""
            out.append(f"<span style='color:{theme.TEXT}'>    at "
                       f"<b style='color:{theme.ACCENT_H}'>{_esc(m.group(1))}."
                       f"{_esc(m.group(2))}</b>"
                       f"(<span style='color:{theme.GREEN}'>{loc}</span>)</span>"
                       if m else f"<span style='color:{theme.ACCENT_H}'>{e}</span>")
        elif kind == "cause":
            out.append(f"<a name='cause{cause_no}'></a>"
                       f"<b style='color:{kcolor}'>{e}</b>")
            cause_no += 1
        elif kind == "exception":
            out.append(f"<b style='color:{kcolor}'>{e}</b>")
        else:
            out.append(f"<span style='color:{theme.TEXT}'>{e}</span>")
    flush_fold()

    stack = ("<pre style='font-family:Menlo,monospace; font-size:12px'>"
             + "\n".join(out) + "</pre>")
    return (f"<body style='background-color:{theme.BG}; color:{theme.TEXT}'>"
            f"{head}{hint}{chain}{stack}</body>")


# --- R8 / ProGuard retrace (Qt-free, best-effort) --------------------------------
_MAP_CLASS_RE = re.compile(r"^([\w.$]+) -> ([\w.$]+):$")
# "    1:5:void doThing(int):10:14 -> a"   (line ranges optional on either side)
_MAP_METHOD_RE = re.compile(
    r"^\s+(?:(\d+):(\d+):)?[\w.$\[\]]+ ([\w$<>]+)\([^)]*\)(?::(\d+))?(?::(\d+))? -> ([\w$<>]+)$")


@dataclass
class Mapping:
    classes: dict = field(default_factory=dict)   # obf class -> original class
    # (obf class, obf method) -> list of (start, end, orig_name, orig_start)
    methods: dict = field(default_factory=dict)


def parse_mapping(text: str) -> Mapping:
    mp = Mapping()
    cur_obf = None
    for line in text.splitlines():
        if line.startswith("#"):
            continue
        m = _MAP_CLASS_RE.match(line)
        if m:
            mp.classes[m.group(2)] = m.group(1)
            cur_obf = m.group(2)
            continue
        if cur_obf is None:
            continue
        m = _MAP_METHOD_RE.match(line)
        if m:
            start, end, orig_name, orig_start = m.group(1), m.group(2), m.group(3), m.group(4)
            mp.methods.setdefault((cur_obf, m.group(6)), []).append((
                int(start) if start else None,
                int(end) if end else None,
                orig_name,
                int(orig_start) if orig_start else None,
            ))
    return mp


# "at a.b.c.d(SourceFile:3)" — class.method(file:line)
_FRAME_RE = re.compile(r"(\bat\s+)([\w.$]+)\.([\w$<>]+)\(([^():]*)(?::(\d+))?\)")
_TOKEN_RE = re.compile(r"[\w.$]{2,}")


def _map_frame(mp: Mapping, m: re.Match) -> str:
    obf_cls, obf_m, file_part, line_s = m.group(2), m.group(3), m.group(4), m.group(5)
    cls = mp.classes.get(obf_cls, obf_cls)
    line = int(line_s) if line_s else None
    name = obf_m
    out_line = line
    for start, end, orig_name, orig_start in mp.methods.get((obf_cls, obf_m), []):
        if line is None or start is None or start <= line <= (end or start):
            name = orig_name
            if line is not None and orig_start is not None and start is not None:
                out_line = orig_start + (line - start)
            elif orig_start is not None:
                out_line = orig_start
            if line is not None and start is not None:
                break  # exact range hit; else keep last candidate
    src = cls.rsplit(".", 1)[-1].split("$", 1)[0] + ".java" \
        if cls != obf_cls and file_part in ("", "SourceFile", "Unknown Source") else file_part
    tail = f"({src}:{out_line})" if out_line is not None else f"({src})"
    return f"{m.group(1)}{cls}.{name}{tail}"


def retrace(mp: Mapping, text: str) -> str:
    """De-obfuscate stack frames + any bare obfuscated class tokens (exception
    types in `Caused by:` lines etc.). Best-effort: ambiguous inlined frames
    resolve to the last matching mapping entry."""
    def sub_token(tm: re.Match) -> str:
        return mp.classes.get(tm.group(0), tm.group(0))

    out = []
    for line in text.splitlines():
        fm = _FRAME_RE.search(line)
        if fm:
            line = _FRAME_RE.sub(lambda m: _map_frame(mp, m), line)
        else:
            line = _TOKEN_RE.sub(sub_token, line)
        out.append(line)
    return "\n".join(out)


# --- tiny settings (remember the last mapping.txt across sessions) -----------------
def _settings_path() -> str:
    return os.path.join(app_support_dir(), _SETTINGS_FILE)


def load_last_mapping_path() -> str:
    try:
        with open(_settings_path(), encoding="utf-8") as f:
            p = json.load(f).get("last_mapping", "")
        return p if p and os.path.isfile(p) else ""
    except (OSError, ValueError):
        return ""


def save_last_mapping_path(path: str) -> None:
    try:
        os.makedirs(app_support_dir(), exist_ok=True)
        with open(_settings_path(), "w", encoding="utf-8") as f:
            json.dump({"last_mapping": path}, f)
    except OSError:
        pass


# --- workers ---------------------------------------------------------------------
class CrashScanWorker(QThread):
    """Fetch the crash buffer + all dropbox crash tags; emit the merged list."""
    done = pyqtSignal(bool, str, list)   # ok, message, list[CrashItem]

    def __init__(self, adb: str, serial: str, parent=None):
        super().__init__(parent)
        self._adb = adb
        self._serial = serial

    def _run(self, args, timeout=20) -> str:
        r = subprocess.run([self._adb, *args], capture_output=True, text=True,
                           errors="replace", timeout=timeout)
        return r.stdout

    def run(self):
        items: list[CrashItem] = []
        try:
            items += split_crash_blocks(self._run(crash_buffer_args(self._serial)))
            for tag in CRASH_TAGS:
                try:
                    items += split_dropbox_print(
                        self._run(dropbox_print_args(self._serial, tag)), tag)
                except (subprocess.SubprocessError, OSError):
                    pass  # tag missing / redacted on this build — keep the rest
        except (subprocess.SubprocessError, OSError) as exc:
            self.done.emit(False, f"crash scan failed: {exc}", [])
            return
        # Newest first; dropbox timestamps are full dates, buffer ones intra-day.
        items.sort(key=lambda c: c.when, reverse=True)
        self.done.emit(True, f"{len(items)} record(s)", items)


class MappingLoadWorker(QThread):
    """Parse a mapping.txt off the UI thread (release mappings run to many MB)."""
    done = pyqtSignal(bool, str, object, str)   # ok, path, Mapping|None, error

    def __init__(self, path: str, parent=None):
        super().__init__(parent)
        self._path = path

    def run(self):
        try:
            with open(self._path, encoding="utf-8", errors="replace") as f:
                mp = parse_mapping(f.read())
        except OSError as exc:
            self.done.emit(False, self._path, None, str(exc))
            return
        self.done.emit(True, self._path, mp, "")


# --- view -----------------------------------------------------------------------
class CrashView(QWidget):
    """Crashes tab: filterable grouped list on the left, a rich rendered trace
    on the right. Follows the shared App picker for the “This app” filter and
    accepts live-crash pings from the log stream (auto-rescans when visible)."""
    status = pyqtSignal(str)
    failed = pyqtSignal(str)
    saved = pyqtSignal(bool, str, str)

    def __init__(self, adb: str, parent=None):
        super().__init__(parent)
        self._adb = adb or ""
        self._serial: str | None = None
        self._package: str | None = None
        self._worker: CrashScanWorker | None = None
        self._map_worker: MappingLoadWorker | None = None
        self._items: list[CrashItem] = []
        self._groups: list[dict] = []
        self._shown: list[dict] = []      # groups after filters, in list order
        self._mapping: Mapping | None = None
        self._expanded: set[int] = set()  # unfolded framework runs, per record
        self._pending_scan = False        # a live crash arrived while hidden
        self._auto_mapping_tried = False
        self._scanned = False             # at least one scan completed
        self._build()

        # A live crash ping re-scans shortly after (dropbox needs a beat to write).
        self._live_timer = QTimer(self)
        self._live_timer.setSingleShot(True)
        self._live_timer.timeout.connect(self._live_rescan)

    # --- UI -----------------------------------------------------------------
    def _build(self):
        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)

        bar = QWidget()
        bar.setObjectName("FilterBar")
        v = QVBoxLayout(bar)
        v.setContentsMargins(12, 8, 12, 8)
        v.setSpacing(6)

        row1 = QHBoxLayout()
        row1.setSpacing(8)
        self.refresh_btn = QPushButton("⟳  Scan crashes")
        self.refresh_btn.setToolTip(
            "Read the logcat crash buffer + dumpsys dropbox crash/ANR/WTF records")
        self.refresh_btn.clicked.connect(self.refresh)
        row1.addWidget(self.refresh_btn)

        def _kind_toggle(label, tip):
            b = QPushButton(label)
            b.setObjectName("toggle")
            b.setCheckable(True)
            b.setChecked(True)
            b.setToolTip(tip)
            b.toggled.connect(lambda *_: self._refill_list())
            return b

        self.crash_toggle = _kind_toggle("💥 Crashes", "Show Java/Kotlin fatal exceptions")
        self.anr_toggle = _kind_toggle("⏳ ANRs", "Show Application-Not-Responding records")
        self.other_toggle = _kind_toggle("🧨 Other", "Show native crashes and Log.wtf records")
        row1.addWidget(self.crash_toggle)
        row1.addWidget(self.anr_toggle)
        row1.addWidget(self.other_toggle)
        self.app_only = QPushButton("This app")
        self.app_only.setObjectName("toggle")
        self.app_only.setCheckable(True)
        self.app_only.setEnabled(False)
        self.app_only.setToolTip("Only records from the app selected in the App box")
        self.app_only.toggled.connect(lambda *_: self._refill_list())
        row1.addWidget(self.app_only)
        self.search_edit = QLineEdit()
        self.search_edit.setPlaceholderText("🔍  Filter crashes  (process or exception)")
        self.search_edit.setClearButtonEnabled(True)
        self.search_edit.textChanged.connect(lambda *_: self._refill_list())
        row1.addWidget(self.search_edit, 1)
        self.count_lbl = QLabel("")
        self.count_lbl.setObjectName("MockStatus")
        row1.addWidget(self.count_lbl)
        v.addLayout(row1)

        row2 = QHBoxLayout()
        row2.setSpacing(8)
        self.mapping_btn = QPushButton("Load mapping.txt…")
        self.mapping_btn.setToolTip(
            "Load an R8/ProGuard mapping file to de-obfuscate stack traces "
            "(remembered across sessions)")
        self.mapping_btn.clicked.connect(self._pick_mapping)
        row2.addWidget(self.mapping_btn)
        self.retrace_btn = QPushButton("Retrace")
        self.retrace_btn.setObjectName("toggle")
        self.retrace_btn.setCheckable(True)
        self.retrace_btn.setEnabled(False)
        self.retrace_btn.setToolTip("Show the selected record de-obfuscated")
        self.retrace_btn.toggled.connect(lambda *_: self._show_current())
        row2.addWidget(self.retrace_btn)
        self.mapping_lbl = QLabel("")
        self.mapping_lbl.setObjectName("MockStatus")
        row2.addWidget(self.mapping_lbl)
        row2.addStretch(1)
        self.copy_btn = QPushButton("Copy")
        self.copy_btn.setObjectName("toggle")
        self.copy_btn.setToolTip("Copy the trace (as displayed) to the clipboard")
        self.copy_btn.clicked.connect(self._copy_current)
        row2.addWidget(self.copy_btn)
        self.save_btn = QPushButton("Save…")
        self.save_btn.setObjectName("toggle")
        self.save_btn.setToolTip("Save the selected record (as displayed) to a text file")
        self.save_btn.clicked.connect(self._save_current)
        row2.addWidget(self.save_btn)
        v.addLayout(row2)
        root.addWidget(bar)

        split = QSplitter(Qt.Orientation.Horizontal)
        self.list = QListWidget()
        self.list.setWordWrap(True)
        self.list.setSpacing(2)
        self.list.currentRowChanged.connect(self._on_row_changed)
        split.addWidget(self.list)

        self.detail = QTextBrowser()
        self.detail.setObjectName("CrashDetail")
        self.detail.setFrameShape(QTextBrowser.Shape.NoFrame)
        self.detail.setOpenLinks(False)
        self.detail.setOpenExternalLinks(False)
        self.detail.anchorClicked.connect(self._on_anchor)
        self._show_empty_state()
        split.addWidget(self.detail)
        split.setStretchFactor(0, 0)
        split.setStretchFactor(1, 1)
        split.setSizes([360, 820])
        root.addWidget(split, 1)

    def _show_empty_state(self, scanned: bool = False):
        msg = ("No crashes on this device — nothing in the crash buffer or dropbox. 🎉"
               if scanned else
               "Hit <b>⟳ Scan crashes</b> to read the device's crash buffer and "
               "dropbox records.<br><br>"
               "· Crashes group by exception — the <b>×N</b> badge counts repeats<br>"
               "· App frames are highlighted; framework runs fold out of the way<br>"
               "· Load a <b>mapping.txt</b> to retrace obfuscated release builds")
        self.detail.setHtml(
            f"<body style='background-color:{theme.BG}'>"
            f"<div style='color:{theme.TEXT_DIM}; font-size:13px; margin:24px'>{msg}</div>"
            f"</body>")

    # --- lifecycle -------------------------------------------------------------
    def set_serial(self, serial: str | None):
        if serial == self._serial:
            return
        self._serial = serial
        self._items = []
        self._groups = []
        self._shown = []
        self._scanned = False
        self.list.clear()
        self._show_empty_state()
        self.count_lbl.setText("")

    def set_package(self, package: str | None):
        """Follow the shared App picker — enables the “This app” filter."""
        self._package = (package or None) and package.split(":", 1)[0]
        self.app_only.setEnabled(bool(self._package))
        self.app_only.setToolTip(
            f"Only records from {self._package}" if self._package
            else "Only records from the app selected in the App box")
        if self.app_only.isChecked():
            self._refill_list()

    def showEvent(self, event):
        super().showEvent(event)
        if not self._auto_mapping_tried:
            self._auto_mapping_tried = True
            last = load_last_mapping_path()
            if last:
                self._load_mapping(last, announce=False)
        if self._pending_scan:
            self._pending_scan = False
            self.refresh()

    def shutdown(self):
        if self._worker is not None:
            self._worker.wait(2000)
            self._worker = None
        if self._map_worker is not None:
            self._map_worker.wait(2000)
            self._map_worker = None

    # --- live-crash ping (from the log stream) -----------------------------------
    def notify_live_crash(self):
        """Called by MainWindow when the live stream shows a FATAL EXCEPTION /
        ANR line. Debounced re-scan when visible; deferred to next show if not."""
        if self.isVisible():
            self._live_timer.start(1500)   # give dropbox a beat to persist it
        else:
            self._pending_scan = True

    def _live_rescan(self):
        if self._worker is None:
            self.refresh()

    # --- scan --------------------------------------------------------------------
    def refresh(self):
        if not self._adb or not self._serial:
            self.failed.emit("Crashes: no device selected")
            return
        if self._worker is not None:
            self.status.emit("A crash scan is already running…")
            return
        self.refresh_btn.setEnabled(False)
        self.refresh_btn.setText("Scanning…")
        self._worker = CrashScanWorker(self._adb, self._serial, self)
        self._worker.done.connect(self._on_scan_done)
        self._worker.start()

    def _on_scan_done(self, ok: bool, message: str, items: list):
        self._worker = None
        self.refresh_btn.setEnabled(True)
        self.refresh_btn.setText("⟳  Scan crashes")
        if not ok:
            self.failed.emit(f"Crashes: {message}")
            return
        self._items = items
        self._groups = group_crashes(items)
        self._scanned = True
        self._refill_list()
        self.status.emit(f"Crashes: {message}, {len(self._groups)} unique")

    # --- list building / filtering -------------------------------------------------
    def _group_passes(self, g: dict) -> bool:
        it = g["item"]
        if it.kind == "crash" and not self.crash_toggle.isChecked():
            return False
        if it.kind == "anr" and not self.anr_toggle.isChecked():
            return False
        if it.kind in ("native", "wtf") and not self.other_toggle.isChecked():
            return False
        if self.app_only.isChecked() and self._package:
            if it.process.split(":", 1)[0] != self._package:
                return False
        needle = self.search_edit.text().strip().lower()
        if needle and needle not in f"{it.process} {it.title}".lower():
            return False
        return True

    def _refill_list(self):
        prev = self._shown[self.list.currentRow()]["sig"] \
            if 0 <= self.list.currentRow() < len(self._shown) else None
        self._shown = [g for g in self._groups if self._group_passes(g)]
        self.list.blockSignals(True)
        self.list.clear()
        reselect = 0
        for i, g in enumerate(self._shown):
            it = g["item"]
            badge = f"  ×{g['count']}" if g["count"] > 1 else ""
            glyph = _KIND_GLYPH.get(it.kind, "💥")
            item = QListWidgetItem(
                f"{glyph}  {it.process or '(unknown)'}{badge}\n"
                f"{it.title[:110]}\n{it.when}   ·   {it.source}")
            item.setForeground(QColor(_KIND_COLOR.get(it.kind, theme.RED)))
            item.setToolTip(f"{g['count']} occurrence(s)\n{it.title}")
            self.list.addItem(item)
            if g["sig"] == prev:
                reselect = i
        self.list.blockSignals(False)
        total = sum(g["count"] for g in self._shown)
        self.count_lbl.setText(
            f"{len(self._shown)} unique · {total} total" if self._shown else "")
        if self._shown:
            self.list.setCurrentRow(reselect)   # emits → renders detail
        elif self._groups:
            self.detail.setHtml(
                f"<body style='background-color:{theme.BG}'><div style='color:"
                f"{theme.TEXT_DIM}; margin:24px'>No records match the current "
                f"filters.</div></body>")
        else:
            self._show_empty_state(scanned=self._scanned)

    # --- detail rendering -----------------------------------------------------------
    def _current_group(self) -> dict | None:
        row = self.list.currentRow()
        return self._shown[row] if 0 <= row < len(self._shown) else None

    def _on_row_changed(self, *_):
        self._expanded = set()      # folds are per-record
        self._show_current()

    def _display_text(self, item: CrashItem) -> str:
        text = item.plain or item.text
        if self._mapping is not None and self.retrace_btn.isChecked():
            text = retrace(self._mapping, text)
        return text

    def _show_current(self, keep_scroll: bool = False):
        g = self._current_group()
        if g is None:
            return
        it = g["item"]
        text = self._display_text(it)
        retraced = self._mapping is not None and self.retrace_btn.isChecked()
        pos = self.detail.verticalScrollBar().value() if keep_scroll else 0
        self.detail.setHtml(build_crash_html(
            it, text=text, app_pkg=self._package,
            expanded=self._expanded, count=g["count"],
            hint_obfuscated=(not retraced) and looks_obfuscated(text),
            retraced=retraced))
        self.detail.verticalScrollBar().setValue(pos)

    def _on_anchor(self, url):
        s = url.toString()
        if s.startswith("fold:"):
            try:
                n = int(s[5:])
            except ValueError:
                return
            self._expanded.symmetric_difference_update({n})
            self._show_current(keep_scroll=True)
        elif s.startswith("#"):
            self.detail.scrollToAnchor(s[1:])

    # --- mapping / retrace -------------------------------------------------------
    def _pick_mapping(self):
        path, _ = QFileDialog.getOpenFileName(
            self, "Load R8/ProGuard mapping", "", "Mapping files (mapping*.txt *.txt *.map)")
        if path:
            self._load_mapping(path, announce=True)

    def _load_mapping(self, path: str, announce: bool):
        if self._map_worker is not None:
            return
        self.mapping_btn.setEnabled(False)
        self.mapping_lbl.setText(f"Loading {os.path.basename(path)}…")
        self._map_worker = MappingLoadWorker(path, self)
        self._map_worker.done.connect(
            lambda ok, p, mp, err: self._on_mapping_loaded(ok, p, mp, err, announce))
        self._map_worker.start()

    def _on_mapping_loaded(self, ok: bool, path: str, mp, error: str, announce: bool):
        self._map_worker = None
        self.mapping_btn.setEnabled(True)
        if not ok or mp is None or not mp.classes:
            self.mapping_lbl.setText("")
            if announce:
                self.failed.emit(f"Couldn't read mapping: {error or 'no class mappings found'}")
            return
        self._mapping = mp
        save_last_mapping_path(path)
        self.retrace_btn.setEnabled(True)
        self.retrace_btn.setChecked(True)
        self.mapping_lbl.setText(
            f"{os.path.basename(path)} · {len(mp.classes):,} classes")
        if announce:
            self.status.emit(f"Mapping loaded: {len(mp.classes):,} classes")
        self._show_current()

    # --- copy / save -----------------------------------------------------------------
    def _export_text(self) -> tuple[CrashItem, str] | None:
        g = self._current_group()
        if g is None:
            self.status.emit("Select a crash record first")
            return None
        it = g["item"]
        head = f"[{it.source}]  {it.when}  {it.process}  ({g['count']} occurrence(s))"
        return it, f"{head}\n\n{self._display_text(it)}"

    def _copy_current(self):
        exp = self._export_text()
        if exp is None:
            return
        QGuiApplication.clipboard().setText(exp[1])
        self.status.emit("✓ Trace copied to the clipboard")

    def _save_current(self):
        exp = self._export_text()
        if exp is None:
            return
        it, text = exp
        stamp = it.when.replace(":", "").replace(" ", "-").replace(".", "-")
        name = f"crash-{(it.process or 'unknown').replace('/', '_')}-{stamp}.txt"
        path, _ = QFileDialog.getSaveFileName(self, "Save crash record",
                                              f"~/Downloads/{name}", "Text (*.txt)")
        if not path:
            return
        path = os.path.expanduser(path)
        try:
            with open(path, "w", encoding="utf-8") as f:
                f.write(text)
        except OSError as exc:
            self.saved.emit(False, f"Couldn't save: {exc}", "")
            return
        self.saved.emit(True, f"Crash record saved to {os.path.basename(path)}",
                        os.path.dirname(path))
