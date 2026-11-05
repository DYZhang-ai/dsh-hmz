import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StateStore, validateSelectionPatch } from '../lib/state.js'

const dir = () => mkdtempSync(join(tmpdir(), 'hmzflow-state-'))

test('a session that never chose has no flow and include-history ON', () => {
  const store = new StateStore(dir())
  assert.deepEqual(store.selection('s1'), { flow: null, includeHistory: true, updatedAt: null })
})

test('selection persists across store instances (restart)', () => {
  const d = dir()
  new StateStore(d).setSelection('s1', { flow: 'rlar' })
  new StateStore(d).setSelection('s1', { includeHistory: false })
  const again = new StateStore(d)
  assert.equal(again.selection('s1').flow, 'rlar')
  assert.equal(again.selection('s1').includeHistory, false)
  assert.equal(again.selection('s2').flow, null, 'sessions are independent')
  assert.equal(statSync(join(d, 'state.json')).mode & 0o777, 0o600)
})

test('clearing the flow keeps the include-history choice', () => {
  const store = new StateStore(dir())
  store.setSelection('s', { flow: 'rlar', includeHistory: false })
  store.setSelection('s', { flow: null })
  assert.deepEqual({ ...store.selection('s'), updatedAt: null }, { flow: null, includeHistory: false, updatedAt: null })
})

test('invalid patches are refused and nothing is written', () => {
  const d = dir()
  const store = new StateStore(d)
  for (const bad of [null, [], { flow: '../x' }, { flow: 3 }, { includeHistory: 'yes' }, { other: 1 }, { flow: 'a b' }]) {
    assert.throws(() => store.setSelection('s', bad), undefined, JSON.stringify(bad))
  }
  assert.throws(() => readFileSync(join(d, 'state.json')))
  assert.deepEqual(validateSelectionPatch({ flow: 'rlar:rlar' }), { flow: 'rlar:rlar' })
})

test('an unknown state format is not overwritten', () => {
  const d = dir()
  writeFileSync(join(d, 'state.json'), JSON.stringify({ version: 99, x: 1 }))
  assert.throws(() => new StateStore(d), /unknown format/)
  assert.equal(JSON.parse(readFileSync(join(d, 'state.json'), 'utf8')).version, 99)
})

test('regression: a failed durable write leaves the visible state unchanged', async () => {
  const { mkdirSync, rmSync } = await import('node:fs')
  const d = dir()
  const store = new StateStore(d)
  store.setSelection('session-a', { flow: 'chat' })
  rmSync(join(d, 'state.json'))
  mkdirSync(join(d, 'state.json')) // rename onto a directory fails
  assert.throws(() => store.setSelection('session-a', { flow: 'rlar' }))
  assert.equal(store.selection('session-a').flow, 'chat')
  assert.throws(() => store.setBinding('session-a', { run: 1 }))
  assert.equal(store.binding('session-a'), undefined)
})

test('regression: reserved or malformed session ids are refused and cannot pollute prototypes', () => {
  const store = new StateStore(dir())
  for (const bad of ['__proto__', 'constructor', 'prototype', '', '../x', 'a b', 'x'.repeat(200), 5, null]) {
    assert.throws(() => store.setSelection(bad, { flow: 'rlar' }), /invalid session/, String(bad))
  }
  assert.equal(Object.hasOwn(Object.prototype, 'selection'), false)
  assert.equal({}.selection, undefined)
})

test('a state file with a __proto__ session key loads without pollution', () => {
  const d = dir()
  writeFileSync(join(d, 'state.json'), '{"version":2,"sessions":{"__proto__":{"selection":{"flow":"evil"}},"session-ok":{"selection":{"flow":"rlar","__proto__":{"x":1}}}}}')
  const store = new StateStore(d)
  assert.equal(store.selection('session-ok').flow, 'rlar')
  assert.equal(({}).flow, undefined)
  assert.equal(({}).x, undefined)
})

