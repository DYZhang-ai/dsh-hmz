"""Fault-injection regressions for adapter/hmz_adapter.py op_start binding.

Run with the hmz installation's Python (needs hmz importable):
  <hmz-python> -I tests/adapter_start_unit.py <adapter.py>
No hmz host, no agents and no network are used.
"""
import importlib.util
import json
import sys
import tempfile
import types

path = sys.argv[1]
spec = importlib.util.spec_from_file_location("adapter_under_test", path)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
daemon = types.SimpleNamespace(pid=123, started="T0", slot="")
OLD = {"complete": True, "state": "idle", "stopping": None, "run": 1, "epic": "/e/previous", "flow": "old", "ref": "old",
       "by": "someone", "names": {"actor": "OldAgent"}, "roles": ["actor"]}
fail = 0


def check(cond, what):
    global fail
    print(("PASS " if cond else "FAIL ") + what)
    fail |= not cond


def run_case(after, pumped, gone="", accepted=2):
    class Reader:
        def __init__(self, *_):
            self.link = object()
            self.gone = ""
            self.state = dict(OLD)

        def snapshot(self):
            return dict(self.state)

        def view(self):
            return dict(self.state)

        def pump(self, until, stop=None):
            self.gone = gone
            if after is not None:
                self.state = {**OLD, **after}
            return pumped

        def close(self):
            pass

    m._Reader = Reader
    m.op_daemons = lambda a: {"hosts": []}
    m._asked = lambda *a: {"ok": True, "run": accepted}
    sys.modules["hmz.sdk"] = types.SimpleNamespace(Daemons=lambda: types.SimpleNamespace(host=lambda w: daemon))
    with tempfile.TemporaryDirectory() as d:
        return m.op_start({"workspace": d, "requestId": "R", "flow": "new", "task": "t"})


def no_stale(binding):
    return binding["epic"] == "" and binding["names"] == {} and binding["flow"] == "new" and binding["run"] == 2


r = run_case(after=None, pumped=False)
check(not r["bindingComplete"] and no_stale(r["binding"]), "timeout: accepted run kept, nothing from the previous run")
r = run_case(after=None, pumped=False, gone="the host went away")
check(not r["bindingComplete"] and no_stale(r["binding"]) and "went away" in r["incompleteWhy"], "link gone: incomplete, no stale fields")
r = run_case(after={"run": 3, "epic": "/e/other", "by": "dsh-hmz-flow:OTHER", "names": {"actor": "X"}}, pumped=False)
check(not r["bindingComplete"] and no_stale(r["binding"]) and "#3" in r["incompleteWhy"], "replaced by another run: run number not forced onto it")
r = run_case(after={"run": 2, "epic": "/e/new", "by": "someone-else", "names": {"actor": "X"}}, pumped=True)
check(not r["bindingComplete"] and no_stale(r["binding"]), "run 2 started by another frontend is not ours")
r = run_case(after={"run": 2, "epic": "/e/new", "by": "dsh-hmz-flow:R", "names": {"actor": "NewAgent"}, "flow": "new"}, pumped=True)
check(r["bindingComplete"] and r["binding"]["epic"] == "/e/new" and r["binding"]["names"] == {"actor": "NewAgent"}, "exact run by this request: complete binding")
try:
    run_case(after=None, pumped=False, accepted=0)
    check(False, "an answer without a run number is unknown")
except m.Unknown:
    check(True, "an answer without a run number is unknown")
print(json.dumps({"failed": bool(fail)}))
sys.exit(fail)
