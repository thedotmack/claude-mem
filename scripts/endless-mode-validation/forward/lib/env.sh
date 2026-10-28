# Source me (zsh). Shared settings for the forward harness: real agents through isolated claude-mem stacks.
#
# Every path is under the repo or set by an env var. Nothing here writes to the contributor's real ~/.claude,
# ~/.codex or claude-mem data dir: each configuration gets its own HOME, CLAUDE_CONFIG_DIR, CODEX_HOME, XDG dirs,
# CLAUDE_MEM_DATA_DIR and a launchctl/systemctl shim on PATH. Credentials are read from the contributor's own login,
# read only, and passed to the agent in its environment; they are never printed or written to disk.
#
# Env you may set (defaults in brackets):
#   EMV_RUN_NAME        name of this run [run-<date>]
#   EMV_RUN_DIR         where the run lives [<repo>/.scratch/endless-mode-validation/forward/<run name>] (.scratch is gitignored)
#   EMV_AGENT           claude | codex [claude]
#   EMV_MODEL_PROFILE   anthropic | openrouter-deepseek-flash [anthropic]; see lib/model-profile.sh
#   EMV_CLAUDE_MODEL    Claude Code model under the anthropic profile [claude-opus-5-5]
#   EMV_CODEX_MODEL     Codex model [gpt-6.1-sol]
#   EMV_CLAUDE_BIN / EMV_CODEX_BIN   the real agent binaries [command -v claude / codex]. Point these past any wrapper
#                       script that rewrites CLAUDE_CONFIG_DIR or HOME, or the isolation does not hold.
#   EMV_PORT_BASE       first port; configuration i uses EMV_PORT_BASE + 10*i .. +3 [38100]

typeset -g EMV_FORWARD_DIR=${0:A:h:h}  # sourced at top level: zsh sets $0 to this file
typeset -g EMV_REPO_ROOT=${EMV_FORWARD_DIR:h:h:h}

