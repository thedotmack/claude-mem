# Memory Leak Investigation: claude-mem Worker Service

## Problem Statement

The claude-mem worker service exhibits critical heap usage (90%+) that leads to performance degradation and crashes. Heap usage grows from 76% to 88% in 10 minutes during normal operation.

## System Information

**Environment:**

- Plugin version: 6.0.2
- Node.js version: 25.2.0
- PM2 process: claude-mem-worker
- Database: 3,496 observations, 15 MB SQLite
- Vector DB: 121 MB (Chroma)

**Worker Configuration:**

- Default heap limit: ~20-26 MiB (V8 default)
- No NODE_OPTIONS configuration support
- Port: 37777

## Evidence

### Heap Usage Timeline

| Time | Heap Used | Heap Total | Percentage | Status |
|------|-----------|------------|------------|--------|
| Startup | 15.30 MiB | 18.42 MiB | 83.03% | Post-GC |
| +7 min | 17.05 MiB | 22.42 MiB | 76.04% | Initial load |
| +36 min | ~21 MiB | ~26 MiB | 80% | Peak growth |
| +75 min | 21.06 MiB | 26.42 MiB | 79.71% | Pre-GC |
| +135 min | 15.30 MiB | 18.42 MiB | 83.03% | Post-GC (abnormal) |
| Restart | 17.32 MiB | 22.67 MiB | 76.38% | Fresh start |
| +10 min | ~19 MiB | ~21.5 MiB | 88.52% | Rapid growth |

**Critical Observation:** After GC ran at +135 minutes, heap percentage *increased* from 79.71% to 83.03% despite freeing 5.76 MiB. This indicates V8 is shrinking the heap limit due to memory pressure—a sign of undersized heap or leak.

### EventEmitter Memory Leak (Historical)

Logs from Nov 11 show repeated warnings:

```text
MaxListenersExceededWarning: Possible EventEmitter memory leak detected.
11 message listeners added to [EventEmitter]. MaxListeners is 10.
```

Pattern indicates listener cleanup issues during active sessions.

### Worker Restart Pattern

Worker experienced 10 consecutive crashes on Nov 16 at 00:43:23 due to missing PM2 dependencies:

```text
Error: Cannot find module '.../node_modules/pm2/lib/ProcessContainerFork.js'
```

Self-healed at 00:44:56 after dependencies restored. This crash-loop pattern suggests fragility in dependency management.

## Root Causes Identified

### 1. Undersized Heap for Workload

Current heap limit (~20-26 MiB) is insufficient for:

- 121 MB vector database (loaded into memory)
- 3,496 observations with embeddings
- Active session state management

Industry standard: Worker services should idle at 40-60% heap usage. Current 80-90% baseline indicates chronic memory pressure.

### 2. EventEmitter Listener Cleanup

EventEmitter warnings indicate missing `removeListener()` calls. Likely locations:

- Session event handlers
- Message queue processing
- Worker-hook communication

### 3. No Memory Configuration Support

The `~/.claude-mem/settings.json` file supports `CLAUDE_MEM_WORKER_PORT` but not `NODE_OPTIONS`. Users cannot increase heap limit without modifying `ecosystem.config.cjs` (which gets overwritten on updates).

## Attempted Fixes

### Created Settings File

```json
{
  "env": {
    "NODE_OPTIONS": "--max-old-space-size=256"
  }
}
```

**Result:** Settings file created but not loaded by worker. Hook scripts read this file for port configuration, but PM2 worker ignores it.

### Created Monitoring Script

Created `~/.claude-mem/check-health.sh` for manual monitoring:

```bash
#!/bin/bash
# Extracts heap percentage and warns at 80%/90% thresholds
cd ~/.claude/plugins/marketplaces/thedotmack/
HEAP=$(node_modules/.bin/pm2 describe claude-mem-worker | grep "Heap Usage" | grep -oE '[0-9]+\.[0-9]+' | head -1)
# ... threshold checks ...
```

## Current Status

**Worker State:** Online but unstable

- Heap: 88.52% (last check)
- Memory pressure causing aggressive GC cycles
- Crash risk: High (approaching 90% threshold)

**Related Issues:**

- GitHub #117: "it often crashes" (opened Nov 16, 2025) - same symptoms
- GitHub #107: "Memory leaks" (closed Nov 14) - closed without documented fix, user upgraded from v4.3 to v6

## Recommended Next Steps

### Immediate (Stop the Bleeding)

1. Add NODE_OPTIONS support in `ecosystem.config.cjs`:

   ```javascript
   const settings = loadSettingsFile('~/.claude-mem/settings.json');
   node_args: settings.env?.NODE_OPTIONS || '--max-old-space-size=256'
   ```

2. Document restart procedure in troubleshooting guide

### Short-term (Fix the Leak)

1. Profile worker with Node.js inspector:

   ```bash
   NODE_OPTIONS='--inspect --max-old-space-size=256' node plugin/scripts/worker-service.cjs
   ```

2. Take heap snapshots at 0min, 5min, 10min, 15min intervals

3. Use Chrome DevTools to compare snapshots and identify accumulating objects

4. Add proper EventEmitter cleanup:
   - Find `emitter.on(...)` calls without corresponding `removeListener()`
   - Implement session cleanup handlers
   - Add max listeners configuration where appropriate

### Medium-term (Architectural)

1. Implement bounded data structures:
   - Limit `pendingMessages` queue size (currently unbounded)
   - Add TTL to `activeSessions` Map
   - Implement LRU cache for vector embeddings

2. Add queue metrics to `/health` endpoint for monitoring

3. Replace polling with event-driven AsyncQueue (per architecture docs)

4. Consider persisting `pendingMessages` queue to prevent data loss on restart

## Investigation Artifacts

**Configuration Files:**

- `~/.claude-mem/settings.json` - Created with NODE_OPTIONS
- `~/.claude-mem/check-health.sh` - Monitoring script

**Log Evidence:**

- `~/.claude-mem/logs/worker-error.log` - EventEmitter warnings (Nov 11)
- PM2 logs showing 10 restarts (Nov 16, 00:43-00:44)

**Database State:**

- 3,496 observations
- 121 MB vector database
- ~4.3 MB total observation text

## Time Estimate

**Investigation Phase:** 2-4 hours (profiling + EventEmitter review)
**Fix Implementation:** 4-8 hours (NODE_OPTIONS + cleanup)
**Testing & Validation:** 2-3 hours (automated + manual)

**Total:** 8-15 hours depending on root cause complexity

## Questions for Profiling

1. What object types are accumulating in heap snapshots?
2. Are vector embeddings being cached indefinitely?
3. Are Chroma DB connections being released properly?
4. Which EventEmitters are exceeding max listeners?
5. Is `pendingMessages` queue growing unbounded?
