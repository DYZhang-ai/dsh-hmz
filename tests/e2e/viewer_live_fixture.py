"""hmz's own epic view in the Flow viewer keeps a running session's thread live.

usage: viewer_live_fixture.py <dsh-port> <detail.json> <trace.json>
The detail/trace files are hmz web's own shapes for one real epic (from the
adapter's web_detail / web_trace). A parent page under the DSH origin plays the
DSH bridge: the detail stays fixed (the epic metadata does not change while a
session writes its logs) and the trace gains a message after a few seconds.
Checks, on hmz's real modules served by the plugin route:
  1. the new message appears in the open session thread without remounting;
  2. the thread's scroll position is kept when the reader is not at the end;
  3. graph zoom is kept across trace refreshes;
  4. once the session's flow is no longer active: one more read, then none;
  5. no hidden-control leaks: no message box, Resume, Export, Upload, Exomyth.
No model, no hmz host.
"""
import asyncio
import copy
import json
import sys
from urllib.parse import quote, unquote

from playwright.async_api import async_playwright

from dshpage import CHROME

port, detail_file, trace_file = sys.argv[1:4]
ORIGIN = f'http://127.0.0.1:{port}'
detail = json.load(open(detail_file))
full = json.load(open(trace_file))
detail.update({'ended': '', 'how': 'running', 'held': False})
target = full['sessions'][-1]
messages = [i for i, a in enumerate(target['actions']) if a['category'] == 'message']
cut_at = messages[-1]
stage1 = copy.deepcopy(full)
stage1['sessions'][-1]['actions'] = target['actions'][:cut_at]
stage2 = copy.deepcopy(full)
stage2['sessions'][-1]['actions'][cut_at]['args']['text'] = 'SECOND-MARKER ' + stage2['sessions'][-1]['actions'][cut_at]['args']['text']
agent = next(s['agent'] for s in detail['sessions'] if f"{s['backend']}:{s['ident']}" == target['key'])
n = [s for s in detail['sessions'] if s['agent'] == agent].index(next(s for s in detail['sessions'] if f"{s['backend']}:{s['ident']}" == target['key'])) + 1
# The session key `<agent>/<n>` is one path segment of the address.
THREAD = f"#/epics/{detail['name']}/sessions/{quote(agent + '/' + str(n), safe='')}"
failures = []


def check(cond, what):
    print(('PASS ' if cond else 'FAIL ') + what, flush=True)
    if not cond:
        failures.append(what)


