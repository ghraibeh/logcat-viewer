#!/bin/bash
# Launch AndroidLab using the project's virtualenv.
set -e
cd "$(dirname "$0")"
exec .venv/bin/python -m logcat_viewer "$@"
