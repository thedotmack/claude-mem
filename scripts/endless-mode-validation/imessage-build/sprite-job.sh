#!/usr/bin/env bash
# Runs on a Sprite (as a service, or a detachable session from sprites.sh): builds one arm, or `all` three side by
# side, then scores them. ~/.emv/state says where it is (building, scoring, done, failed) and ~/.emv/job.log has the
# output. Results: ~/cmem-imessage-build/run.
set -uo pipefail
arm=$1
[[ $arm == all ]] && arm=plain,claudemem,endless
here=$(cd "$(dirname "$0")" && pwd)
out=$HOME/cmem-imessage-build/run
state() { echo "$1 $(date -u +%FT%TZ)" > ~/.emv/state; }
exec >> ~/.emv/job.log 2>&1
OPENROUTER_API_KEY=$(cat ~/.emv/openrouter-key)
export OPENROUTER_API_KEY
# A Sprite is a throwaway box with none of your logins on it; this only matters if bubblewrap could not be installed.
export EMV_THROWAWAY_BOX=1

# Keep the Sprite awake for the whole job: a task with a short expiry, refreshed every minute (Fly's heartbeat
# pattern). If this script dies, the task lapses and the Sprite can sleep.
api() { curl -s --unix-socket /.sprite/api.sock -H 'Content-Type: application/json' "$@" > /dev/null; }
if [[ -S /.sprite/api.sock ]]; then
  api -X POST http://sprite/v1/tasks -d '{"name": "imsg-build", "expire": "5m"}'
  (while true; do api -X PUT http://sprite/v1/tasks/imsg-build -d '{"expire": "5m"}'; sleep 60; done) &
  beat=$!
  trap 'kill $beat 2>/dev/null; api -X DELETE http://sprite/v1/tasks/imsg-build' EXIT
fi

state building
if ! python3 "$here/run.py" --out "$out" --arms "$arm" --base-ref origin/feat/wire-gateway --notetaker openrouter; then
  state "failed (build)"; exit 1
fi
state scoring
if ! python3 "$here/score.py" --out "$out" --arms "$arm"; then
  state "failed (scoring)"; exit 1
fi
state done
