/** Plain-text renderings shared by leader tools and context. */

/** @param {{flow: string|null, includeHistory: boolean}} selection */
export function describeSelection(selection) {
  if (!selection || !selection.flow) return 'No hmz flow is selected in this DSH session.'
  return `Selected hmz flow: ${selection.flow}. Include visible conversation history when a flow starts: ${selection.includeHistory ? 'ON' : 'OFF'}.`
}

/**
 * @param {any} status adapter `status` result
 * @param {{flow: string|null, includeHistory: boolean}} selection
 */
export function formatStatus(status, selection) {
  const lines = []
  const seen = status.observedAt ? new Date(status.observedAt * 1000).toISOString() : 'unknown time'
  lines.push(`hmz in ${status.workspace} (observed ${seen}):`)
  if (!status.held) {
    lines.push('- The workspace\'s own hmz host (where flows run) is not running: no flow is running there.')
  } else if (status.complete === false) {
    lines.push(`- INCOMPLETE READ of the workspace host (pid ${status.hostPid}): ${status.incompleteWhy || 'no consistent snapshot'}. Its state is unknown; do not treat it as idle.`)
  } else {
    lines.push(`- workspace host pid ${status.hostPid}, state: ${status.state || 'unknown'}, run #${status.run || 0}${status.flow ? `, flow ${status.flow}` : ''}`)
    if (status.epicName) lines.push(`- epic: ${status.epicName}`)
    if (status.by) lines.push(`- started by frontend: ${status.by}`)
    if (status.task) lines.push(`- task: ${clip(status.task, 400)}`)
    if (status.stopping != null) lines.push(`- run #${status.stopping} is still stopping (not yet cleaned up)`)
    const names = status.names ?? {}
    if (Object.keys(names).length) {
      lines.push('- roles -> agents:')
      for (const role of Object.keys(names)) lines.push(`  - ${role} -> ${names[role]}`)
    }
    if (status.workingSessions?.length) lines.push(`- working sessions: ${status.workingSessions.join(', ')}`)
    if (status.openSessions?.length) lines.push(`- open sessions: ${status.openSessions.join(', ')}`)
    if (status.pending?.length) {
      lines.push('- questions waiting for a human (relay with hmz_flow_answer; never answer yourself):')
      for (const one of status.pending) lines.push(`  - ${one.question} [run #${one.run}, ${one.role}] ${clip(one.text, 300)}`)
    }
  }
  if (status.otherHosts?.length) {
    lines.push('- other hmz hosts in this directory (native chats; not bound to this DSH session, not controlled from here):')
    for (const one of status.otherHosts) lines.push(`  - ${one.slot} pid ${one.pid}${one.alive ? '' : ' (not alive)'} since ${one.started}`)
  }
  if (status.recent?.length) {
    lines.push('- recent epics in this directory (for reference only; not bound to this DSH session, may be another client\'s):')
    for (const one of status.recent) {
      lines.push(`  - ${one.epicName} [${one.flow}] ${one.how || 'unknown'}: ${clip(one.task, 160)}`)
    }
  }
  if (status.recentError) lines.push(`- recent epics could not be read: ${status.recentError}`)
  lines.push(describeSelection(selection))
  return lines.join('\n')
}

function clip(value, max) {
  const s = String(value ?? '')
  return s.length > max ? `${s.slice(0, max)}… [${s.length - max} more chars]` : s
}

/**
 * The run bound to this DSH session, as the leader and the panel read it.
 * @param {any} binding
 * @param {any} observed controller.observe() result or {error}
 * @param {boolean} protectedNow
 */
export function formatBinding(binding, observed, protectedNow) {
  if (!binding) return `Bound hmz run: none. Write protection: ${protectedNow ? 'ON' : 'off'}.`
  const lines = [`Bound hmz run (started from this DSH session): #${binding.run ?? '?'} ${binding.flow ?? ''} — phase ${binding.phase}`]
  if (binding.epicName) lines.push(`- epic: ${binding.epicName}; host pid ${binding.hostPid}`)
  const names = binding.names ?? {}
  if (Object.keys(names).length) lines.push(`- roles → agents: ${Object.entries(names).map(([r, a]) => `${r} → ${a}`).join(', ')}`)
  if (binding.phase === 'unknown') lines.push(`- the start's outcome is unknown (${binding.unknownWhy ?? 'no answer'}); it was not re-sent. Only a lookup by its request id can bind it.`)
  if (binding.phase === 'stopping') lines.push('- stop was accepted; waiting for hmz to confirm the run ended')
  if (binding.phase === 'ended') lines.push(`- ended: ${binding.endedHow ?? 'ended'} at ${binding.endedAt ?? '?'}`)
  if (binding.stopUnknown) lines.push(`- a stop request's outcome is unknown: ${binding.stopUnknown}`)
  const obs = observed?.observation
  if (observed?.error) lines.push(`- live check failed: ${observed.error} (state above is the last confirmed one)`)
  else if (obs?.verdict === 'unverified') lines.push(`- live check inconclusive: ${obs.why}`)
  else if (obs?.view) {
    const v = obs.view
    if (v.workingSessions?.length) lines.push(`- working sessions: ${v.workingSessions.join(', ')}`)
    if (v.queued?.length) lines.push(`- queued messages: ${v.queued.map((q) => `to ${q.to || 'any'}: ${clip(q.text, 80)}`).join(' | ')}`)
    if (v.given?.length) lines.push(`- handed to agents, not yet confirmed taken: ${v.given.map((g) => `${g.agent}: ${clip(g.text, 80)}`).join(' | ')}`)
    const pending = (v.pending ?? []).filter((q) => q.run === binding.run)
    for (const q of pending) lines.push(`- waiting for the user: ${q.question} [${q.role}] ${clip(q.text, 300)} → relay with hmz_flow_answer`)
  }
  if (observed?.lookup && !observed.lookup.found) lines.push(`- lookup by request id: not found (${observed.lookup.why ?? ''}); not finding it does not prove it did not start`)
  lines.push(`Write protection: ${protectedNow ? 'ON' : 'off'}.`)
  return lines.join('\n')
}
