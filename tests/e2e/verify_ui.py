"""End-to-end probe of the real DSH preview with the @dsh-hmz/flow plugin.

usage: verify_ui.py <dsh-url-file> <shots-dir> <workspace> <expected-epic>
Prints PASS/FAIL lines; exits non-zero on the first failure.
"""
import asyncio
import sys

from playwright.async_api import async_playwright

from dshpage import CHROME, open_workspace, read_url

url_file, shots, workspace, epic = sys.argv[1:5]
failures = []


def check(cond, what):
    print(('PASS ' if cond else 'FAIL ') + what, flush=True)
    if not cond:
        failures.append(what)


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=CHROME)
        page = await browser.new_page(viewport={'width': 1400, 'height': 950}, locale='zh-CN')
        errors = []
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        await open_workspace(page, read_url(url_file), workspace)
        # A fresh DSH session per probe, so defaults are observed, not earlier choices.
        await page.get_by_text('新会话', exact=True).first.click()
        await page.wait_for_timeout(2000)
        editor = page.locator('[contenteditable="true"]').first

        # 1. '/' menu has a Flow section listing hmz flows, beside 添加/指令.
        await editor.click()
        await page.keyboard.type('/')
        await page.wait_for_timeout(2500)
        menu = await page.get_by_role('listbox').inner_text()
        check('指令' in menu and 'Flow' in menu and 'rlar' in menu, 'slash menu shows Flow group with hmz flows next to 指令')
        await page.screenshot(path=f'{shots}/10-menu.png')

        # 2. Pick rlar -> composer token consumed, flow选项 button appears, panel opens.
        await page.get_by_role('option').filter(has_text='rlar').first.click()
        await page.wait_for_timeout(2000)
        draft = (await editor.inner_text()).strip()
        check(draft == '', f'slash token consumed after pick (draft={draft!r})')
        button = page.locator('[data-hmz-flow="options"]')
        check(await button.count() == 1 and 'rlar' in await button.inner_text(), 'composer shows "flow选项 · rlar" button')
        panel = page.locator('[data-hmz-flow="panel"]')
        await page.wait_for_timeout(2500)
        check(await panel.count() == 1, 'flow options panel is open above the composer')
        panel_text = await panel.inner_text() if await panel.count() else ''
        check('actor' in panel_text and 'reviewer' in panel_text, 'panel shows rlar roles from hmz declaration')
        switch = page.locator('[data-hmz-flow="history-switch"]')
        check(await switch.get_attribute('aria-checked') == 'true', 'include-history defaults to ON')
        await page.screenshot(path=f'{shots}/11-panel.png')

        # 3. Toggle include-history OFF; reload; selection and switch persist.
        await switch.click()
        await page.wait_for_timeout(1500)
        check(await switch.get_attribute('aria-checked') == 'false', 'include-history toggles OFF')
        await page.reload()
        await page.wait_for_timeout(5000)
        await page.keyboard.press('Escape')
        button = page.locator('[data-hmz-flow="options"]')
        check(await button.count() == 1 and 'rlar' in await button.inner_text(), 'flow selection persists across reload')
        await button.click()
        await page.wait_for_timeout(2500)
        check(await page.locator('[data-hmz-flow="history-switch"]').get_attribute('aria-checked') == 'false',
              'include-history OFF persists across reload')
        # Normal sending path untouched: the composer still has its own submit control.
        check(await page.locator('[data-hmz-flow="panel"]').count() == 1, 'panel reopens from the flow选项 button')

        # 4. Ordinary sending is untouched: the message goes to the DSH leader's
        # conversation (this preview has no model key, so the leader answers with an error).
        await page.locator('[data-hmz-flow="panel"]').get_by_role('button', name='关闭').click()
        editor = page.locator('[contenteditable="true"]').first
        await editor.click()
        await page.keyboard.type('hello leader, this is a normal message')
        await page.keyboard.press('Enter')
        await page.wait_for_timeout(6000)
        body = await page.locator('body').inner_text()
        check('hello leader, this is a normal message' in body, 'normal message is posted to the DSH conversation')
        await page.screenshot(path=f'{shots}/14-sent.png')

        # 4b. A progress question goes to the leader, who answers with the real read-only tool.
        await editor.click()
        await page.keyboard.type('hmz 这边现在进度怎么样？')
        await page.keyboard.press('Enter')
        for _ in range(60):
            await page.wait_for_timeout(1000)
            body = await page.locator('body').inner_text()
            if '已完成' in body.split('hmz 这边现在进度怎么样')[-1]:
                break
        await page.get_by_role('tab', name='轨迹').click()
        await page.wait_for_timeout(2500)
        trajectory = await page.locator('body').inner_text()
        check('hmz_flow_status' in trajectory, 'leader called hmz_flow_status for a progress question (trajectory)')
        check('hmz_start' not in trajectory and 'hmz exec' not in trajectory, 'no start attempted for a progress question')
        await page.screenshot(path=f'{shots}/15-trajectory.png')
        await page.get_by_role('tab', name='对话').click()
        await page.wait_for_timeout(1000)
        await page.screenshot(path=f'{shots}/16-progress-answer.png')

        # 5. Flow view: sibling tab of 对话/轨迹, iframe shows native hmz web through the proxy.
        tabs = await page.get_by_role('tab').all_inner_texts()
        check('Flow' in tabs and '对话' in tabs, f'Flow is a sibling view tab (tabs={tabs})')
        await page.get_by_role('tab', name='Flow').click()
        await page.wait_for_timeout(5000)
        frame_el = page.locator('[data-hmz-flow="frame"]')
        check(await frame_el.count() == 1, 'Flow view renders an iframe')
        frame = await (await frame_el.element_handle()).content_frame()
        await frame.wait_for_load_state()
        await page.wait_for_timeout(3000)
        frame_text = await frame.locator('body').inner_text()
        check('humanize' in (await frame.title()).lower() or 'New epic' in frame_text or 'epic' in frame_text.lower(),
              f'iframe shows native hmz UI (title={await frame.title()!r})')
        await page.screenshot(path=f'{shots}/12-flow-view.png')
        # Epic deep link inside the embedded hmz page (absolute /api paths go through the proxy).
        await frame.evaluate(f"() => {{ location.hash = '#/epics/{epic}' }}")
        await page.wait_for_timeout(5000)
        frame_text = await frame.locator('body').inner_text()
        check('hello from hmz demo' in frame_text, 'embedded hmz renders the demo epic transcript via deep link')
        await page.screenshot(path=f'{shots}/13-flow-epic.png')
        status = await frame.evaluate("""async () => (await fetch('/api/held/say', {method: 'POST',
            headers: {'content-type': 'application/json'}, body: JSON.stringify({workspace: 'x', text: 'x'})})).status""")
        check(status == 403, f'embedded hmz page cannot write through the proxy (status={status})')
        api = await frame.evaluate("async () => (await fetch('/api/workspaces')).status")
        check(api == 200, f'embedded hmz page reads its absolute /api paths through the proxy (status={api})')

        # 6. Leave flow mode from the menu.
        await page.get_by_role('tab', name='对话').click()
        await page.wait_for_timeout(1000)
        editor = page.locator('[contenteditable="true"]').first
        await editor.click()
        await page.keyboard.type('/flow')
        await page.wait_for_timeout(2000)
        await page.get_by_role('option').filter(has_text='取消 flow 模式').first.click()
        await page.wait_for_timeout(2000)
        check(await page.locator('[data-hmz-flow="options"]').count() == 0, 'leaving flow mode hides the flow选项 button')

        relevant = [e for e in errors if 'hmz' in e.lower() or 'slot entry crashed' in e]
        check(not relevant, f'no plugin console errors ({relevant[:3]})')
        await browser.close()


asyncio.run(main())
sys.exit(1 if failures else 0)
