# Investigation Report: Stuck Observations in Processing State

**Date:** January 2, 2026
**Investigator:** Claude
**Status:** Complete
**Severity:** High - Observations can get permanently stuck until worker restart

---

## Executive Summary

Observations get stuck in "processing" state due to **six critical gaps** in the message lifecycle:

1. **In-memory tracking set not cleared on error** - `pendingProcessingIds` retains stale IDs after crashes
2. **No try-catch around database updates** - Partial updates leave system in inconsistent state
3. **Hook exit code inconsistency** - Some hooks exit explicitly, others rely on implicit Node.js behavior
4. **5-minute recovery threshold only on startup** - No continuous monitoring during runtime
5. **Iterator doesn't resume after yield errors** - Messages left in "processing" forever
6. **No global error handlers in hooks** - Unhandled promise rejections crash without cleanup

---

## Message Lifecycle Architecture

### Status States

The `pending_messages` table uses 4 states:

| Status | Description | Transition From | Transition To |
|--------|-------------|-----------------|---------------|
| `pending` | Queued, awaiting processing | (created) | `processing` |
| `processing` | Actively being processed by SDK | `pending` | `processed`, `failed`, or stuck |
| `processed` | Successfully completed | `processing` | (deleted after retention) |
| `failed` | Max retries exceeded | `processing` | (permanent) |

### Normal Flow

```
HTTP Request → enqueue() → pending
                              ↓
           claimNextMessage() → processing
                              ↓
              SDK processes → markProcessed() → processed
                              ↓
                      cleanup → deleted
```

### Key Files

| Component | File | Lines |
|-----------|------|-------|
| Status enum | `src/services/sqlite/PendingMessageStore.ts` | 19 |
| Claim message | `src/services/sqlite/PendingMessageStore.ts` | 87-118 |
| Mark processed | `src/services/sqlite/PendingMessageStore.ts` | 252-264 |
| Mark failed | `src/services/sqlite/PendingMessageStore.ts` | 271-296 |
| In-memory tracking | `src/services/worker/SessionManager.ts` | 386 |
| Clear tracking | `src/services/worker/SDKAgent.ts` | 497 |
| Error handler | `src/services/worker/http/routes/SessionRoutes.ts` | 137-168 |

---

## Critical Stuck Points

### Stuck Point #1: In-Memory Set Not Cleared on Error

**Location:** `src/services/worker/http/routes/SessionRoutes.ts:137-168`

**Problem:** When a generator crashes, the error handler marks database messages as failed but **never resets `session.pendingProcessingIds`**.

**Code Path:**
```typescript
session.generatorPromise = agent.startSession(session, this.workerService)
  .catch(error => {
    // Mark all processing messages as failed in DB
    for (const msg of processingMessages) {
      pendingStore.markFailed(msg.id);  // ✓ DB updated
    }
    // ✗ session.pendingProcessingIds.clear() - MISSING!
  });
```

**Result:**
- Database shows messages as `failed`
- In-memory set still contains stale message IDs
- On generator restart, same IDs added again (duplicates possible)
- Memory-database state divergence

**Fix Required:** Add `session.pendingProcessingIds.clear()` in catch block.

---

### Stuck Point #2: No Try-Catch Around markProcessed()

**Location:** `src/services/worker/SDKAgent.ts:487-516`

**Problem:** The `markMessagesProcessed()` function loops through all pending IDs but has no error handling around individual `markProcessed()` calls.

**Code Path:**
```typescript
private async markMessagesProcessed(session, worker): Promise<void> {
  for (const messageId of session.pendingProcessingIds) {
    pendingMessageStore.markProcessed(messageId);  // ✗ No try-catch
  }
  session.pendingProcessingIds.clear();  // Never reached if above throws
}
```

**Result:**
- If DB error occurs on message N, messages N+1...M never marked
- `pendingProcessingIds.clear()` never called
- Partial database update + stale in-memory set

**Fix Required:** Wrap individual `markProcessed()` calls in try-catch, continue on error, log failures.

---

### Stuck Point #3: Hook Exit Code Inconsistency

**Location:** All hooks in `src/hooks/`

**Problem:** Hooks have inconsistent exit patterns:

| Hook | Explicit Exit? | Method | Timeout |
|------|----------------|--------|---------|
| context-hook | YES | `process.exit(0)` | 15s |
| user-message-hook | YES | `process.exit(3)` | 15s |
| new-hook | NO | Implicit | 15s |
| save-hook | NO | Implicit | 300s |
| summary-hook | NO | Implicit | 300s |

**Critical Issues:**

1. **No global error handlers** - No `process.on('unhandledRejection', ...)` in any hook
2. **Async errors bubble to Node.js** - Causes exit(1) with stack trace to stderr
3. **save-hook fire-and-forget pattern** - Errors may not surface

**save-hook.ts Entry Point (lines 75-85):**
```typescript
stdin.on('end', async () => {
  // No try-catch wrapper!
  try {
    parsed = input.trim() ? JSON.parse(input) : undefined;
  } catch (error) {
    throw new Error(`Failed to parse...`);  // Unhandled!
  }
  await saveHook(parsed);  // Also can throw, unhandled!
});
```

**summary-hook.ts Bug (line 68):**
```typescript
if (!response.ok) {
  console.log(STANDARD_HOOK_RESPONSE);  // Outputs success BEFORE throwing!
  throw new Error(`Summary generation failed: ${response.status}`);
}
```

This sends success response to Claude Code, then crashes.

---

### Stuck Point #4: Iterator Doesn't Resume After Yield Error

**Location:** `src/services/queue/SessionQueueProcessor.ts:17-38`

**Problem:** The async iterator stops completely if the consuming agent throws while processing a yielded message.

**Code Path:**
```typescript
async *createIterator(sessionDbId, signal) {
  while (!signal.aborted) {
    const message = this.store.claimNextMessage(sessionDbId);  // → processing
    if (message) {
      yield message;  // Agent throws here = iterator stops
    } else {
      await this.waitForMessage(signal);
    }
  }
}
```

**Result:**
- Message claimed → status = `processing`
- Message yielded → agent throws during processing
- Iterator stops, never resumes
- Message stuck until 5-minute timeout

**Fix Required:** Wrap yield in try-catch, mark failed on error, continue loop.

---

### Stuck Point #5: 5-Minute Recovery Only on Startup

**Location:** `src/services/worker-service.ts:686-690`

**Problem:** Stuck message recovery only runs when worker initializes.

**Code Path:**
```typescript
// In initializeWorker()
const STUCK_THRESHOLD_MS = 5 * 60 * 1000;
const resetCount = pendingStore.resetStuckMessages(STUCK_THRESHOLD_MS);
```

**Result:**
- During normal operation, no continuous monitoring
- Messages can stay stuck for hours if worker doesn't restart
- User must manually restart worker or wait

**Fix Required:** Add periodic stuck message check (every 60 seconds) during runtime.

---

### Stuck Point #6: markFailed() Not Transactional

**Location:** `src/services/sqlite/PendingMessageStore.ts:271-296`

**Problem:** The `markFailed()` method does SELECT then UPDATE without a transaction wrapper.

**Code Path:**
```typescript
markFailed(messageId: number): void {
  const msg = this.db.prepare(`SELECT retry_count FROM pending_messages WHERE id = ?`).get(messageId);

  // Race condition window here!

  if (msg.retry_count < this.maxRetries) {
    this.db.prepare(`UPDATE pending_messages SET status = 'pending', retry_count = retry_count + 1...`).run(messageId);
  } else {
    this.db.prepare(`UPDATE pending_messages SET status = 'failed'...`).run(messageId);
  }
}
```

**Result:**
- If process crashes between SELECT and UPDATE, retry_count may be stale
- Could lead to wrong retry decision

**Fix Required:** Wrap in `this.db.transaction(() => { ... })()`.

---

## Stuck Scenarios

### Scenario A: SDK Hangs During Processing

1. Message claimed → `status = 'processing'`
2. Added to `pendingProcessingIds`
3. Yielded to SDK agent
4. SDK hangs (e.g., network timeout, infinite loop)
5. **Result:** Stuck forever until 5-minute timeout on worker restart

### Scenario B: Generator Crash After Yielding

1. Message claimed and yielded
2. Agent throws error before `markProcessed()`
3. Error handler marks DB messages as `failed`
4. `pendingProcessingIds` NOT cleared
5. Generator restarts
6. Same message IDs added to set again
7. **Result:** Duplicate tracking, potential double-processing

### Scenario C: Partial Database Update

