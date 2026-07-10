"""Database Inspector: browse a debuggable app's SQLite databases, Android-Studio style.

Like Android Studio's Database Inspector, this reads the private SQLite databases of
the **selected app**. Without a JDWP/debug bridge the approach is deliberately simple
and dependency-free:

* **List** the app's ``databases/`` dir over adb — ``run-as <pkg> ls -1 databases/``
  (the only requirement, same as Android Studio: the app must be **debuggable**, or the
  device rooted — then ``su`` is used).
* **Pull a snapshot** of a chosen database (plus its ``-wal`` / ``-shm`` / ``-journal``
  sidecars, so WAL-mode data is current) to a local temp dir with ``exec-out ... cat``.
* **Read** it with Python's stdlib ``sqlite3`` — no new dependency. Browse tables, page
  through rows, and run read-only SQL.

Queries run against the **local snapshot**, never the live device file — the connection
is opened ``query_only`` so an accidental write can't even touch the copy. Hit *Refresh*
to re-pull a fresh snapshot.

Everything that touches the device or opens sqlite runs on a ``QThread`` worker (a big
table's ``COUNT(*)`` or a user JOIN could otherwise stall the UI); the widgets are only
ever updated from result signals.
"""
from __future__ import annotations

import csv
import os
import shutil
import sqlite3
import subprocess
import tempfile

from PyQt6.QtCore import QAbstractTableModel, QModelIndex, QPointF, QRectF, Qt, QThread, pyqtSignal
from PyQt6.QtGui import (
    QColor, QFont, QGuiApplication, QIcon, QKeySequence, QPainter, QPen, QPixmap,
)
from PyQt6.QtWidgets import (
    QAbstractItemView,
    QCheckBox,
    QDialog,
    QDialogButtonBox,
    QFileDialog,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QLineEdit,
    QMenu,
    QPlainTextEdit,
    QProgressBar,
    QPushButton,
    QSplitter,
    QTableView,
    QTreeWidget,
    QTreeWidgetItem,
    QVBoxLayout,
    QWidget,
)

from .theme import ACCENT, GREEN, TEXT, TEXT_DIM

SQLITE_MAGIC = b"SQLite format 3\x00"
SIDECAR_SUFFIXES = ("-wal", "-shm", "-journal")
PAGE_SIZE = 200            # rows shown per table page
QUERY_ROW_CAP = 5000       # max rows a free-form query returns to the table
DB_HOME = "/data/data/{pkg}/databases"

# stderr markers that mean run-as itself refused (app not debuggable / unknown),
# as opposed to a plain "databases/ doesn't exist yet" (accessible, just empty).
_RUNAS_BLOCKED = ("not debuggable", "unknown package", "is unknown", "package inaccessible")


# --- pure adb command builders (no device needed → covered by smoke tests) -----
def list_dbs_args(serial: str, package: str, *, su: bool = False) -> list[str]:
    """adb args to list the files in an app's ``databases/`` directory.

    No shell redirections/metacharacters — ``adb shell`` re-parses the command
    line, so anything fancier gets word-split on the device. ``run-as``/``su``
    exec the plain ``ls`` directly, which is safe."""
    if su:
        return ["-s", serial, "shell", "su", "-c", "ls", "-1", DB_HOME.format(pkg=package)]
    return ["-s", serial, "shell", "run-as", package, "ls", "-1", "databases/"]


def cat_db_args(serial: str, package: str, name: str, *, su: bool = False) -> list[str]:
    """adb args to stream one database file to stdout (binary-clean via exec-out)."""
    if su:
        return ["-s", serial, "exec-out", "su", "-c", "cat",
                f"{DB_HOME.format(pkg=package)}/{name}"]
    return ["-s", serial, "exec-out", "run-as", package, "cat", f"databases/{name}"]


# --- listing / sqlite helpers (Qt-free → unit-testable) -----------------------
def db_candidates(names: list[str]) -> list[str]:
    """From a ``databases/`` listing, the base DB files — drop WAL/SHM/journal
    sidecars and lock files (kept case-insensitively, extension-agnostic: Room
    DBs often have no ``.db`` suffix)."""
    out = []
    for n in names:
        n = n.strip()
        if not n or n.endswith(SIDECAR_SUFFIXES) or n.endswith("-lock") or n.endswith(".lock"):
            continue
        out.append(n)
    return sorted(out, key=str.lower)


def classify_listing(returncode: int, stdout: str, stderr: str):
    """Turn a ``run-as ls`` result into ``(dbs, error)``.

    ``error`` is None on success (``dbs`` may be empty = no databases yet);
    otherwise ``dbs`` is None and ``error`` explains why (blocked / other)."""
    if returncode == 0:
        return db_candidates(stdout.splitlines()), None
    low = (stderr or "").lower()
    if "no such file" in low or "not found" in low:
        return [], None                                   # accessible, no databases/ dir
    if any(m in low for m in _RUNAS_BLOCKED):
        return None, "blocked"
    return None, (stderr.strip() or "couldn't list databases")


def is_sqlite_file(path: str) -> bool:
    try:
        with open(path, "rb") as fh:
            return fh.read(16) == SQLITE_MAGIC
    except OSError:
        return False


def _quote_ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def open_readonly(path: str) -> sqlite3.Connection:
    """Open a pulled snapshot for reading. ``query_only`` guarantees even the
    local copy is never mutated (writes raise), while still reading WAL frames
    from the pulled ``-wal`` sidecar."""
    con = sqlite3.connect(path)
    con.text_factory = bytes                      # decode ourselves (tolerate bad UTF-8)
    con.execute("PRAGMA query_only = ON")
    return con


def list_tables(con: sqlite3.Connection) -> list[tuple[str, str, int]]:
    """``(name, type, row_count)`` for every user table & view (tables first)."""
    rows = con.execute(
        "SELECT name, type FROM sqlite_master "
        "WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' "
        "ORDER BY type DESC, name COLLATE NOCASE").fetchall()
    out = []
    for name, typ in rows:
        name = name.decode("utf-8", "replace") if isinstance(name, bytes) else name
        typ = typ.decode("utf-8", "replace") if isinstance(typ, bytes) else typ
        try:
            n = con.execute(f"SELECT COUNT(*) FROM {_quote_ident(name)}").fetchone()[0]
        except sqlite3.Error:
            n = -1                                # e.g. a view over a missing table
        out.append((name, typ, int(n)))
    return out


def _decode_names(cursor) -> list[str]:
    return [d[0] for d in cursor.description] if cursor.description else []


