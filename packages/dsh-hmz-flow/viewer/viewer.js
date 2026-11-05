// The Flow viewer's router: hmz's own epic view, mounted for exactly one run.
// Addresses inside that run (its graph, an agent, a session's thread) are routed
// to hmz's view; any other address -- a new epic, search, settings, another run,
// the timeline -- is turned back to this run.
import { mount } from './hmz/views/epic.js'

const page = document.getElementById('page')
const first = parse(location.hash)
const EPIC = first.parts[0] === 'epics' ? first.parts[1] : ''
let mounted = null

function parse(hash) {
  const raw = hash.replace(/^#/, '') || '/'
  const url = new URL(raw.startsWith('/') ? raw : `/${raw}`, 'http://viewer')
  return { parts: url.pathname.split('/').filter(Boolean).map(decodeURIComponent), query: url.searchParams }
}

function home() {
  return `#/epics/${encodeURIComponent(EPIC)}`
}

function allowed(parts) {
  if (parts[0] !== 'epics' || parts[1] !== EPIC) return false
  if (parts.length === 2) return true
  return ['agents', 'sessions', 'logs'].includes(parts[2]) && parts.length === 4
}

function route() {
  let { parts, query } = parse(location.hash)
  if (!allowed(parts)) {
    history.replaceState(null, '', home())
    ;({ parts, query } = parse(location.hash))
  }
  // hmz's view moves within the same run itself (keeping its graph zoom and
  // selection); it is mounted again only when it says it cannot.
  if (mounted && typeof mounted.moved === 'function' && mounted.moved({ parts, query })) return
  if (mounted) mounted.leave()
  page.replaceChildren()
  const made = mount(page, { parts, query })
  mounted = typeof made === 'function' ? { leave: made } : made
}

if (!EPIC) {
  page.textContent = 'No run to show.'
} else {
  window.addEventListener('hashchange', route)
  route()
}
