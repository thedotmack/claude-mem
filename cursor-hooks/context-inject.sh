#!/bin/bash
# Context Hook for Cursor (beforeSubmitPrompt)
# Ensures worker is running and refreshes context before prompt submission
#
# Context is updated in BOTH places:
# - Here (beforeSubmitPrompt): Fresh context at session start
# - stop hook (session-summary.sh): Updated context after observations are made

# Source common utilities
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/common.sh" 2>/dev/null || {
  echo '{"continue": true}'
  exit 0
}

# Check dependencies (non-blocking)
check_dependencies >/dev/null 2>&1 || true

# Read JSON input from stdin
input=$(read_json_input)

# Extract workspace root
workspace_root=$(json_get "$input" "workspace_roots[0]" "")
if is_empty "$workspace_root"; then
  workspace_root=$(pwd)
fi

# Get project name
project_name=$(get_project_name "$workspace_root")

# Get worker port from settings
worker_port=$(get_worker_port)

# Ensure worker is running (with retries)
# This primes the worker before the session starts
if ensure_worker_running "$worker_port" >/dev/null 2>&1; then
  # Refresh context file with latest observations
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
fi

# Allow prompt to continue
echo '{"continue": true}'
exit 0

