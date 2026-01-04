# Observation Duplication Regression - 2026-01-02

## Executive Summary

A critical regression is causing the same observation to be created multiple times (2-11 duplicates per observation). This occurred after recent error handling refactoring work that removed try-catch blocks. The root cause is a **race condition between observation persistence and message completion marking** in the SDK agent, exacerbated by crash recovery logic.

## Symptoms

- **11 observations** about "session generator failure" created between 10:01-10:09 PM (same content, different timestamps)
- **8 observations** about "fixed missing closing brace" created between 9:32 PM-9:55 PM
- **2 observations** about "remove large try-catch blocks" created at 9:33 PM
- Multiple other duplicates across different sessions

Example from database:
```sql
-- Same observation created 8 times over 23 minutes
id     | title                                          | created_at
-------|------------------------------------------------|-------------------
36050  | Fixed Missing Closing Brace in SearchManager  | 2026-01-02 21:32:43
36040  | Fixed Missing Closing Brace in SearchManager  | 2026-01-02 21:33:34
36047  | Fixed missing closing brace...                | 2026-01-02 21:33:38
36041  | Fixed missing closing brace...                | 2026-01-02 21:34:33
36060  | Fixed Missing Closing Brace...                | 2026-01-02 21:41:23
36062  | Fixed Missing Closing Brace...                | 2026-01-02 21:53:02
36063  | Fixed Missing Closing Brace...                | 2026-01-02 21:53:33
36065  | Fixed missing closing brace...                | 2026-01-02 21:55:06
```

## Root Cause Analysis

### The Critical Race Condition

The SDK agent has a fatal ordering issue in message processing:

**File: `/Users/alexnewman/Scripts/claude-mem/src/services/worker/SDKAgent.ts`**

```typescript
// Line 328-410: processSDKResponse()
private async processSDKResponse(...): Promise<void> {
  // Parse observations from SDK response
  const observations = parseObservations(text, session.contentSessionId);

  // Store observations IMMEDIATELY
  for (const obs of observations) {
    const { id: obsId } = this.dbManager.getSessionStore().storeObservation(...);
    // ⚠️ OBSERVATION IS NOW IN DATABASE
  }

  // Parse and store summary
  const summary = parseSummary(text, session.sessionDbId);
  if (summary) {
    this.dbManager.getSessionStore().storeSummary(...);
    // ⚠️ SUMMARY IS NOW IN DATABASE
  }

  // ONLY NOW mark the message as processed
  await this.markMessagesProcessed(session, worker);  // ⚠️ LINE 487
}
```

```typescript
// Line 494-502: markMessagesProcessed()
private async markMessagesProcessed(...): Promise<void> {
  const pendingMessageStore = this.sessionManager.getPendingMessageStore();
  if (session.pendingProcessingIds.size > 0) {
    for (const messageId of session.pendingProcessingIds) {
      pendingMessageStore.markProcessed(messageId);  // ⚠️ TOO LATE!
    }
  }
}
```

### The Window of Vulnerability

Between storing observations (line ~340) and marking the message as processed (line 498), there is a **critical window** where:

1. **Observations exist in database** ✅
2. **Message is still in 'processing' status** ⚠️
3. **If SDK crashes/exits** → Message remains stuck in 'processing'

### How Crash Recovery Makes It Worse

**File: `/Users/alexnewman/Scripts/claude-mem/src/services/worker/http/routes/SessionRoutes.ts`**

```typescript
// Line 183-205: Generator .finally() block
.finally(() => {
  // Crash recovery: If not aborted and still has work, restart
  if (!wasAborted) {
    const pendingStore = this.sessionManager.getPendingMessageStore();
    const pendingCount = pendingStore.getPendingCount(sessionDbId);

    if (pendingCount > 0) {  // ⚠️ Counts 'processing' messages too!
      logger.info('SESSION', `Restarting generator after crash/exit`);

      // Restart generator
      setTimeout(() => {
        this.startGeneratorWithProvider(stillExists, ...);
      }, 1000);
    }
  }
});
```

**File: `/Users/alexnewman/Scripts/claude-mem/src/services/sqlite/PendingMessageStore.ts`**

```typescript
// Line 319-326: getPendingCount()
getPendingCount(sessionDbId: number): number {
  const stmt = this.db.prepare(`
    SELECT COUNT(*) as count FROM pending_messages
    WHERE session_db_id = ? AND status IN ('pending', 'processing')  // ⚠️
  `);
  return result.count;
}

// Line 299-314: resetStuckMessages()
resetStuckMessages(thresholdMs: number): number {
  const stmt = this.db.prepare(`
    UPDATE pending_messages
    SET status = 'pending', started_processing_at_epoch = NULL
    WHERE status = 'processing' AND started_processing_at_epoch < ?  // ⚠️
  `);
  return result.changes;
}
```

