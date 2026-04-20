#!/usr/bin/env bash
set -euo pipefail

# eval.sh — Thin wrapper around `python -m swebench.harness.run_evaluation`.
#
# Required env:
#   RUN_ID         Identifier for this evaluation run (matches predictions dir).
# Optional env:
#   MAX_WORKERS    Parallel worker count for the harness (default: 4).
#   DATASET        HF dataset name (default: princeton-nlp/SWE-bench_Verified).
#   TIMEOUT        Per-instance timeout in seconds (default: 1800).
#
# Reports land at:
#   logs/run_evaluation/$RUN_ID/claude-opus-4-7+claude-mem/<instance_id>/report.json

: "${RUN_ID:?RUN_ID is required (e.g. RUN_ID=smoke-001)}"
MAX_WORKERS="${MAX_WORKERS:-4}"
DATASET="${DATASET:-princeton-nlp/SWE-bench_Verified}"
TIMEOUT="${TIMEOUT:-1800}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

PREDICTIONS="evals/swebench/runs/$RUN_ID/predictions.jsonl"

if [[ ! -f "$PREDICTIONS" ]]; then
  echo "ERROR: predictions file not found: $PREDICTIONS" >&2
  echo "Hint: run Phase 3 agent loop first to produce predictions.jsonl for RUN_ID=$RUN_ID." >&2
  exit 1
fi

# Harness REQUIRES Docker — fail fast with a clean message if it's not running.
if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker CLI not found on PATH. The SWE-bench harness requires Docker." >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "ERROR: Docker daemon is not running. Start Docker Desktop (or the docker service) and retry." >&2
  exit 1
fi

# Create/reuse a dedicated venv so we don't pollute the system Python.
VENV_DIR=".venv-swebench"
if [[ ! -d "$VENV_DIR" ]]; then
  echo "[eval.sh] Creating Python venv at $VENV_DIR ..."
  python3 -m venv "$VENV_DIR"
fi
# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"

echo "[eval.sh] Installing/updating swebench in $VENV_DIR ..."
pip install -q swebench

echo "[eval.sh] Running harness:"
echo "  dataset:        $DATASET"
echo "  predictions:    $PREDICTIONS"
echo "  max_workers:    $MAX_WORKERS"
echo "  run_id:         $RUN_ID"
echo "  timeout:        $TIMEOUT"

python -m swebench.harness.run_evaluation \
  --dataset_name "$DATASET" \
  --predictions_path "$PREDICTIONS" \
  --max_workers "$MAX_WORKERS" \
  --run_id "$RUN_ID" \
  --timeout "$TIMEOUT"

REPORTS_DIR="logs/run_evaluation/$RUN_ID/claude-opus-4-7+claude-mem"
echo ""
echo "[eval.sh] Done. Per-instance reports at:"
echo "  $REPORTS_DIR/<instance_id>/report.json"
