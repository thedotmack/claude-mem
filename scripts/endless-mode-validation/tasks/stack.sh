#!/usr/bin/env bash
# Start one arm's isolated stack for the task benchmark (bash only; no zsh, keychain or launchd needed).
# Usage: stack.sh start|stop <plain|claudemem|endless> <arm dir> <port base>
#   plain      Claude Code -> agent tee -> api.anthropic.com (claude-mem fully off)
#   claudemem  regular claude-mem, no wire gateway: Claude Code -> agent tee -> api.anthropic.com, with claude-mem's
#              Claude Code hooks (context at start, observations, summaries) feeding a worker whose observer is sent
#              through its own tee (observer-tee). Memory is written and injected; the agent's context is not trimmed.
#   endless  Claude Code -> wire gateway (memory injection, durable header, Endless Mode on) -> agent tee -> upstream,
#            plus a claude-mem worker whose observer is sent through its own tee (observer-tee), so its tokens count
#            in Endless Mode's cost.
# Ports: base = agent tee, base+1 = worker, base+2 = gateway, base+3 = observer tee.
# Everything lives under <arm dir>; nothing touches the real ~/.claude or ~/.claude-mem.
# Credentials: the observer is given your Claude Code login through its tee (tee-proxy.ts --inject-claude-token, read
# only, never written). With no login found (EMV_CLAUDE_OAUTH_TOKEN, the macOS keychain or ~/.claude/.credentials.json)
# the observer is started without one, which works only where the host supplies credentials itself.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd); repo=$(cd "$here/../../.." && pwd)
action=$1 arm=$2 dir=$3 base=${4:-0}
mkdir -p "$dir"; dir=$(cd "$dir" && pwd)  # absolute: the worker starts from inside the data dir
BUN=${EMV_BUN:-$(command -v bun)}
UPSTREAM=${EMV_UPSTREAM:-https://api.anthropic.com}
tee_port=$base worker_port=$((base + 1)) gateway_port=$((base + 2)) obs_port=$((base + 3))
pids=$dir/pids

if [[ $action == stop ]]; then
  [[ -f $pids ]] && while read -r p; do kill "$p" 2>/dev/null || true; done < "$pids"
  rm -f "$pids"; exit 0
fi

mkdir -p "$dir"/{data,home/.claude-mem,claude-config,proj,logs,tee,observer-tee}
# The real login's location, for the observer tee's read-only token lookup (tee-proxy.ts readClaudeAccessToken).
export EMV_REAL_HOME=${EMV_REAL_HOME:-$HOME} EMV_REAL_USER=${EMV_REAL_USER:-$(id -un)}
export EMV_REAL_CLAUDE_DIR=${EMV_REAL_CLAUDE_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}}
has_login=0
"$BUN" -e "import { readClaudeAccessToken } from '$repo/scripts/endless-mode-validation/forward/tee-proxy.ts'; process.exit(readClaudeAccessToken() ? 0 : 1)" \
  > /dev/null 2>&1 && has_login=1
export HOME=$dir/home CLAUDE_CONFIG_DIR=$dir/claude-config CLAUDE_MEM_DATA_DIR=$dir/data DO_NOT_TRACK=1
unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDECODE
for v in $(compgen -e | grep -E '^CLAUDE_CODE_' || true); do unset "$v"; done
: > "$pids"

"$BUN" "$repo/scripts/endless-mode-validation/forward/tee-proxy.ts" $tee_port "$UPSTREAM" "$dir/tee" > "$dir/logs/tee.log" 2>&1 &
echo $! >> "$pids"
agent_base=http://127.0.0.1:$tee_port

