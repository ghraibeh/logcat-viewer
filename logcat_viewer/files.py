"""Device File Explorer tab.

Browse the device filesystem (shared storage, app-private data via ``run-as``
with a rooted ``su`` fallback, and system paths), transfer files both
directions, drag & drop, and manage files (new folder / rename / delete).

Mirrors the structure of ``dbinspect.py``: pure adb command builders (Qt-free,
smoke-tested) + ``QThread`` workers that never block the UI + a ``FilesView``
that follows the shared device combo / App picker.
"""
import os
import shutil
import subprocess
import tempfile
from dataclasses import dataclass

from PyQt6.QtCore import Qt, QThread, pyqtSignal, QUrl, QMimeData, QSize, QRect, QRectF, QPointF
from PyQt6.QtGui import (
    QDrag, QGuiApplication, QFont, QColor, QPainter, QPen, QPixmap, QIcon,
    QPainterPath, QLinearGradient, QDesktopServices,
)
from PyQt6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QSplitter, QListWidget, QListWidgetItem,
    QTableWidget, QTableWidgetItem, QLineEdit, QPushButton, QToolButton, QLabel,
    QCheckBox, QAbstractItemView, QHeaderView, QMenu, QMessageBox, QFileDialog,
    QInputDialog, QApplication, QStyle, QStackedWidget, QFrame, QStyledItemDelegate,
)

from .theme import TEXT

DATA_DATA = "/data/data"
DEFAULT_PATH = "/sdcard"

# The navigation-pane bookmarks, grouped into Windows-Explorer-style sections.
# (label, path, needs_app)
QUICK_ACCESS = [
    ("App data", DATA_DATA, True),        # target rewritten to /data/data/<pkg>
    ("Downloads", "/sdcard/Download", False),
    ("Pictures", "/sdcard/DCIM", False),
]
LOCATIONS = [
    ("Internal storage", "/sdcard", False),
    ("Temp", "/data/local/tmp", False),
    ("System", "/system", False),
    ("Device root", "/", False),
]
# Flattened, for code that just needs every bookmark (e.g. smoke tests).
PLACES = QUICK_ACCESS + LOCATIONS


# --- path helpers -------------------------------------------------------------
def join_path(base: str, name: str) -> str:
    if base == "/":
        return "/" + name
    return base.rstrip("/") + "/" + name


def parent_path(path: str) -> str:
    path = path.rstrip("/")
    if not path or "/" not in path:
        return "/"
    return path.rsplit("/", 1)[0] or "/"


def is_app_private(path: str, package: str | None) -> bool:
    """True if ``path`` lives inside the selected app's private data dir."""
    if not package:
        return False
    root = f"{DATA_DATA}/{package}"
    return path == root or path.startswith(root + "/")


def access_for(path: str, package: str | None, *, root_mode: bool = False):
    """How to reach ``path`` → ``(run_as, su)``.

    Root (su) mode wraps everything in ``su``; otherwise app-private paths use
    ``run-as <pkg>`` (the worker escalates to su if run-as is refused) and
    everything else uses a plain shell / ``adb pull``/``push``.
    """
    if root_mode:
        return (None, True)
    if is_app_private(path, package):
        return (package, False)
    return (None, False)


def human_size(n: int | None) -> str:
    if n is None:
        return ""
    size = float(n)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if size < 1024 or unit == "TB":
            return f"{int(size)} {unit}" if unit == "B" else f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} TB"


# --- pure adb command builders (no device needed → covered by smoke tests) ----
# No shell redirections/metacharacters — ``adb shell`` re-parses the command
# line, so anything fancier gets word-split on the device. run-as/su exec the
# plain binary directly, which is safe.
def _shell_prefix(serial: str, *, run_as: str | None = None, su: bool = False) -> list[str]:
    base = ["-s", serial, "shell"]
    if su:
        return base + ["su", "-c"]
    if run_as:
        return base + ["run-as", run_as]
    return base


def _execout_prefix(serial: str, *, run_as: str | None = None, su: bool = False) -> list[str]:
    base = ["-s", serial, "exec-out"]
    if su:
        return base + ["su", "-c"]
    if run_as:
        return base + ["run-as", run_as]
    return base


def ls_args(serial: str, path: str, *, run_as: str | None = None, su: bool = False) -> list[str]:
    """adb args to long-list a directory. ``-A`` = incl. dotfiles (not . / ..);
    ``-H`` dereferences the path itself when it's a symlink (e.g. ``/sdcard`` →
    ``/storage/self/primary``) so we list its contents, not the link — while
    entries *inside* still show as links."""
    return _shell_prefix(serial, run_as=run_as, su=su) + ["ls", "-lHA", path]


def cat_args(serial: str, path: str, *, run_as: str | None = None, su: bool = False) -> list[str]:
    """adb args to stream one file to stdout, binary-clean (via exec-out)."""
    return _execout_prefix(serial, run_as=run_as, su=su) + ["cat", path]


def mkdir_args(serial: str, path: str, *, run_as: str | None = None, su: bool = False) -> list[str]:
    return _shell_prefix(serial, run_as=run_as, su=su) + ["mkdir", "-p", path]


def rename_args(serial: str, src: str, dst: str, *, run_as: str | None = None,
                su: bool = False) -> list[str]:
    return _shell_prefix(serial, run_as=run_as, su=su) + ["mv", src, dst]


def delete_args(serial: str, paths: list[str], *, run_as: str | None = None,
                su: bool = False) -> list[str]:
    return _shell_prefix(serial, run_as=run_as, su=su) + ["rm", "-rf", *paths]


# --- listing parse (Qt-free → unit-testable) ----------------------------------
@dataclass
class Entry:
    name: str
    kind: str                     # dir | file | link | other
    size: int | None
    mode: str
    link_target: str | None = None
    modified: str = ""            # "YYYY-MM-DD HH:MM" from ls (best-effort)

    @property
    def ext(self) -> str:
        """Lower-case extension without the dot ("" for none / directories)."""
        if self.kind == "dir":
            return ""
        dot = self.name.rfind(".")
        return self.name[dot + 1:].lower() if dot > 0 else ""

    def type_label(self) -> str:
        if self.kind == "dir":
            return "File folder"
        if self.kind == "link":
            return "Shortcut"
        if self.kind == "other":
            return "System file"
        return f"{self.ext.upper()} file" if self.ext else "File"


_BLOCKED = ("not debuggable", "unknown package", "is unknown", "package inaccessible")


def parse_ls_line(line: str):
    """Parse one ``ls -lA`` line → ``Entry`` (or None for blanks / ``total`` header).

    toybox long format: ``mode nlink owner group size date time name``. The name
    is everything after the 7th field (so spaces in filenames survive); symlinks
    show ``name -> target``; char/block devices print ``major, minor`` where the
    size sits, shifting the name one field right.
    """
    line = line.rstrip("\r\n")
    if not line or line.startswith("total "):
        return None
    parts = line.split(None, 7)
    if len(parts) < 8 or len(parts[0]) < 10:
        return None
    mode = parts[0]
    c = mode[0]
    if c in ("c", "b"):                          # device node: "major, minor" name…
        wide = line.split(None, 8)
        name = wide[8] if len(wide) > 8 else parts[7]
        size = None
        modified = f"{wide[6]} {wide[7]}" if len(wide) > 8 else ""
    else:
        name = parts[7]
        try:
            size = int(parts[4])
        except ValueError:
            size = None
        modified = f"{parts[5]} {parts[6]}"      # date + time
    link_target = None
    if c == "d":
        kind = "dir"
    elif c == "l":
        kind = "link"
        if " -> " in name:
            name, link_target = name.split(" -> ", 1)
    elif c == "-":
        kind = "file"
    else:
        kind = "other"
    return Entry(name, kind, size, mode, link_target, modified)


