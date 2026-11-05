import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createHmzProxy, rewriteFrameAncestors } from '../lib/proxy.js'

const KEY = 'secret-hmz-key-value'
let upstream
let upstreamPort
let proxy
const seen = []

function request(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

before(async () => {
  // A stand-in with hmz web's relevant behavior: key sign-in sets a cookie,
  // pages forbid framing, the API requires the cookie.
  upstream = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers })
    const url = new URL(req.url, 'http://x')
    if (url.pathname === '/' && url.searchParams.get('key') === KEY) {
      res.writeHead(303, { location: '/', 'set-cookie': 'humanize-1=' + KEY + '; HttpOnly; SameSite=Strict; Path=/' })
      return res.end()
    }
    const common = {
      'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
      'set-cookie': 'leak=1',
    }
    if (url.pathname.startsWith('/api/')) {
      if (req.headers.cookie !== `humanize-1=${KEY}`) { res.writeHead(401, common); return res.end('{}') }
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => { res.writeHead(200, { ...common, 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, origin: req.headers.origin ?? null, body })) })
      return
    }
    res.writeHead(200, { ...common, 'content-type': 'text/html' })
    res.end('<title>humanize</title>')
  })
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r))
  upstreamPort = upstream.address().port
  proxy = createHmzProxy({
    upstream: () => ({ origin: `http://127.0.0.1:${upstreamPort}`, key: KEY }),
    frameAncestors: () => ['http://127.0.0.1:4000'],
    readOnly: false,
  })
  await proxy.listen()
})

after(async () => {
  await proxy.close()
  await new Promise((r) => upstream.close(r))
})

async function signedIn(to = '#/') {
  const { path } = proxy.mintTicket(to)
  const res = await request(proxy.port, { path, headers: { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'same-site' } })
  assert.equal(res.status, 303)
  const cookie = res.headers['set-cookie'][0].split(';')[0]
  return { cookie, location: res.headers.location }
}

test('rewriteFrameAncestors replaces or appends only that directive', () => {
  assert.equal(rewriteFrameAncestors("default-src 'self'; frame-ancestors 'none'", ['http://a:1']), "default-src 'self'; frame-ancestors http://a:1")
  assert.equal(rewriteFrameAncestors("default-src 'self'", ['http://a:1', 'http://b:2']), "default-src 'self'; frame-ancestors http://a:1 http://b:2")
  assert.equal(rewriteFrameAncestors('frame-ancestors *', []), "frame-ancestors 'none'")
})

test('nothing is forwarded without a proxy session', async () => {
  const before = seen.length
  for (const path of ['/', '/api/held', '/app.js']) {
    const res = await request(proxy.port, { path })
    assert.equal(res.status, 401, path)
  }
  assert.equal(seen.length, before, 'upstream never contacted')
})

test('wrong Host and cross-site requests are refused before auth', async () => {
  const { cookie } = await signedIn()
  assert.equal((await request(proxy.port, { headers: { host: 'evil.example:80', cookie } })).status, 421)
  assert.equal((await request(proxy.port, { headers: { host: `127.0.0.1:${proxy.port + 1}`, cookie } })).status, 421)
  assert.equal((await request(proxy.port, { headers: { cookie, 'sec-fetch-site': 'cross-site' } })).status, 403)
})

test('tickets are single use, expire, and cannot be forged', async () => {
  const { path } = proxy.mintTicket('#/')
  assert.equal((await request(proxy.port, { path })).status, 303)
  assert.equal((await request(proxy.port, { path })).status, 403, 'reuse refused')
  assert.equal((await request(proxy.port, { path: '/__dsh_hmz/enter?ticket=forged' })).status, 403)
  const short = createHmzProxy({ upstream: () => ({ origin: 'http://127.0.0.1:1', key: 'k' }), frameAncestors: () => [], ticketTtlMs: 1 })
  await short.listen()
  try {
    const t = short.mintTicket('#/')
    await new Promise((r) => setTimeout(r, 20))
    assert.equal((await request(short.port, { path: t.path })).status, 403, 'expired refused')
  } finally { await short.close() }
  const t = proxy.mintTicket('#/')
  assert.equal((await request(proxy.port, { path: t.path, headers: { 'sec-fetch-dest': 'script' } })).status, 403, 'not a page/frame')
})

