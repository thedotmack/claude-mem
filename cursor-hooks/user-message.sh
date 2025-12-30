#!/bin/bash
# User Message Hook for Cursor
# Displays context information to the user
# Maps to claude-mem's user-message-hook functionality
# Note: Cursor doesn't have a direct equivalent, but we can output to stderr
# for visibility in Cursor's output channels
#
# This is an OPTIONAL hook. It can be added to beforeSubmitPrompt if desired,
# but may be verbose since it runs on every prompt submission.

# Read JSON input from stdin (if any)
input=$(cat 2>/dev/null || echo "{}")

# Extract workspace root
workspace_root=$(echo "$input" | jq -r '.workspace_roots[0] // empty' 2>/dev/null || echo "")

if [ -z "$workspace_root" ]; then
  workspace_root=$(pwd)
fi

# Get project name
project_name=$(basename "$workspace_root" 2>/dev/null || echo "unknown-project")

# Get worker port from settings
data_dir="${HOME}/.claude-mem"
settings_file="${data_dir}/settings.json"
worker_port="37777"

if [ -f "$settings_file" ]; then
  worker_port=$(jq -r '.CLAUDE_MEM_WORKER_PORT // "37777"' "$settings_file" 2>/dev/null || echo "37777")
fi

# Ensure worker is running
max_retries=75
retry_count=0
while [ $retry_count -lt $max_retries ]; do
  if curl -s -f "http://127.0.0.1:${worker_port}/api/readiness" > /dev/null 2>&1; then
    break
  fi
  sleep 0.2
  retry_count=$((retry_count + 1))
done

# If worker not ready, exit silently
if [ $retry_count -eq $max_retries ]; then
  exit 0
fi

# Fetch formatted context from worker API (with colors)
context_url="http://127.0.0.1:${worker_port}/api/context/inject?project=${project_name}&colors=true"
output=$(curl -s -f "$context_url" 2>/dev/null || echo "")

# Output to stderr for visibility (parity with user-message-hook.ts)
# Note: Cursor may not display stderr the same way Claude Code does,
# but this is the best we can do without direct UI integration
if [ -n "$output" ]; then
  echo "" >&2
  echo "📝 Claude-Mem Context Loaded" >&2
  echo "   ℹ️  Viewing context from past sessions" >&2
  echo "" >&2
  echo "$output" >&2
  echo "" >&2
  echo "💡 Tip: Wrap content with <private> ... </private> to prevent storing sensitive information." >&2
  echo "💬 Community: https://discord.gg/J4wttp9vDu" >&2
  echo "📺 Web Viewer: http://localhost:${worker_port}/" >&2
  echo "" >&2
fi

exit 0

