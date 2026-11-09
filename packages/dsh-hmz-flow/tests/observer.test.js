import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StateStore } from '../lib/state.js'
import { FlowObserver, streamText } from '../lib/observer.js'
import { buildPrompt, parseReply } from '../lib/observer-prompt.js'
import { redact } from '../lib/observer-diagnostics.js'

const RUN = '11111111-1111-4111-8111-111111111111'
const RUN2 = '22222222-2222-4222-8222-222222222222'
const binding = (requestId = RUN, phase = 'running') => ({ phase, requestId, workspace: '/ws', flow: 'rlar', run: 1, hostPid: 1, hostStarted: 'T', epic: 'E1', epicName: 'E1', names: {} })
const item = (i, text, extra = {}) => ({ ref: `dsh:s1#${i}`, agent: 'Actor', session: 'Actor/1', index: i, category: 'message', tool: '', at: `2026-11-06T00:00:0${i}Z`, text, cut: false, ...extra })
const reply = (note) => JSON.stringify({ note })
const NOTE = { tag: 'heads_up', topic: 'cache invalidation', title: '缓存在多实例下不会失效。', detail: '工作者只在单进程内失效缓存；多实例部署时会读到旧数据。', evidence: ['M1'] }

function harness({ route = { provider: 'deepseek-official', model: 'deepseek-flash' }, evidence, gen, gate = { owner: null }, options } = {}) {
  const store = new StateStore(mkdtempSync(join(tmpdir(), 'hmzflow-obs-')))
  let clock = 1_000_000
  const calls = { evidence: 0, generate: [] }
  let ev = evidence ?? { task: '实现缓存层，支持多实例部署。', items: [item(0, '我用进程内 Map 做缓存，写入时清除本地条目。')], fingerprint: 'f1', omitted: 0 }
  const obs = new FlowObserver({
    store,
    adapter: { request: async (op, args) => { assert.equal(op, 'observe_evidence'); calls.evidence += 1; calls.lastArgs = args; (calls.epics ??= []).push(args.epic); return typeof ev === 'function' ? ev(args) : ev } },
    generate: async (req) => { calls.generate.push(req); return gen ? gen(req) : reply(NOTE) },
    routeOf: () => route,
    now: () => clock,
    gate, // each harness its own host gate unless a test shares one
    options,
  })
  return {
    store, obs, calls, gate,
    now: () => clock,
    setEvidence: (next) => { ev = next },
    advance: (ms) => { clock += ms },
    run: async () => { const p = obs.tick(); if (p) await p },
  }
}

test('new visible work -> one model call, one note with checked provenance; nothing more while it is open', async () => {
  const h = harness()
  h.store.setBinding('S', binding())
  await h.run()
  assert.equal(h.calls.generate.length, 1)
  const req = h.calls.generate[0]
  assert.deepEqual([req.provider, req.model], ['deepseek-official', 'deepseek-flash'], 'the secretary\'s route')
  assert.equal('tools' in req, false)
  assert.match(req.prompt, /\[M1\] Actor\/1 · message/)
  const view = h.obs.view('S')
  assert.equal(view.notes.length, 1)
  const n = view.notes[0]
  assert.equal(n.status, 'open')
  assert.deepEqual(n.evidence.map((e) => [e.ref, e.agent, e.session, e.index]), [['dsh:s1#0', 'Actor', 'Actor/1', 0]])
  h.advance(60_000)
  h.setEvidence({ task: 't', items: [item(0, 'x'), item(1, 'y')], fingerprint: 'f2', omitted: 0 })
  await h.run()
  assert.equal(h.calls.evidence, 1, 'an open note pauses checking')
  assert.equal(h.calls.generate.length, 1)
})

