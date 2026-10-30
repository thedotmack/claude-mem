#!/usr/bin/env bash
# Where OpenDuet's chats are, whether its traffic goes through the gateway, and what Endless Mode has saved so far.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
if [ "$(read_od_env OPENDUET_LOCAL_CHATS)" = true ]; then
  if [ -f "$CHATS_DB" ]; then
    bun -e '
      const { Database } = require("bun:sqlite");
      const db = new Database(process.argv[1], { readonly: true });
      const { threads } = db.query("SELECT count(*) AS threads FROM threads").get();
      const { runs } = db.query("SELECT count(DISTINCT run_id) AS runs FROM events").get();
      console.log(`Chats on this computer: ${threads} conversation${threads === 1 ? "" : "s"}, ${runs} turn${runs === 1 ? "" : "s"}, in ${process.argv[1]}`);
    ' "$CHATS_DB"
  else
    say "Chats on this computer: none yet ($CHATS_DB is made on the first one)"
  fi
  curl -fsS --max-time 2 "http://127.0.0.1:$CHATS_PORT/health" >/dev/null 2>&1 && say "Local chat store: running on $CHATS_PORT" || say "Local chat store: not running"
  if kept=$(curl -fsS --max-time 2 "http://127.0.0.1:$WORKER_PORT/api/chat-transcripts?source=openduet" 2>/dev/null); then
    say "$(printf '%s' "$kept" | jq -r '"Full transcripts in claude-mem: \(.transcripts | length) conversation(s), \([.transcripts[].messageCount] | add // 0) message(s)"')"
  fi
else
  say "Chats: kept in CopilotKit's cloud"
fi
gateway routes list
gateway status --endless
