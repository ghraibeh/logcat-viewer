"""Sleek dev-tool dark theme (Linear/Raycast-style): near-black elevation
layers, one electric-indigo accent, pill tabs, gradient primary actions.
Fusion base + dark palette + a hand-written stylesheet."""
from __future__ import annotations

from PyQt6.QtGui import QColor, QPalette

# Palette ---------------------------------------------------------------------
# Depth ladder: canvas → bar → control → hover. Keep the names stable — every
# module colors itself from these constants.
BG        = "#16171c"   # window canvas (near-black)
SURFACE   = "#1c1e24"   # toolbars / status / detail bars
SURFACE_2 = "#252831"   # inputs, buttons, chips
SURFACE_3 = "#2f3340"   # hover
BORDER    = "#272a34"   # hairline
BORDER_2  = "#3a3f4d"
TEXT      = "#e9ebf3"
TEXT_DIM  = "#7e8595"
ACCENT    = "#6e7bff"   # electric indigo
ACCENT_H  = "#8b96ff"
GREEN     = "#31c96e"
GREEN_H   = "#43dd80"
RED       = "#f25a52"
AMBER     = "#e3a812"

# Derived tokens (used only inside the stylesheet)
WELL        = "#121318"                      # input wells — sunken below any bar
SELECT      = "rgba(110, 123, 255, 0.22)"    # selection tint
SELECT_SOFT = "rgba(110, 123, 255, 0.13)"    # pill-tab / quiet selected tint
GRID        = "#0b0c10"                      # row separators on dense tables
GRAD_ACCENT   = f"qlineargradient(x1:0, y1:0, x2:0, y2:1, stop:0 #7f8bff, stop:1 #5f6cf5)"
GRAD_ACCENT_H = f"qlineargradient(x1:0, y1:0, x2:0, y2:1, stop:0 #99a2ff, stop:1 #707cff)"
GRAD_RED      = f"qlineargradient(x1:0, y1:0, x2:0, y2:1, stop:0 #ff6b60, stop:1 #e4463e)"


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

/* Inputs — sunken wells with a luminous focus ring */
QLineEdit {{
    background: {WELL};
    border: 1px solid {BORDER};
    border-radius: 8px;
    padding: 6px 10px;
    color: {TEXT};
    selection-background-color: {ACCENT};
    selection-color: #ffffff;
}}
QLineEdit:hover {{ border-color: {BORDER_2}; }}
QLineEdit:focus {{ border: 1px solid {ACCENT}; background: {WELL}; }}

QComboBox {{
    background: {SURFACE_2};
    border: 1px solid {BORDER};
    border-radius: 8px;
    padding: 6px 12px;
    min-width: 84px;
    color: {TEXT};
}}
QComboBox:hover {{ background: {SURFACE_3}; border-color: {BORDER_2}; }}
QComboBox:focus {{ border-color: {ACCENT}; }}
QComboBox::drop-down {{ border: none; width: 20px; }}
QComboBox QLineEdit {{
    border: none; background: transparent; padding: 0; margin: 0;
    color: {TEXT}; selection-background-color: {ACCENT}; selection-color: #ffffff;
}}
QComboBox QAbstractItemView {{
    background: {SURFACE_2};
    border: 1px solid {BORDER_2};
    border-radius: 10px;
    padding: 5px;
    selection-background-color: {ACCENT};
    selection-color: #ffffff;
    outline: none;
}}

/* Buttons — quiet chips; primary actions carry the gradient */
QPushButton {{
    background: {SURFACE_2};
    border: 1px solid {BORDER};
    border-radius: 8px;
    padding: 6px 14px;
    color: {TEXT};
}}
QPushButton:hover {{ background: {SURFACE_3}; border-color: {BORDER_2}; }}
QPushButton:pressed {{ background: {BORDER_2}; }}
QPushButton:disabled {{ color: {TEXT_DIM}; background: {SURFACE}; border-color: {BORDER}; }}
QPushButton:checked {{ border-color: {ACCENT}; }}

QPushButton#start {{
    background: {GRAD_ACCENT}; border: none; color: #ffffff;
    font-weight: 600; padding: 7px 16px;
}}
QPushButton#start:hover {{ background: {GRAD_ACCENT_H}; }}
QPushButton#start:disabled {{ background: {SURFACE_2}; color: {TEXT_DIM}; }}
QPushButton#start[running="true"] {{ background: {GRAD_RED}; color: #ffffff; }}

/* Small toggle pills (regex .*) */
QPushButton#toggle {{
    padding: 6px 9px; min-width: 0; font-family: Menlo, monospace; color: {TEXT_DIM};
    border-radius: 8px;
}}
QPushButton#toggle:checked {{
    background: {ACCENT}; border-color: {ACCENT}; color: #ffffff; font-weight: 600;
}}

