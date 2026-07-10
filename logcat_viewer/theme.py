"""Modern dark theme: Fusion base + dark palette + a hand-written stylesheet."""
from __future__ import annotations

from PyQt6.QtGui import QColor, QPalette

# Palette ---------------------------------------------------------------------
BG        = "#24262b"   # window background (neutral dark gray)
SURFACE   = "#2c2f34"   # toolbar / status / detail
SURFACE_2 = "#363a41"   # inputs, buttons
SURFACE_3 = "#424852"   # hover
BORDER    = "#3d434c"
BORDER_2  = "#4d5560"
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

/* Tabs (Logs | Location) */
QTabWidget::pane {{ border: none; }}
QTabBar {{ background: {SURFACE}; qproperty-drawBase: 0; }}
QTabBar::tab {{
    background: transparent; color: {TEXT_DIM};
    padding: 7px 18px; border: none; border-bottom: 2px solid transparent;
}}
QTabBar::tab:hover {{ color: {TEXT}; }}
QTabBar::tab:selected {{ color: {TEXT}; border-bottom: 2px solid {ACCENT}; }}

/* Filter bar (Logs tab) and mock-location control bar (Location tab) */
#FilterBar {{ background: {SURFACE}; border-bottom: 1px solid {BORDER}; }}
#MockBar {{ background: {SURFACE}; border-top: 1px solid {BORDER}; }}
#MockStatus {{ color: {TEXT_DIM}; font-family: Menlo, monospace; font-size: 12px; }}

/* Network Intercept tab control bar */
#InterceptBar {{ background: {SURFACE}; border-top: 1px solid {BORDER}; }}
#InterceptStatus {{ color: {TEXT_DIM}; font-family: Menlo, monospace; font-size: 12px; }}

/* Network Intercept — flow detail (summary bar + request/response cards) */
#FlowSummary {{
    background: {SURFACE}; border-top: 1px solid {BORDER}; border-bottom: 1px solid {BORDER};
}}
#FlowUrl {{ color: {TEXT}; font-family: Menlo, monospace; font-size: 12px; }}
#FlowMeta {{ color: {TEXT_DIM}; font-family: Menlo, monospace; font-size: 11px; }}
#FlowSection {{ background: {SURFACE_2}; border-bottom: 1px solid {BORDER}; }}
#FlowSectionTitle {{ color: {TEXT_DIM}; font-weight: 700; font-size: 11px; }}
#FlowHeaders {{
    background: {BG}; border: none; border-bottom: 1px solid {BORDER}; padding: 4px 10px;
}}
#FlowBody {{ background: {BG}; border: none; }}
#FlowTree {{ background: {BG}; border: none; outline: none; }}
#FlowTree::item {{ padding: 2px 0; }}
#FlowTree::item:selected {{ background: rgba(79, 140, 255, 0.20); color: {TEXT}; }}
#FlowTree QHeaderView::section {{
    background: {SURFACE}; color: {TEXT_DIM}; border: none;
    border-bottom: 1px solid {BORDER}; padding: 3px 8px;
}}
#FlowSearch {{ background: {SURFACE}; border-bottom: 1px solid {BORDER}; }}

/* Request list: a thin dark separator between rows */
QTableView#FlowTable {{ gridline-color: #0c0e12; }}

