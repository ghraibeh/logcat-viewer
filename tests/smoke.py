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

# "|" = OR across substring terms (no regex mode needed)
res, _ = matched(text_query="fatal|com.foo")
check(len(res) == 2, f"find 'fatal|com.foo' matches either (2), got {len(res)}")
res, _ = matched(tag_query="bactivitythread|gmsproxy")
check(len(res) == 2 and {e.tag for e in res} == {"BActivityThread", "GmsProxy"},
      "tag OR-terms match either tag (case-insensitive)")
res, _ = matched(exclude_query="scion|gmsproxy")
check(len(res) == 4 and all(e.tag not in ("Scion", "GmsProxy") for e in res),
      f"exclude OR-terms drop lines matching either (4 left), got {len(res)}")
# trailing / empty terms are ignored, so `error|` behaves like `error`
res, _ = matched(text_query="fatal|")
check(len(res) == 1, f"trailing '|' is ignored (still 1), got {len(res)}")
res, _ = matched(text_query="|")
check(len(res) == 6, "a query of only '|' has no terms -> no filtering")

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

# defaults: Level -> "All levels", Auto-scroll + Wrap off, stream controls in Logs
check(win.level_combo.itemText(0) == "All levels" and win.level_combo.itemData(0) == 0,
      "Level dropdown has an 'All levels' entry at the top (shows everything)")
check(win.level_combo.currentIndex() == 0, "Level defaults to 'All levels'")
check(not win.autoscroll_cb.isChecked(), "Auto-scroll is off by default")
check(not win.wrap_cb.isChecked() and not win._wrap, "Wrap is off by default")
# Start/Pause/Clear now belong to the Logs tab, not the shared device toolbar
_logs_tab = win.tabs.widget(0)
for _b, _n in ((win.start_btn, "Start"), (win.pause_btn, "Pause"), (win.clear_btn, "Clear")):
    check(win.tabs.isAncestorOf(_b) and _logs_tab.isAncestorOf(_b),
          f"{_n} lives inside the Logs tab, not the device bar")
check(not win.tabs.isAncestorOf(win.mirror_btn), "Mirror stays on the shared device bar")
# selecting a row must not yank the view around — autoScroll off
check(not win.table.hasAutoScroll(), "table autoScroll off (select doesn't scroll the view)")

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

# app filter must NOT blank out when the app closes / is between restarts:
# select_app/_refresh_app_pids only ever add PIDs, never drop the known set
# (an empty pid set matches nothing and would hide the whole log).
win._app_pkg = None
win._app_pids = None
_fake_pids = {"n": {5678}}
win._current_app_pkg = lambda: "com.example.app"
win._resolve_pids = lambda pkg: set(_fake_pids["n"])
win.select_app()
check(win._app_pids == frozenset({5678}), "select_app resolves the running app's pids")
_fake_pids["n"] = set()                 # app closes -> no pids on device
win._refresh_app_pids()
check(win._app_pids == frozenset({5678}),
      "app closes: refresh keeps last-known pids (log stays, not blanked)")
win.apply_filter()
check(win.model.rowCount() == 3, "closed app: its already-captured logs stay visible")
_fake_pids["n"] = {9999}                # app restarts with a new pid
win._refresh_app_pids()
check(win._app_pids == frozenset({5678, 9999}),
      "app restarts: refresh adds the new pid (spans the restart)")
del win._current_app_pkg, win._resolve_pids   # drop the instance overrides
win._app_pkg = None
win._app_pids = None
win.apply_filter()

# --- revamped filter bar: Advanced panel + Clear filters -------------------
check(not win.advanced_panel.isVisible(), "Advanced panel is collapsed by default")
win.advanced_btn.setChecked(True)
check(win.advanced_panel.isVisible(), "Advanced toggle reveals the tag/PID/exclude panel")
win.advanced_btn.setChecked(False)
check(not win.advanced_panel.isVisible(), "Advanced toggle hides the panel again")
# a hidden-but-active advanced filter is flagged so rows are never silently dropped
win.tag_edit.setText("GmsProxy")
win.apply_filter()
check("●" in win.advanced_btn.text(), "collapsed Advanced flags an active hidden filter")
check(win.model.rowCount() == 1, "hidden advanced tag filter still applies (1 row)")
# Clear filters resets every field on the bar (not the log, app picker, or view)
win.text_edit.setText("noise"); win.text_regex_cb.setChecked(True)
win.pid_edit.setText("999"); win.exclude_edit.setText("Scion")
win.level_combo.setCurrentIndex(4)   # a non-default level (index 0 is "All levels")
win.clear_filters()
check(win.text_edit.text() == "" and win.tag_edit.text() == ""
      and win.pid_edit.text() == "" and win.exclude_edit.text() == "",
      "Clear filters empties every filter field")
check(not win.text_regex_cb.isChecked() and not win.tag_regex_cb.isChecked()
      and not win.exclude_regex_cb.isChecked(), "Clear filters resets the regex toggles")
check(win.level_combo.currentIndex() == 0, "Clear filters resets level to All levels")
check(win.advanced_btn.text() == "Advanced", "Clear filters drops the Advanced active dot")
check(win.model.rowCount() == 7, "Clear filters shows all rows again (log untouched)")

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

# --- mock location ---------------------------------------------------------
from logcat_viewer.mocklocation import set_args, stop_args, MockLocationView, HELPER_APK, MAP_HTML

sa = set_args("SER", 12.34, -56.78, acc=5)
check(sa[:2] == ["-s", "SER"] and "start-foreground-service" in sa,
      "set_args targets the serial + foreground service")
check("12.3400000" in sa and "-56.7800000" in sa,
      "set_args passes lat/lng as full-precision string extras")
check(sa[sa.index("cmd") + 1] == "set", "set_args sends cmd=set")
check(stop_args("SER")[stop_args("SER").index("cmd") + 1] == "stop", "stop_args sends cmd=stop")
check(os.path.isfile(HELPER_APK), "bundled helper APK present in assets")
check(os.path.isfile(MAP_HTML), "map.html present in assets")

# --- performance monitor (pure parsing) ------------------------------------
from logcat_viewer import monitor as mon
_PROC = (
    "cpu  100 0 50 800 50 0 0 0 0 0\n"
    "cpu0 50 0 25 400 25 0 0 0 0 0\n"
    "cpu1 50 0 25 400 25 0 0 0 0 0\n"
    "intr 123 4 5\n"
    "MemTotal:        8000000 kB\n"
    "MemAvailable:    3000000 kB\n"
    "MemFree:         1000000 kB\n"
    "SwapTotal:       2000000 kB\n"
    "1.50 1.20 0.90 2/900 12345\n"
)
st = mon.parse_cpu_stat(_PROC)
check(st == (1000, 850), f"parse_cpu_stat sums jiffies, idle=idle+iowait, got {st}")
check(mon.cpu_core_count(_PROC) == 2, "cpu_core_count counts per-core lines")
_cores = mon.parse_cpu_cores(_PROC)
check(len(_cores) == 2 and _cores[0] == (500, 425),
      f"parse_cpu_cores returns per-core (total, idle) in order, got {_cores}")
# per-core busy% via delta: cpu0 idle unchanged across samples => 100% busy
_nxt = _PROC.replace("cpu0 50 0 25 400 25", "cpu0 100 0 50 400 25")
check(abs(mon.cpu_percent(mon.parse_cpu_cores(_PROC)[0],
                          mon.parse_cpu_cores(_nxt)[0]) - 100.0) < 0.01,
      "per-core cpu_percent computes from the cpuN delta")
mi = mon.parse_meminfo(_PROC)
check(mi["total"] == 8000000 and mi["available"] == 3000000, "parse_meminfo reads KB values")
check(mon.mem_used_kb(mi) == (5000000, 8000000), "mem_used_kb = total - available")
check(mon.parse_loadavg(_PROC) == (1.50, 1.20, 0.90), "parse_loadavg reads the 3 averages")
# busy% between two samples: Δtotal=100, Δidle=50 -> 50%
prev = mon.parse_cpu_stat(_PROC)
nxt = mon.parse_cpu_stat(_PROC.replace("cpu  100 0 50 800 50", "cpu  150 0 50 850 50"))
check(abs(mon.cpu_percent(prev, nxt) - 50.0) < 0.01,
      f"cpu_percent busy delta = 50%, got {mon.cpu_percent(prev, nxt)}")
check(mon.cpu_percent(prev, prev) is None, "cpu_percent with no delta -> None")
check(mon.mem_used_kb({}) is None and mon.parse_cpu_stat("nope") is None,
      "monitor parsers tolerate junk/empty input")
