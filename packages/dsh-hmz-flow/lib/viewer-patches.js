/**
 * Small, exact patches applied when serving hmz's own `views/epic.js` to the
 * Flow viewer (the installed file is never modified).
 *
 * Why: the viewer shows a run as written down (`held: false`). hmz's view polls
 * the run's detail every few seconds, but its poll only tells the view when the
 * detail changed, and the view reads its sessions' turns (the trace) once. The
 * turns of a running session live in logs the detail does not summarise, so a
 * running session's thread would freeze.
 *
 * These patches add, inside hmz's view:
 * - an independent 4-second timer that re-reads the trace while the run is
 *   active, as the DSH session's own binding says (`detail._dshFlow.active`,
 *   added by the plugin; not inferred from the epic's metadata), then reads it
 *   once more after it stopped being active, and then no more;
 * - a trace revision: the thread redraws only when the trace really changed,
 *   keeping the reader's scroll position (or following the end if they were at
 *   it); nothing is redrawn when nothing changed, so graph zoom and selection
 *   are never reset by a refresh;
 * - clearing the timer when the view is left.
 *
 * Every patch is an exact text anchor. If any anchor is missing (another hmz
 * version), nothing is patched and the original file is served; the viewer
 * still works without live thread refresh, and the mismatch is logged.
 */

export const MARK = '/* [dsh-hmz-flow] live trace patch */'

export const EPIC_VIEW_PATCHES = Object.freeze([
  {
    name: 'trace revision state',
    find: '  let traced = null\n  let tracing = false\n',
    replace: '  let traced = null\n  let tracing = false\n  ' + MARK + ' let traceRev = 0\n  let traceFinal = false\n  let traceSig = \'\'\n',
  },
  {
    name: 'remember what the first read held',
    find: '      traced = (await get(`/api/runs/${encodeURIComponent(name)}/trace`)).sessions\n',
    replace: '      traced = (await get(`/api/runs/${encodeURIComponent(name)}/trace`)).sessions\n'
      + '      ' + MARK + ' traceRev += 1\n      traceSig = JSON.stringify(traced)\n',
  },
  {
    name: 'read the trace again while the flow is active',
    find: '    tracing = false\n    draw()\n  }\n',
    replace: '    tracing = false\n    draw()\n  }\n\n'
      + '  ' + MARK + '\n'
      + '  async function refreshTrace() {\n'
      + '    if (tracing || !traced) return\n'
      + '    tracing = true\n'
      + '    try {\n'
      + '      const next = (await get(`/api/runs/${encodeURIComponent(name)}/trace`)).sessions\n'
      + '      const sig = JSON.stringify(next)\n'
      + '      if (sig !== traceSig) {\n'
      + '        traced = next\n'
      + '        traceSig = sig\n'
      + '        traceRev += 1\n'
      + '        tracing = false\n'
      + '        draw()\n'
      + '      }\n'
      + '    } catch {\n'
      + '      // A failed refresh keeps what was read; the next tick tries again.\n'
      + '    } finally {\n'
      + '      tracing = false\n'
      + '    }\n'
      + '  }\n'
      + '  const traceTimer = setInterval(() => {\n'
      + '    if (!traced || tracing || !seen || !seen.detail) return\n'
      + '    const flow = seen.detail._dshFlow\n'
      + '    const active = flow ? flow.active === true : !seen.detail.ended\n'
      + '    if (active) {\n'
      + '      traceFinal = false\n'
      + '      void refreshTrace()\n'
      + '    } else if (!traceFinal) {\n'
      + '      traceFinal = true\n'
      + '      void refreshTrace()\n'
      + '    }\n'
      + '  }, 4000)\n',
  },
  {
    name: 'redraw the thread on a new trace, keeping its scroll',
    find: "    region('thread', [key, Boolean(traced), tracing, String(traceError)], () => {\n      saidFor = ''\n",
    replace: "    region('thread', [key, traceRev, Boolean(traced), tracing && !traced, String(traceError)], () => {\n"
      + '      ' + MARK + '\n'
      + "      const keep = main.querySelector('.thread-scroll')\n"
      + '      const keepAt = keep ? keep.scrollTop : 0\n'
      + '      const keepEnd = keep ? keep.scrollHeight - keep.scrollTop - keep.clientHeight < 60 : true\n'
      + '      if (keep) queueMicrotask(() => { keep.scrollTop = keepEnd ? keep.scrollHeight : keepAt })\n'
      + "      saidFor = ''\n",
  },
  {
    name: 'stop the timer when the view is left',
    find: '      stop()\n      clearInterval(ticking)\n',
    replace: '      stop()\n      clearInterval(ticking)\n      ' + MARK + ' clearInterval(traceTimer)\n',
  },
])

/**
 * @param {string} text the installed views/epic.js
 * @returns {{text: string, applied: string[], missing: string[]}}
 */
export function patchEpicView(text) {
  const missing = EPIC_VIEW_PATCHES.filter((p) => text.split(p.find).length !== 2).map((p) => p.name)
  if (missing.length) return { text, applied: [], missing }
  let out = text
  for (const p of EPIC_VIEW_PATCHES) out = out.replace(p.find, () => p.replace)
  return { text: out, applied: EPIC_VIEW_PATCHES.map((p) => p.name), missing: [] }
}