### The Duplication Sequence

1. **SDK processes message #1** (e.g., "Read tool on SearchManager.ts")
   - Marks message as 'processing' in database
   - Sends observation prompt to SDK agent

2. **SDK returns response** with observation
   - `parseObservations()` extracts: "Fixed missing closing brace..."
   - `storeObservation()` saves observation #1 to database ✅
   - **CRASH or ERROR occurs** (e.g., from recent error handling changes)
   - `markMessagesProcessed()` NEVER CALLED ⚠️
   - Message remains in 'processing' status

3. **Crash recovery triggers** (line 184-204)
   - `getPendingCount()` finds message still in 'processing'
   - Generator restarts with 1-second delay

4. **Worker restart or stuck message recovery**
   - `resetStuckMessages()` resets message to 'pending'
   - Generator processes the SAME message again

5. **SDK processes message #1 AGAIN**
   - Same observation prompt sent to SDK
   - SDK returns SAME observation (deterministic from same file state)
   - `storeObservation()` saves observation #2 ✅ (DUPLICATE!)
   - Process may crash again, creating observation #3, #4, etc.

### Why No Database Deduplication?

**File: `/Users/alexnewman/Scripts/claude-mem/src/services/sqlite/SessionStore.ts`**

```typescript
// Line 1224-1229: storeObservation() - NO deduplication!
const stmt = this.db.prepare(`
  INSERT INTO observations
  (memory_session_id, project, type, title, subtitle, ...)
  VALUES (?, ?, ?, ?, ?, ...)  // ⚠️ No INSERT OR IGNORE, no uniqueness check
`);
```

The database table has:
- ❌ No UNIQUE constraint on (memory_session_id, title, subtitle, type)
- ❌ No INSERT OR IGNORE logic
- ❌ No deduplication check before insertion

Compare to the IMPORT logic which DOES have deduplication:
```typescript
// Line ~1440: importObservation() HAS deduplication
const existing = this.checkObservationExists(
  obs.memory_session_id,
  obs.title,
  obs.subtitle,
  obs.type
);

if (existing) {
  return { imported: false, id: existing.id };  // ✅ Prevents duplicates
}
```

## Connection to Anti-Pattern Cleanup Work

### What Changed

Recent commits removed try-catch blocks as part of anti-pattern mitigation:

```bash
0123b15 refactor: add error handling back to SearchManager Chroma calls
776f4ea Refactor hooks to streamline error handling and loading states
0ea82bd refactor: improve error logging across SessionStore and mcp-server
379b0c1 refactor: improve error logging in SearchManager.ts
4c0cdec refactor: improve error handling in worker-service.ts
```

Commit `776f4ea` made significant changes:
- Removed try-catch blocks from hooks (useContextPreview, usePagination, useSSE, useSettings)
- Modified SessionStore.ts error handling
- Modified SearchManager.ts error handling (3000+ lines changed)

### How This Triggered the Bug

The duplication regression was **latent** - the race condition always existed. However:

1. **Before**: Large try-catch blocks suppressed errors
   - SDK errors were caught and logged
   - Generator continued running
   - Messages got marked as processed (eventually)

2. **After**: Error handling removed/streamlined
   - SDK errors now crash the generator
   - Generator exits before marking messages processed
   - Crash recovery restarts generator repeatedly
   - Same message processed multiple times

### Evidence from Database

Session 75894 (content_session_id: 56f94e5d-2514-4d44-aa43-f5e31d9b4c38):
- **26 pending messages** queued (all unique)
- **Only 7 observations** should have been created
- **But 8+ duplicates** of "Fixed missing closing brace" were created
- Created over 23-minute window (9:32 PM - 9:55 PM)
- Indicates **repeated crashes and recoveries**

## Fix Strategy

### Short-term Fix (Critical)

**Option 1: Transaction-based atomic completion** (RECOMMENDED)

Wrap observation storage and message completion in a single transaction:

```typescript
// In SDKAgent.ts processSDKResponse()
private async processSDKResponse(...): Promise<void> {
  const pendingStore = this.sessionManager.getPendingMessageStore();

  // Start transaction
  const db = this.dbManager.getSessionStore().db;
  const saveTransaction = db.transaction(() => {
    // Parse and store observations
    const observations = parseObservations(text, session.contentSessionId);
    const observationIds = [];

    for (const obs of observations) {
      const { id } = this.dbManager.getSessionStore().storeObservation(...);
      observationIds.push(id);
    }

    // Parse and store summary
    const summary = parseSummary(text, session.sessionDbId);
    if (summary) {
      this.dbManager.getSessionStore().storeSummary(...);
    }

    // CRITICAL: Mark messages as processed IN SAME TRANSACTION
    for (const messageId of session.pendingProcessingIds) {
      pendingStore.markProcessed(messageId);
    }

    return observationIds;
  });

  // Execute transaction atomically
  const observationIds = saveTransaction();

  // Broadcast to SSE AFTER transaction commits
  for (const obsId of observationIds) {
    worker?.sseBroadcaster.broadcast(...);
  }
}
```

**Option 2: Mark processed BEFORE storing** (SIMPLER)

```typescript
// In SDKAgent.ts processSDKResponse()
private async processSDKResponse(...): Promise<void> {
  // Mark messages as processed FIRST
  await this.markMessagesProcessed(session, worker);

  // Then store observations (idempotent)
  const observations = parseObservations(text, session.contentSessionId);
  for (const obs of observations) {
    this.dbManager.getSessionStore().storeObservation(...);
  }
}
```

Risk: If storage fails, message is marked complete but observation is lost. However, this is better than duplicates.

### Medium-term Fix (Important)

**Add database-level deduplication:**

```sql
-- Add unique constraint
CREATE UNIQUE INDEX idx_observations_unique
ON observations(memory_session_id, title, subtitle, type);

-- Modify storeObservation() to use INSERT OR IGNORE
INSERT OR IGNORE INTO observations (...) VALUES (...);
```

Or use the existing `checkObservationExists()` logic:

```typescript
// In SessionStore.ts storeObservation()
storeObservation(...): { id: number; createdAtEpoch: number } {
  // Check for existing observation
  const existing = this.checkObservationExists(
    memorySessionId,
    observation.title,
    observation.subtitle,
    observation.type
  );

  if (existing) {
    logger.debug('DB', 'Observation already exists, skipping', {
      obsId: existing.id,
      title: observation.title
    });
    return { id: existing.id, createdAtEpoch: existing.created_at_epoch };
  }

  // Insert new observation...
}
```

### Long-term Fix (Architectural)

**Redesign crash recovery to be idempotent:**

1. **Message status flow should be:**
   - `pending` → `processing` → `processed` (one-way, no resets)

2. **Stuck message recovery should:**
   - Create NEW message for retry (with retry_count)
   - Mark old message as 'failed' or 'abandoned'
   - Never reset 'processing' → 'pending'

3. **SDK agent should:**
   - Track which observations were created for each message
   - Skip observation creation if message was already processed
   - Use message ID as idempotency key

## Testing Plan

1. **Reproduce the regression:**
   - Create session with multiple tool uses
   - Force SDK crash during observation processing
   - Verify duplicates are NOT created with fix

2. **Edge cases:**
   - Test worker restart during observation storage
   - Test network failure during Chroma sync
   - Test database write failure scenarios

3. **Performance:**
   - Verify transaction doesn't slow down processing
   - Test with high observation volume (100+ per session)

## Cleanup Required

Run the existing cleanup script to remove current duplicates:

```bash
cd /Users/alexnewman/Scripts/claude-mem
npm run cleanup-duplicates
```

This script identifies duplicates by `(memory_session_id, title, subtitle, type)` and keeps the earliest (MIN(id)).

## Files Requiring Changes

1. **src/services/worker/SDKAgent.ts** - Add transaction or reorder completion
2. **src/services/sqlite/SessionStore.ts** - Add deduplication check
3. **src/services/sqlite/migrations.ts** - Add unique index (optional)
4. **src/services/worker/http/routes/SessionRoutes.ts** - Improve crash recovery logging

## Estimated Impact

- **Severity**: Critical (data integrity)
- **Scope**: All sessions since 2026-01-02 ~9:30 PM
- **User impact**: Confusing duplicate memories, inflated token counts
- **Database impact**: ~50-100+ duplicate rows

## References

- Original issue: Generator failure observations (11 duplicates)
- Related commit: `776f4ea` "Refactor hooks to streamline error handling"
- Cleanup script: `/Users/alexnewman/Scripts/claude-mem/src/bin/cleanup-duplicates.ts`
- Related report: `docs/reports/2026-01-02--stuck-observations.md`