test('unchanged or empty evidence makes no model call, however much time passes; handled topics are not repeated', async () => {
  const h = harness({ gen: () => reply(NOTE) })
  h.store.setBinding('S', binding())
  await h.run()
  const id = h.obs.view('S').notes[0].id
  h.obs.act('S', RUN, id, 'known')
  await h.run()
  assert.equal(h.calls.generate.length, 1, 'polling unchanged progress does not call the model')
  h.advance(31_000)
  await h.run()
  assert.equal(h.calls.evidence, 3)
  assert.equal(h.calls.generate.length, 1, 'same fingerprint: no model call')
  h.advance(31_000)
  h.setEvidence({ task: 't', items: [], fingerprint: 'empty', omitted: 0 })
  await h.run()
  assert.equal(h.calls.generate.length, 1, 'empty evidence: no model call')
  h.advance(31_000)
  h.setEvidence({ task: 't', items: [item(0, 'a'), item(1, 'b')], fingerprint: 'f3', omitted: 0 })
  await h.run()
  assert.equal(h.calls.generate.length, 2)
  assert.match(h.calls.generate[1].prompt, /- cache invalidation/, 'handled topics are listed for the model')
  assert.equal(h.obs.view('S').notes.length, 1, 'the same topic again is dropped')
})

test('six early failures cannot exhaust a run: same evidence retries after persisted backoff and succeeds', async () => {
  let failures = 0
  const h = harness({ gen: () => {
    if (failures++ < 7) throw Object.assign(new Error('HTTP 503 gateway unavailable; api_key="private-key"; sk-123'), { status: 503, code: 'E_GATEWAY' })
    return reply(null)
  } })
  h.store.setBinding('S', binding())
  for (let i = 0; i < 7; i++) {
    await h.run()
    const state = h.obs.runState('S', RUN)
    assert.equal(h.calls.generate.length, i + 1)
    assert.equal(state.fingerprint, '', 'failed evidence remains unacknowledged')
    assert.equal(state.successes, 0)
    await h.run()
    assert.equal(h.calls.generate.length, i + 1, 'backoff prevents immediate failure loops')
    const disk = new StateStore(h.store.dir)
    assert.equal(disk.entry('S').observer.runs[RUN].nextRetryAt, state.nextRetryAt)
    h.advance(state.nextRetryAt - h.now())
  }
  await h.run()
  assert.equal(h.calls.generate.length, 8)
  assert.equal(h.obs.view('S').successes, 1)
  assert.equal(h.obs.view('S').retryAt, null)
  h.advance(48 * 3600_000)
  await h.run()
  assert.equal(h.calls.generate.length, 8, 'time alone never buys another observation')
  const path = join(h.store.dir, 'observer-errors.jsonl')
  const raw = readFileSync(path, 'utf8')
  const diagnostics = raw.trim().split('\n').map(JSON.parse)
  assert.equal(diagnostics.length, 7)
  assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.equal(diagnostics[0].stage, 'model')
  assert.equal(diagnostics[0].error.status, '503')
  assert.match(diagnostics[0].error.message, /gateway unavailable/)
  assert.equal(diagnostics[0].runId, RUN)
  assert.equal(diagnostics[0].model, 'deepseek-flash')
  assert.ok(diagnostics[0].retryAt)
  assert.doesNotMatch(raw + readFileSync(h.store.file, 'utf8'), /private-key|sk-123/)
  assert.equal('lastError' in h.obs.view('S'), false, 'diagnostics are not exposed in browser RPCs')
})

test('new progress can trigger more than six successes without waiting for a time window', async () => {
  const h = harness({ gen: () => reply(null) })
  h.store.setBinding('S', binding())
  for (let i = 0; i < 12; i++) {
    h.setEvidence({ task: 't', items: [item(i, `step ${i}`)], fingerprint: `step-${i}` })
    await h.run()
  }
  assert.equal(h.calls.generate.length, 12)
  assert.equal(h.obs.view('S').successes, 12)
  assert.equal(h.now(), 1_000_000, 'progress, not time, triggers observations')
})

