"""Modern dark theme: Fusion base + dark palette + a hand-written stylesheet."""
from __future__ import annotations

from PyQt6.QtGui import QColor, QPalette

# Palette ---------------------------------------------------------------------
BG        = "#14161b"   # window background
SURFACE   = "#1b1e25"   # toolbar / status / detail
SURFACE_2 = "#232833"   # inputs, buttons
SURFACE_3 = "#2b313d"   # hover
BORDER    = "#2c323d"
BORDER_2  = "#39414f"
TEXT      = "#e2e6ee"
TEXT_DIM  = "#8b93a1"
ACCENT    = "#4f8cff"
ACCENT_H  = "#6ba0ff"
GREEN     = "#3fb950"
GREEN_H   = "#4fca61"
RED       = "#e5534b"
AMBER     = "#d9a400"


def _dark_palette() -> QPalette:
    p = QPalette()
    c = QColor
    p.setColor(QPalette.ColorRole.Window, c(BG))
    p.setColor(QPalette.ColorRole.WindowText, c(TEXT))
    p.setColor(QPalette.ColorRole.Base, c(SURFACE))
    p.setColor(QPalette.ColorRole.AlternateBase, c(SURFACE_2))
    p.setColor(QPalette.ColorRole.Text, c(TEXT))
    p.setColor(QPalette.ColorRole.Button, c(SURFACE_2))
    p.setColor(QPalette.ColorRole.ButtonText, c(TEXT))
    p.setColor(QPalette.ColorRole.ToolTipBase, c(SURFACE_2))
    p.setColor(QPalette.ColorRole.ToolTipText, c(TEXT))
    p.setColor(QPalette.ColorRole.PlaceholderText, c(TEXT_DIM))
    p.setColor(QPalette.ColorRole.Highlight, c(ACCENT))
    p.setColor(QPalette.ColorRole.HighlightedText, c("#ffffff"))
    p.setColor(QPalette.ColorRole.BrightText, c(RED))
    dim = c(TEXT_DIM)
    for grp in (QPalette.ColorGroup.Disabled,):
        p.setColor(grp, QPalette.ColorRole.Text, dim)
        p.setColor(grp, QPalette.ColorRole.ButtonText, dim)
        p.setColor(grp, QPalette.ColorRole.WindowText, dim)
    return p


