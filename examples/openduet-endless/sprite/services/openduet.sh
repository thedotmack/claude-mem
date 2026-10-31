#!/usr/bin/env bash
# Sprite service: once Docker, the chat store and claude-mem are up (their own services), point the OpenDuet route at
# the upstream with Endless Mode on and start OpenDuet. Then stay up, so the Sprite keeps it running.
set -uo pipefail
source "$(dirname "$0")/common.sh"
for _ in $(seq 1 90); do
  docker info >/dev/null 2>&1 && port_in_use "$CHATS_PORT" && port_in_use "$WORKER_PORT" && port_in_use "$GATEWAY_PORT" && break
  sleep 1
done
gateway routes remove "$ROUTE" >/dev/null 2>&1 || true
gateway routes add "$ROUTE" --agent openduet --upstream "$UPSTREAM_ROOT" --capture wire > "$OD_LOGS/routes.log"
gateway routes endless "$ROUTE" on >> "$OD_LOGS/routes.log"
say "claude-mem: worker $WORKER_PORT, gateway $GATEWAY_PORT, route $ROUTE -> $UPSTREAM, Endless Mode on, model $MODEL"
# A service restart stops this script but not what OpenDuet's start.sh left running, which would then hold its ports.
(cd "$OD_REPO" && bash scripts/stop.sh --keep-computers) > "$OD_LOGS/openduet-stop.log" 2>&1 || true
# If OpenDuet doesn't start, clear what it left and try again after a pause, rather than stay up with no app.
until (cd "$OD_REPO" && bash scripts/start.sh); do
  say "OpenDuet did not start; trying again in 30 seconds (logs in $OD_REPO/openbot/.logs)"
  (cd "$OD_REPO" && bash scripts/stop.sh --keep-computers) >> "$OD_LOGS/openduet-stop.log" 2>&1 || true
  sleep 30
done
while true; do sleep 60 & wait $!; done
