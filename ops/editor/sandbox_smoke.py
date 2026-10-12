"""Linux local-only sandbox acceptance: no model calls, no production data."""
import json
import os
from pathlib import Path
import tempfile
from sandbox import Sandbox

def check():
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp); work=root/"work"; inputs=root/"input"
        work.mkdir(); inputs.mkdir(); (root/"secret").write_text("synthetic-never-readable")
        (inputs/"source.txt").write_text("fixture")
        script = '''import os, socket, subprocess
from pathlib import Path
assert "ANTHROPIC_API_KEY" not in os.environ
root=Path(os.environ["EDITOR_WORK_DIR"]).parent
for p in [root/"secret",Path("/proc/1/environ"),Path(os.environ["EDITOR_INPUT_DIR"])/"source.txt"]:
    try:
        if p.name=="source.txt": p.write_text("bad")
        else: p.read_bytes()
    except PermissionError: pass
    else: raise AssertionError("sandbox escape")
try: socket.socket()
except PermissionError: pass
else: raise AssertionError("network allowed")
try: os.truncate(root/"secret",0)
except PermissionError: pass
else: raise AssertionError("truncate escape")
try: os.open(str(root/"secret"),os.O_RDONLY|os.O_TRUNC)
except PermissionError: pass
else: raise AssertionError("readonly truncate escape")
for call in (os.setsid, lambda: os.setpgid(0,0), lambda: os.kill(os.getppid(),0)):
    try: call()
    except PermissionError: pass
    else: raise AssertionError("process group escape")
Path("ok.txt").write_text("local script executed")
assert subprocess.run(["/usr/bin/ffmpeg","-version"],stdout=subprocess.DEVNULL).returncode==0
print("sandbox-ok")
'''
        (work/"check.py").write_text(script)
        r=Sandbox(work, inputs).execute("python", ["check.py"], 30)
        if r["exitCode"] != 0 or not (work/"ok.txt").exists(): raise ValueError("sandbox smoke failed")
        return {"sandbox": "passed", "secretProcInputWriteNetworkGroupEscape": "denied", "pythonAndFFmpeg": "passed"}

if __name__ == "__main__":
    try: print(json.dumps(check()))
    except Exception: print('{"sandbox":"unavailable_or_failed"}'); raise SystemExit(1)
