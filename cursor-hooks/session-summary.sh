#!/bin/bash
# Session Summary Hook for Cursor (stop)
# Called when agent loop ends
#
# This hook:
# 1. Generates session summary
# 2. Updates context file for next session
#
# Output: Empty JSON {} or {"followup_message": "..."} for auto-iteration

# Source common utilities
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/common.sh" 2>/dev/null || {
  echo '{}'
  exit 0
}

# Check dependencies (non-blocking)
check_dependencies >/dev/null 2>&1 || true

# Read JSON input from stdin with error handling
input=$(read_json_input)

# Extract common fields with safe fallbacks
conversation_id=$(json_get "$input" "conversation_id" "")
generation_id=$(json_get "$input" "generation_id" "")
workspace_root=$(json_get "$input" "workspace_roots[0]" "")
status=$(json_get "$input" "status" "completed")

# Fallback workspace to current directory
if is_empty "$workspace_root"; then
  workspace_root=$(pwd)
fi

# Get project name
project_name=$(get_project_name "$workspace_root")

# Use conversation_id as session_id, fallback to generation_id
session_id="$conversation_id"
if is_empty "$session_id"; then
  session_id="$generation_id"
fi

# Exit if no session_id available
if is_empty "$session_id"; then
  echo '{}'
  exit 0
fi

# Get worker port from settings with validation
worker_port=$(get_worker_port)

# Ensure worker is running (with retries)
if ! ensure_worker_running "$worker_port"; then
  echo '{}'
  exit 0
fi

# 1. Request summary generation (fire-and-forget)
# Note: Cursor doesn't provide transcript_path like Claude Code does,
# so we can't extract last_user_message and last_assistant_message.
payload=$(jq -n \
  --arg sessionId "$session_id" \
  '{
    contentSessionId: $sessionId,
    last_user_message: "",
    last_assistant_message: ""
  }' 2>/dev/null)

if [ -n "$payload" ]; then
  curl -s -X POST \
    "http://127.0.0.1:${worker_port}/api/sessions/summarize" \
    -H "Content-Type: application/json" \
    -d "$payload" \
    >/dev/null 2>&1 &
fi

# 2. Update context file for next session
# Fetch fresh context (includes observations from this session)
project_encoded=$(url_encode "$project_name")
context=$(curl -s -f "http://127.0.0.1:${worker_port}/api/context/inject?project=${project_encoded}" 2>/dev/null || echo "")

if [ -n "$context" ]; then
  rules_dir="${workspace_root}/.cursor/rules"
  rules_file="${rules_dir}/claude-mem-context.mdc"
  
  # Create rules directory if it doesn't exist
  mkdir -p "$rules_dir" 2>/dev/null || true
  
  # Write context as a Cursor rule with alwaysApply: true
  cat > "$rules_file" 2>/dev/null << EOF
---
alwaysApply: true
description: "Claude-mem context from past sessions (auto-updated)"
---

# Memory Context from Past Sessions

The following context is from claude-mem, a persistent memory system that tracks your coding sessions.

${context}

---
*Updated after last session. Use claude-mem's MCP search tools for more detailed queries.*
EOF
fi

# Output empty JSON - no followup message
echo '{}'
exit 0

