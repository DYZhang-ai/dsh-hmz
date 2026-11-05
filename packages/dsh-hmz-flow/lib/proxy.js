/**
 * Authenticated loopback reverse proxy in front of the native hmz web UI so
 * DSH can embed it in an iframe without modifying hmz.
 *
 * What it changes, and nothing else:
 * - drops hmz's `X-Frame-Options: DENY` and replaces only the CSP
 *   `frame-ancestors` directive with the DSH page origins;
 * - performs hmz's own key sign-in server-side and attaches hmz's cookie to
 *   forwarded requests, so the hmz key never reaches the browser; hmz's
 *   Set-Cookie headers are not passed through.
 *
 * What it requires before forwarding anything:
 * - a loopback `Host` naming this proxy (DNS-rebinding defense);
 * - not `Sec-Fetch-Site: cross-site`;
 * - a proxy session cookie, which is only minted by redeeming a one-time,
 *   short-lived ticket that the DSH Host hands to an authenticated DSH owner;
 * - for writes, an `Origin` equal to this proxy's origin (hmz additionally
 *   applies its own same-origin checks on top).
 *
 * By default the embed is read-only: every non-GET/HEAD request is refused, so
 * starting, steering, answering or stopping cannot bypass the DSH leader
 * through the embedded page (`readOnly: false` lifts this).
 */
import http from 'node:http'
import { randomBytes } from 'node:crypto'

const ENTER_PATH = '/__dsh_hmz/enter'
const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]'])
const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'host', 'cookie',
])

/**
 * Replace the frame-ancestors directive of a CSP header value.
 * @param {string} policy
 * @param {string[]} ancestors
 */
export function rewriteFrameAncestors(policy, ancestors) {
  const value = `frame-ancestors ${ancestors.length ? ancestors.join(' ') : "'none'"}`
  const parts = String(policy).split(';').map((one) => one.trim()).filter(Boolean)
  let replaced = false
  const out = parts.map((one) => {
    if (/^frame-ancestors(\s|$)/i.test(one)) { replaced = true; return value }
    return one
  })
  if (!replaced) out.push(value)
  return out.join('; ')
}

/** @param {string|undefined} header */
function parseCookies(header) {
  const out = new Map()
  for (const piece of String(header ?? '').split(';')) {
    const at = piece.indexOf('=')
    if (at <= 0) continue
    out.set(piece.slice(0, at).trim(), piece.slice(at + 1).trim())
  }
  return out
}

/**
 * @param {{
 *   upstream: () => Promise<{origin: string, key: string}> | {origin: string, key: string},
 *   frameAncestors: () => string[],
 *   host?: string, port?: number,
 *   ticketTtlMs?: number, sessionTtlMs?: number,
 *   readOnly?: boolean,
 *   logger?: {warn: Function, info?: Function},
 * }} options
 */
