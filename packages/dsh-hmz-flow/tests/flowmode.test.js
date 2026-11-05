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
const user = (id, text, kind = 'user-rpc') => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind } })

async function harness({ start, selection = { flow: 'chat' } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hmzflow-auto-'))
  const store = new StateStore(dir)
  if (selection.flow) {
    store.setSelection(SID, selection)
    store.setOptions(SID, 'chat', { agents: { assistant: 'dsh@acct/deepseek-flash' } })
  }
  const calls = []
  const original = AdapterClient.prototype.request
  let n = 0
  AdapterClient.prototype.request = async function (op, args) {
    calls.push({ op, args })
    if (op === 'flow') return { name: 'chat', agents: [{ name: 'assistant', required: true, auto: false }], envs: [] }
    if (op === 'start') {
      if (start) return start(args)
      n += 1
      return { binding: { hostPid: 1, hostStarted: 'T', run: n, epic: `E${n}`, epicName: `E${n}`, flow: 'chat', names: { assistant: 'A' } } }
    }
    if (op === 'stop') return { accepted: true }
    return {}
  }
  const agent = { id: SID, status: 'running', session: { snapshotEvents: () => [] }, ctx: { tools: { presentAs: () => () => {} } }, followup() {} }
  const events = new Map()
  let guard
  let route
  const disposers = []
  const ctx = {
    logger: () => ({ warn() {}, info() {} }),
    agents: { get: (id) => (id === SID ? agent : undefined), roots: () => [agent], list: () => [agent], isOwnedBy: () => false },
    workingDirectory: { get: () => dir },
    tools: { register: () => () => {}, guard: (fn) => { guard = fn; return () => {} } },
    connection: { fetch: { register: (r) => { route = r; return () => {} } } },
    webServer: { port: 1, register: () => () => {} },
    effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); return d },
    on(name, fn) { events.set(name, fn); return () => {} },
    get: () => undefined,
  }
  apply(ctx, { python: 'python3', stateDir: dir, monitorMs: 600000 })
  const step = (messages, signal = new AbortController().signal) =>
    events.get('agent/pre-step')({ agent, messages, turn: 1, step: 1, signal }, async () => ({ kind: 'enter', messages }))
  const rpc = async (body) => {
    const r = await route.fetch(new Request('http://x/api/hmz-flow/rpc', { method: 'POST', body: JSON.stringify(body) }))
    return { status: r.status, body: await r.json() }
  }
  const state = () => JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).sessions[SID]
  const done = async () => { for (const d of disposers.reverse()) await d(); AdapterClient.prototype.request = original }
  return { step, calls, guard: (exec) => guard({ agent, ...exec }), rpc, state, done }
}

test('a typed task in flow mode starts the flow before the leader\'s step, exactly once', async () => {
  const h = await harness()
  try {
    const out = await h.step([user('m1', 'create hello.txt')])
    assert.equal(h.calls.filter((c) => c.op === 'start').length, 1)
    assert.match(h.calls.find((c) => c.op === 'start').args.task, /^create hello\.txt/)
    assert.equal(out.kind, 'enter')
    assert.equal(out.messages.length, 2, 'the user message plus one plugin notice')
    assert.equal(out.messages[1].source.kind, 'hmz-flow')
    assert.match(out.messages[1].content[0].text, /Do not do it yourself/)
    await h.step([user('m1', 'create hello.txt')])
    assert.equal(h.calls.filter((c) => c.op === 'start').length, 1, 'the same message id never starts twice')
  } finally { await h.done() }
})

test('only fresh messages of a typed source start a flow; notices, replies and an active run do not', async () => {
  const h = await harness()
  try {
    await h.step([user('n1', 'notice', 'hmz-flow'), user('n2', 'reply', 'user-question-reply'), user('n3', 'ctx', 'runtime-context')])
    assert.equal(h.calls.filter((c) => c.op === 'start').length, 0)
    await h.step([user('a', 'first task')])
    await h.step([user('b', 'second message while the run is active')])
    assert.equal(h.calls.filter((c) => c.op === 'start').length, 1, 'a running flow gets the leader, not a new run')
  } finally { await h.done() }
})

test('cancelled before sending: no start, and the message may start later', async () => {
  const h = await harness()
  try {
    const abort = new AbortController()
    abort.abort()
    await h.step([user('c1', 'task')], abort.signal)
    assert.equal(h.calls.filter((c) => c.op === 'start').length, 0)
    await h.step([user('c1', 'task')])
    assert.equal(h.calls.filter((c) => c.op === 'start').length, 1)
  } finally { await h.done() }
})

test('a refused automatic start is reported, writes stay blocked in flow mode, a later success clears the error', async () => {
  let refuse = true
  const h = await harness({ start: () => {
    if (refuse) { const e = new Error('workspace is busy'); e.outcome = 'refused'; throw e }
    return { binding: { hostPid: 1, hostStarted: 'T', run: 1, epic: 'E1', epicName: 'E1', flow: 'chat', names: {} } }
  } })
  try {
    const out = await h.step([user('r1', 'task')])
    assert.match(out.messages[1].content[0].text, /not started: .*workspace is busy|workspace is busy/)
    assert.equal(h.state().lastAutoStart.ok, false)
    assert.ok(h.guard({ name: 'bash' }), 'bash blocked in flow mode after a refused start')
    assert.ok(h.guard({ name: 'run_code' }))
    assert.equal(h.guard({ name: 'read' }), undefined)
    assert.equal(h.guard({ name: 'hmz_flow_start' }), undefined, 'an explicit retry is allowed')
    assert.equal((await h.rpc({ op: 'runs', sessionId: SID })).body.result.lastAutoStart.ok, false)
    refuse = false
    await h.step([user('r2', 'task again')])
    assert.equal(h.state().lastAutoStart.ok, true)
    assert.equal((await h.rpc({ op: 'runs', sessionId: SID })).body.result.lastAutoStart, null)
  } finally { await h.done() }
})

test('Stop names the exact run it was shown for; a stale identity stops nothing', async () => {
  const h = await harness()
  try {
    await h.step([user('s1', 'task')])
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
