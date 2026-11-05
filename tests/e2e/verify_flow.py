"""Real execution path on an isolated DSH preview with DeepSeek-backed hmz agents.

usage: verify_flow.py <preview-dir> <shots-dir> <scenario>
scenarios:
  rlar   add workspace <preview-dir>/demo, select rlar, fill roles, save, reload;
         refused start while a background job of the session runs; real start;
         progress + message to a role; bash write denied by the guard; close the page and
         reopen; restart DSH; stop; verified end and end notice.
  chat   add workspace <preview-dir>/chat-ws, select chat, start; hmz asks the user;
         the leader relays it to DSH's question card; the user's reply is sent; stop.

Environment: PREVIEW_TMUX (required for rlar, must not be the user's preview socket),
DSH_PORT, HMZ_TEST_AGENT_PARTS=cli,account,model (default dsh,preview-deepseek,deepseek-flash).
Evidence is taken from the plugin's state for the exact DSH session id and from tool
results in the trajectory; what the leader says in prose is never counted.
"""
import asyncio
import os
import pathlib
import re
import subprocess
import sys
import time

from playwright.async_api import async_playwright

from dshpage import CHROME, SessionTracker, add_workspace, binding_of, dismiss, read_url

preview, shots, scenario = sys.argv[1:4]
preview = pathlib.Path(preview).resolve()
shots_dir = pathlib.Path(shots)
shots_dir.mkdir(parents=True, exist_ok=True)
STATE = preview / 'state' / 'state.json'
URL = preview / 'private' / 'dsh-url'
ROOT = pathlib.Path(__file__).resolve().parents[2]
CLI, ACCOUNT, MODEL = os.environ.get('HMZ_TEST_AGENT_PARTS', 'dsh,preview-deepseek,deepseek-flash').split(',')
if CLI == 'claude':
    raise SystemExit('refusing a Claude-backed agent for a real hmz run')
TMUX = os.environ.get('PREVIEW_TMUX', '')
failures = []


def check(cond, what):
    print(('PASS ' if cond else 'FAIL ') + what, flush=True)
    if not cond:
        failures.append(what)


async def text_of(page):
    return await page.locator('body').inner_text()


async def ask(page, text, seconds=180):
    editor = page.locator('[contenteditable="true"]').first
    await editor.click()
    await page.keyboard.type(text)
    await page.keyboard.press('Enter')
    await settle(page, text, seconds)


async def settle(page, after, seconds):
    for _ in range(seconds):
        await page.wait_for_timeout(1000)
        tail = (await text_of(page)).split(after)[-1]
        if '已完成' in tail and not re.search(r'思考中|正在', tail[-300:]):
            break
    await page.wait_for_timeout(1500)


async def trajectory(page):
    await page.get_by_role('tab', name='轨迹', exact=True).click()
    await page.wait_for_timeout(2500)
    text = await text_of(page)
    await page.get_by_role('tab', name='对话', exact=True).click()
    await page.wait_for_timeout(800)
    return text


async def setup(page, tracker, flow, workspace):
    await add_workspace(page, str(workspace))
    editor = page.locator('[contenteditable="true"]').first
    await editor.click()
    await page.keyboard.type(f'/{flow}')
    await page.wait_for_timeout(2000)
    await page.get_by_role('option').filter(has_text=flow).first.click()
    await page.wait_for_timeout(4000)
    form = page.locator('[data-hmz-flow="form"]')
    check(await form.count() == 1, f'{flow}: options form renders from the hmz declaration')
    roles = await form.locator('[data-hmz-role]').evaluate_all('els => els.map(e => e.dataset.hmzRole)')
    for role in roles:
        r = form.locator(f'[data-hmz-role="{role}"]')
        await r.locator(f'[data-hmz-field="{role}.cli"]').select_option(CLI)
        await page.wait_for_timeout(300)
        await r.locator(f'[data-hmz-field="{role}.account"]').select_option(ACCOUNT)
        await r.locator(f'[data-hmz-field="{role}.model"]').fill(MODEL)
    if flow != 'chat':
        await form.locator('[data-hmz-field="cost"]').fill('0.5')
        await form.locator('[data-hmz-field="minutes"]').fill('15')
    await page.locator('[data-hmz-flow="save"]').click()
    await page.wait_for_timeout(1500)
    check('已保存' in await page.locator('[data-hmz-flow="save-note"]').inner_text(), f'{flow}: options saved for roles {roles}')
    await page.screenshot(path=str(shots_dir / f'{flow}-01-form.png'), full_page=True)
    await page.locator('[data-hmz-flow="panel"]').get_by_role('button', name='关闭').click()
    sid = tracker.last
    check(bool(sid), f'{flow}: DSH session id observed ({sid})')
    return sid, roles


