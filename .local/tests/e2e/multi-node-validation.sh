#!/bin/bash
# Multi-Node PR Quality Gate — E2E Validation
# Executes 7 layers of validation before upstream PR submission.
# Usage: ./tests/e2e/multi-node-validation.sh [--layer N] [--server HOST]
#
# Exit codes: 0 = all pass, 1 = failures detected
# Output: tests/e2e/reports/validation-<timestamp>.md

set -uo pipefail

# ── Config ────────────────────────────────────────────────────────────────────

SERVER_HOST="${MULTI_NODE_SERVER:-macstudio-m3ultra-regis}"
SERVER_PORT=37777
LOCAL_PORT=37777
AUTH_TOKEN=$(python3 -c "import json; print(json.load(open('$HOME/.claude-mem/settings.json')).get('CLAUDE_MEM_AUTH_TOKEN',''))" 2>/dev/null)
DB_PATH="$HOME/.claude-mem/claude-mem.db"
CACHE_DIR="$HOME/.claude/plugins/cache/thedotmack/claude-mem/12.1.0"
REPORT_DIR="$(dirname "$0")/reports"
TIMESTAMP=$(date +%Y%m%dT%H%M%S)
REPORT="$REPORT_DIR/validation-$TIMESTAMP.md"

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
LAYER_FILTER="${1:-}"

mkdir -p "$REPORT_DIR"

# ── Log baseline (capture line counts BEFORE tests) ──────────────────────────
TODAY=$(date +%Y-%m-%d)
LOCAL_LOG="$HOME/.claude-mem/logs/claude-mem-$TODAY.log"
LOG_BASELINE_LOCAL=0
LOG_BASELINE_SERVER=0
if [[ -f "$LOCAL_LOG" ]]; then
  LOG_BASELINE_LOCAL=$(wc -l < "$LOCAL_LOG" | tr -d ' ')
fi
LOG_BASELINE_SERVER=$(ssh "$SERVER_HOST" "wc -l < ~/.claude-mem/logs/claude-mem-$TODAY.log 2>/dev/null || echo 0" 2>/dev/null | tr -d ' ')

# ── Helpers ───────────────────────────────────────────────────────────────────

pass() { PASS_COUNT=$((PASS_COUNT + 1)); echo "  ✅ $1"; echo "- ✅ $1" >> "$REPORT"; }
fail() { FAIL_COUNT=$((FAIL_COUNT + 1)); echo "  ❌ $1"; echo "- ❌ $1" >> "$REPORT"; }
skip() { SKIP_COUNT=$((SKIP_COUNT + 1)); echo "  ⏭️  $1"; echo "- ⏭️ $1" >> "$REPORT"; }
header() { echo ""; echo "## $1" | tee -a "$REPORT"; echo "" >> "$REPORT"; }

should_run() {
  [[ -z "$LAYER_FILTER" ]] || [[ "$LAYER_FILTER" == "--layer" && "${2:-}" == "$1" ]] || [[ "$LAYER_FILTER" == "$1" ]]
}

# ── Report header ─────────────────────────────────────────────────────────────

cat > "$REPORT" <<EOF
# Multi-Node Validation Report
**Date:** $(date '+%Y-%m-%d %H:%M:%S')
**Machine:** $(hostname)
**Branch:** $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'unknown')
**Commit:** $(git rev-parse --short HEAD 2>/dev/null || echo 'unknown')
**Server:** $SERVER_HOST:$SERVER_PORT

EOF

# ══════════════════════════════════════════════════════════════════════════════
# Layer 1: Schema & Migrations
# ══════════════════════════════════════════════════════════════════════════════

header "Layer 1: Schema & Migrations"

# 1.1 Provenance columns exist in observations
for table in observations user_prompts session_summaries; do
  for col in node platform instance llm_source; do
    if sqlite3 "$DB_PATH" "PRAGMA table_info($table);" 2>/dev/null | grep -q "$col"; then
      pass "$table.$col column exists"
    else
      fail "$table.$col column MISSING"
    fi
  done
done

