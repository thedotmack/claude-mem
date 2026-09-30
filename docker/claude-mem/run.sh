#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TAG="${TAG:-claude-mem:basic}"

HOST_MEM_DIR="${HOST_MEM_DIR:-$REPO_ROOT/.docker-claude-mem-data}"
mkdir -p "$HOST_MEM_DIR"
echo "[run] host .claude-mem dir: $HOST_MEM_DIR" >&2

CREDS_FILE=""
CREDS_MOUNT_ARGS=()
if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
  CREDS_FILE="$(mktemp -t claude-mem-creds.XXXXXX.json)"
  trap 'rm -f "$CREDS_FILE"' EXIT

  creds_obtained=0
  if [[ "$(uname)" == "Darwin" ]]; then
    if security find-generic-password -s 'Claude Code-credentials' -w > "$CREDS_FILE" 2>/dev/null \
       && [[ -s "$CREDS_FILE" ]]; then
      creds_obtained=1
    fi
  fi
  if [[ "$creds_obtained" -eq 0 && -f "$HOME/.claude/.credentials.json" ]]; then
    cp "$HOME/.claude/.credentials.json" "$CREDS_FILE"
    creds_obtained=1
  fi
  if [[ "$creds_obtained" -eq 0 ]]; then
    echo "ERROR: no ANTHROPIC_API_KEY set and no Claude OAuth credentials found." >&2
    echo "       Tried: macOS Keychain ('Claude Code-credentials') and ~/.claude/.credentials.json." >&2
    echo "       Run \`claude login\` on the host first, or set ANTHROPIC_API_KEY." >&2
    exit 1
  fi
  chmod 600 "$CREDS_FILE"
  CREDS_MOUNT_ARGS=(
    -e CLAUDE_MEM_CREDENTIALS_FILE=/auth/.credentials.json
    -v "$CREDS_FILE:/auth/.credentials.json:ro"
  )
else
  CREDS_MOUNT_ARGS=(-e ANTHROPIC_API_KEY)
fi

TTY_ARGS=()
[[ -t 0 && -t 1 ]] && TTY_ARGS=(-it)

docker run --rm ${TTY_ARGS[@]+"${TTY_ARGS[@]}"} \
  "${CREDS_MOUNT_ARGS[@]}" \
  -v "$HOST_MEM_DIR:/home/node/.claude-mem" \
  "$TAG" \
  "$@"