export function createHmzProxy(options) {
  const host = options.host ?? '127.0.0.1'
  const ticketTtl = options.ticketTtlMs ?? 60_000
  const sessionTtl = options.sessionTtlMs ?? 12 * 3600_000
  const readOnly = options.readOnly !== false
  const tickets = new Map() // ticket -> { expires, to }
  const sessions = new Map() // sid -> expires
  let upstreamCookie = null // "name=value" from hmz sign-in
  let upstreamOrigin = null
  let signingIn = null
  let server = null
  let port = 0

  const cookieName = () => `dsh_hmz_flow_${port}`

  function sweep(now = Date.now()) {
    for (const [one, entry] of tickets) if (entry.expires <= now) tickets.delete(one)
    for (const [one, expires] of sessions) if (expires <= now) sessions.delete(one)
  }

  /** One-time ticket; `to` is a hash route inside the hmz page (e.g. `#/epics/x`). */
  function mintTicket(to = '') {
    sweep()
    const ticket = randomBytes(24).toString('base64url')
    const hash = typeof to === 'string' && to.startsWith('#') ? to : ''
    tickets.set(ticket, { expires: Date.now() + ticketTtl, to: hash })
    return { path: `${ENTER_PATH}?ticket=${encodeURIComponent(ticket)}`, port, expiresInMs: ticketTtl }
  }

  async function signIn(force = false) {
    if (upstreamCookie && !force) return upstreamCookie
    if (signingIn) return signingIn
    signingIn = (async () => {
      const { origin, key } = await options.upstream()
      const url = new URL('/', origin)
      url.searchParams.set('key', key)
      const cookie = await new Promise((resolve, reject) => {
        const req = http.request(url, { method: 'GET' }, (res) => {
          res.resume()
          const set = res.headers['set-cookie'] ?? []
          const first = set.map((one) => one.split(';')[0]).find((one) => one.includes('='))
          if (!first) reject(new Error(`hmz web sign-in answered ${res.statusCode} without a cookie`))
          else resolve(first)
        })
        req.on('error', reject)
        req.end()
      })
      upstreamOrigin = new URL(origin).origin
      upstreamCookie = cookie
      return cookie
    })()
    try { return await signingIn } finally { signingIn = null }
  }

  function selfOrigins(req) {
    return [...LOOPBACK_NAMES].map((name) => `http://${name}:${port}`)
  }

  function refuse(res, status, text) {
    res.writeHead(status, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': rewriteFrameAncestors("default-src 'none'", options.frameAncestors()),
    })
    res.end(text)
  }

  function hostAllowed(req) {
    const value = String(req.headers.host ?? '')
    const at = value.lastIndexOf(':')
    if (at < 0) return false
    return LOOPBACK_NAMES.has(value.slice(0, at)) && value.slice(at + 1) === String(port)
  }

  function enter(req, res, url) {
    sweep()
    const ticket = url.searchParams.get('ticket') ?? ''
    const entry = tickets.get(ticket)
    if (!entry) return refuse(res, 403, 'This embed link is invalid, expired or already used. Reopen the Flow view in DSH.')
    tickets.delete(ticket)
    const dest = req.headers['sec-fetch-dest']
    if (dest !== undefined && dest !== 'iframe' && dest !== 'document') {
      return refuse(res, 403, 'The hmz embed only opens as a page or frame.')
    }
    const sid = randomBytes(32).toString('base64url')
    sessions.set(sid, Date.now() + sessionTtl)
    res.writeHead(303, {
      location: `/${entry.to}`,
      'set-cookie': `${cookieName()}=${sid}; HttpOnly; SameSite=Strict; Path=/`,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    })
    res.end()
  }

  function forward(req, res, retried) {
    const cookie = upstreamCookie
    const target = new URL(req.url, upstreamOrigin)
    const headers = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (!HOP_HEADERS.has(name)) headers[name] = value
    }
    headers.host = target.host
    headers.cookie = cookie
    if (typeof headers.origin === 'string' && selfOrigins(req).includes(headers.origin)) {
      headers.origin = upstreamOrigin
    }
    if (headers.referer) delete headers.referer
    const upstreamReq = http.request(target, { method: req.method, headers }, (upstreamRes) => {
      if (upstreamRes.statusCode === 401 && !retried && (req.method === 'GET' || req.method === 'HEAD')) {
        upstreamRes.resume()
        signIn(true).then(() => forward(req, res, true), (error) => refuse(res, 502, `hmz web sign-in failed: ${error.message}`))
        return
      }
      if (upstreamRes.statusCode === 401) {
        // A write refused for the key is not retried; refresh for the next request.
        signIn(true).catch(() => {})
      }
      const out = {}
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (name === 'set-cookie' || name === 'x-frame-options' || name === 'connection' || name === 'keep-alive' || name === 'transfer-encoding') continue
        out[name] = value
      }
      out['content-security-policy'] = rewriteFrameAncestors(
        String(upstreamRes.headers['content-security-policy'] ?? "default-src 'self'"),
        options.frameAncestors(),
      )
      res.writeHead(upstreamRes.statusCode ?? 502, out)
      if (typeof res.flushHeaders === 'function') res.flushHeaders()
      upstreamRes.pipe(res)
    })
    upstreamReq.on('error', (error) => {
      if (!res.headersSent) refuse(res, 502, `hmz web is not reachable: ${error.message}`)
      else res.destroy(error)
    })
    res.on('close', () => upstreamReq.destroy())
    req.pipe(upstreamReq)
  }

  async function handle(req, res) {
    if (!hostAllowed(req)) return refuse(res, 421, 'Unexpected Host for the hmz embed proxy.')
    if (req.headers['sec-fetch-site'] === 'cross-site') return refuse(res, 403, 'Cross-site requests are refused.')
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    if (url.pathname === ENTER_PATH) {
      if (req.method !== 'GET') return refuse(res, 405, 'GET only.')
      return enter(req, res, url)
    }
    const sid = parseCookies(req.headers.cookie).get(cookieName())
    const expires = sid ? sessions.get(sid) : undefined
    if (!expires || expires <= Date.now()) {
      return refuse(res, 401, 'Not signed in to the hmz embed. Open it from the DSH Flow view.')
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (readOnly) {
        return refuse(res, 403, 'The hmz view inside DSH is read-only. Ask the DSH leader, or open hmz web directly.')
      }
      const origin = req.headers.origin
      if (typeof origin !== 'string' || !selfOrigins(req).includes(origin)) {
        return refuse(res, 403, 'Writes must come from the embedded hmz page itself.')
      }
    }
    try {
      await signIn()
    } catch (error) {
      return refuse(res, 502, `hmz web sign-in failed: ${error.message}`)
    }
    forward(req, res, false)
  }

  return {
    mintTicket,
    get port() { return port },
    get sessionCount() { return sessions.size },
    listen() {
      return new Promise((resolve, reject) => {
        server = http.createServer((req, res) => {
          handle(req, res).catch((error) => {
            options.logger?.warn?.('hmz proxy request failed: %s', error?.message ?? error)
            if (!res.headersSent) refuse(res, 500, 'proxy failure')
            else res.destroy()
          })
        })
        server.once('error', reject)
        server.listen(options.port ?? 0, host, () => {
          port = server.address().port
          resolve(port)
        })
      })
    },
    close() {
      tickets.clear()
      sessions.clear()
      if (!server) return Promise.resolve()
      const closing = new Promise((resolve) => server.close(() => resolve()))
      server.closeAllConnections?.()
      server = null
      return closing
    },
  }
}
