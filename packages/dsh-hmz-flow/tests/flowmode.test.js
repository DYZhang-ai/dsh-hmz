import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import { apply } from '../index.js'
import { AdapterClient } from '../lib/adapter-client.js'
import { StateStore } from '../lib/state.js'
import { patchEpicView, MARK } from '../lib/viewer-patches.js'
import { viewerHandler, VIEWER_PATH } from '../lib/viewer-route.js'

const SID = 'session-auto'

async function harness({ start, selection = { flow: 'chat' }, legacy = false, onFlow } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hmzflow-sec-'))
  const store = new StateStore(dir)
  if (selection.flow) {
    store.setSelection(SID, selection)
    store.setOptions(SID, 'chat', { agents: { assistant: 'dsh@acct/deepseek-flash' } })
  }
  if (legacy) {
    // Records left by the earlier automatic-start version: unused now.
    store.update(SID, (entry) => {
      entry.autoStarted = ['old-message-1', 'old-message-2']
      entry.lastAutoStart = { at: '2026-11-05T00:00:00Z', ok: false, outcome: 'not started', error: 'workspace is busy' }
    })
  }
  const calls = []
  const original = AdapterClient.prototype.request
  let n = 0
  AdapterClient.prototype.request = async function (op, args) {
    calls.push({ op, args })
    if (op === 'flow') { onFlow?.(); return { name: 'chat', agents: [{ name: 'assistant', required: true, auto: false }], envs: [] } }
    if (op === 'start') {
      if (start) return start(args)
      n += 1
      return { binding: { hostPid: 1, hostStarted: 'T', run: n, epic: `E${n}`, epicName: `E${n}`, flow: 'chat', names: { assistant: 'A' } } }
    }
    if (op === 'say') return { accepted: true, to: 'A', role: 'assistant', run: args.expect.run, targetWorking: false }
    if (op === 'stop') return { accepted: true }
    return {}
  }
  const agent = { id: SID, status: 'running', session: { snapshotEvents: () => [] }, ctx: { tools: { presentAs: () => () => {} } }, followup() {} }
  const events = new Map()
  const tools = new Map()
  let guard
  let route
  const disposers = []
  const ctx = {
    logger: () => ({ warn() {}, info() {} }),
    agents: { get: (id) => (id === SID ? agent : undefined), roots: () => [agent], list: () => [agent], isOwnedBy: () => false },
    workingDirectory: { get: () => dir },
    tools: { register: (def) => { tools.set(def.name, def); return () => {} }, guard: (fn) => { guard = fn; return () => {} } },
    connection: { fetch: { register: (r) => { route = r; return () => {} } } },
    webServer: { port: 1, register: () => () => {} },
    effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); return d },
    on(name, fn) { events.set(name, fn); return () => {} },
    get: () => undefined,
  }
  apply(ctx, { python: 'python3', stateDir: dir, monitorMs: 600000 })
  let token = 0
  const call = (name, args = {}, signal = new AbortController().signal) => tools.get(name).execute(args, { agent, token: { t: ++token }, rootCallId: `r${token}`, signal })
  const rpc = async (body) => {
    const r = await route.fetch(new Request('http://x/api/hmz-flow/rpc', { method: 'POST', body: JSON.stringify(body) }))
    return { status: r.status, body: await r.json() }
  }
  const state = () => JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).sessions[SID]
  const done = async () => { for (const d of disposers.reverse()) await d(); AdapterClient.prototype.request = original }
  return { events, calls, call, guard: (exec) => guard({ agent, ...exec }), rpc, state, done }
}

test('selecting a flow starts nothing by itself: no pre-step hook, user messages go to the secretary', async () => {
  const h = await harness()
  try {
    assert.equal(h.events.has('agent/pre-step'), false, 'no automatic start hook is registered')
    assert.equal(h.calls.filter((c) => c.op === 'start').length, 0)
    assert.equal(h.guard({ name: 'bash' }), undefined, 'selecting a flow alone does not block the secretary')
    assert.equal(h.guard({ name: 'write' }), undefined)
    assert.equal(h.guard({ name: 'hmz_flow_start' }), undefined)
  } finally { await h.done() }
})

