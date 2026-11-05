/**
 * Per-DSH-session control of the one hmz run that session started.
 *
 * - Commands of one session run one at a time (a promise chain).
 * - A start is fenced: write protection engages synchronously, then existing
 *   work of the session's agent tree is checked (running subagents, running
 *   or stopping background jobs, live non-read-only tool bodies). Anything
 *   busy refuses the start; nothing is killed.
 * - The start intent (request id, workspace, flow) is persisted before hmz is
 *   asked. A start whose answer is lost becomes `unknown`: protection stays,
 *   the request is never re-sent, and only a read-only lookup by request id
 *   may bind it later.
 * - The binding is the exact run: host pid + host start time + run number +
 *   epic. Every action names it; the adapter re-checks it on the link it acts
 *   through (hmz itself has no expected-run precondition, so this narrows but
 *   does not close the race against other hmz frontends).
 * - Stop accepted is not ended. Protection is released only when the run is
 *   verified ended (host no longer holds it AND its epic record is not going).
 * - Notifications (a question for a human, the run ending) are delivered to
 *   the leader once and remembered in the binding.
 */
import { randomUUID } from 'node:crypto'
import { agentTree } from './policy.js'
import { startArguments } from './options.js'

export const ACTIVE = Object.freeze(new Set(['starting', 'running', 'stopping', 'unknown']))

export class FlowError extends Error {
  /**
   * @param {string} message
   * @param {'refused'|'unknown'} outcome
   * @param {{accepted?: boolean}} [extra] accepted: hmz accepted the action but
   *   recording it locally failed; the outcome of the whole step is unknown.
   */
  constructor(message, outcome = 'refused', extra = {}) {
    super(message)
    this.outcome = outcome
    this.accepted = extra.accepted === true
  }
}

export class FlowController {
  /**
   * @param {{
   *   adapter: {request(op: string, args?: object, opts?: object): Promise<any>},
   *   store: import('./state.js').StateStore,
   *   agents: {get(id: string): any, list(): any[], isOwnedBy(id: string, owner: any): boolean},
   *   jobs?: () => ({list(caller?: string): any[]} | undefined),
   *   inflight: import('./policy.js').InFlight,
   *   workspaceOf: (sessionId: string) => string,
   *   notify: (sessionId: string, text: string, summary: string) => boolean,
   *   onProtect?: (sessionId: string, on: boolean) => void,
   *   logger?: {warn: Function, info?: Function},
   * }} deps
   */
  constructor(deps) {
    this.deps = deps
    this.fencing = new Set()
    this.chains = new Map()
    this.ticking = false
    // A start that was in flight when the Host went away has an unknown outcome.
    for (const id of deps.store.boundSessions()) {
      const binding = deps.store.binding(id)
      if (binding?.phase === 'starting') {
        try { deps.store.setBinding(id, { ...binding, phase: 'unknown', unknownWhy: 'the Host restarted before the start was answered' }) } catch {}
      }
    }
  }

  // ------------------------------------------------------------ protection
  protectedIds() {
    const ids = new Set(this.fencing)
    for (const id of this.deps.store.boundSessions()) {
      if (ACTIVE.has(this.deps.store.binding(id)?.phase)) ids.add(id)
    }
    return ids
  }

  isProtected(sessionId) {
    return this.protectedIds().has(sessionId)
  }

  refreshProtection(sessionId) {
    this.deps.onProtect?.(sessionId, this.isProtected(sessionId))
  }

  /** Run `fn` after every earlier command of this session settled. */
  serial(sessionId, fn) {
    const previous = this.chains.get(sessionId) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(fn)
    const tail = next.catch(() => {})
    this.chains.set(sessionId, tail)
    tail.then(() => { if (this.chains.get(sessionId) === tail) this.chains.delete(sessionId) })
    return next
  }

  expectOf(binding) {
    return { hostPid: binding.hostPid, hostStarted: binding.hostStarted, run: binding.run, epic: binding.epic }
  }

  /** The full identity of a bound run, for comparisons across an await. */
  identityOf(binding) {
    return binding ? {
      requestId: binding.requestId, hostPid: binding.hostPid, hostStarted: binding.hostStarted, run: binding.run, epic: binding.epic,
    } : null
  }

  sameRun(a, b) {
    return !!a && !!b && ['requestId', 'hostPid', 'hostStarted', 'run', 'epic'].every((k) => a[k] === b[k])
  }

  saveBinding(sessionId, binding) {
    this.deps.store.setBinding(sessionId, binding)
    this.refreshProtection(sessionId)
  }

