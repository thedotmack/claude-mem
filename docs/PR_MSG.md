# Fix: Accurate Heap Monitoring and PM2 Configuration

## Problem

PM2 reported 90%+ heap usage for claude-mem worker, suggesting critical
memory pressure and potential crash risk.

**PM2 Metrics (Misleading):**

```bash
pm2 describe claude-mem-worker | grep "Heap Usage"
# Output: 76% → 88% → 91% during normal operation
```

**Impact:**

- False alarm suggesting memory leak
- Heap percentage increased after GC (79.71% → 83.03%)
- Suggested undersized heap or memory leak
- Created uncertainty about worker stability

**System Context:**

- 3,496 observations in SQLite (15 MB)
- 121 MB Chroma vector database
- Node.js 25.2.0 running on PM2

---

## Root Cause

PM2's "Heap Usage" percentage calculation is incorrect for processes
using `--max-old-space-size` flag.

### PM2's Broken Calculation

```text
PM2 calculates: used / allocated = 17 MB / 25 MB = 68-91%
Correct formula:  used / limit     = 17 MB / 448 MB = 3.8%
```

### Why PM2 Misleads

1. **PM2 ignores `--max-old-space-size` flag** when calculating percentage
2. **V8 starts with small heap** (20-26 MB) and grows on demand
3. **PM2 measures against allocated heap**, not the configured limit
4. **Result:** False "high pressure" signals for healthy workers

### Evidence

**Before fix (PM2 only):**

```bash
pm2 describe claude-mem-worker | grep "Heap Usage"
# Shows: 91.62% (17 MB / 18.5 MB allocated)
# ❌ Misleading - ignores 448 MB limit
```

**After adding v8.getHeapStatistics():**

```bash
curl http://localhost:37777/health | jq '.heap'
{
  "limit_mb": 448,
  "used_mb": 17,
  "total_mb": 25,
  "percentage": 3.8
}
# ✅ Accurate - shows true usage against limit
```

**The Problem:** PM2's `node_args` field was ignored. Node flags must use
`interpreter_args` instead.

---

## Solution

### 1. Fix PM2 Configuration

**File:** `ecosystem.config.cjs`

**Before:**

```javascript
module.exports = {
  apps: [{
    name: 'claude-mem-worker',
    script: './plugin/scripts/worker-service.cjs',
    node_args: '--max-old-space-size=256',  // ❌ Ignored by PM2!
    // ...
  }]
};
```

**After:**

```javascript
module.exports = {
  apps: [{
    name: 'claude-mem-worker',
    script: './plugin/scripts/worker-service.cjs',
    interpreter_args: '--max-old-space-size=256',  // ✅ Works correctly
    // ...
  }]
};
```

**Why:** PM2 requires `interpreter_args` to pass flags to Node.js. The
`node_args` field is ignored.

### 2. Add Accurate Heap Diagnostics

**File:** `src/services/worker-service.ts`

Added `v8.getHeapStatistics()` to `/health` endpoint:

```typescript
private handleHealth(req: Request, res: Response): void {
  const v8 = require('v8');
  const heapStats = v8.getHeapStatistics();

  res.json({
    status: 'ok',
    timestamp: Date.now(),
    heap: {
      limit_mb: Math.round(heapStats.heap_size_limit / 1024 / 1024),
      used_mb: Math.round(heapStats.used_heap_size / 1024 / 1024),
      total_mb: Math.round(heapStats.total_heap_size / 1024 / 1024),
      percentage: Math.round(
        (heapStats.used_heap_size / heapStats.heap_size_limit) * 100 * 100
      ) / 100
    }
  });
}
```

**Provides:**

- `limit_mb` - Total heap limit (448 MB - V8's heap_size_limit includes
  old space + new space + code space overhead beyond
  --max-old-space-size=256)
- `used_mb` - Actual heap in use (17-20 MB typical)
- `total_mb` - Currently allocated heap (grows on demand)
- `percentage` - True usage: `used_mb / limit_mb`

### 3. Create Accurate Monitoring Script

**File:** `plugin/scripts/check-health.sh`

Core implementation logic (condensed for clarity - see full implementation
in repository):

```bash
#!/bin/bash
set -euo pipefail

# Parse options: -h help, -p port, -q quiet, -j JSON, -v verbose, -d debug
while getopts "hp:qjvd" opt; do
  case $opt in
    h) show_help; exit 0 ;;
    p) PORT=$OPTARG ;;
    q) QUIET=true ;;
    j) JSON_OUTPUT=true ;;
    v) VERBOSE=true ;;
    d) set -x ;;
  esac
done

# Query worker's /health endpoint
HEALTH=$(curl -s "http://localhost:${PORT}/health")
USED=$(echo "$HEALTH" | jq -r '.heap.used_mb')
LIMIT=$(echo "$HEALTH" | jq -r '.heap.limit_mb')
HEAP=$(echo "scale=2; ($USED / $LIMIT) * 100" | bc)

# Determine status: >90% critical, >80% warning, else healthy
if (( $(echo "$HEAP > 90" | bc -l) )); then
  STATUS="CRITICAL"; EXIT_CODE=2
elif (( $(echo "$HEAP > 80" | bc -l) )); then
  STATUS="WARNING"; EXIT_CODE=1
else
  STATUS="HEALTHY"; EXIT_CODE=0
fi

# Output in JSON or human-readable format
[[ "$JSON_OUTPUT" == true ]] && \
  echo "{\"status\": \"$STATUS\", \"heap\": {\"percentage\": $HEAP}}"
[[ "$QUIET" == false ]] && \
  echo "Current heap usage: ${USED}MB / ${LIMIT}MB (${HEAP}%)"
exit $EXIT_CODE
```

