"""App Management tab — an App-Manager-style view of installed apps.

Lists every installed package (user + system) and, for a selected app, shows a
rich detail pane split into **Info · Permissions · Components · App Ops ·
Signature** and offers per-app actions: **Launch · Force-stop · Clear data ·
Enable/Disable (freeze) · Uninstall · Extract APK · App Info**.

Everything is adb-only (no root required; a rooted ``su`` helps for some
sizes/paths). Mirrors ``dbinspect.py``/``files.py``: pure command builders +
parsers (Qt-free, smoke-tested) + ``QThread`` workers that never block the UI +
an ``AppManagerView`` that follows the shared device combo / App picker.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field

from PyQt6.QtCore import Qt, QThread, pyqtSignal, QSize, QRect, QPoint
from PyQt6.QtGui import QColor, QIcon, QImage, QPainter, QPixmap, QFont
from PyQt6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QSplitter, QListWidget, QListWidgetItem,
    QTableWidget, QTableWidgetItem, QTreeWidget, QTreeWidgetItem, QLineEdit,
    QPushButton, QComboBox, QLabel, QTabWidget, QAbstractItemView, QHeaderView,
    QMenu, QMessageBox, QTextBrowser, QInputDialog, QLayout, QSizePolicy,
    QProgressDialog,
)

from .pull import PullWorker
from .decompile import DecompileWorker, SourceViewerWindow, decompile_root
from .theme import TEXT, TEXT_DIM, GREEN, RED, AMBER, ACCENT

# App-ops modes an app op can be set to (the values `appops set` accepts).
APPOP_MODES = ["allow", "deny", "ignore", "default", "foreground"]
# Component state verbs (the `pm` sub-commands for a `<pkg>/<component>`).
COMPONENT_STATES = {"enable": "enable", "disable": "disable", "default": "default-state"}


# --- data models --------------------------------------------------------------
@dataclass
class AppInfo:
    """One row in the app list, from `pm list packages -f -i -U`."""
    package: str
    apk_path: str = ""
    version_code: str = ""
    uid: str = ""
    installer: str = ""
    system: bool = False
    enabled: bool = True

    @property
    def short(self) -> str:
        """A friendly-ish display name derived from the package name."""
        seg = self.package.rsplit(".", 1)[-1]
        return seg or self.package


@dataclass
class Permission:
    name: str
    granted: bool | None = None            # True/False, or None if only requested
    runtime: bool = False                  # a changeable (dangerous) runtime permission


@dataclass
class Component:
    name: str                              # `.Foo` or `com.pkg.Foo` (as pm accepts)
    enabled: bool = True


@dataclass
class AppOp:
    op: str
    mode: str


@dataclass
class AppDetail:
    package: str
    general: dict = field(default_factory=dict)          # field label -> value
    permissions: list = field(default_factory=list)      # [Permission]
    activities: list = field(default_factory=list)       # [Component]
    services: list = field(default_factory=list)
    receivers: list = field(default_factory=list)
    providers: list = field(default_factory=list)
    appops: list = field(default_factory=list)           # [AppOp]
    signatures: list = field(default_factory=list)       # [str] summary lines


# --- pure command builders (Qt-free) ------------------------------------------
def _sh(serial: str) -> list[str]:
    return ["-s", serial, "shell"]


def list_packages_args(serial: str, *, with_uid: bool = True) -> list[str]:
    """`pm list packages` with file (-f), installer (-i), version code, and
    optionally UID (-U — Android 9+)."""
    flags = ["-f", "-i", "--show-versioncode"]
    if with_uid:
        flags.append("-U")
    return _sh(serial) + ["pm", "list", "packages", *flags]


def list_filtered_args(serial: str, flag: str) -> list[str]:
    """Names-only list for a category flag (`-s` system, `-d` disabled, `-e`)."""
    return _sh(serial) + ["pm", "list", "packages", flag]


def dumpsys_args(serial: str, package: str) -> list[str]:
    return _sh(serial) + ["dumpsys", "package", package]


def appops_get_args(serial: str, package: str, *, cmd: bool = True) -> list[str]:
    return _sh(serial) + (["cmd", "appops", "get", package] if cmd
                          else ["appops", "get", package])


def appops_set_args(serial: str, package: str, op: str, mode: str) -> list[str]:
    return _sh(serial) + ["cmd", "appops", "set", package, op, mode]


def stat_size_args(serial: str, path: str) -> list[str]:
    return _sh(serial) + ["stat", "-c", "%s", path]


def du_args(serial: str, package: str, sub: str = ".") -> list[str]:
    """`run-as <pkg> du -sk <sub>` — data/cache size for a debuggable app."""
    return _sh(serial) + ["run-as", package, "du", "-sk", sub]


def launch_args(serial: str, package: str) -> list[str]:
    return _sh(serial) + ["monkey", "-p", package, "-c",
                          "android.intent.category.LAUNCHER", "1"]


def force_stop_args(serial: str, package: str) -> list[str]:
    return _sh(serial) + ["am", "force-stop", package]


def clear_args(serial: str, package: str) -> list[str]:
    return _sh(serial) + ["pm", "clear", package]


def clear_cache_args(serial: str, package: str) -> list[str]:
    """`pm clear --cache-only` — clears the cache without touching app data
    (Android 12+/API 31; older devices reject the flag and we fall back)."""
    return _sh(serial) + ["pm", "clear", "--cache-only", package]


def runas_clear_cache_args(serial: str, package: str) -> list[str]:
    """Debuggable-app fallback: `run-as <pkg> rm -rf cache code_cache`
    (run-as runs in the app's data dir; the app recreates the dirs on demand)."""
    return _sh(serial) + ["run-as", package, "rm", "-rf", "cache", "code_cache"]


def su_clear_cache_args(serial: str, package: str) -> list[str]:
    """Rooted fallback: remove the cache dirs directly via `su`."""
    return _sh(serial) + ["su", "-c", "rm", "-rf",
                          f"/data/data/{package}/cache",
                          f"/data/data/{package}/code_cache"]


def enable_args(serial: str, package: str) -> list[str]:
    return _sh(serial) + ["pm", "enable", package]


def disable_args(serial: str, package: str) -> list[str]:
    return _sh(serial) + ["pm", "disable-user", "--user", "0", package]


def uninstall_args(serial: str, package: str, *, keep_data: bool = False) -> list[str]:
    # host-side `adb uninstall` (not a shell command)
    return ["-s", serial, "uninstall", *(["-k"] if keep_data else []), package]


def grant_args(serial: str, package: str, perm: str) -> list[str]:
    return _sh(serial) + ["pm", "grant", package, perm]


def revoke_args(serial: str, package: str, perm: str) -> list[str]:
    return _sh(serial) + ["pm", "revoke", package, perm]


def component_args(serial: str, package: str, component: str, state: str) -> list[str]:
    """`pm enable|disable|default-state <pkg>/<component>`."""
    verb = COMPONENT_STATES[state]
    return _sh(serial) + ["pm", verb, f"{package}/{component}"]


def app_info_args(serial: str, package: str) -> list[str]:
    return _sh(serial) + ["am", "start", "-a",
                          "android.settings.APPLICATION_DETAILS_SETTINGS",
                          "-d", f"package:{package}"]


def unzip_list_args(serial: str, apk_path: str) -> list[str]:
    """List an APK's entries (text) via the device's toybox ``unzip -l``."""
    return _sh(serial) + ["unzip", "-l", apk_path]


def unzip_extract_args(serial: str, apk_path: str, entry: str) -> list[str]:
    """Stream a single APK entry to stdout (binary) via ``unzip -p``."""
    return ["-s", serial, "exec-out", "unzip", "-p", apk_path, entry]


# density buckets, best → worst; higher score wins when picking a raster icon
_ICON_DENSITY = {"xxxhdpi": 6, "xxhdpi": 5, "xhdpi": 4, "hdpi": 3,
                 "tvdpi": 2, "mdpi": 1, "ldpi": 0, "nodpi": 0}


def parse_zip_entries(stdout: str) -> list[str]:
    """The entry-name column from `unzip -l` output (last whitespace token)."""
    entries = []
    for line in stdout.splitlines():
        parts = line.split()
        if parts:
            entries.append(parts[-1])
    return entries


def pick_launcher_icon(entries: list[str]) -> str | None:
    """Choose the best *raster* launcher icon from an APK's entry list.

    Prefers a real ``ic_launcher`` in the densest ``mipmap`` folder. Adaptive
    icons (``mipmap-anydpi-v26/*.xml``) are naturally excluded by the png/webp
    filter — those need rendering we can't do over adb, so callers fall back to
    the drawn letter tile. Only launcher/icon-named entries are considered, so
    we never grab an arbitrary drawable."""
    best, best_score = None, -1
    for e in entries:
        el = e.lower()
        if not (el.startswith("res/") and el.endswith((".png", ".webp"))):
            continue
        parts = e.split("/")
        if len(parts) < 3:
            continue
        qual = parts[1].lower()                       # e.g. "mipmap-xxxhdpi"
        stem = parts[-1].rsplit(".", 1)[0].lower()
        if "launcher" not in stem and "icon" not in stem:
            continue
        if "foreground" in stem or "background" in stem:  # adaptive layers
            continue
        if stem == "ic_launcher":
            score = 400
        elif "round" in stem:
            score = 100
        elif "launcher" in stem:
            score = 200
        else:                                         # generic "*icon*"
            score = 50
        if qual.startswith("mipmap"):
            score += 30
        for dens, val in _ICON_DENSITY.items():
            if qual.endswith(dens):
                score += val
                break
        if score > best_score:
            best, best_score = e, score
    return best


# --- pure parsers (Qt-free) ---------------------------------------------------
def parse_pkg_list_line(line: str) -> dict | None:
    """Parse one `pm list packages -f -i -U --show-versioncode` line into a dict.

    Handles the base64-y `~~xxx==` install dirs (split the head on the LAST `=`
    so a path containing `=` doesn't confuse the package split) and lines with
    or without the `-f` path prefix."""
    line = line.strip()
    if not line.startswith("package:"):
        return None
    body = line[len("package:"):].strip()
    if not body:
        return None
    parts = body.split()
    head, extras = parts[0], parts[1:]
    if "=" in head:
        apk_path, _, pkg = head.rpartition("=")
    else:
        apk_path, pkg = "", head
    info = {"package": pkg, "apk_path": apk_path,
            "version_code": "", "uid": "", "installer": ""}
    for tok in extras:
        if tok.startswith("versionCode:"):
            info["version_code"] = tok.split(":", 1)[1]
        elif tok.startswith("uid:"):
            info["uid"] = tok.split(":", 1)[1]
        elif tok.startswith("installer:"):
            v = tok.split(":", 1)[1]
            info["installer"] = "" if v in ("null", "") else v
    return info


def parse_package_names(stdout: str) -> set[str]:
    """Set of package names from a bare `pm list packages …` listing."""
    out = set()
    for line in stdout.splitlines():
        line = line.strip()
        if line.startswith("package:"):
            out.add(line[len("package:"):].split()[0].strip())
    return out


def build_app_list(detailed_stdout: str, system: set[str],
                   disabled: set[str]) -> list[AppInfo]:
    """Combine the detailed listing + the system/disabled name-sets → AppInfo."""
    apps: list[AppInfo] = []
    for line in detailed_stdout.splitlines():
        d = parse_pkg_list_line(line)
        if not d:
            continue
        apps.append(AppInfo(
            package=d["package"], apk_path=d["apk_path"],
            version_code=d["version_code"], uid=d["uid"],
            installer=d["installer"],
            system=d["package"] in system,
            enabled=d["package"] not in disabled,
        ))
    apps.sort(key=lambda a: a.package.lower())
    return apps


_PERM_RE = re.compile(r"^[\w.]+$")


def _is_perm(name: str) -> bool:
    return bool(name) and "." in name and bool(_PERM_RE.match(name))


def _search1(text: str, pat: str) -> str:
    m = re.search(pat, text)
    return m.group(1).strip() if m else ""


def parse_permissions(text: str) -> list[Permission]:
    """Extract requested/install/runtime permissions with grant state from
    `dumpsys package <pkg>` output."""
    granted: dict[str, bool] = {}
    requested: set[str] = set()
    runtime: set[str] = set()          # perms in the "runtime permissions:" block
    mode = None
    for raw in text.splitlines():
        s = raw.strip()
        low = s.lower()
        if low.startswith("requested permissions:"):
            mode = "req"; continue
        if low.startswith("install permissions:"):
            mode = "install"; continue
        if low.startswith("runtime permissions:"):
            mode = "runtime"; continue
        if low.startswith("declared permissions:"):
            mode = None; continue
        if not s:
            continue
        # A new section header (ends with ':' but isn't a permission row) ends the block.
        if mode and s.endswith(":") and "granted=" not in s and not _is_perm(s[:-1]):
            mode = None
            continue
        if mode == "req":
            name = s.split(":", 1)[0].strip()
            if _is_perm(name):
                requested.add(name)
        elif mode in ("install", "runtime") and "granted=" in s:
            name = s.split(":", 1)[0].strip()
            if _is_perm(name):
                g = "granted=true" in s
                granted[name] = granted.get(name, False) or g
                requested.add(name)
                if mode == "runtime":
                    runtime.add(name)
    return [Permission(n, granted.get(n), n in runtime) for n in sorted(requested)]


# Resolver-table section headers in `dumpsys package` and the AppDetail field
# they feed. Only components with an intent-filter appear here — that's the
# adb-only limit (App Manager reads the manifest on-device); we label it as such.
_RESOLVER_SECTIONS = {
    "activity resolver table:": "activities",
    "receiver resolver table:": "receivers",
    "service resolver table:": "services",
    "provider resolver table:": "providers",
}


def parse_components(text: str, package: str) -> dict[str, list[Component]]:
    """Best-effort component enumeration from the resolver tables, filtered to
    ``package``. Marks entries listed under ``disabledComponents:`` as disabled."""
    found: dict[str, dict[str, None]] = {
        "activities": {}, "services": {}, "receivers": {}, "providers": {}}
    disabled: set[str] = set()
    tok_re = re.compile(re.escape(package) + r"/([\w.$]+)")
    section = None
    grabbing_disabled = False
    for raw in text.splitlines():
        s = raw.strip()
        low = s.lower()
        if low in _RESOLVER_SECTIONS:
            section = _RESOLVER_SECTIONS[low]
            grabbing_disabled = False
            continue
        if low.startswith("disabledcomponents:"):
            grabbing_disabled = True; section = None
            continue
        if low.startswith(("enabledcomponents:", "packages:", "shared users:",
                           "key set manager:", "preferred activities")):
            grabbing_disabled = False
            if low.startswith(("packages:", "shared users:", "key set manager:")):
                section = None
            continue
        if grabbing_disabled:
            if s and _is_perm(s) or ("." in s and " " not in s and s):
                disabled.add(_full_class(package, s))
            elif s and not s.startswith(package):
                grabbing_disabled = False
        if section:
            for m in tok_re.finditer(s):
                found[section][m.group(1)] = None
    result: dict[str, list[Component]] = {}
    for key, comps in found.items():
        result[key] = [Component(c, _full_class(package, c) not in disabled)
                       for c in sorted(comps)]
    return result


def _full_class(package: str, comp: str) -> str:
    if comp.startswith("."):
        return package + comp
    if "." not in comp:
        return package + "." + comp
    return comp


_APPOP_RE = re.compile(r"([A-Z][A-Z0-9_]+):\s*(allow|deny|ignore|default|foreground)")


def parse_appops(text: str) -> list[AppOp]:
    """Parse `cmd appops get <pkg>` — lines like `CAMERA: allow; time=…`."""
    seen: dict[str, str] = {}
    for raw in text.splitlines():
        m = _APPOP_RE.search(raw)
        if m and m.group(1) not in seen:
            seen[m.group(1)] = m.group(2)
    return [AppOp(op, mode) for op, mode in seen.items()]


_GENERAL_FIELDS = [
    ("versionName", r"\bversionName=(.+)"),
    ("versionCode", r"\bversionCode=(\S+)"),
    ("minSdk", r"\bminSdk=(\S+)"),
    ("targetSdk", r"\btargetSdk=(\S+)"),
    ("userId", r"\buserId=(\S+)"),
    ("codePath", r"\bcodePath=(\S+)"),
    ("dataDir", r"\bdataDir=(\S+)"),
    ("primaryCpuAbi", r"\bprimaryCpuAbi=(\S+)"),
    ("installerPackageName", r"\binstallerPackageName=(\S+)"),
    ("firstInstallTime", r"\bfirstInstallTime=(.+)"),
    ("lastUpdateTime", r"\blastUpdateTime=(.+)"),
]


def parse_general(text: str) -> dict:
    """Pull the headline package fields out of `dumpsys package <pkg>`."""
    g: dict[str, str] = {}
    for key, pat in _GENERAL_FIELDS:
        val = _search1(text, pat)
        if val and val.lower() not in ("null",):
            g[key] = val
    m = re.search(r"\bflags=\[\s*(.*?)\s*\]", text)
    if m:
        g["flags"] = m.group(1)
    splits = re.findall(r"\bsplits=\[(.*?)\]", text)
    if splits and splits[0]:
        g["splits"] = splits[0]
    return g


def parse_signatures(text: str) -> list[str]:
    """Best-effort signing summary from `dumpsys package <pkg>`."""
    out: list[str] = []
    for raw in text.splitlines():
        s = raw.strip()
        if s.startswith(("signatures=", "signing details:", "Signing KeySets:",
                         "PackageSignatures")):
            out.append(s)
    m = re.search(r"signatureScheme=(\S+)", text)
    if m:
        out.append(f"signatureScheme={m.group(1)}")
    return out


def parse_app_detail(package: str, dumpsys: str, appops: str) -> AppDetail:
    """Assemble a full AppDetail from raw command outputs (Qt-free, testable)."""
    comps = parse_components(dumpsys, package)
    return AppDetail(
        package=package,
        general=parse_general(dumpsys),
        permissions=parse_permissions(dumpsys),
        activities=comps["activities"],
        services=comps["services"],
        receivers=comps["receivers"],
        providers=comps["providers"],
        appops=parse_appops(appops),
        signatures=parse_signatures(dumpsys),
    )


def _op_ok(returncode: int, stdout: str) -> bool:
    """`pm`/`am` print Success/Failure to stdout even on returncode 0."""
    head = (stdout or "").strip().lower()
    if head.startswith(("failure", "failed", "error", "exception")):
        return False
    return returncode == 0


# --- workers ------------------------------------------------------------------
class AppListWorker(QThread):
    done = pyqtSignal(bool, list, str)          # ok, [AppInfo], error

    def __init__(self, adb, serial, parent=None):
        super().__init__(parent)
        self._adb, self._serial = adb, serial

    def _run(self, argv, timeout=25):
        return subprocess.run([self._adb, *argv], capture_output=True,
                              text=True, timeout=timeout)

    def run(self):
        try:
            det = self._run(list_packages_args(self._serial, with_uid=True))
            if det.returncode != 0 or "package:" not in det.stdout:
                det = self._run(list_packages_args(self._serial, with_uid=False))
            system = parse_package_names(
                self._run(list_filtered_args(self._serial, "-s")).stdout)
            disabled = parse_package_names(
                self._run(list_filtered_args(self._serial, "-d")).stdout)
        except (subprocess.SubprocessError, OSError) as exc:
            self.done.emit(False, [], f"Listing apps failed: {exc}")
            return
        apps = build_app_list(det.stdout, system, disabled)
        if not apps:
            self.done.emit(False, [], (det.stderr or "No packages returned").strip())
            return
        self.done.emit(True, apps, "")


class AppDetailWorker(QThread):
    done = pyqtSignal(bool, object, str, int)   # ok, AppDetail, error, seq

    def __init__(self, adb, serial, package, apk_path, seq, parent=None):
        super().__init__(parent)
        self._adb, self._serial = adb, serial
        self._pkg, self._apk, self._seq = package, apk_path, seq

    def _run(self, argv, timeout=25):
        return subprocess.run([self._adb, *argv], capture_output=True,
                              text=True, timeout=timeout)

    def run(self):
        try:
            dump = self._run(dumpsys_args(self._serial, self._pkg)).stdout
            ops = self._run(appops_get_args(self._serial, self._pkg))
            ops_out = ops.stdout
            if ops.returncode != 0 or not ops_out.strip():
                ops_out = self._run(
                    appops_get_args(self._serial, self._pkg, cmd=False)).stdout
        except (subprocess.SubprocessError, OSError) as exc:
            self.done.emit(False, None, f"Reading app details failed: {exc}", self._seq)
            return
        if "Unable to find package" in dump or not dump.strip():
            self.done.emit(False, None, f"Package {self._pkg} not found", self._seq)
            return
        detail = parse_app_detail(self._pkg, dump, ops_out)
        # sizes (best-effort, short timeouts; failures leave "—")
        detail.general["apkSize"] = self._size(stat_size_args(self._serial, self._apk)) \
            if self._apk else ""
        detail.general["dataSize"] = self._du(".")
        detail.general["cacheSize"] = self._du("cache")
        self.done.emit(True, detail, "", self._seq)

    def _size(self, argv) -> str:
        try:
            r = self._run(argv, timeout=8)
        except (subprocess.SubprocessError, OSError):
            return ""
        v = r.stdout.strip()
        return _human_bytes(int(v)) if v.isdigit() else ""

    def _du(self, sub) -> str:
        try:
            r = self._run(du_args(self._serial, self._pkg, sub), timeout=8)
        except (subprocess.SubprocessError, OSError):
            return ""
        first = (r.stdout or "").split()
        return _human_bytes(int(first[0]) * 1024) if first and first[0].isdigit() else ""


class AppActionWorker(QThread):
    done = pyqtSignal(bool, str)                # ok, message

    def __init__(self, adb, argv, ok_msg, parent=None):
        super().__init__(parent)
        self._adb, self._argv, self._ok_msg = adb, argv, ok_msg

    def run(self):
        try:
            r = subprocess.run([self._adb, *self._argv], capture_output=True,
                               text=True, timeout=90)
        except (subprocess.SubprocessError, OSError) as exc:
            self.done.emit(False, f"{self._ok_msg}: {exc}")
            return
        ok = _op_ok(r.returncode, r.stdout)
        if ok:
            self.done.emit(True, self._ok_msg)
        else:
            detail = (r.stderr or r.stdout or "").strip().splitlines()
            self.done.emit(False, detail[-1] if detail else f"{self._ok_msg} failed")


class ClearCacheWorker(QThread):
    """Clear only an app's cache, trying the least-privileged method that works:
    `pm clear --cache-only` (any app, modern Android) → `run-as … rm` (debuggable)
    → rooted `su … rm`. Reports which method succeeded."""
    done = pyqtSignal(bool, str)                 # ok, message

    def __init__(self, adb, serial, package, parent=None):
        super().__init__(parent)
        self._adb, self._serial, self._pkg = adb, serial, package

    def run(self):
        attempts = [
            ("pm --cache-only", clear_cache_args(self._serial, self._pkg)),
            ("run-as", runas_clear_cache_args(self._serial, self._pkg)),
            ("su", su_clear_cache_args(self._serial, self._pkg)),
        ]
        errors = []
        for label, argv in attempts:
            try:
                r = subprocess.run([self._adb, *argv], capture_output=True,
                                   text=True, timeout=60)
            except (subprocess.SubprocessError, OSError) as exc:
                errors.append(f"{label}: {exc}")
                continue
            if _op_ok(r.returncode, r.stdout):
                self.done.emit(True, f"Cleared cache for {self._pkg} (via {label})")
                return
            detail = (r.stderr or r.stdout or "").strip().replace("\n", " ")
            errors.append(f"{label}: {detail[:80] or 'failed'}")
        self.done.emit(False, "Could not clear cache — " + "; ".join(errors))


class BulkPermWorker(QThread):
    """Grant or revoke a whole list of runtime permissions, one `pm` call each,
    and report how many changed."""
    done = pyqtSignal(bool, str)                 # ok, message

    def __init__(self, adb, serial, package, perms, grant, parent=None):
        super().__init__(parent)
        self._adb, self._serial, self._pkg = adb, serial, package
        self._perms, self._grant = perms, grant

    def run(self):
        verb = "grant" if self._grant else "revoke"
        builder = grant_args if self._grant else revoke_args
        ok_n, fails = 0, []
        for perm in self._perms:
            try:
                r = subprocess.run(
                    [self._adb, *builder(self._serial, self._pkg, perm)],
                    capture_output=True, text=True, timeout=30)
            except (subprocess.SubprocessError, OSError) as exc:
                fails.append(f"{perm.rsplit('.', 1)[-1]}: {exc}")
                continue
            if _op_ok(r.returncode, r.stdout):
                ok_n += 1
            else:
                detail = (r.stderr or r.stdout or "").strip().replace("\n", " ")
                fails.append(f"{perm.rsplit('.', 1)[-1]}: {detail[:50] or 'failed'}")
        if ok_n and not fails:
            self.done.emit(True, f"{verb.title()}ed {ok_n} permission(s)")
        elif ok_n:
            self.done.emit(True, f"{verb.title()}ed {ok_n}, {len(fails)} failed "
                                 f"({'; '.join(fails[:3])})")
        else:
            self.done.emit(False, f"Could not {verb} permissions — "
                                  + "; ".join(fails[:4]))


class AppIconWorker(QThread):
    # package, result: a QImage, None (no raster icon), or "unavailable" (no unzip)
    done = pyqtSignal(str, object)

    def __init__(self, adb, serial, package, apk_path, parent=None):
        super().__init__(parent)
        self._adb, self._serial = adb, serial
        self._pkg, self._apk = package, apk_path

    def run(self):
        if not self._apk:
            self.done.emit(self._pkg, None)
            return
        try:
            listing = subprocess.run(
                [self._adb, *unzip_list_args(self._serial, self._apk)],
                capture_output=True, text=True, timeout=15)
        except (subprocess.SubprocessError, OSError):
            self.done.emit(self._pkg, None)
            return
        if listing.returncode != 0:
            miss = "not found" in (listing.stderr or "").lower() \
                or "inaccessible" in (listing.stderr or "").lower()
            self.done.emit(self._pkg, "unavailable" if miss else None)
            return
        entry = pick_launcher_icon(parse_zip_entries(listing.stdout))
        if not entry:
            self.done.emit(self._pkg, None)
            return
        try:
            blob = subprocess.run(
                [self._adb, *unzip_extract_args(self._serial, self._apk, entry)],
                capture_output=True, timeout=20)          # binary → no text=True
        except (subprocess.SubprocessError, OSError):
            self.done.emit(self._pkg, None)
            return
        img = QImage.fromData(blob.stdout)
        self.done.emit(self._pkg, img if not img.isNull() else None)


def _human_bytes(n: int) -> str:
    step = 1024.0
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < step:
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= step
    return f"{n:.1f} PB"


# --- letter-tile app icon -----------------------------------------------------
def _hue_color(package: str) -> QColor:
    h = 0
    for ch in package:
        h = (h * 31 + ord(ch)) & 0xFFFFFFFF
    c = QColor()
    c.setHsv(h % 360, 150, 190)
    return c


def app_icon(package: str, size: int = 32) -> QIcon:
    pm = QPixmap(size, size)
    pm.fill(Qt.GlobalColor.transparent)
    p = QPainter(pm)
    p.setRenderHint(QPainter.RenderHint.Antialiasing)
    p.setBrush(_hue_color(package))
    p.setPen(Qt.PenStyle.NoPen)
    r = size * 0.24
    p.drawRoundedRect(1, 1, size - 2, size - 2, r, r)
    letter = next((ch for ch in package.rsplit(".", 1)[-1] if ch.isalnum()), "?").upper()
    p.setPen(QColor("#0d0f12"))
    f = QFont()
    f.setBold(True)
    f.setPixelSize(int(size * 0.52))
    p.setFont(f)
    p.drawText(pm.rect(), Qt.AlignmentFlag.AlignCenter, letter)
    p.end()
    return QIcon(pm)


# --- view ---------------------------------------------------------------------
_INFO_ROWS = [
    ("Package", "package"), ("Version name", "versionName"),
    ("Version code", "versionCode"), ("UID", "userId"),
    ("Min SDK", "minSdk"), ("Target SDK", "targetSdk"),
    ("ABI", "primaryCpuAbi"), ("Installer", "installerPackageName"),
    ("First install", "firstInstallTime"), ("Last update", "lastUpdateTime"),
    ("Data dir", "dataDir"), ("Code path", "codePath"),
    ("APK size", "apkSize"), ("Data size", "dataSize"),
    ("Cache size", "cacheSize"), ("Splits", "splits"), ("Flags", "flags"),
]


class FlowLayout(QLayout):
    """A left-to-right layout that wraps its items to the next row when they
    don't fit — so the action buttons stay fully visible at any window width."""

    def __init__(self, parent=None, hspacing=6, vspacing=6):
        super().__init__(parent)
        self._items: list = []
        self._hspace, self._vspace = hspacing, vspacing
        self.setContentsMargins(0, 0, 0, 0)

    def addItem(self, item):
        self._items.append(item)

    def count(self):
        return len(self._items)

    def itemAt(self, i):
        return self._items[i] if 0 <= i < len(self._items) else None

    def takeAt(self, i):
        return self._items.pop(i) if 0 <= i < len(self._items) else None

    def expandingDirections(self):
        return Qt.Orientation(0)

    def hasHeightForWidth(self):
        return True

    def heightForWidth(self, width):
        return self._do_layout(QRect(0, 0, width, 0), test_only=True)

    def setGeometry(self, rect):
        super().setGeometry(rect)
        self._do_layout(rect, test_only=False)

    def sizeHint(self):
        return self.minimumSize()

    def minimumSize(self):
        size = QSize()
        for item in self._items:
            size = size.expandedTo(item.minimumSize())
        return size

    def _do_layout(self, rect, test_only):
        x, y, line_h = rect.x(), rect.y(), 0
        for item in self._items:
            hint = item.sizeHint()
            nx = x + hint.width() + self._hspace
            if nx - self._hspace > rect.right() and line_h > 0:
                x = rect.x()
                y = y + line_h + self._vspace
                nx = x + hint.width() + self._hspace
                line_h = 0
            if not test_only:
                item.setGeometry(QRect(QPoint(x, y), hint))
            x = nx
            line_h = max(line_h, hint.height())
        return y + line_h - rect.y()


class AppManagerView(QWidget):
    """Installed-app browser + detail pane. Self-contained: needs only ``adb``
    + a serial (via ``set_serial``). Follows the shared App picker (``set_package``
    selects that app in the list) but its own list is authoritative."""

    status = pyqtSignal(str)                    # transient status-bar text
    failed = pyqtSignal(str)                    # error → status bar + dialog
    saved = pyqtSignal(bool, str, str)          # APK extract: ok, message, directory

    def __init__(self, adb: str, parent=None):
        super().__init__(parent)
        self.adb = adb or ""
        self._serial: str | None = None
        self._package: str | None = None        # from the shared App picker
        self._loaded_serial = None               # serial the list was built for
        self._apps: list[AppInfo] = []
        self._current: AppInfo | None = None     # selected app
        self._detail: AppDetail | None = None
        self._detail_seq = 0
        self._pending_select: str | None = None  # pkg to select once list loads
        self._tmp = tempfile.mkdtemp(prefix="logcatviewer-appmgr-")
        self._workers: set[QThread] = set()
        self._list_worker: AppListWorker | None = None
        self._detail_worker: AppDetailWorker | None = None
        self._action_worker: AppActionWorker | None = None
        self._cache_worker: ClearCacheWorker | None = None
        self._bulk_worker: BulkPermWorker | None = None
        self._pull_worker: PullWorker | None = None
        self._decompile_worker: DecompileWorker | None = None
        self._decompile_progress = None
        self._viewers: list = []                 # open SourceViewerWindow refs
        # real app icons, pulled lazily from each APK (adaptive-only → None sentinel)
        self._app_index: dict[str, AppInfo] = {}
        self._icon_cache: dict[str, QIcon | None] = {}
        self._icon_inflight: set[str] = set()
        self._icon_queue: list[str] = []
        self._icon_workers: set[QThread] = set()
        self._icons_disabled = False              # device has no usable `unzip`
        self._build_ui()

    # --- construction ------------------------------------------------------
    def _build_ui(self):
        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)

        split = QSplitter(Qt.Orientation.Horizontal)

        # Left: filter bar + app list.
        left = QWidget()
        lv = QVBoxLayout(left)
        lv.setContentsMargins(0, 0, 0, 0)
        lv.setSpacing(0)

        bar = QWidget()
        bar.setObjectName("AppMgrBar")
        bh = QHBoxLayout(bar)
        bh.setContentsMargins(8, 6, 8, 6)
        bh.setSpacing(6)
        self.search = QLineEdit()
        self.search.setObjectName("AppMgrSearch")
        self.search.setPlaceholderText("Filter apps…")
        self.search.setClearButtonEnabled(True)
        self.search.textChanged.connect(self._apply_filter)
        self.filter_combo = QComboBox()
        self.filter_combo.addItems(["All", "User", "System", "Disabled"])
        self.filter_combo.currentIndexChanged.connect(self._apply_filter)
        self.refresh_btn = QPushButton("⟳")
        self.refresh_btn.setObjectName("toggle")
        self.refresh_btn.setToolTip("Reload the installed-app list")
        self.refresh_btn.clicked.connect(lambda: self._reload(force=True))
        bh.addWidget(self.search, 1)
        bh.addWidget(self.filter_combo)
        bh.addWidget(self.refresh_btn)
        lv.addWidget(bar)

        self.app_list = QListWidget()
        self.app_list.setObjectName("AppMgrList")
        self.app_list.setIconSize(QSize(30, 30))
        self.app_list.currentItemChanged.connect(self._on_app_selected)
        self.app_list.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self.app_list.customContextMenuRequested.connect(self._app_list_menu)
        # fetch real icons only for rows scrolled into view
        self.app_list.verticalScrollBar().valueChanged.connect(self._queue_visible_icons)
        lv.addWidget(self.app_list, 1)

        self.count_label = QLabel("")
        self.count_label.setObjectName("AppMgrCount")
        lv.addWidget(self.count_label)
        split.addWidget(left)

        # Right: header (title + actions) + detail tabs.
        right = QWidget()
        rv = QVBoxLayout(right)
        rv.setContentsMargins(0, 0, 0, 0)
        rv.setSpacing(0)

        header = QWidget()
        header.setObjectName("AppMgrHeader")
        hv = QVBoxLayout(header)
        hv.setContentsMargins(14, 10, 14, 10)
        hv.setSpacing(6)

        titlerow = QHBoxLayout()
        titlerow.setSpacing(10)
        self.icon_label = QLabel()
        self.icon_label.setObjectName("AppMgrIcon")
        self.icon_label.setFixedSize(40, 40)
        self.icon_label.setScaledContents(True)
        self.icon_label.hide()
        titlerow.addWidget(self.icon_label, 0, Qt.AlignmentFlag.AlignVCenter)
        titlebox = QVBoxLayout()
        titlebox.setSpacing(2)
        self.title = QLabel("Select an app")
        self.title.setObjectName("AppMgrTitle")
        self.subtitle = QLabel("")
        self.subtitle.setObjectName("AppMgrSubtitle")
        self.subtitle.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        titlebox.addWidget(self.title)
        titlebox.addWidget(self.subtitle)
        titlerow.addLayout(titlebox, 1)
        hv.addLayout(titlerow)

        actions_bar = QWidget()
        actions = FlowLayout(actions_bar)          # wraps to a 2nd row when narrow
        sp = actions_bar.sizePolicy()
        sp.setHeightForWidth(True)
        sp.setVerticalPolicy(QSizePolicy.Policy.Minimum)
        actions_bar.setSizePolicy(sp)
        self._act_buttons: list[QPushButton] = []
        self.btn_launch = self._action_btn("Launch", self._launch)
        self.btn_stop = self._action_btn("Force-stop", self._force_stop)
        self.btn_cache = self._action_btn("Clear cache", self._clear_cache)
        self.btn_clear = self._action_btn("Clear data", self._clear_data)
        self.btn_freeze = self._action_btn("Disable", self._toggle_enabled)
        self.btn_uninstall = self._action_btn("Uninstall", self._uninstall)
        self.btn_apk = self._action_btn("Extract APK", self._extract_apk)
        self.btn_info = self._action_btn("App Info", self._open_app_info)
        for b in self._act_buttons:
            actions.addWidget(b)
        hv.addWidget(actions_bar)
        rv.addWidget(header)

        self.tabs = QTabWidget()
        self.tabs.setObjectName("AppMgrTabs")
        self._build_info_tab()
        self._build_perm_tab()
        self._build_comp_tab()
        self._build_ops_tab()
        self._build_sig_tab()
        rv.addWidget(self.tabs, 1)
        split.addWidget(right)

        split.setStretchFactor(0, 0)
        split.setStretchFactor(1, 1)
        split.setSizes([320, 720])
        root.addWidget(split)
        self._set_actions_enabled(False)

    def _action_btn(self, text, slot) -> QPushButton:
        b = QPushButton(text)
        b.setObjectName("toggle")
        b.clicked.connect(slot)
        self._act_buttons.append(b)
        return b

    def _build_info_tab(self):
        self.info_table = QTableWidget(0, 2)
        self.info_table.setObjectName("AppMgrInfo")
        self.info_table.horizontalHeader().setVisible(False)
        self.info_table.verticalHeader().setVisible(False)
        self.info_table.setColumnCount(2)
        self.info_table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.info_table.setSelectionMode(QAbstractItemView.SelectionMode.NoSelection)
        self.info_table.setWordWrap(True)
        self.info_table.horizontalHeader().setStretchLastSection(True)
        self.info_table.setColumnWidth(0, 130)
        self.tabs.addTab(self.info_table, "Info")

    def _build_perm_tab(self):
        wrap = QWidget()
        lay = QVBoxLayout(wrap)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(0)

        subbar = QWidget()
        subbar.setObjectName("AppMgrSubBar")
        sh = QHBoxLayout(subbar)
        sh.setContentsMargins(8, 6, 8, 6)
        sh.setSpacing(6)
        self.btn_grant_all = QPushButton("Grant all")
        self.btn_grant_all.setObjectName("toggle")
        self.btn_grant_all.setToolTip("Grant every runtime permission this app requests")
        self.btn_grant_all.clicked.connect(lambda: self._bulk_perms(grant=True))
        self.btn_revoke_all = QPushButton("Revoke all")
        self.btn_revoke_all.setObjectName("toggle")
        self.btn_revoke_all.setToolTip("Revoke every runtime permission from this app")
        self.btn_revoke_all.clicked.connect(lambda: self._bulk_perms(grant=False))
        hint = QLabel("Runtime permissions only")
        hint.setObjectName("AppMgrSubtitle")
        sh.addWidget(self.btn_grant_all)
        sh.addWidget(self.btn_revoke_all)
        sh.addStretch(1)
        sh.addWidget(hint)
        lay.addWidget(subbar)

        self.perm_table = QTableWidget(0, 2)
        self.perm_table.setObjectName("AppMgrPermTable")
        self.perm_table.setHorizontalHeaderLabels(["Permission", "State"])
        self.perm_table.verticalHeader().setVisible(False)
        self.perm_table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.perm_table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.perm_table.horizontalHeader().setStretchLastSection(False)
        self.perm_table.horizontalHeader().setSectionResizeMode(
            0, QHeaderView.ResizeMode.Stretch)
        self.perm_table.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self.perm_table.customContextMenuRequested.connect(self._perm_menu)
        lay.addWidget(self.perm_table, 1)
        self.btn_grant_all.setEnabled(False)
        self.btn_revoke_all.setEnabled(False)
        self.tabs.addTab(wrap, "Permissions")

    def _build_comp_tab(self):
        self.comp_tree = QTreeWidget()
        self.comp_tree.setObjectName("AppMgrCompTree")
        self.comp_tree.setHeaderLabels(["Component", "State"])
        self.comp_tree.setColumnWidth(0, 420)
        self.comp_tree.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self.comp_tree.customContextMenuRequested.connect(self._comp_menu)
        self.tabs.addTab(self.comp_tree, "Components")

    def _build_ops_tab(self):
        self.ops_table = QTableWidget(0, 2)
        self.ops_table.setObjectName("AppMgrOpsTable")
        self.ops_table.setHorizontalHeaderLabels(["App op", "Mode"])
        self.ops_table.verticalHeader().setVisible(False)
        self.ops_table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.ops_table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.ops_table.horizontalHeader().setSectionResizeMode(
            0, QHeaderView.ResizeMode.Stretch)
        self.ops_table.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self.ops_table.customContextMenuRequested.connect(self._ops_menu)
        self.tabs.addTab(self.ops_table, "App Ops")

    def _build_sig_tab(self):
        self.sig_view = QTextBrowser()
        self.sig_view.setObjectName("AppMgrSig")
        self.tabs.addTab(self.sig_view, "Signature")

    # --- shared-selection contract -----------------------------------------
    def set_serial(self, serial: str | None):
        if serial != self._serial:
            self._serial = serial
            self._clear_icon_state()          # APK paths (and icons) are per-device
            self._maybe_reload()

    def set_package(self, package: str | None):
        pkg = package or None
        if pkg == self._package:
            return
        self._package = pkg
        if pkg:
            if not self._select_in_list(pkg):
                self._pending_select = pkg

    def showEvent(self, event):
        super().showEvent(event)
        self._maybe_reload()
        self._queue_visible_icons()   # rows may have been filled while hidden

    def _maybe_reload(self):
        if not self.isVisible():
            return
        if not self.adb or not self._serial:
            self._loaded_serial = self._serial
            self._reset_all("No device selected")
            return
        if self._serial != self._loaded_serial:
            self._reload()

    def _reload(self, force=False, select=None):
        if not self.adb or not self._serial:
            self._reset_all("No device selected")
            return
        if self._list_worker is not None and not force:
            return
        self._loaded_serial = self._serial
        # Which app to reselect (and reload the detail for) once the list lands:
        # an explicit request (e.g. after enable/disable) wins over the shared picker.
        self._pending_select = select or self._package
        self.count_label.setText("Loading apps…")
        self.status.emit("Listing installed apps…")
        w = AppListWorker(self.adb, self._serial)
        w.done.connect(self._on_list_done)
        w.finished.connect(lambda w=w: self._forget(w, "_list_worker"))
        self._list_worker = w
        self._workers.add(w)
        w.start()

    # --- app list ----------------------------------------------------------
    def _on_list_done(self, ok, apps, error):
        if not ok:
            self.count_label.setText("")
            self.failed.emit(error or "Could not list apps")
            return
        self._apps = apps
        self._app_index = {a.package: a for a in apps}
        self._apply_filter()
        self.status.emit(f"{len(apps)} apps installed")
        if self._pending_select:
            self._select_in_list(self._pending_select)
            self._pending_select = None

    def _apply_filter(self, *_):
        needle = self.search.text().strip().lower()
        cat = self.filter_combo.currentText()
        self.app_list.blockSignals(True)
        self.app_list.clear()
        shown = 0
        for app in self._apps:
            if cat == "User" and app.system:
                continue
            if cat == "System" and not app.system:
                continue
            if cat == "Disabled" and app.enabled:
                continue
            if needle and needle not in app.package.lower():
                continue
            cached = self._icon_cache.get(app.package)
            it = QListWidgetItem(cached or app_icon(app.package), app.package)
            it.setData(Qt.ItemDataRole.UserRole, app)
            badges = []
            if app.system:
                badges.append("system")
            if not app.enabled:
                badges.append("disabled")
                it.setForeground(QColor(TEXT_DIM))
            tip = app.package + (f"  ({', '.join(badges)})" if badges else "")
            it.setToolTip(tip)
            self.app_list.addItem(it)
            shown += 1
        self.app_list.blockSignals(False)
        self.count_label.setText(f"{shown} of {len(self._apps)} apps")
        # Keep the current selection highlighted if it still matches the filter,
        # but don't re-trigger a detail reload on every filter keystroke.
        if self._current:
            self.app_list.blockSignals(True)
            found = self._select_in_list(self._current.package)
            self.app_list.blockSignals(False)
            if not found:
                self._current = None
        self._queue_visible_icons()

    def _select_in_list(self, package: str) -> bool:
        for i in range(self.app_list.count()):
            it = self.app_list.item(i)
            app = it.data(Qt.ItemDataRole.UserRole)
            if app and app.package == package:
                self.app_list.setCurrentRow(i)
                self.app_list.scrollToItem(it)
                return True
        return False

    # --- app icons (lazy, per-visible-row) ---------------------------------
    def _queue_visible_icons(self, *_):
        """Enqueue icon fetches for the rows currently scrolled into view."""
        if self._icons_disabled or not self.adb or not self._serial:
            return
        vp = self.app_list.viewport().rect()
        for i in range(self.app_list.count()):
            it = self.app_list.item(i)
            if not self.app_list.visualItemRect(it).intersects(vp):
                continue
            app = it.data(Qt.ItemDataRole.UserRole)
            if not app or not app.apk_path:
                continue
            pkg = app.package
            if pkg in self._icon_cache or pkg in self._icon_inflight \
                    or pkg in self._icon_queue:
                continue
            self._icon_queue.append(pkg)
        self._pump_icons()

    def _pump_icons(self):
        if not self.adb or not self._serial or self._icons_disabled:
            return
        while len(self._icon_inflight) < 3 and self._icon_queue:
            pkg = self._icon_queue.pop(0)
            app = self._app_index.get(pkg)
            if not app or not app.apk_path or pkg in self._icon_cache \
                    or pkg in self._icon_inflight:
                continue
            self._icon_inflight.add(pkg)
            w = AppIconWorker(self.adb, self._serial, pkg, app.apk_path)
            w.done.connect(self._on_icon)
            w.finished.connect(lambda w=w: (self._workers.discard(w),
                                            self._icon_workers.discard(w)))
            self._icon_workers.add(w)
            self._workers.add(w)
            w.start()

    def _on_icon(self, package, result):
        self._icon_inflight.discard(package)
        if result == "unavailable":                # device has no `unzip` — stop
            self._icons_disabled = True
            self._icon_queue.clear()
            return
        if isinstance(result, QImage) and not result.isNull():
            icon = QIcon(QPixmap.fromImage(result))
            self._icon_cache[package] = icon
            self._apply_icon_to_item(package, icon)
            if self._current and self._current.package == package:
                self._set_header_icon(package)
        else:
            self._icon_cache[package] = None       # sentinel: keep the letter tile
        self._pump_icons()

    def _apply_icon_to_item(self, package, icon):
        for i in range(self.app_list.count()):
            it = self.app_list.item(i)
            app = it.data(Qt.ItemDataRole.UserRole)
            if app and app.package == package:
                it.setIcon(icon)
                return

    def _set_header_icon(self, package):
        icon = self._icon_cache.get(package)
        pm = icon.pixmap(40, 40) if icon else app_icon(package, 40).pixmap(40, 40)
        self.icon_label.setPixmap(pm)
        self.icon_label.show()
        if package not in self._icon_cache and package not in self._icon_inflight \
                and not self._icons_disabled:
            self._icon_queue.insert(0, package)     # prioritise the selected app
            self._pump_icons()

    def _clear_icon_state(self):
        self._icon_cache.clear()
        self._icon_inflight.clear()
        self._icon_queue.clear()
        self._icons_disabled = False

    def _on_app_selected(self, cur, _prev):
        if cur is None:
            return
        app = cur.data(Qt.ItemDataRole.UserRole)
        if not app:
            return
        self._current = app
        self.title.setText(app.package)
        self._set_header_icon(app.package)
        badges = " · ".join(
            b for b in ("system app" if app.system else "user app",
                        "disabled" if not app.enabled else "") if b)
        self.subtitle.setText(
            f"UID {app.uid or '—'} · v{app.version_code or '—'} · {badges}")
        self.btn_freeze.setText("Enable" if not app.enabled else "Disable")
        self._set_actions_enabled(True)
        self._clear_detail("Loading…")
        self._load_detail(app)

    def _set_actions_enabled(self, on: bool):
        for b in self._act_buttons:
            b.setEnabled(on)

    # --- detail ------------------------------------------------------------
    def _load_detail(self, app: AppInfo):
        if not self.adb or not self._serial:
            self._clear_detail("No device selected")
            return
        self._detail_seq += 1
        seq = self._detail_seq
        w = AppDetailWorker(self.adb, self._serial, app.package, app.apk_path, seq)
        w.done.connect(self._on_detail_done)
        w.finished.connect(lambda w=w: self._forget(w, "_detail_worker"))
        self._detail_worker = w
        self._workers.add(w)
        w.start()

    def _on_detail_done(self, ok, detail, error, seq):
        if seq != self._detail_seq:
            return                              # a newer selection superseded this
        if not ok:
            self._clear_detail(error or "Could not read details")
            return
        self._detail = detail
        self._populate_info(detail)
        self._populate_perms(detail)
        self._populate_components(detail)
        self._populate_ops(detail)
        self._populate_sig(detail)

    def _clear_detail(self, msg):
        self._detail = None
        self.info_table.setRowCount(0)
        self.perm_table.setRowCount(0)
        self.btn_grant_all.setEnabled(False)
        self.btn_revoke_all.setEnabled(False)
        self.comp_tree.clear()
        self.ops_table.setRowCount(0)
        self.sig_view.setPlainText(msg)
        self.info_table.setRowCount(1)
        self.info_table.setItem(0, 0, QTableWidgetItem(""))
        self.info_table.setItem(0, 1, QTableWidgetItem(msg))

    def _populate_info(self, d: AppDetail):
        rows = []
        for label, key in _INFO_ROWS:
            if key == "package":
                val = d.package
            else:
                val = d.general.get(key, "")
            rows.append((label, val or "—"))
        rows.append(("Enabled", "yes" if (self._current and self._current.enabled) else "no"))
        self.info_table.setRowCount(len(rows))
        for r, (label, val) in enumerate(rows):
            k = QTableWidgetItem(label)
            k.setForeground(QColor(TEXT_DIM))
            v = QTableWidgetItem(str(val))
            v.setFlags(v.flags() | Qt.ItemFlag.ItemIsSelectable)
            self.info_table.setItem(r, 0, k)
            self.info_table.setItem(r, 1, v)
        self.info_table.resizeRowsToContents()

    def _populate_perms(self, d: AppDetail):
        self.perm_table.setRowCount(len(d.permissions))
        n_runtime = 0
        for r, p in enumerate(d.permissions):
            name = QTableWidgetItem(p.name)
            name.setData(Qt.ItemDataRole.UserRole, p.name)
            if p.granted is True:
                state, col = "granted", GREEN
            elif p.granted is False:
                state, col = "denied", RED
            else:
                state, col = "requested", TEXT_DIM
            if p.runtime:
                n_runtime += 1
            else:
                name.setForeground(QColor(TEXT_DIM))   # fixed install/normal perm
            st = QTableWidgetItem(state)
            st.setForeground(QColor(col))
            self.perm_table.setItem(r, 0, name)
            self.perm_table.setItem(r, 1, st)
        # Grant all / Revoke all only make sense for changeable runtime permissions.
        self.btn_grant_all.setEnabled(n_runtime > 0)
        self.btn_revoke_all.setEnabled(n_runtime > 0)
        self.tabs.setTabText(1, f"Permissions ({len(d.permissions)})")

    def _populate_components(self, d: AppDetail):
        self.comp_tree.clear()
        groups = [("Activities", d.activities), ("Services", d.services),
                  ("Receivers", d.receivers), ("Providers", d.providers)]
        total = 0
        for label, comps in groups:
            parent = QTreeWidgetItem([f"{label} ({len(comps)})", ""])
            parent.setFirstColumnSpanned(True)
            f = parent.font(0)
            f.setBold(True)
            parent.setFont(0, f)
            for c in comps:
                leaf = QTreeWidgetItem([c.name, "enabled" if c.enabled else "disabled"])
                leaf.setData(0, Qt.ItemDataRole.UserRole, c.name)
                leaf.setForeground(1, QColor(GREEN if c.enabled else TEXT_DIM))
                if not c.enabled:
                    leaf.setForeground(0, QColor(TEXT_DIM))
                parent.addChild(leaf)
            self.comp_tree.addTopLevelItem(parent)
            parent.setExpanded(len(comps) <= 20)
            total += len(comps)
        self.tabs.setTabText(2, f"Components ({total})")

    def _populate_ops(self, d: AppDetail):
        self.ops_table.setRowCount(len(d.appops))
        for r, o in enumerate(d.appops):
            op = QTableWidgetItem(o.op)
            op.setData(Qt.ItemDataRole.UserRole, o.op)
            mode = QTableWidgetItem(o.mode)
            col = {"allow": GREEN, "foreground": ACCENT,
                   "deny": RED, "ignore": AMBER}.get(o.mode, TEXT)
            mode.setForeground(QColor(col))
            self.ops_table.setItem(r, 0, op)
            self.ops_table.setItem(r, 1, mode)
        self.tabs.setTabText(3, f"App Ops ({len(d.appops)})")

    def _populate_sig(self, d: AppDetail):
        if d.signatures:
            body = "<br>".join(_html_escape(s) for s in d.signatures)
        else:
            body = ("<i>No signing summary in dumpsys. Extract the APK and inspect "
                    "it with <code>apksigner verify --print-certs</code> for the "
                    "full certificate.</i>")
        self.sig_view.setHtml(
            f"<div style='font-family:Menlo,monospace;font-size:12px;color:{TEXT}'>"
            f"{body}</div>")

    # --- per-app actions ---------------------------------------------------
    def _need_app(self) -> AppInfo | None:
        if not self._current or not self._serial:
            self.status.emit("Select an app first")
            return None
        return self._current

    def _run_action(self, argv, ok_msg, *, on_done=None):
        if self._action_worker is not None:
            self.status.emit("Another action is still running…")
            return
        self.status.emit(ok_msg + "…")
        w = AppActionWorker(self.adb, argv, ok_msg)

        def handler(ok, msg, on_done=on_done):
            if ok:
                self.status.emit(msg)
                if on_done:
                    on_done()
            else:
                self.failed.emit(msg)
        w.done.connect(handler)
        w.finished.connect(lambda w=w: self._forget(w, "_action_worker"))
        self._action_worker = w
        self._workers.add(w)
        w.start()

    def _launch(self):
        app = self._need_app()
        if app:
            self._run_action(launch_args(self._serial, app.package),
                             f"Launched {app.package}")

    def _force_stop(self):
        app = self._need_app()
        if app:
            self._run_action(force_stop_args(self._serial, app.package),
                             f"Force-stopped {app.package}")

    def _clear_data(self):
        app = self._need_app()
        if not app:
            return
        if not self._confirm("Clear app data?",
                             f"This wipes all data for {app.package} on the device. "
                             "This cannot be undone."):
            return
        self._run_action(clear_args(self._serial, app.package),
                         f"Cleared data for {app.package}",
                         on_done=lambda: self._load_detail(app))

    def _clear_cache(self):
        # Cache is regenerable, so no confirmation prompt (unlike Clear data).
        app = self._need_app()
        if not app:
            return
        if self._cache_worker is not None:
            self.status.emit("A cache clear is already running…")
            return
        self.status.emit(f"Clearing cache for {app.package}…")
        w = ClearCacheWorker(self.adb, self._serial, app.package)

        def handler(ok, msg, app=app):
            if ok:
                self.status.emit(msg)
                self._load_detail(app)          # refresh the cache-size row
            else:
                self.failed.emit(msg)
        w.done.connect(handler)
        w.finished.connect(lambda w=w: self._forget(w, "_cache_worker"))
        self._cache_worker = w
        self._workers.add(w)
        w.start()

    def _toggle_enabled(self):
        app = self._need_app()
        if not app:
            return
        if app.enabled:
            argv = disable_args(self._serial, app.package)
            msg = f"Disabled {app.package}"
        else:
            argv = enable_args(self._serial, app.package)
            msg = f"Enabled {app.package}"
        # Re-list so the enabled/disabled badge is fresh, then reselect this app
        # (which reloads its detail + updates the Enable/Disable button label).
        self._run_action(argv, msg,
                         on_done=lambda p=app.package: self._reload(force=True, select=p))

    def _uninstall(self):
        app = self._need_app()
        if not app:
            return
        if not self._confirm("Uninstall app?",
                             f"Uninstall {app.package} from the device?"):
            return
        self._run_action(uninstall_args(self._serial, app.package),
                         f"Uninstalled {app.package}",
                         on_done=lambda: self._reload(force=True))

    def _extract_apk(self):
        app = self._need_app()
        if not app:
            return
        if self._pull_worker is not None:
            self.status.emit("An APK extraction is already running…")
            return
        self.status.emit(f"Extracting APK for {app.package}…")
        w = PullWorker(self.adb, self._serial, app.package, self._tmp)
        w.done.connect(self._on_apk_pulled)
        w.finished.connect(lambda w=w: self._forget(w, "_pull_worker"))
        self._pull_worker = w
        self._workers.add(w)
        w.start()

    def _on_apk_pulled(self, ok, message, directory):
        self.saved.emit(ok, message, directory)

    def _open_app_info(self):
        app = self._need_app()
        if app:
            self._run_action(app_info_args(self._serial, app.package),
                             f"Opened settings for {app.package}")

    # --- decompile (right-click an app) ------------------------------------
    def _app_list_menu(self, pos):
        item = self.app_list.itemAt(pos)
        if item is None:
            return
        app = item.data(Qt.ItemDataRole.UserRole)
        if not app:
            return
        menu = QMenu(self)
        act_dec = menu.addAction("Decompile to Java (jadx)…")
        act_extract = menu.addAction("Extract APK")
        menu.addSeparator()
        act_copy = menu.addAction("Copy package name")
        chosen = menu.exec(self.app_list.viewport().mapToGlobal(pos))
        if chosen == act_dec:
            self._decompile(app)
        elif chosen == act_extract:
            self.app_list.setCurrentItem(item)
            self._extract_apk()
        elif chosen == act_copy:
            self._copy(app.package)

    def _decompile(self, app, force=False):
        if not self._serial:
            self.status.emit("Select a device first")
            return
        if self._decompile_worker is not None:
            self.status.emit("A decompile is already running…")
            return
        out = os.path.join(decompile_root(), app.package)
        src = os.path.join(out, "src")
        if not force and os.path.isdir(src) and any(os.scandir(src)):
            self._open_viewer(src, app)          # already decompiled — open cached
            self.status.emit(f"Opened cached decompile of {app.package}")
            return
        prog = QProgressDialog(f"Decompiling {app.package}…", "Cancel", 0, 0, self)
        prog.setWindowTitle("Decompile")
        prog.setWindowModality(Qt.WindowModality.NonModal)
        prog.setMinimumWidth(360)
        prog.setAutoClose(False)
        prog.setAutoReset(False)
        self._decompile_progress = prog

        w = DecompileWorker(self.adb, self._serial, app.package, out)
        prog.canceled.connect(w.cancel)
        w.progress.connect(prog.setLabelText)
        w.done.connect(lambda ok, d, msg, app=app: self._on_decompile_done(ok, d, msg, app))
        w.finished.connect(lambda w=w: self._forget(w, "_decompile_worker"))
        self._decompile_worker = w
        self._workers.add(w)
        prog.show()
        self.status.emit(f"Decompiling {app.package}…")
        w.start()

    def _on_decompile_done(self, ok, src_dir, message, app):
        if self._decompile_progress is not None:
            self._decompile_progress.close()
            self._decompile_progress = None
        if not ok:
            if message != "Cancelled":
                self.failed.emit(message)
            else:
                self.status.emit("Decompile cancelled")
            return
        self.status.emit(message)
        self._open_viewer(src_dir, app, fresh=True)

    def _open_viewer(self, src_dir, app, fresh=False):
        viewer = SourceViewerWindow(
            src_dir, app.package,
            redecompile=lambda app=app: self._decompile(app, force=True))
        self._viewers.append(viewer)
        viewer.destroyed.connect(lambda *_: self._drop_viewer(viewer))
        viewer.show()
        viewer.raise_()
        viewer.activateWindow()
        if fresh:
            viewer.open_first_source()

    def _drop_viewer(self, viewer):
        try:
            self._viewers.remove(viewer)
        except ValueError:
            pass

    # --- context menus -----------------------------------------------------
    def _perm_menu(self, pos):
        app = self._current
        if not app:
            return
        row = self.perm_table.rowAt(pos.y())
        if row < 0:
            return
        item = self.perm_table.item(row, 0)
        perm = item.data(Qt.ItemDataRole.UserRole) if item else None
        if not perm:
            return
        menu = QMenu(self)
        act_grant = menu.addAction("Grant")
        act_revoke = menu.addAction("Revoke")
        menu.addSeparator()
        act_copy = menu.addAction("Copy name")
        chosen = menu.exec(self.perm_table.viewport().mapToGlobal(pos))
        if chosen == act_grant:
            self._run_action(grant_args(self._serial, app.package, perm),
                             f"Granted {perm}", on_done=lambda: self._load_detail(app))
        elif chosen == act_revoke:
            self._run_action(revoke_args(self._serial, app.package, perm),
                             f"Revoked {perm}", on_done=lambda: self._load_detail(app))
        elif chosen == act_copy:
            self._copy(perm)

    def _bulk_perms(self, *, grant: bool):
        app = self._need_app()
        if not app or not self._detail:
            return
        perms = [p.name for p in self._detail.permissions if p.runtime]
        if not perms:
            self.status.emit("No runtime permissions to change")
            return
        if self._bulk_worker is not None:
            self.status.emit("A permission change is already running…")
            return
        verb = "Grant" if grant else "Revoke"
        prep = "to" if grant else "from"
        if not self._confirm(f"{verb} all permissions?",
                             f"{verb} all {len(perms)} runtime permission(s) "
                             f"{prep} {app.package}?"):
            return
        self.status.emit(f"{verb}ing {len(perms)} permission(s)…")
        w = BulkPermWorker(self.adb, self._serial, app.package, perms, grant)

        def handler(ok, msg, app=app):
            (self.status if ok else self.failed).emit(msg)
            self._load_detail(app)              # refresh grant states either way
        w.done.connect(handler)
        w.finished.connect(lambda w=w: self._forget(w, "_bulk_worker"))
        self._bulk_worker = w
        self._workers.add(w)
        w.start()

    def _comp_menu(self, pos):
        app = self._current
        if not app:
            return
        item = self.comp_tree.itemAt(pos)
        comp = item.data(0, Qt.ItemDataRole.UserRole) if item else None
        if not comp:
            return
        menu = QMenu(self)
        act_enable = menu.addAction("Enable")
        act_disable = menu.addAction("Disable")
        act_default = menu.addAction("Reset to default")
        menu.addSeparator()
        act_copy = menu.addAction("Copy name")
        chosen = menu.exec(self.comp_tree.viewport().mapToGlobal(pos))
        mapping = {act_enable: "enable", act_disable: "disable", act_default: "default"}
        if chosen in mapping:
            state = mapping[chosen]
            self._run_action(component_args(self._serial, app.package, comp, state),
                             f"{state.title()}d {comp}",
                             on_done=lambda: self._load_detail(app))
        elif chosen == act_copy:
            self._copy(comp)

    def _ops_menu(self, pos):
        app = self._current
        if not app:
            return
        row = self.ops_table.rowAt(pos.y())
        item = self.ops_table.item(row, 0) if row >= 0 else None
        op = item.data(Qt.ItemDataRole.UserRole) if item else None
        menu = QMenu(self)
        set_menu = None
        if op:
            set_menu = menu.addMenu(f"Set {op} to")
            for mode in APPOP_MODES:
                set_menu.addAction(mode)
        add_action = menu.addAction("Set an app op…")
        chosen = menu.exec(self.ops_table.viewport().mapToGlobal(pos))
        if chosen is None:
            return
        if op and chosen.parent() is set_menu:
            self._set_appop(app, op, chosen.text())
        elif chosen == add_action:
            self._prompt_set_appop(app)

    def _prompt_set_appop(self, app):
        op, ok = QInputDialog.getText(
            self, "Set app op", "App op name (e.g. COARSE_LOCATION):")
        if not ok or not op.strip():
            return
        mode, ok = QInputDialog.getItem(
            self, "Set app op", f"Mode for {op.strip()}:", APPOP_MODES, 0, False)
        if ok:
            self._set_appop(app, op.strip(), mode)

    def _set_appop(self, app, op, mode):
        self._run_action(appops_set_args(self._serial, app.package, op, mode),
                         f"Set {op} = {mode}", on_done=lambda: self._load_detail(app))

    # --- helpers -----------------------------------------------------------
    def _confirm(self, title, text) -> bool:
        box = QMessageBox(self)
        box.setIcon(QMessageBox.Icon.Warning)
        box.setWindowTitle(title)
        box.setText(text)
        box.setStandardButtons(QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No)
        box.setDefaultButton(QMessageBox.StandardButton.No)
        return box.exec() == QMessageBox.StandardButton.Yes

    def _copy(self, text):
        from PyQt6.QtWidgets import QApplication
        QApplication.clipboard().setText(text)
        self.status.emit(f"Copied {text}")

    def _reset_all(self, msg):
        self._apps = []
        self._app_index = {}
        self._current = None
        self._clear_icon_state()
        self.app_list.clear()
        self.count_label.setText(msg)
        self.icon_label.hide()
        self.title.setText("Select an app")
        self.subtitle.setText("")
        self._clear_detail(msg)
        self._set_actions_enabled(False)

    def _forget(self, worker, attr):
        self._workers.discard(worker)
        if getattr(self, attr, None) is worker:
            setattr(self, attr, None)

    def shutdown(self):
        if self._decompile_worker is not None:
            self._decompile_worker.cancel()
        for viewer in list(self._viewers):
            viewer.close()
        for w in list(self._workers):
            try:
                w.wait(1500)
            except RuntimeError:
                pass
        shutil.rmtree(self._tmp, ignore_errors=True)
        # note: decompiled sources under decompile_root() persist across sessions


def _html_escape(s: str) -> str:
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))
