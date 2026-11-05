"""Shared helpers to drive the real DSH preview page with Playwright."""
import pathlib

CHROME = '/root/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome'


async def open_workspace(pg, url, workspace):
    await pg.goto(url)
    await pg.wait_for_timeout(3500)
    await pg.keyboard.press('Escape')  # "开始使用" credentials prompt in a key-less preview
    await pg.wait_for_timeout(300)
    picker = pg.get_by_text('选择工作区', exact=True)
    if await picker.count() == 0:
        return  # the workspace chosen earlier is already current
    await picker.first.click(timeout=8000)
    await pg.wait_for_timeout(800)
    dialog = pg.get_by_role('dialog')
    # The pencil button beside the breadcrumb switches the path to an editable field.
    await dialog.get_by_role('button', name='编辑路径').click()
    await pg.wait_for_timeout(300)
    field = dialog.locator('input, textarea').first
    await field.fill(workspace)
    await field.press('Enter')
    await pg.wait_for_timeout(800)
    await dialog.get_by_role('button', name='打开').click()
    await pg.wait_for_timeout(2500)


def read_url(path):
    return pathlib.Path(path).read_text().strip()
