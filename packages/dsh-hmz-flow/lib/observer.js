/**
 * The flow observer: occasionally reads what the current run's workers visibly
 * did and, rarely, keeps one short note for the user (see observer-prompt.js).
 *
 * What it never does: send anything to the flow or the secretary, start, steer
 * or stop a run, call tools, or wake the secretary. A failure here changes
 * nothing about the run.
 *
 * Scheduling (driven by its own timer, never awaited by the run monitor or RPC):
 * - only the DSH session's current run, while it is `running`; one more pass
 *   after it ended if it was already being observed (never older runs);
 * - only when observing is on for the session (default on);
 * - at most one check per run every `intervalMs`; no model call when the
 *   visible evidence is empty or unchanged, there is no model, or a note of
 *   that run is still open;
 * - at most `maxAttempts` model calls per run (failed ones count), recorded
 *   before the call so a restart does not repeat them;
 * - at most one check at a time for the whole host process, across observer
 *   instances (a plugin reload makes a new one): a host-wide gate is held from
 *   the start of a check until its model call has really settled. Aborting a
 *   call (timeout, turning off, a new run, unload) stops waiting for it but does
 *   not free the gate; a new check starts only after the old call returned;
 * - sessions take turns: the one checked longest ago goes first;
 * - a result for a run that is no longer current, or arriving after observing
 *   was turned off, is dropped.
 */
import { randomUUID } from 'node:crypto'
import { buildPrompt, parseReply } from './observer-prompt.js'

export const OBSERVER_DEFAULTS = Object.freeze({
  intervalMs: 30_000,
  maxAttempts: 6,
  timeoutMs: 45_000,
  maxTokens: 900,
  maxNotes: 10,
  maxRuns: 20,
  evidence: { maxItems: 40, maxChars: 16_000, itemChars: 1200 },
})

/**
 * The host-wide gate: one per process, shared by every FlowObserver instance
 * (`globalThis`, so a reloaded plugin module sees the same one).
 */
const GATE_KEY = Symbol.for('dsh-hmz-flow.observer.gate')
export function hostGate() {
  return (globalThis[GATE_KEY] ??= { owner: null, since: 0 })
}

const NOTE_ID = /^n-[a-f0-9-]{8,40}$/
export const isNoteId = (id) => typeof id === 'string' && NOTE_ID.test(id)

/** Concise, non-revealing status words for the UI. */
export function statusOf(error) {
  if (error?.code === 'timeout') return 'timeout'
  if (error?.code === 'cancelled') return 'cancelled'
  if (error?.code === 'no-model') return 'no-model'
  return 'error'
}

class ObserverError extends Error {
  constructor(code) { super(code); this.code = code }
}

export class FlowObserver {
  /**
   * @param {{
   *   store: import('./state.js').StateStore,
   *   adapter: {request(op: string, args: object): Promise<any>},
   *   generate: (req: {provider: string, model: string, system: string, prompt: string, maxTokens: number, signal: AbortSignal}) => Promise<string>,
   *   routeOf: (sessionId: string) => ({provider?: string, model?: string} | undefined),
   *   now?: () => number,
   *   options?: Partial<typeof OBSERVER_DEFAULTS>,
   *   logger?: any,
   * }} deps
   */
  constructor(deps) {
    this.deps = deps
    this.opt = { ...OBSERVER_DEFAULTS, ...(deps.options ?? {}) }
    this.now = deps.now ?? (() => Date.now())
    this.inflight = null // { sessionId, runId, abort: AbortController, done: Promise }
    this.disposed = false
    this.gate = deps.gate ?? hostGate()
  }

  // ------------------------------------------------------------- state
  entry(sessionId) {
    return this.deps.store.entry(sessionId)?.observer
  }

  enabled(sessionId) {
    return this.entry(sessionId)?.enabled !== false
  }

  setEnabled(sessionId, enabled) {
    if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean')
    this.deps.store.update(sessionId, (entry) => {
      entry.observer = { ...(entry.observer ?? {}), enabled }
    })
    if (!enabled && this.inflight?.sessionId === sessionId) this.inflight.abort.abort(new ObserverError('cancelled'))
    return { enabled }
  }

  runState(sessionId, runId) {
    const runs = this.entry(sessionId)?.runs
    return runs && Object.hasOwn(runs, runId) ? runs[runId] : undefined
  }