# per-app CPU/RAM parsing (dumpsys) — no root / debuggable needed
_CPUINFO = (
    "Load: 1.0 / 1.1 / 1.2\n"
    "  8.3% 12345/com.example.app: 5% user + 3.3% kernel\n"
    "  2.0% 12346/com.example.app:push: 1% user + 1% kernel\n"
    "  4.0% 999/system_server: 2% user + 2% kernel\n"
)
check(abs(mon.parse_app_cpu(_CPUINFO, "com.example.app") - 10.3) < 0.01,
      "parse_app_cpu sums the app's processes (incl. :child), got "
      f"{mon.parse_app_cpu(_CPUINFO, 'com.example.app')}")
check(mon.parse_app_cpu(_CPUINFO, "com.not.here") is None,
      "parse_app_cpu -> None when the app isn't running")
check(mon.parse_app_meminfo("App Summary\n TOTAL PSS: 234567  TOTAL RSS: 300000\n") == 234567,
      "parse_app_meminfo reads TOTAL PSS (newer format)")
check(mon.parse_app_meminfo("  TOTAL      45678   12000   3000\n") == 45678,
      "parse_app_meminfo falls back to the TOTAL table row (older format)")
check(mon.build_probe(None) == mon.PROBE and "dumpsys meminfo com.x" in mon.build_probe("com.x"),
      "build_probe appends dumpsys reads only when a package is watched")
check("'weird; rm'" in mon.build_probe("weird; rm"),
      "build_probe shell-quotes the package name (injection-safe)")
# selecting an app in the picker overlays it on the Monitor tab
win.monitor_view.set_package("com.example.app")
check(win.monitor_view._package == "com.example.app", "Monitor follows the App picker")
win.monitor_view.set_package(None)
# the Monitor tab must not poll adb until it's shown with a device
check(win.monitor_view._worker is None, "Monitor idle (no worker) until shown with a device")

# --- memory-leak detection (LeakCanary / Shark) ----------------------------
from logcat_viewer import leakdetect as leak
check(leak.SHARK_MAIN == "shark.MainKt" and len(leak._SHARK_JARS) >= 10,
      "Shark analyze classpath is pinned (main class + jar set)")
check(leak.leak_summary("====\n0 APPLICATION LEAKS\n").startswith("No application leaks"),
      "leak_summary reads 0 leaks")
check(leak.leak_summary("3 APPLICATION LEAKS") == "3 application leak(s) found",
      "leak_summary reads N leaks")
# the report is built as visual HTML (WebEngine view stays lazy — not built headless)
_SAMPLE_LEAK = (
    "====\nHEAP ANALYSIS RESULT\n====\n2 APPLICATION LEAKS\n\n"
    "References underlined with \"~~~\" are likely causes.\n====\n"
    "13,906 bytes retained by leaking objects\nSignature: abc123def456\n"
    "┬───\n│ GC Root: System class\n├─ com.x.Foo class\n│    Leaking: NO (a class)\n"
    "│    ↓ static Foo.bar\n╰→ com.x.LeakyThing instance\n     Leaking: YES (leak!)\n"
    "                      ~~~~~~~~\n====\n0 LIBRARY LEAKS\n\n====\n"
    "0 UNREACHABLE OBJECTS\n\n====\nMETADATA\n\nBuild.VERSION.SDK_INT: 36\n"
    "Heap total bytes: 35235888\nInstance count: 412508\nClass count: 27958\n"
    "Bitmap count: 54\nAnalysis duration: 1575 ms\n====\n")
_html = leak.build_report_html("com.x", _SAMPLE_LEAK)
check("<!doctype html>" in _html.lower() and "com.x" in _html,
      "build_report_html emits an HTML document for the package")
check(_html.count('class="card leak"') == 1 and "2 application leaks found" in _html,
      "leak count in banner; a visual card per parsed leak trace")
check('class="yes"' in _html and 'class="no"' in _html and 'class="cause"' in _html,
      "leak trace colorizes Leaking YES/NO + likely-cause lines")
check("35.2 MB" in _html and "412,508" in _html,
      "metadata rendered as formatted stat tiles (bytes→MB, thousands)")
_ok_html = leak.build_report_html("com.x", "====\n0 APPLICATION LEAKS\n====\nMETADATA\n")
check('class="banner ok"' in _ok_html and 'class="card leak"' not in _ok_html,
      "zero-leak report shows the green banner and no leak cards")
check(not win.monitor_view.leak_btn.isEnabled(), "Detect-leaks disabled with no app selected")
win.monitor_view.set_serial("SER"); win.monitor_view.set_package("com.example.app")
check(win.monitor_view.leak_btn.isEnabled(), "Detect-leaks enabled once device + app are set")
win.monitor_view.set_package(None); win.monitor_view.set_serial(None)

# tabs present; the map webview stays lazy (never built in headless smoke)
check(win.tabs.count() == 7,
      f"main window has 7 tabs (…Apps + Monitor), got {win.tabs.count()}")
check(win.tabs.tabText(0) == "Logs" and win.tabs.tabText(1) == "Location"
      and win.tabs.tabText(2) == "Network HTTP" and win.tabs.tabText(3) == "Databases"
      and win.tabs.tabText(4) == "Files" and win.tabs.tabText(5) == "Apps"
      and win.tabs.tabText(6) == "Monitor",
      "tab labels end with Apps then Monitor")

# Logs tab has a click-to-pick app list (All apps + clones + device apps)
from PyQt6.QtCore import Qt as _QtLog
_UR = _QtLog.ItemDataRole.UserRole
win._populate_log_app_list(["clone.app"], ["com.aaa", "com.bbb"])
check(win.log_app_list.count() == 4
      and win.log_app_list.item(0).text() == "All apps"
      and win.log_app_list.item(0).data(_UR) is None
      and win.log_app_list.item(1).data(_UR) == "clone.app"
      and "(clone)" in win.log_app_list.item(1).text(),
      "Logs app list mirrors All apps + clones + device apps from the picker")
win._app_pkg = "com.bbb"
win._sync_log_app_selection()
check(win.log_app_list.currentItem().data(_UR) == "com.bbb",
      "_sync_log_app_selection highlights the current app in the Logs list")
win._filter_log_app_list("aaa")
check(not win.log_app_list.item(0).isHidden()          # All apps always shown
      and not win.log_app_list.item(2).isHidden()      # com.aaa matches
      and win.log_app_list.item(3).isHidden(),         # com.bbb filtered out
      "Logs app-list search hides non-matching apps but keeps All apps")
win._filter_log_app_list("")
# both the Logs and Monitor tabs embed an app-picker panel, kept in sync
check(len(win._app_panels) == 2, f"Logs + Monitor each have an app panel, got {len(win._app_panels)}")
_mon_panel = win._app_panels[1]
check(_mon_panel.list.count() == 4 and _mon_panel.list.item(1).data(_UR) == "clone.app",
      "Monitor app panel is populated from the same picker data")
win._app_pkg = "com.aaa"
win._sync_log_app_selection()
check(_mon_panel.list.currentItem().data(_UR) == "com.aaa",
      "selecting an app highlights it in the Monitor panel too")
# picking in the Monitor panel drives the shared selection (→ overlays on Monitor)
_mon_panel.list.setCurrentRow(3)   # com.bbb
check(win._app_pkg == "com.bbb" and win.monitor_view._package == "com.bbb",
      "picking in the Monitor app panel selects that app everywhere")
win._filter_log_app_list("")
win._app_pkg = None
win._sync_log_app_selection()
win.mock_view.set_serial("DEVICE1")
win.mock_view.set_serial(None)
check(win.mock_view._web is None, "map webview stays lazy until the Location tab is shown")

# picking a coordinate via the lat/lng fields (no device, no map needed)
mv = win.mock_view
mv.lat_edit.setText("37.7749")
mv.lng_edit.setText("-122.4194")
mv._apply_fields()
check(mv._lat is not None and abs(mv._lat - 37.7749) < 1e-6 and abs(mv._lng + 122.4194) < 1e-6,
      "typed coordinate is captured")

# typing Lat/Lng and hitting Enable (without pressing Go first) adopts the fields
mv3 = MockLocationView("")
mv3.lat_edit.setText("48.8584")
mv3.lng_edit.setText("2.2945")
check(mv3._ensure_coords() and mv3._lat is not None and abs(mv3._lat - 48.8584) < 1e-6,
      "Enable adopts typed Lat/Lng without needing a map click or Go")

# enabling with nothing selected reverts the toggle instead of crashing
mv2 = MockLocationView("")
mv2.enable_btn.setChecked(True)
check(mv2.enable_btn.isChecked() is False, "Enable Mock reverts when no location/device is set")

