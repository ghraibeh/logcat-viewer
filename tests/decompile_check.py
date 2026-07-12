"""Offline integration test for the jadx decompiler + source viewer.

Decompiles the **bundled** ``mocklocation.apk`` (no device needed) and verifies
the whole chain: tool discovery → ``DecompileWorker`` (run synchronously, same
code the QThread runs) → ``SourceViewerWindow`` loading a real ``.java`` file.

Skips gracefully (exit 0) if neither a system jadx/Java nor a cached download is
available, so it never reaches out to the network in CI.

Usage: QT_QPA_PLATFORM=offscreen .venv/bin/python tests/decompile_check.py
"""
import os
import sys
import tempfile
import shutil

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PyQt6.QtWidgets import QApplication

from logcat_viewer import decompile as dc

app = QApplication([])

fails = []
def check(cond, msg):
    print(("ok  " if cond else "FAIL") + "  " + msg)
    if not cond:
        fails.append(msg)

jadx = dc.cached_jadx() or dc.system_jadx()
java = dc.system_java() or dc.cached_jre_java()
print(f"jadx={jadx}\njava={java}\n")
if not (jadx and java):
    print("no local jadx/Java — skipping (the app would download them on first use)")
    sys.exit(0)

apk = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   "logcat_viewer", "assets", "mocklocation.apk")
check(os.path.exists(apk), f"bundled test APK present: {apk}")

out = tempfile.mkdtemp(prefix="decompile-check-")
try:
    res = {}
    w = dc.DecompileWorker(None, None, "com.logcatviewer.mocklocation", out,
                           local_apks=[apk])
    w.done.connect(lambda ok, d, m: res.update(ok=ok, dir=d, msg=m))
    w.run()                                        # synchronous — same code the thread runs
    print(f"     {res.get('msg')}")
    check(res.get("ok"), "DecompileWorker decompiled the APK")
    src = res.get("dir") or ""
    javas = [os.path.join(r, f) for r, _d, fs in os.walk(src)
             for f in fs if f.endswith(".java")]
    check(len(javas) > 0, f"produced {len(javas)} .java source file(s)")
    check(os.path.isdir(os.path.join(src, "resources")),
          "produced decoded resources/ (incl. AndroidManifest.xml)")

    if javas:
        v = dc.SourceViewerWindow(src, "com.logcatviewer.mocklocation")
        target = next((p for p in javas if p.endswith("MockService.java")), javas[0])
        v._load_file(target)
        body = v.editor.toPlainText()
        check("class" in body and len(body) > 50,
              f"SourceViewerWindow loaded {os.path.basename(target)} "
              f"({len(body)} chars)")
        v.close()
finally:
    shutil.rmtree(out, ignore_errors=True)

print()
if fails:
    print(f"{len(fails)} FAILURE(S)")
    sys.exit(1)
print("ALL DECOMPILE CHECKS PASSED")
