/**
 * The plugin's own small persistent store: one JSON file, written atomically.
 *
 * Holds only integration metadata per DSH session: the flow selection and
 * include-history switch, the saved flow options, every hmz run this session
 * started (`runs`, append-only, keyed by an opaque run id), and which of them is
 * the current one (`binding`, the run leader actions go to). hmz run state
 * itself is never copied here; the session id is the ownership key, never cwd.
 *
 * Every mutation is staged on a copy, persisted (write temp + fsync + rename),
 * and only then published; a failed write leaves the visible state unchanged.
 * Session identifiers are validated and stored as own keys of null-prototype
 * objects, so no identifier can reach Object.prototype.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const VERSION = 3
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/
const RESERVED = new Set(['__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'toString', 'valueOf'])

/** @param {unknown} id */
export function isValidSessionId(id) {
  return typeof id === 'string' && SESSION_ID.test(id) && !RESERVED.has(id)
}

/** @param {unknown} id */
export function assertSessionId(id) {
  if (!isValidSessionId(id)) throw new Error('invalid session identifier')
  return /** @type {string} */ (id)
}

/** Default selection for a session that never chose anything. */
export function defaultSelection() {
  return { flow: null, includeHistory: true, updatedAt: null }
}

const FLOW_NAME = /^[A-Za-z0-9_.:-]{1,120}$/
const RUN_ID = /^[A-Za-z0-9-]{8,80}$/

/** @param {unknown} id */
export function isValidRunId(id) {
  return typeof id === 'string' && RUN_ID.test(id)
}

/**
 * Validate one selection patch coming from the Client.
 * @param {unknown} patch
 * @returns {{flow?: string|null, includeHistory?: boolean}}
 */
export function validateSelectionPatch(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('selection must be an object')
  }
  const out = {}
  for (const key of Object.keys(patch)) {
    if (key !== 'flow' && key !== 'includeHistory') throw new Error(`unknown selection field: ${key}`)
  }
  if (Object.hasOwn(patch, 'flow')) {
    const flow = patch.flow
    if (flow !== null && (typeof flow !== 'string' || !FLOW_NAME.test(flow))) {
      throw new Error('flow must be null or a flow name')
    }
    out.flow = flow
  }
  if (Object.hasOwn(patch, 'includeHistory')) {
    if (typeof patch.includeHistory !== 'boolean') throw new Error('includeHistory must be a boolean')
    out.includeHistory = patch.includeHistory
  }
  return out
}

/** Deep copy of plain JSON into null-prototype objects. */
function plain(value) {
  if (Array.isArray(value)) return value.map(plain)
  if (value !== null && typeof value === 'object') {
    const out = Object.create(null)
    for (const key of Object.keys(value)) {
      if (RESERVED.has(key)) continue
      out[key] = plain(value[key])
    }
    return out
  }
  return value
}

function emptyData() {
  return { version: VERSION, sessions: Object.create(null) }
}

export class StateStore {
  /** @param {string} dir directory owned by this plugin */
  constructor(dir) {
    this.dir = dir
    this.file = join(dir, 'state.json')
    this.data = emptyData()
    this.load()
  }

  load() {
    let raw
    try {
      raw = readFileSync(this.file, 'utf8')
    } catch (error) {
      if (error && error.code === 'ENOENT') return
      throw error
    }
    const parsed = JSON.parse(raw)
    if (!parsed || ![1, 2, VERSION].includes(parsed.version) || !parsed.sessions || typeof parsed.sessions !== 'object') {
      throw new Error(`hmz-flow state ${this.file} has an unknown format; refusing to overwrite it`)
    }
    const data = emptyData()
    for (const id of Object.keys(parsed.sessions)) {
      if (!isValidSessionId(id)) continue
      const entry = plain(parsed.sessions[id])
      // v1/v2 kept only the current binding: it becomes the first run of the history.
      if (!entry.runs) {
        entry.runs = Object.create(null)
        entry.runOrder = []
        const b = entry.binding
        if (b && typeof b.requestId === 'string' && RUN_ID.test(b.requestId)) {
          entry.runs[b.requestId] = plain({ ...b, runId: b.requestId })
          entry.runOrder.push(b.requestId)
        }
      }
      data.sessions[id] = entry
    }
    this.data = data
  }