QPushButton#pause:checked {{
    background: {AMBER}; border-color: {AMBER}; color: #17130a; font-weight: 600;
}}

/* Labelled toggle (Advanced filters) — a chip that fills when active */
QPushButton#advToggle:checked {{
    background: {SELECT_SOFT}; border-color: {ACCENT}; color: {ACCENT_H}; font-weight: 600;
}}

/* Checkboxes */
QCheckBox {{ color: {TEXT_DIM}; spacing: 7px; }}
QCheckBox::indicator {{
    width: 16px; height: 16px; border-radius: 5px;
    border: 1px solid {BORDER_2}; background: {WELL};
}}
QCheckBox::indicator:hover {{ border-color: {ACCENT}; }}
QCheckBox::indicator:checked {{ background: {ACCENT}; border-color: {ACCENT}; }}

/* Table */
QTableView {{
    background: {BG};
    border: none;
    gridline-color: transparent;
    selection-background-color: {SELECT};
    selection-color: {TEXT};
}}
QTableView::item {{ padding: 1px 6px; border: none; }}
QHeaderView::section {{
    background: {SURFACE};
    color: {TEXT_DIM};
    border: none;
    border-bottom: 1px solid {BORDER};
    border-right: 1px solid {BG};
    padding: 6px 8px;
    font-weight: 600;
    font-size: 11px;
    letter-spacing: 0.6px;
}}
QTableView QTableCornerButton::section {{ background: {SURFACE}; border: none; }}

/* Scrollbars — thin, rounded, quiet */
QScrollBar:vertical {{ background: transparent; width: 10px; margin: 0; }}
QScrollBar::handle:vertical {{
    background: {BORDER_2}; min-height: 32px; border-radius: 5px; margin: 2px;
}}
QScrollBar::handle:vertical:hover {{ background: #4b5262; }}
QScrollBar:horizontal {{ background: transparent; height: 10px; margin: 0; }}
QScrollBar::handle:horizontal {{
    background: {BORDER_2}; min-width: 32px; border-radius: 5px; margin: 2px;
}}
QScrollBar::handle:horizontal:hover {{ background: #4b5262; }}
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
    border: 1px solid {BORDER_2}; border-radius: 8px; padding: 5px 9px;
}}

/* Context menu */
QMenu {{
    background: {SURFACE_2}; border: 1px solid {BORDER_2};
    border-radius: 10px; padding: 6px;
}}
QMenu::item {{ padding: 6px 20px; border-radius: 6px; color: {TEXT}; }}
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
    background: {SURFACE}; padding: 7px 10px;
    border-bottom: 1px solid {BORDER}; text-align: left;
}}

/* Tabs — floating pill segments */
QTabWidget::pane {{ border: none; }}
QTabBar {{ background: {SURFACE}; qproperty-drawBase: 0; }}
QTabBar::tab {{
    background: transparent; color: {TEXT_DIM};
    padding: 6px 16px; border: none; border-radius: 8px;
    margin: 5px 3px;
}}
QTabBar::tab:first {{ margin-left: 8px; }}
QTabBar::tab:hover {{ color: {TEXT}; background: {SURFACE_3}; }}
QTabBar::tab:selected {{ color: {ACCENT_H}; background: {SELECT_SOFT}; font-weight: 600; }}

/* Filter bar (Logs tab) and mock-location control bar (Location tab) */
#FilterBar {{ background: {SURFACE}; border-bottom: 1px solid {BORDER}; }}
#FilterSep {{ background: {BORDER_2}; }}

/* Performance Monitor tab */
QLabel#MonHeading {{ font-size: 17px; font-weight: 700; color: {TEXT}; letter-spacing: 0.2px; }}
#MonCard {{ background: {SURFACE}; border: 1px solid {BORDER}; border-radius: 14px; }}
QLabel#MonCaption {{
    color: {TEXT_DIM}; font-weight: 700; letter-spacing: 1.2px; font-size: 11px;
}}
QLabel#MonValue {{ font-size: 31px; font-weight: 800; color: {TEXT}; }}
QLabel#MonSub {{ color: {TEXT_DIM}; font-family: Menlo, monospace; font-size: 12px; }}
QLabel#MonApp {{ font-family: Menlo, monospace; font-size: 12px; font-weight: 600; }}
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
#FlowTree::item:selected {{ background: {SELECT}; color: {TEXT}; }}
#FlowTree QHeaderView::section {{
    background: {SURFACE}; color: {TEXT_DIM}; border: none;
    border-bottom: 1px solid {BORDER}; padding: 3px 8px;
}}
#FlowSearch {{ background: {SURFACE}; border-bottom: 1px solid {BORDER}; }}

