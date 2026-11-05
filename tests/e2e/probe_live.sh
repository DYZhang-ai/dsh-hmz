#!/usr/bin/env bash
# Independent HTTP probes against the running preview (no browser, no credentials).
# usage: probe_live.sh <dsh-port> <proxy-port>
set -u
dsh=$1; px=$2; fail=0
expect() { local want=$1 got=$2 what=$3; if [ "$got" = "$want" ]; then echo "PASS $what ($got)"; else echo "FAIL $what (want $want, got $got)"; fail=1; fi; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
expect 401 "$(code -X POST -H 'content-type: application/json' -d '{"op":"embed","sessionId":"x"}' http://127.0.0.1:$dsh/api/hmz-flow/rpc)" 'DSH plugin route refuses a request without the DSH browser cookie'
expect 401 "$(code http://127.0.0.1:$px/)" 'embed proxy refuses a page without a proxy session'
expect 401 "$(code http://127.0.0.1:$px/api/held)" 'embed proxy refuses the hmz API without a proxy session'
expect 403 "$(code "http://127.0.0.1:$px/__dsh_hmz/enter?ticket=guess")" 'embed proxy refuses a guessed ticket'
expect 421 "$(code -H 'Host: attacker.example' http://127.0.0.1:$px/)" 'embed proxy refuses a foreign Host (DNS rebinding)'
expect 403 "$(code -H 'Sec-Fetch-Site: cross-site' http://127.0.0.1:$px/)" 'embed proxy refuses cross-site requests'
exit $fail
