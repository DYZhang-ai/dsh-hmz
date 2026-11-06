"""Narrow stdio adapter between the DSH hmz-flow Host plugin and hmz's public SDK.

One JSON object per line on stdin: ``{"id": <str>, "op": <str>, "args": {...}}``.
One JSON object per line on stdout: ``{"id": ..., "ok": true, "result": ...}`` or
``{"id": ..., "ok": false, "error": "...", "outcome": "refused"|"unknown"}``.

Reads (never start a daemon host): ``ping``, ``flows``, ``flow``, ``backends``,
``daemons``, ``status``, ``observe``, ``find_request``.

Actions (each sent at most once, never retried here): ``start``, ``say``,
``answer``, ``stop``.

Every read of a run comes from one frontend link attached without replay: hmz
hands a new frontend every snapshot atomically under its lock and then ``live``,
so the snapshots of one read are mutually consistent. A read that did not reach
``live`` is reported as incomplete, never as authoritative.

Limits that come from using hmz unchanged: ``say``/``answer``/``stop`` carry no
expected-run precondition inside hmz. The adapter checks the expected host
(pid + start time), run number and epic on the same link immediately before
acting, which narrows but does not close the window in which another hmz
frontend (native web, CLI) could replace the run.
"""

from __future__ import annotations

import json
import os
import queue
import re
import sys
import threading
import time
import traceback
from pathlib import Path
from typing import Any

#: How long one link may take to hand over its snapshots.
_SNAPSHOT_SECONDS = 8.0
#: How long a start may take to be answered (it imports and opens the flow).
_START_SECONDS = 180.0
#: How long other actions may take to be answered.
_ACT_SECONDS = 30.0
#: How long to wait after a start for the run snapshot to name its epic.
_EPIC_SECONDS = 30.0
#: Frontend names this integration uses; the request id makes a start findable.
_PREFIX = "dsh-hmz-flow"

_out_lock = threading.Lock()


class Unknown(Exception):
    """The action may or may not have happened."""


class Refused(Exception):
    """The action was not taken; the message says why."""


def _write(message: dict[str, Any]) -> None:
    line = json.dumps(message, ensure_ascii=False, default=str)
    with _out_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def _workspace(args: dict[str, Any]) -> str:
    raw = args.get("workspace")
    if not isinstance(raw, str) or not raw:
        raise Refused("workspace is required")
    path = Path(raw)
    if not path.is_absolute():
        raise Refused("workspace must be an absolute path")
    if not path.is_dir():
        raise Refused(f"workspace does not exist: {raw}")
    return os.path.realpath(path)


def _text(args: dict[str, Any], key: str, limit: int = 200_000) -> str:
    value = args.get(key)
    if not isinstance(value, str) or not value.strip():
        raise Refused(f"{key} is required")
    if len(value) > limit:
        raise Refused(f"{key} is longer than {limit} characters")
    return value


# ----------------------------------------------------------------------- reads


def op_ping(_args: dict[str, Any]) -> dict[str, Any]:
    from hmz.daemon.proto import PROTOCOL

    try:
        from importlib.metadata import version

        hmz_version = version("hmz")
    except Exception:  # noqa: BLE001
        hmz_version = "unknown"
    import hmz.web

    # Where hmz's own web front end is installed: the Flow page loads its modules from here.
    static = Path(hmz.web.__file__).resolve().parent / "static"
    return {"hmz": hmz_version, "protocol": PROTOCOL, "pid": os.getpid(), "static": str(static)}


def op_flows(args: dict[str, Any]) -> dict[str, Any]:
    from hmz.sdk import Hmz

    workspace = _workspace(args)
    hmz = Hmz(workspace)
    flows = [{"name": one.name, "whose": one.whose, "about": one.about or ""} for one in hmz.flows.all()]
    return {"workspace": workspace, "flows": flows}


def op_flow(args: dict[str, Any]) -> dict[str, Any]:
    from hmz.sdk import Hmz
    from hmz.web.flows import declared

    workspace = _workspace(args)
    name = args.get("name")
    if not isinstance(name, str) or not name:
        raise Refused("name is required")
    hmz = Hmz(workspace)
    # Only a flow already on offer, never a path: declaring a flow imports it.
    if name not in {one.name for one in hmz.flows.all()}:
        raise Refused(f"{name} is not a flow on offer in {workspace}")
    try:
        return declared(hmz, name)
    except Exception as why:  # Refusal from hmz.web carries a readable message
        raise Refused(str(why)) from why


