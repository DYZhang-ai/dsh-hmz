"""Read one real run's epic through adapter epic_tree / epic_session (read-only).

  HUMANIZE_HOME=... TMPDIR=<private tmp> <hmz-python> -I adapter_epic_read.py <adapter.py> <workspace> <epic-dir> <foreign-epic-dir> [names-json]

Checks: Epic->Agent->Session tree of exactly this run, a paged and capped transcript
of one of its sessions, and refusals for another workspace's epic and a session key
this run did not open. Starts nothing.
"""
import json
import subprocess
import sys
import time
import uuid

adapter, workspace, epic, foreign = sys.argv[1:5]
names = json.loads(sys.argv[5]) if len(sys.argv) > 5 else {}
proc = subprocess.Popen([sys.executable, "-I", adapter], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
fail = 0


def call(op, **args):
    rid = uuid.uuid4().hex
    proc.stdin.write(json.dumps({"id": rid, "op": op, "args": {"workspace": workspace, **args}}) + "\n")
    proc.stdin.flush()
    while True:
        message = json.loads(proc.stdout.readline())
        if message["id"] == rid:
            return message


def check(cond, what):
    global fail
    print(("PASS " if cond else "FAIL ") + what, flush=True)
    fail |= not cond


tree = call("epic_tree", epic=epic, names=names)
check(tree["ok"], f"epic_tree reads the run ({tree.get('error', '')})")
agents = tree["result"]["agents"]
keys = [s["key"] for a in agents for s in a["sessions"]]
check(len(agents) >= 1 and keys, f"tree has agents and sessions ({[(a['role'], a['agent'], len(a['sessions'])) for a in agents]})")
if names:
    check({a["role"] for a in agents} >= set(names), "roles come from the run's own role->agent names")
key = keys[-1]
t0 = time.time()
page = call("epic_session", epic=epic, session=key, limit=5)
first = time.time() - t0
check(page["ok"] and page["result"]["actions"], f"epic_session returns actions ({page['result']['total'] if page['ok'] else page.get('error')})")
r = page["result"]
check(len(r["actions"]) <= 5 and r["to"] == r["total"] and (r["more"] == (r["from"] > 0)), "the newest page is capped and says whether more exists")
if r["more"]:
    older = call("epic_session", epic=epic, session=key, limit=5, before=r["from"])
    check(older["ok"] and older["result"]["to"] == r["from"], "an older page continues exactly where the newest began")
t0 = time.time()
call("epic_session", epic=epic, session=key, limit=5)
check(time.time() - t0 <= first + 0.5, f"an unchanged epic is answered from cache ({first:.2f}s then {time.time() - t0:.2f}s)")
other = call("epic_tree", epic=foreign)
check(not other["ok"] and "not a run of this workspace" in other["error"], "another workspace's epic is refused")
bogus = call("epic_session", epic=epic, session="session-not-of-this-run")
check(not bogus["ok"] and "not one this run opened" in bogus["error"], "a session key this run did not open is refused")
relative = call("epic_tree", epic="../x")
check(not relative["ok"], "a relative epic path is refused")
proc.stdin.close()
proc.wait(30)
sys.exit(fail)