def read_table(con: sqlite3.Connection, table: str, limit: int, offset: int):
    """One page of a table → ``(columns, rows, total_row_count, rowids)``.

    ``rowids`` (parallel to ``rows``) is the per-row rowid used to target edits;
    it's ``None`` for a WITHOUT ROWID table / view (which then can't be edited)."""
    q = _quote_ident(table)
    rowids = None
    try:
        cur = con.execute(f"SELECT _rowid_ AS __rid__, * FROM {q} LIMIT ? OFFSET ?", (limit, offset))
        allc = _decode_names(cur)
        raw = cur.fetchall()
        rowids = [r[0] for r in raw]
        cols = allc[1:]
        rows = [r[1:] for r in raw]
    except sqlite3.OperationalError:
        cur = con.execute(f"SELECT * FROM {q} LIMIT ? OFFSET ?", (limit, offset))
        cols = _decode_names(cur)
        rows = cur.fetchall()
    total = con.execute(f"SELECT COUNT(*) FROM {q}").fetchone()[0]
    return cols, rows, int(total), rowids


def run_query(con: sqlite3.Connection, sql: str, cap: int = QUERY_ROW_CAP):
    """Run a read-only query → ``(columns, rows, truncated)``. Writes raise
    ``sqlite3.OperationalError`` (query_only) which the caller surfaces."""
    cur = con.execute(sql)
    cols = _decode_names(cur)
    rows = cur.fetchmany(cap + 1)
    truncated = len(rows) > cap
    return cols, rows[:cap], truncated


def cell_text(value) -> str:
    """Human display for one cell (bytes are decoded if UTF-8, else summarized)."""
    if value is None:
        return "NULL"
    if isinstance(value, bytes):
        try:
            return value.decode("utf-8")
        except UnicodeDecodeError:
            return f"‹{len(value)} bytes blob›"
    return str(value)


def clipboard_value(value) -> str:
    """Text to put on the clipboard for a cell — the real value (empty for NULL,
    decoded text for UTF-8 bytes, hex for a binary blob)."""
    if value is None:
        return ""
    if isinstance(value, bytes):
        try:
            return value.decode("utf-8")
        except UnicodeDecodeError:
            return value.hex()
    return str(value)


def is_blob(value) -> bool:
    """A binary (non-UTF-8) blob — not safely editable as text."""
    if not isinstance(value, bytes):
        return False
    try:
        value.decode("utf-8")
        return False
    except UnicodeDecodeError:
        return True


# --- editing (writes go through sqlite3 ON THE DEVICE, never file-replacement) --
def sql_literal(value, set_null: bool = False) -> str:
    """A SQL literal for ``value``. Text is single-quoted with quotes doubled
    (injection-safe); numbers pass through; ``None``/``set_null`` → ``NULL``."""
    if set_null or value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return repr(value)
    if isinstance(value, bytes):
        return "X'" + value.hex() + "'"
    return "'" + str(value).replace("'", "''") + "'"


def build_update_sql(table: str, col: str, rowid: int, value, set_null: bool = False) -> str:
    """``UPDATE … SET col=<literal> WHERE _rowid_=<rowid>`` — ``_rowid_`` always
    targets the row's rowid even if a user column is named ``rowid``."""
    return (f"UPDATE {_quote_ident(table)} SET {_quote_ident(col)}="
            f"{sql_literal(value, set_null)} WHERE _rowid_={int(rowid)};")


def apply_local_update(path, table, col, rowid, value, set_null=False) -> None:
    """Mirror an edit onto the local snapshot (a writable connection) so the view
    matches the device without a re-pull."""
    con = sqlite3.connect(path)
    try:
        con.execute(build_update_sql(table, col, int(rowid), value, set_null))
        con.commit()
    finally:
        con.close()


def sqlite3_probe_args(serial: str) -> list[str]:
    """adb args to check whether the device has an ``sqlite3`` binary."""
    return ["-s", serial, "shell", "command", "-v", "sqlite3"]


def edit_args(serial: str, package: str, db: str, *, su: bool = False) -> list[str]:
    """adb args to run the on-device ``sqlite3`` against one database; the SQL is
    fed on **stdin** (so no command-line quoting can break it)."""
    if su:
        return ["-s", serial, "shell", "su", "-c", "sqlite3",
                f"{DB_HOME.format(pkg=package)}/{db}"]
    return ["-s", serial, "shell", "run-as", package, "sqlite3", f"databases/{db}"]


# --- workers ------------------------------------------------------------------
class DbListWorker(QThread):
    """List the selected app's databases (run-as, with a rooted ``su`` fallback),
    and probe for an on-device ``sqlite3`` binary (needed to edit values)."""

    done = pyqtSignal(bool, list, str, bool, bool)  # ok, [dbs], message, used_su, has_sqlite3

    def __init__(self, adb, serial, package, parent=None):
        super().__init__(parent)
        self._adb = adb
        self._serial = serial
        self._pkg = package

    def _run(self, su: bool):
        try:
            r = subprocess.run([self._adb, *list_dbs_args(self._serial, self._pkg, su=su)],
                               capture_output=True, text=True, timeout=15)
        except (subprocess.SubprocessError, OSError) as exc:
            return None, str(exc)
        return classify_listing(r.returncode, r.stdout, r.stderr)

    def _has_sqlite3(self) -> bool:
        try:
            r = subprocess.run([self._adb, *sqlite3_probe_args(self._serial)],
                               capture_output=True, text=True, timeout=8)
        except (subprocess.SubprocessError, OSError):
            return False
        return r.returncode == 0 and "sqlite3" in r.stdout

    def run(self):
        dbs, err = self._run(su=False)
        if err == "blocked":                      # not debuggable → try root
            dbs_su, err_su = self._run(su=True)
            if dbs_su is not None:
                self.done.emit(True, dbs_su, f"{len(dbs_su)} database(s) via su", True,
                               self._has_sqlite3())
                return
            self.done.emit(
                False, [],
                f"'{self._pkg}' is not debuggable and the device isn't rooted — its "
                "databases can't be read. Use a debuggable build or a rooted device/emulator.",
                False, False)
            return
        if dbs is None:
            self.done.emit(False, [], f"Couldn't list databases: {err}", False, False)
            return
        msg = (f"{len(dbs)} database(s)" if dbs else "No databases found for this app")
        self.done.emit(True, dbs, msg, False, self._has_sqlite3())


