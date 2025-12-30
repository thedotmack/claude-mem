#!/bin/bash
# Context Hook for Cursor (beforeSubmitPrompt)
# Ensures worker is running before prompt submission
#
# NOTE: Context is NOT updated here. Context updates happen in the stop hook
# (session-summary.sh) after the session completes, so new observations are included.

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

# Get worker port from settings
worker_port=$(get_worker_port)

# Ensure worker is running (with retries)
# This primes the worker before the session starts
ensure_worker_running "$worker_port" >/dev/null 2>&1 || true

# Allow prompt to continue
echo '{"continue": true}'
exit 0