def op_backends(args: dict[str, Any]) -> dict[str, Any]:
    """The agent backends installed here, their accounts and models, as hmz web reads them."""
    from hmz.sdk import Hmz

    hmz = Hmz(_workspace(args))
    accounts = hmz.accounts

    def held(cli: str) -> dict[str, Any]:
        names = ["", *(one.name for one in accounts.all(cli))]
        return {
            "accounts": [
                {
                    "name": name,
                    "models": [{"name": m.name, "efforts": list(m.efforts)} for m in accounts.models(cli, name)],
                }
                for name in names
            ]
        }

    return {"clis": {cli: held(cli) for cli in sorted(hmz.installed())}}


def op_daemons(args: dict[str, Any]) -> dict[str, Any]:
    """Every hmz host (the workspace's own and each chat's) holding runs in this directory."""
    from hmz.sdk import Daemons

    workspace = _workspace(args)
    hosts = [
        {"slot": one.slot, "pid": one.pid, "started": one.started, "protocol": one.protocol, "alive": one.alive}
        for one in Daemons().all()
        if os.path.realpath(one.workspace) == workspace
    ]
    return {"workspace": workspace, "hosts": hosts}


class _Reader:
    """One frontend link and everything it was told, in order."""

    def __init__(self, daemon: Any, name: str) -> None:
        self.daemon = daemon
        self.messages: queue.SimpleQueue[dict[str, Any]] = queue.SimpleQueue()
        self.snaps: dict[str, Any] = {}
        self.welcome: dict[str, Any] = {}
        self.live = False
        self.gone = ""
        self.link = daemon.link(name=name, kind="sdk", replay=False)
        self.link.heard(self.messages.put)

    def pump(self, until: float, stop: Any = None) -> bool:
        """Read messages until `stop(message)` is true or time runs out."""
        while True:
            left = until - time.monotonic()
            if left <= 0:
                return False
            try:
                message = self.messages.get(timeout=left)
            except queue.Empty:
                return False
            kind = message.get("type")
            if kind == "welcome":
                self.welcome = message
            elif kind == "live":
                self.live = True
            elif kind == "gone":
                self.gone = str(message.get("why") or "gone")
                return False
            elif isinstance(kind, str) and "seq" not in message:
                self.snaps[kind] = message
            if stop is not None and stop(message):
                return True
            if stop is None and self.live:
                return True

    def snapshot(self) -> dict[str, Any]:
        self.pump(time.monotonic() + _SNAPSHOT_SECONDS)
        return self.view()

    def view(self) -> dict[str, Any]:
        run = self.snaps.get("run") or {}
        sessions = self.snaps.get("sessions") or {}
        waiting = self.snaps.get("waiting") or {}
        pending = (self.snaps.get("pending") or {}).get("pending") or []
        complete = self.live and not self.gone and int(self.welcome.get("pid") or -1) == self.daemon.pid
        return {
            "complete": complete,
            "incompleteWhy": "" if complete else (self.gone or ("host pid mismatch" if self.live else "no consistent snapshot in time")),
            "hostPid": self.daemon.pid,
            "hostStarted": self.daemon.started,
            "slot": self.daemon.slot,
            "state": run.get("state", ""),
            "run": run.get("run", 0),
            "stopping": run.get("stopping"),
            "flow": run.get("flow", ""),
            "ref": run.get("ref", ""),
            "epic": run.get("epic", "") or "",
            "task": run.get("task", ""),
            "by": run.get("by", ""),
            "roles": run.get("roles") or [],
            "names": run.get("names") or {},
            "outworlders": run.get("outworlders") or [],
            "agents": run.get("agents") or {},
            "openSessions": sessions.get("open") or [],
            "workingSessions": sessions.get("working") or [],
            "sessionsRun": sessions.get("run", 0),
            "pending": [
                {k: one.get(k) for k in ("question", "run", "role", "text", "options", "mode", "key", "owner")}
                for one in pending
            ],
            "queued": waiting.get("queued") or [],
            "given": waiting.get("given") or [],
        }

    def close(self) -> None:
        self.link.close()


def _recent(workspace: str, limit: int = 3) -> list[dict[str, Any]]:
    """The newest epics of this directory, read off their records (no binding implied)."""
    from hmz.sdk import Hmz

    epics = Hmz(workspace).epics
    out: list[dict[str, Any]] = []
    for path in reversed(epics.all()[-limit:]):
        ran = epics.read(path)
        if ran is None:
            continue
        out.append(
            {"epicName": path.name, "flow": ran.flow, "task": ran.task, "began": ran.began, "ended": ran.ended, "how": epics.ending(ran)}
        )
    return out


def _epic_record(workspace: str, name: str) -> dict[str, Any] | None:
    """How one epic of this directory stands, read off its own record."""
    from hmz.sdk import Hmz

    if not name:
        return None
    epics = Hmz(workspace).epics
    for path in epics.all():
        if path.name == name:
            ran = epics.read(path)
            going = epics.going(path)
            return {
                "epicName": name,
                "going": going,
                "how": (ran.how if ran is not None else "") or "",
                "ended": (ran.ended if ran is not None else "") or "",
                "ending": epics.ending(ran) if ran is not None else "",
            }
    return None