test('legacy exhausted runs retry once; successful new fingerprints survive a restart', async () => {
  const h = harness({ gen: () => reply(null) })
  h.store.setBinding('S', binding())
  h.store.update('S', (entry) => {
    entry.observer = { runs: { [RUN]: { attempts: 6, checks: 6, lastCheckAt: 1, fingerprint: 'f1', terminalDone: false, notes: [], status: { kind: 'error' } } }, order: [RUN] }
  })
  await h.run()
  assert.equal(h.calls.generate.length, 1)
  const restarted = new FlowObserver({
    store: new StateStore(h.store.dir), gate: h.gate, now: h.now,
    adapter: h.obs.deps.adapter, generate: () => assert.fail('successful evidence must not replay'),
    routeOf: h.obs.deps.routeOf,
  })
  await restarted.tick()
  assert.equal(restarted.view('S').attempts, 7)
})

test('invalid replies and failed final checks are diagnosed and retried, not silently acknowledged', async () => {
  let n = 0
  const h = harness({ gen: () => n++ === 1 ? 'not JSON' : reply(null) })
  h.store.setBinding('S', binding())
  await h.run()
  h.store.setBinding('S', binding(RUN, 'ended'))
  h.setEvidence({ task: 't', items: [item(1, 'done')], fingerprint: 'final' })
  await h.run()
  assert.equal(h.obs.runState('S', RUN).terminalDone, false)
  assert.equal(h.obs.runState('S', RUN).fingerprint, 'f1')
  const error = JSON.parse(readFileSync(join(h.store.dir, 'observer-errors.jsonl'), 'utf8'))
  assert.equal(error.stage, 'reply')
  assert.match(error.error.message, /unparsable/)
  h.advance(30_000)
  await h.run()
  assert.equal(h.obs.runState('S', RUN).terminalDone, true)
  assert.equal(h.obs.runState('S', RUN).fingerprint, 'final')
})

test('diagnostics redact credentials but retain transport failure context', () => {
  const error = redact('HTTP 401 Bearer abcdef password=hello https://u:pwd@host/api?key=xyz api_key="abc def"')
  assert.match(error, /HTTP 401/)
  assert.doesNotMatch(error, /abcdef|hello|pwd|xyz|abc def/)
})

test('material-read errors are diagnosed before any model call and retry after restart', async () => {
  const h = harness({ evidence: () => { throw new Error('SDK snapshot incomplete') } })
  h.store.setBinding('S', binding())
  await h.run()
  assert.equal(h.calls.generate.length, 0)
  const log = JSON.parse(readFileSync(join(h.store.dir, 'observer-errors.jsonl'), 'utf8'))
  assert.equal(log.stage, 'evidence')
  assert.match(log.error.message, /snapshot incomplete/)
  h.setEvidence({ task: 't', items: [item(0, 'progress')], fingerprint: 'recovered' })
  let generated = 0
  const restarted = new FlowObserver({
    store: new StateStore(h.store.dir), gate: h.gate, now: h.now,
    adapter: h.obs.deps.adapter, generate: () => { generated++; return reply(null) },
    routeOf: h.obs.deps.routeOf,
  })
  assert.equal(restarted.tick(), null, 'the failure backoff survives restart')
  h.advance(30_000)
  await restarted.tick()
  assert.equal(generated, 1)
  assert.equal(restarted.view('S').failures, 0)
})

test('off before the first run, no model, or a stopping/historical run: no model call', async () => {
  const h = harness()
  h.obs.setEnabled('S', false)
  h.store.setBinding('S', binding())
  await h.run()
  assert.equal(h.calls.evidence + h.calls.generate.length, 0)
  assert.equal(h.obs.view('S').enabled, false, 'the choice made before any run holds')
  h.obs.setEnabled('S', true)
  h.store.setBinding('S', binding(RUN, 'stopping'))
  await h.run()
  assert.equal(h.calls.evidence, 0, 'stopping: not observed')
  const none = harness({ route: null })
  none.store.setBinding('S', binding())
  await none.run()
  assert.equal(none.calls.generate.length, 0)
  assert.equal(none.obs.view('S').status.kind, 'no-model')
})

