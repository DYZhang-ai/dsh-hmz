"""Smoke test of adapter/hmz_adapter.py against a real hmz installation.

Run with the hmz installation's Python and an isolated HUMANIZE_HOME/TMPDIR:
  HUMANIZE_HOME=... TMPDIR=... <hmz-python> -I adapter_smoke.py <adapter.py> <workspace> [epic]
"""
import json
import subprocess
import sys

adapter, workspace = sys.argv[1], sys.argv[2]
epic = sys.argv[3] if len(sys.argv) > 3 else ""
requests = [
    {"id": "ping", "op": "ping"},
    {"id": "flows", "op": "flows", "args": {"workspace": workspace}},
    {"id": "flow", "op": "flow", "args": {"workspace": workspace, "name": "rlar"}},
    {"id": "path", "op": "flow", "args": {"workspace": workspace, "name": "../evil"}},
    {"id": "rel", "op": "flows", "args": {"workspace": "relative/dir"}},
    {"id": "status", "op": "status", "args": {"workspace": workspace}},
    {"id": "start", "op": "start", "args": {"workspace": workspace}},
]
out = subprocess.run([sys.executable, "-I", adapter], input="\n".join(json.dumps(r) for r in requests) + "\n",
                     capture_output=True, text=True, timeout=120)
got = {m["id"]: m for m in map(json.loads, out.stdout.splitlines())}
fail = 0


def check(cond, what):
    global fail
    print(("PASS " if cond else "FAIL ") + what)
    fail |= not cond


check(got["ping"]["ok"] and got["ping"]["result"]["protocol"] == 2, "ping reports hmz protocol 2")
names = [f["name"] for f in got["flows"]["result"]["flows"]]
check({"chat", "rlar"} <= set(names), f"flows lists hmz flows ({names})")
roles = [a["name"] for a in got["flow"]["result"]["agents"] if not a["auto"]]
check(roles == ["actor", "reviewer"], f"rlar declares actor/reviewer ({roles})")
check(not got["path"]["ok"], "a path is refused as a flow name")
check(not got["rel"]["ok"], "a relative workspace is refused")
status = got["status"]["result"]
check(got["status"]["ok"] and "held" in status, "status answers")
if epic:
    check(any(r["epicName"] == epic for r in status.get("recent", [])), "status lists the demo epic as recent (unbound)")
check(not got["start"]["ok"] and "unknown op" in got["start"]["error"], "start is not offered by this adapter version")
sys.exit(fail)
