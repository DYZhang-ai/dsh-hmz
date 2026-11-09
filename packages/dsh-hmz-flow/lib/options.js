/**
 * Flow options as saved from the DSH options panel, and the frozen start
 * arguments built from them and the flow's own declaration.
 */

const SPEC = /^[A-Za-z0-9_-]{1,40}(@[A-Za-z0-9_.-]{1,80})?\/[^\s]{1,200}$/
const ROLE = /^[A-Za-z0-9_.-]{1,80}$/

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** `cli/model:effort` or `cli@account/model:effort`, as hmz `-a` spells an agent. */
export function agentSpec({ cli, account, model, effort }) {
  if (!cli || !model) return ''
  return `${cli}${account ? `@${account}` : ''}/${model}${effort ? `:${effort}` : ''}`
}

export function isAgentSpec(value) {
  return typeof value === 'string' && SPEC.test(value)
}

/**
 * duration is seconds, matching hmz SDK; the UI converts minutes at its boundary.
 * @param {unknown} budget
 * @returns {null | {cost?: number, duration?: number, output_tokens?: number, graceful: boolean | Record<string, boolean>}}
 */
export function validateBudget(budget) {
  if (budget === null || budget === undefined) return null
  if (!isPlainObject(budget)) throw new Error('budget must be an object')
  const out = {}
  for (const key of ['cost', 'duration', 'output_tokens']) {
    if (budget[key] === undefined || budget[key] === null || budget[key] === '') continue
    const n = Number(budget[key])
    if (!Number.isFinite(n) || n < 0) throw new Error(`budget.${key} must be a non-negative number`)
    out[key] = key === 'output_tokens' ? Math.round(n) : n
  }
  if (!Object.keys(out).length) return null
  const graceful = budget.graceful
  if (graceful === undefined || typeof graceful === 'boolean') out.graceful = graceful !== false
  else if (isPlainObject(graceful)) {
    out.graceful = {}
    for (const key of ['cost', 'duration', 'output_tokens']) out.graceful[key] = graceful[key] !== false
  } else throw new Error('budget.graceful must be a boolean or an object')
  return out
}

/**
 * Validate what the panel saves for one flow.
 * @param {unknown} options
 */
export function validateOptions(options) {
  if (!isPlainObject(options)) throw new Error('options must be an object')
  const agents = {}
  if (options.agents !== undefined) {
    if (!isPlainObject(options.agents)) throw new Error('options.agents must be an object')
    for (const [role, spec] of Object.entries(options.agents)) {
      if (!ROLE.test(role)) throw new Error(`invalid role name ${role}`)
      if (spec === '' || spec === null) continue
      if (!isAgentSpec(spec)) throw new Error(`role ${role}: "${spec}" is not an agent (cli[@account]/model[:effort])`)
      agents[role] = spec
    }
  }
  const params = options.params === undefined ? {} : options.params
  if (!isPlainObject(params)) throw new Error('options.params must be an object')
  const envs = options.envs === undefined ? {} : options.envs
  if (!isPlainObject(envs) || Object.values(envs).some((v) => typeof v !== 'string')) throw new Error('options.envs must map roles to strings')
  return {
    agents,
    budget: validateBudget(options.budget),
    params: JSON.parse(JSON.stringify(params)),
    envs: { ...envs },
    profile_flow: options.profile_flow === true,
    profile_environment: options.profile_environment === true,
  }
}

/**
 * Freeze the arguments of one start from the flow declaration, the options
 * saved in DSH (preferred) and what hmz remembers for the workspace.
 * @param {any} declared hmz `declared()` for the flow
 * @param {any} saved validated options or undefined
 * @returns {{ok: true, args: object} | {ok: false, problems: string[]}}
 */
export function startArguments(declared, saved) {
  const problems = []
  // Once the user saved options in DSH they are authoritative: a cleared
  // budget, empty params or empty envs stay cleared. hmz's remembered
  // settings are only the starting point when nothing was saved.
  const source = saved ?? declared.remembered ?? {}
  const agents = {}
  for (const role of declared.agents ?? []) {
    if (role.auto) continue
    const spec = source.agents?.[role.name] || ''
    if (spec) agents[role.name] = spec
    else if (role.required) problems.push(`role "${role.name}" has no agent; choose CLI/model in flow选项`)
  }
  const envs = {}
  for (const role of declared.envs ?? []) {
    const spec = source.envs?.[role.name] || ''
    if (spec) envs[role.name] = spec
    else if (role.required && !role.auto) problems.push(`environment "${role.name}" has no runtime; set it in flow选项`)
  }
  const rawBudget = source.budget
  const budget = rawBudget && typeof rawBudget === 'object' && Object.keys(rawBudget).length ? rawBudget : null
  if (declared.name !== 'chat' && !budget) problems.push('set at least one budget limit (cost, time or output tokens) in flow选项')
  if (problems.length) return { ok: false, problems }
  return {
    ok: true,
    args: {
      flow: declared.name,
      agents,
      envs,
      params: source.params && typeof source.params === 'object' ? source.params : {},
      budget,
      profile_flow: source.profile_flow === true,
      profile_environment: source.profile_environment === true,
    },
    from: saved ? 'saved' : 'remembered',
  }
}