  /** Stage one change to a run's observer record (atomic, bounded). */
  updateRun(sessionId, runId, change) {
    return this.deps.store.update(sessionId, (entry) => {
      const observer = entry.observer ?? (entry.observer = {})
      if (!observer.runs) { observer.runs = Object.create(null); observer.order = [] }
      if (!Object.hasOwn(observer.runs, runId)) {
        observer.runs[runId] = { attempts: 0, checks: 0, lastCheckAt: 0, fingerprint: '', terminalDone: false, notes: [], status: null }
        observer.order = [...(observer.order ?? []), runId]
        while (observer.order.length > this.opt.maxRuns) delete observer.runs[observer.order.shift()]
      }
      const run = observer.runs[runId]
      const out = change(run)
      if (run.notes.length > this.opt.maxNotes) run.notes = run.notes.slice(-this.opt.maxNotes)
      return out
    })
  }

  /** What the UI shows for one run of the session (current run when runId is omitted). */
  view(sessionId, runId) {
    const binding = this.deps.store.binding(sessionId)
    const id = runId ?? binding?.requestId ?? null
    const rs = id ? this.runState(sessionId, id) : undefined
    return {
      enabled: this.enabled(sessionId),
      runId: id,
      current: !!id && id === binding?.requestId,
      phase: id ? (this.deps.store.run(sessionId, id)?.phase ?? null) : null,
      attempts: rs?.attempts ?? 0,
      maxAttempts: this.opt.maxAttempts,
      status: rs?.status ?? null,
      checking: !!this.inflight && this.inflight.sessionId === sessionId && this.inflight.runId === id,
      limited: (rs?.attempts ?? 0) >= this.opt.maxAttempts,
      notes: (rs?.notes ?? []).map((n) => ({ ...n })),
    }
  }

  /** The user marks a note known or dismissed. */
  act(sessionId, runId, noteId, action) {
    if (!isNoteId(noteId)) throw new Error('invalid note id')
    if (action !== 'known' && action !== 'dismissed') throw new Error('invalid action')
    if (!this.deps.store.run(sessionId, runId)) throw new Error('no such run in this DSH session')
    return this.updateRun(sessionId, runId, (run) => {
      const note = run.notes.find((n) => n.id === noteId)
      if (!note) throw new Error('no such note for this run')
      note.status = action
      note.handledAt = new Date(this.now()).toISOString()
      return { id: noteId, status: action }
    })
  }

  // ---------------------------------------------------------- scheduling
  /** Whether a model call for this session/run would still be wanted. */
  wanted(sessionId, runId, terminal) {
    if (this.disposed || !this.enabled(sessionId)) return false
    const binding = this.deps.store.binding(sessionId)
    if (!binding || binding.requestId !== runId) return false
    return terminal ? binding.phase === 'ended' : binding.phase === 'running'
  }

  /** One scheduling pass; starts at most one check and never waits for it. */
  tick() {
    if (this.disposed) return null
    if (this.inflight) {
      const { sessionId, runId, terminal } = this.inflight
      if (!this.wanted(sessionId, runId, terminal)) this.inflight.abort.abort(new ObserverError('cancelled'))
      return null
    }
    if (this.gate.owner) return null // another check (maybe of an older instance) has not settled
    const store = this.deps.store
    const due = []
    for (const sessionId of store.sessionsWithRuns()) {
      if (!this.enabled(sessionId)) continue
      const binding = store.binding(sessionId)
      if (!binding || !binding.requestId || !binding.epic || binding.incomplete) continue
      const runId = binding.requestId
      const rs = this.runState(sessionId, runId)
      let terminal = false
      if (binding.phase === 'ended') {
        if (!rs || rs.lastCheckAt === 0 || rs.terminalDone) continue
        terminal = true
      } else if (binding.phase !== 'running') continue
      if ((rs?.attempts ?? 0) >= this.opt.maxAttempts) continue
      if (rs?.notes?.some((n) => n.status === 'open')) continue
      if (!terminal && rs && this.now() - rs.lastCheckAt < this.opt.intervalMs) continue
      due.push({ sessionId, runId, binding, terminal, last: rs?.lastCheckAt ?? 0 })
    }
    if (!due.length) return null
    // Fair across sessions: the one checked longest ago (never checked first).
    due.sort((a, b) => a.last - b.last)
    const pick = due[0]
    return this.start(pick.sessionId, pick.runId, pick.binding, pick.terminal)
  }

  start(sessionId, runId, binding, terminal) {
    const token = {}
    this.gate.owner = token
    this.gate.since = this.now()
    const abort = new AbortController()
    const flight = { sessionId, runId, terminal, abort, done: null, generation: null }
    this.inflight = flight
    const release = () => { if (this.gate.owner === token) this.gate.owner = null }
    flight.done = this.check(sessionId, runId, binding, terminal, abort, flight)
      .catch((error) => {
        if (this.wanted(sessionId, runId, terminal) || terminal) {
          try { this.updateRun(sessionId, runId, (run) => { run.status = { kind: statusOf(error), at: new Date(this.now()).toISOString() } }) } catch {}
        }
        if (statusOf(error) === 'error') this.deps.logger?.warn?.('hmz-flow observer: check failed')
      })
      .finally(() => {
        if (this.inflight === flight) this.inflight = null
        // The gate is freed only once the model call itself has returned, even
        // when this check stopped waiting for it.
        if (flight.generation) flight.generation.then(release, release)
        else release()
      })
    return flight.done
  }