def classify_listing(returncode: int, stdout: str, stderr: str):
    """Turn an ``ls -lA`` result into ``(entries, error)``.

    ``error`` is None on success (``entries`` may be empty). Otherwise
    ``entries`` is None and ``error`` is a sentinel: ``"blocked"`` (run-as
    refused → try su), ``"not found"``, ``"denied"``, or a raw message.
    Directories sort first, then case-insensitively by name.
    """
    if returncode == 0:
        entries = [e for e in (parse_ls_line(l) for l in stdout.splitlines()) if e]
        entries.sort(key=lambda e: (e.kind != "dir", e.name.lower()))
        return entries, None
    low = (stderr or "").lower()
    if "no such file" in low or "not a directory" in low:
        return None, "not found"
    if any(m in low for m in _BLOCKED):
        return None, "blocked"
    if "permission denied" in low or "operation not permitted" in low:
        return None, "denied"
    return None, (stderr.strip() or "couldn't list directory")


# --- shared transfer helpers (used by workers and the drag-out stager) --------
def _pull_public(adb: str, serial: str, remote: str, local: str) -> bool:
    """``adb pull`` a world-readable path (handles files and dirs)."""
    try:
        r = subprocess.run([adb, "-s", serial, "pull", remote, local],
                           capture_output=True, text=True, timeout=600)
    except (subprocess.SubprocessError, OSError):
        return False
    return r.returncode == 0 and os.path.exists(local)


def _pull_private_file(adb: str, serial: str, remote: str, local: str, run_as, su) -> bool:
    """Stream one app-private file to ``local`` via ``exec-out … cat``."""
    try:
        with open(local, "wb") as out:
            r = subprocess.run([adb, *cat_args(serial, remote, run_as=run_as, su=su)],
                               stdout=out, stderr=subprocess.PIPE, timeout=600)
    except (subprocess.SubprocessError, OSError):
        return False
    if r.returncode != 0:
        try:
            os.remove(local)
        except OSError:
            pass
        return False
    return True


def _pull_private_dir(adb: str, serial: str, remote: str, local: str, run_as, su) -> bool:
    """Recursively pull an app-private directory (adb pull can't reach it)."""
    os.makedirs(local, exist_ok=True)
    try:
        r = subprocess.run([adb, *ls_args(serial, remote, run_as=run_as, su=su)],
                           capture_output=True, text=True, timeout=60)
    except (subprocess.SubprocessError, OSError):
        return False
    entries, err = classify_listing(r.returncode, r.stdout, r.stderr)
    if entries is None:
        return False
    ok = True
    for e in entries:
        child_r, child_l = join_path(remote, e.name), os.path.join(local, e.name)
        if e.kind == "dir":
            ok = _pull_private_dir(adb, serial, child_r, child_l, run_as, su) and ok
        else:
            ok = _pull_private_file(adb, serial, child_r, child_l, run_as, su) and ok
    return ok


def pull_one(adb: str, serial: str, remote: str, kind: str, local: str, run_as, su) -> bool:
    """Pull one entry to ``local``. Public paths use ``adb pull``; app-private
    paths (run_as/su set) stream via ``cat`` (files) or recurse (dirs)."""
    if not (run_as or su):
        return _pull_public(adb, serial, remote, local)
    if kind == "dir":
        return _pull_private_dir(adb, serial, remote, local, run_as, su)
    return _pull_private_file(adb, serial, remote, local, run_as, su)


def _dd_push(adb: str, serial: str, local: str, remote: str, run_as, su) -> tuple[bool, str]:
    """Stream ``local`` into an app-private path via ``dd of=<remote>`` over
    stdin — no shell redirect, and no need for the app to read /data/local/tmp."""
    prefix = ["su", "-c"] if su else ["run-as", run_as]
    try:
        with open(local, "rb") as f:
            r = subprocess.run(
                [adb, "-s", serial, "shell", *prefix, "dd", f"of={remote}"],
                stdin=f, capture_output=True, text=True, timeout=600)
    except (subprocess.SubprocessError, OSError) as exc:
        return False, str(exc)
    return r.returncode == 0, (r.stderr or "").strip()


def _push_private_path(adb: str, serial: str, local: str, remote: str, run_as, su) -> tuple[bool, str]:
    if os.path.isdir(local):
        try:
            subprocess.run([adb, *mkdir_args(serial, remote, run_as=run_as, su=su)],
                           capture_output=True, text=True, timeout=30)
        except (subprocess.SubprocessError, OSError) as exc:
            return False, str(exc)
        ok, detail = True, ""
        for child in sorted(os.listdir(local)):
            cok, cdetail = _push_private_path(adb, serial, os.path.join(local, child),
                                              join_path(remote, child), run_as, su)
            ok = cok and ok
            detail = detail or cdetail
        return ok, detail
    return _dd_push(adb, serial, local, remote, run_as, su)


# --- workers ------------------------------------------------------------------
class DirListWorker(QThread):
    """List one directory (run-as, with a rooted ``su`` fallback for private
    dirs). ``seq`` lets the view drop stale results when navigation outpaces
    listing."""

    done = pyqtSignal(int, bool, str, list, str, bool)  # seq, ok, path, entries, error, used_su

    def __init__(self, adb, serial, path, run_as, su, seq, parent=None):
        super().__init__(parent)
        self._adb = adb
        self._serial = serial
        self._path = path
        self._run_as = run_as
        self._su = su
        self._seq = seq

    def _list(self, *, run_as, su):
        try:
            r = subprocess.run([self._adb, *ls_args(self._serial, self._path, run_as=run_as, su=su)],
                               capture_output=True, text=True, timeout=25)
        except (subprocess.SubprocessError, OSError) as exc:
            return None, str(exc)
        return classify_listing(r.returncode, r.stdout, r.stderr)

    def run(self):
        entries, err = self._list(run_as=self._run_as, su=self._su)
        if err == "blocked" and self._run_as and not self._su:      # not debuggable → try root
            entries_su, err_su = self._list(run_as=None, su=True)
            if entries_su is not None:
                self.done.emit(self._seq, True, self._path, entries_su, "", True)
                return
            self.done.emit(self._seq, False, self._path, [],
                           f"'{self._run_as}' is not debuggable and the device isn't rooted — "
                           "its private files can't be read.", False)
            return
        if entries is None:
            msg = {
                "not found": "No such directory",
                "denied": "Permission denied — try the Root (su) toggle on a rooted device",
                "blocked": "Not accessible (app not debuggable and no root)",
            }.get(err, f"Couldn't list: {err}")
            self.done.emit(self._seq, False, self._path, [], msg, self._su)
            return
        self.done.emit(self._seq, True, self._path, entries, "", self._su)


class PullWorker(QThread):
    """Pull selected entries to a local directory (device → PC)."""

    done = pyqtSignal(bool, str, str)   # ok, message, dest_dir

    def __init__(self, adb, serial, items, dest_dir, run_as, su, parent=None):
        super().__init__(parent)
        self._adb = adb
        self._serial = serial
        self._items = items             # list of (remote_path, kind, name)
        self._dest = dest_dir
        self._run_as = run_as
        self._su = su

    def run(self):
        pulled, errors = [], []
        for remote, kind, name in self._items:
            local = os.path.join(self._dest, name)
            try:
                ok = pull_one(self._adb, self._serial, remote, kind, local,
                              self._run_as, self._su)
            except (subprocess.SubprocessError, OSError) as exc:
                errors.append(f"{name}: {exc}")
                continue
            (pulled if ok else errors).append(name if ok else f"{name}: pull failed")
        ok = bool(pulled) and not errors
        if pulled:
            msg = f"Pulled {len(pulled)} item(s): {', '.join(pulled)}"
            if errors:
                msg += f"  ({len(errors)} failed: {'; '.join(errors)})"
        else:
            msg = "Pull failed: " + "; ".join(errors) if errors else "Nothing to pull"
        self.done.emit(ok, msg, self._dest)