test('turning off or a new run while a call is in flight: the result is dropped, nothing starts until it settled', async () => {
  let release
  const h = harness({ gen: (req) => new Promise((resolve, reject) => {
    release = () => resolve(reply(NOTE))
    req.signal.addEventListener('abort', () => reject(new Error('aborted')))
  }) })
  h.store.setBinding('S', binding())
  const flight = h.obs.tick()
  await new Promise((r) => setTimeout(r, 10))
  assert.ok(h.obs.inflight)
  assert.equal(h.obs.tick(), null, 'one call at a time')
  h.obs.setEnabled('S', false)
  await flight
  assert.equal(h.obs.inflight, null)
  assert.equal(h.obs.view('S').notes.length, 0, 'no note after turning off')
  // a new run replaces the observed one mid-call
  h.obs.setEnabled('S', true)
  h.advance(31_000)
  h.setEvidence({ task: 't', items: [item(0, 'new')], fingerprint: 'g1', omitted: 0 })
  const second = h.obs.tick()
  await new Promise((r) => setTimeout(r, 10))
  h.store.setBinding('S', binding(RUN2))
  h.obs.tick()
  release?.()
  await second
  assert.equal(h.obs.view('S', RUN).notes.length, 0)
  assert.equal(h.obs.view('S', RUN2).notes.length, 0, 'nothing bleeds into the new run')
})

test('dispose cancels the call and waits for it', async () => {
  const h = harness({ gen: (req) => new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(new Error('aborted')))) })
  h.store.setBinding('S', binding())
  h.obs.tick()
  await new Promise((r) => setTimeout(r, 10))
  await h.obs.dispose()
  assert.equal(h.obs.inflight, null)
  assert.equal(h.obs.tick(), null)
})

test('notes stay with their session and run; actions validate ids', async () => {
  const h = harness()
  h.store.setBinding('A', binding())
  await h.run()
  assert.equal(h.obs.view('B').notes.length, 0)
  const id = h.obs.view('A').notes[0].id
  assert.throws(() => h.obs.act('B', RUN, id, 'known'), /no such run/)
  assert.throws(() => h.obs.act('A', RUN, 'not-an-id', 'known'), /invalid note id/)
  assert.throws(() => h.obs.act('A', RUN, id, 'delete'), /invalid action/)
  h.store.setBinding('A', { ...binding(RUN, 'ended') })
  h.store.setBinding('A', binding(RUN2))
  assert.equal(h.obs.view('A').notes.length, 0, 'a new run starts without the old run\'s notes')
  assert.equal(h.obs.view('A', RUN).notes.length, 1, 'the old run keeps its own')
})

test('one more pass after an observed run ends, none for runs never observed', async () => {
  const h = harness({ gen: () => reply(null) })
  h.store.setBinding('S', binding())
  await h.run()
  h.store.setBinding('S', binding(RUN, 'ended'))
  h.setEvidence({ task: 't', items: [item(0, 'final')], fingerprint: 'end', omitted: 0 })
  await h.run()
  assert.equal(h.calls.generate.length, 2)
  h.advance(60_000)
  h.setEvidence({ task: 't', items: [item(0, 'later')], fingerprint: 'later', omitted: 0 })
  await h.run()
  assert.equal(h.calls.generate.length, 2, 'only one terminal pass')
  const cold = harness()
  cold.store.setBinding('S', binding(RUN, 'ended'))
  await cold.run()
  assert.equal(cold.calls.evidence, 0)
})

test('the model call is tool-less and must finish normally', async () => {
  const llm = (chunks) => ({ async *stream(options) { llm.seen = options; for (const c of chunks) yield c } })
  const ok = llm([{ type: 'text-delta', index: 0, text: '{"note"' }, { type: 'text-delta', index: 0, text: ': null}' }, { type: 'finish', reason: { kind: 'stop' } }])
  assert.equal(await streamText(ok, { provider: 'p', model: 'm', system: 's', prompt: 'u', maxTokens: 10 }), '{"note": null}')
  assert.equal('tools' in llm.seen, false)
  assert.equal('sessionId' in llm.seen, false)
  await assert.rejects(streamText(llm([{ type: 'tool-call-delta', index: 0, id: 't', name: 'bash', argumentsDelta: '{}' }, { type: 'finish', reason: { kind: 'tool-calls' } }]), { provider: 'p', model: 'm', system: 's', prompt: 'u', maxTokens: 10 }))
  await assert.rejects(streamText(llm([{ type: 'reasoning-delta', index: 0, text: 'x' }, { type: 'finish', reason: { kind: 'max-tokens' } }]), { provider: 'p', model: 'm', system: 's', prompt: 'u', maxTokens: 10 }))
})