STYLESHEET = f"""
* {{ outline: none; }}

QWidget {{
    background: {BG};
    color: {TEXT};
    font-family: -apple-system, "SF Pro Text", "Helvetica Neue", Arial;
    font-size: 13px;
}}

QLabel {{ background: transparent; color: {TEXT_DIM}; }}

/* Toolbar + filter bar container */
#Toolbar {{
    background: {SURFACE};
    border-bottom: 1px solid {BORDER};
}}
#Detail {{
    background: {SURFACE};
    border: none;
    border-top: 1px solid {BORDER};
    color: {TEXT_DIM};
    padding: 6px 10px;
}}

/* Inputs */
QLineEdit {{
    background: {SURFACE_2};
    border: 1px solid {BORDER};
    border-radius: 7px;
    padding: 5px 9px;
    color: {TEXT};
    selection-background-color: {ACCENT};
    selection-color: #ffffff;
}}
QLineEdit:hover {{ border-color: {BORDER_2}; }}
QLineEdit:focus {{ border-color: {ACCENT}; background: {SURFACE}; }}

QComboBox {{
    background: {SURFACE_2};
    border: 1px solid {BORDER};
    border-radius: 7px;
    padding: 5px 10px;
    min-width: 84px;
    color: {TEXT};
}}
QComboBox:hover {{ border-color: {BORDER_2}; }}
QComboBox:focus {{ border-color: {ACCENT}; }}
QComboBox::drop-down {{ border: none; width: 20px; }}
QComboBox QLineEdit {{
    border: none; background: transparent; padding: 0; margin: 0;
    color: {TEXT}; selection-background-color: {ACCENT}; selection-color: #ffffff;
}}
QComboBox QAbstractItemView {{
    background: {SURFACE_2};
    border: 1px solid {BORDER_2};
    border-radius: 8px;
    padding: 4px;
    selection-background-color: {ACCENT};
    selection-color: #ffffff;
    outline: none;
}}

/* Buttons */
QPushButton {{
    background: {SURFACE_2};
    border: 1px solid {BORDER};
    border-radius: 7px;
    padding: 5px 13px;
    color: {TEXT};
}}
QPushButton:hover {{ background: {SURFACE_3}; border-color: {BORDER_2}; }}
QPushButton:pressed {{ background: {BORDER}; }}
QPushButton:disabled {{ color: {TEXT_DIM}; background: {SURFACE}; }}

QPushButton#start {{
    background: {GREEN}; border: 1px solid {GREEN}; color: #08130a; font-weight: 600;
}}
QPushButton#start:hover {{ background: {GREEN_H}; border-color: {GREEN_H}; }}
QPushButton#start[running="true"] {{
    background: {RED}; border-color: {RED}; color: #1a0605;
}}

/* Small toggle pills (regex .*) */
QPushButton#toggle {{
    padding: 5px 8px; min-width: 0; font-family: Menlo, monospace; color: {TEXT_DIM};
}}
QPushButton#toggle:checked {{
    background: {ACCENT}; border-color: {ACCENT}; color: #ffffff; font-weight: 600;
}}

QPushButton#pause:checked {{
    background: {AMBER}; border-color: {AMBER}; color: #17130a; font-weight: 600;
}}

/* Auto-scroll checkbox */
QCheckBox {{ color: {TEXT_DIM}; spacing: 6px; }}
QCheckBox::indicator {{
    width: 16px; height: 16px; border-radius: 5px;
    border: 1px solid {BORDER_2}; background: {SURFACE_2};
}}
QCheckBox::indicator:checked {{ background: {ACCENT}; border-color: {ACCENT}; }}

/* Table */
QTableView {{
    background: {BG};
    border: none;
    gridline-color: transparent;
    selection-background-color: rgba(79, 140, 255, 0.20);
    selection-color: {TEXT};
}}
QTableView::item {{ padding: 1px 6px; border: none; }}
QHeaderView::section {{
    background: {SURFACE};
    color: {TEXT_DIM};
    border: none;
    border-bottom: 1px solid {BORDER};
    border-right: 1px solid {BG};
    padding: 5px 8px;
    font-weight: 600;
}}
QTableView QTableCornerButton::section {{ background: {SURFACE}; border: none; }}

/* Scrollbars */
QScrollBar:vertical {{ background: transparent; width: 12px; margin: 0; }}
QScrollBar::handle:vertical {{
    background: {BORDER_2}; min-height: 32px; border-radius: 5px; margin: 2px;
}}
QScrollBar::handle:vertical:hover {{ background: #4a5568; }}
QScrollBar:horizontal {{ background: transparent; height: 12px; margin: 0; }}
QScrollBar::handle:horizontal {{
    background: {BORDER_2}; min-width: 32px; border-radius: 5px; margin: 2px;
}}
QScrollBar::handle:horizontal:hover {{ background: #4a5568; }}
QScrollBar::add-line, QScrollBar::sub-line {{ width: 0; height: 0; }}
QScrollBar::add-page, QScrollBar::sub-page {{ background: transparent; }}

/* Status bar */
QStatusBar {{
    background: {SURFACE};
    border-top: 1px solid {BORDER};
    color: {TEXT_DIM};
    font-family: Menlo, monospace;
    font-size: 12px;
}}
QStatusBar::item {{ border: none; }}

QToolTip {{
    background: {SURFACE_2}; color: {TEXT};
    border: 1px solid {BORDER_2}; border-radius: 6px; padding: 4px 7px;
}}

/* Context menu */
QMenu {{
    background: {SURFACE_2}; border: 1px solid {BORDER_2};
    border-radius: 8px; padding: 5px;
}}
QMenu::item {{ padding: 6px 18px; border-radius: 5px; color: {TEXT}; }}
QMenu::item:selected {{ background: {ACCENT}; color: #ffffff; }}
QMenu::item:disabled {{ color: {TEXT_DIM}; }}
QMenu::separator {{ height: 1px; background: {BORDER}; margin: 5px 8px; }}

QLabel#fontLabel {{
    color: {TEXT}; min-width: 22px; qproperty-alignment: AlignCenter;
    font-family: Menlo, monospace;
}}

/* Screen-mirror dock */
QDockWidget {{ color: {TEXT_DIM}; titlebar-close-icon: none; titlebar-normal-icon: none; }}
QDockWidget::title {{
    background: {SURFACE}; padding: 6px 10px;
    border-bottom: 1px solid {BORDER}; text-align: left;
}}
"""


def apply(app) -> None:
    app.setStyle("Fusion")
    app.setPalette(_dark_palette())
    app.setStyleSheet(STYLESHEET)
