"""Entry point: python -m logcat_viewer"""
from __future__ import annotations

import sys

from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import QApplication

from . import theme
from .about import APP_NAME
from .ui import MainWindow


_DEPRECATION_NOTICE = (
    "\n"
    "  ┌───────────────────────────────────────────────────────────────────┐\n"
    "  │  DEPRECATED: the Python (PyQt6) AndroidLab is no longer maintained. │\n"
    "  │  Active development has moved to the Electron app in                │\n"
    "  │  androidlab-electron/  (cd androidlab-electron && npm run dev).     │\n"
    "  └───────────────────────────────────────────────────────────────────┘\n"
)


def main() -> int:
    print(_DEPRECATION_NOTICE, file=sys.stderr)
    if getattr(sys, "frozen", False):
        import multiprocessing
        multiprocessing.freeze_support()
    # QtWebEngine (Location tab map) shares GL contexts with the app; this must
    # be set before the QApplication is created.
    QApplication.setAttribute(Qt.ApplicationAttribute.AA_ShareOpenGLContexts, True)
    app = QApplication(sys.argv)
    app.setApplicationName(APP_NAME)
    theme.apply(app)
    win = MainWindow()
    win.show()
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
