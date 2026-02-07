# Phase 02: Merge PR #820 - Health Check Endpoint Fix

**PR:** https://github.com/thedotmack/claude-mem/pull/820
**Branch:** `fix/health-check-endpoint-811`
**Status:** Has conflicts, needs rebase
**Review:** Approved by bayanoj330-dev
**Priority:** HIGH - Fixes 15-second timeout issue affecting all users

## Summary

Fixes the "Worker did not become ready within 15 seconds" timeout issue by changing health check functions from `/api/readiness` to `/api/health`.

**Root Cause:** `isWorkerHealthy()` and `waitForHealth()` were using `/api/readiness` which returns 503 until full initialization completes (including MCP connection which can take 5+ minutes). Hooks only have 15 seconds timeout.

**Solution:** Use `/api/health` (liveness check) which returns 200 as soon as HTTP server is listening.

## Files Changed

| File | Change |
|------|--------|
| `src/shared/worker-utils.ts` | Change `/api/readiness` → `/api/health` in `isWorkerHealthy()` |
| `src/services/infrastructure/HealthMonitor.ts` | Change `/api/readiness` → `/api/health` in `waitForHealth()` |
| `tests/infrastructure/health-monitor.test.ts` | Update test to expect `/api/health` |

## Dependencies

- **None** - Independent fix

## Fixes Issues

- #811
- #772
- #729

## Tasks

- [x] Checkout PR branch `fix/health-check-endpoint-811` and rebase onto main to resolve conflicts *(Completed: Rebased successfully - build artifact conflicts resolved by accepting main and will rebuild)*
- [x] Review the endpoint change logic in `worker-utils.ts` and `HealthMonitor.ts` *(Completed: Logic is sound - both files use `/api/health` with proper JSDoc explaining the liveness vs readiness distinction)*
- [x] Verify build succeeds after rebase *(Completed: Build succeeded - all hooks, worker service, MCP server, context generator, and React viewer built successfully)*
- [x] Run health monitor tests: `npm test -- tests/infrastructure/health-monitor.test.ts` *(Completed: All 14 tests pass with 24 expect() calls)*
- [x] Merge PR #820 to main *(Completed: Fast-forward merge from fix/health-check-endpoint-811 to main, pushed to origin)*
- [x] Manual verification: Kill worker and start fresh session - should not see 15-second timeout *(Completed: Worker health endpoint responds in ~12ms, no timeout errors in logs, both worker-utils.ts and HealthMonitor.ts correctly use /api/health)*

## Verification

```bash
# After merge, verify hooks work during MCP initialization
# Start a fresh session and observe logs
tail -f ~/.claude-mem/logs/worker.log | grep -i "health"
```

## Notes

- This is a quick fix with minimal code changes
- The `/api/health` endpoint returns 200 as soon as Express is listening
- Background initialization continues after health check passes
- Related to PR #774 which had the same fix but has merge conflicts