def op_status(args: dict[str, Any]) -> dict[str, Any]:
    from hmz.sdk import Daemons

    workspace = _workspace(args)
    out: dict[str, Any] = {"workspace": workspace, "observedAt": time.time()}
    try:
        out["recent"] = _recent(workspace)
    except Exception as why:  # noqa: BLE001 -- informational
        out["recent"], out["recentError"] = [], str(why)
    out["otherHosts"] = [h for h in op_daemons({"workspace": workspace})["hosts"] if h["slot"]]
    daemon = Daemons().here(workspace)
    if daemon is None:
        out["held"] = False
        return out
    out["held"] = True
    reader = _Reader(daemon, f"{_PREFIX}-status")
    try:
        out.update(reader.snapshot())
    finally:
        reader.close()
    out["epicName"] = Path(out["epic"]).name if out.get("epic") else ""
    return out


def _expect(args: dict[str, Any]) -> dict[str, Any]:
    expect = args.get("expect")
    if not isinstance(expect, dict):
        raise Refused("expect (the bound run) is required")
    for key in ("hostPid", "hostStarted", "run", "epic"):
        if key not in expect:
            raise Refused(f"expect.{key} is required")
    return expect


def _same_host(daemon: Any, expect: dict[str, Any]) -> bool:
    return daemon is not None and daemon.pid == expect["hostPid"] and daemon.started == expect["hostStarted"]


def op_observe(args: dict[str, Any]) -> dict[str, Any]:
    """Where the bound run stands: running, stopping, ended, or unverified.

    `ended` is only said when the host that held the run no longer holds it as
    running or stopping AND the epic's own record says it is not going.
    """
    from hmz.sdk import Daemons

    workspace = _workspace(args)
    expect = _expect(args)
    epic_name = Path(str(expect["epic"])).name if expect.get("epic") else ""
    daemon = Daemons().here(workspace)
    record = _epic_record(workspace, epic_name)
    view: dict[str, Any] = {}
    if _same_host(daemon, expect):
        reader = _Reader(daemon, f"{_PREFIX}-observe")
        try:
            view = reader.snapshot()
        finally:
            reader.close()
        if not view["complete"]:
            return {"verdict": "unverified", "why": view["incompleteWhy"], "view": view, "record": record}
        ours = view["run"] == expect["run"]
        if view["stopping"] == expect["run"]:
            return {"verdict": "stopping", "view": view, "record": record}
        if ours and view["state"] == "running":
            return {"verdict": "running", "view": view, "record": record}
        if not ours and view["run"] < expect["run"]:
            return {"verdict": "unverified", "why": "host reports an older run than the bound one", "view": view, "record": record}
        host_done = True
    else:
        host_done = True  # the process that held the run is gone or replaced
    if record is None:
        return {"verdict": "unverified", "why": "the bound epic's record was not found", "view": view, "record": record}
    if record["going"]:
        return {"verdict": "unverified", "why": "the epic still reads as going", "view": view, "record": record}
    if host_done:
        return {"verdict": "ended", "how": record["ending"] or record["how"] or "ended", "view": view, "record": record,
                "hostGone": not _same_host(daemon, expect)}
    return {"verdict": "unverified", "why": "inconsistent", "view": view, "record": record}


def op_find_request(args: dict[str, Any]) -> dict[str, Any]:
    """Whether the host's current or last run was started by this request's frontend.

    Not finding it does not prove the start did not happen.
    """
    from hmz.sdk import Daemons

    workspace = _workspace(args)
    request_id = _text(args, "requestId", 200)
    daemon = Daemons().here(workspace)
    if daemon is None:
        return {"found": False, "why": "no host holds runs in this directory"}
    reader = _Reader(daemon, f"{_PREFIX}-find")
    try:
        view = reader.snapshot()
    finally:
        reader.close()
    if not view["complete"]:
        return {"found": False, "why": view["incompleteWhy"], "complete": False}
    run = args.get("run")
    if view["by"] == f"{_PREFIX}:{request_id}" and (run is None or view["run"] == run) and view["epic"]:
        return {"found": True, "complete": True, "binding": _binding(daemon, view)}
    return {"found": False, "complete": True, "why": f"the host's run was started by {view['by'] or 'nobody'}"}


def _binding(daemon: Any, view: dict[str, Any]) -> dict[str, Any]:
    return {
        "hostPid": daemon.pid,
        "hostStarted": daemon.started,
        "slot": daemon.slot,
        "run": view["run"],
        "epic": view["epic"],
        "epicName": Path(view["epic"]).name if view["epic"] else "",
        "flow": view["flow"],
        "ref": view["ref"],
        "names": view["names"],
        "roles": view["roles"],
    }


