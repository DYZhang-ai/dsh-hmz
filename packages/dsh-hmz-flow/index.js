/**
 * Host half of the DSH x hmz flow integration.
 *
 * - `/api/hmz-flow/rpc`: an exact Connection Fetch route; DSH applies its own
 *   owner authentication before this code runs. Used only by the Client plugin.
 * - A stdio Python adapter that talks to hmz through its public SDK.
 * - The Flow page's data: this DSH session's runs and, for one of them, its
 *   Epic -> Agent -> Session tree and transcripts, read through the hmz SDK and
 *   masked to the session (lib/runview.js). No hmz web service is involved.
 * - Leader tools: list / status / start / send / answer (asks the real user) / stop.
 * - Write protection of the session's agent tree while its run is active.
 */
import { realpathSync, existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AdapterClient, AdapterError } from './lib/adapter-client.js'
import { MaskError, RunView } from './lib/runview.js'
import { VIEWER_PATH, viewerHandler } from './lib/viewer-route.js'
import { StateStore, isValidSessionId } from './lib/state.js'
import { describeSelection, formatStatus, formatBinding } from './lib/present.js'
import { FlowController, FlowError, ACTIVE } from './lib/controller.js'
import { InFlight, flowModeCallReason, protectedCallReason, protectedRootOf } from './lib/policy.js'
import { validateOptions } from './lib/options.js'
import { composeTask, historySnapshot, USER_SOURCES } from './lib/history.js'
import { fallbackUserMessage, loadUserMessageFactory, noticeMessage } from './lib/message.js'

export const name = 'dsh-hmz-flow'
export const inject = ['tools', 'agents', 'connection', 'webServer', 'workingDirectory']

const HERE = dirname(fileURLToPath(import.meta.url))
const ROUTE = '/api/hmz-flow/rpc'

/**
 * Resolve the hmz installation's Python: explicit config, then the venv next
 * to an `hmz` launcher (`<root>/bin/hmz` -> `<root>/venv/bin/python`).
 */
export function resolvePython(config, env = process.env) {
  if (config.python) return config.python
  if (env.DSH_HMZ_PYTHON) return env.DSH_HMZ_PYTHON
  const launcher = config.hmzBin ?? env.DSH_HMZ_BIN
  if (launcher) {
    const candidate = resolve(dirname(launcher), '..', 'venv', 'bin', 'python')
    if (existsSync(candidate)) return candidate
  }
  throw new Error('dsh-hmz-flow: set config.python (or config.hmzBin / DSH_HMZ_PYTHON) to the hmz installation Python')
}

/** Read `http://127.0.0.1:PORT/?key=KEY` that `hmz web` printed, from a private file. */
class UserFacing extends Error {}

