"""Main window: device/stream controls, live filter bar, log table, detail pane."""
from __future__ import annotations

import os

from PyQt6.QtCore import Qt, QProcess, QTimer, QUrl
from PyQt6.QtGui import (
    QDesktopServices,
    QFont,
    QFontMetrics,
    QGuiApplication,
    QKeySequence,
    QShortcut,
)
from PyQt6.QtWidgets import (
    QAbstractItemView,
    QCheckBox,
    QComboBox,
    QCompleter,
    QDockWidget,
    QFileDialog,
    QHeaderView,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMainWindow,
    QMenu,
    QMessageBox,
    QPlainTextEdit,
    QPushButton,
    QTableView,
    QVBoxLayout,
    QWidget,
)

from . import adb as adblib
from . import apps as applib
from .delegates import LevelBadgeDelegate, MessageDelegate, WRAP_FLAGS
from .mirror import MirrorView
from .pull import PullWorker
from .filters import FilterSpec
from .model import COL_MSG, COL_PID, COL_TID, COL_TIME, COL_LEVEL, COL_TAG, LogTableModel
from .parser import PRIORITY, parse_line

FLUSH_MS = 100          # how often buffered lines are pushed into the view
FILTER_DEBOUNCE_MS = 150
RATE_MS = 1000
APP_PID_REFRESH_MS = 3000   # re-resolve the selected app's PIDs (handles restart/launch)
MAX_PENDING = 200_000   # cap the paused/backlog buffer
DEFAULT_FONT_PT = 12
FONT_MIN, FONT_MAX = 8, 30
MSG_MIN_W = 320   # base width of the Message column in non-wrap (horizontal-scroll) mode

LEVELS = [
    ("Verbose", PRIORITY["V"]),
    ("Debug", PRIORITY["D"]),
    ("Info", PRIORITY["I"]),
    ("Warn", PRIORITY["W"]),
    ("Error", PRIORITY["E"]),
    ("Fatal", PRIORITY["F"]),
]

_ERR_STYLE = "border: 1px solid #e2554e; border-radius: 3px;"