# ------------------------------------------------- one run's own epic (Flow page)
#
# The Host resolves `epic` only from the asking DSH session's own run records;
# these ops re-check that it is a run directory of the workspace's own epics and
# read nothing else: no listing of other epics, no other workspace.

_TRANSCRIPTS: dict[str, tuple[tuple[Any, ...], float, list[dict[str, Any]]]] = {}
_TRANSCRIPT_LOCKS: dict[str, threading.Lock] = {}
_TRANSCRIPT_LOCK = threading.Lock()
#: Most actions one detail page carries, and the longest text of one field.
_PAGE_ACTIONS = 60
#: How long a cached transcript is trusted even when the epic's own files did not change:
#: a session's log may live outside the epic (a CLI's home, or a reused agent's earlier
#: epic), which the file signature below does not see.
_TRANSCRIPT_TTL = 15.0
_FIELD_CHARS = 4000


_EPIC_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,199}")


def _own_epic(workspace: str, epic: Any) -> Path:
    """One run directory of this workspace's own epics.

    hmz names a run's epic by its directory name (that is what a run snapshot and
    a binding carry); an absolute path is accepted too. Either must resolve to a
    direct child of `Hmz(workspace).epics.under()`.
    """
    from hmz.sdk import Hmz

    if not isinstance(epic, str) or not epic:
        raise Refused("epic is required")
    under = Path(os.path.realpath(Hmz(workspace).epics.under()))
    if os.path.isabs(epic):
        path = Path(epic)
    elif _EPIC_NAME.fullmatch(epic) and epic not in (".", ".."):
        path = under / epic
    else:
        raise Refused("epic must be a run name or an absolute path")
    real = Path(os.path.realpath(path))
    if real.parent != under or not real.is_dir():
        raise Refused("that epic is not a run of this workspace")
    return real


def _clip(value: Any, limit: int = _FIELD_CHARS) -> tuple[str, int]:
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, default=str)
    return (text, 0) if len(text) <= limit else (text[:limit], len(text) - limit)


def _signature(epic: Path) -> tuple[Any, ...]:
    seen = []
    for root, _dirs, files in os.walk(epic):
        for name in files:
            try:
                st = os.stat(os.path.join(root, name))
            except OSError:
                continue
            seen.append((os.path.relpath(os.path.join(root, name), epic), st.st_mtime_ns, st.st_size))
    return tuple(sorted(seen))


def _transcripts(workspace: str, epic: Path) -> list[dict[str, Any]]:
    """The run's transcripts, read again only when a file of the epic changed.

    One read at a time per epic: a second caller waits and then gets the cached copy.
    """
    from hmz.sdk import Hmz

    key = str(epic)
    with _TRANSCRIPT_LOCK:
        lock = _TRANSCRIPT_LOCKS.setdefault(key, threading.Lock())
    with lock:
        signature = _signature(epic)
        cached = _TRANSCRIPTS.get(key)
        if cached is not None and cached[0] == signature and time.monotonic() - cached[1] < _TRANSCRIPT_TTL:
            return cached[2]
        read = Hmz(workspace).epics.transcripts(epic)
        _TRANSCRIPTS[key] = (signature, time.monotonic(), read)
        if len(_TRANSCRIPTS) > 16:
            _TRANSCRIPTS.pop(next(iter(_TRANSCRIPTS)))
        return read


def op_epic_tree(args: dict[str, Any]) -> dict[str, Any]:
    """Epic -> Agent -> Session of one run, from its own record (no transcripts read)."""
    from hmz.sdk import Hmz

    workspace = _workspace(args)
    epic = _own_epic(workspace, args.get("epic"))
    epics = Hmz(workspace).epics
    ran = epics.read(epic)
    names = args.get("names") if isinstance(args.get("names"), dict) else {}
    role_of = {str(agent): str(role) for role, agent in names.items()}
    agents: dict[str, dict[str, Any]] = {}
    for one in epics.sessions(epic):
        entry = agents.setdefault(one.agent, {"agent": one.agent, "role": role_of.get(one.agent, ""), "sessions": []})
        entry["sessions"].append({
            # The SDK's own session key, `<backend>:<id>`: an id alone may repeat across CLIs.
            "key": f"{one.backend}:{one.ident}", "ident": one.ident, "backend": one.backend, "provider": one.provider,
            "at": one.at, "flow": one.flow, "parent": one.parent,
        })
    drove = []
    for one in (ran.agents if ran is not None else ()):
        drove.append({k: str(getattr(one, k, "") or "") for k in ("agent", "backend", "model", "effort", "provider")})
    for agent, role in role_of.items():
        agents.setdefault(agent, {"agent": agent, "role": role, "sessions": []})
    task, cut = _clip(ran.task if ran is not None else "", 2000)
    return {
        "epic": {
            "name": epic.name, "flow": ran.flow if ran else "", "task": task, "taskCut": cut,
            "began": ran.began if ran else "", "ended": ran.ended if ran else "", "how": ran.how if ran else "",
            "ending": epics.ending(ran) if ran else "", "going": epics.going(epic),
        },
        "drove": drove,
        "agents": list(agents.values()),
    }


