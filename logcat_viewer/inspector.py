"""Layout Inspector: capture a screenshot + `uiautomator dump` view hierarchy
in one worker pass, then browse the tree ↔ click the screenshot to select the
node under the cursor (bounds, resource-id, class, text, flags).

Pure helpers (`parse_bounds`, `build_ui_tree`, `node_at`) are Qt-free and
covered by tests/smoke.py. No dependency beyond adb — `uiautomator dump` works
on any device/app (it reads the accessibility tree, no debuggable needed).
"""
from __future__ import annotations

import subprocess
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field

from PyQt6.QtCore import Qt, QThread, pyqtSignal
from PyQt6.QtGui import QColor, QImage, QPainter, QPen, QPixmap
from PyQt6.QtWidgets import (
    QHBoxLayout, QHeaderView, QLabel, QPushButton, QSplitter, QTableWidget,
    QTableWidgetItem, QTreeWidget, QTreeWidgetItem, QVBoxLayout, QWidget,
)

from . import theme


# --- pure helpers ------------------------------------------------------------
def screencap_args(serial: str) -> list[str]:
    return ["-s", serial, "exec-out", "screencap", "-p"]


def uidump_args(serial: str) -> list[str]:
    """Dump the accessibility hierarchy straight to stdout (no temp file)."""
    return ["-s", serial, "exec-out", "uiautomator", "dump", "/dev/tty"]


def parse_bounds(s: str):
    """'[0,63][1080,231]' -> (0, 63, 1080, 231), or None."""
    try:
        l, t = s[1:s.index("]")].split(",")
        r, b = s[s.rindex("[") + 1:-1].split(",")
        return int(l), int(t), int(r), int(b)
    except (ValueError, IndexError):
        return None


@dataclass
class UiNode:
    attrs: dict
    bounds: tuple | None
    depth: int
    children: list = field(default_factory=list)

    @property
    def label(self) -> str:
        cls = (self.attrs.get("class") or "?").rsplit(".", 1)[-1]
        rid = self.attrs.get("resource-id", "")
        rid = rid.split("/", 1)[-1] if rid else ""
        text = self.attrs.get("text", "")
        bits = [cls]
        if rid:
            bits.append(f"#{rid}")
        if text:
            bits.append(f"“{text[:24]}”")
        return "  ".join(bits)

    @property
    def area(self) -> int:
        if not self.bounds:
            return 1 << 62
        l, t, r, b = self.bounds
        return max(0, r - l) * max(0, b - t)


def build_ui_tree(xml_text: str) -> UiNode | None:
    """Parse a uiautomator dump into a UiNode tree. Tolerates the trailing
    'UI hierchary dumped to: …' noise after the XML."""
    end = xml_text.rfind("</hierarchy>")
    if end >= 0:
        xml_text = xml_text[:end + len("</hierarchy>")]
    start = xml_text.find("<")
    if start < 0:
        return None
    try:
        root_el = ET.fromstring(xml_text[start:])
    except ET.ParseError:
        return None

    def wrap(el, depth) -> UiNode:
        node = UiNode(dict(el.attrib), parse_bounds(el.attrib.get("bounds", "")), depth)
        node.children = [wrap(c, depth + 1) for c in el if c.tag == "node"]
        return node

    root = UiNode({"class": "hierarchy"}, None, 0)
    root.children = [wrap(c, 1) for c in root_el if c.tag == "node"]
    return root


def node_at(root: UiNode, x: int, y: int) -> UiNode | None:
    """Deepest (then smallest) node whose bounds contain (x, y)."""
    best: UiNode | None = None

    def visit(n: UiNode):
        nonlocal best
        if n.bounds:
            l, t, r, b = n.bounds
            if l <= x < r and t <= y < b:
                if best is None or n.depth > best.depth or (
                        n.depth == best.depth and n.area < best.area):
                    best = n
        for c in n.children:
            visit(c)

    visit(root)
    return best


