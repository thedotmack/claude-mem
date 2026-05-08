#!/usr/bin/env bash
#
# Phase 10 — server-beta Docker E2E.
#
# Brings up Postgres + Valkey + claude-mem-server (HTTP) + claude-mem-worker
# (BullMQ generation) and verifies:
#   - no legacy `worker-service.cjs` / WorkerService process anywhere
#   - POST /v1/events?wait=true generates an observation through the queue
#   - server restart mid-stream preserves jobs and observations
#   - revoking an API key denies subsequent reads/writes (401/403)
#
# All assertions are fatal; the script exits non-zero on any failure.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-claude-mem-server-beta-e2e-$(date +%s)}"
RUN_ID="${E2E_RUN_ID:-$(date +%s)-$RANDOM}"
COMPOSE_FILES=(-f docker-compose.yml -f docker-compose.e2e.yml)
# Test-only credentials. docker-compose.yml requires these to be set; the
# stack will refuse to start without them. The values here are scoped to the
# ephemeral E2E project namespace and are torn down by the cleanup trap.
export POSTGRES_USER="${POSTGRES_USER:-claudemem_e2e}"
export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-claudemem_e2e}"
export POSTGRES_DB="${POSTGRES_DB:-claudemem_e2e}"
COMPOSE=(docker compose -p "$PROJECT_NAME" "${COMPOSE_FILES[@]}")
SERVER_SCRIPT="/opt/claude-mem/scripts/server-beta-service.cjs"
# server-beta-service.cjs has its own `server api-key create|list|revoke`
# subtree backed by Postgres (NOT the SQLite worker-service tree).
SERVER_HEALTH_URL="http://127.0.0.1:37877/healthz"

cd "$ROOT_DIR"

