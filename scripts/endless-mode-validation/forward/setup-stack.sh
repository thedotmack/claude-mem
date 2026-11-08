#!/usr/bin/env zsh
# Build one configuration's isolated stack. Usage: setup-stack.sh <none|off|timeline|observation|release>
#   none        claude-mem fully off: the agent talks straight to its tee (no gateway, no worker)
#   off         claude-mem on (gateway with memory injection, durable header and wire capture into the worker), Endless off
#   timeline    the above plus Endless Mode, row format `timeline`
#   observation the above plus Endless Mode, row format `observation`
#   release     the current published claude-mem, installed the way its README says (`npx claude-mem install --ide <agent>`), into
#               this stack's HOME and Claude config dir only: plugin, hooks, its own worker, MCP search tools and
#               startup context. No gateway: the agent talks straight to its tee, as `none` does.
# The gateway configurations install no plugin, hooks or MCP server in the agent: the gateway does the capture.
set -e
source ${0:A:h}/lib/env.sh
emv_check_profile
emv_use_stack $1
mkdir -p $EMV_STACK/{data,proj,logs/turns,bin,tee-anthropic,tee-codex} $HOME/.claude-mem $XDG_CONFIG_HOME $XDG_DATA_HOME $XDG_CACHE_HOME $XDG_STATE_HOME $CLAUDE_CONFIG_DIR

row_format=$([[ $1 == observation ]] && echo observation || echo timeline)
if [[ $EMV_MODEL_PROFILE == openrouter-deepseek-flash ]]; then
  # The observer on claude-mem's openrouter provider, the same model and the same pinned endpoint; the key is given to
  # the worker in its environment at start (start-stack.sh), never written here. No quota fallback to a Claude plan.
  # Not through the tee: a local base URL turns off the observer's openrouter.ai defaults (OpenRouterProvider.ts).
  observer_settings=$(jq -n --arg m "$EMV_OPENROUTER_MODEL" --arg slug "$(emv_pin_provider)" '{CLAUDE_MEM_PROVIDER: "openrouter", CLAUDE_MEM_OPENROUTER_MODEL: $m,
    CLAUDE_MEM_OPENROUTER_BASE_URL: "", CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER: "off",
    CLAUDE_MEM_OPENROUTER_EXTRA_BODY: ({provider: {order: [$slug], allow_fallbacks: false}} | tojson)}')
else
  observer_settings='{"CLAUDE_MEM_PROVIDER": "claude"}'
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
  CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH: $tw
} + $observer' > $EMV_STACK/harness-settings.json
# Every other claude-mem setting stays at its shipped default (Chroma, transcripts, log level and the rest), so each
# setup runs claude-mem as a user gets it. Written before any installer runs, so that it reads this stack's worker port
# and observer, never defaults. A release
# has no wire gateway, so no gateway keys. Any homedir()-relative claude-mem setting resolves into the sandbox HOME: it
# gets the same settings.
write_settings() {
  [[ -f $CLAUDE_MEM_DATA_DIR/settings.json ]] || print '{}' > $CLAUDE_MEM_DATA_DIR/settings.json
  local drop=$([[ $1 == release ]] && echo true || echo false)
  jq -s --argjson drop $drop '.[0] + (.[1] | with_entries(select($drop == false or (.key | startswith("CLAUDE_MEM_WIRE_GATEWAY") | not)))) ' \
    $CLAUDE_MEM_DATA_DIR/settings.json $EMV_STACK/harness-settings.json > $EMV_STACK/settings.merged && mv $EMV_STACK/settings.merged $CLAUDE_MEM_DATA_DIR/settings.json
  cp $CLAUDE_MEM_DATA_DIR/settings.json $HOME/.claude-mem/settings.json
}
write_settings $1
# Optional My Rules for the durable header (EMV_MY_RULES=<file>); our reported runs had none.
[[ -n $EMV_MY_RULES ]] && cp $EMV_MY_RULES $CLAUDE_MEM_DATA_DIR/MY-RULES.md

# Shims: nothing in the sandbox may reach the real launchd or systemd.
for svc in launchctl systemctl; do
  # `launchctl print` answers 113, launchctl's own code for "no such service": Hermes Agent asks it at every start,
  # and a shim that "finds" the service in both domains makes Hermes refuse to run (service_scope_conflict).
  # Its one-off runtime job is refused so that Hermes starts it as a plain child (its documented fallback) that this
  # harness can see and stop, instead of "starting" a job that never ran.
  print -r -- '#!/bin/sh
echo "$(date -u +%FT%TZ) '$svc' $*" >> "$(dirname "$0")/../logs/service-shim.log"
[ "$1" = print ] && exit 113
case "$1 $3" in "bootstrap "*hermes-home*) exit 5 ;; esac
exit 0' > $EMV_STACK/bin/$svc
  chmod +x $EMV_STACK/bin/$svc
