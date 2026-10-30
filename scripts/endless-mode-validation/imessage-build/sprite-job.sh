#!/usr/bin/env bash
# Runs on a Sprite in a detachable session (sprites.sh start): builds one arm, then scores it. ~/.emv/state says where
# it is (building, scoring, done, failed) and ~/.emv/job.log has the output. Results: ~/cmem-imessage-build/run.
set -uo pipefail
arm=$1
here=$(cd "$(dirname "$0")" && pwd)
out=$HOME/cmem-imessage-build/run
state() { echo "$1 $(date -u +%FT%TZ)" > ~/.emv/state; }
exec >> ~/.emv/job.log 2>&1
OPENROUTER_API_KEY=$(cat ~/.emv/openrouter-key)
export OPENROUTER_API_KEY
# A Sprite is a throwaway box with none of your logins on it; this only matters if bubblewrap could not be installed.
export EMV_THROWAWAY_BOX=1
state building
if ! python3 "$here/run.py" --out "$out" --arms "$arm" --base-ref origin/feat/wire-gateway --notetaker openrouter; then
  state "failed (build)"; exit 1
fi
state scoring
if ! python3 "$here/score.py" --out "$out" --arms "$arm"; then
  state "failed (scoring)"; exit 1
fi
state done
