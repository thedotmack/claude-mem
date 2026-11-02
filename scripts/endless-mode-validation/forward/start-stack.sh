#!/usr/bin/env zsh
# Start one configuration's tee(s), worker and gateway from this checkout's source, and its route. `release` starts
# its tee and the installed release's own worker (no gateway, no route).
# Usage: start-stack.sh <none|off|timeline|observation|release>
source ${0:A:h}/lib/env.sh || exit
source $EMV_FORWARD_DIR/lib/claude-token.sh
emv_use_stack $1 || exit
emv_check_profile || exit
L=$EMV_STACK/logs; pids=$EMV_STACK/pids; : >> $pids
for p in $EMV_WORKER_PORT $EMV_GATEWAY_PORT $EMV_TEE_ANTHROPIC_PORT $EMV_TEE_CODEX_PORT; do
  lsof -nP -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1 && { echo "port $p is in use; set EMV_PORT_BASE to a free range" >&2; exit 2; }
done

refresh=(); [[ $EMV_MODEL_PROFILE == anthropic ]] && refresh=(--refresh-claude-token)
pin=(); [[ $EMV_MODEL_PROFILE == openrouter-deepseek-flash ]] && pin=(--pin-provider=$(emv_pin_provider) --pin-model=$EMV_OPENROUTER_MODEL)
nohup $EMV_BUN $EMV_FORWARD_DIR/tee-proxy.ts $EMV_TEE_ANTHROPIC_PORT $(emv_anthropic_upstream) $EMV_STACK/tee-anthropic $refresh $pin > $L/tee-anthropic.log 2>&1 &
print $! >> $pids
if [[ $EMV_AGENT == codex ]]; then
  nohup $EMV_BUN $EMV_FORWARD_DIR/tee-proxy.ts $EMV_TEE_CODEX_PORT https://chatgpt.com/backend-api/codex $EMV_STACK/tee-codex > $L/tee-codex.log 2>&1 &
  print $! >> $pids
fi

if [[ $1 == release ]]; then
  # The installed version must still be the one set up (nothing in the sandbox may have updated it).
  root=$(emv_release_plugin_root) || exit
  installed=$(jq -r .version $root/.claude-plugin/plugin.json)
  [[ $installed == $(<$EMV_STACK/release-version.txt) ]] || { echo "release: installed plugin is $installed, set up was $(<$EMV_STACK/release-version.txt)" >&2; exit 1; }
fi
if [[ $1 != none ]]; then
  # The observer's credential goes into the worker's environment only.
  (
    if [[ $EMV_MODEL_PROFILE == openrouter-deepseek-flash ]]; then export CLAUDE_MEM_OPENROUTER_API_KEY=$EMV_OPENROUTER_KEY
    else emv_read_claude_token || exit; export CLAUDE_CODE_OAUTH_TOKEN=$EMV_CLAUDE_TOKEN; fi
    emv_start_worker
  )
fi
if [[ $1 != none && $1 != release ]]; then
  nohup $EMV_BUN $EMV_REPO_ROOT/src/services/wire-gateway/WireGatewayService.ts start --foreground > $L/gateway.log 2>&1 &
  print $! >> $pids
fi

# Wait for everything to listen (60 x 0.5 s: the worker's first start migrates a new database, measured at a few seconds).
wanted=($EMV_TEE_ANTHROPIC_PORT); [[ $EMV_AGENT == codex ]] && wanted+=($EMV_TEE_CODEX_PORT)
[[ $1 != none ]] && wanted+=($EMV_WORKER_PORT)
[[ $1 != none && $1 != release ]] && wanted+=($EMV_GATEWAY_PORT)
for i in {1..60}; do
  up=0; for p in $wanted; do lsof -nP -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1 && (( up++ )); done
  (( up == ${#wanted} )) && break; sleep 0.5
done
(( up == ${#wanted} )) || { echo "stack $1 did not start (${up}/${#wanted} ports listening); logs in $L" >&2; exit 1; }

if [[ $1 != none && $1 != release ]]; then
  endless=$([[ $1 == off ]] && echo off || echo on)
  route=$(case $EMV_AGENT in codex) echo codex ;; hermes|openclaw) echo $EMV_AGENT ;; *) echo claude-code ;; esac)
  tee_port=$([[ $EMV_AGENT == codex ]] && echo $EMV_TEE_CODEX_PORT || echo $EMV_TEE_ANTHROPIC_PORT)
  emv_gateway routes remove $route >/dev/null 2>&1
  emv_gateway routes add $route --agent $route --upstream http://127.0.0.1:$tee_port --capture wire >> $L/routes.log 2>&1 \
    || { echo "routes add failed; see $L/routes.log" >&2; exit 1; }
  emv_gateway routes endless $route $endless >> $L/routes.log 2>&1 || { echo "routes endless failed; see $L/routes.log" >&2; exit 1; }
fi
echo "stack $1 up: ports ${wanted[*]} (profile $EMV_MODEL_PROFILE, agent $EMV_AGENT)"