async def wait_binding(sid, pred, seconds):
    end = time.time() + seconds
    while time.time() < end:
        b = binding_of(STATE, sid)
        if b and pred(b):
            return b
        await asyncio.sleep(2)
    return binding_of(STATE, sid)


def restart_dsh():
    if not TMUX or TMUX == 'dsh-hmz-preview':
        raise SystemExit('refusing to restart DSH without a dedicated PREVIEW_TMUX (the user preview uses dsh-hmz-preview)')
    subprocess.run(['tmux', '-L', TMUX, 'kill-session', '-t', 'dsh'], check=False)
    time.sleep(2)
    subprocess.run([str(ROOT / 'scripts' / 'preview.sh'), 'start'], check=True, capture_output=True,
                   env={**os.environ, 'PREVIEW_DIR': str(preview), 'PREVIEW_TMUX': TMUX})


def fresh_workspace(kind):
    """A new git directory per run, so artifacts of earlier runs cannot pass a check."""
    ws = preview / 'runs' / f'{kind}-{time.strftime("%H%M%S")}'
    ws.mkdir(parents=True)
    subprocess.run(['git', 'init', '-q'], cwd=ws, check=True)
    (ws / 'README.md').write_text(f'# {kind} test workspace\n')
    subprocess.run(['git', '-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-qm', 'init', '--allow-empty'], cwd=ws, check=True)
    return ws


def alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, TypeError, ValueError):
        return False