# The contributor's real home, captured once; every child inherits it. A sandboxed HOME without it means a script
# was started from inside a stack, where "the real home" cannot be known.
if [[ -z $EMV_REAL_HOME ]]; then
  if [[ $HOME == */endless-mode-validation/forward/*/stacks/* ]]; then
    echo "env.sh: HOME is a sandbox ($HOME) and EMV_REAL_HOME is unset; start from your normal shell" >&2; return 2
  fi
  export EMV_REAL_HOME=$HOME
  export EMV_REAL_CLAUDE_DIR=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
  export EMV_REAL_CODEX_HOME=${CODEX_HOME:-$HOME/.codex}
  export EMV_REAL_CLAUDE_MEM_DIR=${CLAUDE_MEM_DATA_DIR:-$HOME/.claude-mem}
  export EMV_REAL_USER=$(id -un)
  export EMV_REAL_PATH=$PATH
fi

export EMV_RUN_NAME=${EMV_RUN_NAME:-run-$(date +%Y%m%d-%H%M%S)}
export EMV_RUN_DIR=${EMV_RUN_DIR:-$EMV_REPO_ROOT/.scratch/endless-mode-validation/forward/$EMV_RUN_NAME}
export EMV_AGENT=${EMV_AGENT:-claude}
export EMV_MODEL_PROFILE=${EMV_MODEL_PROFILE:-anthropic}
export EMV_CLAUDE_MODEL=${EMV_CLAUDE_MODEL:-claude-opus-5-5}
export EMV_CODEX_MODEL=${EMV_CODEX_MODEL:-gpt-6.1-sol}
export EMV_CLAUDE_BIN=${EMV_CLAUDE_BIN:-$(PATH=$EMV_REAL_PATH command -v claude)}
export EMV_CODEX_BIN=${EMV_CODEX_BIN:-$(PATH=$EMV_REAL_PATH command -v codex)}
export EMV_PORT_BASE=${EMV_PORT_BASE:-38100}
export EMV_PROMPTS=${EMV_PROMPTS:-$EMV_FORWARD_DIR/prompts200.txt}
export EMV_BUN=${EMV_BUN:-$(PATH=$EMV_REAL_PATH command -v bun)}
# Stop before a turn when free disk drops below this many GB. Reason: disk protection. The tee writes every
# request body and response stream, and a full disk would corrupt the sandbox databases mid-run. 5 GB is the stop
# our own runs used (free disk never went below 11 GB in our 200-turn, four-configuration run).
export EMV_MIN_FREE_GB=${EMV_MIN_FREE_GB:-5}

# The four configurations, in a fixed order (their index sets their ports).
typeset -ga EMV_ALL_CONFIGS=(none off timeline observation)
typeset -gA EMV_CONFIG_LABEL=(none 'claude-mem off' off 'claude-mem on, Endless off' timeline 'Endless `timeline`' observation 'Endless `observation`')

# Ports of configuration $1: worker, gateway, Anthropic-side tee, Codex-side tee.
emv_ports() {
  local i=${EMV_ALL_CONFIGS[(i)$1]}
  (( i > ${#EMV_ALL_CONFIGS} )) && { echo "unknown configuration '$1' (one of: ${EMV_ALL_CONFIGS[*]})" >&2; return 2; }
  local base=$(( EMV_PORT_BASE + 10 * (i - 1) ))
  typeset -g EMV_WORKER_PORT=$base EMV_GATEWAY_PORT=$((base + 1)) EMV_TEE_ANTHROPIC_PORT=$((base + 2)) EMV_TEE_CODEX_PORT=$((base + 3))
}

# Switch this shell into configuration $1's sandbox.
emv_use_stack() {
  emv_ports $1 || return
  export EMV_CONFIG=$1
  export EMV_STACK=$EMV_RUN_DIR/stacks/$1
  export EMV_WORKER_PORT EMV_GATEWAY_PORT EMV_TEE_ANTHROPIC_PORT EMV_TEE_CODEX_PORT
  export CLAUDE_MEM_DATA_DIR=$EMV_STACK/data HOME=$EMV_STACK/home CLAUDE_CONFIG_DIR=$EMV_STACK/claude-config CODEX_HOME=$EMV_STACK/codex-home
  export XDG_CONFIG_HOME=$HOME/.config XDG_DATA_HOME=$HOME/.local/share XDG_CACHE_HOME=$HOME/.cache XDG_STATE_HOME=$HOME/.local/state
  # Package caches stay shared (they are caches, not configuration) so a sandbox HOME does not re-download them.
  export npm_config_cache=$EMV_REAL_HOME/.npm BUN_INSTALL_CACHE_DIR=$EMV_REAL_HOME/.bun/install/cache
  export PATH=$EMV_STACK/bin:$EMV_REAL_PATH
  export DO_NOT_TRACK=1
  # Commits the agents make in the sandbox carry a neutral identity, never one derived from your account or host.
  export GIT_AUTHOR_NAME=harness GIT_AUTHOR_EMAIL=harness@example.invalid GIT_COMMITTER_NAME=harness GIT_COMMITTER_EMAIL=harness@example.invalid
  # Nothing from the contributor's own agent session may leak into the sandboxed agents.
  unset ANTHROPIC_BASE_URL OPENAI_BASE_URL ANTHROPIC_API_KEY OPENAI_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDECODE CLAUDE_PID CLAUDE_EFFORT
  local v; for v in ${(k)parameters[(I)CLAUDE_CODE_*]} ${(k)parameters[(I)SUPERSET_*]}; do unset $v; done
}

emv_free_gb() { df -Pk "$EMV_RUN_DIR" 2>/dev/null | awk 'NR==2 {print int($4 / 1048576)}'; }

emv_gateway() { "$EMV_BUN" "$EMV_REPO_ROOT/src/services/wire-gateway/WireGatewayService.ts" "$@"; }

source $EMV_FORWARD_DIR/lib/model-profile.sh
