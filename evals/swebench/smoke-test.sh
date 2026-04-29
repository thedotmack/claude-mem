#!/usr/bin/env bash
set -euo pipefail

INSTANCE_ID="${1:-sympy__sympy-24152}"
DATASET="${DATASET:-princeton-nlp/SWE-bench_Lite}"
IMAGE="${IMAGE:-claude-mem/swebench-agent:latest}"
TIMEOUT="${TIMEOUT:-1800}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RUN_DIR="$REPO_ROOT/evals/swebench/runs/smoke/$INSTANCE_ID"
PREDICTIONS="$REPO_ROOT/evals/swebench/runs/smoke/predictions.jsonl"
mkdir -p "$RUN_DIR" "$(dirname "$PREDICTIONS")"

CREDS_FILE="$(mktemp -t claude-mem-creds.XXXXXX.json)"
trap 'rm -f "$CREDS_FILE"' EXIT

creds_obtained=0
if [[ "$(uname)" == "Darwin" ]]; then
  if security find-generic-password -s 'Claude Code-credentials' -w > "$CREDS_FILE" 2>/dev/null \
     && [[ -s "$CREDS_FILE" ]]; then
    creds_obtained=1
  fi
fi
if [[ "$creds_obtained" -eq 0 && -f "$HOME/.claude/.credentials.json" ]]; then
  cp "$HOME/.claude/.credentials.json" "$CREDS_FILE"
  creds_obtained=1
fi
if [[ "$creds_obtained" -eq 0 ]]; then
  echo "ERROR: no Claude OAuth creds found (macOS Keychain or ~/.claude/.credentials.json)" >&2
  exit 1
fi
chmod 600 "$CREDS_FILE"

INSTANCE_JSON="$(mktemp)"
trap 'rm -f "$CREDS_FILE" "$INSTANCE_JSON"' EXIT
python3 - "$INSTANCE_ID" "$DATASET" > "$INSTANCE_JSON" <<'PY'
import json, sys
from datasets import load_dataset
target = sys.argv[1]
dataset = sys.argv[2]
ds = load_dataset(dataset, split="test")
for row in ds:
    if row["instance_id"] == target:
        print(json.dumps({
            "instance_id": row["instance_id"],
            "repo": row["repo"],
            "base_commit": row["base_commit"],
            "problem_statement": row["problem_statement"],
        }))
        break
else:
    print(f"ERROR: instance {target} not found", file=sys.stderr)
    sys.exit(1)
PY

SCRATCH="$(mktemp -d -t claude-mem-smoke.XXXXXX)"
trap 'rm -f "$CREDS_FILE" "$INSTANCE_JSON"; rm -rf "$SCRATCH"' EXIT

read -r REPO BASE_COMMIT < <(
  python3 - "$SCRATCH" "$INSTANCE_JSON" <<'PY'
import json, os, sys
scratch, instance_json = sys.argv[1], sys.argv[2]
with open(instance_json) as f:
    d = json.load(f)
open(os.path.join(scratch, "problem.txt"), "w").write(d["problem_statement"])
print(d["repo"], d["base_commit"])
PY
)

echo "=== Running $INSTANCE_ID ($REPO @ $BASE_COMMIT) ===" >&2
echo "Scratch: $SCRATCH" >&2
echo "Logs will land in: $RUN_DIR" >&2

TIMEOUT_CMD=()
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT_CMD=(timeout "$TIMEOUT")
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_CMD=(gtimeout "$TIMEOUT")
else
  echo "WARN: no \`timeout\`/\`gtimeout\` on PATH; container runs uncapped" >&2
fi

CONTAINER_NAME="claude-mem-smoke-$INSTANCE_ID-$$"

set +e
"${TIMEOUT_CMD[@]}" docker run --rm \
  --name "$CONTAINER_NAME" \
  -e CLAUDE_MEM_OUTPUT_DIR=/scratch \
  -e CLAUDE_MEM_CREDENTIALS_FILE=/auth/.credentials.json \
  -v "$SCRATCH:/scratch" \
  -v "$CREDS_FILE:/auth/.credentials.json:ro" \
  "$IMAGE" \
  "$INSTANCE_ID" "$REPO" "$BASE_COMMIT" /scratch/problem.txt /scratch/ignored-predictions.jsonl
DOCKER_EXIT=$?
set -e

if [[ "$DOCKER_EXIT" -eq 124 ]]; then
  echo "ERROR: docker run exceeded ${TIMEOUT}s wall-clock; removing container" >&2
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
fi

for f in ingest.jsonl fix.jsonl model_patch.diff; do
  [[ -f "$SCRATCH/$f" ]] && cp "$SCRATCH/$f" "$RUN_DIR/$f"
done

DIFF_FILE="$SCRATCH/model_patch.diff"
DIFF=""
[[ -f "$DIFF_FILE" ]] && DIFF="$(cat "$DIFF_FILE")"
jq -nc \
  --arg id "$INSTANCE_ID" \
  --arg patch "$DIFF" \
  --arg model "claude-opus-4-7+claude-mem" \
  '{instance_id:$id, model_patch:$patch, model_name_or_path:$model}' \
  >> "$PREDICTIONS"

echo "=== Done ===" >&2
echo "Diff size: $(wc -c < "$DIFF_FILE" 2>/dev/null || echo 0) bytes" >&2
echo "Predictions: $PREDICTIONS" >&2
echo "Verify mem-search invocation:" >&2
echo "  grep -o '\"name\":\"[^\"]*mem-search[^\"]*\"' $RUN_DIR/fix.jsonl || echo 'NOT INVOKED'" >&2
