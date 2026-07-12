"""Decompile an APK to Java (JADX) and browse the sources in a code viewer.

Right-click an app → *Decompile* → this pulls the APK, runs **jadx** (DEX → Java
+ decoded resources/manifest), and opens a ``SourceViewerWindow``: a file tree
of the decompiled project on the left and a read-only code editor (line numbers
+ Java/XML syntax highlighting) on the right.

**Self-contained, install-free:** jadx and a Java runtime are *provisioned on
first use* — an existing jadx / Java on the machine is used if present, otherwise
jadx (and, if there's no Java, a minimal JRE) is downloaded once into
``~/Library/Application Support/logcat-viewer/tools`` and cached forever. No
manual `brew install` required; everything runs on a ``QThread`` (never blocks
the UI), consistent with the rest of the app.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import platform
import tarfile
import urllib.error
import urllib.request
import zipfile

from PyQt6.QtCore import Qt, QThread, pyqtSignal, QSize, QRect
from PyQt6.QtGui import (
    QColor, QFont, QPainter, QTextCharFormat, QSyntaxHighlighter, QDesktopServices,
)
try:                                              # Qt6 moved QFileSystemModel to QtGui
    from PyQt6.QtGui import QFileSystemModel
except ImportError:                               # pragma: no cover
    from PyQt6.QtWidgets import QFileSystemModel
from PyQt6.QtCore import QUrl
from PyQt6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QSplitter, QTreeView, QPlainTextEdit,
    QLineEdit, QPushButton, QLabel,
)

from . import apps as applib
from .theme import ACCENT, ACCENT_H, GREEN, AMBER, TEXT_DIM, SURFACE

# Pinned jadx release (downloaded only if no jadx is found on the machine).
JADX_VERSION = "1.5.0"
JADX_URL = (f"https://github.com/skylot/jadx/releases/download/"
            f"v{JADX_VERSION}/jadx-{JADX_VERSION}.zip")


class CancelledError(Exception):
    pass


# --- tool provisioning (find on machine → else download & cache) --------------
def app_support_dir() -> str:
    d = os.path.expanduser("~/Library/Application Support/logcat-viewer")
    os.makedirs(d, exist_ok=True)
    return d


def tools_dir() -> str:
    d = os.path.join(app_support_dir(), "tools")
    os.makedirs(d, exist_ok=True)
    return d


def decompile_root() -> str:
    d = os.path.join(app_support_dir(), "decompiled")
    os.makedirs(d, exist_ok=True)
    return d


def _find_under(root: str, *, name: str, sub: str) -> str | None:
    """Find a file called ``name`` inside a ``<dir>/<sub>/<name>`` layout, no
    matter how the archive nests things."""
    for base, _dirs, files in os.walk(root):
        if os.path.basename(base) == sub and name in files:
            return os.path.join(base, name)
    return None


def system_jadx() -> str | None:
    env = os.environ.get("JADX")
    if env and os.path.exists(env):
        return env
    which = shutil.which("jadx")
    if which:
        return which
    for p in ("/opt/homebrew/bin/jadx", "/usr/local/bin/jadx",
              os.path.expanduser("~/bin/jadx")):
        if os.path.exists(p):
            return p
    return None


def cached_jadx() -> str | None:
    launcher = os.path.join(tools_dir(), f"jadx-{JADX_VERSION}", "bin", "jadx")
    return launcher if os.path.exists(launcher) else None


def _valid_java(path: str | None) -> bool:
    if not path or not os.path.exists(path):
        return False
    try:
        r = subprocess.run([path, "-version"], capture_output=True, timeout=10)
        return r.returncode == 0
    except (subprocess.SubprocessError, OSError):
        return False


def system_java() -> str | None:
    home = os.environ.get("JAVA_HOME")
    if home:
        cand = os.path.join(home, "bin", "java")
        if _valid_java(cand):
            return cand
    which = shutil.which("java")
    if _valid_java(which):
        return which
    if _valid_java("/usr/bin/java"):
        return "/usr/bin/java"
    return None


def cached_jre_java() -> str | None:
    return _find_under(os.path.join(tools_dir(), "jre"), name="java", sub="bin")


def _download(url: str, dest: str, progress, is_cancelled, label: str):
    req = urllib.request.Request(url, headers={"User-Agent": "logcat-viewer"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        total = int(resp.headers.get("Content-Length", 0))
        got = 0
        with open(dest, "wb") as f:
            while True:
                if is_cancelled():
                    raise CancelledError()
                chunk = resp.read(1 << 16)
                if not chunk:
                    break
                f.write(chunk)
                got += len(chunk)
                if total:
                    progress(f"{label}: {got/1e6:.1f} / {total/1e6:.1f} MB")
                else:
                    progress(f"{label}: {got/1e6:.1f} MB")


def download_jadx(progress, is_cancelled) -> str | None:
    dst = os.path.join(tools_dir(), f"jadx-{JADX_VERSION}")
    zip_path = os.path.join(tools_dir(), f"jadx-{JADX_VERSION}.zip")
    try:
        progress("Downloading jadx…")
        _download(JADX_URL, zip_path, progress, is_cancelled, "jadx")
        progress("Extracting jadx…")
        shutil.rmtree(dst, ignore_errors=True)
        with zipfile.ZipFile(zip_path) as z:
            z.extractall(dst)
    except CancelledError:
        raise
    except (OSError, urllib.error.URLError, zipfile.BadZipFile):
        return None
    finally:
        if os.path.exists(zip_path):
            try:
                os.remove(zip_path)
            except OSError:
                pass
    launcher = _find_under(dst, name="jadx", sub="bin")
    if launcher:
        try:
            os.chmod(launcher, 0o755)
        except OSError:
            pass
    return launcher


def _adoptium_url() -> str:
    arch = "aarch64" if platform.machine().lower() in ("arm64", "aarch64") else "x64"
    return (f"https://api.adoptium.net/v3/binary/latest/21/ga/mac/{arch}"
            f"/jre/hotspot/normal/eclipse")


def download_jre(progress, is_cancelled) -> str | None:
    dst = os.path.join(tools_dir(), "jre")
    tgz = os.path.join(tools_dir(), "jre.tar.gz")
    try:
        progress("Downloading Java runtime…")
        _download(_adoptium_url(), tgz, progress, is_cancelled, "JRE")
        progress("Extracting Java runtime…")
        shutil.rmtree(dst, ignore_errors=True)
        with tarfile.open(tgz) as t:
            t.extractall(dst)
    except CancelledError:
        raise
    except (OSError, urllib.error.URLError, tarfile.TarError):
        return None
    finally:
        if os.path.exists(tgz):
            try:
                os.remove(tgz)
            except OSError:
                pass
    java = _find_under(dst, name="java", sub="bin")
    if java:
        try:
            os.chmod(java, 0o755)
        except OSError:
            pass
    return java


def provision_tools(progress, is_cancelled) -> tuple[str, str]:
    """Return (jadx_launcher, java_binary), using what's on the machine and
    downloading whatever's missing. Raises on failure/cancel."""
    jadx = cached_jadx() or system_jadx()
    if not jadx:
        jadx = download_jadx(progress, is_cancelled)
    java = system_java() or cached_jre_java()
    if not java:
        java = download_jre(progress, is_cancelled)
    if not java:
        raise RuntimeError("Java not found and the JRE download failed. Install "
                           "Java (e.g. `brew install openjdk`) or set JAVA_HOME.")
    if not jadx:
        raise RuntimeError("jadx not found and its download failed. Install jadx "
                           "(`brew install jadx`) or set $JADX.")
    return jadx, java