/* Request list: a thin dark separator between rows */
QTableView#FlowTable {{ gridline-color: {GRID}; }}

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
#DbTree::item {{ padding: 3px 2px; border-radius: 5px; }}
#DbTree::item:selected {{ background: {SELECT}; color: {TEXT}; }}
#DbTree QHeaderView::section {{
    background: {SURFACE}; color: {TEXT_DIM}; border: none;
    border-bottom: 1px solid {BORDER}; padding: 5px 8px; font-weight: 600;
}}
#DbEmpty {{ background: transparent; color: {TEXT_DIM}; padding: 24px; }}
QTableView#DbTable {{ gridline-color: {GRID}; }}
QTableView#DbTable QHeaderView::section {{
    background: {SURFACE}; color: {TEXT_DIM}; border: none;
    border-bottom: 1px solid {BORDER}; border-right: 1px solid {BG}; padding: 5px 8px;
}}

/* File Explorer tab */
#ExplorerCmdBar {{ background: {SURFACE}; border-bottom: 1px solid {BORDER}; }}
#ExplorerNavBar {{ background: {SURFACE}; border-bottom: 1px solid {BORDER}; }}
#CmdSep {{ color: {BORDER_2}; max-width: 1px; margin: 2px 6px; }}
QToolButton#CmdBtn {{
    background: transparent; color: {TEXT}; border: 1px solid transparent;
    border-radius: 8px; padding: 5px 10px; font-size: 12px;
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
    background: {WELL}; border: 1px solid {BORDER}; border-radius: 8px;
}}
#ExplorerCrumbs {{ background: transparent; }}
QPushButton#Crumb {{
    background: transparent; color: {TEXT}; border: none;
    border-radius: 6px; padding: 3px 7px; font-size: 12px; text-align: left;
}}
QPushButton#Crumb:hover {{ background: {SURFACE_3}; }}
#CrumbSep {{ color: {TEXT_DIM}; padding: 0 1px; }}
#ExplorerPathEdit {{
    background: {WELL}; color: {TEXT}; border: none; border-radius: 8px; padding: 4px 8px;
}}
#ExplorerSearch {{
    background: {WELL}; color: {TEXT}; border: 1px solid {BORDER};
    border-radius: 8px; padding: 4px 10px;
}}
#ExplorerSearch:focus {{ border: 1px solid {ACCENT}; }}
#ExplorerSidebar {{
    background: {SURFACE}; border: none; border-right: 1px solid {BORDER}; outline: none;
}}
#ExplorerSidebar::item {{ border-radius: 8px; padding: 5px 8px; margin: 1px 6px; }}
#ExplorerSidebar::item:hover {{ background: {SURFACE_3}; }}
#ExplorerSidebar::item:selected {{ background: {SELECT}; color: {TEXT}; }}
#ExplorerSidebar::item:disabled {{ color: {TEXT_DIM}; }}
#SideHeader {{
    color: {TEXT_DIM}; font-size: 11px; font-weight: 700; text-transform: uppercase;
    padding: 8px 14px 2px 14px; letter-spacing: 0.6px;
}}
QTableView#ExplorerTable {{
    background: {BG}; border: none; outline: none;
    selection-background-color: transparent;
}}
QTableView#ExplorerTable::item {{ padding: 2px 6px; border-radius: 5px; }}
QTableView#ExplorerTable::item:selected {{ background: {SELECT}; color: {TEXT}; }}
QTableView#ExplorerTable::item:hover {{ background: {SURFACE_2}; }}
QTableView#ExplorerTable QHeaderView::section {{
    background: {BG}; color: {TEXT_DIM}; border: none;
    border-bottom: 1px solid {BORDER}; padding: 6px 8px; font-weight: 600;
}}
#ExplorerGrid {{ background: {BG}; border: none; outline: none; }}
#ExplorerGrid::item {{ border-radius: 10px; padding: 6px 2px; color: {TEXT}; }}
#ExplorerGrid::item:hover {{ background: {SURFACE_2}; }}
#ExplorerGrid::item:selected {{ background: {SELECT}; color: {TEXT}; }}
#ExplorerStatus {{
    background: {SURFACE}; border-top: 1px solid {BORDER};
    color: {TEXT_DIM}; font-family: Menlo, monospace; font-size: 12px;
}}

