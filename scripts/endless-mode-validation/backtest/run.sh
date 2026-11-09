#!/usr/bin/env bash
# Backtest Endless Mode on YOUR longest Claude Code sessions: rebuild each request from the transcript, check that
# the cache simulator reproduces the usage you were really billed for, then replay every request through this
# checkout's real gateway code (Endless Mode on) and simulate the cache for each case.
#
# Usage: scripts/endless-mode-validation/backtest/run.sh [--top N] [--days D] [--with-compactions]
#   --top N              the N longest sessions by API request count [10]
#   --days D             with activity in the last D days [30]
#   --with-compactions   also every session in that window where Claude Code compacted
# Env: EMV_BACKTEST_NAME [backtest-<date>], EMV_BACKTEST_DIR [<repo>/.scratch/endless-mode-validation/backtest/<name>],
#      EMV_PARALLEL replays at once [4: one bun process each, single-threaded; what our runs used],
#      EMV_PRICES prices file [prices/anthropic-claude-opus-5-5.json]
#
# Reads, never writes: <Claude config dir>/projects/*/*.jsonl, your claude-mem database (through a sqlite backup
# copy in the work dir), worker logs and MY-RULES.md. Everything it writes is under the work dir.
# Step 1 is the validation; when it fails, nothing else runs and no Endless Mode number is produced.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; REPO="$(cd "$HERE/../../.." && pwd)"
top=10; days=30; with_compactions=""
while (( $# )); do
  case $1 in
    --top) top=$2; shift 2 ;; --days) days=$2; shift 2 ;; --with-compactions) with_compactions=--with-compactions; shift ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"; MEM_DIR="${CLAUDE_MEM_DATA_DIR:-$HOME/.claude-mem}"
NAME="${EMV_BACKTEST_NAME:-backtest-$(date +%Y%m%d-%H%M%S)}"
W="${EMV_BACKTEST_DIR:-$REPO/.scratch/endless-mode-validation/backtest/$NAME}"
PAR="${EMV_PARALLEL:-4}"
export EMV_PRICES="${EMV_PRICES:-$HERE/../prices/anthropic-claude-opus-5-5.json}"
mkdir -p "$W/out" "$W/data" "$W/logs"
log() { echo "$(date -u +%FT%TZ) $*" | tee -a "$W/logs/run.log"; }
trap 'log "FAILED at line $LINENO (step above); logs in $W/logs"' ERR
for t in python3 jq git; do command -v $t >/dev/null || { echo "missing: $t" >&2; exit 2; }; done
command -v bun >/dev/null || { echo "missing: bun" >&2; exit 2; }
[[ -d $CLAUDE_DIR/projects ]] || { echo "no Claude Code transcripts in $CLAUDE_DIR/projects" >&2; exit 2; }
log "backtest $NAME at commit $(git -C "$REPO" rev-parse --short HEAD); work dir $W"

log "select: top $top, last $days days $with_compactions"
python3 "$HERE/scan_sessions.py" "$CLAUDE_DIR" "$W/selected-sessions.json" --top "$top" --days "$days" $with_compactions | tee -a "$W/logs/run.log"
python3 - "$W/selected-sessions.json" "$W/labels.json" <<'PY'
import json, os, sys
sel = json.load(open(sys.argv[1]))
json.dump({os.path.basename(s['path'])[:8]: f's{k:02d}' for k, s in enumerate(sel, 1)}, open(sys.argv[2], 'w'), indent=1)
PY

log "rebuild requests"
python3 "$HERE/build_sessions.py" "$W/selected-sessions.json" "$W/sessions" > "$W/logs/build.log" 2>&1

log "STEP 1: validate the simulator against your recorded usage (case a)"
python3 "$HERE/simulate_all.py" "$W/sessions" a > "$W/logs/simulate-a.log" 2>&1
if ! python3 "$HERE/validate.py" "$W/sessions" "$W/labels.json" "$W/out"; then
  log "VALIDATION FAILED: the simulator does not reproduce your recorded usage closely enough, so no Endless Mode numbers are reported. Details: $W/out/validation.md"
  exit 1
fi

log "observations (from a backup copy of $MEM_DIR/claude-mem.db)"
python3 "$HERE/prep_observations.py" "$MEM_DIR" "$W" "$W/sessions" > "$W/logs/observations.log" 2>&1
log "case o (claude-mem off)"
for d in "$W"/sessions/*/; do python3 "$HERE/claude_mem_off.py" "${d%/}"; done > "$W/logs/claude-mem-off.log" 2>&1

log "replay through the gateway ($PAR at a time)"
jobs_file="$W/logs/replay-jobs.txt"; : > "$jobs_file"
for d in "$W"/sessions/*/; do
  s=$(basename "$d"); comp=$(jq '.meta.compactions | length' "$d/session.json")
  for f in timeline observation; do echo "$s $f cont" >> "$jobs_file"; if (( comp > 0 )); then echo "$s $f real" >> "$jobs_file"; fi; done
done
export EMV_BACKTEST_WORK_DIR="$W" CLAUDE_MEM_DATA_DIR="$W/data" DO_NOT_TRACK=1
[[ -f $MEM_DIR/MY-RULES.md ]] && export MY_RULES_FILE="$MEM_DIR/MY-RULES.md"
cd "$REPO"
fail=0
while read -r s f v; do
  while (( $(jobs -rp | wc -l) >= PAR )); do sleep 1; done
  ( bun "$HERE/run-gateway.ts" "$W/sessions/$s" "$f" "$v" > "$W/logs/replay-$s-$f-$v.log" 2>&1 || echo "$s $f $v" >> "$W/logs/replay-failed.txt" ) &
done < "$jobs_file"
wait
if [[ -s $W/logs/replay-failed.txt ]]; then log "replays failed: $(tr '\n' ';' < "$W/logs/replay-failed.txt") (logs in $W/logs)"; exit 1; fi
unset CLAUDE_MEM_DATA_DIR

log "simulate o / a / b / c"
python3 "$HERE/simulate_all.py" "$W/sessions" > "$W/logs/simulate.log" 2>&1
python3 "$HERE/report_data.py" "$W/sessions" "$W/labels.json" "$W/out" > "$W/logs/report-data.log" 2>&1
python3 "$HERE/make_tables.py" "$W/out/report-data.json" > "$W/out/tables.md"
{ echo "# Endless Mode backtest ($NAME, commit $(git -C "$REPO" rev-parse --short HEAD))"; echo
  echo "Prices: $(jq -r '.source' "$EMV_PRICES")"; echo; cat "$W/out/validation.md"; echo; cat "$W/out/tables.md"; } > "$W/out/summary.md"
log "done: $W/out/summary.md (validation + tables; session labels only, safe to paste)"