class PushWorker(QThread):
    """Push local files/dirs into a device directory (PC → device)."""

    done = pyqtSignal(bool, str, str)   # ok, message, remote_dir

    def __init__(self, adb, serial, sources, remote_dir, run_as, su, parent=None):
        super().__init__(parent)
        self._adb = adb
        self._serial = serial
        self._sources = sources
        self._remote = remote_dir
        self._run_as = run_as
        self._su = su

    def _push_public(self, local, remote):
        try:
            r = subprocess.run([self._adb, "-s", self._serial, "push", local, remote],
                               capture_output=True, text=True, timeout=600)
        except (subprocess.SubprocessError, OSError) as exc:
            return False, str(exc)
        detail = (r.stderr or r.stdout or "").strip().splitlines()
        return r.returncode == 0, (detail[-1] if detail else "push failed")

    def run(self):
        pushed, errors = [], []
        for local in self._sources:
            name = os.path.basename(local.rstrip("/"))
            remote = join_path(self._remote, name)
            if self._run_as or self._su:
                ok, detail = _push_private_path(self._adb, self._serial, local, remote,
                                                self._run_as, self._su)
            else:
                ok, detail = self._push_public(local, remote)
            if ok:
                pushed.append(name)
            else:
                errors.append(f"{name}: {detail or 'failed'}")
        ok = bool(pushed) and not errors
        if pushed:
            msg = f"Pushed {len(pushed)} item(s) to {self._remote}: {', '.join(pushed)}"
            if errors:
                msg += f"  ({len(errors)} failed: {'; '.join(errors)})"
        else:
            msg = "Push failed: " + "; ".join(errors) if errors else "Nothing to push"
        self.done.emit(ok, msg, self._remote)


class FileOpWorker(QThread):
    """One short shell op (mkdir / rename / delete) built by the view."""

    done = pyqtSignal(bool, str)        # ok, message

    def __init__(self, adb, argv, ok_msg, parent=None):
        super().__init__(parent)
        self._adb = adb
        self._argv = argv
        self._ok_msg = ok_msg

    def run(self):
        try:
            r = subprocess.run([self._adb, *self._argv], capture_output=True, text=True, timeout=45)
        except (subprocess.SubprocessError, OSError) as exc:
            self.done.emit(False, str(exc))
            return
        if r.returncode == 0:
            self.done.emit(True, self._ok_msg)
        else:
            self.done.emit(False, (r.stderr or r.stdout or "operation failed").strip())



# --- drawn icons (no image assets, cohesive with the dark theme) --------------
_FOLDER = QColor("#54a0ff")
_FOLDER_HI = QColor("#7cc0ff")
_FILE = QColor("#d6dde8")
_FILE_LINE = QColor("#9aa3b2")
_TINTS = {"img": "#38c793", "media": "#b06bff", "archive": "#e3b341", "code": "#54a0ff"}
_GROUPS = {
    "img": {"jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "heic", "ico"},
    "media": {"mp4", "mkv", "mov", "avi", "mp3", "wav", "ogg", "m4a", "flac", "aac"},
    "archive": {"zip", "apk", "tar", "gz", "rar", "7z", "xz", "jar", "aab"},
    "code": {"json", "xml", "txt", "log", "html", "js", "java", "kt", "py", "c",
             "h", "md", "sh", "gradle", "properties", "cfg", "yaml", "yml"},
}


def _ext_group(ext: str):
    for g, exts in _GROUPS.items():
        if ext in exts:
            return g
    return None


def _folder_icon(size: int = 64) -> QIcon:
    pm = QPixmap(size, size)
    pm.fill(Qt.GlobalColor.transparent)
    p = QPainter(pm)
    p.setRenderHint(QPainter.RenderHint.Antialiasing, True)
    u = size / 64.0
    p.setPen(Qt.PenStyle.NoPen)
    p.setBrush(_FOLDER_HI)
    p.drawRoundedRect(QRectF(8 * u, 15 * u, 26 * u, 13 * u), 3 * u, 3 * u)     # back tab
    grad = QLinearGradient(0, 22 * u, 0, 52 * u)
    grad.setColorAt(0.0, _FOLDER_HI)
    grad.setColorAt(1.0, _FOLDER)
    p.setBrush(grad)
    p.drawRoundedRect(QRectF(8 * u, 21 * u, 48 * u, 31 * u), 4 * u, 4 * u)     # body
    p.end()
    return QIcon(pm)


def _file_icon(size: int = 64, tint: str | None = None) -> QIcon:
    pm = QPixmap(size, size)
    pm.fill(Qt.GlobalColor.transparent)
    p = QPainter(pm)
    p.setRenderHint(QPainter.RenderHint.Antialiasing, True)
    u = size / 64.0
    x0, y0, w, h, fold = 15 * u, 8 * u, 34 * u, 48 * u, 12 * u
    page = QPainterPath()
    page.moveTo(x0, y0)
    page.lineTo(x0 + w - fold, y0)
    page.lineTo(x0 + w, y0 + fold)
    page.lineTo(x0 + w, y0 + h)
    page.lineTo(x0, y0 + h)
    page.closeSubpath()
    p.setPen(Qt.PenStyle.NoPen)
    p.setBrush(QColor(tint) if tint else _FILE)
    p.drawPath(page)
    corner = QPainterPath()                                                    # folded corner
    corner.moveTo(x0 + w - fold, y0)
    corner.lineTo(x0 + w - fold, y0 + fold)
    corner.lineTo(x0 + w, y0 + fold)
    corner.closeSubpath()
    p.setBrush(QColor(0, 0, 0, 70))
    p.drawPath(corner)
    p.setPen(QPen(QColor(255, 255, 255, 150) if tint else _FILE_LINE, 2 * u))  # text lines
    for i, ly in enumerate((24, 31, 38, 45)):
        end = x0 + w - 6 * u - (10 * u if i == 3 else 0)
        p.drawLine(QPointF(x0 + 6 * u, ly * u), QPointF(end, ly * u))
    p.end()
    return QIcon(pm)


def _link_icon(base: QIcon, size: int = 64) -> QIcon:
    pm = base.pixmap(size, size)
    p = QPainter(pm)
    p.setRenderHint(QPainter.RenderHint.Antialiasing, True)
    u = size / 64.0
    p.setPen(Qt.PenStyle.NoPen)
    p.setBrush(QColor("#1f2126"))
    p.drawEllipse(QRectF(2 * u, 40 * u, 22 * u, 22 * u))                        # badge
    p.setPen(QPen(QColor("#e2e6ee"), 2.6 * u))
    p.drawLine(QPointF(8 * u, 56 * u), QPointF(17 * u, 47 * u))                 # arrow
    p.drawLine(QPointF(11 * u, 47 * u), QPointF(17 * u, 47 * u))
    p.drawLine(QPointF(17 * u, 47 * u), QPointF(17 * u, 53 * u))
    p.end()
    return QIcon(pm)


# --- directory views (drag & drop both directions) ---------------------------
class _Dnd:
    """Shared drag-in (push) + drag-out (staged pull) for the list & grid views.
    Mixed in *before* the Qt base so these handlers win via the MRO. The host
    class must declare ``pushRequested``/``dropHover`` signals and set
    ``self._stage`` (a callable(rows) → local paths)."""

    def _init_dnd(self):
        self.setAcceptDrops(True)
        self.setDragEnabled(True)
        self.setDragDropMode(QAbstractItemView.DragDropMode.DragDrop)
        self.setDropIndicatorShown(False)
        self._stage = None

    @staticmethod
    def _dropped(mime) -> list[str]:
        if not mime.hasUrls():
            return []
        return [u.toLocalFile() for u in mime.urls() if u.toLocalFile()]

    def startDrag(self, actions):
        if self._stage is None:
            return
        rows = sorted({i.row() for i in self.selectedIndexes()})
        local_paths = self._stage(rows)
        if not local_paths:
            return
        mime = QMimeData()
        mime.setUrls([QUrl.fromLocalFile(p) for p in local_paths])
        drag = QDrag(self)
        drag.setMimeData(mime)
        drag.exec(Qt.DropAction.CopyAction)

    def dragEnterEvent(self, e):
        if e.source() is not self and self._dropped(e.mimeData()):
            e.acceptProposedAction()
            self.dropHover.emit(True)
        else:
            e.ignore()

    def dragMoveEvent(self, e):
        if e.source() is not self and self._dropped(e.mimeData()):
            e.acceptProposedAction()
        else:
            e.ignore()

    def dragLeaveEvent(self, e):
        self.dropHover.emit(False)

    def dropEvent(self, e):
        self.dropHover.emit(False)
        if e.source() is self:
            return
        paths = self._dropped(e.mimeData())
        if paths:
            e.acceptProposedAction()
            self.pushRequested.emit(paths)


class FileTable(_Dnd, QTableWidget):
    """Details view: Name / Date modified / Type / Size."""

    pushRequested = pyqtSignal(list)
    dropHover = pyqtSignal(bool)

    def __init__(self, parent=None):
        super().__init__(0, 4, parent)
        self.setObjectName("ExplorerTable")
        self.setHorizontalHeaderLabels(["Name", "Date modified", "Type", "Size"])
        self.verticalHeader().setVisible(False)
        self.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)
        self.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self.setShowGrid(False)
        self.setWordWrap(False)
        self.setFrameShape(QFrame.Shape.NoFrame)
        self.setIconSize(QSize(20, 20))
        self.setTextElideMode(Qt.TextElideMode.ElideMiddle)
        self.verticalHeader().setDefaultSectionSize(30)
        hdr = self.horizontalHeader()
        hdr.setHighlightSections(False)
        hdr.setStretchLastSection(False)
        hdr.setDefaultAlignment(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter)
        hdr.setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        hdr.setSectionResizeMode(1, QHeaderView.ResizeMode.ResizeToContents)
        hdr.setSectionResizeMode(2, QHeaderView.ResizeMode.ResizeToContents)
        hdr.setSectionResizeMode(3, QHeaderView.ResizeMode.ResizeToContents)
        self._init_dnd()


