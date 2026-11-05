"""Session-scoped Flow page on an isolated DSH preview (DeepSeek-backed chat runs).

usage: verify_sessions.py <preview-dir> <shots-dir>
Environment: PREVIEW_TMUX (dedicated, not the user's), DSH_PORT, HMZ_TEST_AGENT_PARTS.

A: starts a chat run; its Flow page lists it and shows Epic -> Agent -> Session output.
B: a new session that only says hello; its Flow page is empty and asks hmz nothing.
A late response for A never renders in B. A then gets a second run: both are kept,
the older one can be viewed while leader control stays on the current one. After a
DSH restart A shows the same runs. Evidence: plugin state for the exact session ids,
the plugin's own RPC traffic, and the rendered DOM.
"""
import asyncio
import json
import os
import pathlib
import re
import subprocess
import sys
import time

from playwright.async_api import async_playwright

from dshpage import CHROME, SessionTracker, add_workspace, dismiss, read_url, state

preview, shots = pathlib.Path(sys.argv[1]).resolve(), pathlib.Path(sys.argv[2])
shots.mkdir(parents=True, exist_ok=True)
STATE = preview / 'state' / 'state.json'
ROOT = pathlib.Path(__file__).resolve().parents[2]
CLI, ACCOUNT, MODEL = os.environ.get('HMZ_TEST_AGENT_PARTS', 'dsh,preview-deepseek,deepseek-flash').split(',')
if CLI == 'claude':
    raise SystemExit('refusing a Claude-backed agent for a real hmz run')
TMUX = os.environ.get('PREVIEW_TMUX', '')
if not TMUX or TMUX == 'dsh-hmz-preview':
    raise SystemExit('set a dedicated PREVIEW_TMUX; the user preview must not be restarted')
failures = []


def check(cond, what):
    print(('PASS ' if cond else 'FAIL ') + what, flush=True)
    if not cond:
        failures.append(what)


def runs_of(sid):
    entry = state(STATE)['sessions'].get(sid) or {}
    return [entry['runs'][r] for r in entry.get('runOrder', []) if r in entry.get('runs', {})], entry.get('binding')


async def wait_for(pred, seconds, every=2):
    end = time.time() + seconds
    while time.time() < end:
        got = pred()
        if got:
            return got
        await asyncio.sleep(every)
    return pred()


async def ask(page, text, seconds=180):
    editor = page.locator('[contenteditable="true"]').first
    await editor.click()
    await page.keyboard.type(text)
    await page.keyboard.press('Enter')
    for _ in range(seconds):
        await page.wait_for_timeout(1000)
        tail = (await page.locator('body').inner_text()).split(text)[-1]
        if '已完成' in tail and not re.search(r'思考中|正在', tail[-300:]):
            break
    await page.wait_for_timeout(1500)


async def tab(page, name):
    await page.get_by_role('tab', name=name, exact=True).click()
    await page.wait_for_timeout(2500)


def fresh_workspace(kind):
    ws = preview / 'runs' / f'{kind}-{time.strftime("%H%M%S")}'
    ws.mkdir(parents=True)
    subprocess.run(['git', 'init', '-q'], cwd=ws, check=True)
    (ws / 'README.md').write_text('# session isolation test\n')
    return ws


async def select_chat(page):
    editor = page.locator('[contenteditable="true"]').first
    await editor.click()
    await page.keyboard.type('/chat')
    await page.wait_for_timeout(2000)
    await page.get_by_role('option').filter(has_text='chat').first.click()
    await page.wait_for_timeout(4000)
    form = page.locator('[data-hmz-flow="form"]')
    await form.locator('[data-hmz-field="assistant.cli"]').select_option(CLI)
    await page.wait_for_timeout(300)
    await form.locator('[data-hmz-field="assistant.account"]').select_option(ACCOUNT)
    await form.locator('[data-hmz-field="assistant.model"]').fill(MODEL)
    await page.locator('[data-hmz-flow="save"]').click()
    await page.wait_for_timeout(1200)
    await page.locator('[data-hmz-flow="panel"]').get_by_role('button', name='关闭').click()


