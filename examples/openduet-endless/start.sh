#!/usr/bin/env bash
# Start the local chat store, claude-mem's worker and wire gateway (from this checkout, own data folder), point the
# OpenDuet route at OpenRouter with Endless Mode on, then start OpenDuet. Run setup.sh first.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

[ -f "$CM_DATA/settings.json" ] && [ -f "$OD_REPO/.env" ] || die "run setup.sh first"
key=$(read_openrouter_key)
case "$key" in
  sk-or-*) ;;
  "") die "no OpenRouter key: put it in $OD_REPO/.env as OPENAI_API_KEY=sk-or-..." ;;
  *) die "OPENAI_API_KEY in $OD_REPO/.env does not look like an OpenRouter key (sk-or-...)" ;;
esac
local_chats=$(read_od_env OPENDUET_LOCAL_CHATS)
if [ "$local_chats" != true ]; then
  grep -qE '^INTELLIGENCE_API_KEY=.+' "$OD_REPO/.env" || die "OpenDuet needs a CopilotKit Intelligence key; run the three npx/bun lines setup.sh printed"
fi

: > "$OD_PIDS.new"
# Whatever started is recorded for stop.sh, even when a later step fails.
trap 'if [ -f "$OD_PIDS.new" ]; then cat "$OD_PIDS.new" >> "$OD_PIDS"; rm -f "$OD_PIDS.new"; fi' EXIT
start_bg() { # name, then the command
  local name=$1; shift
  nohup "$@" > "$OD_LOGS/$name.log" 2>&1 &
  echo $! >> "$OD_PIDS.new"
}

if [ "$local_chats" = true ]; then
  if port_in_use "$CHATS_PORT"; then
    say "the local chat store is already running on $CHATS_PORT (stop.sh stops it)"
  else
    chats_key=$(read_od_env INTELLIGENCE_API_KEY)
    [ -n "$chats_key" ] || die "no INTELLIGENCE_API_KEY in $OD_REPO/.env; run setup.sh again"
    # Exported rather than passed on the command line, so it never shows in the process list.
    (export LOCAL_CHATS_API_KEY="$chats_key" LOCAL_CHATS_DB="$CHATS_DB" LOCAL_CHATS_PORT="$CHATS_PORT" &&
      start_bg chats bun "$OD_KIT_DIR/local-chats/server.ts")
    for _ in $(seq 1 40); do curl -fsS --max-time 1 "http://127.0.0.1:$CHATS_PORT/health" >/dev/null 2>&1 && break; sleep 0.25; done
    curl -fsS --max-time 2 "http://127.0.0.1:$CHATS_PORT/health" >/dev/null || die "the local chat store did not start; log in $OD_LOGS/chats.log"
  fi
  say "chats: kept on this computer in $CHATS_DB"
fi

if port_in_use "$WORKER_PORT" || port_in_use "$GATEWAY_PORT"; then
  say "claude-mem is already running on $WORKER_PORT/$GATEWAY_PORT (stop.sh stops it)"
else
  # The observer's OpenRouter key goes into the worker's environment only, never into a file.
  cm_env=(env CLAUDE_MEM_DATA_DIR="$CM_DATA" HOME="$CM_HOME" DO_NOT_TRACK=1 PATH="$OD_HOME/bin:$PATH")
  # Exported rather than passed on the command line, so it never shows in the process list.
  (cd "$CM_DATA" && export CLAUDE_MEM_OPENROUTER_API_KEY="$key" &&
    start_bg worker "${cm_env[@]}" bun "$CM_REPO/src/services/worker-service.ts" --daemon)
  start_bg gateway "${cm_env[@]}" bun "$CM_REPO/src/services/wire-gateway/WireGatewayService.ts" start --foreground
  for _ in $(seq 1 60); do port_in_use "$WORKER_PORT" && port_in_use "$GATEWAY_PORT" && break; sleep 0.5; done
  port_in_use "$WORKER_PORT" && port_in_use "$GATEWAY_PORT" || die "claude-mem did not start; logs in $OD_LOGS"
fi
cat "$OD_PIDS.new" >> "$OD_PIDS"
rm -f "$OD_PIDS.new"

gateway routes remove "$ROUTE" >/dev/null 2>&1 || true
gateway routes add "$ROUTE" --agent openduet --upstream "$UPSTREAM" --capture wire > "$OD_LOGS/routes.log"
gateway routes endless "$ROUTE" on >> "$OD_LOGS/routes.log"
say "claude-mem: worker $WORKER_PORT, gateway $GATEWAY_PORT, route $ROUTE -> $UPSTREAM, Endless Mode on, model $MODEL"

(cd "$OD_REPO" && bash scripts/start.sh)

say ""
say "OpenDuet:            http://localhost:3010"
say "OpenDuet's memories: http://127.0.0.1:$WORKER_PORT"
[ "$local_chats" = true ] && say "Chats kept in:       $CHATS_DB"
say "What Endless saved:  $OD_KIT_DIR/status.sh"
say "What it cost:        python3 $OD_KIT_DIR/cost.py"
