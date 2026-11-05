"""Narrow stdio adapter between the DSH hmz-flow Host plugin and hmz's public SDK.

One JSON object per line on stdin: ``{"id": <str>, "op": <str>, "args": {...}}``.
One JSON object per line on stdout: ``{"id": ..., "ok": true, "result": ...}`` or
``{"id": ..., "ok": false, "error": "..."}``.  Nothing else is written to stdout.

This round exposes read-only operations only:

- ``ping``     -- hmz version and protocol facts.
- ``flows``    -- the flows on offer in a workspace (``hmz.runtime.Hmz.flows.all()``).
- ``flow``     -- one flow as hmz's own web form declares it (``hmz.web.flows.declared``).
- ``status``   -- what the workspace's daemon host says about itself, plus the current run's
                  role->agent mapping read from a short-lived, non-replaying frontend link.

It never starts a daemon host (``Daemons().here()`` only, never ``host()``) and never sends a
control request (start/say/answer/stop are deliberately absent this round).
Run it with the Python interpreter of the hmz installation, for example
``<hmz-root>/venv/bin/python -I hmz_adapter.py``.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
import traceback
from pathlib import Path
from typing import Any

#: How long a status link may take to hand over its snapshots before giving up.
_SNAPSHOT_SECONDS = 5.0

_out_lock = threading.Lock()


def _write(message: dict[str, Any]) -> None:
    line = json.dumps(message, ensure_ascii=False, default=str)
    with _out_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def _workspace(args: dict[str, Any]) -> str:
    raw = args.get("workspace")
    if not isinstance(raw, str) or not raw:
        raise ValueError("workspace is required")
    path = Path(raw)
    if not path.is_absolute():
        raise ValueError("workspace must be an absolute path")
    if not path.is_dir():
        raise ValueError(f"workspace does not exist: {raw}")
    return str(path.resolve())


def op_ping(_args: dict[str, Any]) -> dict[str, Any]:
    import hmz
    from hmz.daemon.proto import PROTOCOL

    version = getattr(hmz, "__version__", "")
    if not version:
        try:
            from importlib.metadata import version as _v

            version = _v("hmz")
        except Exception:  # noqa: BLE001
            version = "unknown"
    return {"hmz": version, "protocol": PROTOCOL, "pid": os.getpid()}


def op_flows(args: dict[str, Any]) -> dict[str, Any]:
    from hmz.sdk import Hmz

    workspace = _workspace(args)
    hmz = Hmz(workspace)
    flows = [
        {"name": one.name, "whose": one.whose, "about": one.about or ""}
        for one in hmz.flows.all()
    ]
    return {"workspace": workspace, "flows": flows}


def op_flow(args: dict[str, Any]) -> dict[str, Any]:
    from hmz.sdk import Hmz
    from hmz.web.flows import declared

    workspace = _workspace(args)
    name = args.get("name")
    if not isinstance(name, str) or not name:
        raise ValueError("name is required")
    hmz = Hmz(workspace)
    # Only a flow already on offer, never a path: declaring a flow imports it.
    if name not in {one.name for one in hmz.flows.all()}:
        raise ValueError(f"{name} is not a flow on offer in {workspace}")
    try:
        return declared(hmz, name)
    except Exception as why:  # Refusal from hmz.web carries a readable message
        raise ValueError(str(why)) from why


def _snapshots(daemon: Any) -> dict[str, Any]:
    """Attaches once without replay and keeps the snapshots handed over before `live`."""
    held: dict[str, Any] = {}
    done = threading.Event()

    link = daemon.link(name="dsh-hmz-flow-status", kind="sdk", replay=False)
    try:

        def heard(message: dict[str, Any]) -> None:
            kind = message.get("type")
            if kind in ("live", "gone"):
                done.set()
            elif isinstance(kind, str):
                held[kind] = message

        link.heard(heard)
        done.wait(_SNAPSHOT_SECONDS)
    finally:
        link.close()
    return held


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
            {
                "epicName": path.name,
                "flow": ran.flow,
                "task": ran.task,
                "began": ran.began,
                "ended": ran.ended,
                "how": epics.ending(ran),
            }
        )
    return out


def op_status(args: dict[str, Any]) -> dict[str, Any]:
    from hmz.sdk import Daemons

    workspace = _workspace(args)
    recent: list[dict[str, Any]] = []
    recent_error = ""
    try:
        recent = _recent(workspace)
    except Exception as why:  # noqa: BLE001 -- recent epics are informational
        recent_error = str(why) or type(why).__name__
    daemon = Daemons().here(workspace)
    if daemon is None:
        return {
            "workspace": workspace,
            "held": False,
            "observedAt": time.time(),
            "recent": recent,
            "recentError": recent_error,
        }
    status = daemon.status()
    snaps: dict[str, Any] = {}
    snap_error = ""
    try:
        snaps = _snapshots(daemon)
    except OSError as why:
        snap_error = str(why)
    run = snaps.get("run") or {}
    sessions = snaps.get("sessions") or {}
    epic = status.get("epic") or run.get("epic") or ""
    return {
        "workspace": workspace,
        "held": True,
        "observedAt": time.time(),
        "hostPid": daemon.pid,
        "hostStarted": daemon.started,
        "protocol": daemon.protocol,
        "state": status.get("state", ""),
        "run": status.get("run", 0),
        "flow": status.get("flow", ""),
        "epic": epic,
        "epicName": Path(epic).name if epic else "",
        "task": status.get("task", ""),
        "by": run.get("by", ""),
        "stopping": run.get("stopping"),
        "roles": run.get("roles") or [],
        "names": run.get("names") or {},
        "outworlders": run.get("outworlders") or [],
        "agents": run.get("agents") or {},
        "openSessions": sessions.get("open") or [],
        "workingSessions": sessions.get("working") or [],
        "pending": status.get("pending") or [],
        "ended": status.get("ended"),
        "budget": status.get("budget"),
        "usage": status.get("usage"),
        "attached": status.get("attached", 0),
        "snapshotError": snap_error,
        "recent": recent,
        "recentError": recent_error,
    }


OPS = {"ping": op_ping, "flows": op_flows, "flow": op_flow, "status": op_status}


def _handle(request: dict[str, Any]) -> None:
    rid = request.get("id")
    op = request.get("op")
    handler = OPS.get(op) if isinstance(op, str) else None
    if handler is None:
        _write({"id": rid, "ok": False, "error": f"unknown op: {op!r}"})
        return
    args = request.get("args") or {}
    if not isinstance(args, dict):
        _write({"id": rid, "ok": False, "error": "args must be an object"})
        return
    try:
        result = handler(args)
    except Exception as why:  # noqa: BLE001 -- every failure is answered, never swallowed
        detail = str(why) or type(why).__name__
        if os.environ.get("DSH_HMZ_ADAPTER_DEBUG"):
            traceback.print_exc(file=sys.stderr)
        _write({"id": rid, "ok": False, "error": detail})
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
            _write({"id": None, "ok": False, "error": "request is not JSON"})
            continue
        if not isinstance(request, dict):
            _write({"id": None, "ok": False, "error": "request is not an object"})
            continue
        worker = threading.Thread(target=_handle, args=(request,), daemon=True)
        worker.start()
        running = [one for one in running if one.is_alive()]
        running.append(worker)
    # The Host closed stdin: answer what was already asked, then go.
    for worker in running:
        worker.join(timeout=30)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