def op_epic_session(args: dict[str, Any]) -> dict[str, Any]:
    """What one session of one run did, newest page first, capped and paged."""
    from hmz.sdk import Hmz

    workspace = _workspace(args)
    epic = _own_epic(workspace, args.get("epic"))
    key = args.get("session")
    if not isinstance(key, str) or not key:
        raise Refused("session is required")
    if key not in {f"{one.backend}:{one.ident}" for one in Hmz(workspace).epics.sessions(epic)}:
        raise Refused("that session is not one this run opened")
    found = next((one for one in _transcripts(workspace, epic) if str(one.get("key", "")) == key), None)
    actions = list(found.get("actions") or []) if found else []
    total = len(actions)
    limit = max(1, min(_PAGE_ACTIONS, int(args.get("limit") or _PAGE_ACTIONS)))
    before = args.get("before")
    end = total if not isinstance(before, int) else max(0, min(total, before))
    start = max(0, end - limit)
    out = []
    for index in range(start, end):
        one = actions[index]
        said = one.get("args") or {}
        item: dict[str, Any] = {
            "i": index, "category": str(one.get("category") or ""), "title": _clip(one.get("name") or "", 300)[0],
            "at": one.get("at") or "", "seconds": one.get("seconds"),
        }
        text = said.get("prompt") or said.get("text") or said.get("thinking")
        if text:
            item["text"], item["textCut"] = _clip(text)
        if item["category"] == "tool":
            item["tool"] = str(said.get("tool") or "")
            item["input"], item["inputCut"] = _clip(said.get("input") or "", 2000)
            item["output"], item["outputCut"] = _clip(said.get("output") or "")
            item["error"] = bool(said.get("error"))
        out.append(item)
    return {
        "session": key, "agent": str(found.get("agent") or "") if found else "",
        "total": total, "from": start, "to": end, "more": start > 0, "actions": out,
        "logged": found is not None,
    }


def op_web_detail(args: dict[str, Any]) -> dict[str, Any]:
    """One run, exactly as hmz web's own `GET /api/runs/<name>` answers it.

    Built by hmz's own `hmz.web.runs.detail` and `calls`, so the native epic view
    reads its own shape. Answered as written down (`held: false`): the native
    view then polls this every few seconds instead of following a host stream.
    """
    from hmz.sdk import Hmz
    from hmz.web.runs import calls, detail

    workspace = _workspace(args)
    epic = _own_epic(workspace, args.get("epic"))
    epics = Hmz(workspace).epics
    ran = epics.read(epic)
    if ran is None:
        raise Refused("the run has no record yet")
    going = not ran.how and epics.going(epic)
    return detail(
        ran, held=False, picks_up=epics.picks_up(epic), foreign=epics.foreign(epic), going=going,
    ) | {"calls": calls(epics.tree(epic))}


def op_web_trace(args: dict[str, Any]) -> dict[str, Any]:
    """One run's sessions, as hmz web's own `GET /api/runs/<name>/trace` answers it (cached)."""
    workspace = _workspace(args)
    epic = _own_epic(workspace, args.get("epic"))
    return {"sessions": _transcripts(workspace, epic)}


