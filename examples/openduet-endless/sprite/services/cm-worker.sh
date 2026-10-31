#!/usr/bin/env bash
# Sprite service: claude-mem's worker for OpenDuet, with its own data folder. The observer's OpenRouter key goes into
# its environment only, never into a file.
source "$(dirname "$0")/common.sh"
cd "$CM_DATA"
export CLAUDE_MEM_OPENROUTER_API_KEY="$(read_openrouter_key)" CLAUDE_MEM_DATA_DIR="$CM_DATA" HOME="$CM_HOME" \
  DO_NOT_TRACK=1 PATH="$OD_HOME/bin:$PATH"
exec bun "$CM_REPO/src/services/worker-service.ts" --daemon
