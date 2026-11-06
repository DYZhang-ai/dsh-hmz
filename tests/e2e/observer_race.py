"""Late and out-of-order observer replies in the real DSH page (observer RPCs answered by the test).

usage: observer_race.py <preview-dir>
No model is called: only observerGet/Set/Act are answered in the browser, each
DSH session with its own fixture state; everything else goes to the real Host.

Checks:
- the options panel's status line: on/count, timeout, no model, limit reached, off;
- session switch: a reply for session A that arrives after the page moved to
  session B never shows A's note in B's card, and A's late toggle failure never
  shows in B's panel;
- same session, run change: an older observerGet reply (previous run, previous
  note) that arrives after a newer one never restores the previous run's note;
- a new note starts collapsed even if the previous one was expanded.
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
RUN1 = '11111111-1111-4111-8111-111111111111'
RUN2 = '22222222-2222-4222-8222-222222222222'
failures = []


def check(cond, what):
    print(('PASS ' if cond else 'FAIL ') + what, flush=True)
    if not cond:
        failures.append(what)


def note_id(n):
    return f'n-{n:08x}-0000-4000-8000-000000000000'


class Fixture:
    def __init__(self, label, n):
        self.label = label
        self.enabled = True
        self.run = RUN1
        self.attempts = 1
        self.status = None
        self.note = n
        self.open = True
        self.get_delay = 0.0   # seconds before an observerGet reply
        self.get_snapshot = None  # a frozen (older) view to reply with, when delayed
        self.set_delay = 0.0
        self.set_fails = False
        self.delayed_seen = None  # asyncio.Event set when a delayed get arrives
        self.hold_all = False  # keep delaying every get (not just the next one)

    def view(self):
        return {
            'enabled': self.enabled, 'runId': self.run, 'current': True, 'phase': 'running',
            'attempts': self.attempts, 'maxAttempts': 6, 'limited': self.attempts >= 6,
            'status': self.status, 'checking': False,
            'notes': [{
                'id': note_id(self.note), 'tag': 'know', 'topic': f't{self.note}', 'status': 'open', 'partial': False,
                'title': f'{self.label} 的提醒 #{self.note}', 'detail': f'{self.label} 的说明 #{self.note}',
                'evidence': [{'ref': 'dsh:s#0', 'agent': 'Actor', 'session': 'Actor/1', 'index': 0, 'category': 'instruction', 'tool': '', 'excerpt': 'build a CLI'}],
            }] if self.open else [],
        }


async def main():
    stamp = time.strftime('%H%M%S')
    wss = []
    for name in ('a', 'b'):
        ws = preview / 'runs' / f'observer-race-{name}-{stamp}'
        ws.mkdir(parents=True)
        subprocess.run(['git', 'init', '-q'], cwd=ws, check=True)
        wss.append(ws)
    fixtures = {}
    order = []

    def fixture(sid):
        if sid not in fixtures:
            order.append(sid)
            label = 'AB'[len(order) - 1] if len(order) <= 2 else f'S{len(order)}'
            fixtures[sid] = Fixture(label, 100 * len(order))
        return fixtures[sid]

    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=CHROME)
        page = await browser.new_page(viewport={'width': 1400, 'height': 1000}, locale='zh-CN')
        tracker = SessionTracker(page)
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))

        async def route(r):
            body = json.loads(r.request.post_data or '{}')
            op = body.get('op')
            if op not in ('observerGet', 'observerSet', 'observerAct'):
                return await r.continue_()
            f = fixture(body.get('sessionId'))
            try:
                if op == 'observerGet':
                    if f.get_delay:
                        result = f.get_snapshot or f.view()
                        delay = f.get_delay
                        if not f.hold_all:
                            f.get_delay, f.get_snapshot = 0.0, None
                        if f.delayed_seen:
                            f.delayed_seen.set()
                        await asyncio.sleep(delay)
                        return await r.fulfill(json={'ok': True, 'result': result})
                    return await r.fulfill(json={'ok': True, 'result': f.view()})
                if op == 'observerSet':
                    if f.set_delay:
                        await asyncio.sleep(f.set_delay)
                    if f.set_fails:
                        return await r.fulfill(json={'ok': False, 'error': 'LATE-TOGGLE-FAILURE'})
                    f.enabled = body['enabled']
                    return await r.fulfill(json={'ok': True, 'result': {'enabled': f.enabled}})
                if op == 'observerAct':
                    f.open = False
                    if f.on_act:
                        f.on_act(f)
                    return await r.fulfill(json={'ok': True, 'result': {'id': body['noteId'], 'status': body['action']}})
            except Exception:  # the page may have moved on; a late reply has nowhere to go
                pass

        Fixture.on_act = None
        await page.goto(read_url(preview / 'private' / 'dsh-url'))
        await page.wait_for_timeout(3500)
        await dismiss(page)
        await page.route('**/api/hmz-flow/rpc', route)
        await add_workspace(page, str(wss[0]))
        editor = page.locator('[contenteditable="true"]').first
        await editor.click()
        await page.keyboard.type('/chat')
        await page.wait_for_timeout(2000)
        await page.get_by_role('option').filter(has_text='chat').first.click()
        await page.wait_for_timeout(3500)
        sid_a = tracker.last
        a = fixture(sid_a)
        card = page.locator('[data-hmz-flow="observer"]')
        status = page.locator('[data-hmz-flow="observer-status"]')
        switch = page.locator('[data-hmz-flow="observer-switch"]')

        # ---- the status line (the panel re-reads every 5 s)
        text = await status.inner_text()
        check('已开启' in text and '已检查 1/6 次' in text, f'status: on, with the count ({text!r})')
        a.status, a.attempts = {'kind': 'timeout', 'at': 'x'}, 2
        await page.wait_for_timeout(5600)
        text = await status.inner_text()
        check('上一次查看超时' in text and '2/6' in text, f'status: timeout ({text!r})')
        a.status = {'kind': 'no-model', 'at': 'x'}
        await page.wait_for_timeout(5600)
        check('没有可用的模型' in await status.inner_text(), 'status: no model')
        a.status, a.attempts = {'kind': 'nothing', 'at': 'x'}, 6
        await page.wait_for_timeout(5600)
        text = await status.inner_text()
        check('检查次数已用完' in text and '6/6' in text, f'status: limit reached ({text!r})')
        a.attempts, a.status = 1, None
        await switch.click()
        await page.wait_for_timeout(800)
        check('提醒已关闭' in await status.inner_text() and await switch.get_attribute('aria-checked') == 'false', 'status: off')
        await switch.click()
        await page.wait_for_timeout(800)
        check(await switch.get_attribute('aria-checked') == 'true', 'back on')
        await card.wait_for(timeout=10000)
        check(await card.get_attribute('data-hmz-note') == note_id(100), "A's card shows A's note")

        # ---- session switch with A's replies still on their way
        a.delayed_seen = asyncio.Event()
        a.hold_all, a.get_delay = True, 9.0  # every read of A (card and panel) now comes late
        a.get_snapshot = {**a.view(), 'notes': [{**a.view()['notes'][0], 'id': note_id(199), 'title': 'A-LATE 迟到的提醒'}]}
        await asyncio.wait_for(a.delayed_seen.wait(), timeout=20)  # the next poll of A is now held
        a.set_delay, a.set_fails = 8.0, True
        await switch.click()  # A's toggle reply will come late and fail
        await add_workspace(page, str(wss[1]))
        await editor.click()
        await page.keyboard.type('/chat')
        await page.wait_for_timeout(2000)
        await page.get_by_role('option').filter(has_text='chat').first.click()
        sid_b = tracker.last
        check(sid_b != sid_a, 'the page moved to a second session')
        b = fixture(sid_b)
        seen_notes, seen_text = set(), []
        for _ in range(48):  # 12 s: well past A's late replies
            if await card.count():
                seen_notes.add(await card.get_attribute('data-hmz-note'))
            seen_text.append(await page.locator('body').inner_text())
            await page.wait_for_timeout(250)
        check(note_id(100) not in seen_notes and note_id(199) not in seen_notes and not any('A-LATE' in x or 'A 的提醒' in x for x in seen_text),
              f"A's late reply never shows in B ({sorted(x for x in seen_notes if x)})")
        check(note_id(b.note) in seen_notes, "B's own note shows")
        check(not any('LATE-TOGGLE-FAILURE' in x for x in seen_text), "A's late toggle failure never shows in B's panel")
        check(await switch.count() == 1 and await switch.get_attribute('aria-checked') == 'true', "B's switch shows B's state (on)")
        await page.locator('[data-hmz-flow="panel"]').get_by_role('button', name='关闭').click()
        await page.wait_for_timeout(500)

        # ---- same session: an older reply (previous run) arrives after a newer one
        check(await card.get_attribute('data-hmz-run') == RUN1, 'B starts on run 1')
        old_view = b.view()  # run 1, its open note
        b.delayed_seen = asyncio.Event()
        b.get_delay, b.get_snapshot = 7.0, old_view
        await asyncio.wait_for(b.delayed_seen.wait(), timeout=20)  # the next poll of B is held with the old view

        def to_run2(f):
            f.run, f.note, f.open = RUN2, 300, True
        Fixture.on_act = staticmethod(to_run2)
        await card.locator('[data-hmz-flow="observer-known"]').click()  # newer read: run 2, new note
        runs, notes = [], []
        for _ in range(40):  # 10 s, past the held reply
            if await card.count():
                runs.append(await card.get_attribute('data-hmz-run'))
                notes.append(await card.get_attribute('data-hmz-note'))
            await page.wait_for_timeout(250)
        Fixture.on_act = None
        check(runs and runs[-1] == RUN2 and notes[-1] == note_id(300), f'the newer run 2 note is shown ({runs[-1:]}, {notes[-1:]})')
        first2 = runs.index(RUN2) if RUN2 in runs else len(runs)
        check(all(x == RUN2 for x in runs[first2:]), 'the late older reply never restores run 1')

        # ---- a new note starts collapsed
        await card.locator('[data-hmz-flow="observer-expand"]').click()
        await page.wait_for_timeout(400)
        check(await card.locator('[data-hmz-flow="observer-detail"]').count() == 1, 'expanded')
        check('第 1 条记录 · 收到的指令' in await card.locator('[data-hmz-flow="observer-detail"]').inner_text(), 'an instruction source is labelled as a record')
        b.note = 301  # e.g. handled in another tab and a new note came
        await page.wait_for_timeout(9000)
        check(await card.get_attribute('data-hmz-note') == note_id(301), 'the new note arrived')
        check(await card.locator('[data-hmz-flow="observer-detail"]').count() == 0, 'the new note is collapsed')
        await page.screenshot(path=str(preview / 'shots' / 'observer-race-final.png'))
        check(not errors, f'no page errors ({errors[:2]})')
        await browser.close()


asyncio.run(main())
sys.exit(1 if failures else 0)