class AppCombo(QComboBox):
    """Editable, searchable app picker that lazily loads the device app list
    the first time its dropdown is opened."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self._loader = None

    def set_loader(self, fn):
        self._loader = fn

    def showPopup(self):
        if self._loader and self.count() <= 1:
            self._loader()
        super().showPopup()


class LogTable(QTableView):
    """Table view with a working Cmd+C that copies whole selected log lines."""

    def keyPressEvent(self, event):
        if event.matches(QKeySequence.StandardKey.Copy):
            self.copy_selection()
        else:
            super().keyPressEvent(event)

    def copy_selection(self):
        sm = self.selectionModel()
        model = self.model()
        if sm is None or model is None:
            return
        rows = sorted(i.row() for i in sm.selectedRows())
        if not rows:
            return
        out = []
        for r in rows:
            e = model.entry_at(r)
            out.append(e.raw or f"{e.time} {e.pid} {e.tid} {e.level} {e.tag}: {e.msg}")
        QGuiApplication.clipboard().setText("\n".join(out))


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Logcat Viewer")
        self.resize(1180, 720)

        self.adb = adblib.find_adb()
        self.reader = adblib.LogcatReader(self.adb) if self.adb else None
        self.model = LogTableModel()
        self.pending = []
        self.paused = False
        self._recv_since_tick = 0
        self._rate = 0
        self._dropped = 0
        self._app_pkg = None            # selected app package, or None for "All apps"
        self._app_pids = None           # frozenset of that app's live PIDs, or None
        self._font_pt = DEFAULT_FONT_PT
        self._wrap = True               # word-wrap messages across multiple lines
        self._resizing = False          # re-entrancy guard for row auto-sizing
        self._msg_col_w = MSG_MIN_W     # Message column width in non-wrap mode (grow-only)
        self._install_proc = None       # running `adb install` QProcess, if any
        self._installing = ""           # names of APK(s) currently installing
        self._clone_hosts = {}          # clone package -> VA host (for pulling clone APKs)
        self._pull_worker = None        # running PullWorker, if any

        self._build_ui()
        self._wire()
        self.setAcceptDrops(True)       # drag-drop .apk files onto the window
        self.refresh_devices()
        self._update_status()

    # --- construction ------------------------------------------------------
    def _build_ui(self):
        central = QWidget()
        root = QVBoxLayout(central)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)

        # --- Toolbar container (two rows) -----------------------------------
        toolbar = QWidget()
        toolbar.setObjectName("Toolbar")
        tb = QVBoxLayout(toolbar)
        tb.setContentsMargins(12, 10, 12, 10)
        tb.setSpacing(8)

        # Row 1: device + app + stream controls
        row1 = QHBoxLayout()
        row1.setSpacing(8)
        self.device_combo = QComboBox()
        self.device_combo.setMinimumWidth(220)
        self.refresh_btn = QPushButton("⟳")
        self.refresh_btn.setToolTip("Refresh device list")
        self.install_btn = QPushButton("Install…")
        self.install_btn.setToolTip("Install APK(s) to the selected device — or drag .apk files onto the window")
        self.app_combo = AppCombo()
        self.app_combo.setEditable(True)
        self.app_combo.setInsertPolicy(QComboBox.InsertPolicy.NoInsert)
        self.app_combo.setMinimumWidth(240)
        self.app_combo.addItem("All apps")
        self.app_combo.setCurrentIndex(0)
        self.app_combo.lineEdit().setPlaceholderText("All apps")
        self.app_combo.set_loader(self.reload_apps)
        comp = self.app_combo.completer()
        comp.setCompletionMode(QCompleter.CompletionMode.PopupCompletion)
        comp.setFilterMode(Qt.MatchFlag.MatchContains)
        comp.setCaseSensitivity(Qt.CaseSensitivity.CaseInsensitive)
        self.reload_apps_btn = QPushButton("⟳")
        self.reload_apps_btn.setToolTip("Reload installed / running apps")
        self.pull_btn = QPushButton("Pull")
        self.pull_btn.setToolTip("Pull the selected app's APK(s) from the device")
        self.start_btn = QPushButton("▶  Start")
        self.start_btn.setObjectName("start")
        self.start_btn.setProperty("running", "false")
        self.pause_btn = QPushButton("⏸  Pause")
        self.pause_btn.setObjectName("pause")
        self.pause_btn.setCheckable(True)
        self.pause_btn.setEnabled(False)
        self.clear_btn = QPushButton("✕  Clear")
        self.mirror_btn = QPushButton("Mirror")
        self.mirror_btn.setCheckable(True)
        self.mirror_btn.setToolTip("Mirror the selected device's screen")
        self.autoscroll_cb = QCheckBox("Auto-scroll")
        self.autoscroll_cb.setChecked(True)
        row1.addWidget(QLabel("Device"))
        row1.addWidget(self.device_combo, 1)
        row1.addWidget(self.refresh_btn)
        row1.addWidget(self.install_btn)
        row1.addSpacing(6)
        row1.addWidget(QLabel("App"))
        row1.addWidget(self.app_combo, 1)
        row1.addWidget(self.reload_apps_btn)
        row1.addWidget(self.pull_btn)
        row1.addSpacing(6)
        row1.addWidget(self.start_btn)
        row1.addWidget(self.pause_btn)
        row1.addWidget(self.clear_btn)
        row1.addWidget(self.mirror_btn)
        tb.addLayout(row1)

        # Row 2: view + filter bar
        row2 = QHBoxLayout()
        row2.setSpacing(8)
        row2.addWidget(self.autoscroll_cb)
        self.wrap_cb = QCheckBox("Wrap")
        self.wrap_cb.setChecked(self._wrap)
        self.wrap_cb.setToolTip("Wrap long messages across multiple lines")
        row2.addWidget(self.wrap_cb)
        row2.addSpacing(8)
        self.font_dec_btn = QPushButton("A−")
        self.font_dec_btn.setObjectName("toggle")
        self.font_dec_btn.setToolTip("Decrease text size  (⌘−)")
        self.font_label = QLabel(str(self._font_pt))
        self.font_label.setObjectName("fontLabel")
        self.font_inc_btn = QPushButton("A+")
        self.font_inc_btn.setObjectName("toggle")
        self.font_inc_btn.setToolTip("Increase text size  (⌘+)")
        row2.addWidget(self.font_dec_btn)
        row2.addWidget(self.font_label)
        row2.addWidget(self.font_inc_btn)
        row2.addSpacing(8)
        self.level_combo = QComboBox()
        for name, prio in LEVELS:
            self.level_combo.addItem(name, prio)
        self.tag_edit = QLineEdit()
        self.tag_edit.setPlaceholderText("tag")
        self.tag_regex_cb = self._regex_toggle("Treat tag filter as a regular expression")
        self.pid_edit = QLineEdit()
        self.pid_edit.setPlaceholderText("PID(s)")
        self.pid_edit.setMaximumWidth(110)
        self.text_edit = QLineEdit()
        self.text_edit.setPlaceholderText("search tag + message…")
        self.text_regex_cb = self._regex_toggle("Treat search as a regular expression")
        self.exclude_edit = QLineEdit()
        self.exclude_edit.setPlaceholderText("exclude")
        self.exclude_regex_cb = self._regex_toggle("Treat exclude as a regular expression")

        row2.addWidget(QLabel("Level"))
        row2.addWidget(self.level_combo)
        row2.addSpacing(4)
        row2.addWidget(QLabel("Tag"))
        row2.addWidget(self.tag_edit, 2)
        row2.addWidget(self.tag_regex_cb)
        row2.addWidget(QLabel("PID"))
        row2.addWidget(self.pid_edit)
        row2.addWidget(QLabel("Find"))
        row2.addWidget(self.text_edit, 3)
        row2.addWidget(self.text_regex_cb)
        row2.addWidget(QLabel("Exclude"))
        row2.addWidget(self.exclude_edit, 2)
        row2.addWidget(self.exclude_regex_cb)
        tb.addLayout(row2)

        root.addWidget(toolbar)

        # --- Log table ------------------------------------------------------
        self.table = LogTable()
        self.table.setModel(self.model)
        self._mono = self._make_mono()
        self.table.setFont(self._mono)
        self.table.setItemDelegateForColumn(COL_LEVEL, LevelBadgeDelegate(self.table))
        self._msg_delegate = MessageDelegate(self.table, COL_MSG)
        self._msg_delegate.wrap = self._wrap
        self.table.setItemDelegateForColumn(COL_MSG, self._msg_delegate)
        self.table.setShowGrid(False)
        self.table.setWordWrap(False)  # message wrapping is handled by MessageDelegate
        self.table.setAlternatingRowColors(False)
        self.table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.table.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)
        self.table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.table.setHorizontalScrollMode(QAbstractItemView.ScrollMode.ScrollPerPixel)
        self.table.setVerticalScrollMode(QAbstractItemView.ScrollMode.ScrollPerPixel)
        self.table.setTextElideMode(Qt.TextElideMode.ElideRight)  # for the tag column
        self.table.setFrameShape(QAbstractItemView.Shape.NoFrame)
        self.table.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self.table.customContextMenuRequested.connect(self._show_table_menu)
        vh = self.table.verticalHeader()
        vh.setVisible(False)
        vh.setMinimumSectionSize(16)
        header = self.table.horizontalHeader()
        header.setHighlightSections(False)
        header.setStretchLastSection(False)
        header.setSectionResizeMode(QHeaderView.ResizeMode.Interactive)
        header.setSectionResizeMode(
            COL_MSG,
            QHeaderView.ResizeMode.Stretch if self._wrap else QHeaderView.ResizeMode.Interactive)
        self.table.setColumnWidth(COL_TIME, 112)
        self.table.setColumnWidth(COL_PID, 60)
        self.table.setColumnWidth(COL_TID, 60)
        self.table.setColumnWidth(COL_LEVEL, 46)
        self.table.setColumnWidth(COL_TAG, 220)
        root.addWidget(self.table, 1)

        # --- Detail pane (full selected line) -------------------------------
        self.detail = QPlainTextEdit()
        self.detail.setObjectName("Detail")
        self.detail.setReadOnly(True)
        self.detail.setFont(self._mono)
        self.detail.setFrameShape(QPlainTextEdit.Shape.NoFrame)
        self.detail.setMaximumHeight(72)
        self.detail.setPlaceholderText("Select a row to see the full line…")
        root.addWidget(self.detail)

        self.setCentralWidget(central)
        self._apply_font()  # sets fonts + row height for the current size

        # Screen-mirror dock (right side, hidden until toggled).
        self.mirror_view = MirrorView(self.adb or "")
        self.mirror_dock = QDockWidget("Screen", self)
        self.mirror_dock.setObjectName("MirrorDock")
        self.mirror_dock.setWidget(self.mirror_view)
        self.mirror_view.bind_dock(self.mirror_dock)
        self.mirror_dock.setAllowedAreas(
            Qt.DockWidgetArea.RightDockWidgetArea | Qt.DockWidgetArea.LeftDockWidgetArea)
        self.addDockWidget(Qt.DockWidgetArea.RightDockWidgetArea, self.mirror_dock)
        self.resizeDocks([self.mirror_dock], [320], Qt.Orientation.Horizontal)
        self.mirror_dock.hide()

        if not self.adb:
            self.start_btn.setEnabled(False)
            self.install_btn.setEnabled(False)
            self.mirror_btn.setEnabled(False)
            self.pull_btn.setEnabled(False)
            self.device_combo.addItem("adb not found — set $ADB or add to PATH", None)

    def _regex_toggle(self, tip: str) -> QPushButton:
        btn = QPushButton(".*")
        btn.setObjectName("toggle")
        btn.setCheckable(True)
        btn.setToolTip(tip)
        return btn

    def _make_mono(self) -> QFont:
        f = QFont("SF Mono")
        f.setStyleHint(QFont.StyleHint.Monospace)
        f.setPointSize(self._font_pt)
        return f

    def _apply_font(self):
        self._mono = self._make_mono()
        self.table.setFont(self._mono)
        self.detail.setFont(self._mono)
        self.table.verticalHeader().setDefaultSectionSize(QFontMetrics(self._mono).height() + 7)
        self.font_label.setText(str(self._font_pt))

    def bump_font(self, delta: int):
        pt = max(FONT_MIN, min(FONT_MAX, self._font_pt + delta))
        if pt != self._font_pt:
            self._font_pt = pt
            self._apply_font()
            self._schedule_relayout()  # wrapped heights depend on font size

    def _row_height(self) -> int:
        return QFontMetrics(self._mono).height() + 2 * MessageDelegate.V_PAD

    def set_wrap(self, on: bool):
        self._wrap = bool(on)
        self._msg_delegate.wrap = self._wrap
        header = self.table.horizontalHeader()
        if self._wrap:
            # Message fills the viewport and wraps; no horizontal scroll.
            header.setSectionResizeMode(COL_MSG, QHeaderView.ResizeMode.Stretch)
            self._resize_visible_rows()
        else:
            # Compact single-line rows + horizontal scroll for long lines.
            default_h = self._row_height()
            vh = self.table.verticalHeader()
            vh.setDefaultSectionSize(default_h)
            self.table.setUpdatesEnabled(False)
            for r in range(self.model.rowCount()):
                if vh.sectionSize(r) != default_h:
                    self.table.setRowHeight(r, default_h)
            self.table.setUpdatesEnabled(True)
            header.setSectionResizeMode(COL_MSG, QHeaderView.ResizeMode.Interactive)
            self._msg_col_w = MSG_MIN_W
            self.table.setColumnWidth(COL_MSG, MSG_MIN_W)
            self._fit_message_width()
        if self.autoscroll_cb.isChecked():
            self.table.scrollToBottom()

    def _schedule_relayout(self):
        if getattr(self, "_wrap_timer", None) is None:
            return  # resizeEvent can fire before _wire() has built the timer
        if not self._resizing:
            self._wrap_timer.start(20)  # coalesce bursts of scroll/resize events

    def _relayout_visible(self):
        if self._wrap:
            self._resize_visible_rows()
        else:
            self._fit_message_width()

    def _visible_row_range(self):
        n = self.model.rowCount()
        if n == 0:
            return None
        top = self.table.rowAt(0)
        bottom = self.table.rowAt(self.table.viewport().height() - 1)
        if top < 0:
            top = 0
        if bottom < 0:
            bottom = n - 1
        return max(0, top - 4), min(n - 1, bottom + 4)

    def _fit_message_width(self):
        """Size the Message column (non-wrap mode) to at least fill the viewport,
        and grow to fit the widest visible line so the horizontal scrollbar
        reveals long rows."""
        if self._wrap or self._resizing:
            return
        rng = self._visible_row_range()
        if rng is None:
            return
        self._resizing = True
        try:
            others = sum(self.table.columnWidth(c)
                         for c in (COL_TIME, COL_PID, COL_TID, COL_LEVEL, COL_TAG))
            fill = self.table.viewport().width() - others - 4
            w = max(self._msg_col_w, MSG_MIN_W, fill)
            fm = QFontMetrics(self._mono)
            pad = 2 * MessageDelegate.H_PAD + 14
            for r in range(rng[0], rng[1] + 1):
                w = max(w, fm.horizontalAdvance(self.model.entry_at(r).msg) + pad)
            if w != self.table.columnWidth(COL_MSG):
                self._msg_col_w = w
                self.table.setColumnWidth(COL_MSG, w)
        finally:
            self._resizing = False

    def _resize_visible_rows(self):
        """Auto-size only the rows in (and just around) the viewport — keeps
        wrapping fast no matter how large the buffer is."""
        if not self._wrap or self._resizing:
            return
        n = self.model.rowCount()
        if n == 0:
            return
        self._resizing = True
        try:
            top = self.table.rowAt(0)
            bottom = self.table.rowAt(self.table.viewport().height() - 1)
            if top < 0:
                top = 0
            if bottom < 0:
                bottom = n - 1
            top = max(0, top - 4)
            bottom = min(n - 1, bottom + 4)
            fm = QFontMetrics(self._mono)
            wrap_w = max(40, self.table.columnWidth(COL_MSG)) - 2 * MessageDelegate.H_PAD
            one_line = fm.height() + 2 * MessageDelegate.V_PAD
            flags = WRAP_FLAGS | int(Qt.AlignmentFlag.AlignTop)
            for r in range(top, bottom + 1):
                msg = self.model.entry_at(r).msg
                rect = fm.boundingRect(0, 0, max(1, wrap_w), 1_000_000, flags, msg)
                h = max(one_line, rect.height() + 2 * MessageDelegate.V_PAD)
                if self.table.rowHeight(r) != h:
                    self.table.setRowHeight(r, h)
            if self.autoscroll_cb.isChecked():
                self.table.scrollToBottom()
        finally:
            self._resizing = False

    def _wire(self):
        self.refresh_btn.clicked.connect(self.refresh_devices)
        self.refresh_btn.clicked.connect(self.reload_apps)
        self.start_btn.clicked.connect(self.toggle_stream)
        self.pause_btn.toggled.connect(self.set_paused)
        self.clear_btn.clicked.connect(self.clear)
        self.reload_apps_btn.clicked.connect(self.reload_apps)
        self.install_btn.clicked.connect(self.choose_apks)
        self.pull_btn.clicked.connect(self.pull_selected_app)
        self.app_combo.activated.connect(self.select_app)
        # Reload the app list (and re-point the mirror) whenever the device changes.
        self.device_combo.activated.connect(lambda *_: self.reload_apps())
        self.device_combo.activated.connect(lambda *_: self._mirror_device_changed())

        self.mirror_btn.toggled.connect(self.mirror_dock.setVisible)
        self.mirror_dock.visibilityChanged.connect(self._on_mirror_visibility)
        self.mirror_view.fullscreen_changed.connect(self._on_mirror_fullscreen)
        self.mirror_view.failed.connect(lambda m: self.statusBar().showMessage(f"Mirror: {m}", 6000))
        self.mirror_view.apksDropped.connect(self.install_apks)  # drop APK on the screen to install
        self.mirror_view.captured.connect(self._on_mirror_captured)  # screenshot / recording saved

        self._app_pid_timer = QTimer(self)
        self._app_pid_timer.timeout.connect(self._refresh_app_pids)

        # Populate the app list eagerly once the window is up (~120ms), so the
        # dropdown is always full instead of waiting for the user to type.
        QTimer.singleShot(200, self.reload_apps)

        # Live filtering, debounced so typing on a big buffer stays smooth.
        self._filter_timer = QTimer(self)
        self._filter_timer.setSingleShot(True)
        self._filter_timer.timeout.connect(self.apply_filter)
        for w in (self.tag_edit, self.pid_edit, self.text_edit, self.exclude_edit):
            w.textChanged.connect(self._schedule_filter)
        for w in (self.tag_regex_cb, self.text_regex_cb, self.exclude_regex_cb):
            w.toggled.connect(self.apply_filter)
        self.level_combo.currentIndexChanged.connect(self.apply_filter)

        self._flush_timer = QTimer(self)
        self._flush_timer.timeout.connect(self._flush)
        self._flush_timer.start(FLUSH_MS)

        self._rate_timer = QTimer(self)
        self._rate_timer.timeout.connect(self._tick_rate)
        self._rate_timer.start(RATE_MS)

        if self.reader:
            self.reader.linesReady.connect(self._on_lines)
            self.reader.stateChanged.connect(self._on_state)
            self.reader.error.connect(self._on_error)

        self.table.selectionModel().selectionChanged.connect(self._on_selection)

        self.font_inc_btn.clicked.connect(lambda: self.bump_font(+1))
        self.font_dec_btn.clicked.connect(lambda: self.bump_font(-1))
        self.wrap_cb.toggled.connect(self.set_wrap)

        # Row/column auto-sizing only touches visible rows; re-run on scroll/resize.
        self._wrap_timer = QTimer(self)
        self._wrap_timer.setSingleShot(True)
        self._wrap_timer.timeout.connect(self._relayout_visible)
        self.table.verticalScrollBar().valueChanged.connect(lambda *_: self._schedule_relayout())
        self.table.horizontalHeader().sectionResized.connect(lambda *_: self._schedule_relayout())

        QShortcut(QKeySequence.StandardKey.Find, self, activated=self.text_edit.setFocus)
        QShortcut(QKeySequence("Ctrl+K"), self, activated=self.clear)
        QShortcut(QKeySequence("Meta+K"), self, activated=self.clear)
        QShortcut(QKeySequence.StandardKey.ZoomIn, self, activated=lambda: self.bump_font(+1))
        QShortcut(QKeySequence.StandardKey.ZoomOut, self, activated=lambda: self.bump_font(-1))
        QShortcut(QKeySequence("Meta++"), self, activated=lambda: self.bump_font(+1))
        QShortcut(QKeySequence("Meta+="), self, activated=lambda: self.bump_font(+1))
        QShortcut(QKeySequence("Meta+-"), self, activated=lambda: self.bump_font(-1))

    # --- devices / stream --------------------------------------------------
    def refresh_devices(self):
        if not self.adb:
            return
        current = self.device_combo.currentData()
        self.device_combo.clear()
        devices = adblib.list_devices(self.adb)
        if not devices:
            self.device_combo.addItem("no devices — is one connected?", None)
            self.start_btn.setEnabled(False)
            self.install_btn.setEnabled(False)
            self.pull_btn.setEnabled(False)
            return
        for d in devices:
            self.device_combo.addItem(d.label, d.serial)
        # Restore prior selection, else prefer the first online device.
        idx = self.device_combo.findData(current) if current else -1
        if idx < 0:
            idx = next((i for i, d in enumerate(devices) if d.online), 0)
        self.device_combo.setCurrentIndex(idx)
        self.start_btn.setEnabled(True)
        self.install_btn.setEnabled(True)
        self.pull_btn.setEnabled(True)

    def reload_apps(self):
        """Repopulate the picker: gLite clones first (marked), then device apps.

        Clones are virtual apps installed inside a VA host (not OS-installed), so
        they're listed even when not running."""
        serial = self.device_combo.currentData()
        if not self.adb or not serial:
            return
        try:
            device = set(applib.list_apps(self.adb, serial))
        except Exception:
            device = set()
        try:
            clone_map = applib.list_clones(self.adb, serial)
        except Exception:
            clone_map = {}
        clones = sorted({c for cl in clone_map.values() for c in cl})
        self._clone_hosts = {c: host for host, cl in clone_map.items() for c in cl}
        device_only = sorted(device - set(clones))

        self.app_combo.blockSignals(True)
        self.app_combo.clear()
        self.app_combo.addItem("All apps")
        for c in clones:
            self.app_combo.addItem(f"{c}   (clone)", c)   # display marked, data = real pkg
        for d in device_only:
            self.app_combo.addItem(d, d)
        if self._app_pkg:
            i = self.app_combo.findData(self._app_pkg)
            if i >= 0:
                self.app_combo.setCurrentIndex(i)
            else:
                self.app_combo.setEditText(self._app_pkg)
        else:
            self.app_combo.setCurrentIndex(0)
        self.app_combo.blockSignals(False)
        self.statusBar().showMessage(
            f"{len(clones)} clone{'s' if len(clones) != 1 else ''} + "
            f"{len(device_only)} device apps", 4000)

    def _current_app_pkg(self):
        """The package currently chosen in the picker (strips the "(clone)"
        marker via item data); "" for "All apps" / empty."""
        idx = self.app_combo.currentIndex()
        data = self.app_combo.itemData(idx) if idx >= 0 else None
        text = self.app_combo.currentText().strip()
        pkg = data if (idx > 0 and data and self.app_combo.itemText(idx) == text) else text
        return "" if (not pkg or pkg == "All apps") else pkg

    def select_app(self, *_):
        pkg = self._current_app_pkg()
        if not pkg:
            self._app_pkg = None
            self._app_pids = None
            self._app_pid_timer.stop()
        else:
            self._app_pkg = pkg
            self._app_pids = frozenset(self._resolve_pids(pkg))
            if not self._app_pid_timer.isActive():
                self._app_pid_timer.start(APP_PID_REFRESH_MS)
        self.apply_filter()

    def pull_selected_app(self):
        pkg = self._current_app_pkg()
        if not pkg:
            self.statusBar().showMessage("Pick an app in the App box first, then Pull", 5000)
            return
        serial = self.device_combo.currentData()
        if not self.adb or not serial:
            return
        if self._pull_worker is not None:
            self.statusBar().showMessage("A pull is already running…", 4000)
            return
        default_dir = os.path.expanduser("~/Downloads")
        if not os.path.isdir(default_dir):
            default_dir = os.path.expanduser("~")
        dest_root = QFileDialog.getExistingDirectory(self, f"Pull {pkg} APK(s) into…", default_dir)
        if not dest_root:
            return
        self.pull_btn.setEnabled(False)
        self.pull_btn.setText("Pulling…")
        self.statusBar().showMessage(f"Pulling {pkg} APK(s) → {dest_root} …")
        self._pull_worker = PullWorker(
            self.adb, serial, pkg, dest_root, self._clone_hosts.get(pkg))
        self._pull_worker.done.connect(self._on_pull_done)
        self._pull_worker.start()

    def _on_pull_done(self, ok, message, dest):
        self._pull_worker = None
        self.pull_btn.setEnabled(True)
        self.pull_btn.setText("Pull")
        box = QMessageBox(self)
        box.setModal(False)
        if ok:
            self.statusBar().showMessage(f"✓ {message}", 8000)
            box.setIcon(QMessageBox.Icon.Information)
            box.setWindowTitle("APK pulled")
            box.setText(f"✓  Saved to:\n{dest}")
            box.setInformativeText(message)
            open_btn = box.addButton("Open Folder", QMessageBox.ButtonRole.ActionRole)
            box.addButton(QMessageBox.StandardButton.Ok)
            box.buttonClicked.connect(
                lambda b, d=dest: QDesktopServices.openUrl(QUrl.fromLocalFile(d))
                if b is open_btn else None)
        else:
            self.statusBar().showMessage(f"✗ {message}", 12000)
            box.setIcon(QMessageBox.Icon.Critical)
            box.setWindowTitle("Pull failed")
            box.setText(message)
        box.show()

    def _resolve_pids(self, package):
        serial = self.device_combo.currentData()
        if not self.adb or not serial:
            return set()
        try:
            return applib.resolve_pids(self.adb, serial, package)
        except Exception:
            return set()

    def _refresh_app_pids(self):
        """Re-resolve the selected app's PIDs so a restart/launch is picked up."""
        if not self._app_pkg:
            self._app_pid_timer.stop()
            return
        new = frozenset(self._resolve_pids(self._app_pkg))
        if new != self._app_pids:
            self._app_pids = new
            self.apply_filter()

    def toggle_stream(self):
        if self.reader and self.reader.running:
            self.reader.stop()
        else:
            serial = self.device_combo.currentData()
            if serial and self.reader:
                self.reader.start(serial)
                if self.app_combo.count() <= 1:
                    self.reload_apps()

    # --- screen mirror -----------------------------------------------------
    def _on_mirror_visibility(self, visible):
        if not visible and self.mirror_view.is_fullscreen():
            return  # dock hidden while mirror is popped out — not a stop request
        self.mirror_btn.blockSignals(True)
        self.mirror_btn.setChecked(visible)
        self.mirror_btn.blockSignals(False)
        if visible:
            serial = self.device_combo.currentData()
            if self.adb and serial:
                if not self.mirror_view.mirror_running():
                    self.mirror_view.start(serial)
            else:
                self.mirror_dock.setVisible(False)
        else:
            self.mirror_view.stop()

    def _on_mirror_fullscreen(self, on: bool):
        # Hide the empty dock slot while the mirror is a top-level full-screen window.
        self.mirror_dock.blockSignals(True)
        if on:
            self.mirror_dock.hide()
        else:
            self.mirror_dock.show()
        self.mirror_dock.blockSignals(False)
        self.mirror_btn.blockSignals(True)
        self.mirror_btn.setChecked(True)
        self.mirror_btn.blockSignals(False)

    def _mirror_device_changed(self):
        if self.mirror_dock.isVisible():
            serial = self.device_combo.currentData()
            if self.adb and serial:
                self.mirror_view.start(serial)

    def _on_mirror_captured(self, ok, message, directory):
        """A screenshot / screen recording finished saving."""
        if ok:
            self.statusBar().showMessage(f"✓ {message} → {directory}", 8000)
            if not directory:
                return
            box = QMessageBox(self)
            box.setModal(False)
            box.setIcon(QMessageBox.Icon.Information)
            box.setWindowTitle("Capture saved")
            box.setText(f"✓  {message}")
            box.setInformativeText(directory)
            open_btn = box.addButton("Open Folder", QMessageBox.ButtonRole.ActionRole)
            box.addButton(QMessageBox.StandardButton.Ok)
            box.buttonClicked.connect(
                lambda b, d=directory: QDesktopServices.openUrl(QUrl.fromLocalFile(d))
                if b is open_btn else None)
            box.show()
        else:
            self.statusBar().showMessage(f"✗ {message}", 10000)

    # --- APK install -------------------------------------------------------
    def choose_apks(self):
        paths, _ = QFileDialog.getOpenFileNames(
            self, "Select APK(s) to install", os.path.expanduser("~"),
            "Android packages (*.apk);;All files (*)")
        if paths:
            self.install_apks(paths)

    def install_apks(self, paths):
        serial = self.device_combo.currentData()
        if not self.adb or not serial:
            self.statusBar().showMessage("No device selected", 4000)
            return
        if self._install_proc is not None:
            self.statusBar().showMessage("An install is already running…", 4000)
            return
        apks = [p for p in paths if p.lower().endswith(".apk")]
        if not apks:
            self.statusBar().showMessage("No .apk files selected", 4000)
            return
        # Several APKs at once are treated as splits of one app (install-multiple).
        verb = "install" if len(apks) == 1 else "install-multiple"
        args = ["-s", serial, verb, "-r", "-d", *apks]
        proc = QProcess(self)
        proc.setProcessChannelMode(QProcess.ProcessChannelMode.MergedChannels)
        proc.finished.connect(self._on_install_done)
        self._install_proc = proc
        self._installing = ", ".join(os.path.basename(p) for p in apks)
        self.install_btn.setEnabled(False)
        self.install_btn.setText("Installing…")
        self.statusBar().showMessage(f"Installing {self._installing} → {serial} …")
        self.mirror_view.install_started(self._installing)  # banner on the mirrored screen
        proc.start(self.adb, args)

    def _on_install_done(self, code, status):
        out = bytes(self._install_proc.readAll()).decode("utf-8", "replace").strip()
        self._install_proc = None
        self.install_btn.setEnabled(True)
        self.install_btn.setText("Install…")
        names = self._installing or "APK"
        if code == 0 and "Success" in out:
            self.statusBar().showMessage(f"✓ Installed {names}", 8000)
            self.mirror_view.install_finished(True, f"Installed {names}")
            self.reload_apps()  # the new package shows up in the picker
        else:
            reason = next((l.strip() for l in reversed(out.splitlines()) if l.strip()), "")
            reason = reason or f"adb exited with code {code}"
            self.statusBar().showMessage(f"✗ Install failed: {reason}", 12000)
            self.mirror_view.install_finished(False, f"Failed: {reason}")
            box = QMessageBox(self)
            box.setIcon(QMessageBox.Icon.Critical)
            box.setWindowTitle("Install failed")
            box.setText(f"✗  Failed to install:\n{names}")
            box.setInformativeText(reason)
            if out:
                box.setDetailedText(out)   # full adb output, expandable
            box.setModal(False)
            box.show()

    def dragEnterEvent(self, event):
        md = event.mimeData()
        if md.hasUrls() and any(u.toLocalFile().lower().endswith(".apk") for u in md.urls()):
            event.acceptProposedAction()

    def dropEvent(self, event):
        paths = [u.toLocalFile() for u in event.mimeData().urls()
                 if u.toLocalFile().lower().endswith(".apk")]
        if paths:
            self.install_apks(paths)

    def _on_state(self, state):
        running = self.reader.running if self.reader else False
        self.start_btn.setText("■  Stop" if running else "▶  Start")
        self.start_btn.setProperty("running", "true" if running else "false")
        self._repolish(self.start_btn)
        self.pause_btn.setEnabled(running)
        if not running and self.pause_btn.isChecked():
            self.pause_btn.setChecked(False)
        self._update_status()

    @staticmethod
    def _repolish(w):
        w.style().unpolish(w)
        w.style().polish(w)
        w.update()

    def _on_error(self, msg):
        self.statusBar().showMessage(f"adb: {msg}", 6000)

    # --- stream data -------------------------------------------------------
    def _on_lines(self, lines):
        for line in lines:
            e = parse_line(line)
            if e is not None:
                self.pending.append(e)
        self._recv_since_tick += len(lines)
        if len(self.pending) > MAX_PENDING:
            self._dropped += len(self.pending) - MAX_PENDING
            del self.pending[:-MAX_PENDING]

    def _flush(self):
        if self.paused or not self.pending:
            return
        batch = self.pending
        self.pending = []
        at_bottom_wanted = self.autoscroll_cb.isChecked()
        self.model.append_batch(batch)
        if at_bottom_wanted:
            self.table.scrollToBottom()
        self._schedule_relayout()
        self._update_status()

    def _tick_rate(self):
        self._rate = self._recv_since_tick
        self._recv_since_tick = 0
        self._update_status()

    # --- filtering ---------------------------------------------------------
    def _schedule_filter(self):
        self._filter_timer.start(FILTER_DEBOUNCE_MS)

    def apply_filter(self):
        spec = FilterSpec(
            min_priority=self.level_combo.currentData(),
            tag_query=self.tag_edit.text().strip(),
            tag_regex=self.tag_regex_cb.isChecked(),
            pids=self.pid_edit.text(),
            package=self._app_pkg or "",
            package_pids=self._app_pids,
            text_query=self.text_edit.text(),
            text_regex=self.text_regex_cb.isChecked(),
            exclude_query=self.exclude_edit.text(),
            exclude_regex=self.exclude_regex_cb.isChecked(),
        ).compile()
        self.model.set_filter(spec)
        self._mark(self.tag_edit, spec.has_error("tag"))
        self._mark(self.pid_edit, spec.has_error("pid"))
        self._mark(self.text_edit, spec.has_error("text"))
        self._mark(self.exclude_edit, spec.has_error("exclude"))
        if self.autoscroll_cb.isChecked():
            self.table.scrollToBottom()
        self._schedule_relayout()
        self._update_status()

    @staticmethod
    def _mark(widget, is_error):
        widget.setStyleSheet(_ERR_STYLE if is_error else "")

    # --- misc UI -----------------------------------------------------------
    def set_paused(self, paused):
        self.paused = paused
        self.pause_btn.setText("▶  Resume" if paused else "⏸  Pause")
        if not paused:
            self._flush()
        self._update_status()

    def clear(self):
        self.model.clear()
        self.pending.clear()
        self._dropped = 0
        self.detail.clear()
        if not self._wrap:  # reset horizontal-scroll width for the empty view
            self._msg_col_w = MSG_MIN_W
            self.table.setColumnWidth(COL_MSG, MSG_MIN_W)
        self._update_status()

    def _show_table_menu(self, pos):
        menu = QMenu(self)
        sel = self.table.selectionModel().selectedRows()
        act_copy = menu.addAction(f"Copy {len(sel)} line{'s' if len(sel) != 1 else ''}"
                                  if sel else "Copy")
        act_copy.setEnabled(bool(sel))
        act_clear = menu.addAction("Clear log")
        menu.addSeparator()

        # Force-crash targets the filtered app, else the right-clicked row's process.
        pkg = self._app_pkg
        pids = set(self._app_pids) if self._app_pids else set()
        idx = self.table.indexAt(pos)
        row_pid = self.model.entry_at(idx.row()).pid if idx.isValid() else None
        if pkg:
            label = f"Force-crash  {pkg}" + (f"  ({len(pids)} pid)" if pids else "  (not running)")
            target = (pkg, pids)
        elif row_pid:
            label = f"Force-crash  pid {row_pid}"
            target = ("", {row_pid})
        else:
            label = "Force-crash app"
            target = None
        act_crash = menu.addAction(label)
        act_crash.setEnabled(target is not None)

        chosen = menu.exec(self.table.viewport().mapToGlobal(pos))
        if chosen == act_copy:
            self.table.copy_selection()
        elif chosen == act_clear:
            self.clear()
        elif chosen == act_crash and target is not None:
            self._force_crash(*target)

    def _force_crash(self, package, pids):
        serial = self.device_combo.currentData()
        if not self.adb or not serial:
            return
        if package and not pids:
            pids = self._resolve_pids(package)
        notes = applib.force_crash(self.adb, serial, package, pids)
        who = package or (f"pid {min(pids)}" if pids else "app")
        if notes:
            self.statusBar().showMessage(f"Force-crashed {who}: {', '.join(notes)}", 6000)
        else:
            self.statusBar().showMessage(
                f"Force-crash {who}: nothing ran (needs root for clones, or not running)", 6000)

    def _on_selection(self, *_):
        rows = self.table.selectionModel().selectedRows()
        if rows:
            self.detail.setPlainText(self.model.entry_at(rows[-1].row()).raw)

    def _update_status(self):
        shown = self.model.rowCount()
        total = self.model.total_count()
        state = "running" if (self.reader and self.reader.running) else "stopped"
        parts = [f"{shown:,}/{total:,} shown", f"{self._rate}/s", state]
        if self._app_pkg:
            n = len(self._app_pids) if self._app_pids is not None else 0
            tail = "not running" if n == 0 else f"{n} pid{'s' if n != 1 else ''}"
            parts.append(f"app: {self._app_pkg} ({tail})")
        if self.paused:
            buffered = len(self.pending)
            parts.append(f"PAUSED · {buffered:,} buffered")
        if self._dropped:
            parts.append(f"{self._dropped:,} dropped (backlog cap)")
        self.statusBar().showMessage("   ·   ".join(parts))

    def resizeEvent(self, event):
        super().resizeEvent(event)
        self._schedule_relayout()  # column widths changed -> re-wrap visible rows

    def closeEvent(self, event):
        if self.reader:
            self.reader.stop()
        self.mirror_view.stop()
        super().closeEvent(event)
