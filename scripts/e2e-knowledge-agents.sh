#!/usr/bin/env bash
#
# E2E Test: Knowledge Agents
# Fully hands-off test of the complete knowledge agent lifecycle.
# Designed to be orchestrated via tmux-cli from Claude Code.
#
# Flow: health check → build corpus → list → get → prime → query → reprime → query → rebuild → delete → verify
#
set -euo pipefail

WORKER_URL="http://localhost:37777"
CORPUS_NAME="e2e-test-knowledge-agent"
PASS_COUNT=0
FAIL_COUNT=0
LOG_FILE="${HOME}/.claude-mem/logs/e2e-knowledge-agents-$(date +%Y%m%d-%H%M%S).log"

# -- Helpers ------------------------------------------------------------------

log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG_FILE"; }
pass() { PASS_COUNT=$((PASS_COUNT + 1)); log "PASS: $1"; }
fail() { FAIL_COUNT=$((FAIL_COUNT + 1)); log "FAIL: $1 — $2"; }

assert_http_status() {
  local description="$1" expected_status="$2" actual_status="$3"
  if [[ "$actual_status" == "$expected_status" ]]; then
    pass "$description (HTTP $actual_status)"
  else
    fail "$description" "expected HTTP $expected_status, got $actual_status"
  fi
}

assert_json_field() {
  local description="$1" json="$2" field="$3" expected="$4"
  local actual
  actual=$(echo "$json" | jq -r "$field" 2>/dev/null || echo "PARSE_ERROR")
  if [[ "$actual" == "$expected" ]]; then
    pass "$description ($field=$actual)"
  else
    fail "$description" "expected $field=$expected, got $actual"
  fi
}

assert_json_field_not_empty() {
  local description="$1" json="$2" field="$3"
  local actual
  actual=$(echo "$json" | jq -r "$field" 2>/dev/null || echo "")
  if [[ -n "$actual" && "$actual" != "null" && "$actual" != "" ]]; then
    pass "$description ($field is present)"
  else
    fail "$description" "$field is empty or null"
  fi
}

assert_json_field_numeric_gt() {
  local description="$1" json="$2" field="$3" min_value="$4"
  local actual
  actual=$(echo "$json" | jq -r "$field" 2>/dev/null || echo "0")
  if [[ "$actual" -gt "$min_value" ]] 2>/dev/null; then
    pass "$description ($field=$actual > $min_value)"
  else
    fail "$description" "expected $field > $min_value, got $actual"
  fi
}

curl_get() {
  curl -sS --connect-timeout 5 --max-time 30 -w '\n%{http_code}' "$WORKER_URL$1" 2>/dev/null || printf '\n000'
}

curl_post() {
  local path="$1" body="$2" max_time="${3:-30}"
  curl -sS --connect-timeout 5 --max-time "$max_time" -w '\n%{http_code}' -X POST "$WORKER_URL$path" \
    -H 'Content-Type: application/json' \
    -d "$body" 2>/dev/null || printf '\n000'
}

curl_delete() {
  curl -sS --connect-timeout 5 --max-time 30 -w '\n%{http_code}' -X DELETE "$WORKER_URL$1" 2>/dev/null || printf '\n000'
}

extract_body_and_status() {
  local response="$1"
  RESPONSE_BODY=$(echo "$response" | sed '$d')
  RESPONSE_STATUS=$(echo "$response" | tail -1)
}

# -- Cleanup ------------------------------------------------------------------

cleanup_test_corpus() {
  log "Cleaning up test corpus '$CORPUS_NAME'..."
  curl -s -X DELETE "$WORKER_URL/api/corpus/$CORPUS_NAME" > /dev/null 2>&1 || true
}

# -- Tests --------------------------------------------------------------------

test_worker_health() {
  log "=== Test: Worker Health ==="
  local response
  response=$(curl_get "/api/health")
  extract_body_and_status "$response"
  assert_http_status "Worker health check" "200" "$RESPONSE_STATUS"
}

test_worker_readiness() {
  log "=== Test: Worker Readiness ==="
  local response
  response=$(curl_get "/api/readiness")
  extract_body_and_status "$response"
  assert_http_status "Worker readiness check" "200" "$RESPONSE_STATUS"
}

test_build_corpus() {
  log "=== Test: Build Corpus ==="
  local response
  response=$(curl_post "/api/corpus" "{
    \"name\": \"$CORPUS_NAME\",
    \"description\": \"E2E test corpus for knowledge agents\",
    \"query\": \"architecture\",
    \"limit\": 20
  }")
  extract_body_and_status "$response"
  assert_http_status "Build corpus" "200" "$RESPONSE_STATUS"
  assert_json_field "Build corpus name" "$RESPONSE_BODY" ".name" "$CORPUS_NAME"
  assert_json_field_not_empty "Build corpus description" "$RESPONSE_BODY" ".description"
  assert_json_field_not_empty "Build corpus stats" "$RESPONSE_BODY" ".stats.observation_count"
  log "Build response: $(echo "$RESPONSE_BODY" | jq -c '{name, stats: .stats}' 2>/dev/null)"
}

