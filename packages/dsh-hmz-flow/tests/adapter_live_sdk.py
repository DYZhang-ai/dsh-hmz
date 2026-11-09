"""First-turn evidence through the installed hmz trace parser; no daemon/model/network.

Run: <hmz-python> -I tests/adapter_live_sdk.py <adapter.py>
Only the daemon transport is replaced. Epic discovery and DSH log parsing are real.
"""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import time
from types import SimpleNamespace

with tempfile.TemporaryDirectory(prefix="hmzf-live-sdk-") as scratch:
    root = Path(scratch)
    os.environ["HUMANIZE_HOME"] = str(root / "home")
    from hmz import machine
    from hmz import sdk

    machine().mkdir(parents=True, exist_ok=True)
    workspace = root / "workspace"
    workspace.mkdir()
    epic = sdk.Hmz(workspace).epics.under() / "first-turn"
    epic.mkdir(parents=True)
    spec = importlib.util.spec_from_file_location("adapter_live_test", sys.argv[1])
    adapter = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(adapter)
    now = int(time.time() * 1000)
    session = "session-live-regression"
    log = epic / "sessions" / "dsh" / "sessions" / "fixture" / session / "session.jsonl"
    log.parent.mkdir(parents=True)
    rows = [
        {"type": "session", "id": session, "cwd": str(workspace)},
        {"type": "turn/start", "time": now, "data": {"turn": 1}},
        {"type": "user/message", "time": now + 1, "data": {"source": {"kind": "user"}, "content": [{"type": "text", "text": "Build the CLI"}]}},
        {"type": "tool/call", "time": now + 2, "data": {"callId": "c1", "name": "bash", "arguments": '{"command":"pytest"}'}},
        {"type": "tool/result", "time": now + 3, "data": {"message": {"content": [{"type": "tool-result", "toolCallId": "c1", "isError": True, "content": [{"type": "text", "text": "ImportError from live turn"}]}]}}},
    ]
    log.write_text("\n".join(json.dumps(row) for row in rows) + "\n")
    assert sdk.Hmz(workspace).epics.sessions(epic) == [], "fixture has no Epic opened events"
    assert sdk.Hmz(workspace).epics.transcripts(epic) == [], "the old path is blind"
    messages = [
        {"type": "welcome", "pid": 123},
        {"type": "opened", "seq": 1, "run": 1, "key": "Actor/1", "agent": "Actor", "cli": "dsh", "kept": str(epic / "sessions" / "dsh")},
        {"type": "event", "seq": 2, "run": 1, "session": "Actor/1", "agent": "Actor", "cli": "dsh", "ident": session, "kind": "tool", "text": "bash pytest", "at": now / 1000},
        {"type": "run", "run": 1, "epic": str(epic), "state": "running"},
        {"type": "live", "seq": 2, "elided": 0},
    ]
    link = SimpleNamespace(heard=lambda callback: [callback(m) for m in messages], close=lambda: None)
    daemon = SimpleNamespace(pid=123, started="T0", slot="", link=lambda **kwargs: link)
    sdk.Daemons = lambda: SimpleNamespace(here=lambda workspace: daemon)
    args = {"workspace": str(workspace), "epic": str(epic), "expect": {"hostPid": 123, "hostStarted": "T0", "run": 1, "epic": str(epic)}}
    got = adapter.op_observe_evidence(args)
    assert got["instructions"][0]["text"] == "Build the CLI", got
    tool = got["items"][0]
    assert tool["category"] == "tool" and tool["error"] is True, got
    assert "ImportError from live turn" in tool["text"] and tool["source"] == "transcript", got
    assert tool["session"] == "Actor/1", got
    assert adapter.op_observe_evidence(args)["fingerprint"] == got["fingerprint"]
    # A tool output can change before another SDK event arrives. Cached live
    # traces must notice that file change, not wait for an opened/end event.
    rows[-1]["data"]["message"]["content"][0]["content"][0]["text"] = "Different error, still in first turn"
    log.write_text("\n".join(json.dumps(row) for row in rows) + "\n")
    changed = adapter.op_observe_evidence(args)
    assert changed["fingerprint"] != got["fingerprint"] and "Different error" in changed["items"][0]["text"], changed
    assert sdk.Hmz(workspace).epics.sessions(epic) == [], "reading did not manufacture an Epic opened event"
    assert not list(epic.glob("traces/*")), "no trace export was written into the run"
    print("PASS real hmz parser reads first-turn instructions and tool failure before Epic opened")
