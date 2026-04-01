#!/bin/sh
set -e

# Read prompt from mounted file (safe — no shell expansion of prompt content)
PROMPT_FILE="/workspace/prompt.md"
RESULTS_DIR="/workspace/results"

if [ ! -f "$PROMPT_FILE" ]; then
  echo "ERROR: Prompt file not found at $PROMPT_FILE" >&2
  echo "1" > "$RESULTS_DIR/exit-code"
  exit 1
fi

mkdir -p "$RESULTS_DIR"

# Initialize git repo for agent workspace
git init -q /workspace 2>/dev/null || true

# Run Claude Code with the prompt file content piped via stdin
# Using --print avoids shell injection from prompt content
PROMPT_CONTENT=$(cat "$PROMPT_FILE")
claude -p "$PROMPT_CONTENT" --output-format stream-json > "$RESULTS_DIR/transcript.jsonl" 2>&1
RC=$?

echo "$RC" > "$RESULTS_DIR/exit-code"
exit $RC
