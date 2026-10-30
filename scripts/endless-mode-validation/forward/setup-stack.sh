#!/usr/bin/env zsh
# Build one configuration's isolated stack. Usage: setup-stack.sh <none|off|timeline|observation>
#   none        claude-mem fully off: the agent talks straight to its tee (no gateway, no worker)
#   off         claude-mem on (gateway with memory injection, durable header and wire capture into the worker), Endless off
#   timeline    the above plus Endless Mode, row format `timeline`
#   observation the above plus Endless Mode, row format `observation`
# No plugin, hooks or MCP server are installed in the agent: the gateway does the capture.
set -e
source ${0:A:h}/lib/env.sh
emv_use_stack $1
mkdir -p $EMV_STACK/{data,proj,logs/turns,bin,tee-anthropic,tee-codex,tee-observer} $HOME/.claude-mem $XDG_CONFIG_HOME $XDG_DATA_HOME $XDG_CACHE_HOME $XDG_STATE_HOME $CLAUDE_CONFIG_DIR

row_format=$([[ $1 == observation ]] && echo observation || echo timeline)
if [[ $EMV_MODEL_PROFILE == openrouter-deepseek-flash ]]; then
  # The observer on claude-mem's openrouter provider and the same model; the key is given to the worker in its
  # environment at start (start-stack.sh), never written here. No quota fallback to a Claude plan.
  observer_settings=$(jq -n --arg m "$EMV_OPENROUTER_MODEL" '{CLAUDE_MEM_PROVIDER: "openrouter", CLAUDE_MEM_OPENROUTER_MODEL: $m,
    CLAUDE_MEM_OPENROUTER_BASE_URL: "", CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER: "off"}')
else
  observer_settings=$(jq -n --arg m "${EMV_OBSERVER_MODEL:-}" '{CLAUDE_MEM_PROVIDER: "claude"} + (if $m == "" then {} else {CLAUDE_MEM_MODEL: $m} end)')
fi
jq -n --arg wp $EMV_WORKER_PORT --arg gp $EMV_GATEWAY_PORT --arg fmt $row_format --arg tw "$CLAUDE_MEM_DATA_DIR/transcript-watch.json" \
  --argjson observer "$observer_settings" '{
  CLAUDE_MEM_WORKER_PORT: $wp, CLAUDE_MEM_WORKER_HOST: "127.0.0.1",
  CLAUDE_MEM_WIRE_GATEWAY_PORT: $gp, CLAUDE_MEM_WIRE_GATEWAY_HOST: "127.0.0.1",
  CLAUDE_MEM_WIRE_GATEWAY_AUTOSTART: "false",
  CLAUDE_MEM_WIRE_GATEWAY_FORWARD_SUBSCRIPTION_SIGNINS: "true",
  CLAUDE_MEM_WIRE_GATEWAY_ENDLESS_MODE: "true",
  CLAUDE_MEM_WIRE_GATEWAY_ENDLESS_ROW_FORMAT: $fmt,
  CLAUDE_MEM_WIRE_GATEWAY_MEMORY_INJECTION: "true",
  CLAUDE_MEM_WIRE_GATEWAY_DURABLE_HEADER: "true",
  CLAUDE_MEM_LOG_LEVEL: "DEBUG",
  CLAUDE_MEM_CHROMA_ENABLED: "false",
  CLAUDE_MEM_TRANSCRIPTS_ENABLED: "false",
  CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH: $tw,
  CLAUDE_MEM_TELEGRAM_ENABLED: "false",
  CLAUDE_MEM_GROK_BOT_AWARENESS_ENABLED: "false",
  CLAUDE_MEM_GROK_BOT_INJECT_ENABLED: "false",
  CLAUDE_MEM_CLOUD_SYNC_WS: "false",
  CLAUDE_MEM_WORK_VIEW_AUTO_REFRESH: "false"
} + $observer' > $CLAUDE_MEM_DATA_DIR/settings.json
# Any homedir()-relative claude-mem setting resolves into the sandbox HOME: give it the same settings.
cp $CLAUDE_MEM_DATA_DIR/settings.json $HOME/.claude-mem/settings.json
# EMV_OBSERVER_TEE=1: claude-mem re-injects ANTHROPIC_BASE_URL (and ANTHROPIC_AUTH_TOKEN) from its .env into the
# observer's spawn. With a base URL it never injects the login itself, so the token is a placeholder the observer tee
# swaps for the real one (start-stack.sh); nothing secret is written.
if [[ $EMV_OBSERVER_TEE == 1 && $EMV_MODEL_PROFILE == anthropic && $1 != none ]]; then
  for d in $CLAUDE_MEM_DATA_DIR $HOME/.claude-mem; do
    print -r -- "ANTHROPIC_BASE_URL=http://127.0.0.1:$EMV_TEE_OBSERVER_PORT" > $d/.env
    [[ $EMV_HOST_AUTH == 1 ]] || print -r -- "ANTHROPIC_AUTH_TOKEN=emv-tee-injects-claude-token" >> $d/.env
  done
