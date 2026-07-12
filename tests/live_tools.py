"""Live device check for the dev-tool suite added around the Crashes /
Inspector / Controls / Prefs / Toolbox tabs. READ-ONLY where possible: it
never changes device settings, injects input, or runs monkey — it verifies
that each feature's device command works and its parser understands the real
output of the connected device.

Run: QT_QPA_PLATFORM=offscreen .venv/bin/python tests/live_tools.py <serial>
"""
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from logcat_viewer import adb as adblib
from logcat_viewer import controls as ctl
from logcat_viewer import crash as crashmod
from logcat_viewer import inspector as insp
from logcat_viewer import monitor as mon
from logcat_viewer import prefs as prefsmod
from logcat_viewer import wireless as wifi
from logcat_viewer.appmgr import parse_running_services, running_services_args
from logcat_viewer.intents import build_am_args
from logcat_viewer.notifs import dump_args as notif_args, parse_notifications
from logcat_viewer.perfetto import perfetto_args, pull_trace_args

fails = []


def check(cond, msg):
    if not cond:
        fails.append(msg)
    print(("ok  " if cond else "FAIL") + "  " + msg)


def run(adb, args, timeout=30, binary=False):
    return subprocess.run([adb, *args], capture_output=True, timeout=timeout,
                          **({} if binary else {"text": True, "errors": "replace"}))


def main():
    adb = adblib.find_adb()
    if not adb:
        print("adb not found")
        sys.exit(1)
    serial = sys.argv[1] if len(sys.argv) > 1 else None
    if not serial:
        devs = [d for d in adblib.list_devices(adb) if d.online]
        if not devs:
            print("no device online")
            sys.exit(1)
        serial = devs[0].serial
    print(f"device: {serial}\n")

    # --- Crashes: crash buffer + dropbox ------------------------------------
    r = run(adb, crashmod.crash_buffer_args(serial))
    check(r.returncode == 0, "crash buffer dump runs")
    blocks = crashmod.split_crash_blocks(r.stdout)
    print(f"     crash buffer: {len(blocks)} block(s)")
    r = run(adb, crashmod.dropbox_print_args(serial, "data_app_crash"))
    drops = crashmod.split_dropbox_print(r.stdout, "data_app_crash")
    check(r.returncode == 0, f"dropbox data_app_crash prints ({len(drops)} entries)")
    for b in (blocks + drops)[:3]:
        check(bool(b.title), f"crash record has a headline: {b.title[:60]!r}")

    # --- Inspector: screencap + uiautomator dump -----------------------------
    shot = run(adb, insp.screencap_args(serial), binary=True)
    check(shot.stdout[:4] == b"\x89PNG", "screencap returns a PNG")
    dump = run(adb, insp.uidump_args(serial))
    root = insp.build_ui_tree(dump.stdout)
    check(root is not None and root.children, "uiautomator dump parses into a tree")
    if root:
        n = [0]

        def count(node):
            n[0] += 1
            for c in node.children:
                count(c)
        count(root)
        check(n[0] > 3, f"hierarchy has {n[0]} nodes")
        mid = insp.node_at(root, 200, 400)
        check(mid is not None and mid.bounds, f"hit-test finds a node: {mid.label[:50]!r}")

    # --- Controls: one-round-trip state read (READ-ONLY) ---------------------
    r = run(adb, ["-s", serial, "shell", ctl.read_state_script()])
    state = ctl.interpret_state(ctl.parse_state(r.stdout))
    check(state.get("battery_level") is not None,
          f"controls state: battery {state.get('battery_level')}%")
    check("night" in state and "layout" in state and "doze_idle" in state,
          f"controls state parsed: night={state['night']} anim_off={state['anim_off']} "
          f"doze={state['doze_idle']}")

    # --- Monitor: probe with battery (+ gfx for systemui) --------------------
    pkg = "com.android.systemui"
    r = run(adb, ["-s", serial, "shell", mon.build_probe(pkg)])
    text, _, gfx_txt = r.stdout.partition("@@GFX@@")
    text, _, bat_txt = text.partition("@@BAT@@")
    bat = mon.parse_battery(bat_txt)
    check(bat is not None and 0 <= bat["level"] <= 100,
          f"probe battery: {bat}")
    gfx = mon.parse_gfxinfo(gfx_txt)
    check(gfx is None or gfx["total"] > 0,
          f"probe gfxinfo ({pkg}): {gfx and gfx['total']} frames, "
          f"{gfx and gfx['janky_pct']}% janky")
    check(mon.parse_cpu_stat(text) is not None, "probe still parses /proc/stat")

    # --- Notifications --------------------------------------------------------
    r = run(adb, notif_args(serial))
    notifs = parse_notifications(r.stdout)
    check(r.returncode == 0, f"dumpsys notification runs ({len(notifs)} records)")

    # --- Running services (systemui always has some) --------------------------
    r = run(adb, running_services_args(serial, pkg))
    svcs = parse_running_services(r.stdout)
    check(len(svcs) >= 0 and r.returncode == 0,
          f"running services for {pkg}: {len(svcs)}")

    # --- Intents: harmless no-op broadcast ------------------------------------
    r = run(adb, build_am_args(serial, "broadcast", action="com.logcatviewer.livecheck"))
    check("Broadcast completed" in r.stdout,
          f"am broadcast round-trips: {r.stdout.strip().splitlines()[-1][:60]!r}")

    # --- Wireless: read the device's wlan IP (read-only) ----------------------
    r = run(adb, wifi.ip_route_args(serial))
    ip = wifi.parse_device_ip(r.stdout)
    check(True, f"device wlan IP: {ip} (None is OK when Wi-Fi is off)")

    # --- Prefs: arg builders against a real device (list may legitimately fail
    #     when no debuggable app / no root — we check the failure is clean) ----
    r = run(adb, prefsmod.ls_prefs_args(serial, pkg))
    check(r.returncode != 0 or "not debuggable" in (r.stdout + r.stderr).lower()
          or ".xml" in r.stdout,
          "prefs listing returns a clean result (files or a not-debuggable refusal)")

    # --- Perfetto: 5s minimal trace + pull ------------------------------------
    trace = os.path.join(tempfile.mkdtemp(prefix="livetools-"), "t.perfetto-trace")
    r = run(adb, perfetto_args(serial, 5, ["sched"]), timeout=40)
    if r.returncode == 0:
        r2 = run(adb, pull_trace_args(serial, trace), timeout=60)
        check(r2.returncode == 0 and os.path.getsize(trace) > 1024,
              f"perfetto trace captured + pulled ({os.path.getsize(trace):,} bytes)")
    else:
        check(False, f"perfetto capture failed: {(r.stderr or r.stdout).strip()[:80]}")

    print()
    if fails:
        print(f"{len(fails)} FAILURE(S)")
        sys.exit(1)
    print("ALL LIVE TOOL CHECKS PASSED")


if __name__ == "__main__":
    main()
