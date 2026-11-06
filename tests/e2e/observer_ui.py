"""The flow reminder card and switch in the real DSH page (observer RPCs answered by the test).

usage: observer_ui.py <preview-dir>
Opens a new session in a scratch workspace, selects a flow, then answers only the
observer RPCs in the browser so a reminder exists; every other request goes to
the real Host. No model is called. Checks: the card shows the short reminder,
expands to the explanation with its sources, "Got it"/"Dismiss" send the exact
run and note, "Turn reminders off" and the options-panel switch send observerSet,
and the text is rendered as text (no markup injection).
"""
import asyncio
import json
import pathlib
import subprocess
import sys
import time

from playwright.async_api import async_playwright

from dshpage import CHROME, SessionTracker, add_workspace, dismiss, read_url

preview = pathlib.Path(sys.argv[1]).resolve()
RUN = '11111111-1111-4111-8111-111111111111'
NOTE_ID = 'n-0f0e0d0c-0b0a-4908-8706-050403020100'
failures = []


def check(cond, what):
    print(('PASS ' if cond else 'FAIL ') + what, flush=True)
    if not cond:
        failures.append(what)


async def main():
    ws = preview / 'runs' / f'observer-{time.strftime("%H%M%S")}'
    ws.mkdir(parents=True)
    subprocess.run(['git', 'init', '-q'], cwd=ws, check=True)
    state = {'enabled': True, 'status': 'open', 'acts': [], 'sets': []}

    def view():
        return {
            'enabled': state['enabled'], 'runId': RUN, 'current': True, 'phase': 'running', 'attempts': 1, 'maxAttempts': 6,
            'status': None, 'checking': False,
            'notes': [{
                'id': NOTE_ID, 'tag': 'heads_up', 'topic': 'cache', 'status': state['status'], 'partial': True,
                'title': '缓存只在单进程内失效，<b>多实例</b>部署会读到旧数据。',
                'detail': '工作者用进程内 Map 缓存，写入时只清除本地条目。<img src=x onerror=alert(1)>',
                'evidence': [{'ref': 'dsh:s1#2', 'agent': 'Actor', 'session': 'Actor/1', 'index': 2, 'category': 'tool', 'tool': 'bash', 'excerpt': 'input: grep cache\noutput: Map()'}],
            }],
        }

    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=CHROME)
        page = await browser.new_page(viewport={'width': 1400, 'height': 1000}, locale='zh-CN')
        tracker = SessionTracker(page)
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        dialogs = []
        page.on('dialog', lambda d: (dialogs.append(d.message), asyncio.ensure_future(d.dismiss())))

        async def route(r):
            body = json.loads(r.request.post_data or '{}')
            op = body.get('op')
            if op == 'observerGet':
                return await r.fulfill(json={'ok': True, 'result': view()})
            if op == 'observerAct':
                state['acts'].append(body)
                state['status'] = body['action']
                return await r.fulfill(json={'ok': True, 'result': {'id': body['noteId'], 'status': body['action']}})
            if op == 'observerSet':
                state['sets'].append(body)
                state['enabled'] = body['enabled']
                return await r.fulfill(json={'ok': True, 'result': {'enabled': body['enabled']}})
            await r.continue_()

        await page.goto(read_url(preview / 'private' / 'dsh-url'))
        await page.wait_for_timeout(3500)
        await dismiss(page)
        await add_workspace(page, str(ws))
        await page.route('**/api/hmz-flow/rpc', route)
        editor = page.locator('[contenteditable="true"]').first
        await editor.click()
        await page.keyboard.type('/chat')
        await page.wait_for_timeout(2000)
        await page.get_by_role('option').filter(has_text='chat').first.click()
        await page.wait_for_timeout(3500)

        # The switch in the options panel.
        switch = page.locator('[data-hmz-flow="observer-switch"]')
        check(await switch.count() == 1 and await switch.get_attribute('aria-checked') == 'true', 'the options panel has the reminders switch, on')
        panel_text = await page.locator('[data-hmz-flow="panel"]').inner_text()
        check('不计入 flow 预算' in panel_text and '最多查看 6 次' in panel_text, 'the cost note and the limit are beside the switch')
        check('已检查 1/6 次' in await page.locator('[data-hmz-flow="observer-status"]').inner_text(), 'the status line shows the count')
        await switch.click()
        await page.wait_for_timeout(800)
        check(state['sets'][-1:] == [{'op': 'observerSet', 'sessionId': tracker.last, 'enabled': False}], 'the switch sends observerSet for this session')
        check(await switch.get_attribute('aria-checked') == 'false', 'the switch shows off')
        await switch.click()
        await page.wait_for_timeout(800)
        await page.locator('[data-hmz-flow="panel"]').get_by_role('button', name='关闭').click()

        card = page.locator('[data-hmz-flow="observer"]')
        await card.wait_for(timeout=15000)
        title = await page.locator('[data-hmz-flow="observer-title"]').inner_text()
        check('<b>多实例</b>' in title and '请注意' in await card.inner_text(), 'the short reminder shows, text rendered as text')
        check(await card.locator('[data-hmz-flow="observer-detail"]').count() == 0, 'collapsed by default')
        await page.screenshot(path=str(preview / 'shots' / 'observer-01-card.png'))
        await card.locator('[data-hmz-flow="observer-expand"]').click()
        await page.wait_for_timeout(500)
        detail = await card.locator('[data-hmz-flow="observer-detail"]').inner_text()
        check('<img src=x onerror=alert(1)>' in detail and not dialogs and not errors, 'the explanation shows as text, nothing runs')
        check('Actor/1 · 第 3 条记录 · 工具 bash' in detail and 'grep cache' in detail, 'the source is named: session, record index, tool, excerpt')
        check('只基于最近的一部分记录' in detail, 'a partial basis is said')
        await page.screenshot(path=str(preview / 'shots' / 'observer-02-expanded.png'))
        await card.locator('[data-hmz-flow="observer-known"]').click()
        await page.wait_for_timeout(1500)
        check(state['acts'][-1:] == [{'op': 'observerAct', 'sessionId': tracker.last, 'runId': RUN, 'noteId': NOTE_ID, 'action': 'known'}], '"知道了" sends the exact run and note')
        check(await card.count() == 0, 'the card goes away once handled')
        state['status'] = 'open'
        await page.wait_for_timeout(9000)
        await card.locator('[data-hmz-flow="observer-dismiss"]').click()
        await page.wait_for_timeout(1500)
        check(state['acts'][-1]['action'] == 'dismissed', '"忽略" sends dismissed')
        state['status'] = 'open'
        await page.wait_for_timeout(9000)
        await card.locator('[data-hmz-flow="observer-off"]').click()
        await page.wait_for_timeout(1500)
        check(state['sets'][-1]['enabled'] is False and await card.count() == 0, '"关闭提醒" turns reminders off and hides the card')
        check(not errors, f'no page errors ({errors[:2]})')
        await browser.close()


asyncio.run(main())
sys.exit(1 if failures else 0)