# --- network intercept -----------------------------------------------------
from logcat_viewer.intercept import (
    reverse_args, set_proxy_args, clear_proxy_args, reverse_remove_args,
    get_proxy_args, restore_proxy_args, proxy_restore_cmd, proxy_watchdog_script,
    parse_sni, parse_head, _split_url, _parse_status, flow_to_curl, pretty_body,
    build_flow_export, have_mitmproxy, _json_to_flow, Flow, FlowTableModel,
    FlowFilterSpec, InterceptView, MITM_ADDON,
)

# adb command builders (exact argv, no device)
check(set_proxy_args("SER", 8099)[-3:] == ["global", "http_proxy", "127.0.0.1:8099"],
      "set_proxy_args points global http_proxy at the reverse tunnel")
check(clear_proxy_args("SER")[-1] == ":0", "clear_proxy_args disables the proxy (:0)")
check(get_proxy_args("SER")[-4:] == ["settings", "get", "global", "http_proxy"],
      "get_proxy_args reads the current global http_proxy")
# restore: a real prior proxy is written back verbatim…
check(restore_proxy_args("SER", "10.0.2.2:8888")[-4:]
      == ["put", "global", "http_proxy", "10.0.2.2:8888"],
      "restore_proxy_args re-applies the device's original proxy verbatim")
# …but 'no proxy' states delete the setting (true original), not leave a stale :0
check(all(restore_proxy_args("SER", v)[-3:] == ["delete", "global", "http_proxy"]
          for v in ("", "null", ":0", "127.0.0.1:8099")),
      "restore_proxy_args deletes the setting when the device had no real proxy")
# device-side watchdog: restores real proxy on SIGHUP, exits clean on stdin byte
check(proxy_restore_cmd("10.0.2.2:8888") == "settings put global http_proxy 10.0.2.2:8888"
      and proxy_restore_cmd("null") == "settings delete global http_proxy",
      "proxy_restore_cmd builds the device-shell restore command")
_wd = proxy_watchdog_script("10.0.2.2:8888")
check("trap 'settings put global http_proxy 10.0.2.2:8888' HUP INT TERM" in _wd
      and "read _" in _wd and "trap - HUP INT TERM" in _wd,
      "proxy_watchdog_script traps SIGHUP to restore but disarms on a stdin byte")
# injection-proofing: a value with shell metachars is rejected → delete, not exec
check(proxy_restore_cmd("x; rm -rf /") == "settings delete global http_proxy",
      "proxy_restore_cmd rejects unsafe proxy values (no shell injection)")
check(reverse_args("SER", 8099) == ["-s", "SER", "reverse", "tcp:8099", "tcp:8099"],
      "reverse_args tunnels the port both ways")
check(reverse_remove_args("SER", 8099) == ["-s", "SER", "reverse", "--remove", "tcp:8099"],
      "reverse_remove_args removes the tunnel")


def _client_hello(host: bytes) -> bytes:
    """Build a minimal TLS ClientHello carrying an SNI (spec-accurate)."""
    sni_entry = b"\x00" + len(host).to_bytes(2, "big") + host
    sni_list = len(sni_entry).to_bytes(2, "big") + sni_entry
    ext = b"\x00\x00" + len(sni_list).to_bytes(2, "big") + sni_list
    body = (b"\x03\x03" + b"\x00" * 32 + b"\x00" +
            b"\x00\x02\x13\x01" + b"\x01\x00" +
            len(ext).to_bytes(2, "big") + ext)
    hs = b"\x01" + len(body).to_bytes(3, "big") + body
    return b"\x16\x03\x01" + len(hs).to_bytes(2, "big") + hs


check(parse_sni(_client_hello(b"example.com")) == "example.com", "parse_sni reads the SNI host")
check(parse_sni(b"not a tls hello at all") is None,
      "parse_sni returns None on garbage (never raises)")

start, headers = parse_head(b"GET /x HTTP/1.1\r\nHost: h.com\r\nX-A: 1\r\n\r\nbody")
check(start == "GET /x HTTP/1.1", "parse_head reads the start line")
check(("Host", "h.com") in headers and ("X-A", "1") in headers, "parse_head reads headers")
check(_split_url("http://h.com:8080/a/b?q=1") == ("http", "h.com", 8080, "/a/b?q=1"),
      "_split_url splits an absolute-form target")
check(_parse_status("HTTP/1.1 404 Not Found") == 404, "_parse_status reads the code")

# FlowTableModel: append / filter / ring-buffer trim
fm = FlowTableModel(max_entries=50, trim_chunk=5)
fm.append_batch([Flow(method="GET", host="a.com", path="/1", status=200),
                 Flow(method="POST", host="b.com", path="/2", status=500)])
check(fm.rowCount() == 2, f"FlowTableModel shows 2 rows, got {fm.rowCount()}")
fm.set_filter(FlowFilterSpec(status_class=5).compile())
check(fm.rowCount() == 1 and fm.flow_at(0).status == 500, "status-class filter keeps 5xx only")
fm.set_filter(FlowFilterSpec(method="POST").compile())
check(fm.rowCount() == 1 and fm.flow_at(0).method == "POST", "method filter keeps POST only")
fm.set_filter(FlowFilterSpec(text_query="a.com").compile())
check(fm.rowCount() == 1 and fm.flow_at(0).host == "a.com", "host substring filter")
fm.set_filter(FlowFilterSpec().compile())
fm.append_batch([Flow(host=f"h{i}.com") for i in range(80)])
check(fm.total_count() <= 50, f"flow ring buffer trimmed to <=50, got {fm.total_count()}")

spec = FlowFilterSpec(text_query="(unclosed", text_regex=True).compile()
check(spec.has_error("text"), "invalid flow-filter regex records an error")
check(spec.match(Flow(host="anything", path="/")),
      "invalid regex disables the field (passes) — capture keeps flowing")

curl = flow_to_curl(Flow(method="POST", scheme="http", host="api.x", port=80, path="/v",
                         req_headers=[("Accept", "application/json")], req_body=b'{"a":1}'))
check(curl.startswith("curl -X POST 'http://api.x/v'"), "flow_to_curl builds the command")
check("-H 'Accept: application/json'" in curl and "--data-raw '{\"a\":1}'" in curl,
      "flow_to_curl includes headers + body")
check(pretty_body(b'{"b":2,"a":1}', [("Content-Type", "application/json")]).count("\n") >= 1,
      "pretty_body indents JSON")

_exp = build_flow_export(Flow(method="POST", scheme="https", host="api.x", path="/v", status=200,
                              req_headers=[("Accept", "application/json")],
                              resp_headers=[("Content-Type", "application/json")],
                              req_body=b'{"a":1}', resp_body=b'{"ok":true}'))
check("===== REQUEST =====" in _exp and "===== RESPONSE =====" in _exp
      and "Accept: application/json" in _exp and '"ok"' in _exp,
      "build_flow_export dumps URL + request/response headers + bodies")
import gzip as _gzip
_gz = _gzip.compress(b'{"hello":"world","n":5}')
check('"hello"' in pretty_body(_gz, [("Content-Encoding", "gzip"),
                                     ("Content-Type", "application/json")]),
      "pretty_body decompresses a gzip body (not shown as binary)")

fl = _json_to_flow({"method": "GET", "scheme": "https", "host": "s.com", "port": 443,
                    "path": "/p", "status": 200, "resp_body": "hello",
                    "req_headers": [["Host", "s.com"]], "resp_headers": []})
check(fl is not None and fl.host == "s.com" and fl.resp_body == b"hello",
      "_json_to_flow maps a Tier-2 addon line to a Flow")

check(isinstance(have_mitmproxy(), bool), "have_mitmproxy() returns a bool without raising")
check(os.path.isfile(MITM_ADDON), "bundled mitm addon present in assets")

# the Intercept tab exists and does NOT wire adb until Enabled
iv = win.intercept_view
check(isinstance(iv, InterceptView), "the Intercept tab is an InterceptView")
iv.set_serial(None)
iv.enable_btn.setChecked(True)   # no device -> reverts; no engine, no adb touched
check(iv.enable_btn.isChecked() is False and iv._engine is None,
      "Enable Intercept reverts with no device (no engine started)")
check(iv.cert_btn.isEnabled() == have_mitmproxy(),
      "Install CA Cert button enabled iff mitmproxy is present")
iv._install_cert()   # no device -> no worker started, just a flash
check(iv._cert_worker is None, "Install CA Cert with no device does not start a push worker")

