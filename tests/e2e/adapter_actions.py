"""Drive adapter actions against a real hmz (isolated home): start, observe, say,
answer an exact question (success required), stop, verify the end, then prove an
old question id cannot reach a new run. Spends two tiny DeepSeek-backed chat runs.

  HUMANIZE_HOME=... TMPDIR=... HUMANIZE_DSH_BIN=... <hmz-python> -I adapter_actions.py <adapter.py> <workspace> [agent-spec]

The agent spec defaults to $HMZ_TEST_AGENT, else dsh@preview-deepseek/deepseek-flash.
Claude-backed specs are refused.
"""
import os
import json
import subprocess
import sys
import time
import uuid

adapter, workspace = sys.argv[1], sys.argv[2]
spec = sys.argv[3] if len(sys.argv) > 3 else os.environ.get("HMZ_TEST_AGENT", "dsh@preview-deepseek/deepseek-flash")
if spec.split("@")[0].split("/")[0] == "claude":
    raise SystemExit("refusing a Claude-backed agent for a real hmz run")
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


def wait(pred, seconds, every=1.0):
    end = time.time() + seconds
    while time.time() < end:
        got = pred()
        if got:
            return got
        time.sleep(every)
    return None


rid = uuid.uuid4().hex
started = call("start", requestId=rid, flow="chat", task="Reply with exactly the word: ready", agents={"assistant": spec})
check(started["ok"], f"start accepted ({started.get('error', '')})")
binding = started["result"]["binding"]
expect = {k: binding[k] for k in ("hostPid", "hostStarted", "run", "epic")}
check(bool(binding["epic"]) and binding["names"].get("assistant"), f"binding has epic and role->agent ({binding['names']})")

second = call("start", requestId=uuid.uuid4().hex, flow="chat", task="x", agents={"assistant": spec})
check(not second["ok"] and second["outcome"] == "refused" and "one flow per directory" in second["error"], "second start in the same directory refused")

found = call("find_request", requestId=rid)
check(found["ok"] and found["result"]["found"], "start is findable by its request id")
other = call("find_request", requestId="not-ours")
check(other["ok"] and not other["result"]["found"], "a foreign request id is not matched")

obs = call("observe", expect=expect)
check(obs["result"]["verdict"] == "running", f"observe says running ({obs['result']['verdict']})")

empty = call("say", expect=expect, text="hi")
check(not empty["ok"] and "exactly one of role or agent" in empty["error"], "say without a target is refused")
bad = call("say", expect=expect, role="reviewer", text="hi")
check(not bad["ok"] and "no agent role" in bad["error"], "say to an unknown role is refused")
stale = call("say", expect={**expect, "run": expect["run"] + 7}, role="assistant", text="hi")
check(not stale["ok"] and "not the bound run" in stale["error"], "say with a stale run is refused")

question = wait(lambda: next(iter(call("status")["result"].get("pending") or []), None), 180)
check(question is not None, f"the chat waits on a human question ({question and question['question']})")
wrong = call("answer", expect=expect, question="q999", text="nope")
check(not wrong["ok"] and "no longer waiting" in wrong["error"], "answering a question that is not waiting is refused")
ans = call("answer", expect=expect, question=question["question"], text="Now reply with exactly the word: done")
check(ans["ok"] and ans["result"]["accepted"], f"answer to the exact waiting question is accepted ({ans.get('error', 'ok')})")
answered = wait(lambda: (lambda st: st if question["question"] not in [q["question"] for q in st.get("pending") or []] else None)(call("status")["result"]), 30)
check(answered is not None, "the answered question is no longer pending")
again = call("answer", expect=expect, question=question["question"], text="twice")
check(not again["ok"], "the same question cannot be answered twice")
second_q = wait(lambda: next((q for q in call("status")["result"].get("pending") or [] if q["question"] != question["question"]), None), 180)
check(second_q is not None, "the agent took the answer and the chat asks again")
said = call("say", expect=expect, role="assistant", text="(queued note from the leader)")
check(said["ok"] and said["result"]["to"] == binding["names"]["assistant"], f"say to role resolves to the agent ({said.get('result') or said.get('error')})")
stop = call("stop", expect=expect)
check(stop["ok"] and stop["result"]["accepted"], "stop accepted (not yet ended)")
ended = wait(lambda: (lambda r: r if r["result"]["verdict"] == "ended" else None)(call("observe", expect=expect)), 90, 2)
check(ended is not None, f"observe verifies the end ({ended and ended['result'].get('how')})")
after = call("say", expect=expect, role="assistant", text="late")
check(not after["ok"], "say after the end is refused, never redirected")

# A new run in the same directory: questions of the old run never reach it.
rid2 = uuid.uuid4().hex
started2 = call("start", requestId=rid2, flow="chat", task="Reply with exactly the word: second", agents={"assistant": spec})
check(started2["ok"], f"a new run starts after the old one ended ({started2.get('error', '')})")
if started2["ok"]:
    b2 = started2["result"]["binding"]
    expect2 = {k: b2[k] for k in ("hostPid", "hostStarted", "run", "epic")}
    q2 = wait(lambda: next(iter(call("status")["result"].get("pending") or []), None), 180)
    stale = call("answer", expect=expect, question=q2["question"] if q2 else "q1", text="meant for the old run")
    check(not stale["ok"], f"an answer bound to the old run is refused on the new run ({stale.get('error', '')[:90]})")
    call("stop", expect=expect2)
    wait(lambda: (lambda r: r if r["result"]["verdict"] == "ended" else None)(call("observe", expect=expect2)), 90, 2)
proc.stdin.close()
proc.wait(30)
sys.exit(fail)
