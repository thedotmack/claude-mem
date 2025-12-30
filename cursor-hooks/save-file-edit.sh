#!/bin/bash
# Save File Edit Hook for Cursor
# Captures file edits made by the agent
# Maps file edits to claude-mem observations

# Source common utilities
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/common.sh" 2>/dev/null || {
  echo "Warning: common.sh not found, using fallback functions" >&2
}

# Check dependencies (non-blocking)
check_dependencies >/dev/null 2>&1 || true

# Read JSON input from stdin with error handling
input=$(read_json_input)

# Extract common fields with safe fallbacks
conversation_id=$(json_get "$input" "conversation_id" "")
generation_id=$(json_get "$input" "generation_id" "")
file_path=$(json_get "$input" "file_path" "")
workspace_root=$(json_get "$input" "workspace_roots[0]" "")

# Fallback to current directory if no workspace root
if is_empty "$workspace_root"; then
  workspace_root=$(pwd)
fi

# Exit if no file_path
if is_empty "$file_path"; then
  exit 0
fi

# Use conversation_id as session_id, fallback to generation_id
session_id="$conversation_id"
if is_empty "$session_id"; then
  session_id="$generation_id"
fi

# Exit if no session_id available
if is_empty "$session_id"; then
  exit 0
fi

# Get worker port from settings with validation
worker_port=$(get_worker_port)

# Extract edits array, defaulting to [] if invalid
edits=$(echo "$input" | jq -c '.edits // []' 2>/dev/null || echo "[]")

# Validate edits is a valid JSON array
if ! echo "$edits" | jq 'type == "array"' 2>/dev/null | grep -q true; then
  edits="[]"
fi

# Exit if no edits
if [ "$edits" = "[]" ] || is_empty "$edits"; then
  exit 0
fi

# Create a summary of the edits for the observation (with error handling)
edit_summary=$(echo "$edits" | jq -r '[.[] | "\(.old_string[0:50] // "")... → \(.new_string[0:50] // "")..."] | join("; ")' 2>/dev/null || echo "File edited")

# Treat file edits as a "write_file" tool usage
tool_input=$(jq -n \
  --arg path "$file_path" \
  --argjson edits "$edits" \
  '{
    file_path: $path,
    edits: $edits
  }' 2>/dev/null || echo '{}')

tool_response=$(jq -n \
  --arg summary "$edit_summary" \
  '{
    success: true,
    summary: $summary
  }' 2>/dev/null || echo '{}')

payload=$(jq -n \
  --arg sessionId "$session_id" \
  --arg cwd "$workspace_root" \
  --argjson toolInput "$tool_input" \
  --argjson toolResponse "$tool_response" \
  '{
    contentSessionId: $sessionId,
    tool_name: "write_file",
    tool_input: $toolInput,
    tool_response: $toolResponse,
    cwd: $cwd
  }' 2>/dev/null)

# Exit if payload creation failed
if [ -z "$payload" ]; then
  exit 0
fi

# Ensure worker is running (with retries like claude-mem hooks)
if ! ensure_worker_running "$worker_port"; then
  # Worker not ready - exit gracefully (don't block Cursor)
  exit 0
fi

# Send observation to claude-mem worker (fire-and-forget)
curl -s -X POST \
  "http://127.0.0.1:${worker_port}/api/sessions/observations" \
  -H "Content-Type: application/json" \
  -d "$payload" \
  >/dev/null 2>&1 || true

exit 0