class DbOpenWorker(QThread):
    """Pull one database (+ WAL/SHM/journal sidecars) and introspect its tables."""

    done = pyqtSignal(bool, str, str, list, str)  # ok, db_name, local_path, tables, message

    def __init__(self, adb, serial, package, db_name, dest_dir, su, parent=None):
        super().__init__(parent)
        self._adb = adb
        self._serial = serial
        self._pkg = package
        self._name = db_name
        self._dest = dest_dir
        self._su = su

    def _pull(self, name: str, dest: str) -> bool:
        """Stream one remote file to ``dest``; True if we got non-empty bytes."""
        try:
            with open(dest, "wb") as out:
                r = subprocess.run(
                    [self._adb, *cat_db_args(self._serial, self._pkg, name, su=self._su)],
                    stdout=out, stderr=subprocess.PIPE, timeout=180)
        except (subprocess.SubprocessError, OSError):
            return False
        if r.returncode != 0 or os.path.getsize(dest) == 0:
            try:
                os.remove(dest)                   # drop empty/failed (e.g. missing sidecar)
            except OSError:
                pass
            return False
        return True

    def run(self):
        local = os.path.join(self._dest, self._name)
        if not self._pull(self._name, local):
            self.done.emit(False, self._name, "", [], f"Couldn't read '{self._name}' from device")
            return
        # WAL/SHM/journal alongside the main file → sqlite reads current data.
        for suf in SIDECAR_SUFFIXES:
            self._pull(self._name + suf, local + suf)
        if not is_sqlite_file(local):
            self.done.emit(False, self._name, local, [], f"'{self._name}' is not a SQLite database")
            return
        try:
            con = open_readonly(local)
            try:
                tables = list_tables(con)
            finally:
                con.close()
        except sqlite3.Error as exc:
            self.done.emit(False, self._name, local, [], f"Couldn't open '{self._name}': {exc}")
            return
        self.done.emit(True, self._name, local, tables, f"{self._name}: {len(tables)} table(s)")


class QueryWorker(QThread):
    """Read a table page or run a free-form query against a local snapshot.

    Opens its own sqlite connection (connections are thread-affine) and closes
    it before returning."""

    # ok, cols, rows, total, truncated, msg, rowids
    done = pyqtSignal(bool, list, list, int, bool, str, object)

    def __init__(self, path, *, table=None, sql=None, limit=PAGE_SIZE, offset=0, parent=None):
        super().__init__(parent)
        self._path = path
        self._table = table
        self._sql = sql
        self._limit = limit
        self._offset = offset
        self.seq = 0            # set by the view for latest-wins dispatch
        self.ctx = None         # opaque context echoed back to the handler

    def run(self):
        try:
            con = open_readonly(self._path)
        except sqlite3.Error as exc:
            self.done.emit(False, [], [], -1, False, str(exc), None)
            return
        try:
            if self._table is not None:
                cols, rows, total, rowids = read_table(con, self._table, self._limit, self._offset)
                self.done.emit(True, cols, rows, total, False, "", rowids)
            else:
                cols, rows, truncated = run_query(con, self._sql)
                self.done.emit(True, cols, rows, -1, truncated, "", None)
        except sqlite3.Error as exc:
            self.done.emit(False, [], [], -1, False, str(exc), None)
        finally:
            con.close()


class EditWorker(QThread):
    """Apply one cell edit to the **live device database** via on-device
    ``sqlite3`` (SQL fed on stdin). Never replaces the DB file — sqlite3 handles
    WAL/locking correctly. The row is targeted by rowid."""

    done = pyqtSignal(bool, str)                  # ok, message

    def __init__(self, adb, serial, package, db, table, col, rowid, value,
                 set_null, su, *, row=-1, col_index=-1, path="", parent=None):
        super().__init__(parent)
        self._adb = adb
        self._serial = serial
        self._pkg = package
        self._db = db
        # echoed back so the handler can mirror the change locally:
        self.table = table
        self.col = col
        self.rowid = rowid
        self.value = value
        self.set_null = set_null
        self._su = su
        self.row = row
        self.col_index = col_index
        self.path = path

    def run(self):
        sql = ("PRAGMA busy_timeout=3000;\n"
               + build_update_sql(self.table, self.col, self.rowid, self.value, self.set_null)
               + "\nSELECT changes();\n")
        try:
            r = subprocess.run([self._adb, *edit_args(self._serial, self._pkg, self._db, su=self._su)],
                               input=sql, text=True, capture_output=True, timeout=20)
        except (subprocess.SubprocessError, OSError) as exc:
            self.done.emit(False, str(exc))
            return
        err = (r.stderr or "").strip()
        low = err.lower()
        if "sqlite3" in low and ("not found" in low or "no such file" in low or "exec failed" in low):
            self.done.emit(False, "the device has no 'sqlite3' binary — editing needs an emulator, "
                                  "a rooted device, or a userdebug build")
            return
        if r.returncode != 0 or "error" in low:
            self.done.emit(False, err or f"sqlite3 exited with code {r.returncode}")
            return
        changed = 0
        for line in reversed((r.stdout or "").splitlines()):
            line = line.strip()
            if line.isdigit():
                changed = int(line)
                break
        if changed >= 1:
            self.done.emit(True, "1 row updated on the device")
        else:
            self.done.emit(False, "no row matched (it may have changed) — Refresh and retry")


class DbExportWorker(QThread):
    """Export a pulled snapshot as a **self-contained** ``.db`` file. Uses
    sqlite's backup API so WAL content is folded in — the result is one portable
    file with no ``-wal``/``-shm`` sidecars."""

    done = pyqtSignal(bool, str, str)             # ok, message, directory

    def __init__(self, src_path, dest_path, parent=None):
        super().__init__(parent)
        self._src = src_path
        self._dest = dest_path

    def run(self):
        try:
            src = sqlite3.connect(self._src)
            dst = sqlite3.connect(self._dest)
            try:
                with dst:
                    src.backup(dst)              # consolidates main db + WAL into one file
            finally:
                dst.close()
                src.close()
        except (sqlite3.Error, OSError) as exc:
            self.done.emit(False, f"Export failed: {exc}", "")
            return
        try:
            size = os.path.getsize(self._dest)
        except OSError:
            size = 0
        self.done.emit(True, f"Exported {os.path.basename(self._dest)} ({size / 1024:.0f} KB)",
                       os.path.dirname(self._dest))


# --- results model ------------------------------------------------------------
_C_TEXT = QColor(TEXT)
_C_DIM = QColor(TEXT_DIM)


