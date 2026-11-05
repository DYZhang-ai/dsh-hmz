/**
 * Write protection while an hmz flow owns the working directory.
 *
 * Allowlist, not denylist: while a DSH session (or any agent it owns) is
 * protected, only tools known to be read/communicate-only may run. Unknown
 * tools, shells, file edits, delegation (subagents, workflows, messages to
 * other agents), schedules and `run_code` called directly by the model are
 * denied. A PTC sub-dispatch (a call made from inside run_code) re-enters the
 * guarded pipeline and is judged by its own name.
 *
 * `run_code` itself can touch the filesystem through Node directly, so it is
 * denied as a model-direct call; the plugin also asks the protected agent to
 * present tools natively while protected so allowed tools stay reachable.
 */

export const READ_ONLY_TOOLS = Object.freeze(new Set([
  'hmz_flow_list', 'hmz_flow_status', 'hmz_flow_send', 'hmz_flow_answer', 'hmz_flow_stop',
  'read', 'read_image', 'glob', 'grep', 'lsp',
  'web_search', 'web_fetch',
  'ask_user_question', 'todo_write', 'get_goal', 'skill',
  'job_list', 'job_output', 'list_agents', 'list_subagent_models',
  'session_event_read', 'session_event_search', 'session_event_trace', 'session_search', 'session_trace',
  'terminal_list', 'terminal_read',
  'cordis_inspect_list', 'cordis_inspect_query',
]))

/**
 * @param {{name: string, parent?: unknown}} exec
 * @param {Set<string>} [allowed]
 * @returns {string|undefined} denial reason
 */
export function protectedCallReason(exec, allowed = READ_ONLY_TOOLS) {
  if (exec.name === 'hmz_flow_start') {
    return 'an hmz flow is already bound to this session; check it with hmz_flow_status or stop it first'
  }
  if (allowed.has(exec.name)) return undefined
  if (exec.name === 'run_code' && exec.parent === undefined) {
    return 'run_code is unavailable while an hmz flow owns this directory (it can write files directly); call read/status tools natively'
  }
  return `"${exec.name}" is blocked while an hmz flow owns this directory: the flow edits code, the DSH leader only reads, talks and steers it (hmz_flow_send / hmz_flow_stop)`
}

/** Live tool bodies, tracked from the around-dispatch waterfall. */
export class InFlight {
  constructor() { this.calls = new Map() }
  add(token, entry) { this.calls.set(token, { ...entry, token, since: Date.now() }) }
  remove(token) { this.calls.delete(token) }
  /**
   * Live calls by any of `agentIds` that are not read-only, other than the one
   * call `exceptToken` (the start itself). An enclosing run_code program of
   * that call is NOT excluded: it could keep writing after the start.
   */
  busy(agentIds, exceptToken, allowed = READ_ONLY_TOOLS) {
    const out = []
    for (const [token, call] of this.calls) {
      if (!agentIds.has(call.agentId)) continue
      if (exceptToken !== undefined && token === exceptToken) continue
      if (allowed.has(call.name)) continue
      out.push(call)
    }
    return out
  }
}

/**
 * Agents owned (transitively) by `root`, root included, using only the public
 * registry relation `isOwnedBy`.
 * @param {{list(): any[], isOwnedBy(id: string, owner: any): boolean}} agents
 * @param {any} root
 */
export function agentTree(agents, root) {
  const tree = new Map([[root.id, root]])
  let grew = true
  const all = agents.list()
  while (grew) {
    grew = false
    for (const one of all) {
      if (tree.has(one.id)) continue
      for (const owner of tree.values()) {
        if (agents.isOwnedBy(one.id, owner)) { tree.set(one.id, one); grew = true; break }
      }
    }
  }
  return tree
}

/**
 * The protected root session an agent belongs to, if any.
 * @param {{list(): any[], get(id: string): any, isOwnedBy(id: string, owner: any): boolean}} agents
 * @param {any} agent
 * @param {Iterable<string>} protectedIds
 */
export function protectedRootOf(agents, agent, protectedIds) {
  if (!agent) return undefined
  for (const id of protectedIds) {
    if (agent.id === id) return id
    const root = agents.get(id)
    if (root && agentTree(agents, root).has(agent.id)) return id
  }
  return undefined
}