test_list_corpora() {
  log "=== Test: List Corpora ==="
  local response
  response=$(curl_get "/api/corpus")
  extract_body_and_status "$response"
  assert_http_status "List corpora" "200" "$RESPONSE_STATUS"

  # Verify our test corpus is in the list
  local found
  found=$(echo "$RESPONSE_BODY" | jq -r ".[] | select(.name == \"$CORPUS_NAME\") | .name" 2>/dev/null)
  if [[ "$found" == "$CORPUS_NAME" ]]; then
    pass "Test corpus found in list"
  else
    fail "Test corpus in list" "corpus '$CORPUS_NAME' not found"
  fi
}

test_get_corpus() {
  log "=== Test: Get Corpus ==="
  local response
  response=$(curl_get "/api/corpus/$CORPUS_NAME")
  extract_body_and_status "$response"
  assert_http_status "Get corpus" "200" "$RESPONSE_STATUS"
  assert_json_field "Get corpus name" "$RESPONSE_BODY" ".name" "$CORPUS_NAME"
  assert_json_field "Get corpus session_id (pre-prime)" "$RESPONSE_BODY" ".session_id" "null"
}

test_get_corpus_404() {
  log "=== Test: Get Nonexistent Corpus ==="
  local response
  response=$(curl_get "/api/corpus/nonexistent-corpus-that-does-not-exist")
  extract_body_and_status "$response"
  assert_http_status "Get nonexistent corpus returns 404" "404" "$RESPONSE_STATUS"
}

test_prime_corpus() {
  log "=== Test: Prime Corpus ==="
  log "  (This may take 30-120 seconds — Agent SDK session is being created...)"
  local response
  response=$(curl_post "/api/corpus/$CORPUS_NAME/prime" '{}' 300)
  extract_body_and_status "$response"
  assert_http_status "Prime corpus" "200" "$RESPONSE_STATUS"
  assert_json_field_not_empty "Prime returns session_id" "$RESPONSE_BODY" ".session_id"
  assert_json_field "Prime returns corpus name" "$RESPONSE_BODY" ".name" "$CORPUS_NAME"
  log "Prime response: $(echo "$RESPONSE_BODY" | jq -c '{name, session_id: (.session_id | .[0:20] + "...")}' 2>/dev/null)"
}

test_query_corpus() {
  log "=== Test: Query Corpus ==="
  local response
  response=$(curl_post "/api/corpus/$CORPUS_NAME/query" '{"question": "What are the main topics and themes in this knowledge base? Give a brief summary."}' 300)
  extract_body_and_status "$response"
  assert_http_status "Query corpus" "200" "$RESPONSE_STATUS"
  assert_json_field_not_empty "Query returns answer" "$RESPONSE_BODY" ".answer"
  assert_json_field_not_empty "Query returns session_id" "$RESPONSE_BODY" ".session_id"

  local answer_length
  answer_length=$(echo "$RESPONSE_BODY" | jq -r '.answer | length' 2>/dev/null || echo "0")
  if [[ "$answer_length" -gt 50 ]]; then
    pass "Query answer is substantive (${answer_length} chars)"
  else
    fail "Query answer length" "expected > 50 chars, got $answer_length"
  fi
  log "Query answer preview: $(echo "$RESPONSE_BODY" | jq -r '.answer' 2>/dev/null | head -3)"
}

test_query_without_prime() {
  log "=== Test: Query Unprimed Corpus ==="
  # Build a second corpus but don't prime it
  curl_post "/api/corpus" "{\"name\": \"e2e-unprimed-test\", \"limit\": 5}" > /dev/null 2>&1
  local response
  response=$(curl_post "/api/corpus/e2e-unprimed-test/query" '{"question": "test"}' 30)
  extract_body_and_status "$response"
  # Should fail because corpus isn't primed
  if [[ "$RESPONSE_STATUS" != "200" ]] || echo "$RESPONSE_BODY" | jq -r '.error' 2>/dev/null | grep -qi "prime\|session"; then
    pass "Query unprimed corpus correctly rejected"
  else
    fail "Query unprimed corpus" "expected error about priming, got HTTP $RESPONSE_STATUS"
  fi
  # Cleanup
  curl -s -X DELETE "$WORKER_URL/api/corpus/e2e-unprimed-test" > /dev/null 2>&1 || true
}