class _IconDelegate(QStyledItemDelegate):
    """Draws grid items Windows-11-style: centered icon + a label wrapped to at
    most **two lines** (breaking anywhere, since filenames rarely have spaces),
    ellipsized on the second line. QListView's own word-wrap can't break long
    tokens like ``clip_final.mp4``, so we lay the text out ourselves."""

    _sel = QColor(79, 140, 255, 56)      # matches the QSS rgba(79,140,255,0.22)
    _hov = QColor(255, 255, 255, 14)
    _text = QColor(TEXT)

    def paint(self, painter, option, index):
        painter.save()
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        r = option.rect
        st = option.state
        if st & QStyle.StateFlag.State_Selected:
            painter.setPen(Qt.PenStyle.NoPen); painter.setBrush(self._sel)
            painter.drawRoundedRect(QRectF(r.adjusted(4, 4, -4, -4)), 8, 8)
        elif st & QStyle.StateFlag.State_MouseOver:
            painter.setPen(Qt.PenStyle.NoPen); painter.setBrush(self._hov)
            painter.drawRoundedRect(QRectF(r.adjusted(4, 4, -4, -4)), 8, 8)
        icon = index.data(Qt.ItemDataRole.DecorationRole)
        isz = option.decorationSize
        top = r.y() + 10
        if icon is not None and not icon.isNull():
            ix = r.x() + (r.width() - isz.width()) // 2
            icon.paint(painter, QRect(ix, top, isz.width(), isz.height()),
                       Qt.AlignmentFlag.AlignCenter)
        fm = option.fontMetrics
        tw = r.width() - 8
        line1, line2 = self._two_lines(fm, index.data(Qt.ItemDataRole.DisplayRole) or "", tw)
        painter.setPen(self._text)
        flags = Qt.AlignmentFlag.AlignHCenter | Qt.AlignmentFlag.AlignTop
        ty = top + isz.height() + 5
        painter.drawText(QRect(r.x() + 4, ty, tw, fm.height()), flags, line1)
        if line2:
            painter.drawText(QRect(r.x() + 4, ty + fm.lineSpacing(), tw, fm.height()), flags, line2)
        painter.restore()

    @staticmethod
    def _two_lines(fm, text, width):
        if fm.horizontalAdvance(text) <= width:
            return text, ""
        i = len(text)                                    # longest prefix that fits line 1
        while i > 1 and fm.horizontalAdvance(text[:i]) > width:
            i -= 1
        return text[:i], fm.elidedText(text[i:], Qt.TextElideMode.ElideRight, width)


class IconGrid(_Dnd, QListWidget):
    """Large-icons view."""

    pushRequested = pyqtSignal(list)
    dropHover = pyqtSignal(bool)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setObjectName("ExplorerGrid")
        self.setViewMode(QListWidget.ViewMode.IconMode)
        self.setIconSize(QSize(48, 48))
        self.setGridSize(QSize(116, 104))                # room for two label lines
        self.setResizeMode(QListWidget.ResizeMode.Adjust)
        self.setMovement(QListWidget.Movement.Static)
        self.setUniformItemSizes(True)
        self.setSpacing(6)
        self.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)
        self.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self.setFrameShape(QFrame.Shape.NoFrame)
        self.setItemDelegate(_IconDelegate(self))
        self._init_dnd()


# --- breadcrumb address bar ---------------------------------------------------
class Breadcrumb(QWidget):
    """Clickable path segments (``Device › sdcard › DCIM``). Clicking the empty
    area asks to switch to a raw-path text field (Windows-Explorer behavior)."""

    navigate = pyqtSignal(str)
    editRequested = pyqtSignal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setObjectName("ExplorerCrumbs")
        self._lay = QHBoxLayout(self)
        self._lay.setContentsMargins(6, 0, 6, 0)
        self._lay.setSpacing(1)
        self.set_path("/")

    def set_path(self, path: str):
        while self._lay.count():
            item = self._lay.takeAt(0)
            w = item.widget()
            if w:
                w.deleteLater()
        self._add_segment("This device", "/")
        acc = ""
        for seg in [s for s in path.split("/") if s]:
            acc += "/" + seg
            sep = QLabel("›")
            sep.setObjectName("CrumbSep")
            self._lay.addWidget(sep)
            self._add_segment(seg, acc)
        self._lay.addStretch(1)

    def _add_segment(self, label: str, target: str):
        btn = QPushButton(label)
        btn.setObjectName("Crumb")
        btn.setCursor(Qt.CursorShape.PointingHandCursor)
        btn.clicked.connect(lambda _=False, t=target: self.navigate.emit(t))
        self._lay.addWidget(btn)

    def mousePressEvent(self, event):
        self.editRequested.emit()          # clicked empty area → edit raw path
        super().mousePressEvent(event)


