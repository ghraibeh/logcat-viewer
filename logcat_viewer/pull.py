"""Background worker that pulls an installed app's APK(s) off the device."""
from __future__ import annotations

import os
import subprocess

from PyQt6.QtCore import QThread, pyqtSignal

from . import apps as applib


class PullWorker(QThread):
    # ok, human-readable message, destination directory
    done = pyqtSignal(bool, str, str)

    def __init__(self, adb, serial, package, dest_root, clone_host=None, parent=None):
        super().__init__(parent)
        self._adb = adb
        self._serial = serial
        self._package = package
        self._dest_root = dest_root
        self._host = clone_host

    def run(self):
        remotes = applib.apk_paths_on_device(self._adb, self._serial, self._package)
        if not remotes and self._host:
            remotes = applib.clone_apk_paths(self._adb, self._serial, self._package, self._host)
        if not remotes:
            self.done.emit(False, f"No APK found on device for {self._package}", "")
            return

        dest = os.path.join(self._dest_root, self._package)
        try:
            os.makedirs(dest, exist_ok=True)
        except OSError as exc:
            self.done.emit(False, f"Cannot create {dest}: {exc}", "")
            return

        pulled, errors = [], []
        for remote in remotes:
            name = os.path.basename(remote)
            local = os.path.join(dest, name)
            try:
                res = subprocess.run(
                    [self._adb, "-s", self._serial, "pull", remote, local],
                    capture_output=True, text=True, timeout=180)
            except (subprocess.SubprocessError, OSError) as exc:
                errors.append(f"{name}: {exc}")
                continue
            if res.returncode == 0 and os.path.exists(local):
                pulled.append(name)
            else:
                detail = (res.stderr or res.stdout or "").strip().splitlines()
                errors.append(f"{name}: {detail[-1] if detail else 'pull failed'}")

        ok = bool(pulled) and not errors
        if pulled:
            msg = f"Pulled {len(pulled)} file(s): {', '.join(pulled)}"
            if errors:
                msg += f"  ({len(errors)} failed: " + "; ".join(errors) + ")"
        else:
            msg = "Pull failed: " + "; ".join(errors)
        self.done.emit(ok, msg, dest)