# structured detail view renders a flow (pills + JSON body) without error
iv.detail.set_flow(Flow(method="POST", scheme="https", host="api.x", path="/v", status=200,
                        req_headers=[("Content-Type", "application/json")],
                        resp_headers=[("Content-Type", "application/json")],
                        req_body=b'{"a":1}', resp_body=b'{"ok":true,"n":42}',
                        duration_ms=12, resp_size=18))
check(not iv.detail._method_lbl.isHidden() and "42" in iv.detail._resp["body"].toPlainText(),
      "FlowDetail renders the method pill + response JSON body")

# per-section copy buttons put content on the clipboard
iv.detail.set_flow(Flow(method="POST", host="api.x", path="/v", status=200,
                        req_headers=[("Accept", "application/json")],
                        resp_headers=[("Content-Type", "application/json")],
                        req_body=b'{"a":1}', resp_body=b'{"ok":true}'))
iv.detail._copy("resp", "body")
check('"ok"' in QGuiApplication.clipboard().text(), "Copy Body copies the response JSON")
iv.detail._copy("req", "headers")
check("Accept: application/json" in QGuiApplication.clipboard().text(),
      "Copy Headers copies the request headers")

# copying shows a toast
iv.detail._copy("resp", "body")
check(not iv._toast_lbl.isHidden() and "Copied" in iv._toast_lbl.text(),
      "copy shows a 'Copied' toast")

# Decrypt HTTPS is a toggle, on by default when mitmproxy is present
check(iv.decrypt_btn.isCheckable() and iv.decrypt_btn.isChecked() == have_mitmproxy(),
      "Decrypt HTTPS is a toggle, checked by default when mitmproxy is available")

# JSON tree / text toggle
resp = iv.detail._resp
check(resp["view_btn"].isEnabled(), "Tree toggle is enabled for a JSON body")
resp["view_btn"].setChecked(True)
check(resp["stack"].currentIndex() == 1 and resp["tree"].topLevelItemCount() >= 1,
      "toggling Tree shows the tree view populated from JSON")
resp["view_btn"].setChecked(False)
check(resp["stack"].currentIndex() == 0, "toggling back shows the text view")
iv.detail.set_flow(Flow(method="GET", host="h", path="/x", status=200,
                        resp_headers=[("Content-Type", "text/html")], resp_body=b"<html>"))
check(not resp["view_btn"].isEnabled(), "Tree toggle disabled for a non-JSON body")

# per-section find with a match count
iv.detail.set_flow(Flow(method="POST", host="api.x", path="/v", status=200,
                        resp_headers=[("Content-Type", "application/json")],
                        resp_body=b'{"needle":"haystack","n":1}'))
resp["search_btn"].setChecked(True)
check(not resp["search_bar"].isHidden(), "per-section find bar appears when search is toggled on")
resp["search_edit"].setText("needle")
iv.detail._find(resp, False)
check("match" in resp["search_count"].text(), "per-section find reports a match count")
resp["search_btn"].setChecked(False)
check(resp["search_bar"].isHidden(), "per-section find bar hides when closed")

# collapse / expand a section
resp["col_btn"].setChecked(True)
check(not resp["inner"].isVisibleTo(iv.detail), "collapse hides a section's content")
resp["col_btn"].setChecked(False)
check(resp["inner"].isVisibleTo(iv.detail), "expand shows a section's content")

# per-section maximize: RESPONSE maximized hides the REQUEST card, and back
resp["max_btn"].setChecked(True)
check(not iv.detail._req["card"].isVisibleTo(iv.detail),
      "maximizing RESPONSE hides the REQUEST section")
resp["max_btn"].setChecked(False)
check(iv.detail._req["card"].isVisibleTo(iv.detail),
      "un-maximizing restores the REQUEST section")

iv.detail.clear()
check(iv.detail._method_lbl.isHidden(), "FlowDetail.clear() hides the pills")

# Tier-1 proxy end-to-end over loopback (no device): proxy a real HTTP GET
import asyncio
import http.server
import threading
from logcat_viewer.intercept import serve


class _Upstream(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"hello-from-upstream"
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


_up = http.server.HTTPServer(("127.0.0.1", 0), _Upstream)
_up_port = _up.server_address[1]
threading.Thread(target=_up.serve_forever, daemon=True).start()


async def _proxy_roundtrip():
    captured = []
    stop = asyncio.Event()
    started = asyncio.Event()
    bound = []

    def on_started(p):
        bound.append(p)
        started.set()

    task = asyncio.ensure_future(serve(0, captured.append, stop, on_started=on_started))
    await asyncio.wait_for(started.wait(), timeout=5)
    reader, writer = await asyncio.open_connection("127.0.0.1", bound[0])
    writer.write((f"GET http://127.0.0.1:{_up_port}/ HTTP/1.1\r\n"
                  f"Host: 127.0.0.1:{_up_port}\r\n\r\n").encode())
    await writer.drain()
    data = await asyncio.wait_for(reader.read(-1), timeout=5)
    writer.close()
    await asyncio.sleep(0.1)
    stop.set()
    await asyncio.wait_for(task, timeout=5)
    return data, captured


try:
    _data, _caught = asyncio.new_event_loop().run_until_complete(_proxy_roundtrip())
    check(b"hello-from-upstream" in _data, "Tier-1 proxy relayed the upstream response to the client")
    check(len(_caught) == 1 and _caught[0].status == 200 and _caught[0].resp_body == b"hello-from-upstream",
          f"Tier-1 proxy captured the flow (status + body), got {len(_caught)} flow(s)")
except Exception as exc:
    check(False, f"Tier-1 loopback proxy roundtrip raised: {exc}")
finally:
    _up.shutdown()

# --- database inspector ----------------------------------------------------
from logcat_viewer.dbinspect import (
    list_dbs_args, cat_db_args, db_candidates, classify_listing, is_sqlite_file,
    open_readonly, list_tables, read_table, run_query, cell_text,
    clipboard_value, is_blob, sql_literal, build_update_sql, apply_local_update,
    edit_args, sqlite3_probe_args, DbExportWorker, SqlResultModel, DatabaseView, CellDialog,
)

# pure adb command builders (exact argv, no device)
check(list_dbs_args("SER", "com.x") == ["-s", "SER", "shell", "run-as", "com.x", "ls", "-1", "databases/"],
      "list_dbs_args uses run-as ls on databases/")
check(cat_db_args("SER", "com.x", "app.db")
      == ["-s", "SER", "exec-out", "run-as", "com.x", "cat", "databases/app.db"],
      "cat_db_args streams a db via exec-out run-as cat")
check("su" in list_dbs_args("SER", "com.x", su=True)
      and "/data/data/com.x/databases" in list_dbs_args("SER", "com.x", su=True),
      "list_dbs_args has a rooted su fallback with an absolute path")

# candidate filtering: drop -wal/-shm/-journal/-lock sidecars, keep extension-less DBs
cands = db_candidates(["penguinDB_1", "penguinDB_1-wal", "penguinDB_1-shm",
                       "chucker.db", "chucker.db-journal", "x.db-lock"])
check(cands == ["chucker.db", "penguinDB_1"], f"db_candidates drops sidecars/locks, got {cands}")

# listing classification: rc0 / missing-dir / not-debuggable
dbs, err = classify_listing(0, "a.db\nb\n", "")
check(dbs == ["a.db", "b"] and err is None, "classify_listing rc0 parses the listing")
dbs, err = classify_listing(1, "", "ls: databases/: No such file or directory")
check(dbs == [] and err is None, "classify_listing treats a missing databases/ dir as empty (accessible)")
dbs, err = classify_listing(1, "", "run-as: package not debuggable: com.x")
check(dbs is None and err == "blocked", "classify_listing flags a non-debuggable app as blocked")

# stdlib-sqlite readers against a real local db (NULL / blob / bad-utf8 tolerated)
import sqlite3 as _sqlite3
import tempfile as _tempfile
_dbf = os.path.join(_tempfile.mkdtemp(prefix="smoke-db-"), "t.db")
_c = _sqlite3.connect(_dbf)
_c.execute("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, blob BLOB)")
_c.executemany("INSERT INTO items (name, blob) VALUES (?, ?)",
               [("alpha", None), ("beta", b"\xff\xfe"), (None, b"hello")])
_c.execute("CREATE VIEW v_items AS SELECT id, name FROM items")
_c.commit(); _c.close()

check(is_sqlite_file(_dbf), "is_sqlite_file recognizes a real SQLite file by its header")
_con = open_readonly(_dbf)
_tabs = list_tables(_con)
_names = {t[0]: t for t in _tabs}
check("items" in _names and _names["items"][1] == "table" and _names["items"][2] == 3,
      f"list_tables returns the table with its row count, got {_tabs}")
check("v_items" in _names and _names["v_items"][1] == "view",
      "list_tables includes views")
_cols, _rows, _total, _rowids = read_table(_con, "items", 2, 0)
check(_cols == ["id", "name", "blob"] and len(_rows) == 2 and _total == 3,
      f"read_table pages rows and reports the total, got cols={_cols} n={len(_rows)} total={_total}")
check(_rowids is not None and len(_rowids) == 2,
      f"read_table returns per-row rowids for editing, got {_rowids}")
_c2, _r2, _trunc = run_query(_con, "SELECT COUNT(*) AS n FROM items")
check(_c2 == ["n"] and _r2[0][0] == 3 and not _trunc, "run_query returns columns + rows")
# query_only: a write must be rejected (the local snapshot is never mutated)
_wrote = False
try:
    _con.execute("DELETE FROM items")
    _wrote = True
except _sqlite3.OperationalError:
    pass
check(not _wrote, "open_readonly is query_only — writes are rejected")
_con.close()

check(cell_text(None) == "NULL", "cell_text shows NULL")
check(cell_text(b"\xff\xfe").startswith("‹") and "blob" in cell_text(b"\xff\xfe"),
      "cell_text summarizes a non-UTF-8 blob")
check(cell_text(b"hi") == "hi" and cell_text(42) == "42", "cell_text decodes UTF-8 bytes and ints")

# copy / blob helpers
check(clipboard_value(None) == "" and clipboard_value(b"hi") == "hi" and clipboard_value(5) == "5",
      "clipboard_value: NULL→'' , UTF-8 bytes→text, other→str")
check(clipboard_value(b"\xff\x00") == "ff00", "clipboard_value hex-encodes a binary blob")
check(is_blob(b"\xff\xfe") and not is_blob(b"hi") and not is_blob("x") and not is_blob(None),
      "is_blob: only non-UTF-8 bytes are blobs")

# --- edit: SQL builders (injection-safe) + local-snapshot apply -------------
check(sql_literal("O'Brien") == "'O''Brien'", "sql_literal doubles single quotes (injection-safe)")
check(sql_literal(5) == "5" and sql_literal(None) == "NULL" and sql_literal("x", set_null=True) == "NULL",
      "sql_literal: numbers pass through, None/set_null → NULL")
check(build_update_sql("my tbl", 'a"b', 7, "v")
      == 'UPDATE "my tbl" SET "a""b"=\'v\' WHERE _rowid_=7;',
      "build_update_sql quotes identifiers, targets _rowid_")
check(edit_args("SER", "com.x", "app.db")
      == ["-s", "SER", "shell", "run-as", "com.x", "sqlite3", "databases/app.db"],
      "edit_args runs on-device sqlite3 (SQL comes on stdin)")
check(sqlite3_probe_args("SER") == ["-s", "SER", "shell", "command", "-v", "sqlite3"],
      "sqlite3_probe_args checks for the on-device binary")

# apply_local_update mutates the local snapshot exactly like the device write will
_efile = os.path.join(_tempfile.mkdtemp(prefix="smoke-edit-"), "e.db")
_ec = _sqlite3.connect(_efile)
_ec.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)")
_ec.execute("INSERT INTO t (name) VALUES ('old')")
_rid = _ec.execute("SELECT _rowid_ FROM t").fetchone()[0]
_ec.commit(); _ec.close()
apply_local_update(_efile, "t", "name", _rid, "new")
_ec = _sqlite3.connect(_efile)
check(_ec.execute("SELECT name FROM t WHERE _rowid_=?", (_rid,)).fetchone()[0] == "new",
      "apply_local_update writes the new value into the local snapshot")
