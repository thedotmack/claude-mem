# Issue #520: Stuck Messages Analysis

**Date:** January 4, 2026
**Status:** RESOLVED - Issue no longer exists in current codebase
**Original Issue:** Messages in 'processing' status never recovered after worker crash

---

## Executive Summary

The issue described in GitHub #520 has been **fully resolved** in the current codebase through a fundamental architectural change. The system now uses a **claim-and-delete** pattern instead of the old **claim-process-mark** pattern, which eliminates the stuck 'processing' state problem entirely.

---

## Original Issue Description

The issue claimed that after a worker crash:

1. `getSessionsWithPendingMessages()` returns sessions with `status IN ('pending', 'processing')`
2. But `claimNextMessage()` only looks for `status = 'pending'`
3. So 'processing' messages are orphaned

**Proposed Fix:** Add `resetStuckMessages(0)` at start of `processPendingQueues()`

---

## Current Code Analysis

### 1. Queue Processing Pattern: Claim-and-Delete

The current architecture uses `claimAndDelete()` instead of `claimNextMessage()`:

**File:** `/Users/alexnewman/Scripts/claude-mem/src/services/sqlite/PendingMessageStore.ts`

```typescript
// Lines 85-104
claimAndDelete(sessionDbId: number): PersistentPendingMessage | null {
  const claimTx = this.db.transaction((sessionId: number) => {
    const peekStmt = this.db.prepare(`
      SELECT * FROM pending_messages
      WHERE session_db_id = ? AND status = 'pending'
      ORDER BY id ASC
      LIMIT 1
    `);
    const msg = peekStmt.get(sessionId) as PersistentPendingMessage | null;

    if (msg) {
      // Delete immediately - no "processing" state needed
      const deleteStmt = this.db.prepare('DELETE FROM pending_messages WHERE id = ?');
      deleteStmt.run(msg.id);
    }
    return msg;
  });

  return claimTx(sessionDbId) as PersistentPendingMessage | null;
}
```

**Key insight:** Messages are atomically selected and deleted in a single transaction. There is no 'processing' state for messages being actively worked on - they simply don't exist in the database anymore.

### 2. Iterator Uses claimAndDelete

**File:** `/Users/alexnewman/Scripts/claude-mem/src/services/queue/SessionQueueProcessor.ts`

```typescript
// Lines 18-38
async *createIterator(sessionDbId: number, signal: AbortSignal): AsyncIterableIterator<PendingMessageWithId> {
  while (!signal.aborted) {
    try {
      // Atomically claim AND DELETE next message from DB
      // Message is now in memory only - no "processing" state tracking needed
      const persistentMessage = this.store.claimAndDelete(sessionDbId);

      if (persistentMessage) {
        // Yield the message for processing (it's already deleted from queue)
        yield this.toPendingMessageWithId(persistentMessage);
      } else {
        // Queue empty - wait for wake-up event
        await this.waitForMessage(signal);
      }
    } catch (error) {
      // ... error handling
    }
  }
}
```

### 3. getSessionsWithPendingMessages Still Checks Both States

**File:** `/Users/alexnewman/Scripts/claude-mem/src/services/sqlite/PendingMessageStore.ts`

```typescript
// Lines 319-326
getSessionsWithPendingMessages(): number[] {
  const stmt = this.db.prepare(`
    SELECT DISTINCT session_db_id FROM pending_messages
    WHERE status IN ('pending', 'processing')
  `);
  const results = stmt.all() as { session_db_id: number }[];
  return results.map(r => r.session_db_id);
}
```

**This is technically vestigial code** - with the claim-and-delete pattern, messages should never be in 'processing' state. However, it provides backward compatibility and defense-in-depth.

### 4. Startup Recovery Still Exists

**File:** `/Users/alexnewman/Scripts/claude-mem/src/services/worker-service.ts`

