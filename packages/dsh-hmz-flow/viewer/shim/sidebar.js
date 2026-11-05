// Stands in for hmz's sidebar.js inside the Flow viewer: the global list of
// workspaces and epics is not part of a DSH session's Flow page. The epic view
// imports three helpers from it; changes outside the run (backups, new epics,
// resuming) are not offered here -- the DSH leader controls the run.

/** How the run was backed up: nothing is said here. */
export function backedSaid() {
  return ''
}

/** The run's menu: its title only; no links to other epics, new epics or resuming. */
export function epicMenu(run) {
  return [{ head: String(run?.task || '').split('\n')[0] }]
}

/** Uploading a run's backup is not offered from DSH. */
export function upload() {
  return Promise.reject(new Error('Not available in DSH'))
}