apply_local_update(_efile, "t", "name", _rid, None, set_null=True)
check(_ec.execute("SELECT name FROM t WHERE _rowid_=?", (_rid,)).fetchone()[0] is None,
      "apply_local_update can set a cell to NULL")
_ec.close()

# DbExportWorker: backup a snapshot to a self-contained .db (run() synchronously)
_expfile = os.path.join(_tempfile.mkdtemp(prefix="smoke-exp-"), "out.db")
_exw = DbExportWorker(_dbf, _expfile)
_exw.run()
check(is_sqlite_file(_expfile), "DbExportWorker writes a valid SQLite .db file")
_expcon = open_readonly(_expfile)
check({t[0] for t in list_tables(_expcon)} >= {"items"} and
      _expcon.execute("SELECT COUNT(*) FROM items").fetchone()[0] == 3,
      "exported .db is a full, self-contained copy (same tables + rows)")
_expcon.close()

# SqlResultModel renders a page (row-number gutter is offset-aware)
_m = SqlResultModel()
_m.set_result(["id", "name"], [(1, "a"), (2, None)], offset=10)
check(_m.rowCount() == 2 and _m.columnCount() == 2, "SqlResultModel row/column counts")
from PyQt6.QtCore import Qt as _Qt
check(_m.data(_m.index(1, 1), _Qt.ItemDataRole.DisplayRole) == "NULL",
      "SqlResultModel shows NULL for a null cell")
check(_m.headerData(0, _Qt.Orientation.Vertical, _Qt.ItemDataRole.DisplayRole) == "11",
      "SqlResultModel row-number gutter is 1-based + offset")
_m.set_cell(0, 1, "edited")
check(_m.value_at(0, 1) == "edited"
      and _m.data(_m.index(0, 1), _Qt.ItemDataRole.DisplayRole) == "edited",
      "SqlResultModel.set_cell updates a cell in place (edit reflected instantly)")

# the Databases tab exists and touches no adb until an app is selected
dbv = win.db_view
check(isinstance(dbv, DatabaseView), "the Databases tab is a DatabaseView")
dbv.set_serial("DEVICE1")
dbv.set_package(None)
check(dbv._list_worker is None and dbv.tree.topLevelItemCount() == 0,
      "no app selected -> no listing worker, empty schema tree")
# empty-state placeholders (isHidden() = the explicit show/hide flag, independent
# of whether the tab is the current one in headless mode)
dbv.set_serial(None); dbv._refresh_tree_empty()
check(not dbv.tree_empty.isHidden() and "No app selected" in dbv.tree_empty.text(),
      "DB schema tree shows a placeholder when no app is selected")
dbv._refresh_results_empty()
check(not dbv.results_empty.isHidden() and "No table selected" in dbv.results_empty.text(),
      "DB results show a placeholder when nothing is loaded")
dbv._results_empty = ("📭", "Empty table", "“t” has no rows.")
dbv._refresh_results_empty()
check("Empty table" in dbv.results_empty.text(),
      "DB results placeholder reflects an empty table")
dbv.model.set_result(["id"], [(1,)], offset=0)
dbv._refresh_results_empty()
check(dbv.results_empty.isHidden(), "DB results placeholder hides once rows arrive")
dbv.model.clear()
dbv.set_serial("DEVICE1")
dbv.set_package("com.example.app")
check("com.example.app" in dbv.app_label.text(), "DB tab reflects the selected app in its header")

# cell editability rules (no device write happens here — pure logic)
dbv.model.set_result(["id", "name"], [(1, "a")], offset=0)
dbv._cur_table = "t"; dbv._rowids = [1]; dbv._can_edit_device = True
ed, _r = dbv._cell_editable(0, 1)
check(ed, "a table cell with a rowid on an sqlite3-capable device is editable")
dbv._can_edit_device = False
ed, reason = dbv._cell_editable(0, 1)
check(not ed and "sqlite3" in reason, "no on-device sqlite3 → not editable, with a clear reason")
dbv._can_edit_device = True; dbv._cur_table = None
ed, reason = dbv._cell_editable(0, 1)
check(not ed and "custom query" in reason, "a free-query result is view-only (not editable)")

# CellDialog builds for both view-only and editable cells; Copy works
_saved = {}
_dlg = CellDialog(column="name", value="hello", editable=True, reason="",
                  on_save=lambda t, n: _saved.update(text=t, null=n))
_dlg.editor.setPlainText("changed"); _dlg._save()
check(_saved.get("text") == "changed" and _saved.get("null") is False,
      "CellDialog editable save reports the new text")
_view_only = CellDialog(column="blob", value=b"\xff", editable=False, reason="binary blob")
check(_view_only.editor.isReadOnly(), "CellDialog is read-only for a non-editable cell")