/* Logs tab — left app-picker list */
#LogAppPanel {{ background: {BG}; }}
#LogAppBar {{ background: {SURFACE}; border-bottom: 1px solid {BORDER}; border-right: 1px solid {BORDER}; }}
#LogAppSearch {{
    background: {WELL}; color: {TEXT}; border: 1px solid {BORDER};
    border-radius: 8px; padding: 4px 8px;
}}
#LogAppSearch:focus {{ border: 1px solid {ACCENT}; }}
#LogAppList {{
    background: {BG}; border: none; border-right: 1px solid {BORDER}; outline: none;
}}
#LogAppList::item {{ border-radius: 8px; padding: 4px 6px; margin: 1px 5px; }}
#LogAppList::item:hover {{ background: {SURFACE_2}; }}
#LogAppList::item:selected {{ background: {SELECT}; color: {TEXT}; }}

/* App Management tab */
#AppMgrBar {{ background: {SURFACE}; border-bottom: 1px solid {BORDER}; }}
#AppMgrSubBar {{ background: {SURFACE}; border-bottom: 1px solid {BORDER}; }}
#AppMgrSearch {{
    background: {WELL}; color: {TEXT}; border: 1px solid {BORDER};
    border-radius: 8px; padding: 4px 8px;
}}
#AppMgrSearch:focus {{ border: 1px solid {ACCENT}; }}
#AppMgrList {{
    background: {BG}; border: none; border-right: 1px solid {BORDER}; outline: none;
}}
#AppMgrList::item {{ border-radius: 8px; padding: 5px 6px; margin: 1px 5px; }}
#AppMgrList::item:hover {{ background: {SURFACE_2}; }}
#AppMgrList::item:selected {{ background: {SELECT}; color: {TEXT}; }}
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
#AppMgrCompTree::item:selected {{ background: {SELECT}; color: {TEXT}; }}
#AppMgrCompTree QHeaderView::section {{
    background: {SURFACE}; color: {TEXT_DIM}; border: none;
    border-bottom: 1px solid {BORDER}; padding: 5px 8px; font-weight: 600;
}}
#AppMgrSig {{
    background: {BG}; border: none; color: {TEXT};
    font-family: Menlo, monospace; font-size: 12px; padding: 8px;
}}

/* Decompiled source viewer window */
#SrcViewer {{ background: {BG}; }}
#SrcBar {{ background: {SURFACE}; border-bottom: 1px solid {BORDER}; }}
#SrcPath {{ color: {TEXT_DIM}; font-family: Menlo, monospace; font-size: 11px; }}
#SrcFilter {{
    background: {WELL}; color: {TEXT}; border: 1px solid {BORDER};
    border-radius: 8px; padding: 4px 8px; min-width: 180px;
}}
#SrcFilter:focus {{ border: 1px solid {ACCENT}; }}
#SrcTree {{
    background: {BG}; border: none; border-right: 1px solid {BORDER}; outline: none;
}}
#SrcTree::item {{ padding: 2px 2px; }}
#SrcTree::item:selected {{ background: {SELECT}; color: {TEXT}; }}
QPlainTextEdit {{ background: {BG}; color: {TEXT}; border: none; }}

/* Transient "copied" toast */
#Toast {{
    background: {SURFACE_3}; color: {TEXT};
    border: 1px solid {BORDER_2}; border-radius: 10px;
    padding: 9px 18px; font-weight: 600;
}}

/* About dialog */
#AboutDialog {{ background: {BG}; }}
#AboutName {{ color: {TEXT}; font-size: 23px; font-weight: 800; letter-spacing: 0.2px; }}
#AboutVersion {{ color: {TEXT_DIM}; font-family: Menlo, monospace; font-size: 12px; }}
#AboutTagline {{ color: {TEXT_DIM}; font-size: 13px; }}
#AboutSep {{ background: {BORDER}; border: none; max-height: 1px; }}
#AboutFeatureTitle {{ font-size: 12px; }}
#AboutCreditLabel {{ color: {TEXT_DIM}; font-size: 12px; }}
#AboutAuthor {{ color: {ACCENT_H}; font-size: 16px; font-weight: 700; }}
#AboutContact a {{ color: {TEXT_DIM}; text-decoration: none; font-size: 12px; }}
#AboutContact a:hover {{ color: {ACCENT_H}; }}
#AboutMeta {{ color: {TEXT_DIM}; font-size: 11px; }}
QPushButton#AboutClose {{
    background: {GRAD_ACCENT}; border: none; color: #ffffff;
    font-weight: 600; padding: 7px 28px; border-radius: 8px;
}}
QPushButton#AboutClose:hover {{ background: {GRAD_ACCENT_H}; }}
QPushButton#AboutClose:pressed {{ background: {GRAD_ACCENT}; }}
"""


def apply(app) -> None:
    app.setStyle("Fusion")
    app.setPalette(_dark_palette())
    app.setStyleSheet(STYLESHEET)