done

# Hermes / OpenClaw: sandbox config, base URL at the gateway route (or straight at the tee for `none` and `release`). No
# plugins or hooks, except what the `release` installer adds below, which is why this comes first.
if emv_is_chat_agent; then
  emv_setup_chat_agent $([[ $1 == none || $1 == release ]] && echo "http://127.0.0.1:$EMV_TEE_ANTHROPIC_PORT" || echo "http://127.0.0.1:$EMV_GATEWAY_PORT/r/$EMV_AGENT")
fi

# Codex: minimal config (no hooks, plugins, MCP or notify, except what the `release` installer adds below), base URL at
# the gateway route (or straight at the tee for `none` and `release`).
if [[ $EMV_AGENT == codex ]]; then
  mkdir -p $CODEX_HOME
  codex_base=$([[ $1 == none || $1 == release ]] && echo "http://127.0.0.1:$EMV_TEE_CODEX_PORT" || echo "http://127.0.0.1:$EMV_GATEWAY_PORT/r/codex")
  codex_hooks=$([[ $1 == release ]] && echo true || echo false)
  if [[ $EMV_MODEL_PROFILE == openrouter-deepseek-flash ]]; then
    # OpenRouter's Codex CLI guide: a model_providers block and command-based auth, no ChatGPT login. The reasoning effort
    # stays Codex's own default, as a user would get it. The key is read from Codex's environment (agent-turn.sh).
    cat > $CODEX_HOME/config.toml <<TOML
model = "$EMV_OPENROUTER_MODEL"
model_provider = "emv-openrouter"

[model_providers.emv-openrouter]
name = "emv-openrouter"
base_url = "$codex_base/v1"
wire_api = "responses"

[model_providers.emv-openrouter.auth]
command = "sh"
args = ["-c", "printf %s \"\$EMV_UPSTREAM_KEY\""]

[features]
hooks = $codex_hooks
plugin_hooks = $codex_hooks

[projects."$EMV_STACK/proj"]
trust_level = "trusted"
TOML
  else
    cat > $CODEX_HOME/config.toml <<TOML
model = "$EMV_CODEX_MODEL"
model_reasoning_effort = "low"
openai_base_url = "$codex_base"

[features]
hooks = $codex_hooks
plugin_hooks = $codex_hooks

[projects."$EMV_STACK/proj"]
trust_level = "trusted"
TOML
    # A copy of your Codex login (read only). last_refresh=now keeps the sandboxed Codex from refreshing it during
    # the run: a refresh would rotate the refresh token your real Codex holds.
    [[ -f $EMV_REAL_CODEX_HOME/auth.json ]] || { echo "no Codex login at $EMV_REAL_CODEX_HOME/auth.json (run \`codex login\`)" >&2; exit 3; }
    jq --arg now "$(date -u +%Y-%m-%dT%H:%M:%S.000000Z)" '.last_refresh=$now' $EMV_REAL_CODEX_HOME/auth.json > $CODEX_HOME/auth.json
    chmod 600 $CODEX_HOME/auth.json
  fi
  # Whatever `codex` an installer or hook runs is the real binary, never a wrapper that rewrites CODEX_HOME.
  ln -sf $EMV_CODEX_BIN $EMV_STACK/bin/codex
