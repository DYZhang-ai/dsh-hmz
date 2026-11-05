import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { fallbackUserMessage, loadUserMessageFactory, noticeMessage } from '../lib/message.js'

// The installed DSH entry point, as `process.argv[1]` is inside a running DSH.
const DSH_BIN = process.env.DSH_INSTALLED_BIN
  ?? '/root/artifacts/hmz-installed-dsh-20261104/external-dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'

function assertIdentifiedUserMessage(message) {
  assert.equal(message.role, 'user')
  assert.equal(typeof message.id, 'string')
  assert.match(message.id, /^[0-9a-f-]{36}$/)
  assert.ok(Object.isFrozen(message) && Object.isFrozen(message.content) && Object.isFrozen(message.source))
  assert.equal(message.source.kind, 'hmz-flow')
  assert.equal(message.source.form, 'notice')
  assert.ok(message.source.summary.length <= 120)
  assert.deepEqual(message.content.map((b) => b.type), ['text'])
}

test('regression: notices use the installed public createUserMessage (id + role), resolved from the DSH entry', { skip: !existsSync(DSH_BIN) && 'installed DSH not present' }, async () => {
  const { create, from } = await loadUserMessageFactory([DSH_BIN])
  assert.match(from, /dsh-llm/)
  const a = noticeMessage(create, '[hmz flow notice] x', 's'.repeat(300))
  const b = noticeMessage(create, '[hmz flow notice] y', 'short')
  assertIdentifiedUserMessage(a)
  assertIdentifiedUserMessage(b)
  assert.notEqual(a.id, b.id, 'every notice has its own stable id (the queue keys rows by id)')
})

test('the fallback builds the same identified, frozen shape and refuses caller ids', async () => {
  const { create, from } = await loadUserMessageFactory(['/nonexistent/anchor.js'])
  assert.equal(from, 'fallback')
  assertIdentifiedUserMessage(noticeMessage(create, 'x', 'y'))
  assert.throws(() => fallbackUserMessage({ id: 'mine', content: [], source: { kind: 'hmz-flow' } }))
})
