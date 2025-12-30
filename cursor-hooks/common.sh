#!/bin/bash
# Common utility functions for Cursor hooks
# Source this file in hook scripts: source "$(dirname "$0")/common.sh"

# Check if required commands exist
check_dependencies() {
  local missing=()
  
  if ! command -v jq >/dev/null 2>&1; then
    missing+=("jq")
  fi
  
  if ! command -v curl >/dev/null 2>&1; then
    missing+=("curl")
  fi
  
  if [ ${#missing[@]} -gt 0 ]; then
    echo "Error: Missing required dependencies: ${missing[*]}" >&2
    echo "Please install: ${missing[*]}" >&2
    return 1
  fi
  
  return 0
}

# Safely read JSON from stdin with error handling
read_json_input() {
  local input
  input=$(cat 2>/dev/null || echo "{}")
  
  # Validate JSON
  if ! echo "$input" | jq empty 2>/dev/null; then
    # Invalid JSON - return empty object
    echo "{}"
    return 1
  fi
  
  echo "$input"
  return 0
}

# Get worker port from settings with validation
get_worker_port() {
  local data_dir="${HOME}/.claude-mem"
  local settings_file="${data_dir}/settings.json"
  local port="37777"
  
  if [ -f "$settings_file" ]; then
    local parsed_port
    parsed_port=$(jq -r '.CLAUDE_MEM_WORKER_PORT // "37777"' "$settings_file" 2>/dev/null || echo "37777")
    
    # Validate port is a number between 1-65535
    if [[ "$parsed_port" =~ ^[0-9]+$ ]] && [ "$parsed_port" -ge 1 ] && [ "$parsed_port" -le 65535 ]; then
      port="$parsed_port"
    fi
  fi
  
  echo "$port"
}

# Ensure worker is running with retries
ensure_worker_running() {
  local port="${1:-37777}"
  local max_retries="${2:-75}"  # 15 seconds total (75 * 0.2s)
  local retry_count=0
  
  while [ $retry_count -lt $max_retries ]; do
    if curl -s -f "http://127.0.0.1:${port}/api/readiness" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
    retry_count=$((retry_count + 1))
  done
  
  return 1
}

# URL encode a string (basic implementation)
url_encode() {
  local string="$1"
  # Use printf to URL encode
  printf '%s' "$string" | jq -sRr @uri
}

# Get project name from workspace root
get_project_name() {
  local workspace_root="$1"
  
  if [ -z "$workspace_root" ]; then
    echo "unknown-project"
    return
  fi
  
  # Use basename, fallback to unknown-project
  local project_name
  project_name=$(basename "$workspace_root" 2>/dev/null || echo "unknown-project")
  
  # Handle edge case: empty basename (root directory)
  if [ -z "$project_name" ]; then
    # Check if it's a Windows drive root
    if [[ "$workspace_root" =~ ^[A-Za-z]:\\?$ ]]; then
      local drive_letter
      drive_letter=$(echo "$workspace_root" | grep -oE '^[A-Za-z]' | tr '[:lower:]' '[:upper:]')
      echo "drive-${drive_letter}"
    else
      echo "unknown-project"
    fi
  else
    echo "$project_name"
  fi
}

# Safely extract JSON field with fallback
# Supports both simple fields (e.g., "conversation_id") and array access (e.g., "workspace_roots[0]")
json_get() {
  local json="$1"
  local field="$2"
  local fallback="${3:-}"
  
  local value
  
  # Handle array access syntax (e.g., "workspace_roots[0]")
  if [[ "$field" =~ ^(.+)\[([0-9]+)\]$ ]]; then
    local array_field="${BASH_REMATCH[1]}"
    local index="${BASH_REMATCH[2]}"
    value=$(echo "$json" | jq -r --arg f "$array_field" --arg i "$index" --arg fb "$fallback" '.[$f] // [] | .[$i | tonumber] // $fb' 2>/dev/null || echo "$fallback")
  else
    # Simple field access
    value=$(echo "$json" | jq -r --arg f "$field" --arg fb "$fallback" '.[$f] // $fb' 2>/dev/null || echo "$fallback")
  fi
  
  echo "$value"
}

# Check if string is empty or null
is_empty() {
  local str="$1"
  [ -z "$str" ] || [ "$str" = "null" ] || [ "$str" = "empty" ]
}