export function apply(ctx, rawConfig = {}) {
  const config = rawConfig ?? {}
  const logger = ctx.logger ? ctx.logger('hmz-flow') : console
  const stateDir = config.stateDir
    ?? (process.env.DSH_PROFILE_DIR ? join(process.env.DSH_PROFILE_DIR, 'hmz-flow-state') : join(homedir(), '.dsh-hmz-flow'))
  const store = new StateStore(stateDir)
  const adapter = new AdapterClient({
    python: resolvePython(config),
    script: join(HERE, 'adapter', 'hmz_adapter.py'),
    env: config.hmzEnv ?? {},
    timeoutMs: config.adapterTimeoutMs ?? 60000,
  })
  ctx.effect(() => () => adapter.close(), 'hmz-flow: adapter')

  // ------------------------------------------------------------- helpers
  function liveAgent(sessionId) {
    const agent = ctx.agents.get(sessionId)
    if (!agent) throw new UserFacing('This session is not live on the Host yet; send a message or reopen it first.')
    return agent
  }
  function workspaceOfSession(sessionId) {
    return realpathSync(ctx.workingDirectory.get(liveAgent(sessionId).session))
  }
  const isRoot = (agent) => ctx.agents.roots().some((one) => one.id === agent.id)

  // ------------------------------------------- protection + notifications
  const inflight = new InFlight()
  const presented = new Map() // sessionId -> disposer of presentAs('native')
  /**
   * A session with a selected flow, or a protected one, presents its tools
   * natively: the start and control tools must be called directly (a start from
   * inside a run_code program is refused, because that program could keep
   * writing), and run_code is denied while protected. Switching happens when
   * the flow is selected, i.e. before the turn that starts it.
   */
  function syncPresentation(sessionId) {
    let selected = false
    try { selected = !!store.selection(sessionId).flow } catch {}
    onProtect(sessionId, selected || controller.isProtected(sessionId))
  }
  function onProtect(sessionId, wanted) {
    let on = wanted
    if (!on) { try { on = !!store.selection(sessionId).flow } catch {} }
    const agent = ctx.agents.get(sessionId)
    if (on && agent && !presented.has(sessionId)) {
      try {
        // run_code is denied while protected; native presentation keeps the
        // allowed read/control tools reachable for a PTC-presented leader.
        presented.set(sessionId, agent.ctx.tools.presentAs('native'))
      } catch (error) {
        presented.set(sessionId, null)
        logger.warn('hmz-flow: could not present tools natively for %s: %s', sessionId, error.message)
      }
    } else if (!on && presented.has(sessionId)) {
      const dispose = presented.get(sessionId)
      presented.delete(sessionId)
      try { dispose?.() } catch {}
    }
  }
  // DSH's public message factory, resolved from the running installation.
  let createUserMessage = fallbackUserMessage
  const factoryLoaded = loadUserMessageFactory().then(({ create, from }) => {
    createUserMessage = create
    if (from === 'fallback') logger.warn('hmz-flow: @deepseek-ai/dsh-llm not resolvable; building notices with the same shape locally')
  })
  ctx.effect(() => () => factoryLoaded, 'hmz-flow: message factory')
  function notify(sessionId, text, summary) {
    const agent = ctx.agents.get(sessionId)
    if (!agent) return false
    try {
      agent.followup(noticeMessage(createUserMessage, text, summary))
      return true
    } catch (error) {
      logger.warn('hmz-flow: notice to %s failed: %s', sessionId, error.message)
      return false
    }
  }
  const controller = new FlowController({
    adapter, store, agents: ctx.agents, inflight,
    jobs: () => ctx.get('jobs'),
    workspaceOf: workspaceOfSession,
    notify, onProtect, logger,
  })

  const runView = new RunView({ store, adapter, lastObserved: (id) => controller.lastObserved(id) })

  // The native hmz viewer of the Flow page (static files only; data goes over postMessage).
  let staticDir = null
  const viewerStatic = () => (staticDir ??= adapter.request('ping').then((p) => {
    if (!p.static) throw new Error('hmz did not say where its web front end is')
    return p.static
  }).catch((error) => { staticDir = null; throw error }))
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: VIEWER_PATH, handler: viewerHandler({ staticDir: viewerStatic, logger }) }), 'hmz-flow: viewer route')

  /** Root sessions in flow mode (a flow is selected). */
  function flowModeIds() {
    const ids = []
    for (const root of ctx.agents.roots()) {
      try { if (store.selection(root.id).flow) ids.push(root.id) } catch {}
    }
    return ids
  }
  ctx.effect(() => ctx.tools.guard((exec) => {
    const ids = controller.protectedIds()
    if (ids.size && protectedRootOf(ctx.agents, exec.agent, ids)) return protectedCallReason(exec)
    // Flow mode without an active run (none started yet, or a start that was
    // refused): tasks belong to the flow, so the leader still may not write.
    const modes = flowModeIds()
    if (modes.length && protectedRootOf(ctx.agents, exec.agent, modes)) return flowModeCallReason(exec)
    return undefined
  }), 'hmz-flow: write guard')

  ctx.on('tools/execute', async (exec, next) => {
    inflight.add(exec.token, { agentId: exec.agent?.id, name: exec.name, rootCallId: exec.rootCallId })
    try { return await next() } finally { inflight.remove(exec.token) }
  })

  // Re-engage presentation for protected sessions as their agents come back.
  ctx.on('agent/created', ({ agent }) => {
    attachContext(agent)
    if (isRoot(agent)) {
      syncPresentation(agent.id)
      // A notice that could not be delivered while the session was closed.
      controller.deliverEnded(agent.id)
    }
  })
  ctx.on('agent/disposed', ({ agent }) => { presented.delete(agent.id); contexts.delete(agent.id) })

  ctx.effect(() => {
    let running = null
    const timer = setInterval(() => {
      if (!running) running = controller.tick().finally(() => { running = null })
    }, config.monitorMs ?? 4000)
    return async () => {
      clearInterval(timer)
      if (running) await Promise.race([running, new Promise((r) => setTimeout(r, 5000))])
    }
  }, 'hmz-flow: monitor')

  // ------------------------------------------------------------ Client RPC
  const sessionKnown = (id) => isValidSessionId(id) && (ctx.agents.get(id) !== undefined || store.entry(id) !== undefined)

  const ops = {
    flows: async ({ sessionId }) => adapter.request('flows', { workspace: workspaceOfSession(sessionId) }),
    flow: async ({ sessionId, name }) => adapter.request('flow', { workspace: workspaceOfSession(sessionId), name }),
    backends: async ({ sessionId }) => adapter.request('backends', { workspace: workspaceOfSession(sessionId) }),
    status: async ({ sessionId }) => adapter.request('status', { workspace: workspaceOfSession(sessionId) }),
    getSelection: async ({ sessionId }) => ({ ...store.selection(sessionId), binding: store.binding(sessionId) ?? null, protected: controller.isProtected(sessionId) }),
    setSelection: async ({ sessionId, selection }) => {
      liveAgent(sessionId)
      const saved = store.setSelection(sessionId, selection)
      syncPresentation(sessionId)
      return saved
    },
    getOptions: async ({ sessionId, flow }) => store.options(sessionId, flow) ?? null,
    setOptions: async ({ sessionId, flow, options }) => {
      liveAgent(sessionId)
      const { savedAt, ...rest } = options ?? {}
      return store.setOptions(sessionId, flow, validateOptions(rest))
    },
    binding: async ({ sessionId }) => {
      const observed = ACTIVE.has(store.binding(sessionId)?.phase) ? await controller.observe(sessionId).catch((e) => ({ error: e.message })) : null
      return { binding: store.binding(sessionId) ?? null, protected: controller.isProtected(sessionId), observed }
    },
    // User-only: the leader has no tool for this.
    releaseUnknown: async ({ sessionId }) => controller.releaseUnknown(sessionId),
    // The Stop flow button: names the exact run it was shown for.
    stopRun: async ({ sessionId, runId, identity }) => {
      const run = runView.resolve(sessionId, runId)
      if (!identity || typeof identity !== 'object') throw new MaskError('the run identity is required')
      const expect = controller.identityOf(run)
      for (const key of ['hostPid', 'hostStarted', 'run', 'epic']) {
        if (identity[key] !== expect[key]) throw new FlowError('the run shown has changed since the page drew it; refresh and try again; nothing was stopped')
      }
      const result = await controller.stop(sessionId, { expect })
      return { ...result, phase: store.binding(sessionId)?.phase }
    },
    // The Flow page, masked to this DSH session: no run -> empty, no hmz call.
    runs: async ({ sessionId }) => runView.list(sessionId),
    runTree: async ({ sessionId, runId }) => runView.tree(sessionId, runId),
    runSession: async ({ sessionId, runId, sessionKey, before }) => runView.session(sessionId, runId, sessionKey, before),
    // The native viewer's two reads, for one run of this session only.
    viewDetail: async ({ sessionId, runId }) => runView.native(sessionId, runId, 'web_detail'),
    viewTrace: async ({ sessionId, runId }) => runView.native(sessionId, runId, 'web_trace'),
    // DSH's own model catalog for a backend that runs DSH (hmz's static list can lag it).
    dshModels: async () => {
      const llm = ctx.get('llm')
      if (!llm || typeof llm.listModels !== 'function') return { provider: null, models: [] }
      const provider = config.dshProvider ?? 'deepseek-official'
      const models = await llm.listModels(provider)
      return { provider, models: models.map((m) => ({ id: m.id, name: m.name })) }
    },
  }

  ctx.effect(() => ctx.connection.fetch.register({
    path: ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      let body
      try { body = await request.json() } catch { return json({ ok: false, error: 'request body must be JSON' }, 400) }
      if (!body || typeof body.op !== 'string' || !Object.hasOwn(ops, body.op)) return json({ ok: false, error: 'unknown op' }, 404)
      if (!sessionKnown(body.sessionId)) return json({ ok: false, error: 'unknown session' }, 404)
      try {
        return json({ ok: true, result: await ops[body.op](body) })
      } catch (error) {
        if (error instanceof MaskError) return json({ ok: false, error: error.message, outcome: 'refused' }, 403)
        const outcome = error instanceof AdapterError || error instanceof FlowError ? error.outcome : 'refused'
        return json({ ok: false, error: error.message, outcome }, 200)
      }
    },
  }), 'hmz-flow: client route')

  // ---------------------------------------------------------- leader tools
  const text = (value) => [{ type: 'text', text: String(value) }]
  const toolOutput = { schema: { type: 'string' }, render: (_args, value) => text(value) }
  const noArgs = { type: 'object', properties: {}, additionalProperties: false }
  const rootAgent = (exec, tool) => {
    const agent = exec.agent
    if (!agent) throw new Error(`${tool} needs a calling agent`)
    if (!isRoot(agent)) throw new Error(`${tool} is only available to the DSH session's own agent (the leader), not a subagent`)
    return agent
  }
  const failText = (error) => (error.accepted
    ? `ACCEPTED BY HMZ BUT NOT RECORDED: ${error.message}`
    : error.outcome === 'unknown' ? `OUTCOME UNKNOWN: ${error.message}` : `REFUSED: ${error.message}`)
  function register(definition) {
    ctx.effect(() => ctx.tools.register({ isConcurrencySafe: () => false, output: toolOutput, ...definition }), `hmz-flow: ${definition.name}`)
  }

  register({
    name: 'hmz_flow_list',
    description: 'List the hmz flows available in this session\'s working directory, and which one the user selected in the DSH composer. Read-only.',
    parameters: noArgs,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('hmz_flow_list needs a calling agent')
      const listed = await adapter.request('flows', { workspace: realpathSync(ctx.workingDirectory.get(agent.session)) })
      const selection = store.selection(rootIdOf(agent))
      const lines = listed.flows.map((one) => `- ${one.name}${one.name === selection.flow ? ' (selected)' : ''}: ${one.about}`)
      return [`hmz flows in ${listed.workspace}:`, ...lines, '', describeSelection(selection)].join('\n')
    },
  })

  register({
    name: 'hmz_flow_status',
    description: 'Read the hmz run bound to this DSH session (if any) and what hmz says about the working directory: state, run, epic, roles and the agent filling each, sessions, queued messages and questions waiting for a human. Read-only; never starts, steers or stops anything.',
    parameters: noArgs,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('hmz_flow_status needs a calling agent')
      const id = rootIdOf(agent)
      let observed = null
      if (ACTIVE.has(store.binding(id)?.phase)) observed = await controller.observe(id).catch((error) => ({ error: error.message }))
      const status = await adapter.request('status', { workspace: realpathSync(ctx.workingDirectory.get(agent.session)) })
      return [formatBinding(store.binding(id), observed, controller.isProtected(id)), '', formatStatus(status, store.selection(id))].join('\n')
    },
  })

  register({
    name: 'hmz_flow_start',
    description: 'Start the hmz flow selected in the DSH composer (flow选项) with the options saved there. A task the user sends in flow mode is started automatically; use this only when the user explicitly asks to retry a start that failed. Never for a progress question or because of an hmz notice. While the run is active the flow edits code and this session can only read, talk to the flow (hmz_flow_send) and stop it.',
    parameters: {
      type: 'object',
      properties: { task: { type: 'string', description: 'The task for the flow, in the user\'s terms; complete and self-contained.' } },
      required: ['task'],
      additionalProperties: false,
    },
    async execute(args, exec) {
      const agent = rootAgent(exec, 'hmz_flow_start')
      if (exec.parent !== undefined) {
        return 'REFUSED: hmz_flow_start was called from inside a run_code program, which could keep changing files after the flow starts. Call hmz_flow_start directly as a tool; nothing was started.'
      }
      const task = typeof args?.task === 'string' ? args.task.trim() : ''
      if (!task) return 'REFUSED: task is required'
      try {
        return startedText(await startFlow(agent, task, { exceptToken: exec.token }))
      } catch (error) {
        return failText(error)
      }
    },
  })

  register({
    name: 'hmz_flow_send',
    description: 'Send a message to one agent of the bound hmz run: name the role (e.g. "reviewer") or the agent id from hmz_flow_status, exactly one. hmz queues it for that agent\'s current or next turn; accepted means queued, not acted on.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        role: { type: 'string', description: 'Flow role, e.g. actor or reviewer' },
        agent: { type: 'string', description: 'Agent id as hmz_flow_status lists it' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    async execute(args, exec) {
      const agent = rootAgent(exec, 'hmz_flow_send')
      try {
        const result = await controller.send(agent.id, { text: String(args?.text ?? ''), role: args?.role || '', agent: args?.agent || '' })
        return `ACCEPTED by hmz for ${result.role || result.to} (${result.to}) on run #${result.run}; ${result.targetWorking ? 'its turn is open, hmz hands it over when the agent can take it' : 'it waits for that agent\'s next turn'}. Accepted is not delivered or acted on.`
      } catch (error) {
        return failText(error)
      }
    },
  })

  register({
    name: 'hmz_flow_answer',
    description: 'Show one hmz question (by question id from a notice or hmz_flow_status) to the user in DSH and send their reply to the bound run. You never write the answer: the user does.',
    parameters: {
      type: 'object',
      properties: { question_id: { type: 'string' } },
      required: ['question_id'],
      additionalProperties: false,
    },
    async execute(args, exec) {
      const agent = rootAgent(exec, 'hmz_flow_answer')
      const questionId = String(args?.question_id ?? '')
      const binding = store.binding(agent.id)
      if (!binding || binding.phase !== 'running' || binding.incomplete) return 'REFUSED: no fully identified running hmz run is bound to this session'
      // The exact run this question is shown for; the reply is only ever sent to it.
      const identity = controller.identityOf(binding)
      const questions = ctx.get('userQuestions')
      if (!questions) return 'REFUSED: this DSH has no user-question service to ask the user'
      let status
      try { status = await adapter.request('status', { workspace: binding.workspace }) } catch (error) { return failText(error) }
      if (!status.complete || status.hostPid !== identity.hostPid || status.hostStarted !== identity.hostStarted || status.run !== identity.run || (status.epic && status.epic !== identity.epic)) {
        return `REFUSED: hmz does not currently show the bound run #${identity.run} on its host (${status.incompleteWhy || 'another run or host'}); nothing asked`
      }
      const q = (status.pending ?? []).find((one) => one.question === questionId && one.run === identity.run)
      if (!q) return `REFUSED: question ${questionId} is not waiting on the bound run #${identity.run}`
      let reply
      try {
        const answer = await questions.ask({
          agent,
          signal: exec.signal,
          questions: [{
            id: questionId,
            header: `hmz run #${identity.run} · ${q.role}`,
            question: q.text,
            ...(Array.isArray(q.options) && q.options.length ? { options: q.options.map((label) => ({ label: String(label) })) } : {}),
          }],
        })
        const item = answer.answers.find((one) => one.id === questionId)
        reply = (item?.custom?.trim()) || (item?.selected ?? []).join(', ')
      } catch (error) {
        return `REFUSED: the user did not answer (${error.message}); nothing sent`
      }
      if (!reply) return 'REFUSED: the user gave no answer; nothing sent'
      try {
        await controller.answer(agent.id, { question: questionId, text: reply, expect: identity })
        return `ACCEPTED: the user's reply to ${questionId} was sent to hmz run #${identity.run}.`
      } catch (error) {
        return failText(error)
      }
    },
  })

  register({
    name: 'hmz_flow_stop',
    description: 'Ask hmz to stop the run bound to this session. Use only when the user asks to stop the flow (cancelling your own reply does not stop it). Stop accepted is not the end: protection stays until the run is verified ended.',
    parameters: noArgs,
    async execute(_args, exec) {
      const agent = rootAgent(exec, 'hmz_flow_stop')
      try {
        const result = await controller.stop(agent.id)
        return result.already ? 'The bound run is already stopping.' : 'STOP ACCEPTED by hmz. The run is unwinding; protection stays on until hmz_flow_status shows it ended.'
      } catch (error) {
        return failText(error)
      }
    },
  })

  /**
   * The one way a flow starts, for the leader tool and for the automatic start
   * of a user's task: the selected flow, its saved options (frozen), the
   * optional visible-history background, and the controller's fenced start.
   */
  async function startFlow(agent, task, { exceptToken, excludeIds, signal } = {}) {
    const selection = store.selection(agent.id)
    if (!selection.flow) throw new FlowError('no hmz flow is selected in the composer; pick one under ＋ or / → Flow')
    const workspace = workspaceOfSession(agent.id)
    const declared = await adapter.request('flow', { workspace, name: selection.flow })
    if (signal?.aborted) throw new FlowError('not started: the request was cancelled before it was sent')
    const saved = store.options(agent.id, selection.flow)
    return controller.start(agent.id, {
      task, flow: selection.flow, declared,
      saved: saved ? validateOptions(saved) : undefined,
      exceptToken,
      signal,
      composeTask: (t) => {
        const snapshot = selection.includeHistory ? historySnapshot(agent.session.snapshotEvents(), { excludeIds }) : null
        return { task: composeTask(t, snapshot), history: snapshot }
      },
    })
  }

  function startedText({ binding, history }) {
    const roles = Object.entries(binding.names ?? {}).map(([role, who]) => `${role} → ${who}`).join(', ')
    return [
      `STARTED hmz run #${binding.run} of ${binding.flow} (epic ${binding.epicName || 'pending'}), host pid ${binding.hostPid}.`,
      `Roles: ${roles || 'none'}.`,
      history ? `Background attached: ${history.included}/${history.total} visible messages${history.truncated ? ' (truncated)' : ''}, up to ${history.cutoff}.` : 'No conversation background attached (附带前文 is OFF).',
      'Write protection is ON for this session until the run is verified ended. Use hmz_flow_status for progress.',
    ].join('\n')
  }

  // ------------------------------------------------ automatic start of a task
  // With a flow selected and no run of this session active, a task the user
  // sends goes into the flow: the start happens before the leader's step, not
  // by the leader's choice. Only messages a person typed count (`user`,
  // `user-rpc`); notices, contexts, question replies and other producers never
  // start a flow. Each message id starts at most once (persisted first).
  const autoStartable = (message) => message?.role === 'user' && USER_SOURCES.has(message.source?.kind)
    && typeof message.id === 'string' && message.content?.some?.((b) => b?.type === 'text' && b.text?.trim())
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (!decision || decision.kind !== 'enter') return decision
    const agent = payload.agent
    if (!agent || !isRoot(agent)) return decision
    let selection
    try { selection = store.selection(agent.id) } catch { return decision }
    if (!selection.flow) return decision
    const current = store.binding(agent.id)
    if (current && ACTIVE.has(current.phase)) return decision // a running flow: the leader relays messages
    if (payload.signal?.aborted) return decision
    const candidates = decision.messages.filter(autoStartable)
    if (!candidates.length) return decision
    // Only messages not seen before form the task; each id is claimed (persisted)
    // before anything is sent, so a replay, retry or later step never repeats it.
    let tasks = []
    try {
      tasks = store.update(agent.id, (entry) => {
        const seen = new Set(entry.autoStarted ?? [])
        const fresh = candidates.filter((m) => !seen.has(m.id))
        if (fresh.length) entry.autoStarted = [...(entry.autoStarted ?? []), ...fresh.map((m) => m.id)].slice(-200)
        return fresh
      })
    } catch (error) {
      logger.warn('hmz-flow: could not record the automatic start: %s', error.message)
      return { ...decision, messages: [...decision.messages, noticeMessage(createUserMessage,
        `[hmz flow notice — not a user message] The selected flow ${selection.flow} was NOT started for the message above: its start could not be recorded (${error.message}). Tell the user; do not do the task yourself while flow mode is on.`,
        'hmz flow not started')] }
    }
    if (!tasks.length) return decision
    const ids = tasks.map((m) => m.id)
    const task = tasks.map((m) => m.content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')).join('\n\n').trim()
    let text
    let summary
    try {
      const started = await startFlow(agent, task, { excludeIds: ids, signal: payload.signal })
      try { store.update(agent.id, (entry) => { entry.lastAutoStart = { at: new Date().toISOString(), ok: true, runId: started.binding.requestId } }) } catch {}
      text = `[hmz flow notice — not a user message] Flow mode is on: the user's message above was started as hmz ${startedText(started).replace(/^STARTED /, '')}\nThe flow does the task. Do not do it yourself: tell the user briefly that ${selection.flow} is running it and that progress is visible in the Flow tab.`
      summary = `hmz run #${started.binding.run} started`
    } catch (error) {
      if (payload.signal?.aborted && !error.accepted && error.outcome !== 'unknown') {
        // Cancelled before anything was sent: the messages may start a flow later.
        try { store.update(agent.id, (entry) => { entry.autoStarted = (entry.autoStarted ?? []).filter((id) => !ids.includes(id)) }) } catch {}
        return decision
      }
      const outcome = error.accepted ? 'accepted by hmz but not recorded' : error.outcome === 'unknown' ? 'outcome unknown' : 'not started'
      text = `[hmz flow notice — not a user message] Flow mode is on (${selection.flow}), but the task above was ${outcome}: ${error.message}\nDo not do the task yourself (write tools stay blocked in flow mode). Tell the user what happened; they can fix the flow options and ask you to retry with hmz_flow_start, or leave flow mode.`
      summary = `hmz flow ${outcome}`
      try { store.update(agent.id, (entry) => { entry.lastAutoStart = { at: new Date().toISOString(), ok: false, outcome, error: error.message } }) } catch {}
    }
    return { ...decision, messages: [...decision.messages, noticeMessage(createUserMessage, text, summary)] }
  })

  function rootIdOf(agent) {
    for (const root of ctx.agents.roots()) {
      if (root.id === agent.id || ctx.agents.isOwnedBy(agent.id, root)) return root.id
    }
    return agent.id
  }

  // ---------------------------------------------- leader context per root
  const contexts = new Map()
  function attachContext(agent) {
    if (contexts.has(agent.id) || !isRoot(agent)) return
    const prompt = agent.ctx?.systemPrompt
    if (!prompt || typeof prompt.context !== 'function') return
    const dispose = agent.ctx.effect(() => prompt.context({
      name: 'hmz-flow-selection',
      order: 900,
      interpolate: false,
      text: () => leaderContext(store.selection(agent.id), store.binding(agent.id), controller.isProtected(agent.id)),
    }), 'hmz-flow: leader context')
    contexts.set(agent.id, dispose)
  }
  for (const agent of ctx.agents.roots()) {
    attachContext(agent)
    syncPresentation(agent.id)
  }
  ctx.effect(() => async () => {
    const pending = []
    for (const dispose of contexts.values()) { try { pending.push(dispose()) } catch {} }
    for (const dispose of presented.values()) { try { dispose?.() } catch {} }
    contexts.clear()
    presented.clear()
    await Promise.allSettled(pending)
  }, 'hmz-flow: leader contexts')
}