# --- worker: pull APK(s) + run jadx ------------------------------------------
class DecompileWorker(QThread):
    progress = pyqtSignal(str)                    # human status while working
    done = pyqtSignal(bool, str, str)             # ok, source_dir, message

    def __init__(self, adb, serial, package, out_dir, local_apks=None, parent=None):
        super().__init__(parent)
        self._adb, self._serial, self._pkg = adb, serial, package
        self._out = out_dir
        self._local = local_apks
        self._cancel = False
        self._proc = None

    def cancel(self):
        self._cancel = True
        p = self._proc
        if p and p.poll() is None:
            try:
                p.kill()
            except OSError:
                pass

    def _cancelled(self):
        return self._cancel

    def run(self):
        try:
            self.progress.emit("Preparing decompiler…")
            jadx, java = provision_tools(self.progress.emit, self._cancelled)
        except CancelledError:
            self.done.emit(False, "", "Cancelled"); return
        except Exception as exc:                  # noqa: BLE001 (report any setup failure)
            self.done.emit(False, "", str(exc)); return

        apks = self._local
        if not apks:
            apks = self._pull_apks()
            if apks is None:
                return                            # _pull_apks already emitted done
        if self._cancel:
            self.done.emit(False, "", "Cancelled"); return

        src = os.path.join(self._out, "src")
        shutil.rmtree(src, ignore_errors=True)
        os.makedirs(src, exist_ok=True)
        self.progress.emit("Decompiling with jadx… (this can take a while)")
        env = self._java_env(java)
        try:
            self._proc = subprocess.Popen(
                [jadx, "-d", src, *apks], stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT, text=True, env=env)
            out, _ = self._proc.communicate(timeout=900)
        except subprocess.TimeoutExpired:
            self.cancel()
            self.done.emit(False, "", "jadx timed out (over 15 min)"); return
        except (subprocess.SubprocessError, OSError) as exc:
            self.done.emit(False, "", f"jadx failed to run: {exc}"); return
        if self._cancel:
            self.done.emit(False, "", "Cancelled"); return

        n = sum(len(fs) for _root, _d, fs in os.walk(src))
        if n:
            self.done.emit(True, src, f"Decompiled {self._pkg} — {n} files")
        else:
            self.done.emit(False, src, "jadx produced no output. "
                           + (out or "").strip()[-300:])

    def _pull_apks(self):
        if not self._adb or not self._serial:
            self.done.emit(False, "", "No device to pull the APK from")
            return None
        remotes = applib.apk_paths_on_device(self._adb, self._serial, self._pkg)
        if not remotes:
            self.done.emit(False, "", f"No APK found on device for {self._pkg}")
            return None
        apk_dir = os.path.join(self._out, "apk")
        os.makedirs(apk_dir, exist_ok=True)
        pulled = []
        for r in remotes:
            if self._cancel:
                self.done.emit(False, "", "Cancelled"); return None
            self.progress.emit(f"Pulling {os.path.basename(r)}…")
            local = os.path.join(apk_dir, os.path.basename(r))
            try:
                res = subprocess.run([self._adb, "-s", self._serial, "pull", r, local],
                                     capture_output=True, text=True, timeout=300)
            except (subprocess.SubprocessError, OSError) as exc:
                self.done.emit(False, "", f"APK pull failed: {exc}"); return None
            if res.returncode == 0 and os.path.exists(local):
                pulled.append(local)
        if not pulled:
            self.done.emit(False, "", "APK pull failed"); return None
        return pulled

    @staticmethod
    def _java_env(java):
        """Only steer jadx toward our *downloaded* JRE. For a system/Homebrew
        jadx+java, invoke it exactly as the shell does — overriding JAVA_HOME or
        PATH there breaks the wrapper's own Java detection (and can hang)."""
        env = os.environ.copy()
        if java and os.path.commonpath([os.path.abspath(java), tools_dir()]) == tools_dir():
            jbin = os.path.dirname(java)
            env["PATH"] = jbin + os.pathsep + env.get("PATH", "")
            env["JAVA_HOME"] = os.path.dirname(jbin)
        return env


