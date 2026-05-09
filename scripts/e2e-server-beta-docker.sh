#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-claude-mem-server-beta-e2e-$(date +%s)}"
RUN_ID="${E2E_RUN_ID:-$(date +%s)-$RANDOM}"
COMPOSE_FILES=(-f docker-compose.yml -f docker-compose.e2e.yml)
COMPOSE=(docker compose -p "$PROJECT_NAME" "${COMPOSE_FILES[@]}")
SERVER_SCRIPT="/opt/claude-mem/scripts/worker-service.cjs"

cd "$ROOT_DIR"

cleanup() {
  local exit_code=$?
  if [[ $exit_code -ne 0 ]]; then
    echo "[e2e] failure; recent server logs:" >&2
    "${COMPOSE[@]}" logs --no-color --tail=200 claude-mem-server valkey >&2 || true
  fi
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

wait_for_container_readiness() {
  local deadline=$((SECONDS + 120))
  until "${COMPOSE[@]}" exec -T claude-mem-server curl -fsS http://127.0.0.1:37777/api/readiness >/dev/null 2>&1; do
    if (( SECONDS > deadline )); then
      echo "[e2e] server did not become ready" >&2
      return 1
    fi
    sleep 1
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

echo "[e2e] building plugin bundles"
npm run build

echo "[e2e] starting Docker stack project=$PROJECT_NAME run=$RUN_ID"
"${COMPOSE[@]}" up --build -d valkey claude-mem-server
wait_for_container_readiness

echo "[e2e] creating API keys inside server container"
FULL_KEY_JSON="$(create_key "docker-e2e-full-$RUN_ID" "memories:read,memories:write")"
READ_ONLY_KEY_JSON="$(create_key "docker-e2e-read-$RUN_ID" "memories:read")"
FULL_KEY="$(printf '%s' "$FULL_KEY_JSON" | json_field key)"
READ_ONLY_KEY="$(printf '%s' "$READ_ONLY_KEY_JSON" | json_field key)"
READ_ONLY_KEY_ID="$(printf '%s' "$READ_ONLY_KEY_JSON" | json_field id)"

echo "[e2e] running phase1 functional paths in test container"
"${COMPOSE[@]}" run --rm \
  -e E2E_PHASE=phase1 \
  -e E2E_RUN_ID="$RUN_ID" \
  -e E2E_API_KEY="$FULL_KEY" \
  -e E2E_READ_ONLY_API_KEY="$READ_ONLY_KEY" \
  server-beta-e2e

echo "[e2e] revoking read-only key inside server container"
"${COMPOSE[@]}" exec -T claude-mem-server \
  bun "$SERVER_SCRIPT" server api-key revoke "$READ_ONLY_KEY_ID" >/dev/null

echo "[e2e] restarting server container to verify persisted state"
"${COMPOSE[@]}" restart claude-mem-server
wait_for_container_readiness

echo "[e2e] running phase2 persistence and revoked-key checks in test container"
"${COMPOSE[@]}" run --rm \
  -e E2E_PHASE=phase2 \
  -e E2E_RUN_ID="$RUN_ID" \
  -e E2E_API_KEY="$FULL_KEY" \
  -e E2E_REVOKED_API_KEY="$READ_ONLY_KEY" \
  server-beta-e2e

echo "[e2e] Docker server beta E2E passed for run=$RUN_ID"