async def session_title(page):
    return (await page.locator('header, [class*="header"]').first.inner_text()).split('\n')[0].strip()


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=CHROME)
        context = await browser.new_context(viewport={'width': 1500, 'height': 1000}, locale='zh-CN')
        page = await context.new_page()
        tracker = SessionTracker(page)
        rpc_log = []
        page.on('request', lambda r: rpc_log.append(json.loads(r.post_data or '{}')) if 'api/hmz-flow/rpc' in r.url and r.method == 'POST' else None)
        errors = []
        page.on('console', lambda m: errors.append(m.text[:300]) if m.type == 'error' else None)
        await page.goto(read_url(preview / 'private' / 'dsh-url'))
        await page.wait_for_timeout(3500)
        await dismiss(page)

        # ---------------------------------------------------------------- A
        ws = fresh_workspace('iso')
        await add_workspace(page, str(ws))
        await select_chat(page)
        sid_a = tracker.last
        await ask(page, '请用选中的 chat flow 开始：让助手用一句中文打招呼，然后等我回答。已授权，直接启动。', 240)
        got = await wait_for(lambda: (lambda rs, b: b if b and b.get('epicName') and b.get('phase') == 'running' else None)(*runs_of(sid_a)), 120)
        check(bool(got), f'A: a chat run is bound to session A ({got and (got["run"], got["epicName"])})')
        if not got:
            return
        run1 = got['requestId']
        title_a = await session_title(page)
        await tab(page, 'Flow')
        view = page.locator('[data-hmz-flow="view"]')
        check(await view.get_attribute('data-hmz-state') == 'runs', 'A: Flow page lists this session\'s runs')
        check(await page.locator('iframe').count() == 0, 'A: no iframe; the page is drawn from SDK data')
        await page.locator('[data-hmz-flow="tree"] [data-hmz-agent]').first.wait_for(timeout=30000)
        tree_text = await page.locator('[data-hmz-flow="tree"]').inner_text()
        check(got['names']['assistant'] in tree_text and 'assistant' in tree_text, f'A: tree shows role assistant -> {got["names"]["assistant"]}')
        message = page.locator('[data-hmz-action="message"]')
        await wait_for(lambda: True, 1)
        for _ in range(30):
            if await message.count():
                break
            await page.get_by_role('button', name='刷新').click()
            await page.wait_for_timeout(3000)
        check(await message.count() > 0, 'A: the selected session shows the agent\'s real output (message actions)')
        await page.screenshot(path=str(shots / 'iso-01-A-flow.png'), full_page=True)

        # ---------------------------------------------------------------- B
        await tab(page, '对话')
        await page.get_by_text('新会话', exact=True).first.click()
        await page.wait_for_timeout(2500)
        await ask(page, 'hello', 90)
        sid_b = tracker.last if tracker.last != sid_a else None
        mark = len(rpc_log)
        await tab(page, 'Flow')
        await page.wait_for_timeout(3000)
        sid_b = sid_b or next((r.get('sessionId') for r in rpc_log[mark:] if r.get('sessionId') != sid_a), None)
        check(sid_b and sid_b != sid_a, f'B is a different DSH session ({sid_b})')
        check(await page.locator('[data-hmz-flow="view"]').get_attribute('data-hmz-state') == 'empty', 'B: Flow page is empty (no fallback to A\'s run in the same directory)')
        b_ops = [r.get('op') for r in rpc_log[mark:] if r.get('sessionId') == sid_b]
        check('runTree' not in b_ops and 'runSession' not in b_ops and 'status' not in b_ops, f'B: no tree/detail/status request was made ({sorted(set(b_ops))})')
        check(got['epicName'] not in await page.locator('body').inner_text(), 'B: nothing of A\'s epic is rendered')
        check(not runs_of(sid_b)[0], 'B: no run recorded for B')
        await page.screenshot(path=str(shots / 'iso-02-B-empty.png'), full_page=True)

        # A forged cross-session request from B's page is refused by the Host.
        forged = await page.evaluate("""async ([sid, run]) => {
          const r = await fetch('api/hmz-flow/rpc', {method: 'POST', headers: {'content-type': 'application/json'},
            body: JSON.stringify({op: 'runTree', sessionId: sid, runId: run})}); return r.status }""", [sid_b, run1])
        check(forged == 403, f'B: asking for A\'s run id under B\'s session is 403 ({forged})')

        # ------------------------------------------------- late response for A
        await tab(page, '对话')
        await page.get_by_text(title_a, exact=True).first.click()
        await page.wait_for_timeout(3000)
        check(tracker.last == sid_a, f'switched back to A ({tracker.last})')

        async def slow(route):
            await asyncio.sleep(5)
            await route.continue_()
        await page.route('**/api/hmz-flow/rpc', slow)
        await tab(page, 'Flow')
        await page.wait_for_timeout(800)
        await tab(page, '对话')
        await page.get_by_text('新会话', exact=True).first.click()
        await page.wait_for_timeout(1500)
        await page.unroute('**/api/hmz-flow/rpc')
        await tab(page, 'Flow')
        await page.wait_for_timeout(7000)
        body = await page.locator('[data-hmz-flow="view"]').inner_text()
        check(got['epicName'] not in body and await page.locator('[data-hmz-flow="detail"]').count() == 0,
              'a delayed response for A did not render in the next session')
        await tab(page, '对话')
        await page.get_by_text(title_a, exact=True).first.click()
        await page.wait_for_timeout(3000)

        # ----------------------------------------- A: second run keeps history
        await ask(page, '请停止这个 chat flow。', 150)
        ended = await wait_for(lambda: (lambda rs, b: b if b and b.get('phase') == 'ended' else None)(*runs_of(sid_a)), 180)
        check(bool(ended), 'A: first run verified ended')
        await ask(page, '请再用 chat flow 开一个新任务：让助手用一句英文打招呼，然后等我回答。已授权，直接启动。', 240)
        second = await wait_for(lambda: (lambda rs, b: b if b and b.get('requestId') != run1 and b.get('epicName') else None)(*runs_of(sid_a)), 120)
        runs, binding = runs_of(sid_a)
        check(bool(second) and [r['requestId'] for r in runs][:1] == [run1] and len(runs) == 2, f'A: two runs kept in order ({[(r["run"], r["phase"]) for r in runs]})')
        await tab(page, 'Flow')
        await page.wait_for_timeout(4000)
        listed = await page.locator('[data-hmz-run]').evaluate_all('els => els.map(e => [e.dataset.hmzRun, e.dataset.hmzPhase])')
        check(len(listed) == 2 and listed[0][0] == second['requestId'], f'A: Flow lists both runs, newest current first ({listed})')
        await page.locator(f'[data-hmz-run="{run1}"]').click()
        await page.wait_for_timeout(4000)
        check(await page.locator('[data-hmz-flow="history-note"]').count() == 1, 'A: viewing the older run shows the history note')
        await page.screenshot(path=str(shots / 'iso-03-A-history.png'), full_page=True)
        await tab(page, '对话')
        await ask(page, '请转告 assistant：回答尽量短。', 150)
        _, binding = runs_of(sid_a)
        await tab(page, '轨迹')
        traj = await page.locator('body').inner_text()
        check(f'on run #{binding["run"]}' in traj and 'ACCEPTED by hmz for assistant' in traj,
              f'A: send went to the current run #{binding["run"]} while an older run was being viewed (tool result)')
        await tab(page, '对话')

        # ------------------------------------------------- DSH restart, reopen
        subprocess.run(['tmux', '-L', TMUX, 'kill-session', '-t', 'dsh'], check=False)
        time.sleep(2)
        subprocess.run([str(ROOT / 'scripts' / 'preview.sh'), 'start'], check=True, capture_output=True, env={**os.environ, 'PREVIEW_DIR': str(preview)})
        await page.reload()
        await page.wait_for_timeout(7000)
        await dismiss(page)
        await page.get_by_text(title_a, exact=True).first.click()
        await page.wait_for_timeout(3000)
        await tab(page, 'Flow')
        await page.wait_for_timeout(4000)
        listed = await page.locator('[data-hmz-run]').evaluate_all('els => els.map(e => e.dataset.hmzRun)')
        check(listed == [second['requestId'], run1], 'A after DSH restart: the same two runs, current first')
        await page.screenshot(path=str(shots / 'iso-04-A-after-restart.png'), full_page=True)
        await tab(page, '对话')
        await ask(page, '请停止这个 chat flow。', 150)
        done = await wait_for(lambda: (lambda rs, b: b if b and b.get('phase') == 'ended' else None)(*runs_of(sid_a)), 180)
        check(bool(done), 'A: second run verified ended')

        relevant = [e for e in errors if 'hmz' in e.lower() or 'slot entry crashed' in e]
        check(not relevant, f'no plugin console errors ({relevant[:3]})')
        await browser.close()


asyncio.run(main())
sys.exit(1 if failures else 0)