fi
if [[ $1 == release ]]; then
  # The published version: npm's `latest` unless EMV_RELEASE_VERSION pins one; recorded for start-stack.sh.
  version=${EMV_RELEASE_VERSION:-$(npm view claude-mem@latest version)}
  [[ $version == <->.<->.<-> ]] || { echo "release: could not resolve a claude-mem version (got '$version')" >&2; exit 2; }
  # As a user installs it (README: `npx claude-mem install`), for this agent. --provider claude only skips the cmem.ai
  # browser sign-in (every other provider waits on it, 15.9.0's installer); --no-auto-start means nothing runs until
  # start-stack.sh, by which time write_settings below has put the observer on OpenRouter (checked below). stdin from
  # /dev/null makes the installer non-interactive. DO_NOT_TRACK (emv_use_stack) turns telemetry off.
  ide=(); case $EMV_AGENT in hermes) ide=(--ide hermes) ;; openclaw) ide=(--ide openclaw) ;; codex) ide=(--ide codex-cli) ;; esac
  ( cd $EMV_STACK && npx -y claude-mem@$version install $ide --provider claude --no-auto-start < /dev/null ) > $EMV_STACK/logs/release-install.log 2>&1 \
    || { echo "release: npx claude-mem@$version install failed; see $EMV_STACK/logs/release-install.log" >&2; exit 1; }
  print -r -- $version > $EMV_STACK/release-version.txt
  root=$(emv_release_plugin_root)
  installed=$(jq -r .version $root/.claude-plugin/plugin.json)
  [[ $installed == $version ]] || { echo "release: installed plugin is $installed, wanted $version" >&2; exit 1; }
  if [[ $EMV_AGENT == claude ]]; then
    [[ -x $HOME/.local/bin/claude-mem ]] || { echo "release: the installer put no claude-mem launcher in $HOME/.local/bin" >&2; exit 1; }
    [[ $(jq -r '.enabledPlugins["claude-mem@thedotmack"]' $CLAUDE_CONFIG_DIR/settings.json) == true ]] \
      || { echo "release: the installer did not enable claude-mem@thedotmack in $CLAUDE_CONFIG_DIR/settings.json" >&2; exit 1; }
  fi
  write_settings release
  if [[ $EMV_MODEL_PROFILE == openrouter-deepseek-flash && $(jq -r .CLAUDE_MEM_PROVIDER $CLAUDE_MEM_DATA_DIR/settings.json) != openrouter ]]; then
    echo "release: the observer is not on OpenRouter after the install; refusing, so that it can never reach a Claude model" >&2; exit 1
  fi
  # The installer's work must sit where this agent reads it, pointing at this stack's worker.
  case $EMV_AGENT in
    hermes) [[ -f $HERMES_HOME/plugins/claude-mem/plugin.yaml ]] && grep -q 'provider: claude-mem' $HERMES_HOME/config.yaml \
      || { echo "release: no claude-mem memory provider in $HERMES_HOME" >&2; exit 1; } ;;
    openclaw) [[ $(jq -r '.plugins.entries["claude-mem"].config.workerPort' $OPENCLAW_CONFIG_PATH) == $EMV_WORKER_PORT ]] \
      || { echo "release: $OPENCLAW_CONFIG_PATH does not point claude-mem at this stack's worker $EMV_WORKER_PORT" >&2; exit 1; } ;;
    codex) grep -q 'claude-mem' $CODEX_HOME/config.toml || { echo "release: claude-mem is not in $CODEX_HOME/config.toml" >&2; exit 1; } ;;
  esac
fi
# Claude Code: sandbox config dir, base URL at the gateway route (or the tee for `none`), no plugins.
claude_base=$([[ $1 == none || $1 == release ]] && echo "http://127.0.0.1:$EMV_TEE_ANTHROPIC_PORT" || echo "http://127.0.0.1:$EMV_GATEWAY_PORT/r/claude-code")
claude_env=$(jq -n --arg b $claude_base '{ANTHROPIC_BASE_URL: $b, DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1"}')
if [[ $EMV_MODEL_PROFILE == openrouter-deepseek-flash ]]; then
  # Every model slot Claude Code may pick (main, background, subagent) on the same model (OpenRouter's guide).
  claude_env=$(jq --arg m "$EMV_OPENROUTER_MODEL" '. + {ANTHROPIC_DEFAULT_OPUS_MODEL: $m, ANTHROPIC_DEFAULT_SONNET_MODEL: $m,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: $m, CLAUDE_CODE_SUBAGENT_MODEL: $m}' <<< $claude_env)
fi
# `release` keeps what its installer wrote (enabledPlugins and the rest) and gets the same env and switches on top.
claude_settings=$CLAUDE_CONFIG_DIR/settings.json
[[ $1 == release && -f $claude_settings ]] || print '{}' > $claude_settings
jq --argjson env "$claude_env" --argjson excludes "$(emv_claude_md_excludes)" '. + {env: ((.env // {}) + $env), claudeMdExcludes: $excludes, permissions: ((.permissions // {}) + {defaultMode: "bypassPermissions"})}' \
  $claude_settings > $claude_settings.new && mv $claude_settings.new $claude_settings

# What ran, for the page.
case $EMV_AGENT in
  claude) $EMV_CLAUDE_BIN --version ;;
  codex) $EMV_CODEX_BIN --version ;;
  hermes) git -C ${EMV_HERMES_BIN:h:h:h} rev-parse --short HEAD ;;
  openclaw) PATH=${EMV_OPENCLAW_NODE_DIR:+$EMV_OPENCLAW_NODE_DIR:}$PATH $EMV_OPENCLAW_BIN --version ;;
esac > $EMV_STACK/agent-version.txt 2>/dev/null || echo unknown > $EMV_STACK/agent-version.txt
echo "stack $1 set up$([[ $1 == release ]] && echo " (claude-mem $(<$EMV_STACK/release-version.txt), installed with npx)"): worker $EMV_WORKER_PORT, gateway $EMV_GATEWAY_PORT, tees $EMV_TEE_ANTHROPIC_PORT/$EMV_TEE_CODEX_PORT, row format $row_format, profile $EMV_MODEL_PROFILE"
