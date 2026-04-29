#!/usr/bin/env bash

set -euo pipefail

mkdir -p "$HOME/.claude" "$HOME/.claude-mem"

if [[ -n "${CLAUDE_MEM_CREDENTIALS_FILE:-}" ]]; then
  if [[ ! -f "$CLAUDE_MEM_CREDENTIALS_FILE" ]]; then
    echo "ERROR: CLAUDE_MEM_CREDENTIALS_FILE set but file missing: $CLAUDE_MEM_CREDENTIALS_FILE" >&2
    exit 1
  fi
  cp "$CLAUDE_MEM_CREDENTIALS_FILE" "$HOME/.claude/.credentials.json"
  chmod 600 "$HOME/.claude/.credentials.json"
fi

export PATH="/usr/local/bun/bin:/usr/local/share/npm-global/bin:$PATH"

exec "$@"
