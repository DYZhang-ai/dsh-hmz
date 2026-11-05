/**
 * The plugin's own small persistent store: one JSON file, written atomically.
 *
 * Holds only integration metadata (per-DSH-session flow selection and the
 * include-history switch). hmz run state is never copied here; hmz is the
 * authority for that.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs'
import { join } from 'node:path'

const VERSION = 1

/** Default selection for a session that never chose anything. */
export function defaultSelection() {
  return { flow: null, includeHistory: true, updatedAt: null }
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
  if ('flow' in patch) {
    const flow = patch.flow
    if (flow !== null && (typeof flow !== 'string' || !/^[A-Za-z0-9_.:-]{1,120}$/.test(flow))) {
      throw new Error('flow must be null or a flow name')
    }
    out.flow = flow
  }
  if ('includeHistory' in patch) {
    if (typeof patch.includeHistory !== 'boolean') throw new Error('includeHistory must be a boolean')
    out.includeHistory = patch.includeHistory
  }
  for (const key of Object.keys(patch)) {
    if (key !== 'flow' && key !== 'includeHistory') throw new Error(`unknown selection field: ${key}`)
  }
  return out
}

export class StateStore {
  /** @param {string} dir directory owned by this plugin */
  constructor(dir) {
    this.dir = dir
    this.file = join(dir, 'state.json')
    this.data = { version: VERSION, sessions: {} }
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
    if (parsed && parsed.version === VERSION && parsed.sessions && typeof parsed.sessions === 'object') {
      this.data = parsed
    } else {
      throw new Error(`hmz-flow state ${this.file} has an unknown format; refusing to overwrite it`)
    }
  }

  save() {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const tmp = `${this.file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 })
    const fd = openSync(tmp, 'r')
    try { fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(tmp, this.file)
  }

  /** @param {string} sessionId */
  selection(sessionId) {
    const entry = this.data.sessions[sessionId]
    return { ...defaultSelection(), ...(entry && entry.selection) }
  }

  /**
   * @param {string} sessionId
   * @param {unknown} patch
   */
  setSelection(sessionId, patch) {
    const valid = validateSelectionPatch(patch)
    const entry = this.data.sessions[sessionId] ?? (this.data.sessions[sessionId] = {})
    entry.selection = { ...defaultSelection(), ...entry.selection, ...valid, updatedAt: new Date().toISOString() }
    this.save()
    return entry.selection
  }
}