/* Database Inspector tab */
#DbBar {{ background: {SURFACE}; border-bottom: 1px solid {BORDER}; }}
#DbApp {{ color: {TEXT}; font-family: Menlo, monospace; font-size: 12px; }}
#DbQueryBar {{ background: {SURFACE}; border-bottom: 1px solid {BORDER}; }}
#DbPageBar {{ background: {SURFACE}; border-top: 1px solid {BORDER}; }}
#DbStatus {{ color: {TEXT_DIM}; font-family: Menlo, monospace; font-size: 12px; }}
#DbSearchBar {{ background: {SURFACE}; border-bottom: 1px solid {BORDER}; border-right: 1px solid {BORDER}; }}
QProgressBar#DbBusy {{ background: {SURFACE_2}; border: none; max-height: 3px; min-height: 3px; }}
QProgressBar#DbBusy::chunk {{ background: {ACCENT}; }}
#DbTree {{
    background: {BG}; border: none; border-right: 1px solid {BORDER}; outline: none;
}}
#DbTree::item {{ padding: 3px 2px; }}
#DbTree::item:selected {{ background: rgba(79, 140, 255, 0.20); color: {TEXT}; }}
#DbTree QHeaderView::section {{
    background: {SURFACE}; color: {TEXT_DIM}; border: none;
    border-bottom: 1px solid {BORDER}; padding: 5px 8px; font-weight: 600;
}}
QTableView#DbTable {{ gridline-color: #0c0e12; }}
QTableView#DbTable QHeaderView::section {{
    background: {SURFACE}; color: {TEXT_DIM}; border: none;
    border-bottom: 1px solid {BORDER}; border-right: 1px solid {BG}; padding: 5px 8px;
}}

/* File Explorer tab — Windows-11-Explorer styling on the dark palette */
#ExplorerCmdBar {{ background: {SURFACE}; border-bottom: 1px solid {BORDER}; }}
#ExplorerNavBar {{ background: {SURFACE}; border-bottom: 1px solid {BORDER}; }}
#CmdSep {{ color: {BORDER_2}; max-width: 1px; margin: 2px 6px; }}
QToolButton#CmdBtn {{
    background: transparent; color: {TEXT}; border: 1px solid transparent;
    border-radius: 6px; padding: 5px 10px; font-size: 12px;
}}
QToolButton#CmdBtn:hover {{ background: {SURFACE_3}; }}
QToolButton#CmdBtn:pressed {{ background: {SURFACE_2}; }}
QToolButton#CmdBtn:disabled {{ color: {TEXT_DIM}; }}
QToolButton#CmdBtn::menu-indicator {{ image: none; width: 0; }}
QToolButton#NavBtn {{
    background: transparent; border: none; border-radius: 15px;
    min-width: 30px; max-width: 30px; min-height: 30px; max-height: 30px;
}}
QToolButton#NavBtn:hover {{ background: {SURFACE_3}; }}
QToolButton#NavBtn:pressed {{ background: {SURFACE_2}; }}
QToolButton#NavBtn:disabled {{ background: transparent; }}
#ExplorerAddress {{
    background: {BG}; border: 1px solid {BORDER}; border-radius: 6px;
}}
#ExplorerCrumbs {{ background: transparent; }}
QPushButton#Crumb {{
    background: transparent; color: {TEXT}; border: none;
    border-radius: 4px; padding: 3px 7px; font-size: 12px; text-align: left;
}}
QPushButton#Crumb:hover {{ background: {SURFACE_3}; }}
#CrumbSep {{ color: {TEXT_DIM}; padding: 0 1px; }}
#ExplorerPathEdit {{
    background: {BG}; color: {TEXT}; border: none; border-radius: 6px; padding: 4px 8px;
}}
#ExplorerSearch {{
    background: {BG}; color: {TEXT}; border: 1px solid {BORDER};
    border-radius: 6px; padding: 4px 10px;
}}
#ExplorerSearch:focus {{ border: 1px solid {ACCENT}; }}
#ExplorerSidebar {{
    background: {SURFACE}; border: none; border-right: 1px solid {BORDER}; outline: none;
}}
#ExplorerSidebar::item {{ border-radius: 6px; padding: 5px 8px; margin: 1px 6px; }}
#ExplorerSidebar::item:hover {{ background: {SURFACE_3}; }}
#ExplorerSidebar::item:selected {{ background: rgba(79, 140, 255, 0.22); color: {TEXT}; }}
#ExplorerSidebar::item:disabled {{ color: {TEXT_DIM}; }}
#SideHeader {{
    color: {TEXT_DIM}; font-size: 11px; font-weight: 700; text-transform: uppercase;
    padding: 8px 14px 2px 14px; letter-spacing: 0.4px;
}}
QTableView#ExplorerTable {{
    background: {BG}; border: none; outline: none;
    selection-background-color: transparent;
}}
QTableView#ExplorerTable::item {{ padding: 2px 6px; border-radius: 4px; }}
QTableView#ExplorerTable::item:selected {{ background: rgba(79, 140, 255, 0.22); color: {TEXT}; }}
QTableView#ExplorerTable::item:hover {{ background: {SURFACE_2}; }}
QTableView#ExplorerTable QHeaderView::section {{
    background: {BG}; color: {TEXT_DIM}; border: none;
    border-bottom: 1px solid {BORDER}; padding: 6px 8px; font-weight: 600;
}}
#ExplorerGrid {{ background: {BG}; border: none; outline: none; }}
#ExplorerGrid::item {{ border-radius: 8px; padding: 6px 2px; color: {TEXT}; }}
#ExplorerGrid::item:hover {{ background: {SURFACE_2}; }}
#ExplorerGrid::item:selected {{ background: rgba(79, 140, 255, 0.22); color: {TEXT}; }}
#ExplorerStatus {{
    background: {SURFACE}; border-top: 1px solid {BORDER};
    color: {TEXT_DIM}; font-family: Menlo, monospace; font-size: 12px;
}}