# schema-tree icons
from PyQt6.QtGui import QIcon as _QIcon
check(all(isinstance(ic, _QIcon) and not ic.isNull() for ic in
          (dbv._icon_db_on, dbv._icon_db_off, dbv._icon_table, dbv._icon_view)),
      "DB / table / view tree icons are drawn (non-null)")

# search filter + connect/disconnect over a small fake schema tree
from PyQt6.QtWidgets import QTreeWidgetItem as _TWI
dbv.tree.clear(); dbv._db_items.clear()
_dbi = _TWI(["users.db"]); _dbi.setData(0, _Qt.ItemDataRole.UserRole, ("db", "users.db"))
dbv.tree.addTopLevelItem(_dbi); dbv._db_items["users.db"] = _dbi
_t1 = _TWI(["accounts"]); _t1.setData(0, _Qt.ItemDataRole.UserRole, ("table", "users.db", "accounts", 3))
_t2 = _TWI(["sessions"]); _t2.setData(0, _Qt.ItemDataRole.UserRole, ("table", "users.db", "sessions", 0))
_dbi.addChild(_t1); _dbi.addChild(_t2)
_db2 = _TWI(["cache.db"]); _db2.setData(0, _Qt.ItemDataRole.UserRole, ("db", "cache.db"))
dbv.tree.addTopLevelItem(_db2); dbv._db_items["cache.db"] = _db2

dbv._filter_tree("account")
check(not _dbi.isHidden() and not _t1.isHidden() and _t2.isHidden() and _db2.isHidden(),
      "search by table name keeps its DB, hides the non-matching table + other DBs")
dbv._filter_tree("cache")
check(_db2.isHidden() is False and _dbi.isHidden() is True, "search by database name")
dbv._filter_tree("")
check(not _dbi.isHidden() and not _t1.isHidden() and not _db2.isHidden(),
      "clearing the search shows everything again")

_snap = os.path.join(_tempfile.mkdtemp(prefix="smoke-disc-"), "users.db")
_dc = _sqlite3.connect(_snap); _dc.execute("CREATE TABLE t(x)"); _dc.commit(); _dc.close()
dbv._db_paths["users.db"] = _snap
dbv._disconnect_db("users.db", silent=True)
check("users.db" not in dbv._db_paths and not os.path.exists(_snap) and _dbi.childCount() == 0,
      "disconnect drops the snapshot file + tables and forgets the connection")

# loading indicators toggle with worker activity
check(dbv.tree_busy.isHidden() and dbv.results_busy.isHidden(), "loaders hidden when idle")
dbv._list_worker = object()                      # pretend a listing is in flight
dbv._update_tree_busy()
check(not dbv.tree_busy.isHidden(), "schema loader shows while listing / connecting")
dbv._list_worker = None
dbv._update_tree_busy()
check(dbv.tree_busy.isHidden(), "schema loader hides when no list/open worker runs")
dbv.results_busy.show()
check(not dbv.results_busy.isHidden(), "results loader can show while a query runs")
dbv.results_busy.hide()

dbv.shutdown()
check(not os.path.isdir(dbv._tmp), "DatabaseView.shutdown() removes the pulled-snapshot temp dir")


# --- file explorer ----------------------------------------------------------
from logcat_viewer.files import (
    parse_ls_line, classify_listing, ls_args, cat_args, mkdir_args, rename_args,
    delete_args, access_for, is_app_private, join_path, parent_path, human_size,
    Entry, FilesView, PLACES,
)

# ls -lA parsing (toybox long format)
_d = parse_ls_line("drwxrwx--x 4 u0_a154 u0_a154 4096 2024-05-01 12:00 files")
check(_d.kind == "dir" and _d.name == "files", "parse_ls_line: directory")
_f = parse_ls_line("-rw------- 1 u0_a154 u0_a154 8192 2024-05-01 12:00 shared_prefs.xml")
check(_f.kind == "file" and _f.size == 8192 and _f.name == "shared_prefs.xml",
      "parse_ls_line: file with size")
_sp = parse_ls_line("-rw-rw---- 1 root root 128 2024-01-02 09:30 my report.txt")
check(_sp.name == "my report.txt" and _sp.size == 128, "parse_ls_line: filename with spaces")
_ln = parse_ls_line("lrwxrwxrwx 1 root root 21 2009-01-01 00:00 sdcard -> /storage/self/primary")
check(_ln.kind == "link" and _ln.name == "sdcard" and _ln.link_target == "/storage/self/primary",
      "parse_ls_line: symlink splits name -> target")
check(parse_ls_line("total 40") is None and parse_ls_line("") is None,
      "parse_ls_line: drops 'total' header and blank lines")

# classify_listing sentinels
_ents, _err = classify_listing(0, "drwx------ 2 u0 u0 4096 2024-01-01 00:00 b\n"
                                  "-rw------- 1 u0 u0 5 2024-01-01 00:00 a\n", "")
check(_err is None and [e.name for e in _ents] == ["b", "a"],
      "classify_listing: success sorts directories before files")
check(classify_listing(1, "", "run-as: Package 'x' is not debuggable")[1] == "blocked",
      "classify_listing: not-debuggable → 'blocked' (triggers su fallback)")
check(classify_listing(1, "", "ls: /x: No such file or directory")[1] == "not found",
      "classify_listing: missing dir → 'not found'")
check(classify_listing(1, "", "ls: /x: Permission denied")[1] == "denied",
      "classify_listing: permission denied → 'denied'")

# command builders (tokenized, no shell metacharacters)
check(ls_args("S", "/sdcard") == ["-s", "S", "shell", "ls", "-lHA", "/sdcard"],
      "ls_args: plain shell")
check(ls_args("S", "/data/data/p/db", run_as="p")
      == ["-s", "S", "shell", "run-as", "p", "ls", "-lHA", "/data/data/p/db"], "ls_args: run-as")
check(ls_args("S", "/x", su=True) == ["-s", "S", "shell", "su", "-c", "ls", "-lHA", "/x"],
      "ls_args: su")
check(cat_args("S", "/x", run_as="p")
      == ["-s", "S", "exec-out", "run-as", "p", "cat", "/x"], "cat_args: run-as via exec-out")
check(mkdir_args("S", "/x") == ["-s", "S", "shell", "mkdir", "-p", "/x"], "mkdir_args")
check(rename_args("S", "/a", "/b") == ["-s", "S", "shell", "mv", "/a", "/b"], "rename_args")
check(delete_args("S", ["/a", "/b"]) == ["-s", "S", "shell", "rm", "-rf", "/a", "/b"], "delete_args")

# access decision + path helpers
check(access_for("/sdcard", "com.x") == (None, False), "access_for: public path → plain shell")
check(access_for("/data/data/com.x/files", "com.x") == ("com.x", False),
      "access_for: app-private path → run-as")
check(access_for("/data/data/com.x/files", "com.x", root_mode=True) == (None, True),
      "access_for: Root (su) toggle forces su")
check(is_app_private("/data/data/com.x", "com.x") and not is_app_private("/data/data/com.y", "com.x"),
      "is_app_private matches only the selected app's dir")
check(join_path("/", "a") == "/a" and join_path("/sdcard", "a") == "/sdcard/a", "join_path")
check(parent_path("/sdcard/Download") == "/sdcard" and parent_path("/") == "/"
      and parent_path("/sdcard") == "/", "parent_path")
check(human_size(None) == "" and human_size(0) == "0 B" and human_size(2048) == "2.0 KB",
      "human_size formats bytes")

# parse captures the modified date; Entry derives extension + Windows-style type
check(_f.modified == "2024-05-01 12:00", "parse_ls_line captures the modified date")
check(Entry("x.PNG", "file", 1, "-rw-").ext == "png"
      and Entry("x.PNG", "file", 1, "-rw-").type_label() == "PNG file"
      and Entry("d", "dir", None, "d").type_label() == "File folder",
      "Entry.ext / type_label produce Windows-Explorer type labels")

# the Files tab exists, touches no adb at rest, and lists its navigation pane
fv = win.files_view
check(isinstance(fv, FilesView), "the Files tab is a FilesView")
check(fv.quick_list.count() + fv.loc_list.count() == len(PLACES)
      and fv.path_edit.text() == "/sdcard",
      "Files tab lists Quick access + Locations and defaults to /sdcard")
fv.set_serial("DEVICE1")
check(not fv._list_workers, "no list worker while the hidden tab is not shown")
fv.set_package("com.example.app")
check(fv._app_place.data(_Qt.ItemDataRole.UserRole)[0] == "/data/data/com.example.app",
      "selecting an app repoints the 'App data' bookmark at its private dir")

