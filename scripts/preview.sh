#!/usr/bin/env bash
# Isolated preview of the @dsh-hmz/flow plugin on an installed DSH and hmz.
#
#   scripts/preview.sh start   # start the isolated DSH web (in tmux)
#   scripts/preview.sh stop    # stop only the preview tmux sessions
#   scripts/preview.sh status
#
# Nothing here touches ~/.dsh, ~/.hmz or the global hmz daemon: DSH gets its own
# DSH_HOME, hmz gets its own HUMANIZE_HOME and TMPDIR (so its own daemon socket).
# No hmz web service is needed: the Flow page reads runs through the hmz SDK.
#
# Inputs (environment, with defaults that suit this machine):
#   DSH_BIN       installed dsh launcher
#   HMZ_BIN       installed hmz launcher (the venv beside it supplies Python)
#   PREVIEW_DIR   where the isolated homes, logs and demo workspace live
#   PREVIEW_TMUX  tmux socket name (separate server, so user sessions are untouched)
#   DSH_PORT      DSH web port (default: any free port)
#   PREVIEW_HMZ_HOME   hmz home to use (default \$PREVIEW_DIR/hmz-home); a second preview
#                      may share the first one's hmz accounts while keeping its own TMPDIR,
#                      so its hmz daemon, hosts and runs stay separate
#   PREVIEW_CREDENTIALS_FROM  a DSH home whose .credentials.yaml is copied (0600, never
#                      printed) into a new preview's DSH home that has none yet
#
# Run several previews side by side with different PREVIEW_DIR / PREVIEW_TMUX / DSH_PORT.
# URLs carrying launch tokens are written only to \$PREVIEW_DIR/private (0700), not printed.
set -euo pipefail

here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
pkg="$here/packages/dsh-hmz-flow"
DSH_BIN=${DSH_BIN:-/root/artifacts/hmz-installed-dsh-20261104/external-dsh-launch}
HMZ_BIN=${HMZ_BIN:-"/root/artifacts/hmz-installed-dsh-20261104/test install/bin/hmz"}
PREVIEW_DIR=${PREVIEW_DIR:-"$here/.preview"}
PREVIEW_TMUX=${PREVIEW_TMUX:-dsh-hmz-preview}
PROFILE=${PREVIEW_PROFILE:-hmzflow}

dsh_home="$PREVIEW_DIR/dsh-home"
hmz_home="${PREVIEW_HMZ_HOME:-$PREVIEW_DIR/hmz-home}"
hmz_tmp="$PREVIEW_DIR/tmp"
demo="$PREVIEW_DIR/demo"
logs="$PREVIEW_DIR/logs"
profile_dir="$dsh_home/profiles/$PROFILE"

tm() { tmux -L "$PREVIEW_TMUX" "$@"; }

prepare() {
  mkdir -p "$dsh_home" "$hmz_home" "$hmz_tmp" "$demo" "$logs" "$PREVIEW_DIR/private" "$profile_dir/node_modules/@dsh-hmz"
  chmod 700 "$PREVIEW_DIR/private" "$hmz_tmp"
  if [ -n "${PREVIEW_CREDENTIALS_FROM:-}" ] && [ ! -e "$dsh_home/.credentials.yaml" ] && [ -f "$PREVIEW_CREDENTIALS_FROM/.credentials.yaml" ]; then
    (umask 077; cp "$PREVIEW_CREDENTIALS_FROM/.credentials.yaml" "$dsh_home/.credentials.yaml")
    chmod 600 "$dsh_home/.credentials.yaml"
  fi
  [ -d "$demo/.git" ] || (cd "$demo" && git init -q && echo "# demo" > README.md && git add README.md && git -c user.email=demo@example -c user.name=demo commit -qm init)
  hmz_python="$(cd "$(dirname "$HMZ_BIN")/.." && pwd -P)/venv/bin/python"
  [ -x "$hmz_python" ] || { echo "no hmz venv python at $hmz_python" >&2; exit 1; }
  # What the hmz launcher would export for its dsh backend.
  hmz_dsh_bin=$(cat "$(dirname "$hmz_python")/../../share/dsh-path" 2>/dev/null || true)
  ln -sfn "$pkg" "$profile_dir/node_modules/@dsh-hmz/flow"
  cat > "$profile_dir/package.json" <<JSON
{
  "name": "dsh-profile-$PROFILE",
  "private": true,
  "dependencies": { "@dsh-hmz/flow": "link:$pkg" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@dsh-hmz/flow"] } }
}
JSON
  printf 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n' > "$profile_dir/pnpm-workspace.yaml"
  # Machine-specific plugin config lives in the profile's own patch layer.
  cat > "$profile_dir/cordis.patch.yml" <<YAML
- id: dsh-hmz-flow
  name: '@dsh-hmz/flow'
  config:
    python: '$hmz_python'
    stateDir: '$PREVIEW_DIR/state'
    hmzEnv:
      HUMANIZE_HOME: '$hmz_home'
      TMPDIR: '$hmz_tmp'
      HUMANIZE_DSH_BIN: '$hmz_dsh_bin'
# Preview only: skip the one-time welcome notice so browser probes reach the UI.
- id: ui-settings-general
  name: '@deepseek-ai/dsh-client-ui-settings-general'
  config:
    welcomeNoticeVersion: 2026-09-28.1
YAML
}

start() {
  prepare
  # The Flow page reads runs through the hmz SDK; no hmz web service is started.
  if ! tm has-session -t dsh 2>/dev/null; then
    tm new-session -d -s dsh -c "$demo" \
      "export DSH_HOME='$dsh_home' DSH_TELEMETRY_DISABLED=1; '$DSH_BIN' --profile '$PROFILE' --host 127.0.0.1 --port \${DSH_PORT:-0} --no-open > '$logs/dsh.out' 2> '$logs/dsh.err'"
  fi
  for _ in $(seq 1 150); do grep -q 'token=' "$logs/dsh.out" 2>/dev/null && break; sleep 0.2; done
  url=$(grep -o 'http://[^ ]*token=[^ ]*' "$logs/dsh.out" | head -1 || true)
  [ -n "$url" ] || { echo "DSH did not print its URL; see $logs/dsh.out and $logs/dsh.err" >&2; exit 1; }
  umask 077; printf '%s\n' "$url" > "$PREVIEW_DIR/private/dsh-url"
  echo "DSH preview: http://127.0.0.1:$(printf '%s' "$url" | sed -E 's#^http://[^:]+:([0-9]+)/.*#\1#')/"
  echo "  open the tokenized address stored in $PREVIEW_DIR/private/dsh-url (0600)"
  echo "Demo workspace: $demo"
}

stop() {
  tm kill-session -t dsh 2>/dev/null || true
  tm kill-session -t hmz-web 2>/dev/null || true  # left by older previews
  echo "preview stopped (hmz daemon hosts started by flows keep running, by design)"
}

status() {
  tm ls 2>/dev/null || echo "no preview tmux server"
  [ -f "$PREVIEW_DIR/private/dsh-url" ] && echo "url file: $PREVIEW_DIR/private/dsh-url"
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  prepare) prepare ;;
  *) echo "usage: $0 start|stop|status|prepare" >&2; exit 2 ;;
esac