test('the reply parser is strict and bounded; evidence must be offered material', () => {
  const { refs } = buildPrompt({ task: 'task', items: [item(0, 'a'), item(1, 'b', { category: 'tool', tool: 'bash' })] })
  assert.equal(parseReply('not json', refs).note, null)
  assert.equal(parseReply(reply(null), refs).reason, 'silent')
  assert.equal(parseReply(reply({ ...NOTE, evidence: ['M9'] }), refs).reason, 'unsupported')
  assert.equal(parseReply(reply({ ...NOTE, evidence: [] }), refs).reason, 'unsupported')
  assert.equal(parseReply(reply({ ...NOTE, detail: 'x'.repeat(2000) }), refs).reason, 'too long')
  assert.equal(parseReply(reply({ ...NOTE, tag: 'other' }), refs).reason, 'invalid')
  assert.equal(parseReply(reply(NOTE), refs, ['Cache  Invalidation!']).reason, 'duplicate')
  const ok = parseReply('```json\n' + reply({ ...NOTE, evidence: ['M2'] }) + '\n```', refs)
  assert.deepEqual(ok.note.evidence.map((e) => [e.ref, e.tool]), [['dsh:s1#1', 'bash']])
})

const tick = () => new Promise((r) => setTimeout(r, 5))

test('the host gate outlives an observer: a replacement waits until the old model call really returned', async () => {
  const gate = { owner: null }
  let finish
  // The old call ignores its abort signal entirely.
  const h = harness({ gate, gen: () => new Promise((resolve) => { finish = () => resolve(reply(NOTE)) }) })
  h.store.setBinding('S', binding())
  h.obs.tick()
  await tick()
  assert.ok(gate.owner, 'held while the call runs')
  const t0 = Date.now()
  await h.obs.dispose() // bounded: it stops waiting, it cannot finish the call
  assert.ok(Date.now() - t0 < 1000, 'dispose returns promptly once the check stopped waiting')
  assert.ok(gate.owner, 'abort is not settlement: the gate is still held')
  let started = 0
  const fresh = new FlowObserver({
    store: h.store, gate,
    adapter: { request: async () => { started += 1; return { task: 't', items: [item(0, 'n')], fingerprint: 'z', omitted: 0 } } },
    generate: async () => reply(null),
    routeOf: () => ({ provider: 'p', model: 'm' }),
    now: () => h.now() + 60_000,
  })
  assert.equal(fresh.tick(), null, 'the new instance does not start while the old call is out')
  assert.equal(started, 0)
  finish()
  await tick()
  assert.equal(gate.owner, null, 'freed once the old call returned')
  assert.equal(h.obs.view('S').notes.length, 0, 'the disposed observer\'s late result is dropped')
  const p = fresh.tick()
  assert.ok(p, 'now the new instance may check')
  await p
  assert.equal(started, 1)
  await tick()
  assert.equal(gate.owner, null)
})

test('a timeout stops waiting but keeps the gate until the call returns; then the next check may start', async () => {
  let finish
  const h = harness({ options: { timeoutMs: 20 }, gen: () => new Promise((resolve) => { finish = () => resolve(reply(NOTE)) }) })
  h.store.setBinding('S', binding())
  await h.obs.tick()
  assert.equal(h.obs.view('S').status.kind, 'timeout')
  assert.equal(h.obs.inflight, null)
  assert.ok(h.gate.owner, 'still held: the timed-out call has not returned')
  h.advance(31_000)
  h.setEvidence({ task: 't', items: [item(0, 'more')], fingerprint: 'f9', omitted: 0 })
  assert.equal(h.obs.tick(), null, 'no second call meanwhile')
  finish()
  await tick()
  assert.equal(h.gate.owner, null)
  assert.equal(h.obs.view('S').notes.length, 0, 'the timed-out reply is not used')
  const next = h.obs.tick()
  assert.ok(next, 'the next check starts after the old call returned')
  await tick()
  finish()
  await next
})

