#!/usr/bin/env bash
set -euo pipefail

# run-instance.sh — runs Claude Code + claude-mem against a single SWE-bench
# instance using the two-turn protocol (ingest, then fix), and appends a
# prediction JSONL row to OUT_PREDICTIONS_PATH.
#
# Usage:
#   run-instance.sh INSTANCE_ID REPO_SLUG BASE_COMMIT PROBLEM_STATEMENT_FILE OUT_PREDICTIONS_PATH
#
# Required env:
#   ANTHROPIC_API_KEY

if [[ $# -ne 5 ]]; then
  echo "Usage: $0 INSTANCE_ID REPO_SLUG BASE_COMMIT PROBLEM_STATEMENT_FILE OUT_PREDICTIONS_PATH" >&2
  exit 2
fi

INSTANCE_ID="$1"
REPO_SLUG="$2"
BASE_COMMIT="$3"
PROBLEM_STATEMENT_FILE="$4"
OUT_PREDICTIONS_PATH="$5"

# Auth: either ANTHROPIC_API_KEY (pay-per-call) OR a pre-extracted OAuth
# credentials file from a Claude Max/Pro subscription (flat-fee, but subject
# to Anthropic's usage limits — batch-scale runs may exhaust the 5h window).
# run-batch.py extracts OAuth creds from host Keychain/file and mounts them
# at CLAUDE_MEM_CREDENTIALS_FILE; standalone smoke-test can do the same, or
# set ANTHROPIC_API_KEY directly.
if [[ -z "${ANTHROPIC_API_KEY:-}" && -z "${CLAUDE_MEM_CREDENTIALS_FILE:-}" ]]; then
  echo "ERROR: one of ANTHROPIC_API_KEY or CLAUDE_MEM_CREDENTIALS_FILE is required" >&2
  exit 1
fi

if [[ -n "${CLAUDE_MEM_CREDENTIALS_FILE:-}" && ! -f "$CLAUDE_MEM_CREDENTIALS_FILE" ]]; then
  echo "ERROR: CLAUDE_MEM_CREDENTIALS_FILE set but file missing: $CLAUDE_MEM_CREDENTIALS_FILE" >&2
  exit 1
fi

if [[ ! -f "$PROBLEM_STATEMENT_FILE" ]]; then
  echo "ERROR: PROBLEM_STATEMENT_FILE not found: $PROBLEM_STATEMENT_FILE" >&2
  exit 1
fi

MODEL_NAME="claude-opus-4-7+claude-mem"

# Per-instance ephemeral scratch dir — isolates ~/.claude/ and ~/.claude-mem/.
SCRATCH=$(mktemp -d)
REPO_DIR="$SCRATCH/repo"
MEM_DIR="$SCRATCH/.claude-mem"
CLAUDE_DIR="$SCRATCH/.claude"
mkdir -p "$MEM_DIR" "$CLAUDE_DIR"

# If using OAuth, seed the isolated CLAUDE_DIR with the mounted credentials
# file so Claude Code finds them at HOME=$SCRATCH → ~/.claude/.credentials.json.
# chmod 600 to match what `claude login` writes (it checks permissions).
if [[ -n "${CLAUDE_MEM_CREDENTIALS_FILE:-}" ]]; then
  cp "$CLAUDE_MEM_CREDENTIALS_FILE" "$CLAUDE_DIR/.credentials.json"
  chmod 600 "$CLAUDE_DIR/.credentials.json"
fi

# Directory where artifacts the batch orchestrator reads (model_patch.diff,
# ingest.jsonl, fix.jsonl) are written. When run via `docker run -v
# <host-scratch>:/scratch` from run-batch.py, the orchestrator sets
# CLAUDE_MEM_OUTPUT_DIR=/scratch so these files are visible on the host. In
# standalone/smoke-test mode the default keeps artifacts in the ephemeral
# scratch dir alongside the repo.
OUTPUT_DIR="${CLAUDE_MEM_OUTPUT_DIR:-$SCRATCH}"
mkdir -p "$OUTPUT_DIR"

# Always write a prediction row (even on failure) so batch mode stays aligned.
# The trap emits an empty-patch row if we exit before the success path sets
# PREDICTION_EMITTED=1, then cleans up SCRATCH.
DIFF_OUT="$OUTPUT_DIR/model_patch.diff"
INGEST_LOG="$OUTPUT_DIR/ingest.jsonl"
FIX_LOG="$OUTPUT_DIR/fix.jsonl"

PREDICTION_EMITTED=0
cleanup() {
  local exit_code=$?
  if [[ "$PREDICTION_EMITTED" -ne 1 ]]; then
    # Ensure the orchestrator sees an (empty) diff file even on early exit.
    : > "$DIFF_OUT" 2>/dev/null || true
    jq -nc \
      --arg id "$INSTANCE_ID" \
      --arg patch "" \
      --arg model "$MODEL_NAME" \
      '{instance_id:$id, model_patch:$patch, model_name_or_path:$model}' \
      >> "$OUT_PREDICTIONS_PATH" || true
  fi
  rm -rf "$SCRATCH"
  exit "$exit_code"
}
trap cleanup EXIT

# Shallow clone + fetch the exact commit. Saves minutes on large repos
# (sympy/django/scikit-learn) vs. a full-history clone. Fallback to a full
# clone if the server rejects the by-commit fetch (GitHub supports
# uploadpack.allowReachableSHA1InWant by default on public repos, but mirrors
# may not).
if ! { git clone --depth 1 --no-single-branch "https://github.com/${REPO_SLUG}.git" "$REPO_DIR" \
    && git -C "$REPO_DIR" fetch --depth 1 origin "$BASE_COMMIT"; }; then
  echo "WARN: shallow fetch failed; falling back to full clone" >&2
  rm -rf "$REPO_DIR"
  git clone "https://github.com/${REPO_SLUG}.git" "$REPO_DIR"
fi
git -C "$REPO_DIR" reset --hard "$BASE_COMMIT"

# ---------- Turn 1: Ingest (populate memory via PostToolUse hook) ----------
INGEST_PROMPT="Please learn about the codebase by systematically and thoroughly reading EVERY SOURCE FILE IN FULL, no matter how many there are. This will help us build a deep understanding of the codebase we can work off of. Don't worry about cost. This is critical and non-negotiable."

SESSION_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')

set +e
(
  cd "$REPO_DIR" && HOME="$SCRATCH" claude \
    --print \
    --session-id "$SESSION_ID" \
    --plugin-dir /opt/claude-mem \
    --permission-mode bypassPermissions \
    --allowedTools "Read,Glob,Grep,Bash(ls *),Bash(wc *)" \
    --max-budget-usd 5.00 \
    --output-format json \
    "$INGEST_PROMPT"
) > "$INGEST_LOG" 2>&1
INGEST_EXIT=$?
set -e

if [[ "$INGEST_EXIT" -ne 0 ]]; then
  echo "WARN: ingest turn exited with $INGEST_EXIT; continuing to fix turn" >&2
fi

# ---------- Turn 2: Fix (consume memory via mem-search slash command) ----------
PROBLEM=$(cat "$PROBLEM_STATEMENT_FILE")
QUERY=$(printf '%s' "$PROBLEM" | tr -s '[:space:]' ' ' | cut -c1-200)

FIX_PROMPT="/claude-mem:mem-search ${QUERY}

Problem statement:
${PROBLEM}

Using what you've learned from the codebase (see memory above), produce a minimal unified diff that fixes this bug. Edit files in place. Do NOT commit."

set +e
(
  cd "$REPO_DIR" && HOME="$SCRATCH" claude \
    --print \
    --resume "$SESSION_ID" \
    --plugin-dir /opt/claude-mem \
    --permission-mode bypassPermissions \
    --allowedTools "Read,Glob,Grep,Edit,Write,Bash(git *),Bash(ls *)" \
    --max-budget-usd 5.00 \
    --output-format json \
    "$FIX_PROMPT"
) > "$FIX_LOG" 2>&1
FIX_EXIT=$?
set -e

if [[ "$FIX_EXIT" -ne 0 ]]; then
  echo "WARN: fix turn exited with $FIX_EXIT; will still emit prediction row" >&2
fi

# ---------- Capture diff and emit prediction row ----------
# Write the diff to DIFF_OUT first (authoritative for the batch orchestrator),
# then read it back for the JSONL row (kept for standalone/smoke-test use).
git -C "$REPO_DIR" diff > "$DIFF_OUT" || : > "$DIFF_OUT"
DIFF=$(cat "$DIFF_OUT")

jq -nc \
  --arg id "$INSTANCE_ID" \
  --arg patch "$DIFF" \
  --arg model "$MODEL_NAME" \
  '{instance_id:$id, model_patch:$patch, model_name_or_path:$model}' \
  >> "$OUT_PREDICTIONS_PATH"

PREDICTION_EMITTED=1
