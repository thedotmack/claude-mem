# Source me (zsh, from env.sh). The model profile picks which model the agent AND claude-mem's observer use.
#
# There is no default profile, and full-price models are refused. Owner rule, 2026-10-28: no wire gateway experiment
# runs on Anthropic models; only discount frontier models (e.g. DeepSeek Flash through OpenRouter). So a run with no
# EMV_MODEL_PROFILE fails, and the `anthropic` profile (Claude Code on Claude, Codex on a full-price OpenAI model) fails
# too unless EMV_ALLOW_FULL_PRICE_MODELS=1, which only the owner may decide to set. The check runs before anything
# starts (run.sh, setup-stack.sh, start-stack.sh) and again before every agent turn (agent-turn.sh).
#
# anthropic (refused unless EMV_ALLOW_FULL_PRICE_MODELS=1)
#   Claude Code on the contributor's claude.ai login (EMV_CLAUDE_MODEL), observer on claude-mem's `claude` provider
#   with the same login. Codex (EMV_AGENT=codex) uses the contributor's ChatGPT login.
#
# openrouter-deepseek-flash
#   Both on the exact model `deepseek/deepseek-v4.1-flash-1017` (1,048,576-token context, OpenRouter's listing), never
#   the alias `~deepseek/deepseek-flash-latest`, whose price and model move. Every request is also pinned to one provider
#   endpoint: the tee sets the `provider` field for agents, and CLAUDE_MEM_OPENROUTER_EXTRA_BODY sets it for the observer.
#   The endpoint and its frozen price come from the card (EMV_CARD, or EMV_PIN_PROVIDER to override the slug in the
#   bake-off). Claude Code is pointed
#   at OpenRouter's Anthropic-compatible API (https://openrouter.ai/api, key as a bearer token in
#   ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY blank: OpenRouter's Claude Code guide), still through the gateway and the
#   tee, so capture and measurement are unchanged. The observer uses claude-mem's existing `openrouter` provider with
#   CLAUDE_MEM_OPENROUTER_MODEL set to the same model (sandbox settings only).
#   The key: OPENROUTER_API_KEY from the environment, else (macOS) the login keychain entry whose service is
#   EMV_OPENROUTER_KEYCHAIN_SERVICE [openrouter-endless-mode-tests] and account is you (read only). Never claude-mem's
#   settings.json: that key is the contributor's own and may have no spending limit. It must be an OpenRouter key
#   (sk-or-…). A cmem.ai memory key (cm_pro_…) is refused: it works only at cmem.ai, and claude-mem never sends one to
#   another host. The key goes into the agent's and worker's environment only; it is never printed or written to any file.
#   Claude Code, Hermes Agent, OpenClaw and Codex. Hermes and OpenClaw send OpenAI chat completions to the same upstream
#   (https://openrouter.ai/api + /v1/chat/completions); see lib/chat-agents.sh. Codex sends Responses API requests
#   (+ /v1/responses) with an OpenRouter key and no ChatGPT login (OpenRouter's Codex CLI guide).

typeset -g EMV_OPENROUTER_MODEL=${EMV_OPENROUTER_MODEL:-'deepseek/deepseek-v4.1-flash-1017'}
typeset -g EMV_OPENROUTER_ANTHROPIC_BASE=${EMV_OPENROUTER_ANTHROPIC_BASE:-https://openrouter.ai/api}
# The frozen price card: the pinned endpoint's slug and the one price every cell uses.
export EMV_CARD=${EMV_CARD:-$EMV_FORWARD_DIR/../prices/openrouter-deepseek-v4.1-flash-1017.card.json}

# The endpoint slug every request is pinned to. Fails loudly when there is none.
emv_pin_provider() {
  if [[ -n $EMV_PIN_PROVIDER ]]; then print -r -- $EMV_PIN_PROVIDER; return; fi
  local slug=$(jq -r '.provider_slug // empty' $EMV_CARD 2>/dev/null)
  [[ -n $slug ]] || { echo "openrouter-deepseek-flash: no pinned endpoint (no provider_slug in $EMV_CARD, and EMV_PIN_PROVIDER is unset)" >&2; return 2; }
  print -r -- $slug
}

# Upstream the Anthropic-side tee forwards to.
emv_anthropic_upstream() {
  case $EMV_MODEL_PROFILE in
    anthropic) print -r -- https://api.anthropic.com ;;
    openrouter-deepseek-flash) print -r -- $EMV_OPENROUTER_ANTHROPIC_BASE ;;
    *) echo "unknown EMV_MODEL_PROFILE '$EMV_MODEL_PROFILE' (anthropic | openrouter-deepseek-flash)" >&2; return 2 ;;
  esac
}