/* App Management tab */
#AppMgrBar {{ background: {SURFACE}; border-bottom: 1px solid {BORDER}; }}
#AppMgrSearch {{
    background: {BG}; color: {TEXT}; border: 1px solid {BORDER};
    border-radius: 6px; padding: 4px 8px;
}}
#AppMgrSearch:focus {{ border: 1px solid {ACCENT}; }}
#AppMgrList {{
    background: {BG}; border: none; border-right: 1px solid {BORDER}; outline: none;
}}
#AppMgrList::item {{ border-radius: 6px; padding: 5px 6px; margin: 1px 4px; }}
#AppMgrList::item:hover {{ background: {SURFACE_2}; }}
#AppMgrList::item:selected {{ background: rgba(79, 140, 255, 0.22); color: {TEXT}; }}
#AppMgrCount {{
    background: {SURFACE}; border-top: 1px solid {BORDER}; border-right: 1px solid {BORDER};
    color: {TEXT_DIM}; font-family: Menlo, monospace; font-size: 11px; padding: 4px 10px;
}}
#AppMgrHeader {{ background: {SURFACE}; border-bottom: 1px solid {BORDER}; }}
#AppMgrTitle {{ color: {TEXT}; font-size: 15px; font-weight: 700; }}
#AppMgrSubtitle {{ color: {TEXT_DIM}; font-family: Menlo, monospace; font-size: 11px; }}
#AppMgrInfo, #AppMgrPermTable, #AppMgrOpsTable {{
    background: {BG}; border: none; outline: none; gridline-color: {BG};
}}
#AppMgrInfo::item, #AppMgrPermTable::item, #AppMgrOpsTable::item {{ padding: 4px 6px; }}
#AppMgrPermTable QHeaderView::section, #AppMgrOpsTable QHeaderView::section {{
    background: {SURFACE}; color: {TEXT_DIM}; border: none;
    border-bottom: 1px solid {BORDER}; padding: 5px 8px; font-weight: 600;
}}
#AppMgrCompTree {{ background: {BG}; border: none; outline: none; }}
#AppMgrCompTree::item {{ padding: 3px 2px; }}
#AppMgrCompTree::item:selected {{ background: rgba(79, 140, 255, 0.20); color: {TEXT}; }}
#AppMgrCompTree QHeaderView::section {{
    background: {SURFACE}; color: {TEXT_DIM}; border: none;
    border-bottom: 1px solid {BORDER}; padding: 5px 8px; font-weight: 600;
}}
#AppMgrSig {{
    background: {BG}; border: none; color: {TEXT};
    font-family: Menlo, monospace; font-size: 12px; padding: 8px;
}}

/* Transient "copied" toast */
#Toast {{
    background: {SURFACE_3}; color: {TEXT};
    border: 1px solid {BORDER_2}; border-radius: 9px;
    padding: 8px 16px; font-weight: 600;
}}
"""


def apply(app) -> None:
    app.setStyle("Fusion")
    app.setPalette(_dark_palette())
    app.setStyleSheet(STYLESHEET)
