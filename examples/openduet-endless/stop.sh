#!/usr/bin/env bash
# Stop OpenDuet, then the claude-mem worker and gateway this kit started. Data stays.
set -uo pipefail
source "$(dirname "$0")/lib.sh"

[ -d "$OD_REPO" ] && (cd "$OD_REPO" && bash scripts/stop.sh)
if [ -f "$OD_PIDS" ]; then
  while read -r pid; do [ -n "$pid" ] && kill "$pid" 2>/dev/null; done < "$OD_PIDS"
  rm -f "$OD_PIDS"
fi
say "stopped"