def op_observe_evidence(args: dict[str, Any]) -> dict[str, Any]:
    """What one run's workers visibly did and were asked, bounded, for the flow observer.

    Taken: what a worker said (`message`); its tool calls with their output and
    error flag (`tool`), where the output and the error are kept on their own
    budget so a long input never hides them; and the latest instructions each
    session received (`turn` prompts, as `instruction` items), so a later goal
    is known. Never taken: reasoning (`llm`) or anything else. Each item names
    where it came from (agent, session, record index) and says whether it was
    cut. `fingerprint` covers everything visible, so unchanged evidence can be
    recognised without asking a model. hmz's own logs can already be partial.
    """
    import hashlib

    from hmz.sdk import Hmz

    workspace = _workspace(args)
    epic = _own_epic(workspace, args.get("epic"))
    max_items = max(1, min(80, int(args.get("maxItems") or 40)))
    max_chars = max(1000, min(60_000, int(args.get("maxChars") or 16_000)))
    item_chars = max(200, min(4000, int(args.get("itemChars") or 1200)))
    input_chars = max(80, min(item_chars, int(args.get("inputChars") or 400)))
    prompt_chars = max(200, min(4000, int(args.get("promptChars") or 1500)))
    prompts_per_session = max(0, min(5, int(args.get("promptsPerSession") or 2)))
    epics = Hmz(workspace).epics
    ran = epics.read(epic)
    numbered: dict[str, str] = {}
    counts: dict[str, int] = {}
    for one in epics.sessions(epic):
        counts[one.agent] = counts.get(one.agent, 0) + 1
        numbered[f"{one.backend}:{one.ident}"] = f"{one.agent}/{counts[one.agent]}"

    def cut(text: str, limit: int) -> tuple[str, bool]:
        return (text, False) if len(text) <= limit else (text[:limit] + f" …[{len(text) - limit} more chars]", True)

    def plain(value: Any) -> str:
        return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, default=str)

    digest = hashlib.sha256()
    visible: list[dict[str, Any]] = []
    instructions: list[dict[str, Any]] = []
    for session in _transcripts(workspace, epic):
        key = str(session.get("key") or "")
        if key not in numbered:
            continue
        label = numbered[key]
        agent = label.rsplit("/", 1)[0]
        prompts: list[dict[str, Any]] = []
        for index, action in enumerate(session.get("actions") or []):
            category = action.get("category")
            said = action.get("args") or {}
            base = {"ref": f"{key}#{index}", "agent": agent, "session": label, "index": index, "at": action.get("at") or ""}
            if category == "message":
                text = said.get("text")
                if not isinstance(text, str) or not text.strip():
                    continue
                body, was_cut = cut(text, item_chars)
                item = {**base, "category": "message", "tool": "", "error": False, "text": body, "cut": was_cut}
                digest.update(f"{key}#{index}\0message\0{text}\n".encode())
            elif category == "tool":
                tool = str(said.get("tool") or "")
                given, output, error = plain(said.get("input") or ""), plain(said.get("output") or ""), bool(said.get("error"))
                # Input and output each have their own budget: a long input never hides the result.
                given_cut, input_was_cut = cut(given, input_chars)
                output_cut, output_was_cut = cut(output, max(200, item_chars - len(given_cut)))
                body = f"input: {given_cut}\noutput: {output_cut or '(none recorded)'}" + ("\nresult: the tool reported an error" if error else "")
                item = {**base, "category": "tool", "tool": tool, "error": error, "text": body, "cut": input_was_cut or output_was_cut}
                digest.update(f"{key}#{index}\0tool\0{tool}\0{given}\0{output}\0{error}\n".encode())
            elif category == "turn":
                text = said.get("prompt")
                if not isinstance(text, str) or not text.strip():
                    continue
                body, was_cut = cut(text, prompt_chars)
                prompts.append({**base, "category": "instruction", "tool": "", "error": False, "text": body, "cut": was_cut})
                digest.update(f"{key}#{index}\0turn\0{text}\n".encode())
                continue
            else:
                continue
            visible.append(item)
        instructions.extend(prompts[-prompts_per_session:] if prompts_per_session else [])
    visible.sort(key=lambda one: one["at"])
    instructions.sort(key=lambda one: one["at"])
    # At most 6 instructions overall (the latest), so many sessions never crowd out the work record.
    instructions_omitted = max(0, len(instructions) - 6)
    instructions = instructions[instructions_omitted:]
    kept: list[dict[str, Any]] = []
    used = sum(len(one["text"]) for one in instructions)
    for one in reversed(visible):
        if len(kept) >= max_items or used + len(one["text"]) > max_chars:
            break
        kept.append(one)
        used += len(one["text"])
    kept.reverse()
    task, task_cut = _clip(ran.task if ran is not None else "", 3000)
    return {
        "epicName": epic.name,
        "task": task,
        "taskCut": task_cut,
        "fingerprint": digest.hexdigest(),
        "total": len(visible),
        "instructions": instructions,
        "items": kept,
        "omitted": len(visible) - len(kept),
        "instructionsOmitted": instructions_omitted,
        "cut": any(one["cut"] for one in kept + instructions),
    }


# --------------------------------------------------------------------- actions


def _asked(link: Any, said: dict[str, Any], seconds: float) -> dict[str, Any]:
    from hmz.runtime import Refused as HmzRefused

    try:
        return link.asked(said, seconds=seconds)
    except HmzRefused as why:
        raise Refused(str(why)) from why
    except TimeoutError as why:
        raise Unknown(f"hmz did not answer {said.get('do')!r} in {seconds:.0f}s; it may or may not have happened") from why