test('the secretary\'s explicit start goes through the fenced SDK start; while active, writes are blocked', async () => {
  const h = await harness()
  try {
    const out = await h.call('hmz_flow_start', { task: 'create hello.txt' })
    assert.match(out, /^STARTED hmz run #1/)
    const starts = h.calls.filter((c) => c.op === 'start')
    assert.equal(starts.length, 1)
    assert.match(starts[0].args.task, /^create hello\.txt/)
    assert.ok(h.guard({ name: 'bash' }), 'bash blocked while the run is active')
    assert.ok(h.guard({ name: 'run_code' }))
    assert.ok(h.guard({ name: 'hmz_flow_start' }), 'no second start while one is active')
    assert.equal(h.guard({ name: 'read' }), undefined)
    assert.equal(h.guard({ name: 'hmz_flow_send' }), undefined)
    assert.match(await h.call('hmz_flow_start', { task: 'again' }), /^REFUSED: .*already has hmz run #1/)
    assert.equal(h.calls.filter((c) => c.op === 'start').length, 1)
  } finally { await h.done() }
})

test('a start whose tool call is cancelled before sending starts nothing', async () => {
  const abort = new AbortController()
  const h = await harness({ onFlow: () => abort.abort(new Error('the user cancelled the reply')) })
  try {
    const out = await h.call('hmz_flow_start', { task: 'task' }, abort.signal)
    assert.match(out, /^REFUSED: .*cancelled/)
    assert.deepEqual(h.calls.map((c) => c.op), ['flow'], 'the flow was read, no start was sent')
    assert.equal(h.guard({ name: 'bash' }), undefined, 'nothing to protect')
    const already = new AbortController()
    already.abort()
    assert.match(await h.call('hmz_flow_start', { task: 'task' }, already.signal), /^REFUSED: .*cancelled/)
    assert.deepEqual(h.calls.map((c) => c.op), ['flow'])
  } finally { await h.done() }
})

test('a message the secretary forwards goes to the exact current run', async () => {
  const h = await harness()
  try {
    await h.call('hmz_flow_start', { task: 'task' })
    const out = await h.call('hmz_flow_send', { role: 'assistant', text: 'also add a README' })
    assert.match(out, /^ACCEPTED by hmz/)
    const say = h.calls.find((c) => c.op === 'say')
    assert.deepEqual(say.args.expect, { hostPid: 1, hostStarted: 'T', run: 1, epic: 'E1' })
    assert.match(await h.call('hmz_flow_send', { text: 'no target' }), /^REFUSED: .*exactly one/)
  } finally { await h.done() }
})

test('a refused start leaves no protection and no run; the secretary can say why', async () => {
  const h = await harness({ start: () => { const e = new Error('workspace is busy'); e.outcome = 'refused'; throw e } })
  try {
    const out = await h.call('hmz_flow_start', { task: 'task' })
    assert.match(out, /^REFUSED: .*workspace is busy/)
    assert.equal(h.guard({ name: 'bash' }), undefined, 'no run, no protection')
    assert.deepEqual((await h.rpc({ op: 'runs', sessionId: SID })).body.result.runs, [])
  } finally { await h.done() }
})

test('records of the old automatic start affect neither a manual start nor the Flow page', async () => {
  const h = await harness({ legacy: true })
  try {
    const before = (await h.rpc({ op: 'runs', sessionId: SID })).body.result
    assert.equal('lastAutoStart' in before, false, 'no old auto-start error is shown')
    assert.match(await h.call('hmz_flow_start', { task: 'task' }), /^STARTED/)
    const after = (await h.rpc({ op: 'runs', sessionId: SID })).body.result
    assert.equal(after.runs.length, 1)
    assert.equal('lastAutoStart' in after, false)
    assert.deepEqual(h.state().autoStarted, ['old-message-1', 'old-message-2'], 'old records are left as they were')
  } finally { await h.done() }
})

test('Stop names the exact run it was shown for; a stale identity stops nothing', async () => {
  const h = await harness()
  try {
    await h.call('hmz_flow_start', { task: 'task' })
    const run = (await h.rpc({ op: 'runs', sessionId: SID })).body.result.runs[0]
    const stale = await h.rpc({ op: 'stopRun', sessionId: SID, runId: run.runId, identity: { ...run.identity, run: 99 } })
    assert.equal(stale.body.ok, false)
    assert.equal(h.calls.filter((c) => c.op === 'stop').length, 0)
    const ok = await h.rpc({ op: 'stopRun', sessionId: SID, runId: run.runId, identity: run.identity })
    assert.equal(ok.body.ok, true)
    assert.equal(ok.body.result.phase, 'stopping', 'accepted is stopping, not ended')
  } finally { await h.done() }
})

// ------------------------------------------------------------------ viewer
const INSTALLED = process.env.HMZ_STATIC_DIR ?? '/root/artifacts/hmz-installed-dsh-20261104/test install/venv/lib/python3.12/site-packages/hmz/web/static'

test('the live-trace patch applies to the installed hmz epic view, or is skipped whole', { skip: !existsSync(join(INSTALLED, 'views/epic.js')) && 'hmz not installed here' }, () => {
  const text = readFileSync(join(INSTALLED, 'views/epic.js'), 'utf8')
  const patched = patchEpicView(text)
  assert.deepEqual(patched.missing, [])
  assert.equal(patched.text.split(MARK).length - 1, 5)
  const other = text.replace('      stop()\n      clearInterval(ticking)\n', '      stop()\n      clearInterval(tickingClock)\n')
  const unknown = patchEpicView(other)
  assert.equal(unknown.text, other, 'a version mismatch serves the original untouched')
  assert.equal(unknown.missing.length, 1)
})

test('the viewer route serves only the viewer and hmz\'s epic-view files, under connect-src none', async () => {
  const server = http.createServer(viewerHandler({ staticDir: async () => INSTALLED }))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const get = (path) => new Promise((resolve) => http.get({ host: '127.0.0.1', port, path }, (res) => { res.resume(); res.on('end', () => resolve(res)) }))
  try {
    const page = await get(`${VIEWER_PATH}/index.html`)
    assert.equal(page.statusCode, 200)
    assert.match(page.headers['content-security-policy'], /connect-src 'none'/)
    for (const path of ['hmz/app.js', 'hmz/sidebar.js', 'hmz/views/new.js', 'hmz/../hmz/api.js', '../index.js', 'hmz/views/../app.js']) {
      assert.equal((await get(`${VIEWER_PATH}/${path}`)).statusCode, 404, path)
    }
    if (existsSync(join(INSTALLED, 'views/epic.js'))) {
      const epic = await get(`${VIEWER_PATH}/hmz/views/epic.js`)
      assert.equal(epic.statusCode, 200)
      assert.equal(epic.headers['x-hmzf-patches'], 'applied 5')
    }
  } finally { await new Promise((r) => server.close(r)) }
})

test('observer RPCs: no backend call to read, foreign runs and malformed ids are refused', async () => {
  const h = await harness()
  try {
    const before = h.calls.length
    const empty = await h.rpc({ op: 'observerGet', sessionId: SID })
    assert.equal(empty.body.result.enabled, true, 'on by default')
    assert.deepEqual(empty.body.result.notes, [])
    assert.equal(h.calls.length, before, 'reading made no adapter call')
    const off = await h.rpc({ op: 'observerSet', sessionId: SID, enabled: false })
    assert.equal(off.body.result.enabled, false)
    assert.equal((await h.rpc({ op: 'observerGet', sessionId: SID })).body.result.enabled, false, 'kept before any run')
    assert.equal((await h.rpc({ op: 'observerSet', sessionId: SID, enabled: 'yes' })).body.ok, false)
    const foreign = '99999999-9999-4999-8999-999999999999'
    assert.equal((await h.rpc({ op: 'observerGet', sessionId: SID, runId: foreign })).status, 403)
    assert.equal((await h.rpc({ op: 'observerAct', sessionId: SID, runId: foreign, noteId: 'n-12345678', action: 'known' })).status, 403)
    await h.call('hmz_flow_start', { task: 'task' })
    const run = (await h.rpc({ op: 'runs', sessionId: SID })).body.result.runs[0]
    assert.equal((await h.rpc({ op: 'observerAct', sessionId: SID, runId: run.runId, noteId: '../x', action: 'known' })).status, 403)
    assert.equal((await h.rpc({ op: 'observerAct', sessionId: SID, runId: run.runId, noteId: 'n-12345678', action: 'erase' })).status, 403)
    assert.equal((await h.rpc({ op: 'observerAct', sessionId: SID, runId: run.runId, noteId: 'n-12345678', action: 'known' })).body.ok, false, 'no such note')
    assert.equal((await h.rpc({ op: 'observerGet', sessionId: 'session-nobody' })).status, 404)
  } finally { await h.done() }
})
