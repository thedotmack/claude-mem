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

  # Try macOS Keychain first (primary storage on Darwin), then fall back to
  # the on-disk credentials file — some macOS setups (older CLI versions,
  # users who migrated machines) still have the file-only form.
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

# Pick -it only when a TTY is attached (keeps non-interactive callers working).
# Initialize with a no-op flag so the array is never empty (nounset-safe).
TTY_ARGS=()
[[ -t 0 && -t 1 ]] && TTY_ARGS=(-it)

# NOT `exec` — we want the EXIT trap above to run and remove $CREDS_FILE
# after the container exits. Running docker as a child keeps the shell
# alive long enough for the trap to fire.
docker run --rm ${TTY_ARGS[@]+"${TTY_ARGS[@]}"} \
  "${CREDS_MOUNT_ARGS[@]}" \
  -v "$HOST_MEM_DIR:/home/node/.claude-mem" \
  "$TAG" \
  "$@"
