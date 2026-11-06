"""Fixture regressions for adapter observe_evidence: visible worker messages, tool
calls with output and error (never reasoning), the latest received instructions,
provenance per item, separate input/output budgets, bounds, and the fingerprint.

  <hmz-python> -I tests/adapter_observe_unit.py <adapter.py>
"""
import importlib.util
import sys
import tempfile
import types
from pathlib import Path

spec = importlib.util.spec_from_file_location("adapter_observe_under_test", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
fail = 0


def check(cond, what):
    global fail
    print(("PASS " if cond else "FAIL ") + what)
    fail |= not cond


root = Path(tempfile.mkdtemp())
(root / "ws").mkdir()
under = root / "epics"
(under / "E1").mkdir(parents=True)
S = types.SimpleNamespace
actions = [
    {"category": "turn", "name": "turn", "args": {"prompt": "TASK PROMPT"}},
    {"category": "llm", "name": "think", "args": {"thinking": "SECRET REASONING"}},
    {"category": "message", "name": "say", "args": {"text": "I chose an in-process cache."}},
    {"category": "tool", "name": "bash", "args": {"tool": "bash", "input": {"command": "ls"}, "output": "a.py", "error": False}},
    {"category": "message", "name": "say", "args": {"text": "x" * 5000}},
]
state = {"actions": actions}


class Epics:
    def under(self):
        return under

    def sessions(self, epic):
        return [S(agent="Actor", backend="dsh", provider="p", ident="s1", at="1", flow="f", parent="")]

    def transcripts(self, epic):
        return [{"key": "dsh:s1", "agent": "Actor", "actions": state["actions"]}, {"key": "dsh:other", "agent": "X", "actions": actions}]

    def read(self, epic):
        return S(task="the task")


sys.modules["hmz.sdk"] = types.SimpleNamespace(Hmz=lambda w: types.SimpleNamespace(epics=Epics()))
m._TRANSCRIPT_TTL = 0.0
args = {"workspace": str(root / "ws"), "epic": "E1", "maxItems": 10, "maxChars": 4000, "itemChars": 500}
r = m.op_observe_evidence(args)
texts = " ".join(i["text"] for i in r["items"])
check("SECRET REASONING" not in texts and "TASK PROMPT" not in texts, "no reasoning; turn prompts are not work items")
check([i["text"] for i in r["instructions"]] == ["TASK PROMPT"] and r["instructions"][0]["category"] == "instruction"
      and r["instructions"][0]["session"] == "Actor/1" and r["instructions"][0]["index"] == 0, "the received instruction is kept, with provenance")
check([i["category"] for i in r["items"]] == ["message", "tool", "message"], f"messages and tool results only ({[i['category'] for i in r['items']]})")
check([i["ref"] for i in r["items"]] == ["dsh:s1#2", "dsh:s1#3", "dsh:s1#4"], "refs name session and action index")
check(all(i["session"] == "Actor/1" and i["agent"] == "Actor" for i in r["items"]), "provenance: agent and session")
check(r["items"][2]["cut"] and len(r["items"][2]["text"]) < 600, "long items are cut and say so")
check(all(i["session"] != "X/1" for i in r["items"]), "sessions the run did not open are ignored")
first = r["fingerprint"]
check(m.op_observe_evidence(args)["fingerprint"] == first, "same evidence, same fingerprint")
state["actions"] = actions + [{"category": "message", "name": "say", "args": {"text": "more"}}]
check(m.op_observe_evidence(args)["fingerprint"] != first, "new visible work changes the fingerprint")
small = m.op_observe_evidence({**args, "maxItems": 1})
check(len(small["items"]) == 1 and small["omitted"] == 3 and small["items"][0]["text"] == "more", "newest kept, the rest counted as omitted")

# Changed goal: a later turn prompt replaces the original goal; the latest is kept (latest last).
state["actions"] = [
    {"category": "turn", "name": "turn", "args": {"prompt": "Build a REST API"}},
    {"category": "message", "name": "say", "args": {"text": "Starting the REST API."}},
    {"category": "turn", "name": "turn", "args": {"prompt": "Change of plan: build a CLI instead, no REST API"}},
    {"category": "message", "name": "say", "args": {"text": "Switching to the CLI."}},
    {"category": "turn", "name": "turn", "args": {"prompt": "Also add --json output to the CLI"}},
]
g = m.op_observe_evidence(args)
check([i["text"] for i in g["instructions"]] == ["Change of plan: build a CLI instead, no REST API", "Also add --json output to the CLI"],
      f"latest instructions per session are kept, oldest dropped ({[i['text'] for i in g['instructions']]})")
check(g["instructions"][-1]["ref"] == "dsh:s1#4", "the newest instruction is last")
fp = g["fingerprint"]
state["actions"] = state["actions"][:-1] + [{"category": "turn", "name": "turn", "args": {"prompt": "Also add --yaml output"}}]
check(m.op_observe_evidence(args)["fingerprint"] != fp, "a new instruction changes the fingerprint")
state["actions"] = [{"category": "turn", "name": "turn", "args": {"prompt": "p" * 3000}}]
lp = m.op_observe_evidence({**args, "promptChars": 300})
check(lp["instructions"][0]["cut"] and lp["cut"] and len(lp["instructions"][0]["text"]) < 400, "a long instruction is cut and says so")

# Tool error after a long input: the error and the output survive on their own budget.
state["actions"] = [
    {"category": "tool", "name": "bash", "args": {"tool": "bash", "input": {"command": "pytest " + "-k x " * 2000}, "output": "E   ImportError: no module named foo", "error": True}},
]
te = m.op_observe_evidence(args)
tool = te["items"][0]
check(tool["error"] is True and "the tool reported an error" in tool["text"], "the error flag is preserved")
check("ImportError: no module named foo" in tool["text"], "the output is preserved after a long input")
check(tool["cut"] and te["cut"] and len(tool["text"]) <= 500 + 400, f"the long input is cut and the item says so ({len(tool['text'])})")
state["actions"] = [
    {"category": "tool", "name": "bash", "args": {"tool": "bash", "input": "ls", "output": "o" * 5000, "error": True}},
]
lo = m.op_observe_evidence(args)["items"][0]
check(lo["cut"] and "the tool reported an error" in lo["text"], "a long output is cut but the error line stays")
fe1 = m.op_observe_evidence(args)["fingerprint"]
state["actions"][0]["args"]["error"] = False
check(m.op_observe_evidence(args)["fingerprint"] != fe1, "the error flag is part of the fingerprint")

# Many sessions: at most 6 instructions overall, the newest.
many = [S(agent=f"A{i}", backend="dsh", provider="p", ident=f"m{i}", at=str(i), flow="f", parent="") for i in range(5)]
Epics.sessions = lambda self, epic: many
Epics.transcripts = lambda self, epic: [{"key": f"dsh:m{i}", "agent": f"A{i}", "actions": [
    {"category": "turn", "at": f"{i}-{k}", "args": {"prompt": f"ask {i}.{k}"}} for k in range(2)]} for i in range(5)]
mi = m.op_observe_evidence(args)
check(len(mi["instructions"]) == 6 and mi["instructionsOmitted"] == 4 and mi["instructions"][-1]["text"] == "ask 4.1",
      f"instructions are capped to the newest 6 ({len(mi['instructions'])}, {mi['instructionsOmitted']})")
sys.exit(fail)