def op_start(args: dict[str, Any]) -> dict[str, Any]:
    from hmz.sdk import Daemons

    workspace = _workspace(args)
    request_id = _text(args, "requestId", 200)
    flow = _text(args, "flow", 200)
    task = _text(args, "task")
    # Any chat host of this directory that is mid-turn also writes here: refuse.
    for host in op_daemons({"workspace": workspace})["hosts"]:
        if host["slot"] and host["alive"]:
            raise Refused(f"an hmz chat ({host['slot']}) is held in this directory; finish or close it first")
    try:
        daemon = Daemons().host(workspace)
    except OSError as why:
        raise Refused(f"no hmz host could be started: {why}") from why
    reader = _Reader(daemon, f"{_PREFIX}:{request_id}")
    try:
        view = reader.snapshot()
        if not view["complete"]:
            raise Refused(f"could not read the hmz host consistently ({view['incompleteWhy']}); not starting")
        if view["state"] != "idle" or view["stopping"] is not None:
            raise Refused(
                f"hmz already has run #{view['run']} {view['state'] or 'busy'}"
                f"{' (stopping)' if view['stopping'] is not None else ''} in this directory; one flow per directory"
            )
        said = {
            "do": "start",
            "flow": flow,
            "task": task,
            "agents": dict(args.get("agents") or {}),
            "envs": dict(args.get("envs") or {}),
            "params": args.get("params") if isinstance(args.get("params"), dict) else None,
            "budget": args.get("budget") if isinstance(args.get("budget"), dict) else None,
            "profile_flow": bool(args.get("profile_flow")),
            "profile_environment": bool(args.get("profile_environment")),
            "resume": False,
            "backup": None,
        }
        answer = _asked(reader.link, said, _START_SECONDS)
        number = answer.get("run")
        if not isinstance(number, int) or number <= 0:
            raise Unknown(f"hmz accepted the start but named no run: {answer}")
        frontend = f"{_PREFIX}:{request_id}"
        matched = reader.pump(
            time.monotonic() + _EPIC_SECONDS,
            lambda m: m.get("type") == "run" and m.get("run") == number and m.get("by") == frontend and bool(m.get("epic")),
        )
        view = reader.view()
        # Only a run snapshot of exactly the accepted run, started by this
        # request's frontend, may supply epic/flow/names. Anything else (timeout,
        # link gone, another run in view) keeps only what the answer proved.
        gone = getattr(reader, "gone", "")
        if matched and not gone and view.get("run") == number and view.get("by") == frontend and view.get("epic"):
            binding = _binding(daemon, view)
            complete, why = True, ""
        else:
            binding = {
                "hostPid": daemon.pid, "hostStarted": daemon.started, "slot": daemon.slot,
                "run": number, "epic": "", "epicName": "", "flow": flow, "ref": "", "names": {}, "roles": [],
            }
            complete = False
            why = gone or (
                f"hmz shows run #{view.get('run')} by {view.get('by') or 'nobody'}, not the accepted run #{number}"
                if view.get("run") not in (None, 0, number) else "no snapshot of the accepted run in time"
            )
        binding["frontend"] = frontend
        return {"started": True, "binding": binding, "bindingComplete": complete, "incompleteWhy": why}
    finally:
        # Letting go of the link is not stopping the run.
        reader.close()


def _acting(workspace: str, expect: dict[str, Any], label: str) -> tuple[Any, _Reader, dict[str, Any]]:
    from hmz.sdk import Daemons

    daemon = Daemons().here(workspace)
    if not _same_host(daemon, expect):
        raise Refused("the hmz host that held the bound run is gone or was replaced; the bound run is not running")
    reader = _Reader(daemon, f"{_PREFIX}-{label}")
    view = reader.snapshot()
    if not view["complete"]:
        reader.close()
        raise Refused(f"could not read the hmz host consistently ({view['incompleteWhy']}); nothing sent")
    if view["run"] != expect["run"] or (expect.get("epic") and view["epic"] and view["epic"] != expect["epic"]):
        reader.close()
        raise Refused(f"hmz is now on run #{view['run']}, not the bound run #{expect['run']}; nothing sent")
    return daemon, reader, view