  /** Work of the session's agent tree that is still going, other than `exceptRoot`. */
  quiescence(sessionId, exceptToken) {
    const { agents, jobs, inflight } = this.deps
    const root = agents.get(sessionId)
    if (!root) return ['the session has no live agent']
    const tree = agentTree(agents, root)
    const busy = []
    for (const agent of tree.values()) {
      if (agent.id !== sessionId && agent.status === 'running') busy.push(`subagent ${agent.id} is running`)
    }
    const registry = jobs?.()
    if (registry) {
      for (const id of tree.keys()) {
        let listed = []
        try { listed = registry.list(id) } catch {}
        for (const job of listed) {
          if (job.owner === id && (job.status === 'running' || job.status === 'stopping')) {
            busy.push(`background job ${job.id} (${job.label}) is ${job.status}`)
          }
        }
      }
    }
    for (const call of inflight.busy(new Set(tree.keys()), exceptToken)) {
      busy.push(call.name === 'run_code'
        ? 'a run_code program is still running (call hmz_flow_start directly, not from inside run_code)'
        : `tool ${call.name} is still running`)
    }
    return busy
  }

  // ----------------------------------------------------------------- start
  /**
   * @param {string} sessionId
   * @param {{task: string, flow: string, declared: any, saved: any, composeTask: (task: string) => {task: string, history: any}, exceptToken?: unknown}} request
   */
  start(sessionId, request) {
    return this.serial(sessionId, async () => {
      const { store, adapter } = this.deps
      const current = store.binding(sessionId)
      if (current && ACTIVE.has(current.phase)) {
        throw new FlowError(`this session already has hmz run #${current.run ?? '?'} (${current.phase}); check it with hmz_flow_status or stop it first`)
      }
      const built = startArguments(request.declared, request.saved)
      if (!built.ok) throw new FlowError(`not started: ${built.problems.join('; ')}`)
      const workspace = this.deps.workspaceOf(sessionId)
      this.fencing.add(sessionId)
      this.refreshProtection(sessionId)
      let persisted = false
      try {
        const busy = this.quiescence(sessionId, request.exceptToken)
        if (busy.length) {
          throw new FlowError(`not started: earlier work of this session is still running (${busy.join('; ')}). Let it finish or stop it yourself, then ask again; nothing was killed.`)
        }
        const { task, history } = request.composeTask(request.task)
        const requestId = randomUUID()
        const intent = {
          phase: 'starting', requestId, workspace, flow: built.args.flow, requestedAt: new Date().toISOString(),
          frozen: { agents: built.args.agents, budget: built.args.budget, params: built.args.params },
          history: history ? { included: history.included, total: history.total, truncated: history.truncated, cutoff: history.cutoff } : null,
          notified: { questions: [], ended: false },
        }
        this.saveBinding(sessionId, intent)
        persisted = true
        let answer
        try {
          answer = await adapter.request('start', { workspace, requestId, task, ...built.args }, { timeoutMs: 200_000 })
        } catch (error) {
          if (error.outcome === 'refused' || error.outcome === 'not-sent') {
            this.saveBinding(sessionId, null)
            throw new FlowError(`hmz did not start the flow: ${error.message}`)
          }
          this.saveBinding(sessionId, { ...intent, phase: 'unknown', unknownWhy: error.message, unknownSince: new Date().toISOString() })
          throw new FlowError(`the start's outcome is unknown (${error.message}). It was NOT re-sent. Write protection stays on; hmz_flow_status checks whether hmz started it.`, 'unknown')
        }
        const accepted = {
          ...intent, ...answer.binding, phase: 'running', startedAt: new Date().toISOString(),
          // Accepted, but hmz did not show this exact run yet: only its host and run
          // number are known; epic/roles are filled in by a lookup by request id.
          incomplete: answer.bindingComplete === false,
          incompleteWhy: answer.bindingComplete === false ? answer.incompleteWhy : undefined,
        }
        try {
          this.saveBinding(sessionId, accepted)
        } catch (error) {
          // hmz started it; only our record failed. The persisted `starting` intent
          // keeps protection on and becomes `unknown` on restart, where a lookup by
          // request id binds it. Nothing is re-sent.
          throw new FlowError(
            `hmz accepted the start (run #${accepted.run}${accepted.epicName ? `, epic ${accepted.epicName}` : ''}) but recording it locally failed (${error.message}). It was NOT re-sent; write protection stays on; check hmz_flow_status.`,
            'unknown', { accepted: true })
        }
        return { binding: accepted, history }
      } finally {
        this.fencing.delete(sessionId)
        this.refreshProtection(sessionId)
        if (!persisted) this.refreshProtection(sessionId)
      }
    })
  }

