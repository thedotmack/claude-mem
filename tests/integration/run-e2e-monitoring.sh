#!/bin/bash
# ============================================================================
# E2E Test Orchestrator for Assistant Message Monitoring System
# ============================================================================
#
# This script validates the entire assistant message monitoring pipeline:
#   Hook capture → metadata extraction → DB storage → SSE broadcast → REST API
#
# Usage:
#   ./tests/integration/run-e2e-monitoring.sh
#
# Prerequisites:
#   - Worker must be running on localhost:37777
#   - Or pass --start-worker to start it first
# ============================================================================

set -euo pipefail

WORKER_URL="http://localhost:37777"
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'
PASS=0
FAIL=0
SKIP=0

pass() { echo -e "  ${GREEN}✓${NC} $1"; PASS=$((PASS + 1)); }
fail() { echo -e "  ${RED}✗${NC} $1: $2"; FAIL=$((FAIL + 1)); }
skip() { echo -e "  ${YELLOW}○${NC} $1 (skipped)"; SKIP=$((SKIP + 1)); }

echo "============================================"
echo "Assistant Message Monitoring — E2E Tests"
echo "============================================"
echo ""

# --------------------------------------------------------------------------
# Pre-flight: Check worker is running
# --------------------------------------------------------------------------
echo "Pre-flight checks..."

WORKER_STATUS=$(curl -s -o /dev/null -w '%{http_code}' "$WORKER_URL/api/stats" 2>/dev/null || echo "000")
if [ "$WORKER_STATUS" != "200" ]; then
  if [ "${1:-}" = "--start-worker" ]; then
    echo "  Starting worker..."
    cd "$(dirname "$0")/../.."
    npm run build-and-sync &
    WORKER_PID=$!
    # Wait for worker to come up
    for i in $(seq 1 30); do
      sleep 2
      STATUS=$(curl -s -o /dev/null -w '%{http_code}' "$WORKER_URL/api/stats" 2>/dev/null || echo "000")
      if [ "$STATUS" = "200" ]; then
        echo "  Worker started (PID $WORKER_PID)"
        break
      fi
      if [ $i -eq 30 ]; then
        echo "  ERROR: Worker failed to start after 60s"
        exit 1
      fi
    done
  else
    echo -e "  ${RED}ERROR: Worker not running on $WORKER_URL${NC}"
    echo "  Start with: npm run build-and-sync"
    echo "  Or run with: $0 --start-worker"
    exit 1
  fi
fi

STATS=$(curl -s "$WORKER_URL/api/stats")
VERSION=$(echo "$STATS" | python3 -c "import sys,json; print(json.load(sys.stdin)['worker']['version'])" 2>/dev/null || echo "unknown")
OBS_COUNT=$(echo "$STATS" | python3 -c "import sys,json; print(json.load(sys.stdin)['database']['observations'])" 2>/dev/null || echo "?")
echo -e "  Worker v${VERSION} running, ${OBS_COUNT} observations in DB"
echo ""

# --------------------------------------------------------------------------
# Test 1: Stats endpoint returns expected fields
# --------------------------------------------------------------------------
echo "Test 1: Worker stats endpoint"
STATS_JSON=$(curl -s "$WORKER_URL/api/stats")
HAS_WORKER=$(echo "$STATS_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if 'worker' in d and 'port' in d['worker'] else 'no')" 2>/dev/null)
HAS_DB=$(echo "$STATS_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if 'database' in d and 'observations' in d['database'] else 'no')" 2>/dev/null)
if [ "$HAS_WORKER" = "yes" ] && [ "$HAS_DB" = "yes" ]; then
  pass "Stats endpoint returns worker and database info"
else
  fail "Stats endpoint" "missing worker or database fields"
fi

# --------------------------------------------------------------------------
# Test 2: SSE stream connects
# --------------------------------------------------------------------------
echo "Test 2: SSE /stream connection"
SSE_TMPFILE=$(mktemp)
curl -s -N --max-time 3 "$WORKER_URL/stream" > "$SSE_TMPFILE" 2>/dev/null || true
if grep -q '"type":"connected"' "$SSE_TMPFILE"; then
  pass "SSE stream sends 'connected' event on connect"
