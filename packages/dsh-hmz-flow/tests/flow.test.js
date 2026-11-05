import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { historySnapshot, composeTask, visibleMessages } from '../lib/history.js'
import { protectedCallReason, InFlight, agentTree, protectedRootOf } from '../lib/policy.js'
import { validateOptions, startArguments, agentSpec } from '../lib/options.js'
import { FlowController } from '../lib/controller.js'
import { StateStore } from '../lib/state.js'
import { AdapterError } from '../lib/adapter-client.js'

const user = (text, kind = 'user-rpc') => ({ type: 'user/message', data: { id: 'u', role: 'user', source: { kind }, content: [{ type: 'text', text }] } })
const assistant = (text, extra = []) => ({ type: 'assistant/message', data: { message: { id: 'a', role: 'assistant', source: { kind: 'model' }, content: [{ type: 'thinking', thinking: 'secret reasoning' }, { type: 'text', text }, ...extra] } } })

// ------------------------------------------------------------------ history
test('history keeps only typed user messages and visible assistant text', () => {
  const events = [
    { type: 'system/message', data: { message: { role: 'system', content: [{ type: 'text', text: 'SYSTEM PROMPT' }] } } },
    user('please fix the parser'),
    user('RUNTIME CONTEXT secret', 'runtime-context'),
    user('[hmz flow notice]', 'hmz-flow'),
    assistant('I will look', [{ type: 'tool_use', name: 'bash', input: { cmd: 'cat ~/.ssh/id_rsa' } }]),
    { type: 'tool/result', data: { message: { role: 'tool', content: [{ type: 'text', text: 'RAW TOOL OUTPUT' }] } } },
    user('typed in terminal', 'user'),
  ]
  const msgs = visibleMessages(events)
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'user'])
  const snap = historySnapshot(events, { now: new Date('2026-11-05T00:00:00Z') })
  for (const forbidden of ['SYSTEM PROMPT', 'RUNTIME CONTEXT', 'hmz flow notice', 'RAW TOOL OUTPUT', 'id_rsa', 'secret reasoning']) {
    assert.ok(!snap.text.includes(forbidden), forbidden)
  }
  assert.match(snap.text, /up to 2026-11-05T00:00:00.000Z/)
  assert.equal(snap.included, 3)
  assert.equal(snap.truncated, false)
})

test('history is bounded: newest kept, long messages cut, both labelled', () => {
  const events = []
  for (let i = 0; i < 100; i++) events.push(user(`message ${i} ${'x'.repeat(300)}`))
  events.push(user('LAST ' + 'y'.repeat(5000)))
  const snap = historySnapshot(events, { limits: { maxChars: 3000, perMessageChars: 500, maxMessages: 40 } })
  assert.ok(snap.text.length < 3600)
  assert.ok(snap.text.includes('LAST'))
  assert.ok(!snap.text.includes('message 0 '))
  assert.equal(snap.truncated, true)
  assert.match(snap.text, /older omitted/)
  assert.match(snap.text, /message cut/)
})

