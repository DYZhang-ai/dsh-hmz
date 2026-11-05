#!/usr/bin/env bash
# Isolated preview of the @dsh-hmz/flow plugin on an installed DSH and hmz.
#
#   scripts/preview.sh start   # start isolated hmz web + DSH web (in tmux), print the URL
#   scripts/preview.sh stop    # stop only the preview tmux sessions
#   scripts/preview.sh status
#
# Nothing here touches ~/.dsh, ~/.hmz or the global hmz daemon: DSH gets its own
# DSH_HOME, hmz gets its own HUMANIZE_HOME and TMPDIR (so its own daemon socket).
#
# Inputs (environment, with defaults that suit this machine):
#   DSH_BIN       installed dsh launcher
#   HMZ_BIN       installed hmz launcher (the venv beside it supplies Python)
#   PREVIEW_DIR   where the isolated homes, logs and demo workspace live
#   PREVIEW_TMUX  tmux socket name (separate server, so user sessions are untouched)
set -euo pipefail

here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
pkg="$here/packages/dsh-hmz-flow"
DSH_BIN=${DSH_BIN:-/root/artifacts/hmz-installed-dsh-20261104/external-dsh-launch}
HMZ_BIN=${HMZ_BIN:-"/root/artifacts/hmz-installed-dsh-20261104/test install/bin/hmz"}
PREVIEW_DIR=${PREVIEW_DIR:-"$here/.preview"}
PREVIEW_TMUX=${PREVIEW_TMUX:-dsh-hmz-preview}
PROFILE=${PREVIEW_PROFILE:-hmzflow}

dsh_home="$PREVIEW_DIR/dsh-home"
hmz_home="$PREVIEW_DIR/hmz-home"
hmz_tmp="$PREVIEW_DIR/tmp"
demo="$PREVIEW_DIR/demo"
logs="$PREVIEW_DIR/logs"
profile_dir="$dsh_home/profiles/$PROFILE"
hmz_url_file="$PREVIEW_DIR/private/hmz-web-url"

tm() { tmux -L "$PREVIEW_TMUX" "$@"; }

prepare() {
  mkdir -p "$dsh_home" "$hmz_home" "$hmz_tmp" "$demo" "$logs" "$PREVIEW_DIR/private" "$profile_dir/node_modules/@dsh-hmz"
  chmod 700 "$PREVIEW_DIR/private" "$hmz_tmp"
  [ -d "$demo/.git" ] || (cd "$demo" && git init -q && echo "# demo" > README.md && git add README.md && git -c user.email=demo@example -c user.name=demo commit -qm init)
  hmz_python="$(cd "$(dirname "$HMZ_BIN")/.." && pwd -P)/venv/bin/python"
  [ -x "$hmz_python" ] || { echo "no hmz venv python at $hmz_python" >&2; exit 1; }
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
    hmzWebUrlFile: '$hmz_url_file'
    stateDir: '$PREVIEW_DIR/state'
    hmzEnv:
      HUMANIZE_HOME: '$hmz_home'
      TMPDIR: '$hmz_tmp'
# Preview only: skip the one-time welcome notice so browser probes reach the UI.
- id: ui-settings-general
  name: '@deepseek-ai/dsh-client-ui-settings-general'
  config:
    welcomeNoticeVersion: 2026-09-28.1
YAML
}

start() {
  prepare
  if ! tm has-session -t hmz-web 2>/dev/null; then
    rm -f "$hmz_url_file"
    # hmz web prints its keyed address once; keep it only in a 0600 file.
    tm new-session -d -s hmz-web -c "$demo" \
      "umask 077; export HUMANIZE_HOME='$hmz_home' TMPDIR='$hmz_tmp'; '$HMZ_BIN' web --no-open --port 0 > '$hmz_url_file' 2> '$logs/hmz-web.err'"
  fi
  for _ in $(seq 1 100); do grep -q 'key=' "$hmz_url_file" 2>/dev/null && break; sleep 0.2; done
  grep -q 'key=' "$hmz_url_file" || { echo "hmz web did not print its address; see $logs/hmz-web.err" >&2; exit 1; }
  if ! tm has-session -t dsh 2>/dev/null; then
    tm new-session -d -s dsh -c "$demo" \
      "export DSH_HOME='$dsh_home' DSH_TELEMETRY_DISABLED=1; '$DSH_BIN' --profile '$PROFILE' --host 127.0.0.1 --port \${DSH_PORT:-0} --no-open > '$logs/dsh.out' 2> '$logs/dsh.err'"
  fi
  for _ in $(seq 1 150); do grep -q 'token=' "$logs/dsh.out" 2>/dev/null && break; sleep 0.2; done
  url=$(grep -o 'http://[^ ]*token=[^ ]*' "$logs/dsh.out" | head -1 || true)
  [ -n "$url" ] || { echo "DSH did not print its URL; see $logs/dsh.out and $logs/dsh.err" >&2; exit 1; }
  umask 077; printf '%s\n' "$url" > "$PREVIEW_DIR/private/dsh-url"
  echo "DSH preview URL (contains a launch token; also in $PREVIEW_DIR/private/dsh-url):"
  echo "  $url"
  echo "Demo workspace: $demo"
}

stop() {
  tm kill-session -t dsh 2>/dev/null || true
  tm kill-session -t hmz-web 2>/dev/null || true
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
