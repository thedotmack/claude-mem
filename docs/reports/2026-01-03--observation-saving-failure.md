# Observation Saving Failure Investigation

**Date**: 2026-01-03
**Severity**: CRITICAL
**Status**: Bugs fixed, but observations still not saving

## Summary

Despite fixing two critical bugs (missing `failed_at_epoch` column and FOREIGN KEY constraint errors), observations are still not being saved. Last observation was saved at **2026-01-03 20:44:49** (over an hour ago as of this report).

## Bugs Fixed

### Bug #1: Missing `failed_at_epoch` Column
- **Root Cause**: Code in `PendingMessageStore.markSessionMessagesFailed()` tried to set `failed_at_epoch` column that didn't exist in schema
- **Fix**: Added migration 20 to create the column
- **Status**: ✅ Fixed and verified

### Bug #2: FOREIGN KEY Constraint Failed
- **Root Cause**: ALL THREE agents (SDKAgent, GeminiAgent, OpenRouterAgent) were passing `session.contentSessionId` to `storeObservationsAndMarkComplete()` but function expected `session.memorySessionId`
- **Location**:
  - `src/services/worker/SDKAgent.ts:354`
  - `src/services/worker/GeminiAgent.ts:397`
  - `src/services/worker/OpenRouterAgent.ts:440`
- **Fix**: Changed all three agents to pass `session.memorySessionId` with null check
- **Status**: ✅ Fixed and verified

## Current State (as of investigation)

### Database State
- **Total observations**: 34,734
- **Latest observation**: 2026-01-03 20:44:49 (1+ hours ago)
- **Pending messages**: 0 (queue is empty)
- **Recent sessions**: Multiple sessions created but no observations saved

### Recent Sessions
```
76292 | c5fd263d-d9ae-4f49-8caf-3f7bb4857804 | 4227fb34-ba37-4625-b18c-bc073044ea73 | 2026-01-03T20:50:51.930Z
76269 | 227c4af2-6c64-45cd-8700-4bb8309038a4 | 3ce5f8ff-85d0-4d1a-9c40-c0d8b905fce8 | 2026-01-03T20:47:10.637Z
```

Both have valid `memory_session_id` values captured, suggesting SDK communication is working.

## Root Cause Analysis

### Potential Issues

1. **Worker Not Processing Messages**
   - Queue is empty (0 pending messages)
   - Either messages aren't being created, or they're being processed and deleted immediately without creating observations

2. **Hooks Not Creating Messages**
   - PostToolUse hook may not be firing
   - Or hook is failing silently before creating pending messages

3. **Generator Failing Before Observations**
   - SDK may be failing to return observations
   - Or parsing is failing silently

4. **The FIFO Queue Design Itself**
   - Current system has complex status tracking that hides failures
   - Messages can be marked "processed" even if no observations were created
   - No clear indication of what actually happened

## Evidence of Deeper Problems

### Architectural Issues Found

The queue processing system violates basic FIFO principles:

**Current Overcomplicated Design:**
- Status tracking: `pending` → `processing` → `processed`/`failed`
- Multiple timestamps: `created_at_epoch`, `started_processing_at_epoch`, `completed_at_epoch`, `failed_at_epoch`
- Retry counts and stuck message detection
- Complex recovery logic for different failure scenarios

**What a FIFO Queue Should Be:**
1. INSERT message
2. Process it
3. DELETE when done
4. If worker crashes → message stays in queue → gets reprocessed

The complexity is masking failures. Messages are being marked "processed" but no observations are being created.

## Critical Questions Needing Investigation

1. **Are PostToolUse hooks even firing?**
   - Check hook execution logs
   - Verify tool usage is being captured

2. **Are pending messages being created?**
   - Check message creation in hooks
   - Look for silent failures in message insertion

3. **Is the generator even starting?**
   - Check worker logs for session processing
   - Verify SDK connections are established

4. **Why is the queue always empty?**
   - Messages processed instantly? (unlikely)
   - Messages never created? (more likely)
   - Messages created then immediately deleted? (possible)

## Immediate Next Steps

1. **Add Logging**
   - Add detailed logging to PostToolUse hook
   - Log every step of message creation
   - Log generator startup and SDK responses

2. **Check Hook Execution**
   - Verify hooks are actually running
   - Check for silent failures in hook code

3. **Test Message Creation Manually**
   - Create a test message directly in database
   - Verify worker picks it up and processes it

4. **Simplify the Queue (Long-term)**
   - Remove status tracking complexity
   - Make it a true FIFO queue
   - Make failures obvious instead of silent

## Code Changes Made

### SessionStore.ts
```typescript
// Migration 20: Add failed_at_epoch column
private addFailedAtEpochColumn(): void {
  const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(20);
  if (applied) return;

  const tableInfo = this.db.query('PRAGMA table_info(pending_messages)').all();
  const hasColumn = tableInfo.some(col => col.name === 'failed_at_epoch');

  if (!hasColumn) {
    this.db.run('ALTER TABLE pending_messages ADD COLUMN failed_at_epoch INTEGER');
    logger.info('DB', 'Added failed_at_epoch column to pending_messages table');
  }

  this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(20, new Date().toISOString());
}
```

### SDKAgent.ts, GeminiAgent.ts, OpenRouterAgent.ts
```typescript
// BEFORE (WRONG):
const result = sessionStore.storeObservationsAndMarkComplete(
  session.contentSessionId,  // ❌ Wrong session ID
  session.project,
  observations,
  // ...
);

// AFTER (FIXED):
if (!session.memorySessionId) {
  throw new Error('Cannot store observations: memorySessionId not yet captured');
}

const result = sessionStore.storeObservationsAndMarkComplete(
  session.memorySessionId,  // ✅ Correct session ID
  session.project,
  observations,
  // ...
);
```

## Conclusion

The two bugs are fixed, but observations still aren't being saved. The problem is likely earlier in the pipeline:
- Hooks not executing
- Messages not being created
- Or the overly complex queue system is hiding failures

**The queue design itself is fundamentally flawed** - it tracks too much state and makes failures invisible. A proper FIFO queue would make these issues obvious immediately.

## Recommended Action

1. **Immediate**: Add comprehensive logging to PostToolUse hook and message creation
2. **Short-term**: Manual testing of queue processing
3. **Long-term**: Rip out status tracking and implement proper FIFO queue

---

**Investigation needed**: This report documents what was fixed and what's still broken. The actual root cause of why observations stopped saving needs deeper investigation of the hook execution and message creation pipeline.
