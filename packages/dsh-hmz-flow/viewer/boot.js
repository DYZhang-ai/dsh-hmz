// Runs before hmz's modules in the sandboxed Flow viewer. The viewer has an opaque
// origin and a CSP of connect-src 'none': it cannot reach any server itself. Every
// API read hmz's own modules make is handed to the DSH page that embeds the viewer,
// which answers only for the one run this viewer shows, and refuses the rest.
(() => {
  const pending = new Map()
  let seq = 0
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return
    const said = event.data
    if (!said || said.hmzf !== 'reply' || !pending.has(said.id)) return
    const { resolve } = pending.get(said.id)
    pending.delete(said.id)
    resolve(new Response(JSON.stringify(said.body ?? {}), {
      status: said.status || 500,
      headers: { 'content-type': 'application/json' },
    }))
  })
  // hmz's api.js asks `/d/<daemon>/api/...`; only the path and query are passed on.
  window.fetch = (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href)
    const path = url.pathname.replace(/^\/d\/[^/]+\/api\//, '/api/') + url.search
    const method = (init.method || (typeof input === 'object' && input.method) || 'GET').toUpperCase()
    const id = ++seq
    return new Promise((resolve) => {
      pending.set(id, { resolve })
      window.parent.postMessage({ hmzf: 'fetch', id, method, path }, '*')
    })
  }
  // Live host streams are not part of the viewer: a run is shown as written down
  // and read again every few seconds by hmz's own view.
  window.EventSource = class {
    constructor() { this.readyState = 2 }
    addEventListener() {}
    removeEventListener() {}
    close() {}
  }
})()