  // --------------------------------------------------------------- actions
  activeBinding(sessionId, allowed = ['running']) {
    const binding = this.deps.store.binding(sessionId)
    if (!binding || !ACTIVE.has(binding.phase)) throw new FlowError('this DSH session has no bound hmz run; start one with hmz_flow_start')
    if (!allowed.includes(binding.phase)) throw new FlowError(`the bound hmz run is ${binding.phase}; ${binding.phase === 'unknown' ? 'check hmz_flow_status first' : 'nothing sent'}`)
    return binding
  }

  send(sessionId, { role, agent, text }) {
    return this.serial(sessionId, async () => {
      const binding = this.activeBinding(sessionId)
      if (!!role === !!agent) throw new FlowError('name exactly one of role or agent; an empty target is never sent')
      if (binding.incomplete) throw new FlowError('hmz has not yet shown the bound run\'s roles; check hmz_flow_status first; nothing sent')
      try {
        return await this.deps.adapter.request('say', { workspace: binding.workspace, expect: this.expectOf(binding), text, ...(role ? { role } : { agent }) })
      } catch (error) {
        throw new FlowError(error.outcome === 'unknown'
          ? `the message's outcome is unknown (${error.message}); it was NOT re-sent`
          : `not sent: ${error.message}`, error.outcome)
      }
    })
  }

  /**
   * @param {string} sessionId
   * @param {{question: string, text: string, expect: object}} request `expect` is
   *   the identity of the run the question was shown for; a reply for any other
   *   run (finished, replaced, new host) is refused.
   */
  answer(sessionId, { question, text, expect }) {
    return this.serial(sessionId, async () => {
      const binding = this.activeBinding(sessionId)
      if (!this.sameRun(this.identityOf(binding), expect)) {
        throw new FlowError(`the question was shown for run #${expect?.run ?? '?'}, but the bound run is now #${binding.run ?? '?'} (or another host); the reply was NOT sent`)
      }
      if (binding.incomplete) throw new FlowError('the bound run is not fully identified yet; nothing sent')
      try {
        return await this.deps.adapter.request('answer', { workspace: binding.workspace, expect: this.expectOf(binding), question, text })
      } catch (error) {
        throw new FlowError(error.outcome === 'unknown'
          ? `the answer's outcome is unknown (${error.message}); it was NOT re-sent`
          : `not sent: ${error.message}`, error.outcome)
      }
    })
  }

  stop(sessionId) {
    return this.serial(sessionId, async () => {
      const binding = this.activeBinding(sessionId, ['running', 'stopping'])
      if (binding.phase === 'stopping') return { accepted: true, already: 'stopping' }
      try {
        const result = await this.deps.adapter.request('stop', { workspace: binding.workspace, expect: this.expectOf(binding) })
        try {
          this.saveBinding(sessionId, { ...binding, phase: 'stopping', stopRequestedAt: new Date().toISOString() })
        } catch (error) {
          throw new FlowError(`hmz accepted the stop of run #${binding.run} but recording it locally failed (${error.message}). It was NOT re-sent; protection stays on until the end is verified.`, 'unknown', { accepted: true })
        }
        return result
      } catch (error) {
        if (error instanceof FlowError) throw error
        if (error.outcome === 'unknown') {
          this.saveBinding(sessionId, { ...binding, stopUnknown: error.message })
          throw new FlowError(`the stop's outcome is unknown (${error.message}); it was NOT re-sent; protection stays on`, 'unknown')
        }
        throw new FlowError(`not stopped: ${error.message}`)
      }
    })
  }

  /** User-only: drop protection of a start whose outcome stayed unknown. */
  releaseUnknown(sessionId) {
    return this.serial(sessionId, async () => {
      const binding = this.deps.store.binding(sessionId)
      if (!binding || binding.phase !== 'unknown') throw new FlowError('only a start whose outcome is unknown can be released by hand')
      this.saveBinding(sessionId, { ...binding, phase: 'released', releasedAt: new Date().toISOString() })
      return { released: true }
    })
  }

  // ------------------------------------------------------------ observing
  /** One observation of a session's binding; updates phase and notifies. */
  observe(sessionId) {
    return this.serial(sessionId, () => this.observeNow(sessionId))
  }