class InspectWorker(QThread):
    done = pyqtSignal(bool, str, bytes, str)   # ok, message, png, xml

    def __init__(self, adb: str, serial: str, parent=None):
        super().__init__(parent)
        self._adb = adb
        self._serial = serial

    def run(self):
        try:
            shot = subprocess.run([self._adb, *screencap_args(self._serial)],
                                  capture_output=True, timeout=20)
            dump = subprocess.run([self._adb, *uidump_args(self._serial)],
                                  capture_output=True, timeout=25)
        except (subprocess.SubprocessError, OSError) as exc:
            self.done.emit(False, f"capture failed: {exc}", b"", "")
            return
        xml_text = dump.stdout.decode("utf-8", errors="replace")
        if b"\x89PNG" not in shot.stdout[:8]:
            self.done.emit(False, "screencap returned no image", b"", "")
            return
        if "<hierarchy" not in xml_text:
            err = dump.stderr.decode("utf-8", errors="replace").strip()
            self.done.emit(False, f"uiautomator dump failed: {err or 'no XML'}", b"", "")
            return
        self.done.emit(True, "captured", bytes(shot.stdout), xml_text)


class _ShotCanvas(QWidget):
    """Scaled screenshot with the selected node's bounds drawn on top.
    Clicking emits the device-space coordinate."""
    clicked = pyqtSignal(int, int)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._img: QImage | None = None
        self._sel: tuple | None = None
        self.setMinimumWidth(220)

    def set_image(self, img: QImage | None):
        self._img = img
        self._sel = None
        self.update()

    def set_selection(self, bounds: tuple | None):
        self._sel = bounds
        self.update()

    def _fit(self):
        """(x, y, w, h) of the letterboxed image inside the widget."""
        if self._img is None or self._img.isNull():
            return None
        iw, ih = self._img.width(), self._img.height()
        scale = min(self.width() / iw, self.height() / ih)
        w, h = iw * scale, ih * scale
        return (self.width() - w) / 2, (self.height() - h) / 2, w, h

    def paintEvent(self, _):
        p = QPainter(self)
        p.fillRect(self.rect(), QColor(theme.BG))
        fit = self._fit()
        if fit is None:
            p.setPen(QColor(theme.TEXT_DIM))
            p.drawText(self.rect(), int(Qt.AlignmentFlag.AlignCenter),
                       "Capture to inspect the current screen")
            return
        x, y, w, h = fit
        p.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform)
        p.drawImage(int(x), int(y), self._img.scaled(
            int(w), int(h), Qt.AspectRatioMode.IgnoreAspectRatio,
            Qt.TransformationMode.SmoothTransformation))
        if self._sel:
            sx, sy = w / self._img.width(), h / self._img.height()
            l, t, r, b = self._sel
            pen = QPen(QColor(theme.ACCENT), 2)
            p.setPen(pen)
            p.setBrush(QColor(110, 123, 255, 40))
            p.drawRect(int(x + l * sx), int(y + t * sy),
                       int((r - l) * sx), int((b - t) * sy))

    def mousePressEvent(self, e):
        fit = self._fit()
        if fit is None:
            return
        x, y, w, h = fit
        px, py = e.position().x() - x, e.position().y() - y
        if 0 <= px < w and 0 <= py < h:
            self.clicked.emit(int(px * self._img.width() / w),
                              int(py * self._img.height() / h))


