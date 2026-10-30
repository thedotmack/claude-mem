#!/usr/bin/env zsh
# Start one configuration's tee(s), worker and gateway from this checkout's source, and its route.
# Usage: start-stack.sh <none|off|timeline|observation>
source ${0:A:h}/lib/env.sh || exit
source $EMV_FORWARD_DIR/lib/claude-token.sh
emv_use_stack $1 || exit
emv_check_profile || exit
L=$EMV_STACK/logs; pids=$EMV_STACK/pids; : >> $pids
for p in $EMV_WORKER_PORT $EMV_GATEWAY_PORT $EMV_TEE_ANTHROPIC_PORT $EMV_TEE_CODEX_PORT $EMV_TEE_OBSERVER_PORT; do
  lsof -nP -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1 && { echo "port $p is in use; set EMV_PORT_BASE to a free range" >&2; exit 2; }
done

refresh=(); [[ $EMV_MODEL_PROFILE == anthropic ]] && refresh=(--refresh-claude-token)
nohup $EMV_BUN $EMV_FORWARD_DIR/tee-proxy.ts $EMV_TEE_ANTHROPIC_PORT $(emv_anthropic_upstream) $EMV_STACK/tee-anthropic $refresh > $L/tee-anthropic.log 2>&1 &
print $! >> $pids
if [[ $EMV_AGENT == codex ]]; then
  nohup $EMV_BUN $EMV_FORWARD_DIR/tee-proxy.ts $EMV_TEE_CODEX_PORT https://chatgpt.com/backend-api/codex $EMV_STACK/tee-codex > $L/tee-codex.log 2>&1 &
  print $! >> $pids
fi

observer_tee=0; [[ $EMV_OBSERVER_TEE == 1 && $EMV_MODEL_PROFILE == anthropic && $1 != none ]] && observer_tee=1
if (( observer_tee )); then
  inject=(); [[ $EMV_HOST_AUTH == 1 ]] || inject=(--inject-claude-token)
  nohup $EMV_BUN $EMV_FORWARD_DIR/tee-proxy.ts $EMV_TEE_OBSERVER_PORT $(emv_anthropic_upstream) $EMV_STACK/tee-observer $inject > $L/tee-observer.log 2>&1 &
  print $! >> $pids
fi

if [[ $1 != none ]]; then
  # The observer's credential goes into the worker's environment only.
  (
    if [[ $EMV_MODEL_PROFILE == openrouter-deepseek-flash ]]; then export CLAUDE_MEM_OPENROUTER_API_KEY=$EMV_OPENROUTER_KEY
    else emv_read_claude_token || exit; [[ -n $EMV_CLAUDE_TOKEN ]] && export CLAUDE_CODE_OAUTH_TOKEN=$EMV_CLAUDE_TOKEN; fi
    cd $CLAUDE_MEM_DATA_DIR && nohup $EMV_BUN $EMV_REPO_ROOT/src/services/worker-service.ts --daemon > $L/worker.log 2>&1 &
    print $! >> $pids
  )
  nohup $EMV_BUN $EMV_REPO_ROOT/src/services/wire-gateway/WireGatewayService.ts start --foreground > $L/gateway.log 2>&1 &
  print $! >> $pids
fi

# Wait for everything to listen (60 x 0.5 s: the worker's first start migrates a new database, measured at a few seconds).
wanted=($EMV_TEE_ANTHROPIC_PORT); [[ $EMV_AGENT == codex ]] && wanted+=($EMV_TEE_CODEX_PORT)
[[ $1 != none ]] && wanted+=($EMV_WORKER_PORT $EMV_GATEWAY_PORT)
(( observer_tee )) && wanted+=($EMV_TEE_OBSERVER_PORT)
for i in {1..60}; do
  up=0; for p in $wanted; do lsof -nP -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1 && (( up++ )); done
  (( up == ${#wanted} )) && break; sleep 0.5
done
(( up == ${#wanted} )) || { echo "stack $1 did not start (${up}/${#wanted} ports listening); logs in $L" >&2; exit 1; }

if [[ $1 != none ]]; then
  endless=$([[ $1 == off ]] && echo off || echo on)
  route=$([[ $EMV_AGENT == codex ]] && echo codex || echo claude-code)
  tee_port=$([[ $EMV_AGENT == codex ]] && echo $EMV_TEE_CODEX_PORT || echo $EMV_TEE_ANTHROPIC_PORT)
  emv_gateway routes remove $route >/dev/null 2>&1
  emv_gateway routes add $route --agent $route --upstream http://127.0.0.1:$tee_port --capture wire >> $L/routes.log 2>&1 \
    || { echo "routes add failed; see $L/routes.log" >&2; exit 1; }
  emv_gateway routes endless $route $endless >> $L/routes.log 2>&1 || { echo "routes endless failed; see $L/routes.log" >&2; exit 1; }
fi
echo "stack $1 up: ports ${wanted[*]} (profile $EMV_MODEL_PROFILE, agent $EMV_AGENT)"