# details table (Name / Date modified / Type / Size) + icon grid both populate
fv._entries = [Entry("dir1", "dir", None, "drwx", None, "2024-01-01 09:00"),
               Entry("a.txt", "file", 12, "-rw-", None, "2024-01-02 10:30")]
fv._sort_entries()
check([e.name for e in fv._entries] == ["dir1", "a.txt"],
      "_sort_entries keeps folders first")
fv._populate()
check(fv.table.rowCount() == 2 and fv.table.item(0, 0).text() == "dir1"
      and fv.table.item(0, 2).text() == "File folder"
      and fv.table.item(1, 3).text() == "12 B" and fv.grid.count() == 2,
      "FilesView populates both the details table and the icon grid")

# client-side search hides non-matching rows in both views
fv._apply_search("dir")
check(not fv.table.isRowHidden(0) and fv.table.isRowHidden(1)
      and fv.grid.item(1).isHidden(), "search filters the listing by name")
fv._apply_search("")
check(not fv.table.isRowHidden(1), "clearing the search shows everything again")

# view-mode toggle switches the stacked details/icons widgets
fv._set_view_mode("icons")
check(fv.stack.currentIndex() == 1, "View → Large icons shows the icon grid")
fv._set_view_mode("details")
check(fv.stack.currentIndex() == 0, "View → Details shows the table")

fv.shutdown()
check(not os.path.isdir(fv._tmp), "FilesView.shutdown() removes the staging temp dir")

# ---------------------------------------------------------------------------
# App Management tab
from logcat_viewer.appmgr import (
    AppManagerView, AppInfo, parse_pkg_list_line, build_app_list,
    parse_permissions, parse_components, parse_appops, parse_general,
    parse_app_detail, list_packages_args, dumpsys_args, launch_args,
    clear_args, clear_cache_args, runas_clear_cache_args, su_clear_cache_args,
    disable_args, uninstall_args, grant_args, component_args,
    appops_set_args, app_icon, _human_bytes,
    parse_zip_entries, pick_launcher_icon, unzip_list_args, unzip_extract_args,
)

# pm list packages -f -i -U --show-versioncode → AppInfo fields
_line = ("package:/data/app/~~AbC12==/com.example.app-Xyz==/base.apk="
         "com.example.app versionCode:42 uid:10234 installer:com.android.vending")
_d = parse_pkg_list_line(_line)
check(_d and _d["package"] == "com.example.app"
      and _d["apk_path"].endswith("base.apk") and _d["version_code"] == "42"
      and _d["uid"] == "10234" and _d["installer"] == "com.android.vending",
      "parse_pkg_list_line splits path=pkg on the last '=' and reads the extras")
check(parse_pkg_list_line("total 0") is None
      and parse_pkg_list_line("package:com.foo")["package"] == "com.foo",
      "parse_pkg_list_line ignores non-package lines and handles bare names")

_apps = build_app_list(
    _line + "\npackage:com.android.systemui versionCode:1 uid:10001 installer:null",
    system={"com.android.systemui"}, disabled={"com.example.app"})
check(len(_apps) == 2 and _apps[0].package == "com.android.systemui"
      and _apps[0].system and _apps[0].installer == "" and not _apps[1].enabled
      and _apps[1].installer == "com.android.vending",
      "build_app_list tags system/disabled and sorts, null installer → blank")

# command builders (tokenized, target the serial)
check(list_packages_args("S1") == ["-s", "S1", "shell", "pm", "list", "packages",
                                   "-f", "-i", "--show-versioncode", "-U"],
      "list_packages_args requests file/installer/versioncode/uid")
check(dumpsys_args("S1", "com.foo")[-3:] == ["dumpsys", "package", "com.foo"]
      and launch_args("S1", "com.foo")[3:6] == ["monkey", "-p", "com.foo"]
      and clear_args("S1", "com.foo")[-3:] == ["pm", "clear", "com.foo"]
      and disable_args("S1", "com.foo")[-5:] == ["pm", "disable-user", "--user", "0", "com.foo"],
      "dumpsys/launch/clear/disable builders emit the right adb tokens")
check(clear_cache_args("S1", "com.foo")[-4:] == ["pm", "clear", "--cache-only", "com.foo"]
      and runas_clear_cache_args("S1", "com.foo")[3:]
          == ["run-as", "com.foo", "rm", "-rf", "cache", "code_cache"]
      and su_clear_cache_args("S1", "com.foo")[3:6] == ["su", "-c", "rm"]
      and su_clear_cache_args("S1", "com.foo")[-1] == "/data/data/com.foo/code_cache",
      "clear-cache builders emit pm --cache-only + run-as/su rm fallbacks")
check(uninstall_args("S1", "com.foo") == ["-s", "S1", "uninstall", "com.foo"]
      and uninstall_args("S1", "com.foo", keep_data=True)[3] == "-k"
      and grant_args("S1", "com.foo", "P")[-4:] == ["pm", "grant", "com.foo", "P"]
      and component_args("S1", "com.foo", ".Act", "disable")[-2:] == ["disable", "com.foo/.Act"]
      and component_args("S1", "com.foo", ".Act", "default")[-2:] == ["default-state", "com.foo/.Act"]
      and appops_set_args("S1", "com.foo", "CAMERA", "deny")[-5:]
          == ["appops", "set", "com.foo", "CAMERA", "deny"],
      "uninstall/grant/component/appops builders emit the right adb tokens")

_DUMP = """
Activity Resolver Table:
  Non-Data Actions:
      android.intent.action.MAIN:
        5f3a com.example.app/.MainActivity filter 8a2b
        1122 com.example.app/com.example.app.SecondActivity filter 3344
Receiver Resolver Table:
  Non-Data Actions:
      android.intent.action.BOOT_COMPLETED:
        aa11 com.example.app/.BootReceiver filter bb22
Service Resolver Table:
  Non-Data Actions:
      android.intent.action.SYNC:
        cc33 com.example.app/.SyncService filter dd44
Provider Resolver Table:
  Non-Data Actions:
        ee55 com.example.app/.MyProvider (authorities: com.example.app.provider)
Key Set Manager:
  [com.example.app]
Packages:
  Package [com.example.app] (a1b2c3):
    userId=10234
    codePath=/data/app/~~AbC12==/com.example.app-Xyz==
    primaryCpuAbi=arm64-v8a
    versionCode=42 minSdk=24 targetSdk=34
    versionName=1.2.3
    flags=[ DEBUGGABLE HAS_CODE ALLOW_BACKUP ]
    dataDir=/data/user/0/com.example.app
    firstInstallTime=2024-01-01 09:00:00
    lastUpdateTime=2024-02-01 10:30:00
    signatures=PackageSignatures{5a6b version:3}
    installerPackageName=com.android.vending
    requested permissions:
      android.permission.INTERNET
      android.permission.CAMERA
      android.permission.ACCESS_FINE_LOCATION
    install permissions:
      android.permission.INTERNET: granted=true
    disabledComponents:
      com.example.app.SecondActivity
    User 0: ceDataInode=1 installed=true hidden=false
      runtime permissions:
        android.permission.CAMERA: granted=false, flags=[ USER_SET ]
        android.permission.ACCESS_FINE_LOCATION: granted=true, flags=[ USER_SET ]
"""
_g = parse_general(_DUMP)
check(_g["versionName"] == "1.2.3" and _g["versionCode"] == "42"
      and _g["minSdk"] == "24" and _g["targetSdk"] == "34"
      and _g["dataDir"] == "/data/user/0/com.example.app"
      and _g["firstInstallTime"] == "2024-01-01 09:00:00"
      and "DEBUGGABLE" in _g["flags"],
      "parse_general reads version/sdk/dataDir/times/flags from dumpsys")

_pl = parse_permissions(_DUMP)
_perms = {p.name: p.granted for p in _pl}
check(_perms.get("android.permission.INTERNET") is True
      and _perms.get("android.permission.CAMERA") is False
      and _perms.get("android.permission.ACCESS_FINE_LOCATION") is True,
      "parse_permissions merges install+runtime grant state (3 perms)")
_rt = {p.name for p in _pl if p.runtime}
check("android.permission.CAMERA" in _rt
      and "android.permission.ACCESS_FINE_LOCATION" in _rt
      and "android.permission.INTERNET" not in _rt,
      "parse_permissions flags runtime perms (changeable) vs install perms")

_c = parse_components(_DUMP, "com.example.app")
_acts = {x.name: x.enabled for x in _c["activities"]}
check(len(_c["activities"]) == 2 and _acts.get(".MainActivity") is True
      and _acts.get("com.example.app.SecondActivity") is False
      and _c["receivers"][0].name == ".BootReceiver"
      and _c["services"][0].name == ".SyncService"
      and _c["providers"][0].name == ".MyProvider",
      "parse_components pulls per-type components + disabledComponents state")

