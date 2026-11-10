"""Offered canonical flow refs are preserved; arbitrary paths never reach import.

Run with the hmz Python: python -I adapter_flow_unit.py <adapter.py>.
No daemon, model or network is used.
"""
import importlib.util
import sys
import tempfile
import types

spec = importlib.util.spec_from_file_location("adapter_flow_under_test", sys.argv[1])
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)

offered = ["@local/humanize1:gen-idea", "@user/humanize1:gen-plan", "@user/humanize1:rlcr"]
runtime = types.SimpleNamespace(flows=types.SimpleNamespace(all=lambda: [types.SimpleNamespace(name=name) for name in offered]))
imports = []


def declared(hmz, name):
    assert hmz is runtime
    imports.append(name)
    return {"name": name}


sys.modules["hmz.sdk"] = types.SimpleNamespace(Hmz=lambda workspace: runtime)
sys.modules["hmz.web.flows"] = types.SimpleNamespace(declared=declared)
with tempfile.TemporaryDirectory() as workspace:
    for name in offered:
        assert adapter.op_flow({"workspace": workspace, "name": name}) == {"name": name}
    assert imports == offered
    for name in ["humanize1:rlcr", "/tmp/unoffered-flow", "../unoffered-flow", "@user/unknown", "@local/humanize1:rlcr"]:
        try:
            adapter.op_flow({"workspace": workspace, "name": name})
        except adapter.Refused:
            pass
        else:
            raise AssertionError("Unoffered name reached declaration: " + name)
    assert imports == offered
print("PASS canonical refs preserved; unoffered aliases and paths rejected before import")
