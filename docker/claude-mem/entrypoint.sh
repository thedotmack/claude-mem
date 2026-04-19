#!/usr/bin/env bash
# Entrypoint for the basic claude-mem container. Seeds OAuth creds if a
# credentials file is mounted, then exec's whatever was passed (default: bash).
#
# Env vars:
#   CLAUDE_MEM_CREDENTIALS_FILE  Path to a mounted OAuth credentials JSON file
#                                (e.g. /auth/.credentials.json). Copied into
#                                $HOME/.claude/.credentials.json at startup.
#   ANTHROPIC_API_KEY            Standard API-key auth; set when OAuth isn't used.

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

# Helpful one-liner for interactive users: run `claude` with the plugin dir
# preconfigured. Don't force it — `exec "$@"` lets you override freely.
export PATH="/usr/local/bun/bin:/usr/local/share/npm-global/bin:$PATH"

exec "$@"
