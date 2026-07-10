"""Custom painting: a rounded level badge, and a message column that wraps to
multiple lines with a *tight* row height (no global word-wrap inflation)."""
from __future__ import annotations

from PyQt6.QtCore import QRectF, QSize, Qt
from PyQt6.QtGui import QColor, QFont, QFontMetrics, QPainter
from PyQt6.QtWidgets import QStyle, QStyledItemDelegate, QStyleOptionViewItem

from .colors import BADGE, BADGE_TEXT

# Wrap at word boundaries, but also break very long unbroken tokens (URLs).
WRAP_FLAGS = int(Qt.TextFlag.TextWordWrap | Qt.TextFlag.TextWrapAnywhere)


def _selection_fill(painter, option):
    """Translucent accent, matching the stylesheet's selection-background-color
    so delegate-painted cells blend with the default-painted ones."""
    if option.state & QStyle.StateFlag.State_Selected:
        c = QColor(option.palette.highlight().color())
        c.setAlpha(51)  # ~0.20
        painter.fillRect(option.rect, c)


class LevelBadgeDelegate(QStyledItemDelegate):
    def paint(self, painter: QPainter, option, index):
        level = index.data(Qt.ItemDataRole.DisplayRole) or "?"
        painter.save()
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        _selection_fill(painter, option)

        color = BADGE.get(level, BADGE["?"])
        w, h = 20, 16
        x = option.rect.x() + (option.rect.width() - w) / 2
        y = option.rect.y() + 3          # top-align so it lines up with wrapped text
        chip = QRectF(x, y, w, h)
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(color)
        painter.drawRoundedRect(chip, 5, 5)

        f = QFont(painter.font())
        f.setPointSize(10)
        f.setBold(True)
        painter.setFont(f)
        painter.setPen(BADGE_TEXT)
        painter.drawText(chip, Qt.AlignmentFlag.AlignCenter, level)
        painter.restore()


class MessageDelegate(QStyledItemDelegate):
    """Wraps the message across lines (when enabled) and reports a tight height."""

    H_PAD = 6
    V_PAD = 3

    def __init__(self, table, column: int, parent=None):
        super().__init__(parent or table)
        self._table = table
        self._column = column
        self.wrap = True

    def _width(self) -> int:
        return max(40, self._table.columnWidth(self._column))

    def paint(self, painter: QPainter, option, index):
        opt = QStyleOptionViewItem(option)
        self.initStyleOption(opt, index)
        painter.save()
        _selection_fill(painter, opt)

        text = index.data(Qt.ItemDataRole.DisplayRole) or ""
        color = index.data(Qt.ItemDataRole.ForegroundRole) or opt.palette.text().color()
        painter.setPen(color)
        painter.setFont(opt.font)
        rect = opt.rect.adjusted(self.H_PAD, self.V_PAD, -self.H_PAD, -self.V_PAD)
        if self.wrap:
            flags = WRAP_FLAGS | int(Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignLeft)
            painter.drawText(QRectF(rect), flags, text)
        else:
            # Full text, no elide — the column is sized to content so the table
            # scrolls horizontally to reveal long lines.
            painter.drawText(rect, int(Qt.AlignmentFlag.AlignVCenter | Qt.AlignmentFlag.AlignLeft),
                             text)
        painter.restore()

    def sizeHint(self, option, index):
        fm = QFontMetrics(self._table.font())
        if not self.wrap:
            return QSize(0, fm.height() + 2 * self.V_PAD)
        text = index.data(Qt.ItemDataRole.DisplayRole) or ""
        w = self._width() - 2 * self.H_PAD
        r = fm.boundingRect(0, 0, max(1, w), 1_000_000,
                            WRAP_FLAGS | int(Qt.AlignmentFlag.AlignTop), text)
        return QSize(self._width(), r.height() + 2 * self.V_PAD)
