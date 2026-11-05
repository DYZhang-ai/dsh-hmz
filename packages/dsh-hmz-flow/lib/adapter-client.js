/**
 * Host side of the stdio adapter: spawns the hmz-installation Python on
 * adapter/hmz_adapter.py and correlates JSON-line replies by id.
 *
 * Outcomes are reported honestly and never retried here:
 * - `refused`  the adapter answered and said no;
 * - `not-sent` nothing was written (adapter unavailable before the write);
 * - `unknown`  the request may have been (partly) written but no answer came:
 *              a timeout, a broken pipe, or the adapter exiting.
 * Closing the adapter never stops a flow: it only holds short-lived hmz links.
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'

export class AdapterError extends Error {
  /** @param {string} message @param {'refused'|'unknown'|'not-sent'} outcome */
  constructor(message, outcome) {
    super(message)
    this.name = 'AdapterError'
    this.outcome = outcome
  }
}

export class AdapterClient {
  /**
   * @param {{python: string, script: string, env?: Record<string,string>, timeoutMs?: number, killAfterMs?: number}} options
   */
  constructor(options) {
    this.options = options
    this.child = null
    this.waiting = new Map()
    this.stderrTail = ''
    this.closed = false
  }

  /** Settle one waiting request exactly once. */
  settle(id, outcome) {
    const waiter = this.waiting.get(id)
    if (!waiter) return false
    this.waiting.delete(id)
    clearTimeout(waiter.timer)
    if (outcome.ok) waiter.resolve(outcome.value)
    else waiter.reject(outcome.error)
    return true
  }

  /** Fail every request still waiting on one child process. */
  failChild(child, why, outcome = 'unknown') {
    for (const [id, waiter] of [...this.waiting]) {
      if (waiter.child !== child) continue
      const text = outcome === 'not-sent' ? `hmz adapter could not start (${why}); request not sent` : `hmz adapter failed before answering (${why}); outcome unknown`
      this.settle(id, { ok: false, error: new AdapterError(text, outcome) })
    }
  }

  ensure() {
    if (this.closed) throw new Error('hmz adapter is closed')
    const live = this.child
    if (live && live.exitCode === null && live.signalCode === null && !live.broken) return live
    const { python, script, env } = this.options
    const child = spawn(python, ['-I', script], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } })
    child.broken = false
    child.exited = new Promise((resolve) => child.once('close', resolve))
    this.child = child
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      let message
      try { message = JSON.parse(line) } catch { return }
      if (!message || typeof message.id !== 'string') return
      const waiter = this.waiting.get(message.id)
      if (!waiter || waiter.child !== child) return
      if (message.ok === true) this.settle(message.id, { ok: true, value: message.result })
      else {
        // The adapter says whether an action may have happened; anything else is a refusal.
        const outcome = message.outcome === 'unknown' ? 'unknown' : 'refused'
        this.settle(message.id, { ok: false, error: new AdapterError(String(message.error ?? 'refused'), outcome) })
      }
    })
    child.stderr.on('data', (chunk) => { this.stderrTail = (this.stderrTail + chunk.toString()).slice(-4000) })
    const broken = (why, outcome) => {
      child.broken = true
      if (this.child === child) this.child = null
      this.failChild(child, why, outcome)
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    }
    // Every stream error is contained here; none may escape as an uncaught exception.
    child.stdin.on('error', (error) => broken(`stdin ${error.code ?? error.message}`))
    child.stdout.on('error', (error) => broken(`stdout ${error.code ?? error.message}`))
    child.stderr.on('error', () => {})
    // A process that never started (no pid) cannot have read anything.
    child.on('error', (error) => broken(error.message, child.pid === undefined ? 'not-sent' : 'unknown'))
    child.on('exit', (code, signal) => broken(signal ?? `code ${code}`))
    return child
  }

  /**
   * @param {string} op
   * @param {object} [args]
   * @param {{timeoutMs?: number}} [opts]
   * @returns {Promise<any>}
   */
  request(op, args = {}, opts = {}) {
    let child
    try { child = this.ensure() } catch (error) {
      return Promise.reject(new AdapterError(error.message, 'not-sent'))
    }
    if (!child.stdin.writable) {
      return Promise.reject(new AdapterError('hmz adapter input is closed; request not sent', 'not-sent'))
    }
    const id = randomUUID()
    const timeoutMs = opts.timeoutMs ?? this.options.timeoutMs ?? 30000
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.settle(id, { ok: false, error: new AdapterError(`hmz adapter did not answer ${op} within ${timeoutMs}ms; outcome unknown`, 'unknown') })
      }, timeoutMs)
      this.waiting.set(id, { resolve, reject, timer, child })
      child.stdin.write(`${JSON.stringify({ id, op, args })}\n`, (error) => {
        // Bytes may have reached the adapter before the error: the outcome is unknown.
        if (error) this.settle(id, { ok: false, error: new AdapterError(`writing to hmz adapter failed (${error.code ?? error.message}); outcome unknown`, 'unknown') })
      })
    })
  }

  /** Close stdin, wait for exit; SIGTERM then SIGKILL if it does not go. */
  async close() {
    this.closed = true
    const child = this.child
    this.child = null
    if (!child) return
    if (child.exitCode !== null || child.signalCode !== null) { await child.exited; return }
    try { child.stdin.end() } catch {}
    const killAfter = this.options.killAfterMs ?? 3000
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.())
    const gone = await Promise.race([child.exited.then(() => true), wait(killAfter).then(() => false)])
    if (gone) return
    child.kill('SIGTERM')
    const termed = await Promise.race([child.exited.then(() => true), wait(killAfter).then(() => false)])
    if (termed) return
    child.kill('SIGKILL')
    await child.exited
  }
}
