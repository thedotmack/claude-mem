#!/usr/bin/env bash
# Dev loop for claude-mem inside the basic container.
#
# Differences from run.sh (the ad-hoc harness):
#   - Bind-mounts host `plugin/` over `/opt/claude-mem` — host `npm run build`
#     propagates into the container without rebuilding the image.
#   - Publishes worker port on the host (default 37778 -> 37777 inside) so the
#     viewer UI is reachable from the host browser at http://localhost:37778.
#   - Binds the worker to 0.0.0.0 inside the container so Docker Desktop can
#     forward the port (the default 127.0.0.1 bind blocks host access).
#   - Persists `~/.claude-mem` at $REPO_ROOT/.docker-claude-mem-data on the host
#     so DB + Chroma survive across container restarts.
#   - Starts the worker in the background, then drops you into an interactive
#     shell with `claude` on PATH. Exit the shell to stop the container.
#
# Usage:
#   docker/claude-mem/dev.sh
#   HOST_PORT=38000 docker/claude-mem/dev.sh
#   docker/claude-mem/dev.sh claude --plugin-dir /opt/claude-mem
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TAG="${TAG:-claude-mem:basic}"
CONTAINER_NAME="${CONTAINER_NAME:-claude-mem-dev}"
HOST_PORT="${HOST_PORT:-37778}"

HOST_MEM_DIR="${HOST_MEM_DIR:-$REPO_ROOT/.docker-claude-mem-data}"
mkdir -p "$HOST_MEM_DIR"
echo "[dev] host .claude-mem dir: $HOST_MEM_DIR" >&2
echo "[dev] host worker port:    $HOST_PORT  -> 37777 in container" >&2
echo "[dev] plugin bind-mount:   $REPO_ROOT/plugin -> /opt/claude-mem (rw)" >&2

# Auth — mirror run.sh: Keychain → file → ANTHROPIC_API_KEY.
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
    echo "ERROR: no ANTHROPIC_API_KEY and no Claude OAuth credentials found." >&2
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

# Tear down any previous dev container — idempotent restart.
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true

TTY_ARGS=()
[[ -t 0 && -t 1 ]] && TTY_ARGS=(-it)

# Default command: boot worker in background, drop to bash. Override by passing
# a command after the script name.
if [[ $# -eq 0 ]]; then
  set -- bash -c '
    set -e
    mkdir -p "$HOME/.claude-mem/logs"
    echo "[dev] starting worker on 0.0.0.0:37777..."
    nohup bun /opt/claude-mem/scripts/worker-service.cjs \
      > "$HOME/.claude-mem/logs/worker.log" 2>&1 &
    WORKER_PID=$!
    echo "[dev] worker pid=$WORKER_PID (log: ~/.claude-mem/logs/worker.log)"
    for i in 1 2 3 4 5 6 7 8 9 10; do
      if curl -sS -m 1 http://127.0.0.1:37777/health >/dev/null 2>&1; then
        echo "[dev] worker healthy after ${i}s"
        break
      fi
      sleep 1
    done
    echo "[dev] viewer UI:   http://localhost:'"$HOST_PORT"'/"
    echo "[dev] plugin dir:  /opt/claude-mem (bind-mount)"
    echo "[dev] launch claude with: claude --plugin-dir /opt/claude-mem"
    exec bash
  '
fi

docker run --rm ${TTY_ARGS[@]+"${TTY_ARGS[@]}"} \
  --name "$CONTAINER_NAME" \
  -p "$HOST_PORT:37777" \
  -e CLAUDE_MEM_WORKER_HOST=0.0.0.0 \
  "${CREDS_MOUNT_ARGS[@]}" \
  -v "$REPO_ROOT/plugin:/opt/claude-mem" \
  -v "$HOST_MEM_DIR:/home/node/.claude-mem" \
  "$TAG" \
  "$@"
