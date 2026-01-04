#!/bin/bash
# Session Initialization Hook for Cursor
# Maps to claude-mem's new-hook functionality
# Initializes a new session when a prompt is submitted
#
# NOTE: This hook runs as part of beforeSubmitPrompt and MUST output valid JSON
# with at least {"continue": true} to allow prompt submission.

# Source common utilities
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/common.sh" 2>/dev/null || {
  # Fallback - output continue and exit
  echo '{"continue": true}'
  exit 0
}

# Check dependencies (non-blocking - just warn)
check_dependencies >/dev/null 2>&1 || true

# Read JSON input from stdin with error handling
input=$(read_json_input)

# Extract common fields with safe fallbacks
conversation_id=$(json_get "$input" "conversation_id" "")
generation_id=$(json_get "$input" "generation_id" "")
prompt=$(json_get "$input" "prompt" "")
workspace_root=$(json_get "$input" "workspace_roots[0]" "")

# Fallback to current directory if no workspace root
if is_empty "$workspace_root"; then
  workspace_root=$(pwd)
fi

# Get project name from workspace root
project_name=$(get_project_name "$workspace_root")

# Use conversation_id as session_id (stable across turns), fallback to generation_id
session_id="$conversation_id"
if is_empty "$session_id"; then
  session_id="$generation_id"
fi

# Exit gracefully if no session_id available (still allow prompt)
if is_empty "$session_id"; then
  echo '{"continue": true}'
  exit 0
fi

# Get worker port from settings with validation
worker_port=$(get_worker_port)

# Ensure worker is running (with retries like claude-mem hooks)
if ! ensure_worker_running "$worker_port"; then
  # Worker not ready - still allow prompt to continue
  echo '{"continue": true}'
  exit 0
fi

# Strip leading slash from commands for memory agent (parity with new-hook.ts)
# /review 101 → review 101 (more semantic for observations)
cleaned_prompt="$prompt"
if [ -n "$prompt" ] && [ "${prompt:0:1}" = "/" ]; then
  cleaned_prompt="${prompt:1}"
fi

# Initialize session via HTTP - handles DB operations and privacy checks
payload=$(jq -n \
  --arg sessionId "$session_id" \
  --arg project "$project_name" \
  --arg promptText "$cleaned_prompt" \
  '{
    contentSessionId: $sessionId,
    project: $project,
    prompt: $promptText
  }' 2>/dev/null)

# Exit if payload creation failed (still allow prompt)
if [ -z "$payload" ]; then
  echo '{"continue": true}'
  exit 0
fi

# Send request to worker (fire-and-forget, don't wait for response)
curl -s -X POST \
  "http://127.0.0.1:${worker_port}/api/sessions/init" \
  -H "Content-Type: application/json" \
  -d "$payload" \
  >/dev/null 2>&1 &

# Always allow prompt to continue
echo '{"continue": true}'
exit 0

