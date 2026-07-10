"""Enumerate device apps and resolve a package to its running PID(s).

logcat only carries PIDs, so filtering "by app" means resolving the selected
package to the set of PIDs whose process is named `pkg` or `pkg:<suffix>`
(the latter covers extra app processes and gLite's `:pN` clone processes).
"""
from __future__ import annotations

import subprocess


def _run(adb: str, serial: str | None, args: list[str], timeout: float = 8):
    cmd = [adb]
    if serial:
        cmd += ["-s", serial]
    cmd += args
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def list_packages(adb: str, serial: str | None) -> list[str]:
    """Installed package names via `pm list packages`."""
    try:
        out = _run(adb, serial, ["shell", "pm", "list", "packages"]).stdout
    except (subprocess.SubprocessError, OSError):
        return []
    return [l.strip()[8:] for l in out.splitlines() if l.strip().startswith("package:")]


def running_processes(adb: str, serial: str | None) -> list[tuple[int, str]]:
    """(pid, process_name) for every running process. Names are the full
    Android process names (e.g. `com.glite.poc:p0`), not comm-truncated."""
    try:
        r = _run(adb, serial, ["shell", "ps", "-A", "-o", "PID,NAME"])
        lines = r.stdout.splitlines()
    except (subprocess.SubprocessError, OSError):
        return []
    procs: list[tuple[int, str]] = []
    for line in lines:
        parts = line.strip().split(None, 1)
        if len(parts) == 2 and parts[0].isdigit():
            procs.append((int(parts[0]), parts[1].strip()))
    if not procs:  # fallback for `ps` builds without -o support
        try:
            r = _run(adb, serial, ["shell", "ps", "-A"])
        except (subprocess.SubprocessError, OSError):
            return []
        for line in r.stdout.splitlines():
            cols = line.split()
            if len(cols) >= 2 and cols[1].isdigit():  # USER PID ... NAME
                procs.append((int(cols[1]), cols[-1]))
    return procs


def _base(name: str) -> str:
    return name.split(":", 1)[0]


# gLite/BlackBox lineage hosts store cloned APKs under
# <host>/blackbox/data/app/<clonePkg>/ — these are NOT OS-installed, so they
# only show up in `pm`/`ps` while running. Enumerate them directly.
_KNOWN_HOSTS = ("com.glite.poc", "com.gbag.poc", "top.niunaijun.blackboxa")


def list_clones(adb: str, serial: str | None) -> dict[str, list[str]]:
    """Map VA-host package -> list of cloned package names installed inside it.

    Tries a rooted glob across all hosts first; falls back to `run-as` (works
    for debuggable host builds) against detected/known hosts."""
    clones: dict[str, list[str]] = {}

    # 1) rooted glob — one shot, every host.
    try:
        out = _run(adb, serial,
                   ["shell", "ls -d /data/data/*/blackbox/data/app/*/ 2>/dev/null"]).stdout
    except (subprocess.SubprocessError, OSError):
        out = ""
    for line in out.splitlines():
        parts = line.strip().rstrip("/").split("/")
        # ['', 'data', 'data', <host>, 'blackbox', 'data', 'app', <clone>]
        if len(parts) >= 8 and parts[1:3] == ["data", "data"] and "blackbox" in parts:
            clones.setdefault(parts[3], []).append(parts[-1])
    if clones:
        return clones

    # 2) run-as fallback (no root). Probe known hosts + hosts inferred from
    #    running helper processes (e.g. `com.glite.poc:p0` -> com.glite.poc).
    candidates = set(_KNOWN_HOSTS)
    for _, name in running_processes(adb, serial):
        if ":" in name:
            candidates.add(_base(name))
    for host in candidates:
        try:
            out = _run(adb, serial, ["shell", "run-as", host, "ls", "blackbox/data/app/"]).stdout
        except (subprocess.SubprocessError, OSError):
            continue
        names = [l.strip() for l in out.splitlines()
                 if l.strip() and "/" not in l and "not debuggable" not in l.lower()
                 and "no such" not in l.lower() and "unknown" not in l.lower()]
        if names:
            clones[host] = names
    return clones


def list_apps(adb: str, serial: str | None) -> list[str]:
    """Sorted list of OS-installed packages. (VA clones are enumerated
    separately via list_clones; running-process names are only used for PID
    resolution, not the app list — they'd add kernel/daemon noise.)"""
    names = set(list_packages(adb, serial))
    names.discard("")
    return sorted(names)


def resolve_pids(adb: str, serial: str | None, package: str) -> set[int]:
    """PIDs of processes named `package` or `package:<suffix>`."""
    pids: set[int] = set()
    for pid, name in running_processes(adb, serial):
        if name == package or name.startswith(package + ":"):
            pids.add(pid)
    return pids


def apk_paths_on_device(adb: str, serial: str | None, package: str) -> list[str]:
    """Remote paths of an OS-installed package's APK(s) via `pm path` (base + splits)."""
    try:
        out = _run(adb, serial, ["shell", "pm", "path", package]).stdout
    except (subprocess.SubprocessError, OSError):
        return []
    return [l.strip()[len("package:"):] for l in out.splitlines()
            if l.strip().startswith("package:")]


def clone_apk_paths(adb: str, serial: str | None, package: str, host: str) -> list[str]:
    """Remote paths of a gLite clone's APK(s) under <host>/blackbox/data/app/<pkg>/."""
    d = f"/data/data/{host}/blackbox/data/app/{package}"
    try:
        out = _run(adb, serial, ["shell", f"find {d} -name '*.apk' 2>/dev/null"]).stdout
    except (subprocess.SubprocessError, OSError):
        return []
    return [l.strip() for l in out.splitlines() if l.strip().endswith(".apk")]


def force_crash(adb: str, serial: str | None, package: str, pids) -> list[str]:
    """Force an app to die: `am force-stop <pkg>` (OS apps) plus `kill -9` of the
    given PIDs (works for gLite clone processes, which aren't OS packages —
    requires a rooted shell). Returns human-readable notes on what ran."""
    notes: list[str] = []
    if package:
        try:
            _run(adb, serial, ["shell", "am", "force-stop", package], timeout=6)
            notes.append(f"force-stop {package}")
        except (subprocess.SubprocessError, OSError):
            pass
    pids = sorted({int(p) for p in (pids or [])})
    if pids:
        try:
            _run(adb, serial, ["shell", "kill", "-9", *map(str, pids)], timeout=6)
            notes.append("kill " + ",".join(map(str, pids)))
        except (subprocess.SubprocessError, OSError):
            pass
    return notes