fi
# Optional My Rules for the durable header (EMV_MY_RULES=<file>); our reported runs had none.
[[ -n $EMV_MY_RULES ]] && cp $EMV_MY_RULES $CLAUDE_MEM_DATA_DIR/MY-RULES.md

# Shims: nothing in the sandbox may reach the real launchd or systemd.
for svc in launchctl systemctl; do
  print -r -- '#!/bin/sh
echo "$(date -u +%FT%TZ) '$svc' $*" >> "$(dirname "$0")/../logs/service-shim.log"
exit 0' > $EMV_STACK/bin/$svc
  chmod +x $EMV_STACK/bin/$svc
done

# Claude Code: sandbox config dir, base URL at the gateway route (or the tee for `none`), thinking on, no plugins.
claude_base=$([[ $1 == none ]] && echo "http://127.0.0.1:$EMV_TEE_ANTHROPIC_PORT" || echo "http://127.0.0.1:$EMV_GATEWAY_PORT/r/claude-code")
claude_env=$(jq -n --arg b $claude_base '{ANTHROPIC_BASE_URL: $b, DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1"}')
if [[ $EMV_MODEL_PROFILE == openrouter-deepseek-flash ]]; then
  # Every model slot Claude Code may pick (main, background, subagent) on the same model (OpenRouter's guide).
  claude_env=$(jq --arg m "$EMV_OPENROUTER_MODEL" '. + {ANTHROPIC_DEFAULT_OPUS_MODEL: $m, ANTHROPIC_DEFAULT_SONNET_MODEL: $m,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: $m, CLAUDE_CODE_SUBAGENT_MODEL: $m}' <<< $claude_env)
fi
jq -n --argjson env "$claude_env" '{env: $env, alwaysThinkingEnabled: true, permissions: {defaultMode: "bypassPermissions"}}' \
  > $CLAUDE_CONFIG_DIR/settings.json

# Codex: minimal config (no hooks, plugins, MCP or notify), base URL at the gateway route (or the tee for `none`).
if [[ $EMV_AGENT == codex ]]; then
  mkdir -p $CODEX_HOME
  codex_base=$([[ $1 == none ]] && echo "http://127.0.0.1:$EMV_TEE_CODEX_PORT" || echo "http://127.0.0.1:$EMV_GATEWAY_PORT/r/codex")
  cat > $CODEX_HOME/config.toml <<TOML
model = "$EMV_CODEX_MODEL"
model_reasoning_effort = "low"
openai_base_url = "$codex_base"

[features]
hooks = false
plugin_hooks = false

[projects."$EMV_STACK/proj"]
trust_level = "trusted"
TOML
  # A copy of your Codex login (read only). last_refresh=now keeps the sandboxed Codex from refreshing it during
  # the run: a refresh would rotate the refresh token your real Codex holds.
  [[ -f $EMV_REAL_CODEX_HOME/auth.json ]] || { echo "no Codex login at $EMV_REAL_CODEX_HOME/auth.json (run \`codex login\`)" >&2; exit 3; }
  jq --arg now "$(date -u +%Y-%m-%dT%H:%M:%S.000000Z)" '.last_refresh=$now' $EMV_REAL_CODEX_HOME/auth.json > $CODEX_HOME/auth.json
  chmod 600 $CODEX_HOME/auth.json
fi
echo "stack $1 set up: worker $EMV_WORKER_PORT, gateway $EMV_GATEWAY_PORT, tees $EMV_TEE_ANTHROPIC_PORT/$EMV_TEE_CODEX_PORT, row format $row_format, profile $EMV_MODEL_PROFILE"
