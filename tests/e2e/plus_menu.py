"""The composer's + menu offers Flow; choosing a flow keeps the draft and starts nothing.

usage: plus_menu.py <preview-dir>
Isolated preview only; sends no message to any model. Checks:
  + -> Flow -> popup lists hmz flows -> chat -> flow选项 button and options panel;
  a draft typed before is still in the composer; the / path still offers the Flow group;
  leaving flow mode from + returns to ordinary DSH; no run was bound.
"""
import asyncio
import json
import pathlib
import subprocess
import sys
import time

from playwright.async_api import async_playwright

from dshpage import CHROME, SessionTracker, add_workspace, dismiss, read_url, state

preview = pathlib.Path(sys.argv[1]).resolve()
failures = []


def check(cond, what):
    print(('PASS ' if cond else 'FAIL ') + what, flush=True)
    if not cond:
        failures.append(what)


async def open_plus(page):
    composer = page.locator('[data-composer-card]').first
    buttons = composer.locator('button')
    for i in range(await buttons.count()):
        b = buttons.nth(i)
        if (await b.inner_text()).strip() in ('+', '＋', '') and await b.is_visible():
            label = (await b.get_attribute('aria-label')) or ''
            if '添加' in label or 'add' in label.lower() or 'command' in label.lower() or '指令' in label:
                await b.click()
                return label
    raise SystemExit('no + button found in the composer')


async def main():
    ws = preview / 'runs' / f'plus-{time.strftime("%H%M%S")}'
    ws.mkdir(parents=True)
    subprocess.run(['git', 'init', '-q'], cwd=ws, check=True)
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=CHROME)
        page = await browser.new_page(viewport={'width': 1400, 'height': 1000}, locale='zh-CN')
        tracker = SessionTracker(page)
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        rpc_ops = []
        page.on('request', lambda r: rpc_ops.append(json.loads(r.post_data or '{}').get('op')) if 'api/hmz-flow/rpc' in r.url else None)
        await page.goto(read_url(preview / 'private' / 'dsh-url'))
        await page.wait_for_timeout(3500)
        await dismiss(page)
        await add_workspace(page, str(ws))
        editor = page.locator('[contenteditable="true"]').first
        await editor.click()
        await page.keyboard.type('draft text that must survive')
        label = await open_plus(page)
        await page.wait_for_timeout(1500)
        menu = await page.get_by_role('listbox').inner_text()
        check('Flow' in menu and '添加' in menu and '指令' in menu, f'+ menu ({label!r}) lists Flow beside 添加/指令')
        await page.screenshot(path=str(preview / 'shots' / 'plus-01-menu.png'))
        await page.get_by_role('option').filter(has_text='选择本会话使用的 hmz flow').first.click()
        await page.wait_for_timeout(2500)
        popup = await page.locator('body').inner_text()
        check('chat' in popup and 'rlar' in popup, 'the Flow popup lists this workspace\'s hmz flows')
        await page.screenshot(path=str(preview / 'shots' / 'plus-02-popup.png'))
        await page.get_by_role('option').filter(has_text='chat').first.click()
        await page.wait_for_timeout(3000)
        button = page.locator('[data-hmz-flow="options"]')
        check(await button.count() == 1 and 'chat' in await button.inner_text(), 'flow选项 · chat appears in the composer')
        check(await page.locator('[data-hmz-flow="panel"]').count() == 1, 'the options panel opened')
        draft = (await editor.inner_text()).strip()
        check(draft == 'draft text that must survive', f'the draft is kept ({draft!r})')
        sid = tracker.last
        entry = state(preview / 'state' / 'state.json')['sessions'].get(sid) or {}
        check((entry.get('selection') or {}).get('flow') == 'chat', 'the selection is saved for this session')
        check(not entry.get('binding') and not entry.get('runOrder'), 'nothing was started (no run bound)')
        await page.screenshot(path=str(preview / 'shots' / 'plus-03-selected.png'), full_page=True)
        await page.locator('[data-hmz-flow="panel"]').get_by_role('button', name='关闭').click()

        # The / path still offers the Flow group.
        await editor.click()
        await page.keyboard.press('End')
        await page.keyboard.press('Control+a')
        await page.keyboard.press('Delete')
        await page.keyboard.type('/')
        await page.wait_for_timeout(2000)
        menu = await page.get_by_role('listbox').inner_text()
        check('rlar' in menu and 'Flow' in menu, '/ still shows the Flow group')
        await page.keyboard.press('Escape')
        await page.keyboard.press('Control+a')
        await page.keyboard.press('Delete')

        # Leave flow mode from +.
        await editor.click()
        await page.keyboard.type('second draft')
        await open_plus(page)
        await page.wait_for_timeout(1500)
        await page.get_by_role('option').filter(has_text='选择本会话使用的 hmz flow').first.click()
        await page.wait_for_timeout(2500)
        await page.get_by_role('option').filter(has_text='取消 flow 模式').first.click()
        await page.wait_for_timeout(2500)
        check(await page.locator('[data-hmz-flow="options"]').count() == 0, 'leaving flow mode from + hides flow选项')
        check((await editor.inner_text()).strip() == 'second draft', 'the draft is kept when leaving flow mode')
        entry = state(preview / 'state' / 'state.json')['sessions'].get(sid) or {}
        check((entry.get('selection') or {}).get('flow') is None, 'the session is back to ordinary DSH')
        check(not errors, f'no page errors ({errors[:2]})')
        await browser.close()


asyncio.run(main())
sys.exit(1 if failures else 0)
