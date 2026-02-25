# Fix: SessionStart Hook "startup hook error" — Worker Not Waiting

## Root Cause

The **installed plugin** (`~/.claude/plugins/marketplaces/thedotmack/`) is version **10.2.5** and has **none** of the recent fixes:

| Fix | Repo Status | Installed Status |
|-----|-------------|-----------------|
| Hook group split (smart-install isolated from worker start) | In `plugin/hooks/hooks.json` | **Missing** — all 3 hooks in one group, smart-install failure blocks worker |
| `waitForReadiness()` after spawn | In `src/services/infrastructure/HealthMonitor.ts` | **Missing** — 0 occurrences in installed `worker-service.cjs` |
| Early `initializationCompleteFlag` (after DB+search, not MCP) | In `src/services/worker-service.ts` | **Missing** — flag set after MCP connection (5+ minute wait) |

The changes exist in source code but were **never built and synced** to the installed location.

---

## Phase 1: Build and Sync

```bash
npm run build-and-sync
```

### Verification

```bash
# 1. Confirm waitForReadiness exists in installed build
grep -c "waitForReadiness" ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs
# Expected: > 0

# 2. Confirm hooks.json has two SessionStart groups (the split)
python3 -c "import json; d=json.load(open('$(echo $HOME)/.claude/plugins/marketplaces/thedotmack/plugin/hooks/hooks.json')); print('SessionStart groups:', len(d['hooks']['SessionStart']))"
# Expected: 2

# 3. Confirm initializationCompleteFlag is set before MCP connection
grep -n "Core initialization complete" ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs | head -1
# Expected: appears BEFORE "MCP server connected"
```

## Phase 2: Restart Worker and Test

```bash
# Stop existing worker
bun plugin/scripts/worker-service.cjs stop

# Verify stopped
curl -s http://127.0.0.1:37777/api/health && echo "STILL RUNNING" || echo "STOPPED"
```

Then start a new Claude Code session and verify:
- No "SessionStart:startup hook error" messages
- Worker is running: `curl http://127.0.0.1:37777/api/health`
- Readiness endpoint works: `curl http://127.0.0.1:37777/api/readiness`
