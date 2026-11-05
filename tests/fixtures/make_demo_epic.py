"""Test fixture: run one tiny real `chat` flow in an isolated hmz home and stop it.

Not part of the plugin. Used only so the preview has a real epic to read and a
real run snapshot (roles -> agents) to read. Usage (hmz installation python):

    HUMANIZE_HOME=... TMPDIR=... HUMANIZE_DSH_BIN=... <hmz-python> -I make_demo_epic.py <workspace> [agent-spec] [hold-seconds]

The agent spec defaults to $HMZ_TEST_AGENT, else dsh@preview-deepseek/deepseek-flash
(a DeepSeek account provisioned in the isolated hmz home). Claude-backed specs are refused:
real runs of this project use DeepSeek only.
"""
import os
import sys
import threading
import time

from hmz.sdk import Daemons

workspace = sys.argv[1]
spec = sys.argv[2] if len(sys.argv) > 2 else os.environ.get("HMZ_TEST_AGENT", "dsh@preview-deepseek/deepseek-flash")
if spec.split("@")[0].split("/")[0] == "claude":
    raise SystemExit("refusing a Claude-backed agent for a real hmz run; use a DeepSeek-backed spec")
hold = float(sys.argv[3]) if len(sys.argv) > 3 else 0.0  # seconds to keep the run waiting before stopping
daemon = Daemons().host(workspace)
seen = []
asked = threading.Event()
ended = threading.Event()
with daemon.link(name="demo-fixture", kind="sdk", replay=False) as link:
    def heard(message):
        kind = message.get("type")
        seen.append(kind)
        if kind == "asked":
            asked.set()
        if kind == "ended":
            ended.set()
    link.heard(heard)
    started = link.start("chat", "Reply with exactly: hello from hmz demo", agents={"assistant": spec})
    print("started", started, flush=True)
    asked.wait(180)
    print("asked" if asked.is_set() else "no question within 180s", flush=True)
    if hold:
        print("holding", hold, flush=True)
        time.sleep(hold)
    status = daemon.status()
    print("state", status.get("state"), "epic", status.get("epic"), flush=True)
    if status.get("state") == "running":
        print("stop", link.stop(), flush=True)
        ended.wait(60)
    print("ended" if ended.is_set() else "not ended yet", "kinds", sorted(set(k for k in seen if k)), flush=True)
