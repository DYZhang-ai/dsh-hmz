"""Fixture regressions for adapter epic reads: trusted epic names, scope, composite
session keys and the transcript cache TTL.

  <hmz-python> -I tests/adapter_epic_unit.py <adapter.py>
No hmz data is read: the SDK is replaced by a small stand-in.
"""
import importlib.util
import json
import os
import sys
import tempfile
import types
from pathlib import Path

m_spec = importlib.util.spec_from_file_location("adapter_epic_under_test", sys.argv[1])
m = importlib.util.module_from_spec(m_spec)
m_spec.loader.exec_module(m)
fail = 0


def check(cond, what):
    global fail
    print(("PASS " if cond else "FAIL ") + what)
    fail |= not cond


root = Path(tempfile.mkdtemp())
workspace = root / "ws"
workspace.mkdir()
under = root / "home" / "epics" / "-ws"
(under / "E1").mkdir(parents=True)
outside = root / "elsewhere"
outside.mkdir()
(under / "LINK").symlink_to(outside)
reads = {"n": 0}
Sess = types.SimpleNamespace


class Epics:
    def under(self):
        return under

    def sessions(self, epic):
        return [Sess(agent="A", backend="dsh", provider="p", ident="same", at="1", flow="f", parent=""),
                Sess(agent="B", backend="codex", provider="p", ident="same", at="2", flow="f", parent="")]

    def transcripts(self, epic):
        reads["n"] += 1
        return [{"key": "dsh:same", "agent": "A", "actions": [{"category": "message", "name": "say", "args": {"text": "from dsh"}}]},
                {"key": "codex:same", "agent": "B", "actions": [{"category": "message", "name": "say", "args": {"text": "from codex"}}]}]

    def read(self, epic):
        return None

    def ending(self, ran):
        return ""

    def going(self, epic):
        return False


sys.modules["hmz.sdk"] = types.SimpleNamespace(Hmz=lambda w: types.SimpleNamespace(epics=Epics()))


def refused(epic):
    try:
        m._own_epic(str(workspace), epic)
        return False
    except m.Refused:
        return True


check(m._own_epic(str(workspace), "E1") == Path(os.path.realpath(under / "E1")), "a stored epic name resolves under this workspace's epics")
check(m._own_epic(str(workspace), str(under / "E1")) == Path(os.path.realpath(under / "E1")), "an absolute path of the same run is accepted")
for bad in ["..", ".", "../E1", "E1/../../x", "a/b", "", str(outside), "LINK", "NOPE"]:
    check(refused(bad), f"refused: {bad!r}")
tree = m.op_epic_tree({"workspace": str(workspace), "epic": "E1", "names": {"actor": "A"}})
keys = [s["key"] for a in tree["agents"] for s in a["sessions"]]
check(keys == ["dsh:same", "codex:same"], f"session keys keep the backend: {keys}")
one = m.op_epic_session({"workspace": str(workspace), "epic": "E1", "session": "codex:same"})
check([a["text"] for a in one["actions"]] == ["from codex"], "the composite key selects the right session when ids repeat")
try:
    m.op_epic_session({"workspace": str(workspace), "epic": "E1", "session": "same"})
    check(False, "a bare id is refused")
except m.Refused:
    check(True, "a bare id is refused")
before = reads["n"]
m.op_epic_session({"workspace": str(workspace), "epic": "E1", "session": "dsh:same"})
check(reads["n"] == before, "an unchanged epic within the TTL is served from cache")
m._TRANSCRIPT_TTL = 0.0
m.op_epic_session({"workspace": str(workspace), "epic": "E1", "session": "dsh:same"})
check(reads["n"] == before + 1, "after the TTL the transcript is read again even with unchanged epic files")
print(json.dumps({"failed": bool(fail)}))
sys.exit(fail)