PARENT = """<!doctype html><html><body style="margin:0">
<iframe id="v" sandbox="allow-scripts" style="width:1400px;height:900px;border:0" src="/hmzf-viewer/index.html%s"></iframe>
<script>
window.state = { stage: 1, active: true, traceReads: 0, detailReads: 0, other: [] }
window.addEventListener('message', (e) => {
  const v = document.getElementById('v')
  if (e.source !== v.contentWindow || !e.data || e.data.hmzf !== 'fetch') return
  const path = new URL(e.data.path, 'http://x').pathname
  let reply
  if (path === '/api/runs/%s') { state.detailReads++; reply = { status: 200, body: { ...window.DETAIL, _dshFlow: { active: state.active } } } }
  else if (path === '/api/runs/%s/trace') { state.traceReads++; reply = { status: 200, body: state.stage === 1 ? window.T1 : window.T2 } }
  else { state.other.push(path); reply = { status: 404, body: { error: 'out of scope' } } }
  v.contentWindow.postMessage({ hmzf: 'reply', id: e.data.id, ...reply }, '*')
})
</script></body></html>"""


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=CHROME)
        page = await browser.new_page(viewport={'width': 1450, 'height': 950})
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)

        async def parent(route):
            hash_ = unquote(route.request.url.split('?h=', 1)[1]) if '?h=' in route.request.url else ''
            await route.fulfill(content_type='text/html', body=PARENT % (hash_, detail['name'], detail['name']))

        await page.route(f'{ORIGIN}/fixture-parent.html*', parent)
        await page.add_init_script(f'window.DETAIL = {json.dumps(detail)}; window.T1 = {json.dumps(stage1)}; window.T2 = {json.dumps(stage2)};')

        # 1-2: the open thread of a running session.
        await page.goto(f'{ORIGIN}/fixture-parent.html?h={quote(THREAD, safe="")}')
        frame = page.frame_locator('#v')
        await frame.locator('[data-hmz="thread"]').wait_for(timeout=20000)
        await page.wait_for_timeout(3000)
        text1 = await frame.locator('[data-hmz="thread"]').inner_text()
        check('SECOND-MARKER' not in text1 and len(text1) > 20, 'the open thread shows the session as first read')
        scroller = frame.locator('.thread-scroll')
        await scroller.evaluate('el => { el.scrollTop = 0 }')
        await page.evaluate('state.stage = 2')
        for _ in range(12):
            await page.wait_for_timeout(1000)
            if 'SECOND-MARKER' in await frame.locator('[data-hmz="thread"]').inner_text():
                break
        check('SECOND-MARKER' in await frame.locator('[data-hmz="thread"]').inner_text(), 'the new message appears in hmz\'s own thread without a reload (fixed detail)')
        check(await scroller.evaluate('el => el.scrollTop') == 0, 'the reader\'s scroll position is kept')
        reads = await page.evaluate('state.traceReads')
        check(reads >= 2, f'the trace is read again while the flow is active ({reads} reads)')
        await page.screenshot(path='/tmp/hmzf-viewer-thread.png')

        # 4: no longer active -> one more read, then none.
        await page.evaluate('state.active = false')
        await page.wait_for_timeout(9000)
        after_final = await page.evaluate('state.traceReads')
        await page.wait_for_timeout(9000)
        check(await page.evaluate('state.traceReads') == after_final, f'after the flow stopped being active: no more trace reads ({after_final})')

        # 3: graph zoom survives trace refreshes.
        await page.evaluate('state.active = true; state.stage = 1')
        await page.goto(f'{ORIGIN}/fixture-parent.html?h={quote("#/epics/" + detail["name"], safe="")}')
        await frame.locator('.view-epic').wait_for(timeout=20000)
        await page.wait_for_timeout(2500)
        read_turns = frame.get_by_role('button', name='Read turns')
        if await read_turns.count():
            await read_turns.click()
            await page.wait_for_timeout(2500)
        zoom_in = frame.get_by_role('button', name='Zoom in')
        zoom_label = frame.locator('text=/^\\d+%$/').first
        before = await zoom_label.inner_text() if await zoom_label.count() else ''
        if await zoom_in.count():
            await zoom_in.click()
            await zoom_in.click()
        zoomed = await zoom_label.inner_text() if await zoom_label.count() else ''
        await page.evaluate('state.stage = 2')
        await page.wait_for_timeout(9000)
        later = await zoom_label.inner_text() if await zoom_label.count() else ''
        check(bool(zoomed) and zoomed != before and later == zoomed, f'graph zoom kept across trace refreshes ({before} -> {zoomed} -> {later})')
        await page.screenshot(path='/tmp/hmzf-viewer-graph.png')

        # 5: controls that act outside the run are not shown.
        body = frame.locator('body')
        for label, sel in [('message box', '[data-hmz="dock"]'), ('Resume', 'a[href*="resume="]'), ('Export', 'a[download]'),
                           ('Upload', '[data-hmz="upload"]'), ('Exomyth', '[data-hmz="exomyth-open"]'), ('sidebar toggle', '.bar-side'),
                           ('Copy link', '.bar-actions > button.btn.quiet.small')]:
            loc = frame.locator(sel)
            visible = any([await loc.nth(i).is_visible() for i in range(await loc.count())])
            check(not visible, f'{label} is not shown')
        check(await frame.locator('[data-hmz="sidebar"], .sidebar').count() == 0, 'no global sidebar in the viewer')
        kept = frame.locator('.bar-actions > *')
        shown = [await kept.nth(i).is_visible() for i in range(await kept.count())]
        check(any(shown), 'the EPIC/ASIDE panel toggle is still shown in the header')
        other = await page.evaluate('state.other')
        check(all(o.startswith('/api/btw') for o in other), f'the viewer asked for nothing outside the run ({other[:4]})')
        check(not [e for e in errors if 'Content Security Policy' in e or 'Refused' in e], f'no CSP/load errors ({errors[:2]})')
        del body
        await browser.close()


asyncio.run(main())
sys.exit(1 if failures else 0)