1. 5 messages being marked processed
2. Messages 1-3 succeed
3. Database connection drops
4. Message 4 throws error
5. Loop breaks, messages 4-5 never marked
6. `pendingProcessingIds.clear()` never called
7. **Result:** Mixed state - some processed, some stuck

### Scenario D: Hook Throws Without Cleanup

1. `save-hook.ts` receives observation
2. HTTP request to worker succeeds
3. Output `STANDARD_HOOK_RESPONSE` sent
4. Later code throws (e.g., Chroma sync fails)
5. Node.js exits with code 1
6. **Result:** Claude Code sees success, but observation may be partial

---

## Recovery Mechanisms

### Current Mechanisms

| Mechanism | Location | Trigger | Limitation |
|-----------|----------|---------|------------|
| Startup stuck reset | worker-service.ts:687 | Worker restart | Only on restart |
| Generator crash recovery | SessionRoutes.ts:183-216 | Generator exit | Requires full exit |
| Manual retry | (needs verification) | User action | Requires UI intervention |
| Old message cleanup | SDKAgent.ts:504 | After processing | Only cleans processed |

### Missing Mechanisms

1. **Continuous stuck monitoring** - No runtime detection
2. **Per-message timeout** - No kill switch for hung SDK
3. **UI stuck count display** - User can't see stuck messages
4. **Manual recovery API** - No endpoint to retry individual messages

---

## Recommendations

### Priority 1: Critical Fixes

1. **Clear pendingProcessingIds in error handler**
   - File: `SessionRoutes.ts:168`
   - Add: `session.pendingProcessingIds.clear()`

2. **Add try-catch around markProcessed loop**
   - File: `SDKAgent.ts:489`
   - Wrap individual calls, continue on error

3. **Add global error handler to hooks**
   - All hooks in `src/hooks/`
   - Add `process.on('unhandledRejection', ...)` at entry

### Priority 2: Robustness Improvements

4. **Add continuous stuck message monitor**
   - Check every 60 seconds during runtime
   - Reset messages stuck > 5 minutes

5. **Make markFailed transactional**
   - Wrap SELECT + UPDATE in transaction

6. **Fix summary-hook output-before-throw bug**
   - Move `console.log(STANDARD_HOOK_RESPONSE)` after error check

### Priority 3: Observability

7. **Add stuck message count to viewer UI**
   - Show processing messages > 2 minutes old

8. **Add manual retry API endpoint**
   - Allow user to retry stuck messages without restart

9. **Add explicit exit to all hooks**
   - Consistent `process.exit(0)` on success path

---

## Appendix: File Reference

### Database Layer
- `src/services/sqlite/PendingMessageStore.ts` - Message queue persistence
- `src/services/sqlite/SessionStore.ts` - Session management, table schemas

### Processing Layer
- `src/services/queue/SessionQueueProcessor.ts` - Async iterator for claiming
- `src/services/worker/SessionManager.ts` - Session state, message iterator
- `src/services/worker/SDKAgent.ts` - SDK interaction, response processing

### HTTP Layer
- `src/services/worker/http/routes/SessionRoutes.ts` - Generator lifecycle, error handling

### Worker Layer
- `src/services/worker-service.ts` - Startup recovery, health checks

### Hooks
- `src/hooks/context-hook.ts` - SessionStart (explicit exit)
- `src/hooks/user-message-hook.ts` - SessionStart parallel (explicit exit)
- `src/hooks/new-hook.ts` - UserPromptSubmit (implicit exit)
- `src/hooks/save-hook.ts` - PostToolUse (implicit exit, fire-and-forget)
- `src/hooks/summary-hook.ts` - Stop (implicit exit, output bug)

### Constants
- `src/shared/hook-constants.ts` - Exit codes, timeouts

---

## Conclusion

The primary cause of stuck observations is the **disconnect between in-memory tracking (`pendingProcessingIds`) and database state**. When errors occur, the database may be updated but the in-memory set is not cleared, leading to:

1. Duplicate tracking on restart
2. Memory-database state divergence
3. Messages appearing stuck in UI

Secondary causes include inconsistent hook exit patterns and the lack of runtime stuck message monitoring.

The 5-minute startup recovery is a safety net, but it only works when the worker restarts. For a production system, continuous monitoring and proper error handling at all state transition points are essential.
