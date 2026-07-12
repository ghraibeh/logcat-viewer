"""About dialog: app identity, version, feature summary, and author credit.

A self-contained, dark-themed ``QDialog`` with a drawn app logo (no external
image asset). Reached from the menu (App menu → *About Logcat Viewer* on macOS)
and the toolbar's info button. Styling lives under the ``#About*`` selectors in
``theme.py``; the logo colors reuse the theme palette constants.
"""
from __future__ import annotations

from PyQt6.QtCore import Qt, QUrl
from PyQt6.QtGui import (
    QColor,
    QDesktopServices,
    QFont,
    QLinearGradient,
    QPainter,
    QPainterPath,
    QPen,
    QPixmap,
)
from PyQt6.QtWidgets import (
    QDialog,
    QFrame,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from . import __version__
from . import theme

APP_NAME = "Logcat Viewer"
TAGLINE = "Live Android logcat, powerful filtering, and a full device toolkit."
AUTHOR = "Mahmoud Alghraibeh"
CONTACT = "M.Ghraibeh@penguinin.com"
COPYRIGHT_YEAR = 2026
BUILT_WITH = "Built with Python · PyQt6 · adb"

# (accent-dot color, title, one-line description)
FEATURES = [
    (theme.ACCENT, "Live logs", "Stream & filter adb logcat by level, tag, PID, regex"),
    (theme.GREEN, "Screen mirror", "H.264 mirroring, screenshots, and recording"),
    (theme.AMBER, "Device tools", "Mock GPS, HTTP intercept, SQLite & file explorer"),
    (theme.RED, "App manager", "Permissions, components, app-ops, APK decompile"),
]


def logo_pixmap(size: int = 76) -> QPixmap:
    """A crisp, self-drawn app mark: a rounded gradient badge with a terminal
    ``>_`` prompt. Supersampled and tagged with a device-pixel-ratio so it stays
    sharp on HiDPI displays."""
    ratio = 3
    s = size * ratio
    pm = QPixmap(s, s)
    pm.fill(Qt.GlobalColor.transparent)
    p = QPainter(pm)
    p.setRenderHint(QPainter.RenderHint.Antialiasing)

    grad = QLinearGradient(0, 0, s, s)
    grad.setColorAt(0.0, QColor(theme.ACCENT_H))
    grad.setColorAt(1.0, QColor("#2f63c8"))
    p.setBrush(grad)
    p.setPen(Qt.PenStyle.NoPen)
    radius = s * 0.24
    p.drawRoundedRect(0, 0, s, s, radius, radius)

    # ">_" prompt drawn as rounded strokes.
    pen = QPen(QColor("#ffffff"))
    pen.setWidthF(s * 0.065)
    pen.setCapStyle(Qt.PenCapStyle.RoundCap)
    pen.setJoinStyle(Qt.PenJoinStyle.RoundJoin)
    p.setPen(pen)
    p.setBrush(Qt.BrushStyle.NoBrush)

    chevron = QPainterPath()
    chevron.moveTo(s * 0.26, s * 0.34)
    chevron.lineTo(s * 0.46, s * 0.50)
    chevron.lineTo(s * 0.26, s * 0.66)
    p.drawPath(chevron)

    # underscore / cursor
    p.drawLine(int(s * 0.54), int(s * 0.66), int(s * 0.74), int(s * 0.66))
    p.end()

    pm.setDevicePixelRatio(ratio)
    return pm


class AboutDialog(QDialog):
    """Modal-but-lightweight About window. Constructed lazily by the caller."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setObjectName("AboutDialog")
        self.setWindowTitle(f"About {APP_NAME}")
        self.setModal(True)
        self.setFixedWidth(500)

        root = QVBoxLayout(self)
        root.setContentsMargins(40, 32, 40, 24)
        root.setSpacing(0)

        # --- Header: logo + identity ---------------------------------------
        logo = QLabel()
        logo.setPixmap(logo_pixmap(76))
        logo.setAlignment(Qt.AlignmentFlag.AlignCenter)
        root.addWidget(logo)
        root.addSpacing(14)

        name = QLabel(APP_NAME)
        name.setObjectName("AboutName")
        name.setAlignment(Qt.AlignmentFlag.AlignCenter)
        root.addWidget(name)

        version = QLabel(f"Version {__version__}")
        version.setObjectName("AboutVersion")
        version.setAlignment(Qt.AlignmentFlag.AlignCenter)
        root.addWidget(version)
        root.addSpacing(10)

        tagline = QLabel(TAGLINE)
        tagline.setObjectName("AboutTagline")
        tagline.setAlignment(Qt.AlignmentFlag.AlignCenter)
        tagline.setWordWrap(True)
        root.addWidget(tagline)
        root.addSpacing(20)

        root.addWidget(self._separator())
        root.addSpacing(16)

        # --- Feature list (one line each; robust against wrapping) ----------
        features = QVBoxLayout()
        features.setContentsMargins(6, 0, 6, 0)
        features.setSpacing(11)
        for color, title, desc in FEATURES:
            features.addLayout(self._feature_row(color, title, desc))
        root.addLayout(features)
        root.addSpacing(18)

        root.addWidget(self._separator())
        root.addSpacing(16)

        # --- Author credit --------------------------------------------------
        credit = QLabel("Designed & developed by")
        credit.setObjectName("AboutCreditLabel")
        credit.setAlignment(Qt.AlignmentFlag.AlignCenter)
        root.addWidget(credit)

        author = QLabel(AUTHOR)
        author.setObjectName("AboutAuthor")
        author.setAlignment(Qt.AlignmentFlag.AlignCenter)
        root.addWidget(author)
        root.addSpacing(2)

        contact = QLabel(
            f'<a href="mailto:{CONTACT}" '
            f'style="color:{theme.TEXT_DIM}; text-decoration:none">{CONTACT}</a>')
        contact.setObjectName("AboutContact")
        contact.setAlignment(Qt.AlignmentFlag.AlignCenter)
        contact.setOpenExternalLinks(False)
        contact.linkActivated.connect(
            lambda href: QDesktopServices.openUrl(QUrl(href)))
        root.addWidget(contact)
        root.addSpacing(16)

        meta = QLabel(f"{BUILT_WITH}\n© {COPYRIGHT_YEAR} {AUTHOR}. All rights reserved.")
        meta.setObjectName("AboutMeta")
        meta.setAlignment(Qt.AlignmentFlag.AlignCenter)
        root.addWidget(meta)
        root.addSpacing(20)

        # --- Buttons --------------------------------------------------------
        buttons = QHBoxLayout()
        buttons.addStretch(1)
        close = QPushButton("Close")
        close.setObjectName("AboutClose")
        close.setDefault(True)
        close.clicked.connect(self.accept)
        buttons.addWidget(close)
        buttons.addStretch(1)
        root.addLayout(buttons)

    # -- helpers ------------------------------------------------------------
    @staticmethod
    def _separator() -> QFrame:
        line = QFrame()
        line.setObjectName("AboutSep")
        line.setFrameShape(QFrame.Shape.HLine)
        line.setFixedHeight(1)
        return line

    def _feature_row(self, color: str, title: str, desc: str) -> QHBoxLayout:
        row = QHBoxLayout()
        row.setContentsMargins(0, 0, 0, 0)
        row.setSpacing(10)
        row.addWidget(self._dot(color), 0, Qt.AlignmentFlag.AlignVCenter)
        label = QLabel(
            f'<span style="color:{theme.TEXT}; font-weight:600">{title}</span>'
            f'&nbsp;&nbsp;<span style="color:{theme.TEXT_DIM}">{desc}</span>')
        label.setObjectName("AboutFeatureTitle")
        label.setWordWrap(True)
        row.addWidget(label, 1)
        return row

    @staticmethod
    def _dot(color: str) -> QWidget:
        dot = QLabel()
        dot.setFixedSize(9, 9)
        dot.setStyleSheet(f"background: {color}; border-radius: 4px;")
        return dot


def show_about(parent=None) -> None:
    """Open (and center on the parent) a fresh About dialog."""
    dlg = AboutDialog(parent)
    dlg.exec()
