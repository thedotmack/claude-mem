# Source me (zsh, from env.sh). Agents that speak OpenAI chat completions: Hermes Agent and OpenClaw.
#
# Each runs on its own sandbox home with the OpenRouter profile's model, pointed at the gateway route (or straight at
# the tee for `none`). The key is only in the agent's environment as EMV_UPSTREAM_KEY: their configs name that variable
# and hold no secret. OPENROUTER_API_KEY is removed from the agent's environment so that no auxiliary call (title,
# compression summary) can go to OpenRouter directly and skip the tee; those calls count in the measured cost.

emv_is_chat_agent() { [[ $EMV_AGENT == hermes || $EMV_AGENT == openclaw ]]; }

# Writes the sandboxed agent's config. Usage: emv_setup_chat_agent <base url without /v1>
emv_setup_chat_agent() {
  local base=$1
  case $EMV_AGENT in
    hermes)
      mkdir -p $HERMES_HOME
      cat > $HERMES_HOME/config.yaml <<YAML
model:
  default: "$EMV_OPENROUTER_MODEL"
  provider: emv-openrouter
providers:
  emv-openrouter:
    name: emv-openrouter
    base_url: "$base/v1"
    key_env: EMV_UPSTREAM_KEY
    api_mode: chat_completions
YAML
      ;;
    openclaw)
      mkdir -p $OPENCLAW_STATE_DIR
      # contextWindow: OpenRouter's listing for this model (see lib/model-profile.sh).
      jq -n --arg m "$EMV_OPENROUTER_MODEL" --arg b "$base/v1" --arg w "$EMV_STACK/proj" '{
        models: {providers: {"emv-openrouter": {baseUrl: $b, apiKey: "${EMV_UPSTREAM_KEY}", api: "openai-completions",
          models: [{id: $m, name: $m, reasoning: true, input: ["text"], contextWindow: 1048576,
                    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}}]}}},
        agents: {defaults: {model: {primary: ("emv-openrouter/" + $m)}, workspace: $w, skipBootstrap: true}}
      }' > $OPENCLAW_CONFIG_PATH
      ;;
    *) echo "not a chat agent: $EMV_AGENT" >&2; return 2 ;;
  esac
}

# One turn. Writes $T/<label>.json as {result, session_id} (the shape run.sh's artifacts read), prints agent-turn.sh's
# one status line and the first 300 characters of the reply. Usage: emv_run_chat_turn <label> <prompt> <first|resume> <turns dir> <sid file>
emv_run_chat_turn() {
  local label=$1 prompt=$2 mode=$3 T=$4 sidfile=$5 start=$(date +%s) rc raw=$T/$label.raw
  emv_read_openrouter_key || return
  local -a agent_env=(env -u OPENROUTER_API_KEY -u ANTHROPIC_AUTH_TOKEN EMV_UPSTREAM_KEY=$EMV_OPENROUTER_KEY)
  case $EMV_AGENT in
    hermes)
      local -a resume=()
      if [[ $mode == resume ]]; then
        [[ -s $sidfile ]] || { echo "rc=no-session secs=0 error=True sid=None"; echo 'no Hermes session to resume: an earlier turn failed'; return; }
        resume=(--resume $(<$sidfile))
      fi
      $agent_env $EMV_HERMES_BIN chat -Q --yolo -q "$prompt" $resume < /dev/null > $raw 2> $T/$label.err; rc=$?
      ;;
    openclaw)
      # One id for the whole session; --timeout 3600 is only a hung-turn stop (OpenClaw's own default of 600 s is
      # shorter than the long turns seen in the 500-turn run), and a hit stop shows as an error on the turn.
      print -r -- emv-session > $sidfile
      PATH=${EMV_OPENCLAW_NODE_DIR:+$EMV_OPENCLAW_NODE_DIR:}$PATH $agent_env $EMV_OPENCLAW_BIN agent --local --agent main --session-id emv-session \
        --timeout 3600 --json -m "$prompt" < /dev/null > $raw 2> $T/$label.err; rc=$?
      ;;
  esac
  python3 $EMV_FORWARD_DIR/chat-turn-result.py $EMV_AGENT $raw $T/$label.err $T/$label.json $rc $(( $(date +%s) - start )) $sidfile
}
