"""Headless smoke test: parser, filters, model, and full-UI construction.

Run: QT_QPA_PLATFORM=offscreen .venv/bin/python tests/smoke.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from logcat_viewer.parser import parse_line, PRIORITY
from logcat_viewer.filters import FilterSpec

SAMPLE = [
    "07-09 14:23:01.123  1234  1250 D BActivityThread: bindApplication com.glite.poc",
    "07-09 14:23:01.200  1234  1250 I GmsProxy: getServiceRequest ZERO_PARTY",
    "07-09 14:23:01.310  5678  5678 W ChromeMonoFix: patched libmonochrome.so",
    "07-09 14:23:01.420  5678  5690 E AndroidRuntime: FATAL EXCEPTION: main",
    "07-09 14:23:01.421  5678  5690 E AndroidRuntime:  at com.foo.Bar.baz(Bar.java:42)",
    "--------- beginning of crash",
    "",
    "07-09 14:23:02.000   999   999 V Scion: noise noise noise",
]

fails = []


def check(cond, msg):
    if not cond:
        fails.append(msg)
    print(("ok  " if cond else "FAIL") + "  " + msg)


# --- parser ----------------------------------------------------------------
entries = [e for e in (parse_line(l) for l in SAMPLE) if e is not None]
check(len(entries) == 6, f"6 content lines parsed (dividers/blank dropped), got {len(entries)}")
e0 = entries[0]
check(e0.pid == 1234 and e0.tid == 1250, "pid/tid parsed")
check(e0.level == "D" and e0.tag == "BActivityThread", "level/tag parsed")
check(e0.msg == "bindApplication com.glite.poc", "message parsed")
check(entries[3].priority == PRIORITY["E"], "error priority")


def matched(**kw):
    spec = FilterSpec(**kw).compile()
    return [e for e in entries if spec.match(e)], spec


# --- filters ---------------------------------------------------------------
res, _ = matched(min_priority=PRIORITY["W"])
check(len(res) == 3, f"level>=Warn keeps W+E+E = 3, got {len(res)}")

res, _ = matched(tag_query="gmsproxy")
check(len(res) == 1 and res[0].tag == "GmsProxy", "tag substring is case-insensitive")

res, _ = matched(tag_query="BActivityThread|GmsProxy", tag_regex=True)
check(len(res) == 2, f"tag regex alternation matches 2, got {len(res)}")

res, _ = matched(pids="5678")
check(len(res) == 3 and all(e.pid == 5678 for e in res), "PID filter")

res, _ = matched(pids="1234, 999")
check(len(res) == 3, f"multi-PID filter matches 3 (pid 1234 x2 + 999), got {len(res)}")

res, _ = matched(text_query="FATAL")
check(len(res) == 1, f"free-text find matches 1, got {len(res)}")

res, _ = matched(exclude_query="Scion")
check(len(res) == 5 and all("Scion" not in e.tag for e in res), "exclude drops Scion")

res, _ = matched(package_pids=frozenset({5678}))
check(len(res) == 3 and all(e.pid == 5678 for e in res), "app filter (package_pids) keeps only that app's pids")

res, _ = matched(package_pids=frozenset())
check(len(res) == 0, "selected app not running (empty pid set) shows nothing")

res, _ = matched(text_query="com\\.foo\\.\\w+", text_regex=True)
check(len(res) == 1, f"find regex matches stacktrace line, got {len(res)}")

# invalid regex -> field disabled + error recorded, stream still flows
res, spec = matched(text_query="(unclosed", text_regex=True)
check(spec.has_error("text"), "invalid regex records an error")
check(len(res) == 6, "invalid regex disables field (all pass), not zero")

# --- model + full UI (offscreen) -------------------------------------------
from PyQt6.QtWidgets import QApplication
from logcat_viewer.model import LogTableModel
from logcat_viewer.ui import MainWindow

app = QApplication([])

model = LogTableModel(max_entries=100, trim_chunk=10)
model.append_batch(entries)
check(model.rowCount() == 6, f"model shows 6 rows, got {model.rowCount()}")
model.set_filter(FilterSpec(min_priority=PRIORITY["E"]).compile())
check(model.rowCount() == 2, f"filtered model shows 2 error rows, got {model.rowCount()}")

# ring-buffer trim
big = [e for _ in range(30) for e in entries]  # 180 entries
model.set_filter(FilterSpec().compile())
model.append_batch(big)
check(model.total_count() <= 100, f"ring buffer trimmed to <=100, got {model.total_count()}")

win = MainWindow()
win.show()
win._on_lines(SAMPLE)   # feed lines through the real pipeline
win._flush()
check(win.model.total_count() == 6, f"UI pipeline ingested 6, got {win.model.total_count()}")
win.text_edit.setText("GmsProxy")
win.apply_filter()
check(win.model.rowCount() == 1, f"UI live filter -> 1 row, got {win.model.rowCount()}")
win.set_paused(True)
win._on_lines(["07-09 14:23:03.000  111  111 I Later: after pause"])
win._flush()
check(win.model.total_count() == 6, "paused: new line buffered, not shown")
win.set_paused(False)
win._flush()
check(win.model.total_count() == 7, "resume: buffered line flushed")

# app filter through the real UI path (7 entries; pids 5678 x3)
win.text_edit.setText("")
win._app_pkg = "com.example.app"
win._app_pids = frozenset({5678})
win.apply_filter()
check(win.model.rowCount() == 3, f"UI app filter -> 3 rows for pid 5678, got {win.model.rowCount()}")
win._app_pkg = None
win._app_pids = None
win.apply_filter()
check(win.model.rowCount() == 7, "clearing app filter restores all rows")

# font size controls
from logcat_viewer.ui import FONT_MIN, FONT_MAX
base = win._font_pt
win.bump_font(+3)
check(win._font_pt == base + 3, f"font increase by 3 -> {base + 3}, got {win._font_pt}")
row_h_big = win.table.verticalHeader().defaultSectionSize()
win.bump_font(-1000)
check(win._font_pt == FONT_MIN, "font decrease clamps to FONT_MIN")
check(win.table.verticalHeader().defaultSectionSize() < row_h_big, "row height shrinks with font")
win.bump_font(+1000)
check(win._font_pt == FONT_MAX, "font increase clamps to FONT_MAX")

# copy selection -> clipboard
from PyQt6.QtGui import QGuiApplication
win.table.selectAll()
check(len(win.table.selectionModel().selectedRows()) == win.model.rowCount(),
      "selectAll selects every visible row")
win.table.copy_selection()
clip = QGuiApplication.clipboard().text()
check(clip.count("\n") == win.model.rowCount() - 1 and len(clip) > 0,
      f"copy_selection copies all selected lines (got {clip.count(chr(10)) + 1} lines)")

# word-wrap: a long message grows the row beyond a single line; unwrap resets it
win.resize(900, 600)
win.show()
app.processEvents()
long_line = "07-09 14:23:09.000  1234  1250 I LongTag: " + ("word " * 80).strip()
win.text_edit.setText("")
win._app_pkg = None
win._app_pids = None
win.apply_filter()
win.set_wrap(True)
win._on_lines([long_line])
win._flush()
app.processEvents()
win._resize_visible_rows()
app.processEvents()
long_row = next((r for r in range(win.model.rowCount())
                 if win.model.entry_at(r).tag == "LongTag"), None)
single = win._row_height()
check(long_row is not None, "long-message row present")
h_wrapped = win.table.rowHeight(long_row)
check(h_wrapped > single, f"wrapped long row taller than one line ({h_wrapped} > {single})")
win.set_wrap(False)
app.processEvents()
check(win.table.rowHeight(long_row) == single,
      f"unwrap resets row to single line (got {win.table.rowHeight(long_row)}, want {single})")

# non-wrap: Message column grows to fit a long line -> horizontal scroll
from PyQt6.QtGui import QFontMetrics
from logcat_viewer.model import COL_MSG
verylong = "07-09 14:23:11.000  1  1 I HScroll: " + ("A" * 600)
win._on_lines([verylong])
win._flush()
app.processEvents()
win.table.scrollToBottom()
win._fit_message_width()
app.processEvents()
adv = QFontMetrics(win._mono).horizontalAdvance("A" * 600)
colw = win.table.columnWidth(COL_MSG)
check(colw >= adv, f"non-wrap message column grows to fit long line ({colw} >= {adv})")

print()
if fails:
    print(f"{len(fails)} FAILURE(S)")
    sys.exit(1)
print("ALL SMOKE CHECKS PASSED")
