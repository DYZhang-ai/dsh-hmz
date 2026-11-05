import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StateStore } from '../lib/state.js'
import { RunView, MaskError } from '../lib/runview.js'
import { FlowController } from '../lib/controller.js'
import { InFlight } from '../lib/policy.js'
import { validateOptions } from '../lib/options.js'

const dir = () => mkdtempSync(join(tmpdir(), 'hmzflow-runs-'))
const RUN_A = '11111111-1111-4111-8111-111111111111'
const RUN_B = '22222222-2222-4222-8222-222222222222'
const bound = (requestId, run, epicName) => ({
  phase: 'running', requestId, workspace: '/ws', flow: 'chat', hostPid: 10, hostStarted: 'T', run,
  epic: `/home/epics/-ws/${epicName}`, epicName, names: { assistant: `Agent${run}` }, notified: { questions: [], ended: false },
})

// ------------------------------------------------------------------- store
test('v2 state with one binding migrates to a run history without losing it', () => {
  const d = dir()
  writeFileSync(join(d, 'state.json'), JSON.stringify({ version: 2, sessions: { 'session-a': {
    selection: { flow: 'chat', includeHistory: false }, options: { chat: { agents: { assistant: 'dsh@x/y' } } }, binding: bound(RUN_A, 1, 'E1'),
  } } }))
  const store = new StateStore(d)
  assert.deepEqual(store.runsOf('session-a').map((r) => r.runId), [RUN_A])
  assert.equal(store.binding('session-a').epicName, 'E1')
  assert.equal(store.selection('session-a').includeHistory, false)
  assert.equal(store.options('session-a', 'chat').agents.assistant, 'dsh@x/y')
  store.setSelection('session-a', { flow: 'chat' })
  assert.equal(JSON.parse(readFileSync(join(d, 'state.json'), 'utf8')).version, 3)
})

test('a second run of a session keeps the first; a refused start leaves no history entry', () => {
  const store = new StateStore(dir())
  store.setBinding('s', bound(RUN_A, 1, 'E1'))
  store.setBinding('s', { ...bound(RUN_A, 1, 'E1'), phase: 'ended', endedHow: 'done' })
  store.setBinding('s', { phase: 'starting', requestId: RUN_B, workspace: '/ws', flow: 'chat' })
  store.setBinding('s', bound(RUN_B, 2, 'E2'))
  assert.deepEqual(store.runsOf('s').map((r) => [r.runId, r.phase]), [[RUN_A, 'ended'], [RUN_B, 'running']])
  assert.equal(store.binding('s').requestId, RUN_B, 'the current run is the newest')
  const third = '33333333-3333-4333-8333-333333333333'
  store.setBinding('s', { phase: 'starting', requestId: third, workspace: '/ws', flow: 'chat' })
  store.setBinding('s', null)
  assert.deepEqual(store.runsOf('s').map((r) => r.runId), [RUN_A, RUN_B])
  assert.equal(store.run('other', RUN_A), undefined, 'a run id resolves only within its own session')
})

// -------------------------------------------------------------------- mask
function view(store, impl = async () => { throw new Error('adapter must not be called') }) {
  const calls = []
  const adapter = { request: async (op, args) => { calls.push({ op, args }); return impl(op, args) } }
  return { rv: new RunView({ store, adapter }), calls }
}

test('a new session has an empty Flow page and no hmz call is made', () => {
  const store = new StateStore(dir())
  store.setBinding('session-old', bound(RUN_A, 1, 'E1')) // another session's run in the same directory
  const { rv, calls } = view(store)
  assert.deepEqual(rv.list('session-new'), { currentRunId: null, runs: [], lastAutoStart: null, pending: [] })
  assert.equal(calls.length, 0)
})

test('cross-session run ids, malformed ids and foreign session keys are refused before the adapter', async () => {
  const store = new StateStore(dir())
  store.setBinding('session-a', bound(RUN_A, 1, 'E1'))
  store.setBinding('session-b', bound(RUN_B, 1, 'E9'))
  const tree = { epic: { name: 'E1' }, agents: [{ agent: 'Agent1', role: 'assistant', sessions: [{ key: 'dsh:sess-1' }] }] }
  const { rv, calls } = view(store, async (op) => (op === 'epic_tree' ? tree : { session: 'sess-1', actions: [] }))
  await assert.rejects(rv.tree('session-a', RUN_B), MaskError)
  await assert.rejects(rv.tree('session-a', '../../etc'), MaskError)
  await assert.rejects(rv.session('session-a', RUN_B, 'dsh:sess-1'), MaskError)
  assert.equal(calls.length, 0, 'nothing reached the adapter')
  await assert.rejects(rv.session('session-a', RUN_A, 'sess-of-another-run'), /not one this run opened/)
  assert.deepEqual(calls.map((c) => c.op), ['epic_tree'], 'only this run\'s tree was read to check the key')
  assert.equal(calls[0].args.epic, '/home/epics/-ws/E1', 'the epic path comes from the session\'s own record')
  await rv.session('session-a', RUN_A, 'dsh:sess-1')
  assert.deepEqual(calls.at(-1), { op: 'epic_session', args: { workspace: '/ws', epic: '/home/epics/-ws/E1', session: 'dsh:sess-1' } })
  await assert.rejects(rv.session('session-a', RUN_A, 'dsh:sess-1', -1), MaskError)
})

test('a run whose epic is not known yet shows a pending tree without asking hmz', async () => {
  const store = new StateStore(dir())
  store.setBinding('s', { ...bound(RUN_A, 1, ''), epic: '', epicName: '', incomplete: true })
  const { rv, calls } = view(store)
  assert.deepEqual(await rv.tree('s', RUN_A), { epic: null, agents: [], drove: [], pendingEpic: true })
  assert.equal(calls.length, 0)
})

// ------------------------------------------------- history vs control target
test('after a second run, history keeps the first while control acts on the current run only', async () => {
  const store = new StateStore(dir())
  const agent = { id: 'S', status: 'idle' }
  const calls = []
  let next = 1
  const adapter = { request: async (op, args) => {
    calls.push({ op, args })
    if (op === 'start') { const n = next++; return { binding: { hostPid: 10, hostStarted: 'T', run: n, epic: `/e/E${n}`, epicName: `E${n}`, flow: 'chat', names: { assistant: `A${n}` } } } }
    if (op === 'observe') return { verdict: 'ended', how: 'done' }
    if (op === 'say') return { accepted: true, to: args.role, run: args.expect.run }
    throw new Error(op)
  } }
  const ctl = new FlowController({ adapter, store, agents: { get: () => agent, list: () => [agent], isOwnedBy: () => false },
    inflight: new InFlight(), workspaceOf: () => '/ws', notify: () => true })
  const req = { task: 't', flow: 'chat', declared: { name: 'chat', agents: [{ name: 'assistant', required: true, auto: false }], envs: [] },
    saved: validateOptions({ agents: { assistant: 'dsh@p/m' } }), composeTask: (t) => ({ task: t, history: null }) }
  const first = await ctl.start('S', req)
  await ctl.observe('S') // run 1 ends
  const second = await ctl.start('S', req)
  assert.deepEqual(store.runsOf('S').map((r) => [r.run, r.phase]), [[1, 'ended'], [2, 'running']])
  await ctl.send('S', { role: 'assistant', text: 'x' })
  assert.equal(calls.find((c) => c.op === 'say').args.expect.run, 2)
  assert.notEqual(first.binding.requestId, second.binding.requestId)
  const rv = new RunView({ store, adapter })
  assert.deepEqual(rv.list('S').runs.map((r) => [r.run, r.current]), [[2, true], [1, false]])
})