  async observeNow(sessionId) {
    const { store, adapter } = this.deps
    let binding = store.binding(sessionId)
    if (binding?.phase === 'ended') {
      this.deliverEnded(sessionId)
      return { binding: store.binding(sessionId) }
    }
    if (!binding || !ACTIVE.has(binding.phase)) return { binding }
    if (binding.phase === 'unknown' || binding.phase === 'starting' || binding.incomplete) {
      const found = await adapter.request('find_request', {
        workspace: binding.workspace, requestId: binding.requestId, ...(binding.incomplete ? { run: binding.run } : {}),
      })
      if (!found.found) return { binding, lookup: found }
      if (binding.incomplete && (found.binding.hostPid !== binding.hostPid || found.binding.hostStarted !== binding.hostStarted)) {
        return { binding, lookup: { found: false, why: 'the run found is on another host' } }
      }
      binding = { ...binding, ...found.binding, phase: binding.phase === 'stopping' ? 'stopping' : 'running', incomplete: false, incompleteWhy: undefined, reconciledAt: new Date().toISOString() }
      this.saveBinding(sessionId, binding)
    }
    if (!binding.epic) return { binding, observation: { verdict: 'unverified', why: 'the bound run has no epic yet' } }
    const observation = await adapter.request('observe', { workspace: binding.workspace, expect: this.expectOf(binding) })
    if (observation.verdict === 'ended') {
      const ended = { ...binding, phase: 'ended', endedHow: observation.how, endedAt: new Date().toISOString() }
      this.saveBinding(sessionId, ended)
      this.deliverEnded(sessionId)
      return { binding: store.binding(sessionId), observation }
    }
    if (observation.verdict === 'stopping' && binding.phase !== 'stopping') {
      binding = { ...binding, phase: 'stopping' }
      this.saveBinding(sessionId, binding)
    }
    if (observation.verdict === 'running' || observation.verdict === 'stopping') {
      const asked = (observation.view?.pending ?? []).filter((q) => q.run === binding.run)
      const told = new Set(binding.notified?.questions ?? [])
      for (const q of asked) {
        if (told.has(q.question)) continue
        const options = Array.isArray(q.options) && q.options.length ? ` Options: ${q.options.join(' | ')}.` : ''
        const delivered = this.deps.notify(sessionId,
          `[hmz flow notice — not a user message] hmz run #${binding.run} (${q.role}) is waiting for the user: "${q.text}".${options} Question id ${q.question}. ` +
          `Show it to the user by calling hmz_flow_answer with question_id "${q.question}" — that tool asks the user directly and sends only their reply. Never answer it yourself.`,
          `hmz question ${q.question} from ${q.role}`)
        if (delivered) told.add(q.question)
      }
      if (told.size !== (binding.notified?.questions ?? []).length) {
        binding = { ...binding, notified: { ...(binding.notified ?? {}), questions: [...told] } }
        this.saveBinding(sessionId, binding)
      }
    }
    return { binding: store.binding(sessionId), observation }
  }

  /**
   * Deliver a pending end-of-run notice (once). The phase is already `ended`;
   * delivery is retried on every tick and whenever the session's agent comes
   * back, until the leader actually received it.
   */
  deliverEnded(sessionId) {
    const binding = this.deps.store.binding(sessionId)
    if (!binding || binding.phase !== 'ended' || binding.notified?.ended) return false
    const delivered = this.deps.notify(sessionId,
      `[hmz flow notice — not a user message] hmz run #${binding.run} (${binding.flow}, epic ${binding.epicName}) has ended: ${binding.endedHow}. Write protection for this session is released. Tell the user briefly; do not start another flow unless they ask.`,
      `hmz run #${binding.run} ended: ${binding.endedHow}`)
    if (!delivered) return false
    try { this.saveBinding(sessionId, { ...binding, notified: { ...(binding.notified ?? {}), ended: true } }) } catch {}
    return true
  }

  /** Observe every protected session once; overlapping ticks are skipped. */
  async tick() {
    if (this.ticking) return
    this.ticking = true
    try {
      for (const id of this.deps.store.boundSessions()) {
        const binding = this.deps.store.binding(id)
        if (binding?.phase === 'ended' && !binding.notified?.ended) { this.deliverEnded(id); continue }
        if (!ACTIVE.has(binding?.phase)) continue
        try { await this.observe(id) } catch (error) { this.deps.logger?.warn?.('hmz-flow observe %s failed: %s', id, error.message) }
      }
    } finally {
      this.ticking = false
    }
  }
}