# --- the tab widget -----------------------------------------------------------
class FilesView(QWidget):
    """Windows-Explorer-style device file browser: command bar + back/forward +
    breadcrumb address bar + search, a Quick-access navigation pane, and a
    details / large-icons view. Two-way transfer + drag & drop. Self-contained:
    needs only ``adb`` + a serial (+ the App picker for private data)."""

    status = pyqtSignal(str)            # transient status-bar text
    failed = pyqtSignal(str)            # error → status bar + dialog
    saved = pyqtSignal(bool, str, str)  # transfer done: ok, message, local directory

    def __init__(self, adb: str, parent=None):
        super().__init__(parent)
        self.adb = adb or ""
        self._serial: str | None = None
        self._package: str | None = None
        self._path = DEFAULT_PATH
        self._root_mode = False
        self._loaded_key = None                       # (serial, path, pkg, su) last listed
        self._entries: list[Entry] = []
        self._list_seq = 0
        self._view_mode = "details"                   # details | icons
        self._sort_key = "name"                       # name | date | size | type
        self._sort_desc = False
        self._history: list[str] = []
        self._hist_idx = -1
        self._list_workers: set[DirListWorker] = set()
        self._pull_worker: PullWorker | None = None
        self._push_worker: PushWorker | None = None
        self._op_worker: FileOpWorker | None = None
        self._tmp = tempfile.mkdtemp(prefix="logcatviewer-files-")
        # drawn icons (rendered once, scaled per view)
        self._ic_folder = _folder_icon()
        self._ic_link = _link_icon(_folder_icon())
        self._ic_file = _file_icon()
        self._ic_tinted = {g: _file_icon(tint=c) for g, c in _TINTS.items()}
        self._build_ui()

    # --- construction ------------------------------------------------------
    def _icon(self, e: Entry) -> QIcon:
        if e.kind == "dir":
            return self._ic_folder
        if e.kind == "link":
            return self._ic_link
        grp = _ext_group(e.ext)
        return self._ic_tinted.get(grp, self._ic_file)

    def _tool_btn(self, text, sp, slot, tip=None):
        b = QToolButton()
        b.setObjectName("CmdBtn")
        b.setText(text)
        if sp is not None:
            b.setIcon(self.style().standardIcon(sp))
        b.setToolButtonStyle(Qt.ToolButtonStyle.ToolButtonTextBesideIcon)
        b.setToolTip(tip or text)
        if slot is not None:
            b.clicked.connect(slot)
        return b

    def _nav_btn(self, sp, slot, tip):
        b = QToolButton()
        b.setObjectName("NavBtn")
        b.setIcon(self.style().standardIcon(sp))
        b.setToolTip(tip)
        b.clicked.connect(slot)
        return b

    def _build_ui(self):
        SP = QStyle.StandardPixmap
        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)

        # --- command bar ---------------------------------------------------
        cmd = QWidget()
        cmd.setObjectName("ExplorerCmdBar")
        ch = QHBoxLayout(cmd)
        ch.setContentsMargins(10, 6, 10, 6)
        ch.setSpacing(4)
        self.newfolder_btn = self._tool_btn("New folder", SP.SP_FileDialogNewFolder,
                                            self._new_folder)
        self.upload_btn = self._tool_btn("Upload", SP.SP_ArrowUp, self._upload,
                                         "Push file(s) from this Mac into the current folder")
        self.download_btn = self._tool_btn("Download", SP.SP_ArrowDown, self._download_selected,
                                           "Pull the selected item(s) to this Mac")
        self.rename_btn = self._tool_btn("Rename", SP.SP_FileDialogDetailedView, self._rename_selected)
        self.delete_btn = self._tool_btn("Delete", SP.SP_TrashIcon, self._delete_selected)
        for b in (self.newfolder_btn, self.upload_btn, self.download_btn):
            ch.addWidget(b)
        sep = QFrame(); sep.setObjectName("CmdSep"); sep.setFrameShape(QFrame.Shape.VLine)
        ch.addWidget(sep)
        ch.addWidget(self.rename_btn)
        ch.addWidget(self.delete_btn)
        ch.addStretch(1)
        # Sort menu
        self.sort_btn = QToolButton()
        self.sort_btn.setObjectName("CmdBtn")
        self.sort_btn.setText("Sort")
        self.sort_btn.setToolButtonStyle(Qt.ToolButtonStyle.ToolButtonTextBesideIcon)
        self.sort_btn.setPopupMode(QToolButton.ToolButtonPopupMode.InstantPopup)
        self.sort_btn.setMenu(self._build_sort_menu())
        ch.addWidget(self.sort_btn)
        # View menu
        self.view_btn = QToolButton()
        self.view_btn.setObjectName("CmdBtn")
        self.view_btn.setText("View")
        self.view_btn.setToolButtonStyle(Qt.ToolButtonStyle.ToolButtonTextBesideIcon)
        self.view_btn.setPopupMode(QToolButton.ToolButtonPopupMode.InstantPopup)
        self.view_btn.setMenu(self._build_view_menu())
        ch.addWidget(self.view_btn)
        self.su_check = QCheckBox("Root (su)")
        self.su_check.setToolTip("Run as root on a rooted device (reach otherwise-locked paths)")
        ch.addWidget(self.su_check)
        root.addWidget(cmd)

        # --- navigation / address bar --------------------------------------
        nav = QWidget()
        nav.setObjectName("ExplorerNavBar")
        nh = QHBoxLayout(nav)
        nh.setContentsMargins(10, 6, 10, 6)
        nh.setSpacing(4)
        self.back_btn = self._nav_btn(SP.SP_ArrowBack, self._go_back, "Back")
        self.fwd_btn = self._nav_btn(SP.SP_ArrowForward, self._go_forward, "Forward")
        self.up_btn = self._nav_btn(SP.SP_ArrowUp, lambda: self._navigate(parent_path(self._path)), "Up")
        self.reload_btn = self._nav_btn(SP.SP_BrowserReload, lambda: self._load(), "Refresh")
        for b in (self.back_btn, self.fwd_btn, self.up_btn, self.reload_btn):
            nh.addWidget(b)

        self.address = QStackedWidget()
        self.address.setObjectName("ExplorerAddress")
        self.crumbs = Breadcrumb()
        self.crumbs.navigate.connect(self._navigate)
        self.crumbs.editRequested.connect(self._begin_edit_path)
        self.path_edit = QLineEdit(self._path)
        self.path_edit.setObjectName("ExplorerPathEdit")
        self.path_edit.returnPressed.connect(self._commit_edit_path)
        self.path_edit.editingFinished.connect(self._end_edit_path)
        self.address.addWidget(self.crumbs)                 # index 0
        self.address.addWidget(self.path_edit)              # index 1
        nh.addWidget(self.address, 1)

        self.search_edit = QLineEdit()
        self.search_edit.setObjectName("ExplorerSearch")
        self.search_edit.setPlaceholderText("Search")
        self.search_edit.setClearButtonEnabled(True)
        self.search_edit.setFixedWidth(200)
        self.search_edit.textChanged.connect(self._apply_search)
        nh.addWidget(self.search_edit)
        root.addWidget(nav)

        # --- splitter: navigation pane | view ------------------------------
        split = QSplitter(Qt.Orientation.Horizontal)

        side = QWidget()
        side.setObjectName("ExplorerSidebar")
        side.setMinimumWidth(170)
        side.setMaximumWidth(260)
        sv = QVBoxLayout(side)
        sv.setContentsMargins(0, 8, 0, 8)
        sv.setSpacing(2)
        self._app_place = None
        self.quick_list = self._make_place_list(QUICK_ACCESS)
        self.loc_list = self._make_place_list(LOCATIONS)
        sv.addWidget(self._side_header("Quick access"))
        sv.addWidget(self.quick_list)
        sv.addWidget(self._side_header("This device"))
        sv.addWidget(self.loc_list)
        sv.addStretch(1)
        split.addWidget(side)

        self.table = FileTable()
        self.grid = IconGrid()
        self._mono = QFont("SF Pro Text")
        self.table.setFont(self._mono)
        self.grid.setFont(self._mono)
        self.stack = QStackedWidget()
        self.stack.addWidget(self.table)                    # index 0 = details
        self.stack.addWidget(self.grid)                     # index 1 = icons
        split.addWidget(self.stack)
        split.setStretchFactor(0, 0)
        split.setStretchFactor(1, 1)
        split.setSizes([190, 820])
        root.addWidget(split, 1)

        self.status_label = QLabel("")
        self.status_label.setObjectName("ExplorerStatus")
        self.status_label.setContentsMargins(12, 6, 12, 6)
        root.addWidget(self.status_label)

        # --- wiring --------------------------------------------------------
        self.su_check.toggled.connect(self._toggle_root)
        for view in (self.table, self.grid):
            view.doubleClicked.connect(self._on_activate)
            view.customContextMenuRequested.connect(self._show_menu)
            view.pushRequested.connect(self._push_locals)
            view.dropHover.connect(self._on_drop_hover)
            view.itemSelectionChanged.connect(self._update_actions)
            view._stage = self._stage_for_drag
        self.crumbs.set_path(self._path)
        self._update_actions()

    def _side_header(self, text):
        lbl = QLabel(text)
        lbl.setObjectName("SideHeader")
        return lbl

    def _make_place_list(self, places):
        SP = QStyle.StandardPixmap
        icons = {
            "App data": SP.SP_DirLinkIcon, "Downloads": SP.SP_ArrowDown,
            "Pictures": SP.SP_DirIcon, "Internal storage": SP.SP_DriveHDIcon,
            "Temp": SP.SP_DirIcon, "System": SP.SP_ComputerIcon,
            "Device root": SP.SP_DriveHDIcon,
        }
        lst = QListWidget()
        lst.setObjectName("ExplorerSidebar")
        lst.setFrameShape(QFrame.Shape.NoFrame)
        lst.setIconSize(QSize(18, 18))
        lst.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        row_h = 30
        for label, path, needs_app in places:
            item = QListWidgetItem(self.style().standardIcon(icons.get(label, SP.SP_DirIcon)), label)
            item.setData(Qt.ItemDataRole.UserRole, (path, needs_app))
            lst.addItem(item)
            if needs_app and label == "App data":
                self._app_place = item
        lst.setFixedHeight(row_h * lst.count() + 6)
        lst.itemClicked.connect(self._on_place_clicked)
        lst.clearSelection()
        return lst

    def _build_sort_menu(self):
        menu = QMenu(self)
        self._sort_actions = {}
        for key, label in (("name", "Name"), ("date", "Date modified"),
                           ("type", "Type"), ("size", "Size")):
            act = menu.addAction(label)
            act.setCheckable(True)
            act.triggered.connect(lambda _=False, k=key: self._set_sort_key(k))
            self._sort_actions[key] = act
        menu.addSeparator()
        self._asc_act = menu.addAction("Ascending")
        self._desc_act = menu.addAction("Descending")
        for a in (self._asc_act, self._desc_act):
            a.setCheckable(True)
        self._asc_act.triggered.connect(lambda: self._set_sort_dir(False))
        self._desc_act.triggered.connect(lambda: self._set_sort_dir(True))
        self._sort_actions["name"].setChecked(True)
        self._asc_act.setChecked(True)
        return menu

    def _build_view_menu(self):
        menu = QMenu(self)
        self._details_act = menu.addAction("Details")
        self._icons_act = menu.addAction("Large icons")
        for a in (self._details_act, self._icons_act):
            a.setCheckable(True)
        self._details_act.setChecked(True)
        self._details_act.triggered.connect(lambda: self._set_view_mode("details"))
        self._icons_act.triggered.connect(lambda: self._set_view_mode("icons"))
        return menu

    # --- selection lifecycle (follows the shared device/app picker) --------
    def set_serial(self, serial: str | None):
        if serial != self._serial:
            self._serial = serial
            self._maybe_reload()

    def set_package(self, package: str | None):
        if package != self._package:
            self._package = package or None
            self._update_app_place()
            self._maybe_reload()

    def showEvent(self, event):
        super().showEvent(event)
        self._maybe_reload()

    def _maybe_reload(self):
        if not self.isVisible():
            return
        key = (self._serial, self._path, self._package, self._root_mode)
        if key == self._loaded_key:
            return
        if not self.adb or not self._serial:
            self._loaded_key = key
            self._reset("No device selected")
            return
        self._load()

    def _update_app_place(self):
        if self._app_place is None:
            return
        if self._package:
            self._app_place.setData(Qt.ItemDataRole.UserRole,
                                    (f"{DATA_DATA}/{self._package}", True))
            self._app_place.setFlags(self._app_place.flags() | Qt.ItemFlag.ItemIsEnabled)
            self._app_place.setToolTip(f"{DATA_DATA}/{self._package}")
        else:
            self._app_place.setData(Qt.ItemDataRole.UserRole, (DATA_DATA, True))
            self._app_place.setFlags(self._app_place.flags() & ~Qt.ItemFlag.ItemIsEnabled)
            self._app_place.setToolTip("Pick an app in the App box above to browse its private data")

    # --- navigation & listing ----------------------------------------------
    def _navigate(self, path: str, record: bool = True):
        self._record_next = record
        self._load(path or "/")

    def _load(self, target: str | None = None):
        """List ``target`` (defaults to the current dir). ``self._path`` only
        commits on success, so the visible listing and the path it targets
        never disagree after a failed navigation."""
        if not hasattr(self, "_record_next"):
            self._record_next = True
        if target is None:
            target = self._path
            self._record_next = False
        if not self.adb or not self._serial:
            self._reset("No device selected")
            return
        self._loaded_key = (self._serial, target, self._package, self._root_mode)
        self.path_edit.setText(target)
        self.crumbs.set_path(target)
        self._list_seq += 1
        seq = self._list_seq
        run_as, su = access_for(target, self._package, root_mode=self._root_mode)
        self._set_status(f"Opening {target}…")
        w = DirListWorker(self.adb, self._serial, target, run_as, su, seq)
        w.done.connect(self._on_listed)
        w.finished.connect(lambda w=w: self._list_workers.discard(w))
        self._list_workers.add(w)
        w.start()

    def _on_listed(self, seq, ok, path, entries, error, used_su):
        if seq != self._list_seq:
            return
        record = getattr(self, "_record_next", True)
        if not ok:
            self._set_status(f"✗ {error}")
            self.path_edit.setText(self._path)
            self.crumbs.set_path(self._path)
            self.failed.emit(error)
            return
        self._path = path
        self._entries = entries
        if record:
            self._push_history(path)
        self._sort_entries()
        self._populate()
        self._apply_search(self.search_edit.text())
        self._sync_sidebar_selection()
        self._update_nav_buttons()

    def _populate(self):
        self.table.setRowCount(0)
        self.table.setRowCount(len(self._entries))
        self.grid.clear()
        for row, e in enumerate(self._entries):
            icon = self._icon(e)
            name = QTableWidgetItem(icon, e.name)
            if e.link_target:
                name.setToolTip(f"{e.name} → {e.link_target}")
            size = QTableWidgetItem("" if e.kind == "dir" else human_size(e.size))
            size.setTextAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
            self.table.setItem(row, 0, name)
            self.table.setItem(row, 1, QTableWidgetItem(e.modified))
            self.table.setItem(row, 2, QTableWidgetItem(e.type_label()))
            self.table.setItem(row, 3, size)
            gi = QListWidgetItem(icon, e.name)
            gi.setToolTip(e.name if not e.link_target else f"{e.name} → {e.link_target}")
            self.grid.addItem(gi)
        self._update_actions()

    def _reset(self, message: str):
        self._entries = []
        self.table.setRowCount(0)
        self.grid.clear()
        self._set_status(message)
        self._update_actions()

    # --- history / nav buttons ---------------------------------------------
    def _push_history(self, path):
        if self._hist_idx >= 0 and self._history[self._hist_idx] == path:
            return
        del self._history[self._hist_idx + 1:]
        self._history.append(path)
        self._hist_idx = len(self._history) - 1

    def _go_back(self):
        if self._hist_idx > 0:
            self._hist_idx -= 1
            self._navigate(self._history[self._hist_idx], record=False)

    def _go_forward(self):
        if self._hist_idx < len(self._history) - 1:
            self._hist_idx += 1
            self._navigate(self._history[self._hist_idx], record=False)

    def _update_nav_buttons(self):
        self.back_btn.setEnabled(self._hist_idx > 0)
        self.fwd_btn.setEnabled(self._hist_idx < len(self._history) - 1)
        self.up_btn.setEnabled(self._path not in ("", "/"))

    # --- address-bar edit mode ---------------------------------------------
    def _begin_edit_path(self):
        self.path_edit.setText(self._path)
        self.address.setCurrentIndex(1)
        self.path_edit.setFocus()
        self.path_edit.selectAll()

    def _commit_edit_path(self):
        self.address.setCurrentIndex(0)
        self._navigate(self.path_edit.text().strip() or "/")

    def _end_edit_path(self):
        if self.address.currentIndex() == 1:
            self.address.setCurrentIndex(0)

    # --- sort / view / search ----------------------------------------------
    def _set_sort_key(self, key):
        self._sort_key = key
        for k, act in self._sort_actions.items():
            act.setChecked(k == key)
        self._sort_entries()
        self._populate()
        self._apply_search(self.search_edit.text())

    def _set_sort_dir(self, desc):
        self._sort_desc = desc
        self._asc_act.setChecked(not desc)
        self._desc_act.setChecked(desc)
        self._sort_entries()
        self._populate()
        self._apply_search(self.search_edit.text())

    def _sort_entries(self):
        keyfn = {
            "name": lambda e: e.name.lower(),
            "date": lambda e: e.modified,
            "size": lambda e: (e.size if e.size is not None else -1),
            "type": lambda e: e.type_label().lower(),
        }[self._sort_key]
        self._entries.sort(key=keyfn, reverse=self._sort_desc)
        self._entries.sort(key=lambda e: e.kind != "dir")   # folders first (stable)

    def _set_view_mode(self, mode):
        self._view_mode = mode
        self.stack.setCurrentIndex(0 if mode == "details" else 1)
        self._details_act.setChecked(mode == "details")
        self._icons_act.setChecked(mode == "icons")

    def _apply_search(self, text):
        needle = (text or "").lower()
        visible = 0
        for row, e in enumerate(self._entries):
            hide = bool(needle) and needle not in e.name.lower()
            self.table.setRowHidden(row, hide)
            self.grid.item(row).setHidden(hide)
            visible += not hide
        if needle:
            self._set_status(f"{visible} of {len(self._entries)} match “{text}”")
        else:
            self._set_status(self._count_text())

    # --- helpers ------------------------------------------------------------
    def _count_text(self):
        note = "  ·  root (su)" if self._root_mode else ""
        return f"{self._path}  —  {len(self._entries)} item(s){note}"

    def _child(self, name: str) -> str:
        return join_path(self._path, name)

    def _active(self):
        return self.table if self._view_mode == "details" else self.grid

    def _selected_entries(self) -> list[Entry]:
        rows = sorted({i.row() for i in self._active().selectedIndexes()})
        return [self._entries[r] for r in rows if 0 <= r < len(self._entries)]

    def _set_status(self, message: str):
        self.status_label.setText(message)
        self.status.emit(message)

    def _access(self):
        return access_for(self._path, self._package, root_mode=self._root_mode)

    def _update_actions(self):
        sel = self._selected_entries() if hasattr(self, "table") else []
        self.download_btn.setEnabled(bool(sel))
        self.delete_btn.setEnabled(bool(sel))
        self.rename_btn.setEnabled(len(sel) == 1)

    def _sync_sidebar_selection(self):
        for lst in (self.quick_list, self.loc_list):
            lst.blockSignals(True)
            lst.clearSelection()
            for i in range(lst.count()):
                data = lst.item(i).data(Qt.ItemDataRole.UserRole)
                if data and data[0] == self._path:
                    lst.item(i).setSelected(True)
            lst.blockSignals(False)

    # --- events -------------------------------------------------------------
    def _on_place_clicked(self, item):
        (self.quick_list if self.sender() is self.loc_list else self.loc_list).clearSelection()
        path, needs_app = item.data(Qt.ItemDataRole.UserRole)
        if needs_app and not self._package:
            self._set_status("Pick an app in the App box above to browse its private data")
            return
        self._navigate(path)

    def _on_activate(self, index):
        row = index.row()
        if 0 <= row < len(self._entries):
            e = self._entries[row]
            if e.kind in ("dir", "link"):
                self._navigate(self._child(e.name))
            else:
                self._open_entry(e)

    def _toggle_root(self, on: bool):
        self._root_mode = on
        self._load()

    def _on_drop_hover(self, active: bool):
        if active:
            self.status_label.setText(f"Drop to upload into {self._path}")
        else:
            self.status_label.setText(self._count_text())

    # --- context menu -------------------------------------------------------
    def _show_menu(self, pos):
        view = self.sender() or self._active()
        entries = self._selected_entries()
        menu = QMenu(self)
        act = {}
        if len(entries) == 1 and entries[0].kind in ("dir", "link"):
            act["open"] = menu.addAction("Open")
        elif len(entries) == 1:
            act["openfile"] = menu.addAction("Open")
        if entries:
            act["download"] = menu.addAction("Download to Mac…")
        act["upload"] = menu.addAction("Upload here…")
        menu.addSeparator()
        act["newfolder"] = menu.addAction("New folder…")
        if len(entries) == 1:
            act["rename"] = menu.addAction("Rename…")
        if entries:
            act["copy"] = menu.addAction("Copy device path")
            menu.addSeparator()
            act["delete"] = menu.addAction(f"Delete {len(entries)} item(s)…")
        chosen = menu.exec(view.viewport().mapToGlobal(pos))
        if chosen is None:
            return
        if chosen is act.get("open"):
            self._navigate(self._child(entries[0].name))
        elif chosen is act.get("openfile"):
            self._open_entry(entries[0])
        elif chosen is act.get("download"):
            self._download(entries)
        elif chosen is act.get("upload"):
            self._upload()
        elif chosen is act.get("newfolder"):
            self._new_folder()
        elif chosen is act.get("rename"):
            self._rename(entries[0])
        elif chosen is act.get("copy"):
            QGuiApplication.clipboard().setText(self._child(entries[0].name))
            self._set_status(f"Copied {self._child(entries[0].name)}")
        elif chosen is act.get("delete"):
            self._delete(entries)

    # --- transfers ----------------------------------------------------------
    def _download_selected(self):
        entries = self._selected_entries()
        if not entries:
            self._set_status("Select item(s) to download first")
            return
        self._download(entries)

    def _download(self, entries: list[Entry]):
        if self._pull_worker is not None:
            self._set_status("A download is already running…")
            return
        default_dir = os.path.expanduser("~/Downloads")
        if not os.path.isdir(default_dir):
            default_dir = os.path.expanduser("~")
        dest = QFileDialog.getExistingDirectory(self, "Download to…", default_dir)
        if not dest:
            return
        run_as, su = self._access()
        items = [(self._child(e.name), e.kind, e.name) for e in entries]
        self.download_btn.setEnabled(False)
        self._set_status(f"Downloading {len(items)} item(s)…")
        w = PullWorker(self.adb, self._serial, items, dest, run_as, su)
        w.done.connect(self._on_pull_done)
        self._pull_worker = w
        w.start()

    def _on_pull_done(self, ok, message, dest_dir):
        self._pull_worker = None
        self._update_actions()
        if ok:
            self.saved.emit(True, message, dest_dir)
        else:
            self.failed.emit(message)
        self._set_status(("✓ " if ok else "✗ ") + message)

    def _open_entry(self, e: Entry):
        if self._pull_worker is not None:
            self._set_status("A transfer is already running…")
            return
        run_as, su = self._access()
        dst = os.path.join(self._tmp, "open")
        shutil.rmtree(dst, ignore_errors=True)
        os.makedirs(dst, exist_ok=True)
        self._set_status(f"Opening {e.name}…")
        w = PullWorker(self.adb, self._serial, [(self._child(e.name), e.kind, e.name)],
                       dst, run_as, su)
        w.done.connect(self._on_open_done)
        self._pull_worker = w
        w.start()

    def _on_open_done(self, ok, message, dest_dir):
        self._pull_worker = None
        if not ok:
            self.failed.emit(message)
            self._set_status(f"✗ {message}")
            return
        first = next((os.path.join(dest_dir, f) for f in sorted(os.listdir(dest_dir))), None)
        if first:
            QDesktopServices.openUrl(QUrl.fromLocalFile(first))
            self._set_status(f"Opened {os.path.basename(first)}")

    def _upload(self):
        if self._push_worker is not None:
            self._set_status("An upload is already running…")
            return
        files, _ = QFileDialog.getOpenFileNames(self, "Upload file(s) to the device",
                                                os.path.expanduser("~"))
        if files:
            self._push_locals(files)

    def _push_locals(self, sources: list[str]):
        if self._push_worker is not None:
            self._set_status("An upload is already running…")
            return
        run_as, su = self._access()
        self.upload_btn.setEnabled(False)
        self._set_status(f"Uploading {len(sources)} item(s) to {self._path}…")
        w = PushWorker(self.adb, self._serial, sources, self._path, run_as, su)
        w.done.connect(self._on_push_done)
        self._push_worker = w
        w.start()

    def _on_push_done(self, ok, message, remote_dir):
        self._push_worker = None
        self.upload_btn.setEnabled(True)
        if ok:
            self.saved.emit(True, message, "")
            self._load()
        else:
            self.failed.emit(message)
        self._set_status(("✓ " if ok else "✗ ") + message)

    def _stage_for_drag(self, rows: list[int]) -> list[str]:
        """Synchronously pull the selected entries to a temp dir so a drag-out
        to Finder has real local files. Large files briefly block the drag —
        the Download button is the non-blocking path."""
        entries = [self._entries[r] for r in rows if 0 <= r < len(self._entries)]
        if not entries:
            return []
        run_as, su = self._access()
        stage = os.path.join(self._tmp, "drag")
        shutil.rmtree(stage, ignore_errors=True)
        os.makedirs(stage, exist_ok=True)
        out = []
        QApplication.setOverrideCursor(Qt.CursorShape.WaitCursor)
        self._set_status(f"Staging {len(entries)} item(s) for drag…")
        try:
            for e in entries:
                local = os.path.join(stage, e.name)
                if pull_one(self.adb, self._serial, self._child(e.name), e.kind, local, run_as, su):
                    out.append(local)
        finally:
            QApplication.restoreOverrideCursor()
        self._set_status(self._count_text())
        return out

    # --- file management ----------------------------------------------------
    def _new_folder(self):
        if self._op_worker is not None:
            self._set_status("An operation is already running…")
            return
        name, ok = QInputDialog.getText(self, "New folder", "Folder name:")
        name = name.strip()
        if not ok or not name:
            return
        run_as, su = self._access()
        target = self._child(name)
        self._run_op(mkdir_args(self._serial, target, run_as=run_as, su=su), f"Created {target}")

    def _rename_selected(self):
        sel = self._selected_entries()
        if len(sel) == 1:
            self._rename(sel[0])
        else:
            self._set_status("Select a single item to rename")

    def _rename(self, entry: Entry):
        if self._op_worker is not None:
            self._set_status("An operation is already running…")
            return
        name, ok = QInputDialog.getText(self, "Rename", "New name:", text=entry.name)
        name = name.strip()
        if not ok or not name or name == entry.name:
            return
        run_as, su = self._access()
        argv = rename_args(self._serial, self._child(entry.name), self._child(name),
                           run_as=run_as, su=su)
        self._run_op(argv, f"Renamed to {name}")

    def _delete_selected(self):
        sel = self._selected_entries()
        if sel:
            self._delete(sel)
        else:
            self._set_status("Select item(s) to delete first")

    def _delete(self, entries: list[Entry]):
        if self._op_worker is not None:
            self._set_status("An operation is already running…")
            return
        names = ", ".join(e.name for e in entries)
        box = QMessageBox(self)
        box.setIcon(QMessageBox.Icon.Warning)
        box.setWindowTitle("Delete from device")
        box.setText(f"Delete {len(entries)} item(s) from the device?\n\n{names}")
        box.setInformativeText("This is permanent — files are removed on the device.")
        box.setStandardButtons(QMessageBox.StandardButton.Cancel | QMessageBox.StandardButton.Yes)
        box.setDefaultButton(QMessageBox.StandardButton.Cancel)
        if box.exec() != QMessageBox.StandardButton.Yes:
            return
        run_as, su = self._access()
        paths = [self._child(e.name) for e in entries]
        self._run_op(delete_args(self._serial, paths, run_as=run_as, su=su),
                     f"Deleted {len(entries)} item(s)")

    def _run_op(self, argv, ok_msg):
        self._set_status("Working…")
        w = FileOpWorker(self.adb, argv, ok_msg)
        w.done.connect(self._on_op_done)
        self._op_worker = w
        w.start()

    def _on_op_done(self, ok, message):
        self._op_worker = None
        if ok:
            self._set_status(f"✓ {message}")
            self.status.emit(message)
            self._load()
        else:
            self.failed.emit(message)
            self._set_status(f"✗ {message}")

    # --- teardown -----------------------------------------------------------
    def shutdown(self):
        """Stop any running workers and remove staged temp files on app close."""
        for w in [self._pull_worker, self._push_worker, self._op_worker, *self._list_workers]:
            if w is not None and w.isRunning():
                w.wait(2000)
        shutil.rmtree(self._tmp, ignore_errors=True)
