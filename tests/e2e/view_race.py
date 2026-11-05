"""Flow page selection races, on the real client.js with mocked plugin RPCs.

usage: view_race.py <preview-dir>
Uses an isolated preview; opens a new DSH session in a scratch workspace and
answers the plugin's RPCs in the browser (no hmz, no model). Checks:
  1. switching to run B while run A's tree is still loading shows B's tree and output;
  2. switching sessions of one run while the first detail is still loading shows the
     second session's output and never the first's;
  3. nothing of A appears after A's late answers arrive.
"""
import asyncio
import json
import pathlib
import subprocess
import sys
import time

from playwright.async_api import async_playwright

from dshpage import CHROME, add_workspace, dismiss, read_url

preview = pathlib.Path(sys.argv[1]).resolve()
A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
failures = []


def check(cond, what):
    print(('PASS ' if cond else 'FAIL ') + what, flush=True)
    if not cond:
        failures.append(what)


async def main():
    ws = preview / 'runs' / f'race-{time.strftime("%H%M%S")}'
    ws.mkdir(parents=True)
    subprocess.run(['git', 'init', '-q'], cwd=ws, check=True)
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=CHROME)
        page = await browser.new_page(viewport={'width': 1500, 'height': 1000}, locale='zh-CN')
        calls, errors = [], []
        page.on('pageerror', lambda e: errors.append(str(e)))

        async def route(r):
            d = r.request.post_data_json
            calls.append(d)
            op = d['op']
            if op == 'getSelection':
                result = {'flow': None, 'binding': None, 'includeHistory': True, 'protected': False}
            elif op == 'runs':
                result = {'currentRunId': A, 'pending': [], 'runs': [
                    {'runId': x, 'current': x == A, 'flow': f'FLOW-{x[0]}', 'run': i + 1, 'phase': 'ended', 'endedHow': 'done', 'epicName': f'epic-{x[0]}'}
                    for i, x in enumerate([A, B])]}
            elif op == 'runTree':
                if d['runId'] == A:
                    await asyncio.sleep(3)
                result = {'epic': {'task': 'race fixture'}, 'agents': [{'agent': f'AG-{d["runId"][0]}', 'role': 'actor', 'sessions': [
                    {'key': f'dsh:s1-{d["runId"][0]}', 'backend': 'dsh', 'at': '2026-11-05T00:00:02Z'},
                    {'key': f'dsh:s2-{d["runId"][0]}', 'backend': 'dsh', 'at': '2026-11-05T00:00:01Z'}]}]}
            elif op == 'runSession':
                if d['sessionKey'].startswith('dsh:s1-'):
                    await asyncio.sleep(3)
                result = {'session': d['sessionKey'], 'total': 1, 'from': 0, 'to': 1, 'more': False,
                          'actions': [{'i': 0, 'category': 'message', 'title': 'out', 'text': f'OUTPUT {d["sessionKey"]}'}]}
            else:
                result = {}
            await r.fulfill(json={'ok': True, 'result': result})

        await page.goto(read_url(preview / 'private' / 'dsh-url'))
        await page.wait_for_timeout(3500)
        await dismiss(page)
        await add_workspace(page, str(ws))
        await page.route('**/api/hmz-flow/rpc', route)
        editor = page.locator('[contenteditable="true"]').first
        await editor.click()
        await page.keyboard.type('hello race fixture')
        await page.keyboard.press('Enter')
        await page.wait_for_timeout(4000)
        await page.get_by_role('tab', name='Flow', exact=True).click()
        await page.locator(f'[data-hmz-run="{B}"]').wait_for()
        for _ in range(100):
            if any(c['op'] == 'runTree' and c['runId'] == A for c in calls):
                break
            await page.wait_for_timeout(20)
        # 1. run switch while A's tree is in flight
        await page.locator(f'[data-hmz-run="{B}"]').click()
        await page.wait_for_timeout(1500)
        view = page.locator('[data-hmz-flow="view"]')
        check('AG-b' in await view.inner_text(), 'run B\'s tree shows while A\'s tree is still loading')
        # 2. session switch while s1's detail is in flight (s1 is selected first: newest)
        await page.locator('[data-hmz-session="dsh:s2-b"]').click()
        await page.wait_for_timeout(1500)
        text = await view.inner_text()
        check('OUTPUT dsh:s2-b' in text, 'the second session\'s output shows while the first is still loading')
        await page.wait_for_timeout(3500)  # every late answer has arrived
        text = await view.inner_text()
        check('OUTPUT dsh:s2-b' in text and 'OUTPUT dsh:s1-b' not in text, 'the late answer of the first session is not drawn')
        check('AG-a' not in text and 'OUTPUT dsh:s1-a' not in text and 'OUTPUT dsh:s2-a' not in text, 'nothing of run A is drawn after its late answers')
        check(not errors, f'no page errors ({errors[:2]})')
        print(json.dumps({'treeCalls': [c['runId'][0] for c in calls if c['op'] == 'runTree'],
                          'sessionCalls': [c['sessionKey'] for c in calls if c['op'] == 'runSession']}))
        await browser.close()


asyncio.run(main())
sys.exit(1 if failures else 0)
