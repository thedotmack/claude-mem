#!/usr/bin/env bash
# scripts/validate-server-beta.sh
#
# End-to-end contract validator for the server-beta runtime.
#
# This is the contract validator for the server-beta runtime path.
#
# Contract:
#   - Idempotent. Re-running on a dirty machine wipes state and starts clean.
#   - No manual SQL. No env-var debugging. No scope hacks.
#   - Each of 10 steps logs PASS or FAIL with an actionable next-step hint.
#   - Exit code 0 = all green. Exit code 1 = first failing step.
#
# Dependencies: bash, curl, jq, docker compose (v2).
#
# Usage:
#   bash scripts/validate-server-beta.sh
#
# Environment overrides:
#   CLAUDE_MEM_SERVER_BETA_PORT   default 37877
#   POSTGRES_USER                 default claudemem
#   POSTGRES_PASSWORD             default claudemem
#   POSTGRES_DB                   default claudemem
#   CLAUDE_MEM_SERVER_DATABASE_URL  default postgres://claudemem:claudemem@localhost:5432/claudemem
#   API_KEY_NAME                  default e2e-validator
#   PROVIDER                      default claude (info-only; worker honors its own env)
#   ANTHROPIC_API_KEY             optional; without it Step 6 fails fast (clean error)
#   VALIDATE_HEALTH_TIMEOUT       default 60   (seconds to wait for healthchecks)
#   VALIDATE_JOB_TIMEOUT          default 30   (seconds to wait for generation)

set -u
# NOTE: no `set -e` — we manage step-level failure ourselves so the next-step
# hints render correctly. Each step calls `fail` on error and we exit there.

# -----------------------------------------------------------------------------
# Config
# -----------------------------------------------------------------------------
PORT="${CLAUDE_MEM_SERVER_BETA_PORT:-37877}"
PG_USER="${POSTGRES_USER:-claudemem}"
PG_PASSWORD="${POSTGRES_PASSWORD:-claudemem}"
PG_DB="${POSTGRES_DB:-claudemem}"
DB_URL="${CLAUDE_MEM_SERVER_DATABASE_URL:-postgres://${PG_USER}:${PG_PASSWORD}@localhost:5432/${PG_DB}}"
API_KEY_NAME="${API_KEY_NAME:-e2e-validator}"
PROVIDER="${PROVIDER:-claude}"
HEALTH_TIMEOUT="${VALIDATE_HEALTH_TIMEOUT:-60}"
JOB_TIMEOUT="${VALIDATE_JOB_TIMEOUT:-30}"

BASE_URL="http://127.0.0.1:${PORT}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOTAL_STEPS=10

# Colors (only if attached to a TTY)
if [[ -t 1 ]]; then
  C_RED=$'\033[0;31m'; C_GREEN=$'\033[0;32m'; C_YELLOW=$'\033[0;33m'
  C_BLUE=$'\033[0;34m'; C_BOLD=$'\033[1m'; C_RESET=$'\033[0m'
else
  C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''; C_BOLD=''; C_RESET=''
fi

CURRENT_STEP=0
LAST_FAIL_STEP=0

# -----------------------------------------------------------------------------
# Logging helpers
# -----------------------------------------------------------------------------
step_begin() {
  CURRENT_STEP=$1
  shift
  printf '%s[STEP %d/%d]%s %s ... ' "${C_BLUE}" "${CURRENT_STEP}" "${TOTAL_STEPS}" "${C_RESET}" "$*"
}

pass() {
  printf '%sPASS%s\n' "${C_GREEN}" "${C_RESET}"
}