class SqlResultModel(QAbstractTableModel):
    """A page of query/table results: column names + a list of value tuples."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self._cols: list[str] = []
        self._rows: list[tuple] = []
        self._offset = 0        # absolute index of the first row (for the row-number gutter)

    def set_result(self, cols, rows, offset=0):
        self.beginResetModel()
        self._cols = list(cols)
        self._rows = [list(r) for r in rows]      # mutable so edits can update in place
        self._offset = offset
        self.endResetModel()

    def clear(self):
        self.set_result([], [], 0)

    def set_cell(self, row, col, value):
        if 0 <= row < len(self._rows) and 0 <= col < len(self._cols):
            self._rows[row][col] = value
            idx = self.index(row, col)
            self.dataChanged.emit(idx, idx)

    def value_at(self, row, col):
        if 0 <= row < len(self._rows) and 0 <= col < len(self._cols):
            return self._rows[row][col]
        return None

    @property
    def columns(self):
        return self._cols

    @property
    def rows(self):
        return self._rows

    def rowCount(self, parent=QModelIndex()) -> int:
        return 0 if parent.isValid() else len(self._rows)

    def columnCount(self, parent=QModelIndex()) -> int:
        return 0 if parent.isValid() else len(self._cols)

    def headerData(self, section, orientation, role=Qt.ItemDataRole.DisplayRole):
        if role != Qt.ItemDataRole.DisplayRole:
            return None
        if orientation == Qt.Orientation.Horizontal:
            return self._cols[section] if 0 <= section < len(self._cols) else None
        return str(self._offset + section + 1)          # 1-based absolute row number

    def data(self, index, role=Qt.ItemDataRole.DisplayRole):
        if not index.isValid():
            return None
        value = self._rows[index.row()][index.column()]
        if role == Qt.ItemDataRole.DisplayRole:
            return cell_text(value)
        if role == Qt.ItemDataRole.ForegroundRole:
            return _C_DIM if (value is None or isinstance(value, bytes)) else _C_TEXT
        if role == Qt.ItemDataRole.ToolTipRole and value is not None:
            return cell_text(value)
        return None


# --- the results table (Cmd+C copies selected cells as TSV) -------------------
class ResultTable(QTableView):
    def keyPressEvent(self, event):
        if event.matches(QKeySequence.StandardKey.Copy):
            self._copy_selection()
        else:
            super().keyPressEvent(event)

    def _copy_selection(self):
        sm = self.selectionModel()
        model = self.model()
        if sm is None or model is None:
            return
        idxs = sm.selectedIndexes()
        if not idxs:
            return
        rows = sorted({i.row() for i in idxs})
        cols = sorted({i.column() for i in idxs})
        lines = ["\t".join(str(model.index(r, c).data() or "") for c in cols) for r in rows]
        QGuiApplication.clipboard().setText("\n".join(lines))


def _icon_pixmap() -> QPixmap:
    pm = QPixmap(16, 16)
    pm.fill(Qt.GlobalColor.transparent)
    return pm


def make_db_icon(color: str) -> QIcon:
    """A small database cylinder, drawn in ``color`` (no image assets)."""
    pm = _icon_pixmap()
    p = QPainter(pm)
    p.setRenderHint(QPainter.RenderHint.Antialiasing, True)
    p.setPen(QPen(QColor(color), 1.3))
    p.setBrush(Qt.BrushStyle.NoBrush)
    p.drawEllipse(QRectF(2.5, 2.0, 11, 3.6))                 # lid
    p.drawLine(QPointF(2.5, 3.8), QPointF(2.5, 11.5))        # sides
    p.drawLine(QPointF(13.5, 3.8), QPointF(13.5, 11.5))
    p.drawArc(QRectF(2.5, 4.2, 11, 3.6), 0, -180 * 16)       # middle band
    p.drawArc(QRectF(2.5, 9.7, 11, 3.6), 0, -180 * 16)       # bottom
    p.end()
    return QIcon(pm)


def make_table_icon(color: str) -> QIcon:
    """A small grid/table glyph, drawn in ``color``."""
    pm = _icon_pixmap()
    p = QPainter(pm)
    p.setRenderHint(QPainter.RenderHint.Antialiasing, True)
    p.setPen(QPen(QColor(color), 1.2))
    p.setBrush(Qt.BrushStyle.NoBrush)
    p.drawRoundedRect(QRectF(2.5, 3.0, 11, 10), 1.5, 1.5)
    p.drawLine(QPointF(2.5, 6.2), QPointF(13.5, 6.2))        # header row
    p.drawLine(QPointF(2.5, 9.6), QPointF(13.5, 9.6))        # a body row
    p.drawLine(QPointF(6.6, 3.0), QPointF(6.6, 13.0))        # a column
    p.end()
    return QIcon(pm)


def _looks_json(text: str) -> bool:
    t = (text or "").strip()
    if not t or t[0] not in "{[":
        return False
    try:
        import json
        json.loads(t)
        return True
    except Exception:
        return False


class CellDialog(QDialog):
    """View a full cell value — and, when the cell is editable, change it and
    write the new value back to the **live device database**.

    Editing is offered only for a real table row (has a rowid), a non-blob value,
    and a device that has an ``sqlite3`` binary; otherwise this is a read-only
    viewer (Copy still works)."""

    def __init__(self, *, column, value, editable, reason="", on_save=None, parent=None):
        super().__init__(parent)
        self._value = value
        self._editable = editable
        self._on_save = on_save
        self.setWindowTitle(f"{column}")
        self.setMinimumSize(460, 320)
        self.setObjectName("DbCellDialog")

        v = QVBoxLayout(self)
        v.setContentsMargins(14, 12, 14, 12)
        v.setSpacing(8)

        kind = ("NULL" if value is None else
                "BLOB" if isinstance(value, bytes) else
                type(value).__name__)
        info = QLabel(f"<b>{column}</b> · {kind}")
        info.setTextFormat(Qt.TextFormat.RichText)
        v.addWidget(info)

        self.editor = QPlainTextEdit()
        mono = QFont("SF Mono")
        mono.setStyleHint(QFont.StyleHint.Monospace)
        mono.setPointSize(12)
        self.editor.setFont(mono)
        shown = cell_text(value)
        if _looks_json(shown):
            try:
                import json
                shown = json.dumps(json.loads(shown), indent=2, ensure_ascii=False)
            except Exception:
                pass
        self.editor.setPlainText("" if value is None else shown)
        self.editor.setReadOnly(not editable)
        v.addWidget(self.editor, 1)

        self.null_cb = QCheckBox("Set NULL")
        self.null_cb.setEnabled(editable)
        self.null_cb.toggled.connect(lambda on: self.editor.setDisabled(on))
        if editable:
            v.addWidget(self.null_cb)
        elif reason:
            note = QLabel(reason)
            note.setWordWrap(True)
            note.setObjectName("DbStatus")
            v.addWidget(note)

        buttons = QDialogButtonBox()
        copy_btn = buttons.addButton("Copy", QDialogButtonBox.ButtonRole.ActionRole)
        copy_btn.clicked.connect(self._copy)
        if editable:
            self.save_btn = buttons.addButton("Save to device",
                                              QDialogButtonBox.ButtonRole.AcceptRole)
            self.save_btn.clicked.connect(self._save)
        buttons.addButton(QDialogButtonBox.StandardButton.Close).clicked.connect(self.reject)
        v.addWidget(buttons)

    def _copy(self):
        QGuiApplication.clipboard().setText(clipboard_value(self._value))

    def _save(self):
        set_null = self.null_cb.isChecked()
        new_text = None if set_null else self.editor.toPlainText()
        self._on_save(new_text, set_null)
        self.accept()


# --- the tab widget -----------------------------------------------------------
class DatabaseView(QWidget):
    """Schema tree (databases → tables) + a results table with paging and a
    read-only SQL box. Self-contained: needs only ``adb`` + a serial + package."""

    status = pyqtSignal(str)                       # transient status-bar text
    failed = pyqtSignal(str)                       # error → status bar + dialog
    saved = pyqtSignal(bool, str, str)            # CSV export: ok, message, directory

    def __init__(self, adb: str, parent=None):
        super().__init__(parent)
        self.adb = adb or ""
        self._serial: str | None = None
        self._package: str | None = None
        self._loaded_key = None                   # (serial, pkg) last listed
        self._listing_key = None                  # (serial, pkg) the running list worker is for
        self._pending_list = False                # app/device changed mid-listing → relist
        self._su = False                          # databases reached via su (rooted)
        self._tmp = tempfile.mkdtemp(prefix="logcatviewer-db-")
        self._db_paths: dict[str, str] = {}       # db name → local snapshot path
        self._db_items: dict[str, QTreeWidgetItem] = {}
        self._cur_db: str | None = None           # db backing the results / query box
        self._cur_table: str | None = None
        self._offset = 0
        self._total = 0
        self._rowids = None                       # per-visible-row rowid (None = not editable)
        self._can_edit_device = False             # device has an sqlite3 binary
        self._query_seq = 0                       # latest-wins guard for QueryWorker
        self._workers: set[QThread] = set()       # keep refs alive
        self._list_worker: DbListWorker | None = None
        self._open_worker: DbOpenWorker | None = None
        self._edit_worker: EditWorker | None = None
        self._export_worker: DbExportWorker | None = None
        # schema-tree icons (connected DB is tinted green, disconnected is dim)
        self._icon_db_on = make_db_icon(GREEN)
        self._icon_db_off = make_db_icon(TEXT_DIM)
        self._icon_table = make_table_icon(TEXT_DIM)
        self._icon_view = make_table_icon(ACCENT)
        self._build_ui()

    # --- construction ------------------------------------------------------
    def _build_ui(self):
        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)

        # Top control bar (shared device/app come from the main toolbar above).
        bar = QWidget()
        bar.setObjectName("DbBar")
        h = QHBoxLayout(bar)
        h.setContentsMargins(12, 8, 12, 8)
        h.setSpacing(8)
        self.app_label = QLabel("Select an app in the App box above to inspect its databases")
        self.app_label.setObjectName("DbApp")
        self.refresh_btn = QPushButton("⟳  Refresh")
        self.refresh_btn.setObjectName("toggle")
        self.refresh_btn.setToolTip("Re-list the app's databases and re-pull a fresh snapshot")
        h.addWidget(self.app_label, 1)
        h.addWidget(self.refresh_btn)
        root.addWidget(bar)

        split = QSplitter(Qt.Orientation.Horizontal)

        # Left: a filter box + schema tree (databases → tables).
        left = QWidget()
        lv = QVBoxLayout(left)
        lv.setContentsMargins(0, 0, 0, 0)
        lv.setSpacing(0)
        search_bar = QWidget()
        search_bar.setObjectName("DbSearchBar")
        sh = QHBoxLayout(search_bar)
        sh.setContentsMargins(8, 6, 8, 6)
        self.search_edit = QLineEdit()
        self.search_edit.setObjectName("DbSearch")
        self.search_edit.setPlaceholderText("Filter databases & tables…")
        self.search_edit.setClearButtonEnabled(True)
        sh.addWidget(self.search_edit)
        lv.addWidget(search_bar)

        self.tree_busy = self._make_busy()        # loader shown while listing / connecting
        lv.addWidget(self.tree_busy)

        self.tree = QTreeWidget()
        self.tree.setObjectName("DbTree")
        self.tree.setHeaderLabel("Databases")
        self.tree.setMinimumWidth(220)
        self.tree.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.tree.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self.tree.customContextMenuRequested.connect(self._show_tree_menu)
        lv.addWidget(self.tree, 1)
        split.addWidget(left)

        # Right: query box + results table + paging bar.
        right = QWidget()
        rv = QVBoxLayout(right)
        rv.setContentsMargins(0, 0, 0, 0)
        rv.setSpacing(0)

        qbar = QWidget()
        qbar.setObjectName("DbQueryBar")
        qh = QHBoxLayout(qbar)
        qh.setContentsMargins(10, 7, 10, 7)
        qh.setSpacing(8)
        self.query_edit = QLineEdit()
        self.query_edit.setPlaceholderText("SELECT * FROM …   (read-only, runs on a local snapshot)")
        self.query_edit.setEnabled(False)
        self.run_btn = QPushButton("Run")
        self.run_btn.setObjectName("start")
        self.run_btn.setEnabled(False)
        self.export_btn = QPushButton("Export CSV")
        self.export_btn.setObjectName("toggle")
        self.export_btn.setEnabled(False)
        self.export_btn.setToolTip("Save the current results as a CSV file")
        qh.addWidget(self.query_edit, 1)
        qh.addWidget(self.run_btn)
        qh.addWidget(self.export_btn)
        rv.addWidget(qbar)

        self.results_busy = self._make_busy()     # loader shown while a query runs
        rv.addWidget(self.results_busy)

        self.table = ResultTable()
        self.model = SqlResultModel()
        self.table.setModel(self.model)
        self.table.setObjectName("DbTable")
        self.table.setAlternatingRowColors(False)
        self.table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectItems)
        self.table.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)
        self.table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.table.setHorizontalScrollMode(QAbstractItemView.ScrollMode.ScrollPerPixel)
        self.table.setFrameShape(QAbstractItemView.Shape.NoFrame)
        self.table.setWordWrap(False)
        self.table.setTextElideMode(Qt.TextElideMode.ElideRight)
        self.table.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self.table.customContextMenuRequested.connect(self._show_cell_menu)
        self.table.doubleClicked.connect(self._open_cell_dialog)
        self.table.verticalHeader().setDefaultSectionSize(24)
        hdr = self.table.horizontalHeader()
        hdr.setHighlightSections(False)
        hdr.setSectionResizeMode(QHeaderView.ResizeMode.Interactive)
        self._mono = QFont("SF Mono")
        self._mono.setStyleHint(QFont.StyleHint.Monospace)
        self._mono.setPointSize(12)
        self.table.setFont(self._mono)
        rv.addWidget(self.table, 1)

        pbar = QWidget()
        pbar.setObjectName("DbPageBar")
        ph = QHBoxLayout(pbar)
        ph.setContentsMargins(10, 6, 10, 6)
        ph.setSpacing(8)
        self.prev_btn = QPushButton("◀ Prev")
        self.prev_btn.setObjectName("toggle")
        self.next_btn = QPushButton("Next ▶")
        self.next_btn.setObjectName("toggle")
        self.prev_btn.setEnabled(False)
        self.next_btn.setEnabled(False)
        self.page_label = QLabel("")
        self.page_label.setObjectName("DbStatus")
        ph.addWidget(self.prev_btn)
        ph.addWidget(self.next_btn)
        ph.addWidget(self.page_label, 1)
        rv.addWidget(pbar)

        split.addWidget(right)
        split.setStretchFactor(0, 0)
        split.setStretchFactor(1, 1)
        split.setSizes([260, 720])
        root.addWidget(split, 1)

        self.refresh_btn.clicked.connect(self.refresh)
        self.search_edit.textChanged.connect(self._filter_tree)
        self.tree.itemClicked.connect(self._on_tree_clicked)
        self.run_btn.clicked.connect(self._run_query)
        self.query_edit.returnPressed.connect(self._run_query)
        self.export_btn.clicked.connect(self._export_csv)
        self.prev_btn.clicked.connect(lambda: self._page(-1))
        self.next_btn.clicked.connect(lambda: self._page(+1))

    @staticmethod
    def _make_busy() -> QProgressBar:
        """A thin indeterminate progress bar used as a loading indicator."""
        bar = QProgressBar()
        bar.setObjectName("DbBusy")
        bar.setRange(0, 0)                        # 0..0 = animated 'busy' mode
        bar.setTextVisible(False)
        bar.setFixedHeight(3)
        bar.hide()
        return bar

    def _update_tree_busy(self):
        """Show the schema loader while databases are being listed or connected."""
        self.tree_busy.setVisible(self._list_worker is not None or self._open_worker is not None)

    # --- device / app context ---------------------------------------------
    def set_serial(self, serial: str | None):
        if serial != self._serial:
            self._serial = serial
            self._maybe_reload()

    def set_package(self, package: str | None):
        if package != self._package:
            self._package = package or None
            self.app_label.setText(
                f"App:  {self._package}" if self._package
                else "Select an app in the App box above to inspect its databases")
            self._maybe_reload()

    def showEvent(self, event):
        super().showEvent(event)
        self._maybe_reload()

    def _maybe_reload(self):
        """Lazily (re)list databases when the tab is visible and the app/device
        changed — nothing touches adb until the user actually opens this tab."""
        if not self.isVisible():
            return
        key = (self._serial, self._package)
        if key == self._loaded_key:
            return
        if not self.adb or not self._serial or not self._package:
            self._loaded_key = key
            self._reset_all()
            return
        self._loaded_key = key
        self._load_dbs()

    def refresh(self):
        self._loaded_key = None
        self._db_paths.clear()                    # force fresh snapshots
        self._maybe_reload()

    # --- listing databases -------------------------------------------------
    def _load_dbs(self):
        if not self.adb or not self._serial or not self._package:
            return
        if self._list_worker is not None:
            self._pending_list = True             # relist for the current app when this finishes
            return
        self._pending_list = False
        self._reset_all()
        self._listing_key = (self._serial, self._package)
        self._status(f"Listing databases for {self._package}…")
        w = DbListWorker(self.adb, self._serial, self._package)
        w.done.connect(self._on_dbs_listed)
        self._list_worker = w
        w.start()
        self._update_tree_busy()

    def _on_dbs_listed(self, ok, dbs, message, used_su, has_sqlite3):
        self._list_worker = None
        # If the app/device changed while we were listing, the results are stale:
        # redo for the app that's selected now (or just drop them if none is).
        if self._pending_list or (self._serial, self._package) != self._listing_key:
            self._pending_list = False
            if self.adb and self._serial and self._package:
                self._load_dbs()
            else:
                self._update_tree_busy()
            return
        self._su = used_su
        self._can_edit_device = bool(has_sqlite3)
        if not ok:
            self._status(message)
            self.failed.emit(message)
            self._update_tree_busy()
            return
        self.tree.clear()
        self._db_items.clear()
        for name in dbs:
            item = QTreeWidgetItem([name])
            item.setData(0, Qt.ItemDataRole.UserRole, ("db", name))
            item.setToolTip(0, name)
            self._mark_db_connected(item, False)  # disconnected until opened
            self.tree.addTopLevelItem(item)
            self._db_items[name] = item
        self._status(message)
        self._filter_tree(self.search_edit.text())
        if dbs:                                   # auto-connect the first DB so the tab isn't empty
            self._open_db(dbs[0], auto_select=True)
        self._update_tree_busy()

    # --- opening a database (pull + introspect) ----------------------------
    def _open_db(self, name, auto_select=False, export_dest=None):
        if not self.adb or not self._serial or not self._package:
            return
        item = self._db_items.get(name)
        if name in self._db_paths and item is not None and item.childCount() > 0:
            item.setExpanded(True)               # already open
            if auto_select:
                self._select_first_table(item)
            if export_dest:
                self._start_export(self._db_paths[name], export_dest)
            return
        if self._open_worker is not None:
            self._status("Opening another database…")
            return
        self._status(f"Opening {name}…")
        w = DbOpenWorker(self.adb, self._serial, self._package, name, self._tmp, self._su)
        w._auto_select = auto_select             # remembered for the handler
        w._export_dest = export_dest             # export once pulled (if requested)
        w.done.connect(self._on_db_opened)
        self._open_worker = w
        w.start()
        self._update_tree_busy()

    def _on_db_opened(self, ok, name, path, tables, message):
        auto_select = getattr(self._open_worker, "_auto_select", False)
        export_dest = getattr(self._open_worker, "_export_dest", None)
        self._open_worker = None
        self._update_tree_busy()
        if not ok:
            self._status(message)
            self.failed.emit(message)
            return
        self._db_paths[name] = path
        item = self._db_items.get(name)
        if item is None:
            return
        item.takeChildren()
        for tname, ttype, count in tables:
            label = f"{tname}   ({count if count >= 0 else '—'})"
            if ttype == "view":
                label = f"{tname}   (view)"
            child = QTreeWidgetItem([label])
            child.setData(0, Qt.ItemDataRole.UserRole, ("table", name, tname, count))
            child.setForeground(0, QColor(TEXT_DIM))
            child.setIcon(0, self._icon_view if ttype == "view" else self._icon_table)
            child.setToolTip(0, f"{tname}  ·  {ttype}")
            item.addChild(child)
        self._mark_db_connected(item, True)       # connected: green cylinder + bright label
        item.setExpanded(True)
        self._status(message)
        self._filter_tree(self.search_edit.text())
        if auto_select:
            self._select_first_table(item)
        if export_dest:
            self._start_export(path, export_dest)

    # --- connection state / schema-tree helpers ----------------------------
    def _mark_db_connected(self, item, connected):
        item.setIcon(0, self._icon_db_on if connected else self._icon_db_off)
        item.setForeground(0, QColor(TEXT if connected else TEXT_DIM))

    def _disconnect_db(self, name, silent=False):
        """Drop a database's snapshot: clear its tables, remove the local files,
        and mark it disconnected. Results from it are cleared too."""
        if self._cur_db == name:
            self._cur_db = self._cur_table = None
            self._rowids = None
            self.model.clear()
            self.query_edit.clear()
            self.query_edit.setEnabled(False)
            self.run_btn.setEnabled(False)
            self.export_btn.setEnabled(False)
            self.prev_btn.setEnabled(False)
            self.next_btn.setEnabled(False)
            self.page_label.clear()
        path = self._db_paths.pop(name, None)
        if path:
            for suf in ("",) + SIDECAR_SUFFIXES:
                try:
                    os.remove(path + suf)
                except OSError:
                    pass
        item = self._db_items.get(name)
        if item is not None:
            item.takeChildren()
            item.setExpanded(False)
            self._mark_db_connected(item, False)
        if not silent:
            self._status(f"Disconnected {name}")

    def _filter_tree(self, text):
        """Show only databases/tables whose name matches; keep a DB visible when
        one of its (loaded) tables matches, and reveal the matches."""
        q = (text or "").strip().lower()
        for i in range(self.tree.topLevelItemCount()):
            db_item = self.tree.topLevelItem(i)
            role = db_item.data(0, Qt.ItemDataRole.UserRole)
            db_name = (role[1] if role else db_item.text(0)).lower()
            db_match = (not q) or (q in db_name)
            any_child = False
            for j in range(db_item.childCount()):
                child = db_item.child(j)
                crole = child.data(0, Qt.ItemDataRole.UserRole)
                tname = (crole[2] if crole and len(crole) > 2 else child.text(0)).lower()
                child_match = db_match or (q in tname)
                child.setHidden(not child_match)
                any_child = any_child or (q and q in tname)
            db_item.setHidden(not (db_match or any_child))
            if q and (db_match or any_child):
                db_item.setExpanded(True)

    # --- right-click schema tree: connect / disconnect / export ------------
    def _show_tree_menu(self, pos):
        item = self.tree.itemAt(pos)
        if item is None:
            return
        role = item.data(0, Qt.ItemDataRole.UserRole)
        if not role:
            return
        db = role[1]                              # ("db", name) or ("table", db, ...)
        connected = db in self._db_paths
        menu = QMenu(self)
        act = {}
        if role[0] == "db":
            if connected:
                act["disc"] = menu.addAction("Disconnect")
                act["reconn"] = menu.addAction("Reconnect (fresh snapshot)")
            else:
                act["conn"] = menu.addAction("Connect")
        else:                                     # a table node
            act["browse"] = menu.addAction("Browse")
        menu.addSeparator()
        act["export"] = menu.addAction("Export database as .db file…")
        chosen = menu.exec(self.tree.viewport().mapToGlobal(pos))
        if chosen is None:
            return
        if chosen is act.get("conn"):
            self._open_db(db, auto_select=True)
        elif chosen is act.get("disc"):
            self._disconnect_db(db)
        elif chosen is act.get("reconn"):
            self._disconnect_db(db, silent=True)
            self._open_db(db, auto_select=True)
        elif chosen is act.get("browse"):
            self._browse_table(role[1], role[2], 0)
        elif chosen is act.get("export"):
            self._export_db(db)

    def _export_db(self, name):
        if self._export_worker is not None:
            self._status("An export is already running…")
            return
        default_dir = os.path.expanduser("~/Downloads")
        if not os.path.isdir(default_dir):
            default_dir = os.path.expanduser("~")
        suggested = name if name.lower().endswith(".db") else f"{name}.db"
        dest, _ = QFileDialog.getSaveFileName(
            self, f"Export '{name}' as a .db file", os.path.join(default_dir, suggested),
            "SQLite database (*.db);;All files (*)")
        if not dest:
            return
        path = self._db_paths.get(name)
        if path is not None:
            self._start_export(path, dest)        # already pulled
        else:
            self._open_db(name, export_dest=dest)  # pull first, then export

    def _start_export(self, src_path, dest_path):
        if self._export_worker is not None:
            return
        self._status(f"Exporting {os.path.basename(dest_path)}…")
        w = DbExportWorker(src_path, dest_path)
        w.done.connect(self._on_export_done)
        self._export_worker = w
        w.start()

    def _on_export_done(self, ok, message, directory):
        self._export_worker = None
        self._status(("✓ " if ok else "✗ ") + message)
        self.saved.emit(ok, message, directory)

    def _select_first_table(self, db_item):
        """Auto-select a sensible table so the tab opens showing data: prefer a
        non-empty, non-``android_metadata`` table, then any non-metadata table,
        then whatever's there."""
        best, best_score = None, None
        for i in range(db_item.childCount()):
            child = db_item.child(i)
            role = child.data(0, Qt.ItemDataRole.UserRole)
            if not role or role[0] != "table":
                continue
            name = role[2]
            count = role[3] if len(role) > 3 else -1
            score = (name != "android_metadata", count > 0)   # non-metadata, then non-empty
            if best is None or score > best_score:
                best, best_score = child, score
        if best is not None:
            self.tree.setCurrentItem(best)
            role = best.data(0, Qt.ItemDataRole.UserRole)
            self._browse_table(role[1], role[2], 0)

    # --- tree interaction --------------------------------------------------
    def _on_tree_clicked(self, item, _col=0):
        role = item.data(0, Qt.ItemDataRole.UserRole)
        if not role:
            return
        if role[0] == "db":
            self._open_db(role[1])
        elif role[0] == "table":
            self._browse_table(role[1], role[2], 0)

    # --- browsing a table / running a query --------------------------------
    def _browse_table(self, db, table, offset):
        path = self._db_paths.get(db)
        if path is None:
            return
        self._cur_db, self._cur_table, self._offset = db, table, offset
        self.query_edit.setEnabled(True)
        self.run_btn.setEnabled(True)
        self.query_edit.setText(f"SELECT * FROM {_quote_ident(table)}")
        self._dispatch(QueryWorker(path, table=table, limit=PAGE_SIZE, offset=offset),
                       ctx=("table", db, table, offset))

    def _run_query(self):
        sql = self.query_edit.text().strip()
        if not sql or self._cur_db is None:
            return
        path = self._db_paths.get(self._cur_db)
        if path is None:
            return
        self._cur_table = None                    # results are now a free query, not a table page
        self._dispatch(QueryWorker(path, sql=sql), ctx=("query",))

    def _dispatch(self, worker: QueryWorker, ctx):
        """Latest-wins: stale worker results (an older click/query still running)
        are ignored so the table always reflects the most recent request."""
        self._query_seq += 1
        worker.seq = self._query_seq
        worker.ctx = ctx
        worker.done.connect(self._on_query_done)
        worker.finished.connect(lambda w=worker: self._workers.discard(w))
        self._workers.add(worker)
        self._status("Running…")
        self.results_busy.show()
        worker.start()

    def _on_query_done(self, ok, cols, rows, total, truncated, message, rowids):
        worker = self.sender()
        if worker is None or worker.seq != self._query_seq:
            return                                # a newer request supersedes this one
        self.results_busy.hide()                  # the latest query finished
        if not ok:
            self._status(f"✗ {message}")
            self.failed.emit(f"Query failed: {message}")
            return
        ctx = worker.ctx
        offset = ctx[3] if ctx and ctx[0] == "table" else 0
        self._rowids = rowids                     # per-row rowid for edits (None = read-only)
        self.model.set_result(cols, rows, offset)
        self._fit_columns()
        self.export_btn.setEnabled(bool(cols))
        if ctx and ctx[0] == "table":
            self._total = total
            self._update_paging()
            first = offset + 1 if rows else 0
            self._status(f"{ctx[2]}: rows {first}–{offset + len(rows)} of {total:,}")
        else:
            self.prev_btn.setEnabled(False)
            self.next_btn.setEnabled(False)
            tail = " (truncated)" if truncated else ""
            self.page_label.setText(f"{len(rows):,} row(s){tail}")
            self._status(f"Query OK — {len(rows):,} row(s){tail}")

    def _page(self, direction):
        if self._cur_db is None or self._cur_table is None:
            return
        new = self._offset + direction * PAGE_SIZE
        if new < 0 or new >= self._total:
            return
        self._browse_table(self._cur_db, self._cur_table, new)

    def _update_paging(self):
        self.prev_btn.setEnabled(self._offset > 0)
        self.next_btn.setEnabled(self._offset + PAGE_SIZE < self._total)
        shown_end = min(self._offset + PAGE_SIZE, self._total)
        first = self._offset + 1 if self._total else 0
        self.page_label.setText(f"rows {first}–{shown_end} of {self._total:,}")

    # --- cell copy / view / edit -------------------------------------------
    def _cell_editable(self, row, col):
        """``(editable, reason)`` for one cell. Editable only for a real table
        row (rowid), a non-blob value, and a device with an ``sqlite3`` binary."""
        if self._cur_table is None or self._rowids is None:
            return False, "Editing is available when browsing a table, not a custom query."
        if not (0 <= row < len(self._rowids)) or self._rowids[row] is None:
            return False, "This row has no rowid, so it can't be targeted for editing."
        if not self._can_edit_device:
            return False, ("This device has no 'sqlite3' binary, so values can't be written "
                           "back. Editing works on an emulator, a rooted device, or a "
                           "userdebug build.")
        if is_blob(self.model.value_at(row, col)):
            return False, "Binary blob values can't be edited as text."
        return True, ""

    def _show_cell_menu(self, pos):
        idx = self.table.indexAt(pos)
        if not idx.isValid():
            return
        row, col = idx.row(), idx.column()
        menu = QMenu(self)
        act_copy = menu.addAction("Copy value")
        act_copy_row = menu.addAction("Copy row")
        menu.addSeparator()
        editable, _ = self._cell_editable(row, col)
        act_open = menu.addAction("Edit value…" if editable else "View value…")
        chosen = menu.exec(self.table.viewport().mapToGlobal(pos))
        if chosen == act_copy:
            self._copy_cell(row, col)
        elif chosen == act_copy_row:
            self._copy_row(row)
        elif chosen == act_open:
            self._open_cell_dialog(idx)

    def _copy_cell(self, row, col):
        QGuiApplication.clipboard().setText(clipboard_value(self.model.value_at(row, col)))
        self._status("Copied cell value")

    def _copy_row(self, row):
        vals = self.model.rows[row] if 0 <= row < len(self.model.rows) else []
        QGuiApplication.clipboard().setText("\t".join(clipboard_value(v) for v in vals))
        self._status("Copied row")

    def _open_cell_dialog(self, index):
        if not index.isValid():
            return
        row, col = index.row(), index.column()
        column = self.model.columns[col] if col < len(self.model.columns) else ""
        editable, reason = self._cell_editable(row, col)
        dlg = CellDialog(
            column=column, value=self.model.value_at(row, col), editable=editable, reason=reason,
            on_save=lambda text, set_null, r=row, c=col: self._save_cell(r, c, text, set_null),
            parent=self)
        dlg.exec()

    def _save_cell(self, row, col, new_text, set_null):
        if self._edit_worker is not None:
            self._status("An edit is already running…")
            return
        editable, reason = self._cell_editable(row, col)
        if not editable:
            self.failed.emit(reason or "This cell can't be edited")
            return
        db, table, path = self._cur_db, self._cur_table, self._db_paths.get(self._cur_db)
        if path is None:
            return
        self._status("Saving to device…")
        w = EditWorker(self.adb, self._serial, self._package, db, table,
                       self.model.columns[col], self._rowids[row], new_text, set_null, self._su,
                       row=row, col_index=col, path=path)
        w.done.connect(self._on_edit_done)
        self._edit_worker = w
        w.start()

    def _on_edit_done(self, ok, message):
        worker = self.sender()
        self._edit_worker = None
        if not ok:
            self._status(f"✗ {message}")
            self.failed.emit(f"Edit failed: {message}")
            return
        # mirror the confirmed device change onto the local snapshot + visible cell.
        try:
            apply_local_update(worker.path, worker.table, worker.col, worker.rowid,
                               worker.value, worker.set_null)
        except sqlite3.Error:
            pass
        self.model.set_cell(worker.row, worker.col_index,
                            None if worker.set_null else worker.value)
        self._status(f"✓ {message}")

    def _fit_columns(self):
        self.table.resizeColumnsToContents()
        for c in range(self.model.columnCount()):
            if self.table.columnWidth(c) > 400:
                self.table.setColumnWidth(c, 400)

    # --- CSV export --------------------------------------------------------
    def _export_csv(self):
        from PyQt6.QtWidgets import QFileDialog
        if not self.model.columns:
            return
        default_dir = os.path.expanduser("~/Downloads")
        if not os.path.isdir(default_dir):
            default_dir = os.path.expanduser("~")
        base = f"{self._cur_table or 'query'}.csv"
        path, _ = QFileDialog.getSaveFileName(
            self, "Export results as CSV", os.path.join(default_dir, base),
            "CSV files (*.csv);;All files (*)")
        if not path:
            return
        try:
            with open(path, "w", newline="", encoding="utf-8") as fh:
                writer = csv.writer(fh)
                writer.writerow(self.model.columns)
                for row in self.model.rows:
                    writer.writerow(["" if v is None else cell_text(v) for v in row])
        except OSError as exc:
            self.saved.emit(False, f"Export failed: {exc}", "")
            return
        self.saved.emit(True, f"Exported {len(self.model.rows):,} row(s) to {os.path.basename(path)}",
                        os.path.dirname(path))

    # --- misc --------------------------------------------------------------
    def _reset_all(self):
        self.search_edit.blockSignals(True)
        self.search_edit.clear()
        self.search_edit.blockSignals(False)
        self.tree.clear()
        self._db_items.clear()
        self.model.clear()
        self._cur_db = self._cur_table = None
        self._rowids = None
        self.query_edit.clear()
        self.query_edit.setEnabled(False)
        self.run_btn.setEnabled(False)
        self.export_btn.setEnabled(False)
        self.prev_btn.setEnabled(False)
        self.next_btn.setEnabled(False)
        self.page_label.clear()

    def _status(self, text: str):
        # Paging info lives in page_label; transient status goes to the status bar.
        self.status.emit(text)

    def shutdown(self):
        """Remove the pulled snapshots on app close."""
        try:
            shutil.rmtree(self._tmp, ignore_errors=True)
        except OSError:
            pass