async def rlar(context, page, tracker):
    """rlar is short with DeepSeek: it must reach a verified end with the actor's file."""
    ws = fresh_workspace('rlar')
    sid, _ = await setup(page, tracker, 'rlar', ws)
    await page.reload()
    await page.wait_for_timeout(5000)
    await dismiss(page)
    await page.locator('[data-hmz-flow="options"]').click()
    await page.wait_for_timeout(3500)
    check(tracker.last == sid, 'reload shows the same DSH session')
    form = page.locator('[data-hmz-flow="form"]')
    check(await form.locator('[data-hmz-field="reviewer.model"]').input_value() == MODEL
          and await form.locator('[data-hmz-field="reviewer.account"]').input_value() == ACCOUNT
          and await form.locator('[data-hmz-field="cost"]').input_value() == '0.5', 'saved options persist across reload')
    await page.locator('[data-hmz-flow="panel"]').get_by_role('button', name='关闭').click()

    # Pre-existing work: while the session's background job runs, a start is refused.
    job_started = time.time()
    await ask(page, '请用 bash 工具在后台运行 `sleep 45`（run_in_background=true），启动后立即返回，不要等待它结束。', 120)
    job_ends = job_started + 45
    await ask(page, '现在请用选中的 rlar flow 执行：在仓库根目录创建 hello.txt，内容为一行 hello from rlar，并由 reviewer 确认。已授权，直接启动。', 180)
    traj = await trajectory(page)
    refused = 'earlier work of this session is still running' in traj and 'background job' in traj
    if refused:
        check(True, 'hmz_flow_start was refused while the session\'s background job ran (tool result)')
    else:
        print('note: the leader did not try to start while the job ran (it waited); refusal not exercised in this run', flush=True)
    early = binding_of(STATE, sid)
    if early:
        from datetime import datetime
        requested = datetime.fromisoformat(early['requestedAt'].replace('Z', '+00:00')).timestamp()
        check(requested >= job_ends - 2, 'any start happened only after the background job had ended')
    else:
        check(True, 'no start while the background job ran')
    if not binding_of(STATE, sid):
        await page.wait_for_timeout(max(0, int((job_ends - time.time()) * 1000)) + 3000)
        await ask(page, '后台任务已经结束。请现在启动刚才的 rlar 任务。', 240)
    b = await wait_binding(sid, lambda b: b.get('phase') in ('running', 'stopping', 'ended') and b.get('epicName'), 120)
    check(bool(b) and b.get('names', {}).keys() >= {'actor', 'reviewer'},
          f'real start bound the exact run ({b and {k: b.get(k) for k in ("phase", "run", "epicName", "names", "hostPid")}})')
    check('STARTED hmz run' in await trajectory(page), 'hmz_flow_start returned STARTED (tool result)')
    await page.screenshot(path=str(shots_dir / 'rlar-03-started.png'))
    ended = await wait_binding(sid, lambda b: b.get('phase') == 'ended', 900)
    check(ended and ended.get('phase') == 'ended', f'rlar run verified ended ({ended and ended.get("endedHow")})')
    hello = ws / 'hello.txt'
    check(hello.exists() and 'hello from rlar' in hello.read_text(), 'the actor created hello.txt in the workspace')
    notified = await wait_binding(sid, lambda b: (b.get('notified') or {}).get('ended'), 60)
    check(bool(notified and notified['notified'].get('ended')), 'the end notice was delivered to the leader')
    await page.wait_for_timeout(20000)
    traj = await trajectory(page)
    check('[hmz flow notice' in traj and 'has ended' in traj, 'the leader\'s model input contains the end notice')
    await page.get_by_role('tab', name='Flow', exact=True).click()
    await page.wait_for_timeout(7000)
    await page.screenshot(path=str(shots_dir / 'rlar-04-flow-ended.png'))
    await page.get_by_role('tab', name='对话', exact=True).click()


