#!/usr/bin/env bash
# Score a predictions.jsonl produced by ``scripts/swebench/run.py`` using the
# official SWE-bench evaluation harness. Requires Docker.
#
# Usage:
#   scripts/swebench/evaluate.sh [PREDICTIONS_PATH] [RUN_ID]
#
# Defaults:
#   PREDICTIONS_PATH = scripts/swebench/out/predictions.jsonl
#   RUN_ID           = claude-mem-$(date +%Y%m%d-%H%M%S)
set -euo pipefail

PREDICTIONS="${1:-scripts/swebench/out/predictions.jsonl}"
RUN_ID="${2:-claude-mem-$(date +%Y%m%d-%H%M%S)}"

if [[ ! -f "$PREDICTIONS" ]]; then
  echo "error: predictions file not found: $PREDICTIONS" >&2
  exit 2
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "error: docker is required by the SWE-bench evaluation harness" >&2
  exit 2
fi

# Install the harness on demand — pinning is the caller's choice.
if ! python -c "import swebench" >/dev/null 2>&1; then
  echo "Installing swebench harness ..." >&2
  python -m pip install --upgrade swebench >&2
fi

# Harness CLI uses underscored flag names.
# Source: https://github.com/SWE-bench/SWE-bench/blob/main/swebench/harness/run_evaluation.py#L587-L670
exec python -m swebench.harness.run_evaluation \
  --dataset_name SWE-bench/SWE-bench_Verified \
  --split test \
  --predictions_path "$PREDICTIONS" \
  --run_id "$RUN_ID" \
  --max_workers "${SWEBENCH_MAX_WORKERS:-4}"
