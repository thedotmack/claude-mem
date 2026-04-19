#!/usr/bin/env bash
# Drop into an interactive claude-mem container with OAuth creds + persistent
# memory volume. For ad-hoc testing / poking around.
#
# Usage:
#   docker/claude-mem/run.sh
#   docker/claude-mem/run.sh claude --plugin-dir /opt/claude-mem --print "hi"
#
# On exit, the mounted .claude-mem/ dir on the host survives so you can inspect
# the DB: `sqlite3 <HOST_MEM_DIR>/claude-mem.db 'select count(*) from observations'`.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TAG="${TAG:-claude-mem:basic}"

HOST_MEM_DIR="${HOST_MEM_DIR:-$REPO_ROOT/.docker-claude-mem-data}"
mkdir -p "$HOST_MEM_DIR"
echo "[run] host .claude-mem dir: $HOST_MEM_DIR" >&2

# Auth. Prefer OAuth (extracted from macOS Keychain / Linux creds file);
# fall back to ANTHROPIC_API_KEY env.
CREDS_FILE=""
CREDS_MOUNT_ARGS=()
if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
  CREDS_FILE="$(mktemp -t claude-mem-creds.XXXXXX.json)"
  trap 'rm -f "$CREDS_FILE"' EXIT

  if [[ "$(uname)" == "Darwin" ]]; then
    if ! security find-generic-password -s 'Claude Code-credentials' -w > "$CREDS_FILE" 2>/dev/null; then
      echo "ERROR: no ANTHROPIC_API_KEY set and 'Claude Code-credentials' not in macOS Keychain." >&2
      echo "       Run \`claude login\` on the host first, or set ANTHROPIC_API_KEY." >&2
      exit 1
    fi
  elif [[ -f "$HOME/.claude/.credentials.json" ]]; then
    cp "$HOME/.claude/.credentials.json" "$CREDS_FILE"
  else
    echo "ERROR: no ANTHROPIC_API_KEY and no ~/.claude/.credentials.json." >&2
    exit 1
  fi
  chmod 644 "$CREDS_FILE"
  CREDS_MOUNT_ARGS=(
    -e CLAUDE_MEM_CREDENTIALS_FILE=/auth/.credentials.json
    -v "$CREDS_FILE:/auth/.credentials.json:ro"
  )
else
  CREDS_MOUNT_ARGS=(-e ANTHROPIC_API_KEY)
fi

# Pick -it only when a TTY is attached (keeps non-interactive callers working).
TTY_ARGS=()
[[ -t 0 && -t 1 ]] && TTY_ARGS=(-it)

exec docker run --rm "${TTY_ARGS[@]}" \
  "${CREDS_MOUNT_ARGS[@]}" \
  -v "$HOST_MEM_DIR:/home/node/.claude-mem" \
  "$TAG" \
  "$@"
