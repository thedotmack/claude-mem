#!/bin/bash
# Save Observation Hook for Cursor
# Captures MCP tool usage and shell command execution
# Maps to claude-mem's save-hook functionality

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
workspace_root=$(json_get "$input" "workspace_roots[0]" "")

# Fallback to current directory if no workspace root
if is_empty "$workspace_root"; then
  workspace_root=$(pwd)
fi

# Use conversation_id as session_id (stable across turns), fallback to generation_id
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

# Determine hook type and extract relevant data
hook_event=$(json_get "$input" "hook_event_name" "")

if [ "$hook_event" = "afterMCPExecution" ]; then
  # MCP tool execution
  tool_name=$(json_get "$input" "tool_name" "")
  
  if is_empty "$tool_name"; then
    exit 0
  fi
  
  # Extract tool_input and tool_response, defaulting to {} if invalid
  tool_input=$(echo "$input" | jq -c '.tool_input // {}' 2>/dev/null || echo "{}")
  tool_response=$(echo "$input" | jq -c '.result_json // {}' 2>/dev/null || echo "{}")
  
  # Validate JSON
  if ! echo "$tool_input" | jq empty 2>/dev/null; then
    tool_input="{}"
  fi
  if ! echo "$tool_response" | jq empty 2>/dev/null; then
    tool_response="{}"
  fi
  
  # Prepare observation payload
  payload=$(jq -n \
    --arg sessionId "$session_id" \
    --arg toolName "$tool_name" \
    --argjson toolInput "$tool_input" \
    --argjson toolResponse "$tool_response" \
    --arg cwd "$workspace_root" \
    '{
      contentSessionId: $sessionId,
      tool_name: $toolName,
      tool_input: $toolInput,
      tool_response: $toolResponse,
      cwd: $cwd
    }' 2>/dev/null)
    
elif [ "$hook_event" = "afterShellExecution" ]; then
  # Shell command execution
  command=$(json_get "$input" "command" "")
  
  if is_empty "$command"; then
    exit 0
  fi
  
  output=$(json_get "$input" "output" "")
  
  # Treat shell commands as "Bash" tool usage
  tool_input=$(jq -n --arg cmd "$command" '{command: $cmd}' 2>/dev/null || echo '{}')
  tool_response=$(jq -n --arg out "$output" '{output: $out}' 2>/dev/null || echo '{}')
  
  payload=$(jq -n \
    --arg sessionId "$session_id" \
    --arg cwd "$workspace_root" \
    --argjson toolInput "$tool_input" \
    --argjson toolResponse "$tool_response" \
    '{
      contentSessionId: $sessionId,
      tool_name: "Bash",
      tool_input: $toolInput,
      tool_response: $toolResponse,
      cwd: $cwd
    }' 2>/dev/null)
else
  exit 0
fi

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

