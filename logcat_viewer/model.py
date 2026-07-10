"""Qt table model over a capped log buffer with an incremental filtered view."""
from __future__ import annotations

from PyQt6.QtCore import QAbstractTableModel, QModelIndex, Qt

from .colors import META, MSG_TEXT, tag_color
from .filters import FilterSpec
from .parser import LogEntry

COL_TIME, COL_PID, COL_TID, COL_LEVEL, COL_TAG, COL_MSG = range(6)
HEADERS = ["Time", "PID", "TID", "Lvl", "Tag", "Message"]


class LogTableModel(QAbstractTableModel):
    def __init__(self, max_entries: int = 200_000, trim_chunk: int = 20_000, parent=None):
        super().__init__(parent)
        self.max_entries = max_entries
        self.trim_chunk = trim_chunk
        self.entries: list[LogEntry] = []      # full ring buffer
        self.visible: list[int] = []           # indices into entries that pass the filter
        self._spec = FilterSpec().compile()

    # --- Qt model interface ------------------------------------------------
    def rowCount(self, parent=QModelIndex()) -> int:
        return 0 if parent.isValid() else len(self.visible)

    def columnCount(self, parent=QModelIndex()) -> int:
        return 0 if parent.isValid() else len(HEADERS)

    def headerData(self, section, orientation, role=Qt.ItemDataRole.DisplayRole):
        if orientation == Qt.Orientation.Horizontal and role == Qt.ItemDataRole.DisplayRole:
            return HEADERS[section]
        return None

    def data(self, index, role=Qt.ItemDataRole.DisplayRole):
        if not index.isValid():
            return None
        e = self.entries[self.visible[index.row()]]
        col = index.column()
        if role == Qt.ItemDataRole.DisplayRole:
            if col == COL_TIME:
                return e.time
            if col == COL_PID:
                return str(e.pid) if e.pid else ""
            if col == COL_TID:
                return str(e.tid) if e.tid else ""
            if col == COL_LEVEL:
                return e.level
            if col == COL_TAG:
                return e.tag
            if col == COL_MSG:
                return e.msg
        elif role == Qt.ItemDataRole.ForegroundRole:
            if col == COL_TAG:
                return tag_color(e.tag)
            if col == COL_MSG:
                return MSG_TEXT.get(e.level, MSG_TEXT["?"])
            if col in (COL_TIME, COL_PID, COL_TID):
                return META
            return None  # level column is painted by the badge delegate
        elif role == Qt.ItemDataRole.TextAlignmentRole:
            if col in (COL_PID, COL_TID):
                return int(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignTop)
            return int(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignTop)
        return None

    # --- data flow ---------------------------------------------------------
    def append_batch(self, new_entries: list[LogEntry]) -> None:
        if not new_entries:
            return
        base = len(self.entries)
        self.entries.extend(new_entries)
        matched = [base + off for off, e in enumerate(new_entries) if self._spec.match(e)]
        if matched:
            first = len(self.visible)
            self.beginInsertRows(QModelIndex(), first, first + len(matched) - 1)
            self.visible.extend(matched)
            self.endInsertRows()
        if len(self.entries) > self.max_entries:
            self._trim()

    def set_filter(self, spec: FilterSpec) -> None:
        self.beginResetModel()
        self._spec = spec
        self._rebuild_visible()
        self.endResetModel()

    def clear(self) -> None:
        self.beginResetModel()
        self.entries = []
        self.visible = []
        self.endResetModel()

    def entry_at(self, row: int) -> LogEntry:
        return self.entries[self.visible[row]]

    def total_count(self) -> int:
        return len(self.entries)

    # --- internals ---------------------------------------------------------
    def _rebuild_visible(self) -> None:
        m = self._spec.match
        self.visible = [i for i, e in enumerate(self.entries) if m(e)]

    def _trim(self) -> None:
        drop = len(self.entries) - self.max_entries + self.trim_chunk
        self.beginResetModel()
        self.entries = self.entries[drop:]
        self._rebuild_visible()
        self.endResetModel()