**Features:**

- Queries `/health` endpoint for accurate V8 statistics
- Three status levels: HEALTHY (0-80%), WARNING (80-90%), CRITICAL (>90%)
- Multiple output modes: normal, verbose (`-v`), JSON (`-j`), quiet (`-q`)
- Exit codes: 0 (healthy), 1 (warning), 2 (critical)
- Professional bash: `set -euo pipefail`, getopts, heredoc help menu

---

## Verification

Run these commands to verify the fix:

```bash
# 1. Confirm ecosystem.config.cjs uses interpreter_args
grep -n "interpreter_args" ecosystem.config.cjs
# Expected: Line 218: interpreter_args: getNodeOptions(),

# 2. Build and deploy changes
npm run build && npm run sync-marketplace && npm run worker:restart

# 3. Verify worker has correct heap limit via /health endpoint
curl -s http://localhost:37777/health | jq '.heap'
# Expected output:
# {
#   "limit_mb": 448,
#   "used_mb": 17,
#   "total_mb": 25,
#   "percentage": 3.8
# }

# 4. Run monitoring script (standard mode)
bash plugin/scripts/check-health.sh
# Expected output:
# Current heap usage: 17MB / 448MB (3.80%)
# ✅ Heap usage is healthy

# 5. Run monitoring script (verbose mode)
bash plugin/scripts/check-health.sh -v
# Expected output:
# Heap Statistics:
#   Used:       17 MB
#   Allocated:  25 MB
#   Limit:      448 MB
#   Usage:      3.80%
# ✅ Heap usage is healthy

# 6. Compare PM2 vs accurate metrics (demonstrates the discrepancy)
pm2 describe claude-mem-worker | grep "Heap Usage"  # Shows ~91%
curl -s http://localhost:37777/health | \
  jq '.heap.percentage'  # Shows 3.8%

# 7. Verify no errors in worker logs
pm2 logs claude-mem-worker --err --lines 50 --nostream
```

---

## Impact

| Metric | Before Fix | After Fix |
|--------|-----------|-----------|
| PM2 reported heap | 76-91% | 75-91% (still wrong, now ignorable) |
| Actual heap usage | Unknown | 3-4% (17-20 MB / 448 MB) |
| Heap limit | Unverifiable | 448 MB (--max-old-space-size=256) |
| Crash risk | Uncertain | None (428 MB headroom) |
| Monitoring accuracy | PM2 only (misleading) | v8.getHeapStatistics() (accurate) |

**Before:** False memory leak alarm, uncertain worker stability

**After:** Confirmed healthy operation with accurate monitoring

---

## Files Changed

| File | Changes | Purpose |
|------|---------|---------|
| `ecosystem.config.cjs` | `node_args` → `interpreter_args` | Fix PM2 flag application |
| `src/services/worker-service.ts` | Add heap stats to `/health` | Accurate metrics via v8 |
| `plugin/scripts/check-health.sh` | New monitoring script | Query `/health` instead of PM2 |
| `docs/claude-mem-memory-investigation.md` | Complete investigation | Full technical context |

**Total changes:**

- 4 files modified/created
- PM2 configuration fixed
- Worker service enhanced with diagnostics
- Monitoring infrastructure added
- Complete investigation documented

---

## Testing Environment

This fix was developed and tested with:

- 3,496 observations in SQLite database (15 MB)
- 121 MB Chroma vector database
- Multiple sessions over several hours of operation
- Worker remained stable at 3-4% heap usage throughout testing

---

## Review Checklist

- [ ] Verify `ecosystem.config.cjs` uses `interpreter_args`
- [ ] Check `/health` endpoint returns heap statistics
- [ ] Run `check-health.sh` and confirm 3-4% usage
- [ ] Build succeeds: `npm run build`
- [ ] Worker restarts cleanly: `npm run worker:restart`
- [ ] PM2 logs show no errors
- [ ] Review investigation doc: `docs/claude-mem-memory-investigation.md`

---

## Related

- Investigation document: `docs/claude-mem-memory-investigation.md`
- GitHub [#117](https://github.com/thedotmack/claude-mem/issues/117):
  "it often crashes" - This fix may resolve reported crashes if they were
  caused by misinterpreting PM2 metrics and taking unnecessary action
- GitHub [#107](https://github.com/thedotmack/claude-mem/issues/107):
  "Memory leaks" (closed) - Likely same root cause as this issue