test('sessions take turns: the one checked longest ago goes first', async () => {
  let n = 0
  const h = harness({ gen: () => reply(null), evidence: (args) => ({ task: 't', items: [item(0, `${args.epic} ${n}`)], fingerprint: `${args.epic}-${n++}`, omitted: 0 }) })
  h.store.setBinding('A', { ...binding(RUN), epic: 'EA' })
  h.store.setBinding('B', { ...binding(RUN2), epic: 'EB' })
  for (let i = 0; i < 4; i++) { await h.run(); await tick(); h.advance(31_000) }
  assert.deepEqual(h.calls.epics, ['EA', 'EB', 'EA', 'EB'], 'alternating, B is never starved')
})

test('a note is marked partial when any excerpt or instruction was cut or records were left out', async () => {
  const cases = [
    [{ items: [item(0, 'a', { cut: true })] }, true],
    [{ items: [item(0, 'a')], instructions: [{ ...item(1, 'do x'), category: 'instruction', cut: true }] }, true],
    [{ items: [item(0, 'a')], instructionsOmitted: 2 }, true],
    [{ items: [item(0, 'a')], omitted: 3 }, true],
    [{ items: [item(0, 'a')] }, false],
  ]
  for (const [extra, partial] of cases) {
    const h = harness({ evidence: { task: '实现缓存层，支持多实例部署。', fingerprint: 'p', omitted: 0, ...extra } })
    h.store.setBinding('S', binding())
    await h.run()
    assert.equal(h.obs.view('S').notes[0].partial, partial, JSON.stringify(extra))
  }
})

test('received instructions reach the prompt as the current goal and can be cited (changed goal)', async () => {
  const ev = {
    task: 'Build a REST API for the notes service.',
    instructions: [
      { ...item(0, 'Build a REST API for the notes service.'), category: 'instruction' },
      { ...item(3, 'Change of plan: build a CLI instead; drop the REST API.'), category: 'instruction' },
    ],
    items: [item(4, 'Switching to the CLI as asked.'), item(5, 'pytest failed', { category: 'tool', tool: 'bash', error: true })],
    fingerprint: 'g', omitted: 0,
  }
  const { system, user, refs } = buildPrompt(ev)
  assert.match(system, /"know"/)
  assert.match(system, /"heads_up"/)
  assert.match(system, /latest instruction/)
  assert.match(system, /never just because it differs from the original task/)
  assert.match(system, /little or no new record/)
  assert.match(user, /original task \(later instructions may have changed it\)/)
  assert.ok(user.indexOf('[I1]') < user.indexOf('[I2]') && user.indexOf('[I2]') < user.indexOf('<material>'), 'instructions in order, before the material')
  assert.match(user, /\[I2\] Actor\/1 · received instruction\nChange of plan/)
  assert.match(user, /\[M2\] Actor\/1 · tool bash \(error\)/)
  const parsed = parseReply(reply({ ...NOTE, tag: 'heads_up', evidence: ['I2', 'M2'] }), refs)
  assert.deepEqual(parsed.note.evidence.map((e) => [e.category, e.index, e.error]), [['instruction', 3, false], ['tool', 5, true]])
  const zh = buildPrompt({ ...ev, task: '实现缓存层，支持多实例部署，并且写测试。' })
  assert.match(zh.system, /值得知道/)
  assert.match(zh.system, /请注意/)
  assert.match(zh.system, /不要仅凭一段时间没有新记录/)
  assert.match(zh.system, /以工作者收到的最新指令为准/)
  // the observer passes them through and an instruction-only change still counts as new work
  const h = harness({ evidence: { ...ev, items: [] } })
  h.store.setBinding('S', binding())
  await h.run()
  assert.equal(h.calls.generate.length, 1)
  assert.match(h.calls.generate[0].prompt, /<instructions>/)
})
