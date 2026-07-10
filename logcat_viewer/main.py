"""App entry for PyInstaller and ``python -m logcat_viewer.main``."""
from __future__ import annotations

import sys

from logcat_viewer.__main__ import main

if __name__ == "__main__":
    sys.exit(main())