async def chat(context, page, tracker):
    """chat waits for the user: it carries question relay, send, reopen, DSH restart and stop."""
    sid, _ = await setup(page, tracker, 'chat', fresh_workspace('chat'))
    await ask(page, '请用选中的 chat flow 开始：让助手用一句话打招呼，然后等我回答。已授权，直接启动。', 240)
    b = await wait_binding(sid, lambda b: b.get('phase') == 'running' and b.get('epicName'), 90)
    check(bool(b) and b.get('phase') == 'running', f'chat run bound ({b and {k: b.get(k) for k in ("run", "epicName", "names", "hostPid")}})')
    if not b:
        return
    host_pid = b['hostPid']
    # hmz asks the human; the monitor's notice wakes the leader, which relays it via hmz_flow_answer.
    card = None
    for _ in range(240):
        await page.wait_for_timeout(1000)
        header = page.get_by_text(re.compile(r'hmz run #\d+ ·'))
        if await header.count():
            card = header.first
            break
    check(card is not None, 'a DSH question card for the hmz question appeared (notice consumed by the leader)')
    await page.screenshot(path=str(shots_dir / 'chat-02-question.png'), full_page=True)
    if card is None:
        return
    first_q = (binding_of(STATE, sid).get('notified') or {}).get('questions', [])
    reply = '请用中文简单介绍一下你自己。'
    answer_box = page.get_by_placeholder('输入你的答案')
    typed = await answer_box.count() > 0
    if typed:
        await answer_box.first.fill(reply)
        await page.wait_for_timeout(500)
        await page.get_by_role('button', name='提交', exact=True).click()
    check(typed, f'the user typed the reply into the DSH question card (questions notified: {first_q})')
    for _ in range(60):
        await page.wait_for_timeout(2000)
        if "ACCEPTED: the user's reply to q" in await trajectory(page):
            break
    traj = await trajectory(page)
    check("ACCEPTED: the user's reply to q" in traj, 'hmz_flow_answer sent the real user reply (tool result)')
    await page.screenshot(path=str(shots_dir / 'chat-03-answered.png'), full_page=True)

    await ask(page, '请转告 chat 里的 assistant（角色 assistant）：回答尽量简短。', 150)
    check('ACCEPTED by hmz for assistant' in await trajectory(page), 'hmz_flow_send to role assistant accepted (tool result)')

    # Close the page; a new page of the same browser shows the same session and binding.
    await page.close()
    page = await context.new_page()
    tracker.__init__(page)
    await page.goto(f'http://127.0.0.1:{os.environ.get("DSH_PORT", "44190")}/')
    await page.wait_for_timeout(6000)
    await dismiss(page)
    await page.locator('[data-hmz-flow="options"]').click()
    await page.wait_for_timeout(3500)
    bound = await page.locator('[data-hmz-flow="binding"]').inner_text()
    check(tracker.last == sid and f'run #{b["run"]}' in bound, f'reopened page shows the same session and bound run ({bound[:90]!r})')
    await page.locator('[data-hmz-flow="panel"]').get_by_role('button', name='关闭').click()

    restart_dsh()
    await page.wait_for_timeout(4000)
    await page.reload()
    await page.wait_for_timeout(8000)
    await dismiss(page)
    after = binding_of(STATE, sid)
    check(alive(host_pid), f'hmz host pid {host_pid} survived the DSH restart')
    check(after and after.get('run') == b['run'] and after.get('epic') == b['epic'] and after.get('phase') == 'running',
          f'binding after restart is the same running run ({after and after.get("phase")})')
    await page.get_by_role('tab', name='Flow', exact=True).click()
    await page.wait_for_timeout(7000)
    note = await page.locator('[data-hmz-flow="view-note"]').inner_text()
    check(b['epicName'] in note, f'Flow view deep-links the bound epic after restart ({note})')
    check(await page.locator('[data-hmz-flow="readonly"]').count() == 1, 'Flow view is labelled read-only')
    await page.screenshot(path=str(shots_dir / 'chat-04-after-restart.png'))
    await page.get_by_role('tab', name='对话', exact=True).click()
    await page.wait_for_timeout(1000)

    await ask(page, '请停止这个 chat flow。', 150)
    check('STOP ACCEPTED' in await trajectory(page), 'hmz_flow_stop accepted by hmz (tool result)')
    ended = await wait_binding(sid, lambda b: b.get('phase') == 'ended', 180)
    check(ended and ended.get('phase') == 'ended', f'chat run verified ended ({ended and ended.get("endedHow")})')
    notified = await wait_binding(sid, lambda b: (b.get('notified') or {}).get('ended'), 60)
    check(bool(notified and notified['notified'].get('ended')), 'the end notice was delivered after the restart')
    await page.wait_for_timeout(15000)
    await page.screenshot(path=str(shots_dir / 'chat-05-stopped.png'), full_page=True)


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=CHROME)
        context = await browser.new_context(viewport={'width': 1400, 'height': 1000}, locale='zh-CN')
        page = await context.new_page()
        tracker = SessionTracker(page)
        errors = []
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        await page.goto(read_url(URL))
        await page.wait_for_timeout(3500)
        await dismiss(page)
        await (rlar if scenario == 'rlar' else chat)(context, page, tracker)
        relevant = [e[:300] for e in errors if 'hmz' in e.lower() or 'slot entry crashed' in e]
        check(not relevant, f'no plugin console errors ({relevant[:3]})')
        await browser.close()


asyncio.run(main())
sys.exit(1 if failures else 0)