# The model Claude Code is started with.
emv_claude_model() {
  [[ $EMV_MODEL_PROFILE == openrouter-deepseek-flash ]] && print -r -- $EMV_OPENROUTER_MODEL || print -r -- $EMV_CLAUDE_MODEL
}

# Puts the OpenRouter key into EMV_OPENROUTER_KEY (never printed). Fails loudly when there is none or it is not an
# OpenRouter key.
emv_read_openrouter_key() {
  local key=$OPENROUTER_API_KEY source='OPENROUTER_API_KEY'
  local service=${EMV_OPENROUTER_KEYCHAIN_SERVICE:-openrouter-endless-mode-tests}
  if [[ -z $key && $(uname) == Darwin ]]; then
    # The keychain path is explicit because HOME may be a sandbox.
    key=$(security find-generic-password -s "$service" -a "$EMV_REAL_USER" -w "$EMV_REAL_HOME/Library/Keychains/login.keychain-db" 2>/dev/null)
    source="the keychain entry $service"
  fi
  if [[ -z $key ]]; then
    echo "openrouter-deepseek-flash: no OpenRouter key (the keychain entry $service, or OPENROUTER_API_KEY; claude-mem's settings.json is never used)" >&2; return 3
  fi
  if [[ $key == cm_pro_* ]]; then
    echo "openrouter-deepseek-flash: the key in $source is a cmem.ai memory key (cm_pro_…), which only cmem.ai accepts; claude-mem never sends it to another host. Set OPENROUTER_API_KEY to an OpenRouter key (sk-or-…)." >&2; return 3
  fi
  if [[ $key != sk-or-* ]]; then
    echo "openrouter-deepseek-flash: the key in $source does not look like an OpenRouter key (sk-or-…)" >&2; return 3
  fi
  typeset -g EMV_OPENROUTER_KEY=$key
}

# Profile checks: before anything starts, and before every agent turn.
emv_check_profile() {
  local rule='owner rule 2026-10-28: wire gateway experiments run on discount models only'
  if [[ $EMV_AGENT == codex && $EMV_MODEL_PROFILE == anthropic && $EMV_ALLOW_FULL_PRICE_MODELS != 1 ]]; then
    echo "refused: EMV_AGENT=codex on the anthropic profile runs a full-price OpenAI model ($rule). Use EMV_MODEL_PROFILE=openrouter-deepseek-flash." >&2; return 4
  fi
  case $EMV_MODEL_PROFILE in
    '') echo "refused: no EMV_MODEL_PROFILE set, and there is no fallback to Claude ($rule). Set EMV_MODEL_PROFILE=openrouter-deepseek-flash and OPENROUTER_API_KEY." >&2; return 4 ;;
    anthropic)
      [[ $EMV_ALLOW_FULL_PRICE_MODELS == 1 ]] && return 0
      echo "refused: EMV_MODEL_PROFILE=anthropic runs Claude models ($rule). Set EMV_MODEL_PROFILE=openrouter-deepseek-flash and OPENROUTER_API_KEY." >&2; return 4 ;;
    openrouter-deepseek-flash)
      [[ $EMV_AGENT == (claude|hermes|openclaw|codex) ]] || { echo "openrouter-deepseek-flash supports EMV_AGENT=claude, hermes, openclaw or codex" >&2; return 2; }
      emv_pin_provider >/dev/null || return
      emv_read_openrouter_key ;;
    *) emv_anthropic_upstream ;;
  esac
  if emv_is_chat_agent && [[ $EMV_MODEL_PROFILE != openrouter-deepseek-flash ]]; then echo "EMV_AGENT=$EMV_AGENT runs on openrouter-deepseek-flash only" >&2; return 2; fi
}