cleanup() {
  local exit_code=$?
  if [[ $exit_code -ne 0 ]]; then
    echo "[e2e] failure; recent logs:" >&2
    "${COMPOSE[@]}" logs --no-color --tail=200 \
      claude-mem-server claude-mem-worker valkey postgres >&2 || true
  fi
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

wait_for_container_readiness() {
  local deadline=$((SECONDS + 180))
  until "${COMPOSE[@]}" exec -T claude-mem-server curl -fsS "$SERVER_HEALTH_URL" >/dev/null 2>&1; do
    if (( SECONDS > deadline )); then
      echo "[e2e] server did not become ready within 180s" >&2
      return 1
    fi
    sleep 2
  done
}

json_field() {
  local field="$1"
  node -e '
    const field = process.argv[1];
    let raw = "";
    process.stdin.on("data", chunk => raw += chunk);
    process.stdin.on("end", () => {
      const value = JSON.parse(raw)[field];
      if (value === undefined || value === null) process.exit(1);
      process.stdout.write(String(value));
    });
  ' "$field"
}

create_key() {
  local name="$1"
  local scopes="$2"
  "${COMPOSE[@]}" exec -T claude-mem-server \
    bun "$SERVER_SCRIPT" server api-key create --name "$name" --scope "$scopes"
}

assert_no_worker_process() {
  echo "[e2e] verifying no legacy worker process is running"
  # `docker compose ps` should not list a service named "worker" (legacy).
  # The new generation worker is named `claude-mem-worker`; that's allowed.
  local services
  services="$("${COMPOSE[@]}" ps --services)"
  if echo "$services" | grep -E '(^|\s)worker($|\s)' | grep -v 'claude-mem-worker' >/dev/null; then
    echo "[e2e] FAIL — unexpected legacy worker service in compose stack:" >&2
    echo "$services" >&2
    return 1
  fi

  # No process inside the server container should be running worker-service.cjs.
  if "${COMPOSE[@]}" exec -T claude-mem-server pgrep -af 'worker-service\.cjs' >/dev/null 2>&1; then
    echo "[e2e] FAIL — worker-service.cjs is running inside claude-mem-server" >&2
    "${COMPOSE[@]}" exec -T claude-mem-server pgrep -af 'worker-service\.cjs' >&2 || true
    return 1
  fi
  if "${COMPOSE[@]}" exec -T claude-mem-worker pgrep -af 'worker-service\.cjs' >/dev/null 2>&1; then
    echo "[e2e] FAIL — worker-service.cjs is running inside claude-mem-worker" >&2
    return 1
  fi
  echo "[e2e] no legacy worker processes detected"
}

assert_local_dev_rejected_in_docker() {
  echo "[e2e] verifying local-dev auth is rejected inside Docker"
  # Run a throwaway server-beta container with CLAUDE_MEM_AUTH_MODE=local-dev.
  # validateServerBetaEnv() should refuse to start and exit non-zero.
  local rc=0
  "${COMPOSE[@]}" run --rm \
    --no-deps \
    -e CLAUDE_MEM_AUTH_MODE=local-dev \
    -e CLAUDE_MEM_ALLOW_LOCAL_DEV_BYPASS=1 \
    -e CLAUDE_MEM_CONTAINER_MODE=server \
    claude-mem-server >/tmp/local-dev-stdout.$$ 2>/tmp/local-dev-stderr.$$ \
    || rc=$?
  if [[ $rc -eq 0 ]]; then
    echo "[e2e] FAIL — server-beta started with CLAUDE_MEM_AUTH_MODE=local-dev in Docker" >&2
    cat /tmp/local-dev-stderr.$$ >&2 || true
    rm -f /tmp/local-dev-stdout.$$ /tmp/local-dev-stderr.$$
    return 1
  fi
  if ! grep -q 'local-dev is not allowed in Docker' /tmp/local-dev-stderr.$$; then
    echo "[e2e] FAIL — expected local-dev rejection message; saw:" >&2
    cat /tmp/local-dev-stderr.$$ >&2 || true
    rm -f /tmp/local-dev-stdout.$$ /tmp/local-dev-stderr.$$
    return 1
  fi
  rm -f /tmp/local-dev-stdout.$$ /tmp/local-dev-stderr.$$
  echo "[e2e] local-dev auth correctly rejected"
}

echo "[e2e] building plugin bundles"
npm run build

echo "[e2e] starting Docker stack project=$PROJECT_NAME run=$RUN_ID"
"${COMPOSE[@]}" up --build -d postgres valkey claude-mem-server claude-mem-worker
wait_for_container_readiness
assert_no_worker_process

echo "[e2e] creating API keys inside server container"
FULL_KEY_JSON="$(create_key "docker-e2e-full-$RUN_ID" "events:write,sessions:write,observations:read,jobs:read,memories:read,memories:write")"
READ_ONLY_KEY_JSON="$(create_key "docker-e2e-read-$RUN_ID" "observations:read,jobs:read,memories:read")"
FULL_KEY="$(printf '%s' "$FULL_KEY_JSON" | json_field key)"
READ_ONLY_KEY="$(printf '%s' "$READ_ONLY_KEY_JSON" | json_field key)"
READ_ONLY_KEY_ID="$(printf '%s' "$READ_ONLY_KEY_JSON" | json_field id)"
FULL_PROJECT_ID="$(printf '%s' "$FULL_KEY_JSON" | json_field projectId)"

echo "[e2e] running phase1 functional paths in test container"
"${COMPOSE[@]}" run --rm \
  -e E2E_PHASE=phase1 \
  -e E2E_RUN_ID="$RUN_ID" \
  -e E2E_API_KEY="$FULL_KEY" \
  -e E2E_READ_ONLY_API_KEY="$READ_ONLY_KEY" \
  -e E2E_PROJECT_ID="$FULL_PROJECT_ID" \
  server-beta-e2e

echo "[e2e] revoking read-only key inside server container"
"${COMPOSE[@]}" exec -T claude-mem-server \
  bun "$SERVER_SCRIPT" server api-key revoke "$READ_ONLY_KEY_ID" >/dev/null

echo "[e2e] restarting server container to verify persisted state and queue durability"
"${COMPOSE[@]}" restart claude-mem-server claude-mem-worker
wait_for_container_readiness
assert_no_worker_process

echo "[e2e] running phase2 persistence and revoked-key checks in test container"
"${COMPOSE[@]}" run --rm \
  -e E2E_PHASE=phase2 \
  -e E2E_RUN_ID="$RUN_ID" \
  -e E2E_API_KEY="$FULL_KEY" \
  -e E2E_REVOKED_API_KEY="$READ_ONLY_KEY" \
  -e E2E_PROJECT_ID="$FULL_PROJECT_ID" \
  server-beta-e2e

echo "[e2e] verifying anti-pattern guards"
assert_local_dev_rejected_in_docker

echo "[e2e] Docker server beta E2E passed for run=$RUN_ID"