# --- code editor with line numbers + syntax highlighting ----------------------
class _LineNumberArea(QWidget):
    def __init__(self, editor):
        super().__init__(editor)
        self._editor = editor

    def sizeHint(self):
        return QSize(self._editor.line_number_width(), 0)

    def paintEvent(self, event):
        self._editor.paint_line_numbers(event)


class CodeEditor(QPlainTextEdit):
    """Read-only monospace editor with a line-number gutter."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setReadOnly(True)
        self.setLineWrapMode(QPlainTextEdit.LineWrapMode.NoWrap)
        f = QFont("Menlo")
        f.setStyleHint(QFont.StyleHint.Monospace)
        f.setPointSize(12)
        self.setFont(f)
        self.setTabStopDistance(4 * self.fontMetrics().horizontalAdvance(" "))
        self._lna = _LineNumberArea(self)
        self.blockCountChanged.connect(lambda _=0: self._update_margins())
        self.updateRequest.connect(self._on_update)
        self._update_margins()

    def line_number_width(self):
        digits = max(3, len(str(max(1, self.blockCount()))))
        return 14 + self.fontMetrics().horizontalAdvance("9") * digits

    def _update_margins(self):
        self.setViewportMargins(self.line_number_width(), 0, 0, 0)

    def _on_update(self, rect, dy):
        if dy:
            self._lna.scroll(0, dy)
        else:
            self._lna.update(0, rect.y(), self._lna.width(), rect.height())
        if rect.contains(self.viewport().rect()):
            self._update_margins()

    def resizeEvent(self, event):
        super().resizeEvent(event)
        cr = self.contentsRect()
        self._lna.setGeometry(QRect(cr.left(), cr.top(),
                                    self.line_number_width(), cr.height()))

    def paint_line_numbers(self, event):
        painter = QPainter(self._lna)
        painter.fillRect(event.rect(), QColor(SURFACE))
        block = self.firstVisibleBlock()
        num = block.blockNumber()
        top = round(self.blockBoundingGeometry(block)
                    .translated(self.contentOffset()).top())
        bottom = top + round(self.blockBoundingRect(block).height())
        painter.setPen(QColor(TEXT_DIM))
        h = self.fontMetrics().height()
        while block.isValid() and top <= event.rect().bottom():
            if block.isVisible() and bottom >= event.rect().top():
                painter.drawText(0, top, self._lna.width() - 6, h,
                                 Qt.AlignmentFlag.AlignRight, str(num + 1))
            block = block.next()
            top = bottom
            bottom = top + round(self.blockBoundingRect(block).height())
            num += 1


_JAVA_KEYWORDS = (
    r"\b(?:abstract|assert|boolean|break|byte|case|catch|char|class|const|continue|"
    r"default|do|double|else|enum|extends|final|finally|float|for|goto|if|implements|"
    r"import|instanceof|int|interface|long|native|new|package|private|protected|public|"
    r"return|short|static|strictfp|super|switch|synchronized|this|throw|throws|transient|"
    r"try|void|volatile|while|true|false|null|var)\b")


class Highlighter(QSyntaxHighlighter):
    """Java / XML syntax highlighter; ``set_mode`` switches per opened file."""

    def __init__(self, document):
        super().__init__(document)
        self._mode = None
        self._rules = []
        self._block = None                        # (start_regex, end_regex) for /* */, <!-- -->

    @staticmethod
    def _fmt(color, bold=False, italic=False):
        f = QTextCharFormat()
        f.setForeground(QColor(color))
        if bold:
            f.setFontWeight(QFont.Weight.Bold)
        if italic:
            f.setFontItalic(True)
        return f

    def set_mode(self, mode):
        if mode == self._mode:
            return
        self._mode = mode
        self._rules = []
        self._block = None
        if mode == "java":
            self._rules = [
                (re.compile(_JAVA_KEYWORDS), self._fmt(ACCENT, bold=True)),
                (re.compile(r"@\w+"), self._fmt(ACCENT_H)),
                (re.compile(r"\b\d[\w.]*\b"), self._fmt(AMBER)),
                (re.compile(r'"(?:\\.|[^"\\])*"'), self._fmt(GREEN)),
                (re.compile(r"'(?:\\.|[^'\\])*'"), self._fmt(GREEN)),
                (re.compile(r"//[^\n]*"), self._fmt(TEXT_DIM, italic=True)),
            ]
            self._block = (re.compile(r"/\*"), re.compile(r"\*/"))
        elif mode == "xml":
            self._rules = [
                (re.compile(r"</?[\w:.\-]+"), self._fmt(ACCENT, bold=True)),
                (re.compile(r"\b[\w:.\-]+(?==)"), self._fmt(AMBER)),
                (re.compile(r'"[^"]*"'), self._fmt(GREEN)),
                (re.compile(r"/?>"), self._fmt(ACCENT, bold=True)),
            ]
            self._block = (re.compile(r"<!--"), re.compile(r"-->"))
        self.rehighlight()

    def highlightBlock(self, text):
        for rx, fmt in self._rules:
            for m in rx.finditer(text):
                self.setFormat(m.start(), m.end() - m.start(), fmt)
        if not self._block:
            return
        start_rx, end_rx = self._block
        comment = self._fmt(TEXT_DIM, italic=True)
        self.setCurrentBlockState(0)
        if self.previousBlockState() == 1:
            start = 0
        else:
            m = start_rx.search(text)
            start = m.start() if m else -1
        while start >= 0:
            m = end_rx.search(text, start)
            if m:
                self.setFormat(start, m.end() - start, comment)
                nxt = start_rx.search(text, m.end())
                start = nxt.start() if nxt else -1
            else:
                self.setCurrentBlockState(1)
                self.setFormat(start, len(text) - start, comment)
                break


_BINARY_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".ico", ".arsc",
               ".dex", ".so", ".ttf", ".otf", ".jar", ".zip", ".bin", ".dat", ".pdf"}
_XML_EXT = {".xml", ".html", ".htm", ".xhtml", ".svg"}
_MAX_PREVIEW = 3 * 1024 * 1024


class SourceViewerWindow(QWidget):
    """Top-level window: decompiled file tree + read-only code viewer."""

    def __init__(self, root_dir, title, redecompile=None, parent=None):
        super().__init__(parent)
        self._root = root_dir
        self._redecompile = redecompile
        self.setObjectName("SrcViewer")
        self.setWindowTitle(f"Decompiled — {title}")
        self.resize(1120, 720)
        self._build_ui()

    def _build_ui(self):
        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)

        bar = QWidget()
        bar.setObjectName("SrcBar")
        bh = QHBoxLayout(bar)
        bh.setContentsMargins(10, 7, 10, 7)
        bh.setSpacing(8)
        self.filter = QLineEdit()
        self.filter.setObjectName("SrcFilter")
        self.filter.setPlaceholderText("Filter files…")
        self.filter.setClearButtonEnabled(True)
        self.filter.textChanged.connect(self._apply_filter)
        self.path_label = QLabel("")
        self.path_label.setObjectName("SrcPath")
        self.path_label.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        open_btn = QPushButton("Open in Finder")
        open_btn.setObjectName("toggle")
        open_btn.clicked.connect(
            lambda: QDesktopServices.openUrl(QUrl.fromLocalFile(self._root)))
        bh.addWidget(self.filter, 0)
        bh.addWidget(self.path_label, 1)
        if self._redecompile:
            re_btn = QPushButton("Re-decompile")
            re_btn.setObjectName("toggle")
            re_btn.clicked.connect(self._redecompile)
            bh.addWidget(re_btn)
        bh.addWidget(open_btn)
        root.addWidget(bar)

        split = QSplitter(Qt.Orientation.Horizontal)
        self.model = QFileSystemModel()
        self.model.setRootPath(self._root)
        self.model.setNameFilterDisables(False)
        self.tree = QTreeView()
        self.tree.setObjectName("SrcTree")
        self.tree.setModel(self.model)
        self.tree.setRootIndex(self.model.index(self._root))
        for col in (1, 2, 3):                     # hide size / type / date columns
            self.tree.setColumnHidden(col, True)
        self.tree.setHeaderHidden(True)
        self.tree.clicked.connect(self._open_index)
        split.addWidget(self.tree)

        self.editor = CodeEditor()
        self.highlighter = Highlighter(self.editor.document())
        self.editor.setPlainText("← select a file to view its source")
        split.addWidget(self.editor)
        split.setStretchFactor(0, 0)
        split.setStretchFactor(1, 1)
        split.setSizes([340, 780])
        root.addWidget(split, 1)

        # expand the top-level (sources / resources) so the tree isn't empty
        self.tree.expand(self.model.index(self._root))

    def _apply_filter(self, text):
        self.model.setNameFilters([f"*{text}*"] if text else [])

    def _open_index(self, index):
        path = self.model.filePath(index)
        if os.path.isdir(path):
            return
        self._load_file(path)

    def _load_file(self, path):
        rel = os.path.relpath(path, self._root)
        self.path_label.setText(rel)
        ext = os.path.splitext(path)[1].lower()
        try:
            size = os.path.getsize(path)
        except OSError:
            size = 0
        if ext in _BINARY_EXT:
            self.highlighter.set_mode(None)
            self.editor.setPlainText(f"[binary file — {rel} ({_human(size)})]")
            return
        if size > _MAX_PREVIEW:
            self.highlighter.set_mode(None)
            self.editor.setPlainText(f"[file too large to preview — {_human(size)}]")
            return
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                text = f.read()
        except OSError as exc:
            self.editor.setPlainText(f"[could not read {rel}: {exc}]")
            return
        mode = "java" if ext == ".java" else "xml" if ext in _XML_EXT else None
        self.highlighter.set_mode(mode)
        self.editor.setPlainText(text)

    def open_first_source(self):
        """Auto-open the first `.java` file (nicety after a fresh decompile)."""
        srcs = os.path.join(self._root, "sources")
        base = srcs if os.path.isdir(srcs) else self._root
        for root, _dirs, files in os.walk(base):
            for name in sorted(files):
                if name.endswith(".java"):
                    self._select_path(os.path.join(root, name))
                    return

    def _select_path(self, path):
        idx = self.model.index(path)
        if idx.isValid():
            self.tree.setCurrentIndex(idx)
            self.tree.scrollTo(idx)
            self._load_file(path)


def _human(n: int) -> str:
    step = 1024.0
    for unit in ("B", "KB", "MB", "GB"):
        if n < step:
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= step
    return f"{n:.1f} TB"
