import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AdapterClient } from '../lib/adapter-client.js'

// A stand-in adapter speaking the same JSON-line protocol.
const FAKE = `
import json, sys, os, time
for line in sys.stdin:
    r = json.loads(line)
    op = r["op"]
    if op == "echo":
        print(json.dumps({"id": r["id"], "ok": True, "result": r["args"]}), flush=True)
    elif op == "refuse":
        print(json.dumps({"id": r["id"], "ok": False, "error": "no such flow"}), flush=True)
    elif op == "hang":
        pass
    elif op == "die":
        os._exit(3)
    elif op == "noise":
        print("not json", flush=True)
        print(json.dumps({"id": "someone-else", "ok": True, "result": 1}), flush=True)
        print(json.dumps({"id": r["id"], "ok": True, "result": "after-noise"}), flush=True)
`

function client(timeoutMs = 2000) {
  const d = mkdtempSync(join(tmpdir(), 'hmzflow-adapter-'))
  const script = join(d, 'fake.py')
  writeFileSync(script, FAKE)
  return new AdapterClient({ python: 'python3', script, timeoutMs })
}

test('answers are correlated by id, ignoring noise', async () => {
  const c = client()
  try {
    const [a, b, n] = await Promise.all([c.request('echo', { x: 1 }), c.request('echo', { x: 2 }), c.request('noise')])
    assert.deepEqual([a, b, n], [{ x: 1 }, { x: 2 }, 'after-noise'])
  } finally { await c.close() }
})

test('a refusal is reported as refused', async () => {
  const c = client()
  try {
    await assert.rejects(c.request('refuse'), (e) => e.outcome === 'refused' && /no such flow/.test(e.message))
  } finally { await c.close() }
})

test('no reply in time is unknown, not failure', async () => {
  const c = client(300)
  try {
    await assert.rejects(c.request('hang'), (e) => e.outcome === 'unknown')
  } finally { await c.close() }
})

test('adapter death mid-request is unknown, and the next request respawns it', async () => {
  const c = client()
  try {
    await assert.rejects(c.request('die'), (e) => e.outcome === 'unknown')
    assert.deepEqual(await c.request('echo', { y: 1 }), { y: 1 })
  } finally { await c.close() }
})

test('after close no request is sent', async () => {
  const c = client()
  await c.request('echo', {})
  await c.close()
  await assert.rejects(c.request('echo', {}), /closed/)
})
