/**
 * Identified user-role messages for agent.followup(), as DSH's public
 * `createUserMessage` (from @deepseek-ai/dsh-llm) builds them.
 *
 * The plugin is installed outside DSH's node_modules, so the factory is resolved
 * from the running DSH installation (the process entry point). If it cannot be
 * resolved, an equivalent message is built here: a fresh stable `id`,
 * `role: 'user'`, the given content and source, deep-frozen — the exact shape
 * the public factory returns. A message without `id`/`role` is malformed: the
 * DSH queue UI keys rows by id and crashes on a missing one.
 */
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

/** Same contract as DSH's createUserMessage: no caller-supplied id/role. */
export function fallbackUserMessage(input) {
  if (input && (Object.hasOwn(input, 'id') || Object.hasOwn(input, 'role'))) throw new Error('a new message takes no id or role')
  return deepFreeze(structuredClone({ ...input, role: 'user', id: randomUUID() }))
}

/**
 * Resolve the installed `createUserMessage`.
 * @param {string[]} anchors files whose module resolution reaches DSH's packages
 * @returns {Promise<{create: (input: object) => object, from: string}>}
 */
export async function loadUserMessageFactory(anchors = [process.argv[1]].filter(Boolean)) {
  for (const anchor of anchors) {
    try {
      const path = createRequire(anchor).resolve('@deepseek-ai/dsh-llm')
      const mod = await import(pathToFileURL(path).href)
      if (typeof mod.createUserMessage === 'function') return { create: mod.createUserMessage, from: path }
    } catch { /* try the next anchor */ }
  }
  return { create: fallbackUserMessage, from: 'fallback' }
}

/** A plugin notice: identified user-role content with a non-user source. */
export function noticeMessage(create, text, summary) {
  return create({
    content: [{ type: 'text', text }],
    source: { kind: 'hmz-flow', form: 'notice', summary: String(summary).slice(0, 120) },
  })
}