test_reprime_corpus() {
  log "=== Test: Reprime Corpus ==="
  log "  (Creating fresh session...)"

  # Capture old session_id
  local old_response old_session_id
  old_response=$(curl_get "/api/corpus/$CORPUS_NAME")
  extract_body_and_status "$old_response"
  old_session_id=$(echo "$RESPONSE_BODY" | jq -r '.session_id' 2>/dev/null)

  local response
  response=$(curl_post "/api/corpus/$CORPUS_NAME/reprime" '{}' 300)
  extract_body_and_status "$response"
  assert_http_status "Reprime corpus" "200" "$RESPONSE_STATUS"
  assert_json_field_not_empty "Reprime returns session_id" "$RESPONSE_BODY" ".session_id"

  local new_session_id
  new_session_id=$(echo "$RESPONSE_BODY" | jq -r '.session_id' 2>/dev/null)
  if [[ "$new_session_id" != "$old_session_id" ]]; then
    pass "Reprime created new session (different session_id)"
  else
    fail "Reprime session_id" "expected new session_id, got same as before"
  fi
}

test_query_after_reprime() {
  log "=== Test: Query After Reprime ==="
  local response
  response=$(curl_post "/api/corpus/$CORPUS_NAME/query" '{"question": "List the types of observations in this knowledge base."}' 300)
  extract_body_and_status "$response"
  assert_http_status "Query after reprime" "200" "$RESPONSE_STATUS"
  assert_json_field_not_empty "Answer after reprime" "$RESPONSE_BODY" ".answer"
  log "Post-reprime answer preview: $(echo "$RESPONSE_BODY" | jq -r '.answer' 2>/dev/null | head -3)"
}

test_rebuild_corpus() {
  log "=== Test: Rebuild Corpus ==="
  local response
  response=$(curl_post "/api/corpus/$CORPUS_NAME/rebuild" '{}' 60)
  extract_body_and_status "$response"
  assert_http_status "Rebuild corpus" "200" "$RESPONSE_STATUS"
  assert_json_field "Rebuild returns name" "$RESPONSE_BODY" ".name" "$CORPUS_NAME"
  assert_json_field_not_empty "Rebuild returns stats" "$RESPONSE_BODY" ".stats.observation_count"
}

test_delete_corpus() {
  log "=== Test: Delete Corpus ==="
  local response
  response=$(curl_delete "/api/corpus/$CORPUS_NAME")
  extract_body_and_status "$response"
  assert_http_status "Delete corpus" "200" "$RESPONSE_STATUS"

  # Verify it's gone
  local verify_response
  verify_response=$(curl_get "/api/corpus/$CORPUS_NAME")
  extract_body_and_status "$verify_response"
  assert_http_status "Deleted corpus returns 404" "404" "$RESPONSE_STATUS"
}

test_delete_nonexistent() {
  log "=== Test: Delete Nonexistent Corpus ==="
  local response
  response=$(curl_delete "/api/corpus/nonexistent-corpus-that-does-not-exist")
  extract_body_and_status "$response"
  assert_http_status "Delete nonexistent returns 404" "404" "$RESPONSE_STATUS"
}

# -- Main ---------------------------------------------------------------------

main() {
  mkdir -p "$(dirname "$LOG_FILE")"
  log "======================================================"
  log "  Knowledge Agents E2E Test"
  log "  $(date)"
  log "======================================================"
  log ""

  # Cleanup any leftover test data
  cleanup_test_corpus

  # Phase 1: Health checks
  test_worker_health
  test_worker_readiness
  log ""

  # Phase 2: CRUD operations
  test_build_corpus
  test_list_corpora
  test_get_corpus
  test_get_corpus_404
  log ""

  # Phase 3: Agent SDK operations (prime + query)
  test_prime_corpus
  test_query_corpus
  test_query_without_prime
  log ""

  # Phase 4: Reprime + query again
  test_reprime_corpus
  test_query_after_reprime
  log ""

  # Phase 5: Rebuild + cleanup
  test_rebuild_corpus
  test_delete_corpus
  test_delete_nonexistent
  log ""

  # Summary
  local total=$((PASS_COUNT + FAIL_COUNT))
  log "======================================================"
  log "  RESULTS: $PASS_COUNT/$total passed, $FAIL_COUNT failed"
  log "======================================================"

  if [[ "$FAIL_COUNT" -gt 0 ]]; then
    log "  STATUS: FAILED"
    log "  Log: $LOG_FILE"
    exit 1
  else
    log "  STATUS: ALL PASSED"
    log "  Log: $LOG_FILE"
    exit 0
  fi
}

main "$@"