def op_say(args: dict[str, Any]) -> dict[str, Any]:
    workspace = _workspace(args)
    expect = _expect(args)
    text = _text(args, "text", 100_000)
    role = args.get("role") or ""
    agent = args.get("agent") or ""
    if bool(role) == bool(agent):
        raise Refused("name exactly one of role or agent; an empty target is never sent")
    _, reader, view = _acting(workspace, expect, "say")
    try:
        if view["state"] != "running":
            raise Refused(f"the bound run #{expect['run']} is {view['state'] or 'not running'}; nothing sent")
        names = view["names"]
        if role:
            if role not in names:
                raise Refused(f"run #{view['run']} has no agent role {role!r}; roles: {', '.join(names) or 'none'}")
            target = names[role]
        else:
            if agent not in names.values():
                raise Refused(f"run #{view['run']} has no agent {agent!r}; agents: {', '.join(names.values()) or 'none'}")
            target = agent
        if not target:
            raise Refused("resolved an empty target; nothing sent")
        _asked(reader.link, {"do": "say", "text": text, "to": target}, _ACT_SECONDS)
        working = [k for k in view["workingSessions"] if k.split("/")[0] == target]
        return {
            "accepted": True,
            "to": target,
            "role": role or next((r for r, n in names.items() if n == target), ""),
            "run": view["run"],
            "targetWorking": bool(working),
        }
    finally:
        reader.close()


def op_answer(args: dict[str, Any]) -> dict[str, Any]:
    workspace = _workspace(args)
    expect = _expect(args)
    question = _text(args, "question", 100)
    text = _text(args, "text", 100_000)
    _, reader, view = _acting(workspace, expect, "answer")
    try:
        waiting = next((q for q in view["pending"] if q["question"] == question), None)
        if waiting is None:
            raise Refused(f"question {question} is no longer waiting on run #{view['run']}; nothing sent")
        if waiting.get("run") != expect["run"]:
            raise Refused(f"question {question} belongs to run #{waiting.get('run')}, not the bound run; nothing sent")
        _asked(reader.link, {"do": "answer", "question": question, "text": text}, _ACT_SECONDS)
        return {"accepted": True, "question": question, "run": view["run"]}
    finally:
        reader.close()


def op_stop(args: dict[str, Any]) -> dict[str, Any]:
    workspace = _workspace(args)
    expect = _expect(args)
    _, reader, view = _acting(workspace, expect, "stop")
    try:
        if view["stopping"] == expect["run"]:
            return {"accepted": True, "already": "stopping", "run": expect["run"]}
        if view["state"] != "running":
            raise Refused(f"the bound run #{expect['run']} is {view['state'] or 'not running'}; nothing to stop")
        _asked(reader.link, {"do": "stop"}, _ACT_SECONDS)
        # Accepted is not ended: the run unwinds and its sessions close afterwards.
        return {"accepted": True, "run": expect["run"]}
    finally:
        reader.close()


OPS = {
    "ping": op_ping,
    "flows": op_flows,
    "flow": op_flow,
    "backends": op_backends,
    "daemons": op_daemons,
    "status": op_status,
    "observe": op_observe,
    "find_request": op_find_request,
    "epic_tree": op_epic_tree,
    "web_detail": op_web_detail,
    "observe_evidence": op_observe_evidence,
    "web_trace": op_web_trace,
    "epic_session": op_epic_session,
    "start": op_start,
    "say": op_say,
    "answer": op_answer,
    "stop": op_stop,
}


def _handle(request: dict[str, Any]) -> None:
    rid = request.get("id")
    op = request.get("op")
    handler = OPS.get(op) if isinstance(op, str) else None
    if handler is None:
        _write({"id": rid, "ok": False, "error": f"unknown op: {op!r}", "outcome": "refused"})
        return
    args = request.get("args") or {}
    if not isinstance(args, dict):
        _write({"id": rid, "ok": False, "error": "args must be an object", "outcome": "refused"})
        return
    try:
        result = handler(args)
    except Refused as why:
        _write({"id": rid, "ok": False, "error": str(why), "outcome": "refused"})
        return
    except Unknown as why:
        _write({"id": rid, "ok": False, "error": str(why), "outcome": "unknown"})
        return
    except Exception as why:  # noqa: BLE001 -- every failure is answered, never swallowed
        if os.environ.get("DSH_HMZ_ADAPTER_DEBUG"):
            traceback.print_exc(file=sys.stderr)
        # An unexpected failure in an action may have happened after sending.
        outcome = "unknown" if op in ("start", "say", "answer", "stop") else "refused"
        _write({"id": rid, "ok": False, "error": str(why) or type(why).__name__, "outcome": outcome})
        return
    _write({"id": rid, "ok": True, "result": result})


def main() -> int:
    running: list[threading.Thread] = []
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except ValueError:
            _write({"id": None, "ok": False, "error": "request is not JSON", "outcome": "refused"})
            continue
        if not isinstance(request, dict):
            _write({"id": None, "ok": False, "error": "request is not an object", "outcome": "refused"})
            continue
        worker = threading.Thread(target=_handle, args=(request,), daemon=True)
        worker.start()
        running = [one for one in running if one.is_alive()]
        running.append(worker)
    # The Host closed stdin: answer what was already asked, then go.
    for worker in running:
        worker.join(timeout=_START_SECONDS)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