fail() {
  printf '%sFAIL%s\n' "${C_RED}" "${C_RESET}"
  LAST_FAIL_STEP=${CURRENT_STEP}
  if [[ $# -gt 0 ]]; then
    printf '%s  → %s%s\n' "${C_YELLOW}" "$*" "${C_RESET}"
  fi
}

hint() {
  printf '%s  hint: %s%s\n' "${C_YELLOW}" "$*" "${C_RESET}"
}

die() {
  echo
  printf '%s=== VALIDATION FAILED at step %d/%d ===%s\n' \
    "${C_BOLD}${C_RED}" "${LAST_FAIL_STEP}" "${TOTAL_STEPS}" "${C_RESET}"
  exit 1
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "${C_RED}fatal:${C_RESET} required command '$1' not found in PATH" >&2
    exit 2
  fi
}

# -----------------------------------------------------------------------------
# Preflight
# -----------------------------------------------------------------------------
require_cmd docker
require_cmd curl
require_cmd jq
if ! docker compose version >/dev/null 2>&1; then
  echo "${C_RED}fatal:${C_RESET} 'docker compose' (v2) is required" >&2
  exit 2
fi

cd "${REPO_ROOT}"

# Export required POSTGRES_* env vars for docker compose (the compose file
# uses :? syntax and refuses to start without them).
export POSTGRES_USER="${PG_USER}"
export POSTGRES_PASSWORD="${PG_PASSWORD}"
export POSTGRES_DB="${PG_DB}"

# CLI invocation: prefer built binary, fall back to ts-source via bun if
# available. The script does NOT require the build to be present, but it
# DOES require the dist/npx-cli/index.js to exist before any of the 
# scopes can pass.
CLI_CMD=(node "${REPO_ROOT}/dist/npx-cli/index.js")
if [[ ! -f "${REPO_ROOT}/dist/npx-cli/index.js" ]]; then
  # Pre-build fallback: agents may iterate without building. Try bun on src
  # directly. If neither works, we still continue; Step 3 will fail loudly.
  if command -v bun >/dev/null 2>&1 && [[ -f "${REPO_ROOT}/src/npx-cli/index.ts" ]]; then
    CLI_CMD=(bun "${REPO_ROOT}/src/npx-cli/index.ts")
  fi
fi

echo "${C_BOLD}=== claude-mem server-beta E2E validator ===${C_RESET}"
echo "  port:        ${PORT}"
echo "  db-url:      ${DB_URL}"
echo "  cli:         ${CLI_CMD[*]}"
echo "  provider:    ${PROVIDER}"
echo "  api-key:     ${API_KEY_NAME}"
echo

# -----------------------------------------------------------------------------
# Step 1 — clean slate
# -----------------------------------------------------------------------------
step_begin 1 "BUG-N/A: docker compose down -v (clean slate)"
if docker compose down -v --remove-orphans >/dev/null 2>&1; then
  pass
else
  fail "docker compose down failed"
  hint "Is docker daemon running? Try: docker ps"
  die
fi

# -----------------------------------------------------------------------------
# Step 2 — build + start + wait for healthy
# -----------------------------------------------------------------------------
step_begin 2 "docker compose up -d --build (wait <=${HEALTH_TIMEOUT}s for healthy)"
if ! docker compose up -d --build >/tmp/claude-mem-validate-up.log 2>&1; then
  fail "docker compose up failed"
  hint "See /tmp/claude-mem-validate-up.log for build/start errors"
  hint "Did you set POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB env vars?"
  die
fi

# Poll until all containers report 'healthy' (or one reports unhealthy/exited).
# docker-compose.yml defines healthchecks on: postgres, valkey, claude-mem-server.
# claude-mem-worker has NO healthcheck today, so we accept 'running'.
deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
expected_services=(postgres valkey claude-mem-server claude-mem-worker)
all_healthy=0
while (( $(date +%s) < deadline )); do
  ok=1
  for svc in "${expected_services[@]}"; do
    cid=$(docker compose ps -q "$svc" 2>/dev/null || true)
    if [[ -z "$cid" ]]; then ok=0; break; fi
    state=$(docker inspect -f '{{.State.Status}}' "$cid" 2>/dev/null || echo "missing")
    health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid" 2>/dev/null || echo "none")
    if [[ "$state" != "running" ]]; then ok=0; break; fi
    # If a healthcheck exists, require it to be healthy. Otherwise running is fine.
    if [[ "$health" != "none" && "$health" != "healthy" ]]; then ok=0; break; fi
  done
  if (( ok == 1 )); then all_healthy=1; break; fi
  sleep 2
done

if (( all_healthy != 1 )); then
  fail "not all containers reached healthy within ${HEALTH_TIMEOUT}s"
  echo "  --- docker compose ps ---"
  docker compose ps
  hint "Inspect logs: docker compose logs --tail=80"
  die
fi
pass

# -----------------------------------------------------------------------------
# Step 3 — bootstrap API key via CLI (no manual SQL)
# -----------------------------------------------------------------------------
step_begin 3 "bootstrap API key via CLI (CLAUDE_MEM_RUNTIME=server-beta -> Postgres, default scopes superset)"
# the CLI must write to Postgres when CLAUDE_MEM_RUNTIME=server-beta
# AND CLAUDE_MEM_SERVER_DATABASE_URL is set. If it silently falls back to
# SQLite, step 4 will fail with 403.
# the bootstrapped key MUST carry memories:read AND memories:write.
api_key_log=/tmp/claude-mem-validate-key.log
if ! CLAUDE_MEM_RUNTIME=server-beta \
     CLAUDE_MEM_SERVER_DATABASE_URL="${DB_URL}" \
     "${CLI_CMD[@]}" server api-key create \
       --name "${API_KEY_NAME}" \
       --scope "memories:read,memories:write,events:write,sessions:write,observations:read,jobs:read" \
       >"${api_key_log}" 2>&1; then
  fail "CLI api-key create exited non-zero"
  echo "  --- last 40 lines ---"
  tail -n 40 "${api_key_log}" | sed 's/^/    /'
  hint "CLI may be writing to ~/.claude-mem/claude-mem.db (SQLite) instead of Postgres."
  hint "under Node 22+ the CLI may crash with 'Dynamic require of \"events\"' — try Bun."
  hint "Did you map the postgres port to the host? See docker-compose.override.yml for the 'dev' profile."
  die
fi

# Extract the raw key. Output format may vary (text or JSON). Accept either.
API_KEY=$(grep -oE 'cmem_[A-Za-z0-9_-]+' "${api_key_log}" | head -n 1 || true)
if [[ -z "${API_KEY}" ]]; then
  fail "could not parse cmem_* key from CLI output"
  echo "  --- last 40 lines ---"
  tail -n 40 "${api_key_log}" | sed 's/^/    /'
  hint "The CLI output format may have changed; expected to find a 'cmem_...' token."
  die
fi
pass
printf '  api-key: %s%s%s (length=%d)\n' "${C_BOLD}" "${API_KEY:0:14}…" "${C_RESET}" "${#API_KEY}"

# -----------------------------------------------------------------------------
# Step 4 — POST /v1/memories
# -----------------------------------------------------------------------------
step_begin 4 "POST /v1/memories (expect 201; verifies memories:write scope present on bootstrapped key)"
mem_body=$(cat <<'JSON'
{
  "content": "validator-mem-v1: claude-mem server-beta validation memory created at boot.",
  "metadata": { "source": "validate-server-beta.sh", "phase": "step-4" },
  "tags": ["e2e", "validator"]
}
JSON
)
mem_http=$(curl -sS -o /tmp/claude-mem-validate-mem.json -w '%{http_code}' \
  -X POST "${BASE_URL}/v1/memories" \
  -H "Authorization: Bearer ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d "${mem_body}" || true)
if [[ "${mem_http}" != "201" && "${mem_http}" != "200" ]]; then
  fail "POST /v1/memories returned HTTP ${mem_http}"
  echo "  --- response body ---"
  cat /tmp/claude-mem-validate-mem.json | head -c 1000 | sed 's/^/    /'
  echo
  hint "HTTP 403 →  (scopes mismatch). HTTP 401 →  (CLI wrote to SQLite, not PG)."
  hint "HTTP 500 → check 'docker compose logs claude-mem-server --tail=80'."
  die
fi
MEMORY_ID=$(jq -r '.id // .memoryId // empty' /tmp/claude-mem-validate-mem.json 2>/dev/null || true)
pass
[[ -n "${MEMORY_ID}" ]] && printf '  memoryId: %s\n' "${MEMORY_ID}"

# -----------------------------------------------------------------------------
# Step 5 — POST /v1/events (enqueue a generation job)
# -----------------------------------------------------------------------------
step_begin 5 "POST /v1/events (expect 202 + jobId; verifies ModeManager loaded + worker consuming)"
# Payload synthesised to give Claude enough signal to produce a non-skipped
# observation. Mode prompts typically skip trivial commands; an Edit tool
# event with concrete file path + diff content yields a stable observation.
ev_body=$(cat <<'JSON'
{
  "eventType": "PostToolUse",
  "sourceType": "hook",
  "payload": {
    "tool_name": "Edit",
    "tool_input": {
      "file_path": "/tmp/validator-step-5-feature.ts",
      "old_string": "// TODO: implement validator feature",
      "new_string": "// Implemented validator feature for end-to-end test\nexport function validatorFeature() { return 'validator-step-5-result'; }"
    },
    "tool_response": { "filePath": "/tmp/validator-step-5-feature.ts", "oldString": "// TODO", "newString": "validatorFeature", "success": true },
    "session_id": "validator-session-e2e",
    "transcript_path": "/dev/null"
  }
}
JSON
)
ev_http=$(curl -sS -o /tmp/claude-mem-validate-ev.json -w '%{http_code}' \
  -X POST "${BASE_URL}/v1/events" \
  -H "Authorization: Bearer ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d "${ev_body}" || true)
if [[ "${ev_http}" != "202" && "${ev_http}" != "201" && "${ev_http}" != "200" ]]; then
  fail "POST /v1/events returned HTTP ${ev_http}"
  echo "  --- response body ---"
  cat /tmp/claude-mem-validate-ev.json | head -c 1000 | sed 's/^/    /'
  echo
  hint "HTTP 403 →  (events:write scope missing on bootstrapped key)."
  hint "HTTP 500 → worker may not be reachable; check 'docker compose logs claude-mem-worker'."
  die
fi
JOB_ID=$(jq -r '.jobId // .id // .job.id // empty' /tmp/claude-mem-validate-ev.json 2>/dev/null || true)
if [[ -z "${JOB_ID}" ]]; then
  fail "could not parse jobId from /v1/events response"
  cat /tmp/claude-mem-validate-ev.json | head -c 500 | sed 's/^/    /'
  echo
  hint "Expected one of: .jobId, .id, .job.id in the JSON body."
  die
fi
pass
printf '  jobId: %s\n' "${JOB_ID}"

# -----------------------------------------------------------------------------
# Step 6 — poll /v1/jobs/{id} until completed
# -----------------------------------------------------------------------------
step_begin 6 "+11+25: poll /v1/jobs/${JOB_ID} (expect completed within ${JOB_TIMEOUT}s)"
deadline=$(( $(date +%s) + JOB_TIMEOUT ))
job_status=""
job_error=""
while (( $(date +%s) < deadline )); do
  curl -sS -o /tmp/claude-mem-validate-job.json -w '' \
    "${BASE_URL}/v1/jobs/${JOB_ID}" \
    -H "Authorization: Bearer ${API_KEY}" || true
  job_status=$(jq -r '.status // empty' /tmp/claude-mem-validate-job.json 2>/dev/null || true)
  if [[ "${job_status}" == "completed" || "${job_status}" == "succeeded" || "${job_status}" == "success" ]]; then
    break
  fi
  if [[ "${job_status}" == "failed" || "${job_status}" == "error" ]]; then
    job_error=$(jq -r '.error // .failedReason // empty' /tmp/claude-mem-validate-job.json 2>/dev/null || true)
    break
  fi
  sleep 2
done

if [[ "${job_status}" == "completed" || "${job_status}" == "succeeded" || "${job_status}" == "success" ]]; then
  pass
elif [[ "${job_status}" == "failed" || "${job_status}" == "error" ]]; then
  fail "job ${JOB_ID} ended with status=${job_status}"
  printf '  error: %s\n' "${job_error:-<none>}"
  hint "If error mentions 'No mode loaded':  (ModeManager not initialized in server-beta)."
  hint "If error mentions 'ANTHROPIC_API_KEY': set ANTHROPIC_API_KEY in .env (worker provider not configured)."
  hint "If error mentions a column 'merged_into_project':  (Postgres schema missing column)."
  die
else
  fail "job ${JOB_ID} did not complete within ${JOB_TIMEOUT}s (last status: ${job_status:-<none>})"
  echo "  --- last job body ---"
  cat /tmp/claude-mem-validate-job.json | head -c 800 | sed 's/^/    /'
  echo
  hint "worker may be running idle with no provider configured (no log)."
  hint "queue retries unbounded — job may be looping. Inspect 'docker compose logs claude-mem-worker'."
  die
fi

# -----------------------------------------------------------------------------
# Step 7 — POST /v1/search and find the generated observation
# -----------------------------------------------------------------------------
step_begin 7 "POST /v1/search with platformSource filter (expect at least one hit)"
search_body='{"query": "validator", "limit": 20, "platformSource": "hook"}'
search_http=$(curl -sS -o /tmp/claude-mem-validate-search.json -w '%{http_code}' \
  -X POST "${BASE_URL}/v1/search" \
  -H "Authorization: Bearer ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d "${search_body}" || true)
if [[ "${search_http}" != "200" ]]; then
  fail "POST /v1/search returned HTTP ${search_http}"
  cat /tmp/claude-mem-validate-search.json | head -c 600 | sed 's/^/    /'
  echo
  hint "HTTP 403 →  (observations:read scope missing)."
  hint "HTTP 404 →  (server-beta /v1/search route missing — MCP routes through wrong backend)."
  hint "zero hits while observation exists may indicate platformSource filter ignored."
  die
fi
hit_count=$(jq -r '(.observations // .results // .matches // []) | length' /tmp/claude-mem-validate-search.json 2>/dev/null || echo 0)
if [[ "${hit_count}" =~ ^[0-9]+$ ]] && (( hit_count > 0 )); then
  pass
  printf '  hits: %d\n' "${hit_count}"
else
  fail "search returned 0 hits"
  hint "The generated observation should be findable. Did Step 6 actually produce content?"
  hint "Inspect: curl -sS '${BASE_URL}/v1/search' ... | jq ."
  die
fi

# -----------------------------------------------------------------------------
# Step 8 — POST /v1/context and verify observation present
# -----------------------------------------------------------------------------
step_begin 8 "POST /v1/context (expect observation present; verifies context-fetch routing)"
ctx_body='{"query": "validator", "limit": 20}'
ctx_http=$(curl -sS -o /tmp/claude-mem-validate-ctx.json -w '%{http_code}' \
  -X POST "${BASE_URL}/v1/context" \
  -H "Authorization: Bearer ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d "${ctx_body}" || true)
if [[ "${ctx_http}" != "200" ]]; then
  fail "POST /v1/context returned HTTP ${ctx_http}"
  cat /tmp/claude-mem-validate-ctx.json | head -c 600 | sed 's/^/    /'
  echo
  hint "HTTP 404 →  (route missing). HTTP 403 → scope gap."
  die
fi
ctx_size=$(jq -r '(.context // .text // "") | length' /tmp/claude-mem-validate-ctx.json 2>/dev/null || echo 0)
ctx_hits=$(jq -r '(.observations // .matches // []) | length' /tmp/claude-mem-validate-ctx.json 2>/dev/null || echo 0)
if [[ ! "${ctx_size}" =~ ^[0-9]+$ ]]; then ctx_size=0; fi
if [[ ! "${ctx_hits}" =~ ^[0-9]+$ ]]; then ctx_hits=0; fi
if (( ctx_size > 0 || ctx_hits > 0 )); then
  pass
  printf '  context-bytes: %d, observation-refs: %d\n' "${ctx_size}" "${ctx_hits}"
else
  fail "/v1/context returned empty payload"
  cat /tmp/claude-mem-validate-ctx.json | head -c 600 | sed 's/^/    /'
  echo
  hint "The generated observation from Step 6 should appear in the context pack."
  die
fi

# -----------------------------------------------------------------------------
# Step 9 — final aggregate
# -----------------------------------------------------------------------------
step_begin 9 "GET /healthz (server still up — daemon did not exit immediately)"
health_http=$(curl -sS -o /tmp/claude-mem-validate-healthz.txt -w '%{http_code}' "${BASE_URL}/healthz" || echo "000")
if [[ "${health_http}" != "200" ]]; then
  fail "GET /healthz returned HTTP ${health_http}"
  hint "server-beta-service.cjs may have exited immediately after spawning daemon child."
  die
fi
pass

# -----------------------------------------------------------------------------
# Step 10 — exit cleanly
# -----------------------------------------------------------------------------
step_begin 10 "PASS/FAIL summary + exit 0"
pass

echo
printf '%s=== ALL %d STEPS PASSED — server-beta is healthy ===%s\n' \
  "${C_BOLD}${C_GREEN}" "${TOTAL_STEPS}" "${C_RESET}"
exit 0
