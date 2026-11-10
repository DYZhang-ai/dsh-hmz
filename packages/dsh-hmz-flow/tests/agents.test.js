import test from 'node:test'
import assert from 'node:assert/strict'
import { flowAgents } from '../lib/agents.js'
import { agentTree, protectedRootOf } from '../lib/policy.js'

test('keeps the released DSH ownership API unchanged', () => {
  const legacy = { roots() {}, isOwnedBy() {} }
  assert.equal(flowAgents(legacy), legacy)
})

test('protects the current DSH tree across depths and keeps ordinary forks independent', () => {
  const lead = { id: 'lead' }
  const child = { id: 'child' }
  const nested = { id: 'nested', session: { header: { parentSession: 'offline-creator' } } }
  const fork = { id: 'fork', session: { header: { parentSession: 'lead' } } }
  const all = [lead, child, nested, fork]
  const registry = { list: () => all, get: (id) => all.find(a => a.id === id) }
  const roots = new Map([[lead, lead], [child, lead], [nested, lead], [fork, fork]])
  const agents = flowAgents(registry, { rootOf: (agent) => roots.get(agent) })
  assert.deepEqual(agents.roots(), [lead, fork])
  assert.deepEqual([...agentTree(agents, lead).keys()], ['lead', 'child', 'nested'])
  assert.equal(protectedRootOf(agents, nested, ['lead']), 'lead')
  assert.equal(protectedRootOf(agents, fork, ['lead']), undefined)
  assert.equal(agents.isOwnedBy('missing', lead), false)
})

test('does not treat an unpublished or orphaned subagent as a leader', () => {
  const lead = { id: 'lead' }
  const pending = { id: 'pending' }
  const registry = { list: () => [lead, pending], get: (id) => id === lead.id ? lead : pending }
  const agents = flowAgents(registry, { rootOf: (agent) => {
    if (agent === pending) throw Object.assign(new Error('agent has no active runtime owner'), { code: 'UNAUTHORIZED' })
    return lead
  } })
  assert.deepEqual(agents.roots(), [lead])
  assert.equal(agents.isOwnedBy(pending.id, lead), false)
})

test('rejects an unsupported runtime instead of silently dropping descendant protection', () => {
  assert.throws(() => flowAgents({ list: () => [] }), /subagents.rootOf/)
})

test('propagates ownership lookup failures rather than treating a protected child as unrelated', () => {
  const lead = { id: 'lead' }
  const child = { id: 'child' }
  const agents = flowAgents({ list: () => [lead, child], get: () => child }, {
    rootOf() { throw new Error('ownership lookup failed') },
  })
  assert.throws(() => agents.isOwnedBy('child', lead), /ownership lookup failed/)
})