_ops = {o.op: o.mode for o in parse_appops(
    "com.example.app::\n  COARSE_LOCATION: allow; time=+1h ago\n"
    "  CAMERA: deny\n  RECORD_AUDIO: ignore\n  LEGACY_STORAGE: default")}
check(_ops == {"COARSE_LOCATION": "allow", "CAMERA": "deny",
               "RECORD_AUDIO": "ignore", "LEGACY_STORAGE": "default"},
      "parse_appops reads OP: mode lines and strips trailing detail")

_detail = parse_app_detail("com.example.app", _DUMP, "CAMERA: deny")
check(_detail.package == "com.example.app" and len(_detail.permissions) == 3
      and len(_detail.activities) == 2 and len(_detail.appops) == 1
      and _detail.signatures, "parse_app_detail assembles a full AppDetail")

check(_human_bytes(0) == "0 B" and _human_bytes(1536).endswith("KB")
      and _human_bytes(5 * 1024 * 1024).endswith("MB"),
      "_human_bytes formats sizes")
check(not app_icon("com.example.app").isNull(), "app_icon draws a letter tile")

# launcher-icon extraction from an APK entry listing (APK == ZIP, via unzip)
_ZIPL = """Archive:  /data/app/com.example.app/base.apk
  Length      Date    Time    Name
---------  ---------- -----   ----
     1024  2024-01-01 00:00   AndroidManifest.xml
     8000  2024-01-01 00:00   res/mipmap-mdpi/ic_launcher.png
    40000  2024-01-01 00:00   res/mipmap-xxxhdpi/ic_launcher.png
    39000  2024-01-01 00:00   res/mipmap-xxxhdpi/ic_launcher_round.png
      900  2024-01-01 00:00   res/mipmap-anydpi-v26/ic_launcher.xml
    12000  2024-01-01 00:00   res/drawable-xhdpi/splash.png
---------                     -------
    99999                     6 files"""
_ents = parse_zip_entries(_ZIPL)
check("res/mipmap-xxxhdpi/ic_launcher.png" in _ents
      and "res/mipmap-mdpi/ic_launcher.png" in _ents,
      "parse_zip_entries reads the Name column (last token) of unzip -l")
check(pick_launcher_icon(_ents) == "res/mipmap-xxxhdpi/ic_launcher.png",
      "pick_launcher_icon prefers the densest raster ic_launcher (not round/xml/drawable)")
check(pick_launcher_icon(["res/mipmap-anydpi-v26/ic_launcher.xml",
                          "res/drawable/bg.png"]) is None,
      "pick_launcher_icon returns None when only adaptive-XML / non-launcher exist")
check(unzip_list_args("S1", "/a/base.apk")[-3:] == ["unzip", "-l", "/a/base.apk"]
      and unzip_extract_args("S1", "/a/base.apk", "res/x.png")[2] == "exec-out"
      and unzip_extract_args("S1", "/a/base.apk", "res/x.png")[-4:]
          == ["unzip", "-p", "/a/base.apk", "res/x.png"],
      "unzip list/extract builders emit shell -l and exec-out -p")

# the Apps tab exists, touches no adb at rest, populates list + detail offscreen
av = win.appmgr_view
check(isinstance(av, AppManagerView), "the Apps tab is an AppManagerView")
check(av.btn_cache.text() == "Clear cache" and len(av._act_buttons) == 8,
      "the Apps tab has a Clear cache action button")
check(av.btn_grant_all.text() == "Grant all" and av.btn_revoke_all.text() == "Revoke all"
      and not av.btn_grant_all.isEnabled(),
      "the Permissions tab has Grant all / Revoke all buttons (disabled at rest)")
check(av._list_worker is None and av._detail_worker is None,
      "no App-Manager worker runs while the hidden tab is not shown")
av._apps = [AppInfo("com.example.app", system=False, enabled=False, uid="10234"),
            AppInfo("com.android.systemui", system=True)]
av._apply_filter()
check(av.app_list.count() == 2, "_apply_filter lists all apps")
av.filter_combo.setCurrentText("System")
check(av.app_list.count() == 1
      and av.app_list.item(0).text() == "com.android.systemui",
      "filter → System shows only system apps")
av.filter_combo.setCurrentText("All")
av._current = av._apps[0]
av._detail_seq = 7
av._on_detail_done(True, _detail, "", 7)
check(av.info_table.rowCount() > 5 and av.perm_table.rowCount() == 3
      and av.comp_tree.topLevelItemCount() == 4 and av.ops_table.rowCount() == 1,
      "AppManagerView populates Info/Permissions/Components/App Ops from a detail")
check(av.btn_grant_all.isEnabled() and av.btn_revoke_all.isEnabled(),
      "Grant all / Revoke all enable once an app with runtime perms is shown")
av._on_detail_done(True, parse_app_detail("x", "", ""), "", 3)   # stale seq 3 ≠ 7
check(av.perm_table.rowCount() == 3, "a stale detail (old seq) is ignored")

# a fetched real icon replaces the letter tile on the row + header
from PyQt6.QtGui import QImage as _QImage
_img = _QImage(24, 24, _QImage.Format.Format_RGB32)
_img.fill(0xFF3355AA)
av._on_icon("com.example.app", _img)
check(av._icon_cache.get("com.example.app") is not None
      and not av.app_list.item(0).icon().isNull()
      and not av.icon_label.pixmap().isNull(),
      "_on_icon applies a fetched icon to the row + header")
av._on_icon("com.android.systemui", "unavailable")
check(av._icons_disabled, "'unavailable' (no unzip on device) disables icon fetching")
av.shutdown()
check(not os.path.isdir(av._tmp), "AppManagerView.shutdown() removes the staged-APK temp dir")

# ---------------------------------------------------------------------------
# Decompiler (jadx) + source viewer
import tempfile as _tf
import shutil as _shutil
from logcat_viewer.decompile import (
    SourceViewerWindow, Highlighter, CodeEditor,
    system_jadx, system_java, decompile_root,
)
# tool discovery never raises and returns str|None
check(system_jadx() is None or isinstance(system_jadx(), str), "system_jadx() returns str|None")
check(system_java() is None or isinstance(system_java(), str), "system_java() returns str|None")
check(os.path.isdir(decompile_root()), "decompile_root() creates its cache dir")

# highlighter switches Java/XML modes without error
_doc = CodeEditor()
_hl = Highlighter(_doc.document())
_doc.setPlainText("// c\n@Override\npublic class A { String s=\"x\"; int n=3; }")
_hl.set_mode("java")
_doc.setPlainText("<a b=\"c\"><!-- x --></a>")
_hl.set_mode("xml")
check(_doc.line_number_width() > 0, "CodeEditor draws a line-number gutter")

# the source viewer opens a decompiled tree and loads a file into the editor
_srcroot = _tf.mkdtemp(prefix="smoke-src-")
os.makedirs(os.path.join(_srcroot, "sources", "com", "x"), exist_ok=True)
_javap = os.path.join(_srcroot, "sources", "com", "x", "Main.java")
with open(_javap, "w") as _f:
    _f.write("package com.x;\npublic class Main { /* hi */ }\n")
_sv = SourceViewerWindow(_srcroot, "com.x")
_sv._load_file(_javap)
check("public class Main" in _sv.editor.toPlainText()
      and _sv.path_label.text().endswith("Main.java"),
      "SourceViewerWindow loads a .java file into the code editor")
_sv._load_file(_javap.replace("Main.java", "logo.png"))  # nonexistent binary-ext path
_sv.close()
_shutil.rmtree(_srcroot, ignore_errors=True)

# ---------------------------------------------------------------------------
# About dialog: builds, draws a non-null logo, and credits the author
# ---------------------------------------------------------------------------
from PyQt6.QtWidgets import QLabel as _QLabel, QPushButton as _QPushButton
from logcat_viewer.about import AboutDialog, logo_pixmap, AUTHOR
check(not logo_pixmap(64).isNull(), "about.logo_pixmap() draws a non-null app mark")
_about = AboutDialog()
_texts = " ".join(_l.text() for _l in _about.findChildren(_QLabel))
check("Logcat Viewer" in _texts and AUTHOR in _texts,
      "AboutDialog shows the app name and author credit")
check(_about.findChild(_QPushButton, "AboutClose") is not None,
      "AboutDialog has a Close button")
_about.close()

print()
if fails:
    print(f"{len(fails)} FAILURE(S)")
    sys.exit(1)
print("ALL SMOKE CHECKS PASSED")
