/**
 * Host half of the DSH x hmz flow integration.
 *
 * - `/api/hmz-flow/rpc`: an exact Connection Fetch route (DSH owner auth is
 *   applied by DSH before this code runs) used by the Client plugin.
 * - A stdio Python adapter that talks to hmz through its public SDK.
 * - An authenticated reverse proxy so the native hmz web UI can be embedded.
 * - Read-only leader tools and the selected-flow context for root agents.
 *
 * This version deliberately offers no start/say/answer/stop: those are not
 * exposed until their lifecycle and write protection are implemented.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AdapterClient, AdapterError } from './lib/adapter-client.js'
import { createHmzProxy } from './lib/proxy.js'
import { StateStore } from './lib/state.js'
import { describeSelection, formatStatus } from './lib/present.js'

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
    timeoutMs: config.adapterTimeoutMs ?? 30000,
  })
  ctx.effect(() => () => { void adapter.close() }, 'hmz-flow: adapter')

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
      proxy.listen().then(
        (port) => logger.info?.('hmz embed proxy listening on %s:%d', config.proxyHost ?? '127.0.0.1', port),
        (error) => { proxyError = error; logger.warn('hmz embed proxy failed: %s', error.message) },
      )
      return () => { void proxy.close() }
    }, 'hmz-flow: embed proxy')
  } else {
    proxyError = new Error('hmzWebUrlFile is not configured; the Flow view cannot embed hmz web')
  }

  // ------------------------------------------------------------- helpers
  function workspaceOfSession(sessionId) {
    const agent = ctx.agents.get(sessionId)
    if (!agent) throw new UserFacing('This session is not live on the Host yet; send a message or reopen it first.')
    return ctx.workingDirectory.get(agent.session)
  }

  async function status(workspace) {
    return adapter.request('status', { workspace })
  }

  // ------------------------------------------------------------ Client RPC
  const ops = {
    async flows({ sessionId }) {
      return adapter.request('flows', { workspace: workspaceOfSession(sessionId) })
    },
    async flow({ sessionId, name }) {
      return adapter.request('flow', { workspace: workspaceOfSession(sessionId), name })
    },
    async status({ sessionId }) {
      return status(workspaceOfSession(sessionId))
    },
    async getSelection({ sessionId }) {
      return store.selection(sessionId)
    },
    async setSelection({ sessionId, selection }) {
      return store.setSelection(sessionId, selection)
    },
    async embed({ sessionId }) {
      if (!proxy || proxyError) throw new UserFacing(`hmz embed unavailable: ${proxyError?.message ?? 'proxy not started'}`)
      if (!proxy.port) throw new UserFacing('hmz embed proxy is still starting')
      let hash = '#/'
      let current = null
      try {
        current = await status(workspaceOfSession(sessionId))
        // Deep-link only to a run that is running or stopping right now; a past or
        // foreign epic is never auto-selected as this session's.
        if (current?.held && current.epicName && (current.state === 'running' || current.state === 'stopping')) {
          hash = `#/epics/${encodeURIComponent(current.epicName)}`
        }
      } catch (error) {
        current = { error: error.message }
      }
      return { ...proxy.mintTicket(hash), hash, status: current }
    },
  }

  ctx.effect(() => ctx.connection.fetch.register({
    path: ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      let body
      try {
        body = await request.json()
      } catch {
        return json({ ok: false, error: 'request body must be JSON' }, 400)
      }
      const op = body && typeof body.op === 'string' ? ops[body.op] : undefined
      if (!op || !Object.hasOwn(ops, body.op)) return json({ ok: false, error: `unknown op ${body?.op}` }, 404)
      if (typeof body.sessionId !== 'string' || body.sessionId === '') {
        return json({ ok: false, error: 'sessionId is required' }, 400)
      }
      try {
        return json({ ok: true, result: await op(body) })
      } catch (error) {
        const outcome = error instanceof AdapterError ? error.outcome : 'refused'
        return json({ ok: false, error: error.message, outcome }, 200)
      }
    },
  }), 'hmz-flow: client route')

  // ---------------------------------------------------------- leader tools
  const text = (value) => [{ type: 'text', text: String(value) }]
  const toolOutput = { schema: { type: 'string' }, render: (_args, value) => text(value) }

  ctx.effect(() => ctx.tools.register({
    name: 'hmz_flow_list',
    description: 'List the hmz flows available in this session\'s working directory, and which one the user selected in the DSH composer. Read-only.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: toolOutput,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('hmz_flow_list needs a calling agent')
      const workspace = ctx.workingDirectory.get(agent.session)
      const listed = await adapter.request('flows', { workspace })
      const selection = store.selection(agent.id)
      const lines = listed.flows.map((one) => `- ${one.name}${one.name === selection.flow ? ' (selected)' : ''}: ${one.about}`)
      return [`hmz flows in ${listed.workspace}:`, ...lines, '', describeSelection(selection)].join('\n')
    },
  }), 'hmz-flow: hmz_flow_list')

  ctx.effect(() => ctx.tools.register({
    name: 'hmz_flow_status',
    description: 'Read what hmz says about the flow run in this session\'s working directory: state, run number, epic, roles and the agent filling each, open/working sessions, and questions waiting for a human. Read-only; it never starts, steers or stops anything.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: toolOutput,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('hmz_flow_status needs a calling agent')
      const workspace = ctx.workingDirectory.get(agent.session)
      return formatStatus(await status(workspace), store.selection(agent.id))
    },
  }), 'hmz-flow: hmz_flow_status')

  // ---------------------------------------------- selected-flow leader context
  const contexts = new Map()
  const attach = (agent) => {
    if (contexts.has(agent.id)) return
    const roots = ctx.agents.roots()
    if (!roots.some((one) => one.id === agent.id)) return
    const prompt = agent.ctx?.systemPrompt
    if (!prompt || typeof prompt.context !== 'function') return
    const dispose = agent.ctx.effect(() => prompt.context({
      name: 'hmz-flow-selection',
      order: 900,
      interpolate: false,
      text: () => {
        const selection = store.selection(agent.id)
        return selection.flow ? leaderContext(selection) : ''
      },
    }), 'hmz-flow: leader context')
    contexts.set(agent.id, dispose)
  }
  ctx.on('agent/created', ({ agent }) => { attach(agent) })
  ctx.on('agent/disposed', ({ agent }) => { contexts.delete(agent.id) })
  for (const agent of ctx.agents.roots()) attach(agent)
  ctx.effect(() => () => {
    for (const dispose of contexts.values()) { try { void dispose() } catch {} }
    contexts.clear()
  }, 'hmz-flow: leader contexts')
}

function leaderContext(selection) {
  return [
    '[hmz flow mode — set by the user in the DSH composer, not a user instruction]',
    describeSelection(selection),
    'You remain the leader/secretary: the user keeps talking to you. hmz runs flows in its own process.',
    'Available now (read-only): hmz_flow_list, hmz_flow_status. Use hmz_flow_status when the user asks about progress.',
    'Not available in this version: starting, steering or stopping a flow from DSH. If the user asks to run the flow, say so plainly;',
    'do not run `hmz` through bash or other tools as a substitute.',
  ].join('\n')
}

class UserFacing extends Error {}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}
