#!/usr/bin/env zsh
# Stop one configuration's stack and check nothing of it still listens. Usage: stop-stack.sh <none|off|timeline|observation>
source ${0:A:h}/lib/env.sh || exit
emv_use_stack $1 || exit
[[ -f $EMV_STACK/pids ]] && for pid in $(<$EMV_STACK/pids); do kill $pid 2>/dev/null; done
ports=($EMV_WORKER_PORT $EMV_GATEWAY_PORT $EMV_TEE_ANTHROPIC_PORT $EMV_TEE_CODEX_PORT)
# The worker may fork; anything still listening on this stack's own ports is this stack's.
for i in {1..20}; do
  left=(); for p in $ports; do left+=($(lsof -nP -t -iTCP:$p -sTCP:LISTEN 2>/dev/null)); done
  (( ${#left} == 0 )) && break
  kill $left 2>/dev/null; sleep 0.5
done
(( ${#left} == 0 )) || { echo "stack $1: still listening after stop: pids ${left[*]}" >&2; exit 1; }
: > $EMV_STACK/pids
echo "stack $1 stopped (ports ${ports[*]} free)"