test('composeTask appends background only when present', () => {
  assert.equal(composeTask(' do it ', null), 'do it')
  assert.equal(composeTask('do it', historySnapshot([])), 'do it')
  assert.match(composeTask('do it', historySnapshot([user('hi')])), /^do it\n\n---\n\[Background only/)
})

// ------------------------------------------------------------------- policy
test('protected calls: allowlist, not denylist; root run_code denied, PTC sub-calls judged by name', () => {
  assert.equal(protectedCallReason({ name: 'read' }), undefined)
  assert.equal(protectedCallReason({ name: 'hmz_flow_status' }), undefined)
  assert.equal(protectedCallReason({ name: 'hmz_flow_stop' }), undefined)
  for (const name of ['bash', 'write', 'edit', 'str_replace_editor', 'subagent', 'workflow', 'send_message', 'schedule_create', 'some_new_mcp_tool', 'pwsh', 'terminal_send', 'hmz_flow_start']) {
    assert.ok(protectedCallReason({ name }), name)
  }
  assert.ok(protectedCallReason({ name: 'run_code' }), 'model-direct run_code')
  assert.equal(protectedCallReason({ name: 'read', parent: {} }), undefined, 'PTC sub-call to read')
  assert.ok(protectedCallReason({ name: 'bash', parent: {} }), 'PTC sub-call to bash')
})

function fakeAgents(tree) {
  // tree: { id: parentId|null }
  const agents = Object.fromEntries(Object.keys(tree).map((id) => [id, { id, status: 'idle' }]))
  return {
    agents,
    get: (id) => agents[id],
    list: () => Object.values(agents),
    roots: () => Object.values(agents).filter((a) => tree[a.id] === null),
    isOwnedBy: (id, owner) => tree[id] === owner.id,
  }
}

test('agent tree follows isOwnedBy transitively; protection covers descendants only', () => {
  const reg = fakeAgents({ L: null, c1: 'L', g1: 'c1', other: null })
  assert.deepEqual([...agentTree(reg, reg.get('L')).keys()].sort(), ['L', 'c1', 'g1'])
  assert.equal(protectedRootOf(reg, reg.get('g1'), ['L']), 'L')
  assert.equal(protectedRootOf(reg, reg.get('other'), ['L']), undefined)
})

test('in-flight tracker excludes only the start call itself; an enclosing run_code still counts', () => {
  const f = new InFlight()
  f.add('start', { agentId: 'L', name: 'hmz_flow_start', rootCallId: 'r1' })
  f.add('outer', { agentId: 'L', name: 'run_code', rootCallId: 'r1' })
  f.add('t2', { agentId: 'L', name: 'read', rootCallId: 'r2' })
  f.add('t3', { agentId: 'c1', name: 'bash', rootCallId: 'r3' })
  assert.deepEqual(f.busy(new Set(['L', 'c1']), 'start').map((c) => c.name).sort(), ['bash', 'run_code'])
  f.remove('t3'); f.remove('outer')
  assert.deepEqual(f.busy(new Set(['L', 'c1']), 'start'), [])
})

test('regression: a start from inside a still-running run_code program is refused', async () => {
  const h = harness(async () => { throw new Error('hmz must not be asked') })
  h.inflight.add('outer', { agentId: 'S', name: 'run_code', rootCallId: 'ptc' })
  h.inflight.add('start', { agentId: 'S', name: 'hmz_flow_start', rootCallId: 'ptc' })
  await assert.rejects(h.ctl.start('S', startReq({ exceptToken: 'start' })), /run_code program is still running/)
  assert.equal(h.calls.length, 0)
  assert.equal(h.ctl.isProtected('S'), false)
})

// ------------------------------------------------------------------ options
const declaredRlar = {
  name: 'rlar',
  agents: [{ name: 'actor', required: true, auto: false }, { name: 'reviewer', required: true, auto: false }, { name: 'human', required: true, auto: true }],
  remembered: { agents: { actor: 'claude/claude-haiku-4-5:low' }, budget: {}, params: {} },
}

test('options validation rejects malformed agents/budgets', () => {
  assert.throws(() => validateOptions({ agents: { actor: 'not a spec' } }))
  assert.throws(() => validateOptions({ budget: { cost: -1 } }))
  assert.throws(() => validateOptions({ params: [] }))
  const ok = validateOptions({ agents: { actor: agentSpec({ cli: 'dsh', model: 'deepseek-v4-flash', effort: 'low' }), reviewer: '' }, budget: { cost: '0.5', duration: 600 } })
  assert.deepEqual(ok.agents, { actor: 'dsh/deepseek-v4-flash:low' })
  assert.deepEqual(ok.budget, { cost: 0.5, duration: 600, graceful: true })
})

test('start arguments: missing role agent or budget is reported, saved options win', () => {
  const missing = startArguments(declaredRlar, undefined)
  assert.equal(missing.ok, false)
  assert.ok(missing.problems.some((p) => p.includes('reviewer')))
  assert.ok(missing.problems.some((p) => p.includes('budget')))
  const saved = validateOptions({ agents: { actor: 'dsh/deepseek-v4-flash:low', reviewer: 'dsh/deepseek-v4-flash:low' }, budget: { cost: 1 } })
  const built = startArguments(declaredRlar, saved)
  assert.equal(built.ok, true)
  assert.deepEqual(built.args.agents, { actor: 'dsh/deepseek-v4-flash:low', reviewer: 'dsh/deepseek-v4-flash:low' })
  assert.equal(startArguments({ name: 'chat', agents: [{ name: 'assistant', required: true, auto: false }], remembered: { agents: { assistant: 'a/b' } } }).ok, true, 'chat needs no budget')
})

// --------------------------------------------------------------- controller
function harness(adapterImpl, { agents = fakeAgents({ S: null, c: 'S' }), jobs = [] } = {}) {
  const store = new StateStore(mkdtempSync(join(tmpdir(), 'hmzflow-ctl-')))
  const calls = []
  const notices = []
  const adapter = { request: async (op, args) => { calls.push({ op, args }); return adapterImpl(op, args, calls) } }
  const inflight = new InFlight()
  const ctl = new FlowController({
    adapter, store, agents, inflight,
    jobs: () => ({ list: (caller) => jobs.filter((j) => j.owner === caller) }),
    workspaceOf: () => '/ws',
    notify: (id, text) => { notices.push(text); return true },
  })
  return { ctl, store, calls, notices, inflight, agents }
}
const saved = validateOptions({ agents: { actor: 'dsh/m', reviewer: 'dsh/m' }, budget: { cost: 1 } })
const startReq = (extra = {}) => ({ task: 'fix it', flow: 'rlar', declared: declaredRlar, saved, composeTask: (t) => ({ task: t, history: null }), ...extra })
const BOUND = { hostPid: 10, hostStarted: 'T', slot: '', run: 1, epic: '/e/E1', epicName: 'E1', flow: 'rlar', names: { actor: 'A1', reviewer: 'R1' } }

test('a busy session (running subagent, job, or tool body) refuses to start and kills nothing', async () => {
  for (const setup of [
    (h) => { h.agents.get('c').status = 'running' },
    (h) => { h.jobs.push({ id: 'bash-1', label: 'npm test', owner: 'S', status: 'running' }) },
    (h) => { h.inflight.add('tok', { agentId: 'S', name: 'bash', rootCallId: 'other' }) },
  ]) {
    const jobs = []
    const h = harness(async () => { throw new Error('must not be called') }, { jobs })
    h.jobs = jobs
    setup(h)
    await assert.rejects(h.ctl.start('S', startReq({ exceptToken: 'mine' })), /still running.*nothing was killed/)
    assert.equal(h.calls.length, 0, 'hmz never asked')
    assert.equal(h.ctl.isProtected('S'), false, 'fence released')
    assert.equal(h.store.binding('S'), undefined)
  }
})

test('start persists intent first, then binds the exact run; protection on until verified end', async () => {
  let seenIntent = null
  const h = harness(async (op, args) => {
    if (op === 'start') {
      seenIntent = h.store.binding('S')
      return { binding: { ...BOUND, frontend: `dsh-hmz-flow:${args.requestId}` } }
    }
    if (op === 'observe') return h.verdict
    throw new Error(op)
  })
  const { binding } = await h.ctl.start('S', startReq())
  assert.equal(seenIntent.phase, 'starting', 'intent persisted before hmz was asked')
  assert.equal(binding.phase, 'running')
  assert.equal(h.ctl.isProtected('S'), true)
  await assert.rejects(h.ctl.start('S', startReq()), /already has hmz run #1/)

  h.verdict = { verdict: 'running', view: { pending: [{ question: 'q1', run: 1, role: 'human', text: 'Ship it?', options: ['yes', 'no'] }] } }
  await h.ctl.observe('S')
  await h.ctl.observe('S')
  assert.equal(h.notices.filter((n) => n.includes('q1')).length, 1, 'question notified once')
  assert.match(h.notices[0], /Never answer it yourself/)

  h.verdict = { verdict: 'unverified', why: 'timeout' }
  await h.ctl.observe('S')
  assert.equal(h.ctl.isProtected('S'), true, 'unverified keeps protection')

  h.verdict = { verdict: 'ended', how: 'done' }
  await h.ctl.observe('S')
  await h.ctl.observe('S')
  assert.equal(h.store.binding('S').phase, 'ended')
  assert.equal(h.ctl.isProtected('S'), false)
  assert.equal(h.notices.filter((n) => n.includes('has ended')).length, 1, 'end notified once')
})

test('a lost start answer becomes unknown: never re-sent, protection kept, lookup by request id can bind it', async () => {
  let starts = 0
  const h = harness(async (op, args) => {
    if (op === 'start') { starts++; throw new AdapterError('timeout', 'unknown') }
    if (op === 'find_request') return h.found ?? { found: false, why: 'not there' }
    if (op === 'observe') return { verdict: 'running', view: { pending: [] } }
    throw new Error(op)
  })
  await assert.rejects(h.ctl.start('S', startReq()), (e) => e.outcome === 'unknown' && /NOT re-sent/.test(e.message))
  assert.equal(h.store.binding('S').phase, 'unknown')
  assert.equal(h.ctl.isProtected('S'), true)
  await h.ctl.observe('S')
  assert.equal(h.store.binding('S').phase, 'unknown', 'not found is not proof')
  await assert.rejects(h.ctl.send('S', { role: 'actor', text: 'x' }), /unknown/)
  h.found = { found: true, binding: BOUND }
  await h.ctl.observe('S')
  assert.equal(h.store.binding('S').phase, 'running')
  assert.equal(starts, 1, 'start sent exactly once')
})

test('a refused start clears the intent and releases the fence', async () => {
  const h = harness(async () => { throw new AdapterError('hmz already has run #3 running', 'refused') })
  await assert.rejects(h.ctl.start('S', startReq()), /did not start/)
  assert.ok(!h.store.binding('S'))
  assert.equal(h.ctl.isProtected('S'), false)
})

test('send needs exactly one target; stop accepted is stopping, not ended', async () => {
  const h = harness(async (op, args) => {
    if (op === 'start') return { binding: BOUND }
    if (op === 'say') return { accepted: true, to: 'R1', role: 'reviewer', run: 1 }
    if (op === 'stop') return { accepted: true, run: 1 }
    if (op === 'observe') return { verdict: 'stopping', view: { pending: [] } }
    throw new Error(op)
  })
  await h.ctl.start('S', startReq())
  await assert.rejects(h.ctl.send('S', { text: 'x' }), /exactly one/)
  await assert.rejects(h.ctl.send('S', { role: 'reviewer', agent: 'R1', text: 'x' }), /exactly one/)
  const said = await h.ctl.send('S', { role: 'reviewer', text: 'please review' })
  assert.equal(said.to, 'R1')
  const sayCall = h.calls.find((c) => c.op === 'say')
  assert.deepEqual(sayCall.args.expect, { hostPid: 10, hostStarted: 'T', run: 1, epic: '/e/E1' })
  await h.ctl.stop('S')
  assert.equal(h.store.binding('S').phase, 'stopping')
  assert.equal(h.ctl.isProtected('S'), true)
  await h.ctl.observe('S')
  assert.equal(h.ctl.isProtected('S'), true, 'still protected while stopping')
})

test('commands of one session are serialized', async () => {
  const order = []
  let release
  const gate = new Promise((r) => { release = r })
  const h = harness(async (op) => {
    if (op === 'start') return { binding: BOUND }
    if (op === 'say') { order.push('say-begin'); await gate; order.push('say-end'); return { accepted: true, to: 'A1', run: 1 } }
    if (op === 'stop') { order.push('stop'); return { accepted: true } }
    throw new Error(op)
  })
  await h.ctl.start('S', startReq())
  const a = h.ctl.send('S', { role: 'actor', text: 'x' })
  const b = h.ctl.stop('S')
  await new Promise((r) => setTimeout(r, 20))
  release()
  await Promise.all([a, b])
  assert.deepEqual(order, ['say-begin', 'say-end', 'stop'])
})

test('a start interrupted by a Host restart is unknown after restore', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hmzflow-ctl-'))
  const store = new StateStore(dir)
  store.setBinding('S', { phase: 'starting', requestId: 'r', workspace: '/ws', flow: 'rlar' })
  const ctl = new FlowController({ adapter: { request: async () => ({}) }, store: new StateStore(dir), agents: fakeAgents({ S: null }), inflight: new InFlight(), workspaceOf: () => '/ws', notify: () => true })
  assert.equal(ctl.deps.store.binding('S').phase, 'unknown')
  assert.equal(ctl.isProtected('S'), true)
})

test('regression: an end notice not deliverable while the leader is absent is retried later', async () => {
  let live = false
  const h = harness(async (op) => (op === 'start' ? { binding: BOUND } : { verdict: 'ended', how: 'done' }))
  h.ctl.deps.notify = () => live
  await h.ctl.start('S', startReq())
  await h.ctl.tick()
  assert.equal(h.store.binding('S').phase, 'ended')
  assert.equal(h.store.binding('S').notified.ended, false)
  // restart: a new controller over the same store
  const again = new FlowController({ ...h.ctl.deps, notify: () => true })
  await again.tick()
  assert.equal(again.deps.store.binding('S').notified.ended, true)
})

test('regression: a reply is only sent to the exact run it was shown for', async () => {
  const h = harness(async (op, args) => {
    if (op === 'start') return { binding: BOUND }
    if (op === 'answer') return { accepted: true, run: args.expect.run }
    throw new Error(op)
  })
  await h.ctl.start('S', startReq())
  const shown = h.ctl.identityOf(h.store.binding('S'))
  // the run is replaced by another one on a new host (run numbers restart)
  h.store.setBinding('S', { ...h.store.binding('S'), hostPid: 99, hostStarted: 'T2', run: 1, epic: '/e/E2', requestId: 'other' })
  await assert.rejects(h.ctl.answer('S', { question: 'q1', text: 'yes', expect: shown }), /NOT sent/)
  assert.equal(h.calls.filter((c) => c.op === 'answer').length, 0)
  const now = h.ctl.identityOf(h.store.binding('S'))
  await h.ctl.answer('S', { question: 'q1', text: 'yes', expect: now })
  assert.equal(h.calls.filter((c) => c.op === 'answer').length, 1)
})

test('regression: an incomplete binding is completed only by a lookup of the exact run on the same host', async () => {
  const h = harness(async (op, args) => {
    if (op === 'start') return { binding: { hostPid: 10, hostStarted: 'T', run: 2, epic: '', names: {}, flow: 'rlar' }, bindingComplete: false, incompleteWhy: 'timeout' }
    if (op === 'find_request') { h.lookups.push(args); return h.found }
    if (op === 'observe') return { verdict: 'running', view: { pending: [] } }
    throw new Error(op)
  })
  h.lookups = []
  await h.ctl.start('S', startReq())
  assert.equal(h.store.binding('S').incomplete, true)
  await assert.rejects(h.ctl.send('S', { role: 'actor', text: 'x' }), /roles/)
  h.found = { found: true, binding: { ...BOUND, hostPid: 77, run: 2 } }
  await h.ctl.observe('S')
  assert.equal(h.store.binding('S').incomplete, true, 'another host does not complete it')
  assert.equal(h.lookups.at(-1).run, 2)
  h.found = { found: true, binding: { ...BOUND, run: 2, epic: '/e/E2', epicName: 'E2' } }
  await h.ctl.observe('S')
  assert.equal(h.store.binding('S').incomplete, false)
  assert.equal(h.store.binding('S').epic, '/e/E2')
})

// ------------------------------------------------------------------ present
import { formatStatus } from '../lib/present.js'
const sel = { flow: 'rlar', includeHistory: true }

test('status rendering: an incomplete read is shown as unknown, never as idle', () => {
  const out = formatStatus({ workspace: '/w', held: true, observedAt: 1, complete: false, incompleteWhy: 'no consistent snapshot in time', hostPid: 5, state: '', run: 0, recent: [], otherHosts: [] }, sel)
  assert.match(out, /INCOMPLETE READ.*unknown/)
  assert.doesNotMatch(out, /state: idle|nothing is running|no flow is running/)
})

test('status rendering: no default host does not hide native chat hosts in the directory', () => {
  const out = formatStatus({ workspace: '/w', held: false, observedAt: 1, recent: [], otherHosts: [{ slot: 'chat:abc', pid: 9, started: 'T', alive: true }] }, sel)
  assert.match(out, /own hmz host.*not running/)
  assert.match(out, /chat:abc pid 9/)
  assert.match(out, /not bound to this DSH session/)
  assert.doesNotMatch(out, /nothing is running here/)
})

test('status rendering: complete read lists roles and questions with their run', () => {
  const out = formatStatus({ workspace: '/w', held: true, observedAt: 1, complete: true, hostPid: 5, state: 'running', run: 2, flow: 'rlar', epicName: 'E', names: { actor: 'A' }, pending: [{ question: 'q1', run: 2, role: 'human', text: 'ok?' }], recent: [], otherHosts: [] }, sel)
  assert.match(out, /actor -> A/)
  assert.match(out, /q1 \[run #2, human\]/)
})

test('regression: saved options are authoritative — cleared budget/params/envs are not resurrected', () => {
  const declared = { name: 'chat', agents: [{ name: 'assistant', required: true, auto: false }], envs: [{ name: 'workspace', required: true, auto: true }],
    remembered: { agents: { assistant: 'dsh@old/x' }, budget: { cost: 5 }, params: { p: 1 }, envs: { workspace: 'docker' } } }
  const fromRemembered = startArguments(declared, undefined)
  assert.equal(fromRemembered.args.budget.cost, 5)
  assert.equal(fromRemembered.from, 'remembered')
  const cleared = validateOptions({ agents: { assistant: 'dsh@preview-deepseek/deepseek-flash' }, budget: null, params: {}, envs: {} })
  const built = startArguments(declared, cleared)
  assert.equal(built.ok, true)
  assert.equal(built.args.budget, null, 'cleared chat budget stays cleared')
  assert.deepEqual(built.args.params, {})
  assert.deepEqual(built.args.envs, {})
  assert.equal(built.args.agents.assistant, 'dsh@preview-deepseek/deepseek-flash')
  const missingRole = startArguments({ ...declared, name: 'rlar' }, validateOptions({ agents: {}, budget: { cost: 1 } }))
  assert.ok(missingRole.problems.some((p) => p.includes('assistant')), 'a role cleared in DSH is not filled from hmz memory')
})

test('environment roles: required non-auto env needs a runtime; envs validated as strings', () => {
  const declared = { name: 'x', agents: [], envs: [{ name: 'box', required: true, auto: false }], remembered: {} }
  assert.ok(startArguments(declared, validateOptions({ budget: { cost: 1 } })).problems.some((p) => p.includes('box')))
  const ok = startArguments(declared, validateOptions({ budget: { cost: 1 }, envs: { box: 'local' } }))
  assert.deepEqual(ok.args.envs, { box: 'local' })
  assert.throws(() => validateOptions({ envs: { box: 3 } }))
})

test('regression: hmz accepted but the local record failed — reported as accepted/unknown, protected, never re-sent', async () => {
  let starts = 0
  let stops = 0
  const h = harness(async (op) => {
    if (op === 'start') { starts++; return { binding: BOUND } }
    if (op === 'stop') { stops++; return { accepted: true } }
    throw new Error(op)
  })
  const realSet = h.store.setBinding.bind(h.store)
  let failPhase = 'running'
  h.store.setBinding = (id, b) => { if (b?.phase === failPhase) throw new Error('ENOSPC'); return realSet(id, b) }
  await assert.rejects(h.ctl.start('S', startReq()), (e) => e.outcome === 'unknown' && e.accepted && /accepted the start.*NOT re-sent/.test(e.message))
  assert.equal(starts, 1)
  assert.equal(h.store.binding('S').phase, 'starting', 'the persisted intent keeps protection')
  assert.equal(h.ctl.isProtected('S'), true)
  failPhase = 'stopping'
  realSet('S', { ...h.store.binding('S'), ...BOUND, phase: 'running' })
  await assert.rejects(h.ctl.stop('S'), (e) => e.outcome === 'unknown' && e.accepted && /accepted the stop/.test(e.message))
  assert.equal(stops, 1)
  assert.equal(h.ctl.isProtected('S'), true)
})
