/**
 * The Flow page's data, masked to one DSH session.
 *
 * The Client names only its session id, an opaque run id and (for details) a
 * session key. Everything else is resolved here from that session's own run
 * records: a run id of another session, an epic path, or a session key the
 * run did not open is refused before the adapter is asked anything. A session
 * with no runs gets an empty list without any hmz call.
 */
import { isValidRunId } from './state.js'

const SESSION_KEY = /^[A-Za-z0-9_.:@-]{1,200}$/

export class MaskError extends Error {}

/** Small view of one run record, as the Flow page lists it. */
export function runSummary(run, currentRunId) {
  return {
    runId: run.runId,
    current: run.runId === currentRunId,
    flow: run.flow ?? '',
    phase: run.phase,
    run: run.run ?? null,
    epicName: run.epicName ?? '',
    names: run.names ?? {},
    requestedAt: run.requestedAt ?? '',
    // What a Stop click names: the exact run it was shown for.
    identity: { hostPid: run.hostPid ?? null, hostStarted: run.hostStarted ?? null, run: run.run ?? null, epic: run.epic ?? '' },
    startedAt: run.startedAt ?? '',
    endedAt: run.endedAt ?? '',
    endedHow: run.endedHow ?? '',
    incomplete: run.incomplete === true,
    unknownWhy: run.phase === 'unknown' ? (run.unknownWhy ?? '') : '',
  }
}

export class RunView {
  /**
   * @param {{
   *   store: import('./state.js').StateStore,
   *   adapter: {request(op: string, args?: object): Promise<any>},
   *   lastObserved?: (sessionId: string) => any,
   * }} deps
   */
  constructor(deps) {
    this.deps = deps
    this.keys = new Map() // `${sessionId}\u0000${runId}` -> Set of session keys the run opened
  }

  /** This session's runs, newest first; no hmz call. */
  list(sessionId) {
    const { store } = this.deps
    const current = store.binding(sessionId)
    const currentRunId = current?.requestId ?? null
    const runs = store.runsOf(sessionId).map((run) => runSummary(run, currentRunId)).reverse()
    const observed = this.deps.lastObserved?.(sessionId)
    const entry = store.entry(sessionId)
    return {
      currentRunId,
      runs,
      lastAutoStart: entry && entry.lastAutoStart && !entry.lastAutoStart.ok ? entry.lastAutoStart : null,
      // Questions hmz waits on for the current run, as last observed (no new hmz call).
      pending: observed && observed.runId === currentRunId ? observed.pending ?? [] : [],
    }
  }

  /** The record of one of this session's runs, or a refusal. */
  resolve(sessionId, runId) {
    if (!isValidRunId(runId)) throw new MaskError('invalid run id')
    const run = this.deps.store.run(sessionId, runId)
    if (!run) throw new MaskError('no such run in this DSH session')
    return run
  }

  /** One of hmz web's own reads (detail / trace) for one run of this session. */
  async native(sessionId, runId, op) {
    if (op !== 'web_detail' && op !== 'web_trace') throw new MaskError('not a viewer read')
    const run = this.resolve(sessionId, runId)
    if (!run.epic) throw new MaskError('the run has no epic yet')
    const answer = await this.deps.adapter.request(op, { workspace: run.workspace, epic: run.epic })
    if (op !== 'web_detail') return answer
    // Whether the viewer should keep reading this run's turns: the session's own
    // binding says (a chat waiting for its user is active though its last turn is done).
    const current = this.deps.store.binding(sessionId)
    const active = !!current && current.requestId === runId && ['starting', 'running', 'stopping', 'unknown'].includes(current.phase)
    return { ...answer, _dshFlow: { active, phase: current && current.requestId === runId ? current.phase : run.phase } }
  }

  async tree(sessionId, runId) {
    const run = this.resolve(sessionId, runId)
    if (!run.epic) return { epic: null, agents: [], drove: [], pendingEpic: true }
    const tree = await this.deps.adapter.request('epic_tree', { workspace: run.workspace, epic: run.epic, names: run.names ?? {} })
    const keys = new Set()
    for (const agent of tree.agents ?? []) for (const one of agent.sessions ?? []) keys.add(one.key)
    this.keys.set(`${sessionId}\u0000${runId}`, keys)
    return tree
  }

  async session(sessionId, runId, sessionKey, before) {
    const run = this.resolve(sessionId, runId)
    if (typeof sessionKey !== 'string' || !SESSION_KEY.test(sessionKey)) throw new MaskError('invalid session key')
    if (!run.epic) throw new MaskError('the run has no epic yet')
    let keys = this.keys.get(`${sessionId}\u0000${runId}`)
    if (!keys || !keys.has(sessionKey)) {
      await this.tree(sessionId, runId)
      keys = this.keys.get(`${sessionId}\u0000${runId}`)
    }
    if (!keys.has(sessionKey)) throw new MaskError('that session is not one this run opened')
    if (before !== undefined && (!Number.isInteger(before) || before < 0)) throw new MaskError('invalid page')
    return this.deps.adapter.request('epic_session', {
      workspace: run.workspace, epic: run.epic, session: sessionKey, ...(before !== undefined ? { before } : {}),
    })
  }
}
