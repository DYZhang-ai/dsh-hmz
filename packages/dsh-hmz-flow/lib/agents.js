/** Agent ownership used by the flow leader and its write-protection fence. */
export function flowAgents(agents, getSubagents) {
  if (typeof agents.roots === 'function' && typeof agents.isOwnedBy === 'function') return agents
  if (typeof getSubagents !== 'function') {
    throw new Error('hmz-flow: DSH must provide agents.roots/isOwnedBy or a getter for subagents.rootOf')
  }
  // A delegated Agent can be announced before its runtime owner is published.
  // It must not become a leader, or reject the runtime's creation event.
  const rootOf = (agent) => {
    // Resolve on every query: DSH can replace this service without reloading
    // the plugin. A temporary absence must fail the fence, not exempt a child.
    const subagents = getSubagents()
    if (typeof subagents?.rootOf !== 'function') {
      throw new Error('hmz-flow: subagent ownership service is unavailable')
    }
    try { return subagents.rootOf(agent) } catch (error) {
      if (error?.code === 'UNAUTHORIZED') return undefined
      throw error
    }
  }
  return {
    get: (id) => agents.get(id),
    list: () => agents.list(),
    roots: () => agents.list().filter((agent) => rootOf(agent) === agent),
    // Flow fences belong to tree roots; membership includes all depths even
    // when an intermediate creator is no longer resident.
    isOwnedBy: (id, owner) => {
      const agent = agents.get(id)
      return !!agent && agent !== owner && rootOf(agent) === owner
    },
  }
}
