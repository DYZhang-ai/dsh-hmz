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
  lines.push(`hmz status for ${status.workspace} (observed ${seen}):`)
  if (!status.held) {
    lines.push('- No hmz host is holding runs in this directory: nothing is running here.')
  } else {
    lines.push(`- host pid ${status.hostPid}, state: ${status.state || 'unknown'}, run #${status.run || 0}${status.flow ? `, flow ${status.flow}` : ''}`)
    if (status.epicName) lines.push(`- epic: ${status.epicName}`)
    if (status.by) lines.push(`- started by frontend: ${status.by}`)
    if (status.task) lines.push(`- task: ${clip(status.task, 400)}`)
    if (status.stopping) lines.push(`- run #${status.stopping} is still stopping (not yet cleaned up)`)
    const names = status.names ?? {}
    const roles = Object.keys(names)
    if (roles.length) {
      lines.push('- roles -> agents:')
      for (const role of roles) lines.push(`  - ${role} -> ${names[role]}`)
    }
    if (status.workingSessions?.length) lines.push(`- working sessions: ${status.workingSessions.join(', ')}`)
    if (status.openSessions?.length) lines.push(`- open sessions: ${status.openSessions.join(', ')}`)
    if (status.pending?.length) {
      lines.push('- questions waiting for a human (answer only with the real user\'s reply):')
      for (const one of status.pending) lines.push(`  - ${one.question} [${one.role}] ${clip(one.text, 300)}`)
    }
    if (status.ended) lines.push(`- last run ended: ${status.ended.how}${status.ended.why ? ` (${clip(status.ended.why, 200)})` : ''}`)
    if (status.snapshotError) lines.push(`- note: role snapshot unavailable: ${status.snapshotError}`)
  }
  if (status.recent?.length) {
    lines.push('- recent epics in this directory (for reference only; not bound to this DSH session, may be another client\'s):')
    for (const one of status.recent) {
      lines.push(`  - ${one.epicName} [${one.flow}] ${one.how || 'unknown'}: ${clip(one.task, 160)}`)
    }
  }
  lines.push(describeSelection(selection))
  return lines.join('\n')
}

function clip(value, max) {
  const s = String(value ?? '')
  return s.length > max ? `${s.slice(0, max)}… [${s.length - max} more chars]` : s
}