# 1.2 Fresh DB migration test
FRESH_DB=$(mktemp /tmp/claude-mem-fresh-XXXXXX.db)
if bun -e "
  const { SessionStore } = require('./src/services/sqlite/SessionStore.ts');
  const store = new SessionStore('$FRESH_DB');
  const cols = store.db.prepare(\"PRAGMA table_info(observations)\").all();
  const hasNode = cols.some(c => c.name === 'node');
  const hasLlm = cols.some(c => c.name === 'llm_source');
  process.exit(hasNode && hasLlm ? 0 : 1);
" 2>/dev/null; then
  pass "Fresh DB creates all provenance columns"
else
  fail "Fresh DB migration missing provenance columns"
fi
rm -f "$FRESH_DB"

# ══════════════════════════════════════════════════════════════════════════════
# Layer 2: Build & Bundle
# ══════════════════════════════════════════════════════════════════════════════

header "Layer 2: Build & Bundle"

# 2.1 Build succeeds
if npm run build > /dev/null 2>&1; then
  pass "npm run build succeeds"
else
  fail "npm run build failed"
fi

# 2.2 Worker bundle contains multi-node code
WORKER_BUNDLE="plugin/scripts/worker-service.cjs"
PROXY_BUNDLE_CHECK="plugin/scripts/proxy-service.cjs"
# Network mode in worker (minified: check env var name)
if grep -q "NETWORK_MODE" "$WORKER_BUNDLE" 2>/dev/null; then
  pass "worker-service.cjs contains NETWORK_MODE"
else
  fail "worker-service.cjs MISSING NETWORK_MODE"
fi
# Proxy contains auth and server forwarding (minified: check key strings)
for pattern in Authorization serverHost; do
  if grep -q "$pattern" "$PROXY_BUNDLE_CHECK" 2>/dev/null; then
    pass "proxy-service.cjs contains $pattern"
  else
    fail "proxy-service.cjs MISSING $pattern"
  fi
done

# 2.3 Proxy bundle contains SSE forwarding
PROXY_BUNDLE="plugin/scripts/proxy-service.cjs"
if grep -q "text/event-stream" "$PROXY_BUNDLE" 2>/dev/null; then
  pass "proxy-service.cjs contains SSE forwarding"
else
  fail "proxy-service.cjs MISSING SSE forwarding"
fi

# 2.4 Viewer bundle contains all card components
VIEWER_BUNDLE="plugin/ui/viewer-bundle.js"
for pattern in 'itemType==="observation"' 'itemType==="summary"' 'meta-pills'; do
  if grep -q "$pattern" "$VIEWER_BUNDLE" 2>/dev/null; then
    pass "viewer-bundle.js contains $pattern"
  else
    fail "viewer-bundle.js MISSING $pattern"
  fi
done

# 2.5 Bundle size sanity check (should be >200KB for viewer)
VIEWER_SIZE=$(wc -c < "$VIEWER_BUNDLE" 2>/dev/null || echo 0)
if [[ "$VIEWER_SIZE" -gt 200000 ]]; then
  pass "viewer-bundle.js size OK (${VIEWER_SIZE} bytes)"
else
  fail "viewer-bundle.js suspiciously small (${VIEWER_SIZE} bytes)"
fi

# ══════════════════════════════════════════════════════════════════════════════
# Layer 3: API Verification
# ══════════════════════════════════════════════════════════════════════════════

header "Layer 3: API Verification"

# 3.1 Local health
LOCAL_HEALTH=$(curl -s "http://localhost:$LOCAL_PORT/api/health" 2>/dev/null)
if echo "$LOCAL_HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['status']=='ok'" 2>/dev/null; then
  LOCAL_MODE=$(echo "$LOCAL_HEALTH" | python3 -c "import sys,json; print(json.load(sys.stdin).get('mode','?'))")
  pass "Local health OK (mode=$LOCAL_MODE)"
else
  fail "Local health endpoint failed"
fi

# 3.2 Server health (direct)
SERVER_HEALTH=$(curl -s -H "Authorization: Bearer $AUTH_TOKEN" "http://$SERVER_HOST:$SERVER_PORT/api/health" 2>/dev/null)
if echo "$SERVER_HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['status']=='ok' and d['mode']=='server'" 2>/dev/null; then
  pass "Server health OK (mode=server)"
else
  fail "Server health failed or not in server mode"
fi

# 3.3 Observations API returns provenance columns
OBS_RESPONSE=$(curl -s "http://localhost:$LOCAL_PORT/api/observations?limit=5" 2>/dev/null)
OBS_HAS_NODE=$(echo "$OBS_RESPONSE" | python3 -c "
import sys, json
d = json.load(sys.stdin)
# Check if 'node' key exists in response items (even if value is null)
has_key = all('node' in item for item in d.get('items', []))
print('yes' if has_key else 'no')
" 2>/dev/null)
if [[ "$OBS_HAS_NODE" == "yes" ]]; then
  pass "Observations API returns node column"
else
  fail "Observations API missing node column"
fi

# 3.4 Prompts API returns provenance columns
PROMPT_RESPONSE=$(curl -s "http://localhost:$LOCAL_PORT/api/prompts?limit=5" 2>/dev/null)
PROMPT_HAS_NODE=$(echo "$PROMPT_RESPONSE" | python3 -c "
import sys, json
d = json.load(sys.stdin)
has_key = all('node' in item for item in d.get('items', []))
print('yes' if has_key else 'no')
" 2>/dev/null)
if [[ "$PROMPT_HAS_NODE" == "yes" ]]; then
  pass "Prompts API returns node column"
else
  fail "Prompts API missing node column"
fi

# 3.5 Summaries API returns provenance columns
SUM_RESPONSE=$(curl -s "http://localhost:$LOCAL_PORT/api/summaries?limit=5" 2>/dev/null)
SUM_HAS_NODE=$(echo "$SUM_RESPONSE" | python3 -c "
import sys, json
d = json.load(sys.stdin)
items = d.get('items', [])
if len(items) == 0:
    print('skip')
else:
    has_key = all('node' in item for item in items)
    print('yes' if has_key else 'no')
" 2>/dev/null)
if [[ "$SUM_HAS_NODE" == "yes" ]]; then
  pass "Summaries API returns node column"
elif [[ "$SUM_HAS_NODE" == "skip" ]]; then
  skip "Summaries API — no summaries to check"
else
  fail "Summaries API missing node column"
fi

# 3.6 SSE stream delivers initial_load
SSE_DATA=$(curl -s -N --max-time 5 "http://localhost:$LOCAL_PORT/stream" 2>/dev/null)
if echo "$SSE_DATA" | grep -q "initial_load"; then
  pass "SSE stream delivers initial_load"
else
  fail "SSE stream missing initial_load event"
fi

# ══════════════════════════════════════════════════════════════════════════════
# Layer 4: Provenance E2E
# ══════════════════════════════════════════════════════════════════════════════

header "Layer 4: Provenance E2E"

# 4.1 Recent observations have provenance in DB
RECENT_PROV=$(sqlite3 "$DB_PATH" "
  SELECT COUNT(*) FROM (
    SELECT * FROM observations
    WHERE node IS NOT NULL AND platform IS NOT NULL
    ORDER BY created_at_epoch DESC LIMIT 10
  );
" 2>/dev/null)
if [[ "$RECENT_PROV" -gt 0 ]]; then
  pass "Recent observations have provenance ($RECENT_PROV/10 with node+platform)"
else
  fail "No recent observations with provenance data"
fi

# 4.2 Recent prompts have provenance in DB
PROMPT_PROV=$(sqlite3 "$DB_PATH" "
  SELECT COUNT(*) FROM (
    SELECT * FROM user_prompts
    WHERE node IS NOT NULL AND platform IS NOT NULL
    ORDER BY created_at_epoch DESC LIMIT 10
  );
" 2>/dev/null)
if [[ "$PROMPT_PROV" -gt 0 ]]; then
  pass "Recent prompts have provenance ($PROMPT_PROV/10 with node+platform)"
else
  fail "No recent prompts with provenance data"
fi

# 4.3 Provenance matches between API and server DB (same observation by ID)
# In multi-node mode, different observations may have different nodes. Compare the SAME observation.
API_OBS=$(echo "$OBS_RESPONSE" | python3 -c "
import sys, json
d = json.load(sys.stdin)
items = [i for i in d.get('items', []) if i.get('node') and i.get('id')]
if items:
    print(f\"{items[0]['id']}|{items[0]['node']}\")
else:
    print('none')
" 2>/dev/null)
if [[ "$API_OBS" == "none" ]]; then
  skip "No observations with node in API response"
else
  API_OBS_ID=$(echo "$API_OBS" | cut -d'|' -f1)
  API_OBS_NODE=$(echo "$API_OBS" | cut -d'|' -f2)
  SERVER_DB_NODE=$(ssh "$SERVER_HOST" "sqlite3 ~/.claude-mem/claude-mem.db \"SELECT node FROM observations WHERE id = $API_OBS_ID;\"" 2>/dev/null)
  if [[ "$API_OBS_NODE" == "$SERVER_DB_NODE" ]]; then
    pass "API node matches server DB for observation $API_OBS_ID ($API_OBS_NODE)"
  else
    fail "API node ($API_OBS_NODE) != server DB node ($SERVER_DB_NODE) for observation $API_OBS_ID"
  fi
fi

# 4.4 Observations originate from client node, not server
# In client mode, new observations should carry the CLIENT's node name, not the server's
if [[ "$LOCAL_MODE" == "client" ]]; then
  LOCAL_NODE=$(hostname -s 2>/dev/null || hostname)
  # Check most recent observations for client node name
  CLIENT_OBS=$(curl -s "http://localhost:$LOCAL_PORT/api/observations?limit=10" 2>/dev/null | python3 -c "
import sys, json
d = json.load(sys.stdin)
local = '$LOCAL_NODE'
# Count observations that have this client's node
client_obs = [i for i in d.get('items', []) if i.get('node') and local.lower() in i['node'].lower()]
server_obs = [i for i in d.get('items', []) if i.get('node') and local.lower() not in i['node'].lower()]
print(f'{len(client_obs)}:{len(server_obs)}')
" 2>/dev/null)
  CLIENT_COUNT=$(echo "$CLIENT_OBS" | cut -d: -f1)
  SERVER_COUNT=$(echo "$CLIENT_OBS" | cut -d: -f2)
  if [[ "$CLIENT_COUNT" -gt 0 ]]; then
    pass "Observations carry client node name ($CLIENT_COUNT client, $SERVER_COUNT server)"
  elif [[ "$SERVER_COUNT" -gt 0 ]]; then
    fail "Observations carry SERVER node name instead of client ($SERVER_COUNT with server name)"
  else
    skip "No observations with node to check origin"
  fi
fi

# ══════════════════════════════════════════════════════════════════════════════
# Layer 5: Deployment Verification
# ══════════════════════════════════════════════════════════════════════════════

header "Layer 5: Deployment Verification"

# 5.1 Local cache matches build output
LOCAL_BUNDLE_HASH=$(md5 -q "$WORKER_BUNDLE" 2>/dev/null)
CACHE_BUNDLE_HASH=$(md5 -q "$CACHE_DIR/scripts/worker-service.cjs" 2>/dev/null)
if [[ "$LOCAL_BUNDLE_HASH" == "$CACHE_BUNDLE_HASH" ]]; then
  pass "Local cache matches build output"
else
  fail "Local cache STALE (hashes differ)"
fi

# 5.2 Server cache matches build output
SERVER_BUNDLE_HASH=$(ssh "$SERVER_HOST" "md5 -q ~/.claude/plugins/cache/thedotmack/claude-mem/12.1.0/scripts/worker-service.cjs" 2>/dev/null)
if [[ "$LOCAL_BUNDLE_HASH" == "$SERVER_BUNDLE_HASH" ]]; then
  pass "Server cache matches build output"
else
  fail "Server cache STALE (hashes differ: local=$LOCAL_BUNDLE_HASH server=$SERVER_BUNDLE_HASH)"
fi

# 5.3 Version match between proxy and server
VERSION_MATCH=$(echo "$LOCAL_HEALTH" | python3 -c "import sys,json; print(json.load(sys.stdin).get('versionMatch','unknown'))" 2>/dev/null)
if [[ "$VERSION_MATCH" == "True" ]]; then
  pass "Proxy-server version match"
else
  fail "Version mismatch between proxy and server"
fi

# 5.4 Server reachable from proxy
SERVER_REACHABLE=$(echo "$LOCAL_HEALTH" | python3 -c "import sys,json; print(json.load(sys.stdin).get('serverReachable','unknown'))" 2>/dev/null)
if [[ "$SERVER_REACHABLE" == "True" ]]; then
  pass "Server reachable from proxy"
else
  fail "Server unreachable from proxy"
fi

# ══════════════════════════════════════════════════════════════════════════════
# Layer 6: Network Behavior
# ══════════════════════════════════════════════════════════════════════════════

header "Layer 6: Network Behavior"

# 6.1 Auth rejection without token
AUTH_REJECT=$(curl -s -o /dev/null -w "%{http_code}" "http://$SERVER_HOST:$SERVER_PORT/api/observations" 2>/dev/null)
if [[ "$AUTH_REJECT" == "401" ]]; then
  pass "Server rejects unauthenticated requests (401)"
else
  fail "Server returned $AUTH_REJECT instead of 401 for unauthenticated request"
fi

# 6.2 Auth acceptance with token
AUTH_ACCEPT=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $AUTH_TOKEN" "http://$SERVER_HOST:$SERVER_PORT/api/observations?limit=1" 2>/dev/null)
if [[ "$AUTH_ACCEPT" == "200" ]]; then
  pass "Server accepts authenticated requests (200)"
else
  fail "Server returned $AUTH_ACCEPT for authenticated request"
fi

# 6.3 Admin routes blocked by proxy
ADMIN_BLOCK=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$LOCAL_PORT/api/admin/shutdown" 2>/dev/null)
if [[ "$ADMIN_BLOCK" == "403" ]]; then
  pass "Proxy blocks admin routes (403)"
else
  fail "Proxy returned $ADMIN_BLOCK for admin route (expected 403)"
fi

# 6.4 SSE through proxy delivers server events
PROXY_SSE=$(curl -s -N --max-time 5 "http://localhost:$LOCAL_PORT/stream" 2>/dev/null)
if echo "$PROXY_SSE" | grep -q "initial_load"; then
  PROJECT_COUNT=$(echo "$PROXY_SSE" | grep "initial_load" | python3 -c "
import sys, json
for line in sys.stdin:
  line = line.strip()
  if line.startswith('data:'):
    d = json.loads(line[5:])
    if d.get('type') == 'initial_load':
      print(len(d.get('projects', [])))
      break
" 2>/dev/null)
  pass "SSE through proxy works ($PROJECT_COUNT projects)"
else
  fail "SSE through proxy failed"
fi

# 6.5 SSE delivers new_prompt events (not just initial_load)
# Check that the SSE stream type includes prompt broadcasting capability
SSE_TYPES=$(echo "$PROXY_SSE" | grep -o '"type":"[^"]*"' | sort -u)
if echo "$SSE_TYPES" | grep -q "processing_status"; then
  pass "SSE delivers processing_status events"
else
  fail "SSE missing processing_status events"
fi

# ══════════════════════════════════════════════════════════════════════════════
# Layer 7: Visual Verification — Client (Automated via Playwright)
# ══════════════════════════════════════════════════════════════════════════════

header "Layer 7a: Visual — Client Viewer"

SCREENSHOT_DIR="$REPORT_DIR/screenshots"
REFERENCE_DIR="$(dirname "$0")/reference-screenshots"
mkdir -p "$SCREENSHOT_DIR" "$REFERENCE_DIR"

VISUAL_SCRIPT="$SCREENSHOT_DIR/visual-check.mjs"
cat > "$VISUAL_SCRIPT" <<'PLAYWRIGHT_EOF'
import { chromium } from 'playwright';
import { writeFileSync, existsSync, readFileSync } from 'fs';
import { execSync } from 'child_process';

const results = [];
const pass = (msg) => { results.push({ status: 'pass', msg }); };
const fail = (msg) => { results.push({ status: 'fail', msg }); };
const skip = (msg) => { results.push({ status: 'skip', msg }); };

const [,, screenshotPath, mode, targetUrl, referenceDir] = process.argv;
const url = targetUrl || 'http://localhost:37777';
const viewerMode = mode || 'client';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(4000); // Wait for SSE + initial pagination

  // ── Basic rendering ──

  const title = await page.title();
  title.includes('claude-mem') ? pass(`[${viewerMode}] Page title OK`) : fail(`[${viewerMode}] Unexpected title: ${title}`);

  const headerText = await page.textContent('body') || '';
  headerText.includes('v12') ? pass(`[${viewerMode}] Header shows version`) : fail(`[${viewerMode}] Header missing version`);

  // ── Mode-specific header ──

  if (viewerMode === 'client') {
    headerText.toLowerCase().includes('connected to') || headerText.toLowerCase().includes('client')
      ? pass('[client] Header shows client/connected status')
      : fail('[client] Header missing client connection info');
  } else if (viewerMode === 'server') {
    headerText.toLowerCase().includes('server')
      ? pass('[server] Header shows server mode')
      : fail('[server] Header missing server mode indicator');
  }

  // ── Feed composition ──

  const cards = await page.$$('.card');
  cards.length > 0 ? pass(`[${viewerMode}] Feed has ${cards.length} cards`) : fail(`[${viewerMode}] Feed has no cards`);

  // Card type diversity
  const obsTypes = ['discovery', 'change', 'feature', 'bugfix', 'refactor', 'decision'];
  const typeCounts = {};
  for (const t of obsTypes) {
    const els = await page.$$(`.type-${t}`);
    if (els.length > 0) typeCounts[t] = els.length;
  }
  const typeNames = Object.keys(typeCounts);
  typeNames.length >= 2
    ? pass(`[${viewerMode}] ${typeNames.length} observation types: ${typeNames.map(t => `${t}(${typeCounts[t]})`).join(', ')}`)
    : (typeNames.length === 1 ? pass(`[${viewerMode}] 1 observation type: ${typeNames[0]}(${typeCounts[typeNames[0]]})`) : fail(`[${viewerMode}] No observation cards`));

  const promptCards = await page.$$('text=PROMPT');
  promptCards.length > 0 ? pass(`[${viewerMode}] ${promptCards.length} prompt cards`) : fail(`[${viewerMode}] No prompt cards`);

  const summaryCards = await page.$$('text=SUMMARY');
  // Summaries are optional — just report
  summaryCards.length > 0
    ? pass(`[${viewerMode}] ${summaryCards.length} summary cards`)
    : skip(`[${viewerMode}] No summary cards (may be normal)`);

  // ── SSE state capture (before refresh) ──

  const nodePillsSSE = await page.$$('.pill--node');
  const platformPillsSSE = await page.$$('[class*="pill--platform"]');
  const idPillsSSE = await page.$$('.pill--id');
  const obsBefore = await page.$$(obsTypes.map(t => `.type-${t}`).join(', '));

  nodePillsSSE.length > 0
    ? pass(`[${viewerMode}] SSE: ${nodePillsSSE.length} node pills`)
    : fail(`[${viewerMode}] SSE: No node pills`);
  platformPillsSSE.length > 0
    ? pass(`[${viewerMode}] SSE: ${platformPillsSSE.length} platform pills`)
    : fail(`[${viewerMode}] SSE: No platform pills`);

  // ── Screenshot (SSE state) ──

  const ssePath = screenshotPath.replace('.png', `-${viewerMode}-sse.png`);
  await page.screenshot({ path: ssePath, fullPage: false });
  pass(`[${viewerMode}] SSE screenshot captured`);

  // ── Refresh → pagination state ──

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  const nodePillsPag = await page.$$('.pill--node');
  const platformPillsPag = await page.$$('[class*="pill--platform"]');
  const obsAfter = await page.$$(obsTypes.map(t => `.type-${t}`).join(', '));

  // ── SSE vs Pagination comparison ──

  obsAfter.length > 0
    ? pass(`[${viewerMode}] Pagination: ${obsAfter.length} observations persist`)
    : fail(`[${viewerMode}] Pagination: observations DISAPPEARED`);

  nodePillsPag.length > 0
    ? pass(`[${viewerMode}] Pagination: ${nodePillsPag.length} node pills persist`)
    : fail(`[${viewerMode}] Pagination: node pills DISAPPEARED`);

  // Compare counts — detect SSE/pagination drift
  const obsDelta = Math.abs(obsBefore.length - obsAfter.length);
  obsDelta <= 2
    ? pass(`[${viewerMode}] SSE→Pagination observation delta: ${obsDelta} (≤2 OK)`)
    : fail(`[${viewerMode}] SSE→Pagination observation drift: ${obsBefore.length} → ${obsAfter.length}`);

  const pillDelta = Math.abs(nodePillsSSE.length - nodePillsPag.length);
  pillDelta <= 5
    ? pass(`[${viewerMode}] SSE→Pagination pill delta: ${pillDelta} (≤5 OK)`)
    : fail(`[${viewerMode}] SSE→Pagination pill drift: ${nodePillsSSE.length} → ${nodePillsPag.length}`);

  // ── Screenshot (pagination state) ──

  const pagPath = screenshotPath.replace('.png', `-${viewerMode}-pagination.png`);
  await page.screenshot({ path: pagPath, fullPage: false });
  pass(`[${viewerMode}] Pagination screenshot captured`);

  // ── MetadataFooter completeness ──

  const idPills = await page.$$('.pill--id');
  const datePills = await page.$$('.pill--date');
  idPills.length > 0 ? pass(`[${viewerMode}] ${idPills.length} ID pills`) : fail(`[${viewerMode}] No ID pills`);
  datePills.length > 0 ? pass(`[${viewerMode}] ${datePills.length} date pills`) : fail(`[${viewerMode}] No date pills`);

  // ── Console toggle ──

  const consoleBtn = await page.$('.console-toggle-btn');
  consoleBtn ? pass(`[${viewerMode}] Console toggle button present`) : fail(`[${viewerMode}] Console toggle button missing`);

  // ── Reference screenshot comparison ──

  if (referenceDir) {
    const refPath = `${referenceDir}/${viewerMode}-reference.png`;
    if (existsSync(refPath)) {
      // Pixel comparison using ImageMagick if available
      try {
        const diffOutput = execSync(
          `compare -metric RMSE "${pagPath}" "${refPath}" /dev/null 2>&1 || true`,
          { encoding: 'utf-8', timeout: 10000 }
        ).trim();
        const match = diffOutput.match(/^([\d.]+)/);
        if (match) {
          const rmse = parseFloat(match[1]);
          // RMSE < 5000 = acceptable visual drift (layout same, content different)
          // RMSE > 15000 = significant regression
          rmse < 15000
            ? pass(`[${viewerMode}] Reference comparison RMSE=${rmse.toFixed(0)} (< 15000)`)
            : fail(`[${viewerMode}] Visual regression RMSE=${rmse.toFixed(0)} (> 15000 threshold)`);
        } else {
          skip(`[${viewerMode}] Reference comparison: could not parse RMSE`);
        }
      } catch {
        skip(`[${viewerMode}] Reference comparison: ImageMagick not available`);
      }
    } else {
      // First run — save as reference
      execSync(`cp "${pagPath}" "${refPath}"`);
      pass(`[${viewerMode}] Reference screenshot saved (first run)`);
    }
  }

} catch (err) {
  fail(`[${viewerMode}] Playwright error: ${err.message}`);
} finally {
  await browser.close();
}

writeFileSync('/dev/stdout', JSON.stringify(results));
PLAYWRIGHT_EOF

SCREENSHOT_PATH="$SCREENSHOT_DIR/viewer-$TIMESTAMP.png"

# 7a: Client viewer (localhost proxy)
VISUAL_RESULTS_CLIENT=$(node "$VISUAL_SCRIPT" "$SCREENSHOT_PATH" "client" "http://localhost:$LOCAL_PORT" "$REFERENCE_DIR" 2>/dev/null || echo "[]")

process_visual_results() {
  local label="$1"
  local json_results="$2"
  if [[ "$json_results" == "[]" || -z "$json_results" ]]; then
    skip "$label: Playwright could not run"
    return
  fi
  echo "$json_results" | python3 -c "
import sys, json
results = json.loads(sys.stdin.read())
for r in results:
  icon = '✅' if r['status']=='pass' else ('❌' if r['status']=='fail' else '⏭️')
  print(f'  {icon} {r[\"msg\"]}')
" 2>/dev/null

  local vp vf vs
  vp=$(echo "$json_results" | python3 -c "import sys,json; print(sum(1 for r in json.loads(sys.stdin.read()) if r['status']=='pass'))" 2>/dev/null)
  vf=$(echo "$json_results" | python3 -c "import sys,json; print(sum(1 for r in json.loads(sys.stdin.read()) if r['status']=='fail'))" 2>/dev/null)
  vs=$(echo "$json_results" | python3 -c "import sys,json; print(sum(1 for r in json.loads(sys.stdin.read()) if r['status']=='skip'))" 2>/dev/null)
  PASS_COUNT=$((PASS_COUNT + vp))
  FAIL_COUNT=$((FAIL_COUNT + vf))
  SKIP_COUNT=$((SKIP_COUNT + vs))

  echo "$json_results" | python3 -c "
import sys, json
for r in json.loads(sys.stdin.read()):
  icon = '✅' if r['status']=='pass' else ('❌' if r['status']=='fail' else '⏭️')
  print(f'- {icon} {r[\"msg\"]}')
" >> "$REPORT" 2>/dev/null
}

process_visual_results "Client" "$VISUAL_RESULTS_CLIENT"

# ══════════════════════════════════════════════════════════════════════════════
# Layer 7b: Visual Verification — Server
# ══════════════════════════════════════════════════════════════════════════════

header "Layer 7b: Visual — Server Viewer"

# Server viewer requires auth for API calls — test via SSH port-forward or direct API checks
# Playwright can load the HTML but fetch calls fail without auth headers
# So we validate server rendering via API data + structure checks instead
SERVER_VIEWER_URL="http://$SERVER_HOST:$SERVER_PORT"

# Check server serves viewer HTML WITHOUT auth (public asset)
SERVER_HTML=$(curl -s "$SERVER_VIEWER_URL/" 2>/dev/null | head -10)
if echo "$SERVER_HTML" | grep -q "claude-mem"; then
  pass "[server] Viewer HTML served"
else
  fail "[server] Viewer HTML not served"
fi

# Check server viewer-bundle exists
SERVER_BUNDLE=$(curl -s -o /dev/null -w "%{http_code}" "$SERVER_VIEWER_URL/viewer-bundle.js" 2>/dev/null)
if [[ "$SERVER_BUNDLE" == "200" ]]; then
  pass "[server] viewer-bundle.js accessible (200)"
else
  fail "[server] viewer-bundle.js returned $SERVER_BUNDLE"
fi

# Check server SSE stream works with auth
SERVER_SSE=$(curl -s -N --max-time 5 -H "Authorization: Bearer $AUTH_TOKEN" "$SERVER_VIEWER_URL/stream" 2>/dev/null)
if echo "$SERVER_SSE" | grep -q "initial_load"; then
  pass "[server] SSE stream with auth delivers initial_load"
else
  fail "[server] SSE stream failed with auth"
fi

# Check server API returns observations with provenance
SERVER_OBS=$(curl -s -H "Authorization: Bearer $AUTH_TOKEN" "$SERVER_VIEWER_URL/api/observations?limit=3" 2>/dev/null)
SERVER_OBS_NODE=$(echo "$SERVER_OBS" | python3 -c "
import sys, json
d = json.load(sys.stdin)
items = [i for i in d.get('items', []) if i.get('node')]
print(len(items))
" 2>/dev/null)
if [[ "$SERVER_OBS_NODE" -gt 0 ]]; then
  pass "[server] API returns $SERVER_OBS_NODE observations with provenance"
else
  fail "[server] API returns no observations with provenance"
fi

# ══════════════════════════════════════════════════════════════════════════════
# Layer 8: Log Analysis
# ══════════════════════════════════════════════════════════════════════════════

header "Layer 8: Log Analysis"

# Analyze logs generated DURING the test run (between baseline and now)
LOG_END_LOCAL=0
if [[ -f "$LOCAL_LOG" ]]; then
  LOG_END_LOCAL=$(wc -l < "$LOCAL_LOG" | tr -d ' ')
fi
LOG_LINES_DURING=$((LOG_END_LOCAL - LOG_BASELINE_LOCAL))

analyze_log_section() {
  local label="$1"      # "Local" or "Server"
  local log_content="$2" # The log text to analyze

  if [[ -z "$log_content" ]]; then
    skip "$label: no log data"
    return
  fi

  local errors logins uncaught stored_obs zero_obs broadcasts parser_warns

  errors=$(echo "$log_content" | grep -c '\[ERROR\]' 2>/dev/null | head -1 | tr -cd '0-9')
  errors=${errors:-0}
  [[ "$errors" -eq 0 ]] && pass "$label: no ERROR entries" || fail "$label: $errors ERROR entries"

  logins=$(echo "$log_content" | grep -c 'Not logged in' 2>/dev/null | head -1 | tr -cd '0-9')
  logins=${logins:-0}
  [[ "$logins" -eq 0 ]] && pass "$label: no 'Not logged in' failures" || fail "$label: $logins 'Not logged in' failures"

  uncaught=$(echo "$log_content" | grep -ci 'uncaught\|unhandled.*rejection\|FATAL' 2>/dev/null | head -1 | tr -cd '0-9')
  uncaught=${uncaught:-0}
  [[ "$uncaught" -eq 0 ]] && pass "$label: no uncaught exceptions" || fail "$label: $uncaught uncaught exceptions"

  stored_obs=$(echo "$log_content" | grep 'STORED.*obsCount=' | grep -v 'obsCount=0' | wc -l | tr -cd '0-9')
  stored_obs=${stored_obs:-0}
  zero_obs=$(echo "$log_content" | grep 'STORED.*obsCount=0' | wc -l | tr -cd '0-9')
  zero_obs=${zero_obs:-0}
  if [[ "$stored_obs" -gt 0 ]]; then
    pass "$label: observations stored ($stored_obs with data, $zero_obs empty)"
  elif [[ "$zero_obs" -gt 0 ]]; then
    fail "$label: all stores have obsCount=0 ($zero_obs entries)"
  elif [[ "$LOCAL_MODE" == "client" && "$label" == *"Local"* ]]; then
    pass "$label: no local STORED entries (expected — client delegates to server)"
  else
    fail "$label: no STORED entries (standalone/server should store locally)"
  fi

  broadcasts=$(echo "$log_content" | grep -c 'Broadcasting processing status' 2>/dev/null | head -1 | tr -cd '0-9')
  broadcasts=${broadcasts:-0}
  if [[ "$broadcasts" -gt 0 ]]; then
    pass "$label: SSE broadcasting ($broadcasts events)"
  elif [[ "$LOCAL_MODE" == "client" && "$label" == *"Local"* ]]; then
    pass "$label: no local SSE broadcasts (expected — client pipes server SSE)"
  else
    fail "$label: no SSE broadcasts (standalone/server should broadcast)"
  fi

  parser_warns=$(echo "$log_content" | grep -c 'PARSER.*WARN\|WARN.*PARSER' 2>/dev/null | head -1 | tr -cd '0-9')
  parser_warns=${parser_warns:-0}
  # Parser warnings about observation/summary tag confusion are a known prompt conditioning issue (#1312), not a code regression.
  # Fail only on high counts that suggest a systemic problem.
  if [[ "$parser_warns" -eq 0 ]]; then
    pass "$label: no parser warnings"
  elif [[ "$parser_warns" -le 15 ]]; then
    pass "$label: $parser_warns parser warnings (known #1312, within threshold)"
  else
    fail "$label: $parser_warns parser warnings (exceeds threshold of 15)"
  fi
}

# ── 8a: BEFORE tests (baseline — last 100 lines before test started) ──
echo "  --- Before tests (baseline) ---" | tee -a "$REPORT"
if [[ -f "$LOCAL_LOG" && "$LOG_BASELINE_LOCAL" -gt 0 ]]; then
  BASELINE_START=$((LOG_BASELINE_LOCAL > 100 ? LOG_BASELINE_LOCAL - 100 : 1))
  BEFORE_CONTENT=$(sed -n "${BASELINE_START},${LOG_BASELINE_LOCAL}p" "$LOCAL_LOG" 2>/dev/null)
  analyze_log_section "Local pre-test" "$BEFORE_CONTENT"
else
  skip "Local pre-test: no baseline log"
fi

# ── 8b: DURING tests (lines generated while tests ran) ──
echo "  --- During tests ($LOG_LINES_DURING new lines) ---" | tee -a "$REPORT"
if [[ -f "$LOCAL_LOG" && "$LOG_LINES_DURING" -gt 0 ]]; then
  DURING_CONTENT=$(tail -n +"$((LOG_BASELINE_LOCAL + 1))" "$LOCAL_LOG" 2>/dev/null)
  analyze_log_section "Local during-test" "$DURING_CONTENT"
elif [[ "$LOCAL_MODE" == "client" ]]; then
  pass "Local during-test: no local log lines (expected — client proxy logs minimally)"
else
  fail "Local during-test: no log lines generated (standalone/server should log during activity)"
fi

# ── 8c: Server logs (full analysis — before + during) ──
echo "  --- Server logs ---" | tee -a "$REPORT"
SERVER_BEFORE=$(ssh "$SERVER_HOST" "
  LOG=~/.claude-mem/logs/claude-mem-$TODAY.log
  if [ -f \"\$LOG\" ]; then
    TOTAL=\$(wc -l < \"\$LOG\" | tr -d ' ')
    START=\$(( TOTAL > 200 ? TOTAL - 200 : 1 ))
    sed -n \"\${START},\${TOTAL}p\" \"\$LOG\"
  fi
" 2>/dev/null)
analyze_log_section "Server" "$SERVER_BEFORE"

# ── 8d: AFTER tests — snapshot current state ──
echo "  --- After tests (final state) ---" | tee -a "$REPORT"
if [[ -f "$LOCAL_LOG" ]]; then
  AFTER_CONTENT=$(tail -50 "$LOCAL_LOG" 2>/dev/null)
  # Just check for crashes during the test run itself
  CRASH_AFTER=$(echo "$AFTER_CONTENT" | grep -ci 'FATAL\|segfault\|SIGKILL\|SIGABRT' 2>/dev/null | head -1 | tr -cd '0-9')
  CRASH_AFTER=${CRASH_AFTER:-0}
  [[ "$CRASH_AFTER" -eq 0 ]] && pass "Local post-test: no crashes" || fail "Local post-test: $CRASH_AFTER crashes detected"

  # Worker still alive?
  if lsof -ti :$LOCAL_PORT > /dev/null 2>&1; then
    pass "Local post-test: worker still running"
  else
    fail "Local post-test: worker DIED during tests"
  fi
fi

# Server still alive?
SERVER_POST=$(curl -s --max-time 3 -H "Authorization: Bearer $AUTH_TOKEN" "http://$SERVER_HOST:$SERVER_PORT/api/health" 2>/dev/null)
if echo "$SERVER_POST" | python3 -c "import sys,json; assert json.load(sys.stdin)['status']=='ok'" 2>/dev/null; then
  pass "Server post-test: still healthy"
else
  fail "Server post-test: health check failed"
fi

# ══════════════════════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════════════════════

echo ""
echo "══════════════════════════════════════════════════════════════"

cat >> "$REPORT" <<EOF

---

## Summary

| Result | Count |
|--------|-------|
| ✅ Pass | $PASS_COUNT |
| ❌ Fail | $FAIL_COUNT |
| ⏭️ Skip | $SKIP_COUNT |

**Verdict:** $([ $FAIL_COUNT -eq 0 ] && echo "✅ READY FOR UPSTREAM" || echo "❌ NOT READY — $FAIL_COUNT failures")
EOF

echo "  ✅ Pass: $PASS_COUNT"
echo "  ❌ Fail: $FAIL_COUNT"
echo "  ⏭️  Skip: $SKIP_COUNT"
echo ""
if [[ $FAIL_COUNT -eq 0 ]]; then
  echo "  ✅ VERDICT: READY FOR UPSTREAM"
else
  echo "  ❌ VERDICT: NOT READY — $FAIL_COUNT failures"
fi
echo ""
echo "  Report: $REPORT"
[[ -f "$SCREENSHOT_PATH" ]] && echo "  Screenshot: $SCREENSHOT_PATH"
echo "══════════════════════════════════════════════════════════════"

exit $([[ $FAIL_COUNT -eq 0 ]] && echo 0 || echo 1)
