import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'
import { AdapterClient } from '../lib/adapter-client.js'
import { StateStore } from '../lib/state.js'

const RUN_A = '11111111-1111-4111-8111-111111111111'

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'hmzflow-route-'))
  const calls = []
  const original = AdapterClient.prototype.request
  AdapterClient.prototype.request = async function (op, args) { calls.push({ op, args }); return { agents: [], epic: { name: 'E1' } } }
  let route = null
  const disposers = []
  const agents = ['session-a', 'session-b'].map((id) => ({ id, status: 'idle', session: {}, ctx: { tools: { presentAs: () => () => {} } } }))
  const ctx = {
    logger: () => ({ warn() {}, info() {} }),
    agents: { get: (id) => agents.find((a) => a.id === id), roots: () => agents, list: () => agents, isOwnedBy: () => false },
    workingDirectory: { get: () => dir },
    tools: { register: () => () => {}, guard: () => () => {} },
    connection: { fetch: { register: (r) => { route = r; return () => {} } } },
    webServer: { port: 1, register: () => () => {} },
    effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); return d },
    on() {},
    get: () => undefined,
  }
  const store = new StateStore(dir)
  store.setBinding('session-a', { phase: 'ended', requestId: RUN_A, workspace: dir, flow: 'chat', run: 1, epic: join(dir, 'E1'), epicName: 'E1', hostPid: 1, hostStarted: 'T', names: {}, notified: { ended: true } })
  apply(ctx, { python: 'python3', stateDir: dir, monitorMs: 600000 })
  const post = async (body) => {
    const response = await route.fetch(new Request('http://x/api/hmz-flow/rpc', { method: 'POST', body: JSON.stringify(body) }))
    return { status: response.status, body: await response.json() }
  }
  const done = async () => {
    for (const d of disposers.reverse()) await d()
    AdapterClient.prototype.request = original
  }
  return { post, calls, done }
}

test('route: a new session lists no runs and makes no hmz call; another session\'s run id is 403', async () => {
  const h = await harness()
  try {
    const fresh = await h.post({ op: 'runs', sessionId: 'session-b' })
    assert.equal(fresh.status, 200)
    assert.deepEqual(fresh.body.result.runs, [])
    const cross = await h.post({ op: 'runTree', sessionId: 'session-b', runId: RUN_A })
    assert.equal(cross.status, 403)
    const crossDetail = await h.post({ op: 'runSession', sessionId: 'session-b', runId: RUN_A, sessionKey: 'k' })
    assert.equal(crossDetail.status, 403)
    assert.equal(h.calls.length, 0, 'no adapter call for any of these')
    const own = await h.post({ op: 'runs', sessionId: 'session-a' })
    assert.deepEqual(own.body.result.runs.map((r) => r.runId), [RUN_A])
    assert.equal((await h.post({ op: 'embed', sessionId: 'session-a' })).status, 404, 'the old embed path is gone')
  } finally { await h.done() }
})
