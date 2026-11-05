"""Real Host + adapter + SDK, through the plugin's authenticated RPC from a DSH page.

usage: flow_rpc_real.py <preview-dir>
Picks a session of the preview's plugin state that has an ended run with an epic,
reads its runs, tree and one session's output, and checks that a session without
runs gets nothing and that the run id is refused under any other session. No hmz
web service is needed and no model is called.
"""
import asyncio
import json
import pathlib
import sys

from playwright.async_api import async_playwright

from dshpage import CHROME, dismiss, read_url, state

preview = pathlib.Path(sys.argv[1]).resolve()
failures = []


def check(cond, what):
    print(('PASS ' if cond else 'FAIL ') + what, flush=True)
    if not cond:
        failures.append(what)


async def main():
    sessions = state(preview / 'state' / 'state.json')['sessions']
    owner, run = next(((sid, e['runs'][r]) for sid, e in sessions.items() for r in e.get('runOrder', [])
                       if e['runs'][r].get('epicName') and e['runs'][r].get('phase') == 'ended'), (None, None))
    if owner is None:
        raise SystemExit('no ended run with an epic in this preview\'s state')
    other = next((sid for sid in sessions if sid != owner), None)
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=CHROME)
        page = await browser.new_page()
        await page.goto(read_url(preview / 'private' / 'dsh-url'))
        await page.wait_for_timeout(3000)
        await dismiss(page)

        async def rpc(body):
            return await page.evaluate("""async (body) => {
              const r = await fetch('api/hmz-flow/rpc', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)})
              return {status: r.status, body: await r.json()} }""", body)

        listed = await rpc({'op': 'runs', 'sessionId': owner})
        runs = listed['body'].get('result', {}).get('runs', [])
        check(listed['status'] == 200 and any(r['runId'] == run['runId'] for r in runs), f'owner session lists its run ({run["flow"]} #{run["run"]} {run["epicName"]})')
        tree = await rpc({'op': 'runTree', 'sessionId': owner, 'runId': run['runId']})
        agents = tree['body'].get('result', {}).get('agents', [])
        check(tree['status'] == 200 and agents and agents[0]['sessions'], f'tree read through the real SDK ({[(a["role"], a["agent"]) for a in agents]})')
        key = agents[0]['sessions'][0]['key'] if agents and agents[0]['sessions'] else ''
        detail = await rpc({'op': 'runSession', 'sessionId': owner, 'runId': run['runId'], 'sessionKey': key})
        actions = detail['body'].get('result', {}).get('actions', [])
        check(detail['status'] == 200 and actions, f'session output read ({len(actions)} actions, categories {sorted({a["category"] for a in actions})})')
        if other:
            cross = await rpc({'op': 'runTree', 'sessionId': other, 'runId': run['runId']})
            check(cross['status'] in (403, 404), f'the same run id under another session is refused ({cross["status"]})')
        print(json.dumps({'owner': owner, 'run': run['runId'], 'sessionKey': key}))
        await browser.close()


asyncio.run(main())
sys.exit(1 if failures else 0)