else
  fail "SSE stream" "no 'connected' event received"
fi
rm -f "$SSE_TMPFILE"

# --------------------------------------------------------------------------
# Test 3: Observations API returns items with metadata key
# --------------------------------------------------------------------------
echo "Test 3: GET /api/observations includes metadata field"
OBS_JSON=$(curl -s "$WORKER_URL/api/observations?limit=10")
ITEM_COUNT=$(echo "$OBS_JSON" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('items',[])))" 2>/dev/null || echo "0")
if [ "$ITEM_COUNT" -gt "0" ]; then
  # Check that 'metadata' key exists in all items
  ALL_HAVE_KEY=$(echo "$OBS_JSON" | python3 -c "
import sys,json
items = json.load(sys.stdin)['items']
print('yes' if all('metadata' in i for i in items) else 'no')
" 2>/dev/null)
  if [ "$ALL_HAVE_KEY" = "yes" ]; then
    pass "All observations have 'metadata' key in response"
  else
    fail "Observations API" "some items missing 'metadata' key"
  fi
else
  skip "No observations in database to verify"
fi

# --------------------------------------------------------------------------
# Test 4: At least some observations have non-null metadata
# --------------------------------------------------------------------------
echo "Test 4: Recent observations have populated metadata"
META_COUNT=$(echo "$OBS_JSON" | python3 -c "
import sys,json
items = json.load(sys.stdin)['items']
print(sum(1 for i in items if i.get('metadata') is not None))
" 2>/dev/null || echo "0")
if [ "$META_COUNT" -gt "0" ]; then
  pass "${META_COUNT}/${ITEM_COUNT} observations have non-null metadata"
else
  fail "Metadata population" "0/${ITEM_COUNT} observations have metadata — pipeline may be broken"
fi

# --------------------------------------------------------------------------
# Test 5: Metadata JSON structure is valid and contains tool_name
# --------------------------------------------------------------------------
echo "Test 5: Metadata JSON contains tool_name field"
VALID_META=$(echo "$OBS_JSON" | python3 -c "
import sys,json
items = json.load(sys.stdin)['items']
with_meta = [i for i in items if i.get('metadata')]
if not with_meta:
    print('skip')
else:
    all_valid = True
    for i in with_meta:
        try:
            m = json.loads(i['metadata'])
            if 'tool_name' not in m:
                all_valid = False
        except:
            all_valid = False
    print('yes' if all_valid else 'no')
" 2>/dev/null)
if [ "$VALID_META" = "yes" ]; then
  pass "All metadata JSON objects contain 'tool_name'"
elif [ "$VALID_META" = "skip" ]; then
  skip "No metadata to validate"
else
  fail "Metadata structure" "some metadata objects missing 'tool_name'"
fi

# --------------------------------------------------------------------------
# Test 6: Tool-specific metadata fields are correct
# --------------------------------------------------------------------------
echo "Test 6: Tool-specific metadata fields"
TOOL_CHECK=$(echo "$OBS_JSON" | python3 -c "
import sys,json
items = json.load(sys.stdin)['items']
tools_seen = set()
errors = []
for i in items:
    if not i.get('metadata'): continue
    m = json.loads(i['metadata'])
    tn = m.get('tool_name','')
    tools_seen.add(tn)
    # Validate tool-specific fields
    if tn == 'Read' and 'file_path' in m:
        if not isinstance(m['file_path'], str):
            errors.append(f'Read: file_path not string')
    if tn == 'WebFetch' and 'source_url' in m:
        if not m['source_url'].startswith('http'):
            errors.append(f'WebFetch: source_url not URL')
    if tn == 'Grep' and 'search_pattern' in m:
        if not isinstance(m['search_pattern'], str):
            errors.append(f'Grep: search_pattern not string')
    if tn == 'Bash' and 'command' in m:
        if not isinstance(m['command'], str):
            errors.append(f'Bash: command not string')
if errors:
    print('fail:' + '; '.join(errors))
else:
    print('pass:' + ','.join(sorted(tools_seen)))
" 2>/dev/null)
if [[ "$TOOL_CHECK" == pass:* ]]; then
  TOOLS="${TOOL_CHECK#pass:}"
  pass "Tool-specific fields valid (tools seen: ${TOOLS})"
elif [[ "$TOOL_CHECK" == fail:* ]]; then
  fail "Tool metadata" "${TOOL_CHECK#fail:}"
else
  skip "Could not validate tool metadata"
fi

# --------------------------------------------------------------------------
# Test 7: Single observation by ID preserves metadata
# --------------------------------------------------------------------------
echo "Test 7: GET /api/observation/:id preserves metadata"
FIRST_WITH_META=$(echo "$OBS_JSON" | python3 -c "
import sys,json
items = json.load(sys.stdin)['items']
for i in items:
    if i.get('metadata'):
        print(i['id'])
        break
else:
    print('none')
" 2>/dev/null)
if [ "$FIRST_WITH_META" != "none" ] && [ -n "$FIRST_WITH_META" ]; then
  SINGLE_OBS=$(curl -s "$WORKER_URL/api/observation/$FIRST_WITH_META")
  SINGLE_HAS_META=$(echo "$SINGLE_OBS" | python3 -c "
import sys,json
d = json.load(sys.stdin)
m = json.loads(d.get('metadata','{}'))
print('yes' if 'tool_name' in m else 'no')
" 2>/dev/null)
  if [ "$SINGLE_HAS_META" = "yes" ]; then
    pass "Single observation $FIRST_WITH_META has metadata intact"
  else
    fail "Single observation" "metadata lost on individual fetch"
  fi
else
  skip "No observation with metadata to test individually"
fi

# --------------------------------------------------------------------------
# Test 8: Batch observation endpoint preserves metadata
# --------------------------------------------------------------------------
echo "Test 8: POST /api/observations/batch preserves metadata"
BATCH_IDS=$(echo "$OBS_JSON" | python3 -c "
import sys,json
items = json.load(sys.stdin)['items'][:3]
print(json.dumps([i['id'] for i in items]))
" 2>/dev/null)
if [ -n "$BATCH_IDS" ] && [ "$BATCH_IDS" != "[]" ]; then
  BATCH_RESULT=$(curl -s -X POST "$WORKER_URL/api/observations/batch" \
    -H 'Content-Type: application/json' \
    -d "{\"ids\": $BATCH_IDS}")
  BATCH_HAS_META_KEY=$(echo "$BATCH_RESULT" | python3 -c "
import sys,json
items = json.load(sys.stdin)
print('yes' if all('metadata' in i for i in items) else 'no')
" 2>/dev/null)
  if [ "$BATCH_HAS_META_KEY" = "yes" ]; then
    pass "Batch endpoint returns metadata key for all observations"
  else
    fail "Batch endpoint" "metadata key missing from some batch results"
  fi
else
  skip "No observation IDs for batch test"
fi

# --------------------------------------------------------------------------
# Test 9: Pagination preserves metadata across pages
# --------------------------------------------------------------------------
echo "Test 9: Paginated observations preserve metadata"
TMPDIR_E2E=$(mktemp -d)
curl -s "$WORKER_URL/api/observations?limit=3&offset=0" > "$TMPDIR_E2E/page1.json"
curl -s "$WORKER_URL/api/observations?limit=3&offset=3" > "$TMPDIR_E2E/page2.json"
PAGINATION_CHECK=$(python3 -c "
import json
with open('$TMPDIR_E2E/page1.json') as f: p1 = json.load(f)
with open('$TMPDIR_E2E/page2.json') as f: p2 = json.load(f)
p1_items = p1.get('items',[])
p2_items = p2.get('items',[])
if not p1_items or not p2_items:
    print('skip')
else:
    p1_ids = set(i['id'] for i in p1_items)
    p2_ids = set(i['id'] for i in p2_items)
    no_overlap = len(p1_ids & p2_ids) == 0
    all_have_key = all('metadata' in i for i in p1_items + p2_items)
    if no_overlap and all_have_key:
        print('yes')
    elif not no_overlap:
        print('overlap')
    else:
        print('missing_key')
" 2>/dev/null)
rm -rf "$TMPDIR_E2E"
if [ "$PAGINATION_CHECK" = "yes" ]; then
  pass "No ID overlap and metadata key present across pages"
elif [ "$PAGINATION_CHECK" = "overlap" ]; then
  fail "Pagination" "overlapping IDs between pages"
elif [ "$PAGINATION_CHECK" = "missing_key" ]; then
  fail "Pagination" "metadata key missing on some paginated items"
else
  skip "Insufficient data for pagination test"
fi

# --------------------------------------------------------------------------
# Test 10: conversation-observe endpoint accepts valid request
# --------------------------------------------------------------------------
echo "Test 10: POST /api/sessions/conversation-observe"
TEST_SESSION="e2e-test-$(date +%s)"
CONVO_RESULT=$(curl -s -w '\n%{http_code}' -X POST "$WORKER_URL/api/sessions/conversation-observe" \
  -H 'Content-Type: application/json' \
  -d "{
    \"contentSessionId\": \"$TEST_SESSION\",
    \"exchanges\": [{
      \"promptNumber\": 1,
      \"userText\": \"E2E test: what is 2+2?\",
      \"assistantText\": \"E2E test: 2+2 equals 4.\"
    }],
    \"project\": \"e2e-test\"
  }")
CONVO_HTTP_CODE=$(echo "$CONVO_RESULT" | tail -1)
CONVO_BODY=$(echo "$CONVO_RESULT" | sed '$d')
if [ "$CONVO_HTTP_CODE" = "200" ]; then
  CONVO_STATUS=$(echo "$CONVO_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
  if [ "$CONVO_STATUS" = "accepted" ]; then
    pass "conversation-observe accepted request (status=accepted)"
  else
    fail "conversation-observe" "200 but status='$CONVO_STATUS', expected 'accepted'"
  fi
else
  fail "conversation-observe" "HTTP $CONVO_HTTP_CODE, expected 200"
fi

# --------------------------------------------------------------------------
# Test 11: conversation-observe rejects malformed request
# --------------------------------------------------------------------------
echo "Test 11: conversation-observe validation"
REJECT_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$WORKER_URL/api/sessions/conversation-observe" \
  -H 'Content-Type: application/json' \
  -d '{"contentSessionId": "test-no-exchanges"}')
if [ "$REJECT_CODE" = "400" ]; then
  pass "Rejects request missing 'exchanges' field (400)"
else
  fail "Validation" "Expected 400, got $REJECT_CODE for missing exchanges"
fi

# --------------------------------------------------------------------------
# Test 12: Processing status endpoint
# --------------------------------------------------------------------------
echo "Test 12: Processing status endpoint"
PROC_STATUS=$(curl -s "$WORKER_URL/api/processing-status")
PROC_VALID=$(echo "$PROC_STATUS" | python3 -c "
import sys,json
d = json.load(sys.stdin)
print('yes' if isinstance(d.get('isProcessing'), bool) and isinstance(d.get('queueDepth'), int) else 'no')
" 2>/dev/null)
if [ "$PROC_VALID" = "yes" ]; then
  pass "Processing status returns isProcessing (bool) and queueDepth (int)"
else
  fail "Processing status" "unexpected response format"
fi

# --------------------------------------------------------------------------
# Summary
# --------------------------------------------------------------------------
echo ""
echo "============================================"
TOTAL=$((PASS + FAIL + SKIP))
echo -e "Results: ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC}, ${YELLOW}${SKIP} skipped${NC} / ${TOTAL} total"
echo "============================================"

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "VERDICT: PIPELINE HAS FAILURES — metadata may not be flowing end-to-end"
  exit 1
else
  echo ""
  echo "VERDICT: Assistant message monitoring pipeline is working"
  exit 0
fi