class InspectorView(QWidget):
    """Inspector tab: screenshot on the left, hierarchy tree + properties on
    the right; two-way selection between them."""
    status = pyqtSignal(str)
    failed = pyqtSignal(str)

    def __init__(self, adb: str, parent=None):
        super().__init__(parent)
        self._adb = adb or ""
        self._serial: str | None = None
        self._worker: InspectWorker | None = None
        self._root: UiNode | None = None
        self._node_items: dict = {}    # id(UiNode) -> QTreeWidgetItem
        self._build()

    def _build(self):
        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)
        bar = QWidget()
        bar.setObjectName("FilterBar")
        h = QHBoxLayout(bar)
        h.setContentsMargins(12, 8, 12, 8)
        h.setSpacing(8)
        self.capture_btn = QPushButton("📸  Capture")
        self.capture_btn.setToolTip(
            "Screenshot + uiautomator view-hierarchy dump of the current screen")
        self.capture_btn.clicked.connect(self.capture)
        h.addWidget(self.capture_btn)
        hint = QLabel("Click the screenshot or the tree to inspect a view")
        hint.setObjectName("MockStatus")
        h.addWidget(hint)
        h.addStretch(1)
        root.addWidget(bar)

        split = QSplitter(Qt.Orientation.Horizontal)
        self.canvas = _ShotCanvas()
        self.canvas.clicked.connect(self._on_canvas_click)
        split.addWidget(self.canvas)

        right = QSplitter(Qt.Orientation.Vertical)
        self.tree = QTreeWidget()
        self.tree.setHeaderLabels(["view"])
        self.tree.setHeaderHidden(True)
        self.tree.currentItemChanged.connect(self._on_tree_select)
        right.addWidget(self.tree)
        self.props = QTableWidget(0, 2)
        self.props.setHorizontalHeaderLabels(["property", "value"])
        self.props.horizontalHeader().setSectionResizeMode(
            1, QHeaderView.ResizeMode.Stretch)
        self.props.verticalHeader().setVisible(False)
        self.props.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        right.addWidget(self.props)
        right.setStretchFactor(0, 3)
        right.setStretchFactor(1, 2)
        split.addWidget(right)
        split.setStretchFactor(0, 1)
        split.setStretchFactor(1, 1)
        split.setSizes([420, 560])
        root.addWidget(split, 1)

    # --- lifecycle ---------------------------------------------------------------
    def set_serial(self, serial: str | None):
        if serial == self._serial:
            return
        self._serial = serial
        self._root = None
        self._node_items.clear()
        self.tree.clear()
        self.props.setRowCount(0)
        self.canvas.set_image(None)

    def shutdown(self):
        if self._worker is not None:
            self._worker.wait(2000)
            self._worker = None

    # --- capture -----------------------------------------------------------------
    def capture(self):
        if not self._adb or not self._serial:
            self.failed.emit("Inspector: no device selected")
            return
        if self._worker is not None:
            self.status.emit("A capture is already running…")
            return
        self.capture_btn.setEnabled(False)
        self.capture_btn.setText("Capturing…")
        self._worker = InspectWorker(self._adb, self._serial, self)
        self._worker.done.connect(self._on_captured)
        self._worker.start()

    def _on_captured(self, ok: bool, message: str, png: bytes, xml_text: str):
        self._worker = None
        self.capture_btn.setEnabled(True)
        self.capture_btn.setText("📸  Capture")
        if not ok:
            self.failed.emit(f"Inspector: {message}")
            return
        img = QImage.fromData(png, "PNG")
        self.canvas.set_image(img)
        self._root = build_ui_tree(xml_text)
        self._rebuild_tree()
        n = len(self._node_items)
        self.status.emit(f"Inspector: {n} views captured")

    def _rebuild_tree(self):
        self.tree.clear()
        self._node_items.clear()
        if self._root is None:
            return

        def add(node: UiNode, parent_item):
            item = QTreeWidgetItem([node.label])
            item.setData(0, Qt.ItemDataRole.UserRole, node)
            if parent_item is None:
                self.tree.addTopLevelItem(item)
            else:
                parent_item.addChild(item)
            self._node_items[id(node)] = item
            for c in node.children:
                add(c, item)

        for c in self._root.children:
            add(c, None)
        self.tree.expandToDepth(3)

    # --- selection ---------------------------------------------------------------
    def _on_canvas_click(self, x: int, y: int):
        if self._root is None:
            return
        node = node_at(self._root, x, y)
        item = self._node_items.get(id(node)) if node else None
        if item is not None:
            self.tree.setCurrentItem(item)
            self.tree.scrollToItem(item)

    def _on_tree_select(self, cur, _prev=None):
        node = cur.data(0, Qt.ItemDataRole.UserRole) if cur else None
        if node is None:
            return
        self.canvas.set_selection(node.bounds)
        show = [(k, v) for k, v in node.attrs.items() if v not in ("", "false")]
        show += [(k, v) for k, v in node.attrs.items() if v == "false"]
        self.props.setRowCount(len(show))
        for r, (k, v) in enumerate(show):
            self.props.setItem(r, 0, QTableWidgetItem(k))
            self.props.setItem(r, 1, QTableWidgetItem(v))
