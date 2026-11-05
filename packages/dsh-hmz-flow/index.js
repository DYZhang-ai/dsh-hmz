/**
 * Host half of the DSH x hmz flow integration.
 *
 * - `/api/hmz-flow/rpc`: an exact Connection Fetch route; DSH applies its own
 *   owner authentication before this code runs. Used only by the Client plugin.
 * - A stdio Python adapter that talks to hmz through its public SDK.
 * - An authenticated, read-only reverse proxy so native hmz web is embedded.
 * - Leader tools: list / status / start / send / answer (asks the real user) / stop.
 * - Write protection of the session's agent tree while its run is active.
 */
import { realpathSync, existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AdapterClient, AdapterError } from './lib/adapter-client.js'
import { createHmzProxy } from './lib/proxy.js'
import { StateStore, isValidSessionId } from './lib/state.js'
import { describeSelection, formatStatus, formatBinding } from './lib/present.js'
import { FlowController, FlowError, ACTIVE } from './lib/controller.js'
import { InFlight, protectedCallReason, protectedRootOf } from './lib/policy.js'
import { validateOptions } from './lib/options.js'
import { composeTask, historySnapshot } from './lib/history.js'

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
export function readHmzWebAddress(file) {
  const text = readFileSync(file, 'utf8')
  const match = text.match(/https?:\/\/[^\s]+\?key=[^\s]+/)
  if (!match) throw new Error(`no hmz web address in ${file}`)
  const url = new URL(match[0])
  const key = url.searchParams.get('key')
  if (!key) throw new Error(`hmz web address in ${file} has no key`)
  return { origin: url.origin, key }
}

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

  // ---------------------------------------------------------------- proxy
  let proxy = null
  let proxyError = null
  if (config.hmzWebUrlFile) {
    const dshOrigins = () => {
      const port = ctx.webServer.port
      const extra = Array.isArray(config.frameAncestors) ? config.frameAncestors : []
      return [`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...extra]
    }
    proxy = createHmzProxy({
      upstream: () => readHmzWebAddress(config.hmzWebUrlFile),
      frameAncestors: dshOrigins,
      host: config.proxyHost ?? '127.0.0.1',
      port: config.proxyPort ?? 0,
      readOnly: config.embedReadOnly !== false,
      logger,
    })
    ctx.effect(() => {
      const listening = proxy.listen().then(
        (port) => logger.info?.('hmz embed proxy listening on %s:%d', config.proxyHost ?? '127.0.0.1', port),
        (error) => { proxyError = error; logger.warn('hmz embed proxy failed: %s', error.message) },
      )
      return async () => {
        await proxy.close()
        await listening
      }
    }, 'hmz-flow: embed proxy')
  } else {
    proxyError = new Error('hmzWebUrlFile is not configured; the Flow view cannot embed hmz web')
  }

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
  function notify(sessionId, text, summary) {
    const agent = ctx.agents.get(sessionId)
    if (!agent) return false
    try {
      agent.followup({
        content: [{ type: 'text', text }],
        source: { kind: 'hmz-flow', form: 'notice', summary: summary.slice(0, 120) },
      })
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

  ctx.effect(() => ctx.tools.guard((exec) => {
    const ids = controller.protectedIds()
    if (ids.size === 0) return undefined
    if (!protectedRootOf(ctx.agents, exec.agent, ids)) return undefined
    return protectedCallReason(exec)
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
    embed: async ({ sessionId }) => {
      if (!proxy || proxyError) throw new UserFacing(`hmz embed unavailable: ${proxyError?.message ?? 'proxy not started'}`)
      if (!proxy.port) throw new UserFacing('hmz embed proxy is still starting')
      let hash = '#/'
      let target = 'home'
      const binding = store.binding(sessionId)
      let current = null
      if (binding?.epicName) {
        hash = `#/epics/${encodeURIComponent(binding.epicName)}`
        target = 'bound'
      } else {
        try {
          current = await adapter.request('status', { workspace: workspaceOfSession(sessionId) })
          // A run that is not this session's is shown, never bound.
          if (current?.held && current.epicName && (current.state === 'running' || current.stopping != null)) {
            hash = `#/epics/${encodeURIComponent(current.epicName)}`
            target = 'unbound-running'
          }
        } catch (error) { current = { error: error.message } }
      }
      return { ...proxy.mintTicket(hash), hash, target, binding: binding ?? null, status: current, readOnly: config.embedReadOnly !== false }
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
  const failText = (error) => (error.outcome === 'unknown' ? `OUTCOME UNKNOWN: ${error.message}` : `REFUSED: ${error.message}`)
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
    description: 'Start the hmz flow the user selected in the DSH composer (flow选项), in this session\'s working directory, with the options saved there. Use it when the user clearly asks to run the work with the flow; do NOT use it to answer a progress question or because of an hmz notice. While the run is active the flow edits code and this session can only read, talk to the flow (hmz_flow_send) and stop it.',
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
      const selection = store.selection(agent.id)
      if (!selection.flow) return 'REFUSED: no hmz flow is selected in the composer; ask the user to pick one under / → Flow'
      try {
        const workspace = workspaceOfSession(agent.id)
        const declared = await adapter.request('flow', { workspace, name: selection.flow })
        const saved = store.options(agent.id, selection.flow)
        const { binding, history } = await controller.start(agent.id, {
          task, flow: selection.flow, declared,
          saved: saved ? validateOptions(saved) : undefined,
          exceptToken: exec.token,
          composeTask: (t) => {
            const snapshot = selection.includeHistory ? historySnapshot(agent.session.snapshotEvents()) : null
            return { task: composeTask(t, snapshot), history: snapshot }
          },
        })
        const roles = Object.entries(binding.names ?? {}).map(([role, who]) => `${role} → ${who}`).join(', ')
        return [
          `STARTED hmz run #${binding.run} of ${binding.flow} (epic ${binding.epicName || 'pending'}), host pid ${binding.hostPid}.`,
          `Roles: ${roles || 'none'}.`,
          history ? `Background attached: ${history.included}/${history.total} visible messages${history.truncated ? ' (truncated)' : ''}, up to ${history.cutoff}.` : 'No conversation background attached (附带前文 is OFF).',
          'Write protection is ON for this session until the run is verified ended. Use hmz_flow_status for progress.',
        ].join('\n')
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
    'You are the leader/secretary: the user keeps talking to you. Start the selected flow with hmz_flow_start only when the user clearly asks for the work to be done with it.',
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