test('ticket redeems to a deep link and an HttpOnly SameSite=Strict cookie', async () => {
  const { cookie, location } = await signedIn('#/epics/E1')
  assert.equal(location, '/#/epics/E1')
  assert.match(cookie, /^dsh_hmz_flow_\d+=/)
  const { path } = proxy.mintTicket('javascript:alert(1)')
  const res = await request(proxy.port, { path })
  assert.equal(res.headers.location, '/', 'non-hash destinations are dropped')
  assert.match(res.headers['set-cookie'][0], /HttpOnly; SameSite=Strict; Path=\//)
})

test('pages are framable only by DSH, hmz cookie and key never reach the browser', async () => {
  const { cookie } = await signedIn()
  const res = await request(proxy.port, { path: '/', headers: { cookie } })
  assert.equal(res.status, 200)
  assert.equal(res.headers['x-frame-options'], undefined)
  assert.equal(res.headers['content-security-policy'], "default-src 'self'; connect-src 'self'; frame-ancestors http://127.0.0.1:4000; base-uri 'none'")
  assert.equal(res.headers['set-cookie'], undefined)
  assert.ok(!JSON.stringify(res.headers).includes(KEY))
  const forwarded = seen.at(-1)
  assert.equal(forwarded.headers.cookie, `humanize-1=${KEY}`, 'proxy sends only the hmz cookie upstream')
  assert.ok(!String(forwarded.headers.cookie).includes('dsh_hmz_flow'), 'proxy cookie not forwarded')
})

test('API reads pass; writes need the proxy Origin and are re-originated', async () => {
  const { cookie } = await signedIn()
  const read = await request(proxy.port, { path: '/api/held', headers: { cookie, 'sec-fetch-site': 'same-origin' } })
  assert.equal(read.status, 200)
  const noOrigin = await request(proxy.port, { method: 'POST', path: '/api/held/say', headers: { cookie, 'content-type': 'application/json' }, body: '{}' })
  assert.equal(noOrigin.status, 403)
  const foreign = await request(proxy.port, { method: 'POST', path: '/api/held/say', headers: { cookie, origin: 'http://127.0.0.1:4000', 'content-type': 'application/json' }, body: '{}' })
  assert.equal(foreign.status, 403, 'even the DSH page origin cannot write through the proxy')
  const ok = await request(proxy.port, { method: 'POST', path: '/api/held/say', headers: { cookie, origin: `http://127.0.0.1:${proxy.port}`, 'content-type': 'application/json' }, body: '{"text":"x"}' })
  assert.equal(ok.status, 200)
  const said = JSON.parse(ok.body)
  assert.equal(said.origin, `http://127.0.0.1:${upstreamPort}`)
  assert.equal(said.body, '{"text":"x"}')
})

test('the default embed is read-only: no write reaches hmz', async () => {
  const ro = createHmzProxy({ upstream: () => ({ origin: `http://127.0.0.1:${upstreamPort}`, key: KEY }), frameAncestors: () => [] })
  await ro.listen()
  try {
    const { path } = ro.mintTicket('#/')
    const enter = await request(ro.port, { path })
    const cookie = enter.headers['set-cookie'][0].split(';')[0]
    const before = seen.length
    for (const p of ['/api/held/start', '/api/held/say', '/api/held/stop', '/api/flows/setup']) {
      const res = await request(ro.port, { method: 'POST', path: p, headers: { cookie, origin: `http://127.0.0.1:${ro.port}`, 'content-type': 'application/json' }, body: '{}' })
      assert.equal(res.status, 403, p)
    }
    assert.equal(seen.length, before, 'upstream never saw a write')
    assert.equal((await request(ro.port, { path: '/api/held', headers: { cookie } })).status, 200, 'reads still work')
  } finally { await ro.close() }
})

test('an upstream 401 on GET re-signs-in once (hmz web restarted with a new key)', async () => {
  const { cookie } = await signedIn()
  // Simulate hmz web restart: invalidate by making the next API call 401 once.
  let flipped = false
  const original = upstream.listeners('request')[0]
  upstream.removeAllListeners('request')
  upstream.on('request', (req, res) => {
    if (!flipped && req.url.startsWith('/api/')) { flipped = true; res.writeHead(401); return res.end() }
    original(req, res)
  })
  try {
    const res = await request(proxy.port, { path: '/api/held', headers: { cookie } })
    assert.equal(res.status, 200)
  } finally {
    upstream.removeAllListeners('request')
    upstream.on('request', original)
  }
})

test('regression: network-path, absolute and backslash targets never leave the fixed upstream', async () => {
  let reached = 0
  const other = http.createServer((req, res) => { reached++; res.end('other') })
  await new Promise((r) => other.listen(0, '127.0.0.1', r))
  const otherPort = other.address().port
  try {
    const { cookie } = await signedIn()
    const before = seen.length
    for (const path of [`//127.0.0.1:${otherPort}/probe`, `http://127.0.0.1:${otherPort}/probe`, `/\\127.0.0.1:${otherPort}/probe`, '*']) {
      const res = await request(proxy.port, { path, headers: { cookie } })
      assert.equal(res.status, 400, path)
    }
    assert.equal(reached, 0, 'unrelated server never contacted')
    assert.equal(seen.length, before, 'upstream not contacted either')
    // An encoded path stays a path on the fixed upstream.
    const ok = await request(proxy.port, { path: '/%2F%2Fexample.com/x', headers: { cookie } })
    assert.equal(ok.status, 200)
    assert.equal(seen.at(-1).url, '/%2F%2Fexample.com/x')
    assert.equal(seen.at(-1).headers.host, `127.0.0.1:${upstreamPort}`)
  } finally { await new Promise((r) => other.close(r)) }
})

test('regression: a non-loopback, non-http or credentialed upstream is refused before any request', async () => {
  for (const origin of ['http://10.1.2.3:8080', 'https://127.0.0.1:1', 'http://user:pw@127.0.0.1:1', 'file:///etc/passwd', 'not a url']) {
    const bad = createHmzProxy({ upstream: () => ({ origin, key: 'k' }), frameAncestors: () => [] })
    await bad.listen()
    try {
      const { path } = bad.mintTicket('#/')
      const enter = await request(bad.port, { path })
      const cookie = enter.headers['set-cookie'][0].split(';')[0]
      const res = await request(bad.port, { path: '/', headers: { cookie } })
      assert.equal(res.status, 502, origin)
      assert.match(res.body, /sign-in failed/)
    } finally { await bad.close() }
  }
})

test('regression: closing while listen() is pending leaves no listener', async () => {
  const p = createHmzProxy({ upstream: () => ({ origin: 'http://127.0.0.1:1', key: 'k' }), frameAncestors: () => [] })
  const listening = p.listen()
  const closing = p.close()
  await assert.rejects(listening, /closed/)
  await closing
  await assert.rejects(p.listen(), /closed/)
})

test('regression: close() resolves after a failed bind (EADDRINUSE)', async () => {
  const occupied = http.createServer()
  await new Promise((r) => occupied.listen(0, '127.0.0.1', r))
  try {
    const p = createHmzProxy({ port: occupied.address().port, upstream: () => ({ origin: 'http://127.0.0.1:1', key: 'k' }), frameAncestors: () => [] })
    await assert.rejects(p.listen(), /EADDRINUSE/)
    const closed = await Promise.race([p.close().then(() => true), new Promise((r) => setTimeout(() => r(false), 500))])
    assert.equal(closed, true)
  } finally { await new Promise((r) => occupied.close(r)) }
})

test('regression: hmz web restarting on a new port is followed for reads; writes are never re-sent', async () => {
  const hits = { first: [], second: [] }
  const make = (name) => http.createServer((req, res) => {
    hits[name].push(`${req.method} ${req.url}`)
    if (req.url.startsWith('/?key=')) { res.writeHead(303, { 'set-cookie': `c=${name}`, location: '/' }); return res.end() }
    req.resume(); req.on('end', () => res.end(name))
  })
  const a = make('first')
  const b = make('second')
  await new Promise((r) => a.listen(0, '127.0.0.1', r))
  await new Promise((r) => b.listen(0, '127.0.0.1', r))
  let current = a.address().port
  const p = createHmzProxy({ upstream: () => ({ origin: `http://127.0.0.1:${current}`, key: 'k' }), frameAncestors: () => [], readOnly: false })
  await p.listen()
  try {
    const enter = await request(p.port, { path: p.mintTicket('#/').path })
    const cookie = enter.headers['set-cookie'][0].split(';')[0]
    assert.equal((await request(p.port, { path: '/x', headers: { cookie } })).body, 'first')
    await new Promise((r) => { a.close(r); a.closeAllConnections() })
    current = b.address().port
    const write = await request(p.port, { method: 'POST', path: '/api/held/say', headers: { cookie, origin: `http://127.0.0.1:${p.port}`, 'content-type': 'application/json' }, body: '{}' })
    assert.equal(write.status, 502)
    assert.match(write.body, /not retried/)
    assert.equal(hits.second.filter((h) => h.startsWith('POST')).length, 0, 'the write never reached the new hmz web')
    const read = await request(p.port, { path: '/y', headers: { cookie } })
    assert.equal(read.status, 200)
    assert.equal(read.body, 'second')
  } finally {
    await p.close()
    await new Promise((r) => { b.close(r); b.closeAllConnections() })
  }
})