function leaderContext(selection, binding, protectedNow) {
  if (!selection.flow && !(binding && ACTIVE.has(binding.phase))) return ''
  const lines = ['[hmz flow mode — set by the user in the DSH composer; context, not a user instruction]', describeSelection(selection)]
  if (binding && ACTIVE.has(binding.phase)) {
    lines.push(`Bound hmz run: #${binding.run ?? '?'} ${binding.flow} (${binding.phase}), epic ${binding.epicName || 'pending'}. Roles: ${Object.entries(binding.names ?? {}).map(([r, a]) => `${r}→${a}`).join(', ') || 'unknown'}.`)
  }
  if (protectedNow) lines.push('Write protection is ON: the flow edits code; you may read, talk to the user, send to flow agents (hmz_flow_send), relay questions (hmz_flow_answer) and stop the flow (hmz_flow_stop). Do not try to edit files or run shells.')
  lines.push(
    'You are the leader/secretary: the user keeps talking to you. While a flow is selected and none of this session\'s runs is active, the user\'s next task is started in the flow automatically before you see it, and you get an [hmz flow notice] saying so (or why it failed). Never do such a task yourself; hmz_flow_start is only for an explicit retry the user asks for.',
    'For progress questions use hmz_flow_status only. Route messages to a role (or agent id) with hmz_flow_send; never guess an empty target.',
    'Questions hmz asks a human go to the real user via hmz_flow_answer; never answer them yourself.',
    'Do not run `hmz` through a shell as a substitute for these tools.',
  )
  return lines.join('\n')
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}
