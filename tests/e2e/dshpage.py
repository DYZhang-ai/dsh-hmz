"""Shared helpers to drive a real DSH preview with Playwright."""
import json
import pathlib

CHROME = '/root/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome'


def read_url(path):
    return pathlib.Path(path).read_text().strip()


async def dismiss(page):
    await page.keyboard.press('Escape')  # first-run prompts
    await page.wait_for_timeout(300)


async def add_workspace(page, workspace):
    """Add (or re-select) `workspace` through the sidebar's 添加工作区 dialog.

    This always names the target directory; it never relies on whichever
    workspace DSH happens to have selected. Adding opens a new session there.
    """
    await page.get_by_role('button', name='添加工作区', exact=True).click()
    await page.wait_for_timeout(600)
    dialog = page.get_by_role('dialog')
    await dialog.get_by_role('button', name='编辑路径').click()
    field = dialog.locator('input, textarea').first
    await field.fill(workspace)
    await field.press('Enter')
    await page.wait_for_timeout(600)
    await dialog.get_by_role('button', name='打开', exact=True).click()
    await page.wait_for_timeout(2000)


class SessionTracker:
    """The DSH session the page is showing, as the plugin's own RPCs name it.

    DSH page URLs do not identify sessions; the plugin's Client posts the exact
    sessionId with every call, which is what this records.
    """

    def __init__(self, page):
        self.last = None
        page.on('request', self._seen)

    def _seen(self, request):
        if 'api/hmz-flow/rpc' not in request.url or request.method != 'POST':
            return
        try:
            body = json.loads(request.post_data or '{}')
        except ValueError:
            return
        if isinstance(body.get('sessionId'), str):
            self.last = body['sessionId']


def state(state_file):
    return json.loads(pathlib.Path(state_file).read_text())


def binding_of(state_file, session_id):
    entry = state(state_file)['sessions'].get(session_id) or {}
    return entry.get('binding')
