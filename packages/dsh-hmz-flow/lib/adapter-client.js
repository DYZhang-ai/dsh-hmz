/**
 * Host side of the stdio adapter: spawns the hmz-installation Python on
 * adapter/hmz_adapter.py and correlates JSON-line replies by id.
 *
 * The adapter only holds short-lived hmz links; closing it never stops a
 * flow. A request whose reply never arrived is reported as `unknown`, never
 * retried here.
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'

export class AdapterClient {
  /**
   * @param {{python: string, script: string, env?: Record<string,string>, timeoutMs?: number, logger?: any}} options
   */
  constructor(options) {
    this.options = options
    this.child = null
    this.waiting = new Map()
    this.stderrTail = ''
    this.closed = false
  }

  ensure() {
    if (this.closed) throw new Error('hmz adapter is closed')
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child
    const { python, script, env } = this.options
    const child = spawn(python, ['-I', script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    })
    this.child = child
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      let message
      try { message = JSON.parse(line) } catch { return }
      const waiter = this.waiting.get(message.id)
      if (!waiter) return
      this.waiting.delete(message.id)
      clearTimeout(waiter.timer)
      if (message.ok) waiter.resolve(message.result)
      else waiter.reject(new AdapterError(String(message.error ?? 'refused'), 'refused'))
    })
    child.stderr.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-4000)
    })
    const fail = (why) => {
      if (this.child === child) this.child = null
      for (const [id, waiter] of this.waiting) {
        if (waiter.child !== child) continue
        this.waiting.delete(id)
        clearTimeout(waiter.timer)
        waiter.reject(new AdapterError(`hmz adapter exited before answering (${why}); outcome unknown`, 'unknown'))
      }
    }
    child.on('exit', (code, signal) => fail(signal ?? `code ${code}`))
    child.on('error', (error) => fail(error.message))
    return child
  }

  /**
   * @param {string} op
   * @param {object} [args]
   * @returns {Promise<any>}
   */
  request(op, args = {}) {
    let child
    try { child = this.ensure() } catch (error) { return Promise.reject(error) }
    const id = randomUUID()
    const timeoutMs = this.options.timeoutMs ?? 30000
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        reject(new AdapterError(`hmz adapter did not answer ${op} within ${timeoutMs}ms; outcome unknown`, 'unknown'))
      }, timeoutMs)
      this.waiting.set(id, { resolve, reject, timer, child })
      child.stdin.write(`${JSON.stringify({ id, op, args })}\n`, (error) => {
        if (!error) return
        this.waiting.delete(id)
        clearTimeout(timer)
        reject(new AdapterError(`could not write to hmz adapter: ${error.message}`, 'not-sent'))
      })
    })
  }

  async close() {
    this.closed = true
    const child = this.child
    this.child = null
    if (!child) return
    child.stdin.end()
    await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGTERM'); resolve() }, 3000)
      child.once('exit', () => { clearTimeout(timer); resolve() })
    })
  }
}

export class AdapterError extends Error {
  /** @param {string} message @param {'refused'|'unknown'|'not-sent'} outcome */
  constructor(message, outcome) {
    super(message)
    this.name = 'AdapterError'
    this.outcome = outcome
  }
}
