// Stands in for hmz's app.js inside the Flow viewer. hmz's app.js is the whole
// workbench -- the global sidebar of every workspace's epics, the router of every
// view and the dialogs -- which the viewer does not load. The epic view imports
// only `go` from it; navigation goes through the viewer's own scoped router.

/** Goes to another view: the viewer's router keeps it inside the one run shown. */
export function go(path) {
  location.hash = path.startsWith('#') ? path : `#${path}`
}

export function where() {
  const raw = location.hash.replace(/^#/, '') || '/'
  const url = new URL(raw.startsWith('/') ? raw : `/${raw}`, 'http://viewer')
  return { parts: url.pathname.split('/').filter(Boolean).map(decodeURIComponent), query: url.searchParams }
}

export function stays() {}

export function covered() {
  return false
}

export function shut() {}
