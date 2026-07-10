"""Entry point: python -m logcat_viewer"""
from __future__ import annotations

import sys

from PyQt6.QtWidgets import QApplication

from . import theme
from .ui import MainWindow


def main() -> int:
    app = QApplication(sys.argv)
    app.setApplicationName("Logcat Viewer")
    theme.apply(app)
    win = MainWindow()
    win.show()
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
