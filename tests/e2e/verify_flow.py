"""Real execution path on the DSH preview: options form, leader start, status,
send-to-role, guard, DSH restart survival, stop, verified end.

usage: verify_flow.py <dsh-url-file> <shots-dir> <workspace> <phase>
phases: form | start | steer | guard | stop
State between phases (the DSH session URL) is kept in <shots-dir>/session.txt.
Prints PASS/FAIL; exits non-zero on failures.
"""
import asyncio
import pathlib
import sys

from playwright.async_api import async_playwright

from dshpage import CHROME, open_workspace, read_url

url_file, shots, workspace, phase = sys.argv[1:5]
shots_dir = pathlib.Path(shots)
session_file = shots_dir / 'session.txt'
failures = []


def check(cond, what):
    print(('PASS ' if cond else 'FAIL ') + what, flush=True)
    if not cond:
        failures.append(what)


async def ask_leader(page, text, settle_seconds=150, done_marker='已完成'):
    editor = page.locator('[contenteditable="true"]').first
    await editor.click()
    await page.keyboard.type(text)
    await page.keyboard.press('Enter')
    for _ in range(settle_seconds):
        await page.wait_for_timeout(1000)
        body = await page.locator('main, body').first.inner_text()
        tail = body.split(text)[-1]
        if done_marker in tail and '思考中' not in tail[-200:]:
            break
    await page.wait_for_timeout(1500)


async def trajectory(page):
    await page.get_by_role('tab', name='轨迹').click()
    await page.wait_for_timeout(2500)
    text = await page.locator('body').inner_text()
    await page.get_by_role('tab', name='对话').click()
    await page.wait_for_timeout(800)
    return text


async def open_session(page):
    base = read_url(url_file)
    if session_file.exists():
        await page.goto(base)
        await page.wait_for_timeout(2500)
        await page.goto(session_file.read_text().strip())
        await page.wait_for_timeout(4000)
        await page.keyboard.press('Escape')
    else:
        await open_workspace(page, base, workspace)
        await page.get_by_text('新会话', exact=True).first.click()
        await page.wait_for_timeout(2000)


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=CHROME)
        page = await browser.new_page(viewport={'width': 1400, 'height': 1000}, locale='zh-CN')
        errors = []
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        await open_session(page)
        editor = page.locator('[contenteditable="true"]').first

        if phase == 'form':
            await editor.click()
            await page.keyboard.type('/rlar')
            await page.wait_for_timeout(2000)
            await page.get_by_role('option').filter(has_text='rlar').first.click()
            await page.wait_for_timeout(4000)
            form = page.locator('[data-hmz-flow="form"]')
            check(await form.count() == 1, 'options form renders from hmz declaration')
            for role in ('actor', 'reviewer'):
                r = form.locator(f'[data-hmz-role="{role}"]')
                await r.locator(f'[data-hmz-field="{role}.cli"]').select_option('claude')
                await page.wait_for_timeout(300)
                model = r.locator(f'[data-hmz-field="{role}.model"]')
                if await model.evaluate('e => e.tagName') == 'SELECT':
                    await model.select_option('claude-haiku-4-5')
                else:
                    await model.fill('claude-haiku-4-5')
            await form.locator('[data-hmz-field="cost"]').fill('0.5')
            await form.locator('[data-hmz-field="minutes"]').fill('15')
            await page.locator('[data-hmz-flow="save"]').click()
            await page.wait_for_timeout(1500)
            check('已保存' in await page.locator('[data-hmz-flow="save-note"]').inner_text(), 'options saved')
            await page.screenshot(path=f'{shots}/20-form.png', full_page=True)
            # The first message makes the tabs appear and pins the session URL for later phases.
            await page.locator('[data-hmz-flow="panel"]').get_by_role('button', name='关闭').click()
            await ask_leader(page, '你好，先别做任何事，只确认你看到了我选的 flow 是哪个。', 90)
            session_file.write_text(page.url)
            await page.reload()
            await page.wait_for_timeout(5000)
            await page.locator('[data-hmz-flow="options"]').click()
            await page.wait_for_timeout(4000)
            form = page.locator('[data-hmz-flow="form"]')
            model_value = await form.locator('[data-hmz-field="reviewer.model"]').input_value()
            check(model_value == 'claude-haiku-4-5', f'reviewer model persisted ({model_value})')
            check(await form.locator('[data-hmz-field="cost"]').input_value() == '0.5', 'budget persisted')
            await page.locator('[data-hmz-flow="panel"]').get_by_role('button', name='关闭').click()

        elif phase == 'start':
            await ask_leader(page, '请用选中的 flow 执行这个任务：在仓库根目录创建 hello.txt，内容为一行 hello from rlar，然后由 reviewer 确认。', 240)
            traj = await trajectory(page)
            check('hmz_flow_start' in traj, 'leader called hmz_flow_start for a clear execution request')
            check('STARTED hmz run' in traj, 'start reported STARTED with a run number')
            await page.screenshot(path=f'{shots}/21-started.png')
            await page.locator('[data-hmz-flow="options"]').click()
            await page.wait_for_timeout(3000)
            bound = page.locator('[data-hmz-flow="binding"]')
            text = await bound.inner_text() if await bound.count() else ''
            check('running' in text or 'ended' in text, f'panel shows the bound run ({text[:120]!r})')
            await page.screenshot(path=f'{shots}/22-bound-panel.png')
            await page.locator('[data-hmz-flow="panel"]').get_by_role('button', name='关闭').click()
            await page.get_by_role('tab', name='Flow').click()
            await page.wait_for_timeout(6000)
            note = await page.locator('[data-hmz-flow="view-note"]').inner_text()
            check('本会话绑定的 run' in note, f'Flow view deep-links the bound run ({note})')
            check(await page.locator('[data-hmz-flow="readonly"]').count() == 1, 'Flow view is labelled read-only')
            await page.screenshot(path=f'{shots}/23-flow-bound.png')
            await page.get_by_role('tab', name='对话').click()

        elif phase == 'steer':
            await ask_leader(page, '现在进度如何？', 120)
            await ask_leader(page, '请转告 reviewer：检查时请确认 hello.txt 末尾有换行。', 120)
            traj = await trajectory(page)
            check(traj.count('hmz_flow_start') <= 1, 'no extra start for a progress question or a steer')
            check('hmz_flow_status' in traj, 'progress question used hmz_flow_status')
            check('hmz_flow_send' in traj, 'steer used hmz_flow_send')
            await page.screenshot(path=f'{shots}/24-steer.png')

        elif phase == 'guard':
            await ask_leader(page, '测试一下：请你自己直接用 bash 执行 `echo leader-write > leader.txt`，不要通过 flow。如果被拦截，请原样告诉我拦截信息。', 120)
            traj = await trajectory(page)
            blocked = 'blocked while an hmz flow owns this directory' in traj or 'unavailable while an hmz flow' in traj
            check(not pathlib.Path(workspace, 'leader.txt').exists(), 'leader.txt was not created while the flow runs')
            print('guard message seen in trajectory:', blocked)
            await page.screenshot(path=f'{shots}/25-guard.png')

        elif phase == 'stop':
            await ask_leader(page, '请停止这个 flow。', 120)
            traj = await trajectory(page)
            check('hmz_flow_stop' in traj, 'stop request used hmz_flow_stop')
            await page.screenshot(path=f'{shots}/26-stop.png')

        relevant = [e for e in errors if 'hmz' in e.lower() or 'slot entry crashed' in e]
        check(not relevant, f'no plugin console errors ({relevant[:3]})')
        await browser.close()


asyncio.run(main())
sys.exit(1 if failures else 0)