```typescript
// Lines 236-242
// Recover stuck messages from previous crashes
const { PendingMessageStore } = await import('./sqlite/PendingMessageStore.js');
const pendingStore = new PendingMessageStore(this.dbManager.getSessionStore().db, 3);
const STUCK_THRESHOLD_MS = 5 * 60 * 1000;
const resetCount = pendingStore.resetStuckMessages(STUCK_THRESHOLD_MS);
if (resetCount > 0) {
  logger.info('SYSTEM', `Recovered ${resetCount} stuck messages from previous session`, { thresholdMinutes: 5 });
}
```

This runs BEFORE `processPendingQueues()` is called (line 281), which addresses the original fix request.

---

## Verification of Issue Status

### Does the Issue Exist?

**NO** - The issue as described no longer exists because:

1. **No 'processing' state during normal operation**: With claim-and-delete, messages go directly from 'pending' to 'deleted'. They never enter a 'processing' state.

2. **Startup recovery handles legacy stuck messages**: Even if 'processing' messages exist (from old code or edge cases), `resetStuckMessages()` is called BEFORE `processPendingQueues()` in `initializeBackground()` (lines 236-241 run before line 281).

3. **Architecture fundamentally changed**: The old `claimNextMessage()` function that only looked for `status = 'pending'` no longer exists. It was replaced with `claimAndDelete()`.

### GeminiAgent and OpenRouterAgent Behavior

Both agents use the same `SessionManager.getMessageIterator()` which calls `SessionQueueProcessor.createIterator()` which uses `claimAndDelete()`. All three agents (SDKAgent, GeminiAgent, OpenRouterAgent) use identical queue processing:

```typescript
// GeminiAgent.ts:174, OpenRouterAgent.ts:134
for await (const message of this.sessionManager.getMessageIterator(session.sessionDbId)) {
  // ...
}
```

They do NOT handle recovery differently - they all rely on the shared infrastructure.

### What v8.5.7 Changed

Looking at the git history:

```
v8.5.7 (ac03901):
- Minor ESM/CommonJS compatibility fix for isMainModule detection
- No queue-related changes

v8.5.6 -> v8.5.7:
- f21ea97 refactor: decompose monolith into modular architecture with comprehensive test suite (#538)
```

The major refactor happened before v8.5.7. The claim-and-delete pattern was already in place.

---

## Timeline of Resolution

Based on git history, the issue was likely resolved through these commits:

1. **b8ce27b** - `feat(queue): Simplify queue processing and enhance reliability`
2. **eb1a78b** - `fix: eliminate duplicate observations by simplifying message queue`
3. **d72a81e** - `Refactor session queue processing and database interactions`

These commits appear to have introduced the claim-and-delete pattern that eliminates the original bug.

---

## Conclusion

**Issue #520 should be closed as resolved.**

The described bug (`claimNextMessage()` only checking `status = 'pending'`) no longer exists because:

1. `claimNextMessage()` was replaced with `claimAndDelete()` which atomically removes messages
2. `resetStuckMessages()` is already called at startup BEFORE `processPendingQueues()`
3. The 'processing' status is now only used for legacy compatibility and edge cases

### No Fix Needed

The proposed fix ("Add `resetStuckMessages(0)` at start of `processPendingQueues()`") is:

1. **Unnecessary** - The recovery happens in `initializeBackground()` before `processPendingQueues()` is called
2. **Using wrong threshold** - `resetStuckMessages(0)` would reset ALL processing messages immediately, which could cause issues if called during normal operation (not just startup)

The current implementation with a 5-minute threshold is more robust - it only recovers truly stuck messages, not messages that are actively being processed.

---

## Appendix: File References

| Component | File | Key Lines |
|-----------|------|-----------|
| claimAndDelete | `src/services/sqlite/PendingMessageStore.ts` | 85-104 |
| Queue Iterator | `src/services/queue/SessionQueueProcessor.ts` | 18-38 |
| Startup Recovery | `src/services/worker-service.ts` | 236-242 |
| processPendingQueues | `src/services/worker-service.ts` | 326-375 |
| getSessionsWithPendingMessages | `src/services/sqlite/PendingMessageStore.ts` | 319-326 |
| resetStuckMessages | `src/services/sqlite/PendingMessageStore.ts` | 279-290 |