  async check(sessionId, runId, binding, terminal, abort, flight = {}) {
    const at = () => new Date(this.now()).toISOString()
    // The check happens now, whatever comes of it: the interval starts here.
    this.updateRun(sessionId, runId, (run) => { run.lastCheckAt = this.now(); if (terminal) run.terminalDone = true })
    const route = this.deps.routeOf(sessionId)
    if (!route?.provider || !route?.model) {
      this.updateRun(sessionId, runId, (run) => { run.status = { kind: 'no-model', at: at() } })
      return
    }
    const evidence = await this.deps.adapter.request('observe_evidence', { workspace: binding.workspace, epic: binding.epic, ...this.opt.evidence })
    if (abort.signal.aborted || !this.wanted(sessionId, runId, terminal)) return
    const rs = this.runState(sessionId, runId)
    if ((!evidence.items?.length && !evidence.instructions?.length) || evidence.fingerprint === rs?.fingerprint) {
      this.updateRun(sessionId, runId, (run) => { run.status = { kind: 'unchanged', at: at() } })
      return
    }
    const prior = (rs?.notes ?? []).map((n) => n.topic)
    const { system, user, refs } = buildPrompt(evidence, prior)
    // Counted before the call, so a restart never replays it.
    this.updateRun(sessionId, runId, (run) => { run.attempts += 1; run.checks += 1; run.fingerprint = evidence.fingerprint })
    const timer = setTimeout(() => abort.abort(new ObserverError('timeout')), this.opt.timeoutMs)
    let text
    try {
      const generation = Promise.resolve().then(() => this.deps.generate({ provider: route.provider, model: route.model, system, prompt: user, maxTokens: this.opt.maxTokens, signal: abort.signal }))
      flight.generation = generation
      // Stop waiting on abort; the gate stays held until `generation` settles.
      const aborted = new Promise((_, reject) => {
        if (abort.signal.aborted) reject(new Error('aborted'))
        abort.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
      text = await Promise.race([generation, aborted])
    } catch (error) {
      if (abort.signal.aborted) throw abort.signal.reason instanceof ObserverError ? abort.signal.reason : new ObserverError('cancelled')
      throw error
    } finally {
      clearTimeout(timer)
    }
    if (abort.signal.aborted || !this.wanted(sessionId, runId, terminal)) return
    const parsed = parseReply(text, refs, prior)
    this.updateRun(sessionId, runId, (run) => {
      if (parsed.note && !run.notes.some((n) => n.topic === parsed.note.topic)) {
        // Partial: older records left out, the task cut, or any excerpt cut (hmz's own logs may be partial too).
        const partial = !!evidence.omitted || !!evidence.instructionsOmitted || !!evidence.taskCut || !!evidence.cut
          || [...(evidence.items ?? []), ...(evidence.instructions ?? [])].some((one) => one.cut)
        run.notes.push({ id: `n-${randomUUID()}`, ...parsed.note, status: 'open', createdAt: at(), partial })
        run.status = { kind: 'noted', at: at() }
      } else {
        run.status = { kind: parsed.reason === 'silent' ? 'silent' : 'nothing', at: at() }
      }
    })
  }

  /**
   * Stop: abort any check and wait (bounded) for it to stop waiting. A model
   * call that ignores the abort keeps the host-wide gate until it returns, so
   * a replacement observer cannot start another call meanwhile.
   */
  async dispose() {
    this.disposed = true
    const flight = this.inflight
    if (!flight) return
    flight.abort.abort(new ObserverError('cancelled'))
    await Promise.race([flight.done, new Promise((r) => setTimeout(r, 5000).unref?.())])
  }
}

/**
 * One independent, tool-less model call: the text it streams, required to
 * finish normally. Tool calls, reasoning-only answers and other finishes fail.
 * @param {{stream(options: object): AsyncIterable<any>}} llm
 */
export async function streamText(llm, { provider, model, system, prompt, maxTokens, signal }) {
  let text = ''
  let finished = null
  for await (const chunk of llm.stream({ provider, model, system, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }], maxTokens, signal })) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'tool-call-delta') throw new ObserverError('error')
    else if (chunk.type === 'finish') finished = chunk.reason
  }
  if (!finished || finished.kind !== 'stop') throw new ObserverError(finished?.kind === 'aborted' ? 'cancelled' : 'error')
  return text
}