if [[ $arm == endless || $arm == claudemem ]]; then
  gateway=$([[ $arm == endless ]] && echo true || echo false)
  row_format=${EMV_ROW_FORMAT:-timeline}
  # The observer's model: claude-mem's default unless EMV_OBSERVER_MODEL is set.
  obs_model=${EMV_OBSERVER_MODEL:-$(grep -o "CLAUDE_MEM_MODEL: '[^']*'" "$repo/src/shared/SettingsDefaultsManager.ts" | head -1 | cut -d"'" -f2)}
  jq -n --arg wp $worker_port --arg gp $gateway_port --arg fmt "$row_format" --arg obs_model "$obs_model" --arg gw $gateway '{
    CLAUDE_MEM_WORKER_PORT: $wp, CLAUDE_MEM_WORKER_HOST: "127.0.0.1",
    CLAUDE_MEM_WIRE_GATEWAY_PORT: $gp, CLAUDE_MEM_WIRE_GATEWAY_HOST: "127.0.0.1",
    CLAUDE_MEM_WIRE_GATEWAY_AUTOSTART: "false",
    CLAUDE_MEM_WIRE_GATEWAY_FORWARD_SUBSCRIPTION_SIGNINS: "true",
    CLAUDE_MEM_WIRE_GATEWAY_ENDLESS_MODE: $gw,
    CLAUDE_MEM_WIRE_GATEWAY_ENDLESS_ROW_FORMAT: $fmt,
    CLAUDE_MEM_WIRE_GATEWAY_MEMORY_INJECTION: $gw,
    CLAUDE_MEM_WIRE_GATEWAY_DURABLE_HEADER: $gw,
    CLAUDE_MEM_PROVIDER: "claude",
    CLAUDE_MEM_MODEL: $obs_model,
    CLAUDE_MEM_LOG_LEVEL: "DEBUG",
    CLAUDE_MEM_CHROMA_ENABLED: "false",
    CLAUDE_MEM_TRANSCRIPTS_ENABLED: "false",
    CLAUDE_MEM_TELEGRAM_ENABLED: "false",
    CLAUDE_MEM_GROK_BOT_AWARENESS_ENABLED: "false",
    CLAUDE_MEM_GROK_BOT_INJECT_ENABLED: "false",
    CLAUDE_MEM_CLOUD_SYNC_WS: "false",
    CLAUDE_MEM_WORK_VIEW_AUTO_REFRESH: "false"
  }' > "$CLAUDE_MEM_DATA_DIR/settings.json"
  cp "$CLAUDE_MEM_DATA_DIR/settings.json" "$HOME/.claude-mem/settings.json"
  # The observer's API base: claude-mem re-injects ANTHROPIC_BASE_URL (and ANTHROPIC_AUTH_TOKEN) from its .env into the
  # observer's spawn. With a base URL claude-mem never injects the login itself, so the token is a placeholder the
  # observer tee swaps for the real one; nothing secret is written.
  inject=()
  for d in "$CLAUDE_MEM_DATA_DIR" "$HOME/.claude-mem"; do
    echo "ANTHROPIC_BASE_URL=http://127.0.0.1:$obs_port" > "$d/.env"
    [[ $has_login == 1 ]] && echo "ANTHROPIC_AUTH_TOKEN=emv-tee-injects-claude-token" >> "$d/.env"
  done
  [[ $has_login == 1 ]] && inject=(--inject-claude-token)
  "$BUN" "$repo/scripts/endless-mode-validation/forward/tee-proxy.ts" $obs_port "$UPSTREAM" "$dir/observer-tee" ${inject[@]+"${inject[@]}"} > "$dir/logs/observer-tee.log" 2>&1 &
  echo $! >> "$pids"
  (cd "$CLAUDE_MEM_DATA_DIR" && exec "$BUN" "$repo/src/services/worker-service.ts" --daemon > "$dir/logs/worker.log" 2>&1) &
  echo $! >> "$pids"
  if [[ $arm == endless ]]; then
    "$BUN" "$repo/src/services/wire-gateway/WireGatewayService.ts" start --foreground > "$dir/logs/gateway.log" 2>&1 &
    echo $! >> "$pids"
    agent_base=http://127.0.0.1:$gateway_port/r/claude-code
  fi
fi

want=($tee_port)
[[ $arm == endless ]] && want+=($worker_port $gateway_port $obs_port)
[[ $arm == claudemem ]] && want+=($worker_port $obs_port)
for i in $(seq 1 120); do
  up=0; for p in "${want[@]}"; do (exec 3<>/dev/tcp/127.0.0.1/$p) 2>/dev/null && up=$((up + 1)); done
  [[ $up == ${#want[@]} ]] && break; sleep 0.5
done
[[ $up == ${#want[@]} ]] || { echo "stack $arm did not start ($up/${#want[@]} ports); logs in $dir/logs" >&2; exit 1; }

if [[ $arm == endless ]]; then
  gw() { "$BUN" "$repo/src/services/wire-gateway/WireGatewayService.ts" "$@"; }
  gw routes remove claude-code > /dev/null 2>&1 || true
  gw routes add claude-code --agent claude-code --upstream http://127.0.0.1:$tee_port --capture wire >> "$dir/logs/routes.log" 2>&1
  gw routes endless claude-code on >> "$dir/logs/routes.log" 2>&1
fi

# The claudemem arm's hooks: claude-mem's own Claude Code hooks (plugin/hooks/hooks.json), run from this checkout
# through a small `claude-mem` wrapper bound to this arm's data dir. Left out: `start` and ensure-launcher (the worker
# is already up) and Setup's version check (no installed plugin here).
hooks='{}'
if [[ $arm == claudemem ]]; then
  mkdir -p "$dir/bin"
  printf '#!/usr/bin/env bash\nexport CLAUDE_MEM_DATA_DIR=%q HOME=%q\nexec %q %q "$@"\n' \
    "$CLAUDE_MEM_DATA_DIR" "$HOME" "$BUN" "$repo/src/services/worker-service.ts" > "$dir/bin/claude-mem"
  chmod +x "$dir/bin/claude-mem"
  hooks=$(jq --arg cm "$dir/bin/claude-mem" '.hooks | del(.Setup)
    | with_entries(.value |= (map(.hooks |= map(select(.command == "claude-mem" and .args[0] == "hook")
        | {type, command: ([$cm] + .args | map(@sh) | join(" "))} + (if .async then {async} else {} end)
          + (if .timeout then {timeout} else {} end))) | map(select(.hooks | length > 0))))
    | with_entries(select(.value | length > 0))' "$repo/plugin/hooks/hooks.json")
fi

# Claude Code's sandbox settings: base URL, no plugins, and a narrow allowlist (file tools plus running Python in the
# scratch project). Anything else is refused, since `claude -p` cannot ask.
jq -n --arg b "$agent_base" --argjson hooks "$hooks" '{env: {ANTHROPIC_BASE_URL: $b, DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1"},
  permissions: {defaultMode: "acceptEdits", allow: ["Read", "Edit", "Write", "Glob", "Grep",
    "Bash(python3:*)", "Bash(python:*)", "Bash(pytest:*)", "Bash(ls:*)", "Bash(cat:*)"],
    deny: ["WebFetch", "WebSearch", "Bash(curl:*)", "Bash(wget:*)", "Bash(git push:*)"]}}
  + (if $hooks == {} then {} else {hooks: $hooks} end)' > "$CLAUDE_CONFIG_DIR/settings.json"
echo "$agent_base" > "$dir/agent-base-url"
echo "stack $arm up: ${want[*]} -> $agent_base"
