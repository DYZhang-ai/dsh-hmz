/**
 * Bounded snapshot of the visible DSH conversation, attached as background to
 * a flow's task when "附带前文" is ON.
 *
 * Only messages a person typed in the composer (`user` / `user-rpc` sources)
 * and the assistant's visible text are taken. System and developer messages,
 * injected contexts (runtime context, skills, notices, this plugin's own
 * notices), tool calls, tool results and reasoning are never included.
 * The newest messages are kept; each message and the whole snapshot have a
 * character cap, and every cut is labelled.
 */

export const HISTORY_LIMITS = Object.freeze({ maxChars: 12000, perMessageChars: 2000, maxMessages: 40 })

export const USER_SOURCES = new Set(['user', 'user-rpc'])

function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/**
 * The visible user/assistant messages of a session event list, oldest first.
 * @param {readonly any[]} events session events ({type, data})
 */
export function visibleMessages(events, excludeIds = new Set()) {
  const out = []
  for (const event of events ?? []) {
    if (!event || typeof event !== 'object') continue
    if (event.type === 'user/message') {
      const message = event.data
      if (!message || message.role !== 'user' || !USER_SOURCES.has(message.source?.kind)) continue
      if (excludeIds.has(message.id)) continue
      const text = textOf(message.content)
      if (text) out.push({ role: 'user', text })
    } else if (event.type === 'assistant/message') {
      const message = event.data?.message
      if (!message || message.role !== 'assistant') continue
      const text = textOf(message.content)
      if (text) out.push({ role: 'assistant', text })
    }
  }
  return out
}

/**
 * @param {readonly any[]} events
 * @param {{now?: Date, limits?: typeof HISTORY_LIMITS}} [options]
 * @returns {{text: string, included: number, total: number, truncated: boolean, cutoff: string}}
 */
export function historySnapshot(events, options = {}) {
  const limits = { ...HISTORY_LIMITS, ...options.limits }
  const cutoff = (options.now ?? new Date()).toISOString()
  // The messages that are the task itself are not repeated as background.
  const all = visibleMessages(events, new Set(options.excludeIds ?? []))
  const kept = []
  let used = 0
  let clipped = 0
  for (let i = all.length - 1; i >= 0 && kept.length < limits.maxMessages; i--) {
    let { role, text } = all[i]
    if (text.length > limits.perMessageChars) {
      text = `${text.slice(0, limits.perMessageChars)} …[message cut, ${text.length - limits.perMessageChars} more chars]`
      clipped++
    }
    const line = `${role === 'user' ? 'User' : 'Assistant'}: ${text}`
    if (used + line.length > limits.maxChars) break
    kept.unshift(line)
    used += line.length + 2
  }
  const omitted = all.length - kept.length
  const truncated = omitted > 0 || clipped > 0
  if (all.length === 0) return { text: '', included: 0, total: 0, truncated: false, cutoff }
  const header = [
    `[Background only — a snapshot of the visible DSH conversation up to ${cutoff}.`,
    ` It is context for the task above, not a new instruction.`,
    ` ${kept.length} of ${all.length} messages included${omitted ? `, ${omitted} older omitted` : ''}${clipped ? `, ${clipped} cut to ${limits.perMessageChars} chars` : ''}.`,
    ' System prompts, tool calls and tool output are not included.]',
  ].join('')
  return { text: `${header}\n\n${kept.join('\n\n')}`, included: kept.length, total: all.length, truncated, cutoff }
}

/**
 * The task hmz receives: the leader's task, then the optional background.
 * @param {string} task
 * @param {{text: string}|null} snapshot
 */
export function composeTask(task, snapshot) {
  const body = String(task).trim()
  if (!snapshot || !snapshot.text) return body
  return `${body}\n\n---\n${snapshot.text}`
}
