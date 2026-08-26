#!/usr/bin/env bash

# claude-mem-docker — control the stable containerized claude-mem worker.
#
#   on       Switch this machine's memory to the Docker worker: flips
#            CLAUDE_MEM_EXTERNAL_WORKER=true in ~/.claude-mem/settings.json,
#            shuts down the host worker, starts the container.
#   off      Switch back to the normal host worker: stops the container,
#            flips the flag off (the next hook event lazy-spawns the host
#            worker as usual).
#   status   Show mode, container state, and worker health/version.
#   seed     Copy the host's ~/.claude-mem database + Chroma into the
#            container volume (docker/local/seed-data.sh; --force to overwrite).
#   build    Build the image from this checkout's plugin/ directory.
#   upgrade  Rebuild the image from this checkout (npm run build first) and
#            restart the container on it. The data volume is untouched.
#   logs     Tail the container logs.
#
# The container publishes the worker port on 127.0.0.1 only.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
COMPOSE=(docker compose -f "$REPO_ROOT/docker-compose.local.yml")
SETTINGS="$HOME/.claude-mem/settings.json"
CONTAINER_NAME="claude-mem-local"

worker_port() {
  node -e '
const fs = require("fs");
try {
  const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  process.stdout.write(String(s.CLAUDE_MEM_WORKER_PORT || 37777));
} catch { process.stdout.write("37777"); }
' "$SETTINGS"
}

set_external_flag() {
  node -e '
const fs = require("fs");
const p = process.argv[1];
const s = JSON.parse(fs.readFileSync(p, "utf8"));
s.CLAUDE_MEM_EXTERNAL_WORKER = process.argv[2];
fs.writeFileSync(p, JSON.stringify(s, null, 2) + "\n");
' "$SETTINGS" "$1"
}

external_flag() {
  node -e '
const fs = require("fs");
try {
  const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  process.stdout.write(s.CLAUDE_MEM_EXTERNAL_WORKER === "true" ? "true" : "false");
} catch { process.stdout.write("false"); }
' "$SETTINGS"
}

port_alive() {
  curl -s -o /dev/null --max-time 3 "http://127.0.0.1:$1/api/health"
}

container_running() {
  [[ -n "$(docker ps -q -f "name=^${CONTAINER_NAME}$")" ]]
}

wait_port_state() { # $1=port $2=alive|dead $3=timeout_s
  local deadline=$((SECONDS + $3))
  while ((SECONDS < deadline)); do
    if [[ "$2" == "alive" ]]; then
      port_alive "$1" && return 0
    else
      port_alive "$1" || return 0
    fi
    sleep 1
  done
  return 1
}

PORT="$(worker_port)"

case "${1:-}" in
  on)
    echo "==> Enabling external worker mode (hooks stop managing the worker)..."
    set_external_flag true
    if ! container_running && port_alive "$PORT"; then
      echo "==> Shutting down host worker on port $PORT..."
      curl -s -X POST --max-time 10 "http://127.0.0.1:$PORT/api/admin/shutdown" >/dev/null || true
      if ! wait_port_state "$PORT" dead 20; then
        echo "ERROR: host worker did not release port $PORT; leaving external mode ON but not starting the container." >&2
        exit 1
      fi
      rm -f "$HOME/.claude-mem/worker.pid"
    fi
    echo "==> Starting container..."
    "${COMPOSE[@]}" up -d
    if wait_port_state "$PORT" alive 90; then
      echo "==> claude-mem-local is up on 127.0.0.1:$PORT — memory now runs in Docker."
    else
      echo "WARNING: container started but the worker is not answering yet; check '$0 logs'." >&2
    fi
    ;;

  off)
    echo "==> Stopping container..."
    "${COMPOSE[@]}" stop
    set_external_flag false
    echo "==> External worker mode OFF. The host worker will lazy-spawn on the next hook event."
    ;;

  status)
    echo "External worker mode: $(external_flag)"
    if container_running; then
      docker ps -f "name=^${CONTAINER_NAME}$" --format 'Container: {{.Status}}'
    else
      echo "Container: not running"
    fi
    if port_alive "$PORT"; then
      echo "Worker on 127.0.0.1:$PORT:"
      curl -s --max-time 3 "http://127.0.0.1:$PORT/api/health" | head -c 400
      echo
    else
      echo "Worker on 127.0.0.1:$PORT: not responding"
    fi
    ;;

  seed)
    shift
    "$REPO_ROOT/docker/local/seed-data.sh" "$@"
    ;;

  build)
    "${COMPOSE[@]}" build
    ;;

  upgrade)
    echo "==> Building plugin from $REPO_ROOT..."
    (cd "$REPO_ROOT" && npm run build)
    echo "==> Rebuilding image and restarting container (data volume is preserved)..."
    "${COMPOSE[@]}" build
    "${COMPOSE[@]}" up -d
    ;;

  logs)
    "${COMPOSE[@]}" logs -f --tail 100
    ;;

  *)
    sed -n '3,20p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