  /** Serialize `data` durably; throws without touching the published state. */
  persist(data) {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
      const fd = openSync(tmp, 'r')
      try { fsyncSync(fd) } finally { closeSync(fd) }
      renameSync(tmp, this.file)
    } catch (error) {
      try { rmSync(tmp, { force: true }) } catch {}
      throw error
    }
    try {
      const dirFd = openSync(this.dir, 'r')
      try { fsyncSync(dirFd) } finally { closeSync(dirFd) }
    } catch {}
  }

  /**
   * Stage a change to one session on a copy, persist it, then publish it.
   * @param {string} sessionId
   * @param {(entry: any) => any} change returns the value to give back
   */
  update(sessionId, change) {
    const id = assertSessionId(sessionId)
    const staged = { version: VERSION, sessions: plain(this.data.sessions) }
    const entry = staged.sessions[id] ?? (staged.sessions[id] = Object.create(null))
    const result = change(entry)
    this.persist(staged)
    this.data = staged
    return result
  }

  /** @param {string} sessionId */
  entry(sessionId) {
    const id = assertSessionId(sessionId)
    return Object.hasOwn(this.data.sessions, id) ? this.data.sessions[id] : undefined
  }

  /** @param {string} sessionId */
  selection(sessionId) {
    const entry = this.entry(sessionId)
    return { ...defaultSelection(), ...(entry && entry.selection ? entry.selection : {}) }
  }

  /**
   * @param {string} sessionId
   * @param {unknown} patch
   */
  setSelection(sessionId, patch) {
    const valid = validateSelectionPatch(patch)
    return this.update(sessionId, (entry) => {
      entry.selection = plain({ ...defaultSelection(), ...entry.selection, ...valid, updatedAt: new Date().toISOString() })
      return { ...entry.selection }
    })
  }

  /** Saved flow options per flow name, or undefined. */
  options(sessionId, flow) {
    const entry = this.entry(sessionId)
    const all = entry && entry.options
    return all && Object.hasOwn(all, flow) ? plain(all[flow]) : undefined
  }

  setOptions(sessionId, flow, options) {
    if (typeof flow !== 'string' || !FLOW_NAME.test(flow)) throw new Error('flow must be a flow name')
    return this.update(sessionId, (entry) => {
      if (!entry.options) entry.options = Object.create(null)
      entry.options[flow] = plain({ ...options, savedAt: new Date().toISOString() })
      return plain(entry.options[flow])
    })
  }

  /** The exact hmz run this session started, or undefined. */
  binding(sessionId) {
    const entry = this.entry(sessionId)
    return entry && entry.binding ? plain(entry.binding) : undefined
  }

  /**
   * Set the current run of a session. A binding carrying a request id is also
   * written into the session's run history under that id (its run id); a
   * history entry is never removed by a later start, only by the refusal of
   * the very start that created it (`null` while it was still `starting`).
   */
  setBinding(sessionId, binding) {
    return this.update(sessionId, (entry) => {
      const previous = entry.binding
      if (!entry.runs) { entry.runs = Object.create(null); entry.runOrder = [] }
      if (binding && isValidRunId(binding.requestId)) {
        const runId = binding.requestId
        if (!Object.hasOwn(entry.runs, runId)) entry.runOrder.push(runId)
        entry.runs[runId] = plain({ ...binding, runId })
      } else if (binding === null && previous && previous.phase === 'starting' && isValidRunId(previous.requestId)) {
        delete entry.runs[previous.requestId]
        entry.runOrder = entry.runOrder.filter((one) => one !== previous.requestId)
      }
      entry.binding = binding === null ? null : plain(binding)
      return entry.binding ? plain(entry.binding) : null
    })
  }

  /** This session's runs, oldest first (copies). */
  runsOf(sessionId) {
    const entry = this.entry(sessionId)
    if (!entry || !entry.runs) return []
    return (entry.runOrder ?? []).filter((id) => Object.hasOwn(entry.runs, id)).map((id) => plain(entry.runs[id]))
  }

  /** One run of this session by its run id, or undefined (never another session's). */
  run(sessionId, runId) {
    if (!isValidRunId(runId)) return undefined
    const entry = this.entry(sessionId)
    return entry && entry.runs && Object.hasOwn(entry.runs, runId) ? plain(entry.runs[runId]) : undefined
  }

  /** Update one history run that is not the current binding (e.g. a delivered notice). */
  updateRun(sessionId, runId, patch) {
    if (!isValidRunId(runId)) throw new Error('invalid run id')
    return this.update(sessionId, (entry) => {
      if (!entry.runs || !Object.hasOwn(entry.runs, runId)) throw new Error('no such run in this session')
      entry.runs[runId] = plain({ ...entry.runs[runId], ...patch, runId })
      if (entry.binding && entry.binding.requestId === runId) entry.binding = plain({ ...entry.binding, ...patch })
      return plain(entry.runs[runId])
    })
  }

  /** Sessions with any run history. */
  sessionsWithRuns() {
    return Object.keys(this.data.sessions).filter((id) => (this.data.sessions[id].runOrder ?? []).length > 0)
  }

  /** Every session id with a binding, for reconnect after restart. */
  boundSessions() {
    return Object.keys(this.data.sessions).filter((id) => this.data.sessions[id].binding)
  }
}
