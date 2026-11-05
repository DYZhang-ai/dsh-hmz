/**
 * Serves the Flow page's native hmz viewer: a tiny host page, the plugin's own
 * viewer modules, and hmz's own installed web front-end modules for one epic
 * view -- the files are read from the installed hmz, never copied or altered.
 *
 * The viewer runs in a sandboxed iframe (opaque origin: no DSH cookies or
 * storage) under a CSP of connect-src 'none'. It reaches no server: every read
 * it makes is answered over postMessage by the DSH page, for one run only.
 * What is served here is static code, the same for everyone; no run data.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const VIEWER = join(HERE, '..', 'viewer')
export const VIEWER_PATH = '/hmzf-viewer'

/** hmz front-end files one epic view needs (its import closure without app.js/sidebar.js). */
export const HMZ_FILES = Object.freeze(new Set([
  'views/epic.js', 'acting.js', 'api.js', 'composer.js', 'dom.js', 'epic.js', 'graph.js', 'held.js',
  'shell.js', 'transcript.js', 'ui.js', 'style.css', 'theme.js', 'mark.svg',
]))
const OWN_FILES = Object.freeze(new Set(['boot.js', 'viewer.js', 'shim/app.js', 'shim/sidebar.js']))
const TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.html': 'text/html; charset=utf-8' }

export function importMap(base) {
  return JSON.stringify({ imports: {
    [`${base}/hmz/app.js`]: `${base}/shim/app.js`,
    [`${base}/hmz/sidebar.js`]: `${base}/shim/sidebar.js`,
  } })
}

/** The viewer page and its CSP (the inline import map is allowed by its hash only). */
export function viewerPage(base) {
  const map = importMap(base)
  const hash = createHash('sha256').update(map).digest('base64')
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">
<link rel="stylesheet" href="${base}/hmz/style.css">
<script src="${base}/hmz/theme.js"></script>
<script src="${base}/boot.js"></script>
<script type="importmap">${map}</script>
<script type="module" src="${base}/viewer.js"></script>
</head><body><div class="app side-folded" data-hmz="app"><main id="page" class="main" tabindex="-1"></main></div><div class="overlay" data-hmz="overlay" hidden></div></body></html>`
  return { html, hash }
}

function typeOf(name) {
  const dot = name.lastIndexOf('.')
  return TYPES[dot >= 0 ? name.slice(dot) : ''] ?? 'application/octet-stream'
}

/**
 * @param {{staticDir: () => Promise<string>, logger?: any}} deps
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function viewerHandler({ staticDir, logger }) {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://viewer')
    const rest = url.pathname.slice(VIEWER_PATH.length).replace(/^\//, '')
    const common = {
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      // Loaded by an opaque-origin (sandboxed) document: module scripts need CORS.
      'access-control-allow-origin': '*',
      'cross-origin-resource-policy': 'cross-origin',
    }
    const refuse = (status, text) => { res.writeHead(status, { ...common, 'content-type': 'text/plain; charset=utf-8' }); res.end(text) }
    if (req.method !== 'GET' && req.method !== 'HEAD') return refuse(405, 'GET only')
    try {
      if (rest === 'index.html') {
        const host = String(req.headers.host ?? '')
        const self = `http://${host}${VIEWER_PATH}/`
        const { html, hash } = viewerPage(VIEWER_PATH)
        res.writeHead(200, {
          ...common,
          'content-type': TYPES['.html'],
          'content-security-policy': [
            "default-src 'none'",
            `script-src ${self} 'sha256-${hash}'`,
            `style-src ${self} 'unsafe-inline'`,
            `img-src ${self} data:`,
            `font-src ${self}`,
            "connect-src 'none'",
            "frame-ancestors 'self'",
            "base-uri 'none'",
            "form-action 'none'",
          ].join('; '),
        })
        return res.end(req.method === 'HEAD' ? undefined : html)
      }
      let file = null
      if (rest.startsWith('hmz/') && HMZ_FILES.has(rest.slice(4))) file = join(await staticDir(), rest.slice(4))
      else if (OWN_FILES.has(rest)) file = join(VIEWER, rest)
      if (!file) return refuse(404, 'not part of the Flow viewer')
      const body = await readFile(file)
      res.writeHead(200, { ...common, 'content-type': typeOf(file) })
      res.end(req.method === 'HEAD' ? undefined : body)
    } catch (error) {
      logger?.warn?.('hmz-flow viewer: %s', error.message)
      if (!res.headersSent) refuse(500, 'viewer file unavailable')
    }
  }
}
