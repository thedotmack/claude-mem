#!/usr/bin/env zsh
# Anthropic profile only. Claude Code's claude.ai access token rotates (the old one is revoked). The agent turns read
# it afresh every turn and the tees re-read it on a 401, but the workers' observers hold the one they started with.
# This checks every 30 s and, on a change, restarts each worker with the new token and logs the time. Only a
# 12-character hash of the token is logged, never the token. Usage: token-watch.sh <stop file> <config>...
source ${0:A:h}/lib/env.sh || exit
source $EMV_FORWARD_DIR/lib/claude-token.sh
stop=$1; shift; L=$EMV_RUN_DIR/logs/token-watch.log
hash_now() { emv_read_claude_token 2>/dev/null && print -r -- $EMV_CLAUDE_TOKEN | shasum -a 256 | cut -c1-12; }
last=$(hash_now); echo "$(date +%T) watching (token ${last})" >> $L
while [[ ! -e $stop ]]; do
  sleep 30; now=$(hash_now)
  [[ $now == $last || -z $now ]] && continue
  echo "$(date +%T) token changed ${last} -> ${now}; restarting workers" >> $L; last=$now
  for c in "$@"; do
    [[ $c == none ]] && continue
    ( emv_use_stack $c
      for pid in $(lsof -nP -t -iTCP:$EMV_WORKER_PORT -sTCP:LISTEN 2>/dev/null); do kill $pid; done; sleep 3
      emv_read_claude_token && export CLAUDE_CODE_OAUTH_TOKEN=$EMV_CLAUDE_TOKEN
      cd $CLAUDE_MEM_DATA_DIR && nohup $EMV_BUN $EMV_REPO_ROOT/src/services/worker-service.ts --daemon >> $EMV_STACK/logs/worker.log 2>&1 &
      print $! >> $EMV_STACK/pids )
  done
  echo "$(date +%T) workers restarted" >> $L
done
