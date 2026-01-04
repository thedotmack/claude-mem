# SessionStore Test Failures Analysis

**Date:** 2026-01-04
**Category:** SessionStore
**Failing Tests:** 2
**File:** `tests/session_store.test.ts`

---

## 1. Executive Summary

Two tests in the SessionStore test suite are failing due to **SQLite foreign key constraint violations**. The tests attempt to store observations and summaries using a `memory_session_id` that does not exist in the `sdk_sessions` table, because `createSDKSession()` now stores `memory_session_id` as `NULL` instead of setting it to the `content_session_id`.

This is a **test design issue**, not a production bug. The tests were written before a critical architectural change that separated `memory_session_id` from `content_session_id` to prevent memory messages from being injected into user transcripts.

---

## 2. Test Analysis

### Test 1: `should store observation with timestamp override`

**Location:** Lines 36-74

**What it does:**
1. Creates an SDK session using `createSDKSession(claudeId, project, prompt)`
2. Constructs an observation object
3. Calls `storeObservation(claudeId, project, observation, promptNumber, 0, pastTimestamp)`
4. Expects the observation to be stored with the overridden timestamp
5. Retrieves the observation and verifies `created_at_epoch` matches the override

**Expected behavior:**
- Observation should be stored with `createdAtEpoch = 1600000000000`
- Retrieved observation should have `created_at_epoch = 1600000000000`
- ISO string should match the epoch timestamp

**Actual error:**
```
SQLiteError: FOREIGN KEY constraint failed
```

### Test 2: `should store summary with timestamp override`

**Location:** Lines 76-105

**What it does:**
1. Creates an SDK session using `createSDKSession(claudeId, project, prompt)`
2. Constructs a summary object
3. Calls `storeSummary(claudeId, project, summary, promptNumber, 0, pastTimestamp)`
4. Expects the summary to be stored with the overridden timestamp
5. Retrieves the summary and verifies `created_at_epoch` matches the override

**Expected behavior:**
- Summary should be stored with `createdAtEpoch = 1650000000000`
- Retrieved summary should have `created_at_epoch = 1650000000000`

**Actual error:**
```
SQLiteError: FOREIGN KEY constraint failed
```

---

## 3. Current Implementation Status

### Schema (from `initializeSchema()`)

**observations table:**
```sql
CREATE TABLE observations (
  ...
  memory_session_id TEXT NOT NULL,
  ...
  FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE
);
```

**session_summaries table:**
```sql
CREATE TABLE session_summaries (
  ...
  memory_session_id TEXT NOT NULL,
  ...
  FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE
);
```

### createSDKSession Implementation (Lines 1164-1182)

```typescript
createSDKSession(contentSessionId: string, project: string, userPrompt: string): number {
  const now = new Date();
  const nowEpoch = now.getTime();

  // NOTE: memory_session_id starts as NULL. It is captured by SDKAgent from the first SDK
  // response and stored via updateMemorySessionId(). CRITICAL: memory_session_id must NEVER
  // equal contentSessionId - that would inject memory messages into the user's transcript!
  this.db.prepare(`
    INSERT OR IGNORE INTO sdk_sessions
    (content_session_id, memory_session_id, project, user_prompt, started_at, started_at_epoch, status)
    VALUES (?, NULL, ?, ?, ?, ?, 'active')
  `).run(contentSessionId, project, userPrompt, now.toISOString(), nowEpoch);

  // Return existing or new ID
  const row = this.db.prepare('SELECT id FROM sdk_sessions WHERE content_session_id = ?')
    .get(contentSessionId) as { id: number };
  return row.id;
}
```

**Key observation:** `memory_session_id` is inserted as `NULL`, and must be updated later via `updateMemorySessionId()`.

### storeObservation Implementation (Lines 1224-1273)

The method expects `memorySessionId` as the first parameter and uses it directly to insert into the `observations` table:

```typescript
storeObservation(
  memorySessionId: string,  // <-- This is the FK value
  project: string,
  ...
)
```

### storeSummary Implementation (Lines 1279-1324)

Similar to storeObservation, expects `memorySessionId` as first parameter:

```typescript
storeSummary(
  memorySessionId: string,  // <-- This is the FK value
  project: string,
  ...
)
```

---

## 4. Root Cause Analysis

### The Problem

The tests pass `claudeId` (which equals `content_session_id`) to `storeObservation()` and `storeSummary()`, but these methods require a valid `memory_session_id` that exists in `sdk_sessions.memory_session_id`.

**Flow of test:**
1. `createSDKSession('claude-sess-obs', ...)` creates a row with:
   - `content_session_id = 'claude-sess-obs'`
   - `memory_session_id = NULL`

2. `storeObservation('claude-sess-obs', ...)` tries to insert with:
   - `memory_session_id = 'claude-sess-obs'`

3. FK check: Does `'claude-sess-obs'` exist in `sdk_sessions.memory_session_id`? **NO** (it's NULL)

4. Result: `FOREIGN KEY constraint failed`

### Historical Context

The test comments reveal the original assumption (lines 40-42):
```typescript
// createSDKSession inserts using memory_session_id = content_session_id in the current implementation
// "VALUES (?, ?, ?, ?, ?, ?, 'active')" -> contentSessionId, contentSessionId, ...
```

This comment is **outdated**. The implementation was changed to set `memory_session_id = NULL` to prevent memory messages from leaking into user transcripts (a critical architectural fix noted in the code comment at line 1170-1171).

### Why This Matters

In production, the flow is:
1. Hook creates session with `memory_session_id = NULL`
2. SDKAgent processes messages and captures the actual memory session ID from the SDK response
3. `updateMemorySessionId()` is called to set the proper value
4. **Only then** can observations/summaries be stored

The tests skip step 2-3, which is why they fail.

---

## 5. Recommended Fixes

### Option A: Update Tests to Use Proper Flow (Recommended)

Modify the tests to call `updateMemorySessionId()` before storing observations/summaries:

```typescript
it('should store observation with timestamp override', () => {
  const claudeId = 'claude-sess-obs';
  const memorySessionId = 'memory-sess-obs';  // Separate ID
  const sessionDbId = store.createSDKSession(claudeId, 'test-project', 'initial prompt');

  // Simulate SDKAgent capturing the memory session ID
  store.updateMemorySessionId(sessionDbId, memorySessionId);

  const obs = { ... };
  const pastTimestamp = 1600000000000;

  const result = store.storeObservation(
    memorySessionId,  // Use the memory session ID, not claudeId
    'test-project',
    obs,
    1,
    0,
    pastTimestamp
  );

  expect(result.createdAtEpoch).toBe(pastTimestamp);
  // ... rest of assertions
});
```

Similar change for the summary test.

### Option B: Add Test Helper Method

Create a helper that combines session creation and memory ID assignment:

```typescript
function createTestSession(store: SessionStore, sessionId: string, project: string): { dbId: number; memorySessionId: string } {
  const memorySessionId = `memory-${sessionId}`;
  const dbId = store.createSDKSession(sessionId, project, 'test prompt');
  store.updateMemorySessionId(dbId, memorySessionId);
  return { dbId, memorySessionId };
}
```

### Option C: Keep Tests Simple with In-Memory Workaround

For unit tests only, after `createSDKSession()`, manually set the memory_session_id:

```typescript
beforeEach(() => {
  store = new SessionStore(':memory:');
  // No workaround here, but tests must explicitly call updateMemorySessionId
});
```

---

## 6. Priority/Effort Estimate

| Metric | Value |
|--------|-------|
| **Priority** | Medium |
| **Effort** | Low (15-30 minutes) |
| **Risk** | Low |
| **Impact** | Test suite only, no production impact |

### Reasoning

- **Medium priority**: Tests should pass, but this doesn't affect production functionality
- **Low effort**: Simple test modifications, no architectural changes needed
- **Low risk**: Only test code changes, implementation is correct
- **No production impact**: The FK constraint is working correctly in production where the proper flow (session creation -> memory ID assignment -> observation storage) is followed

---

## 7. Additional Notes

### Test Comment Accuracy

The test file contains an outdated comment that should be removed or updated:

```typescript
// createSDKSession inserts using memory_session_id = content_session_id in the current implementation
```

This is no longer accurate and may confuse future developers.

### Related Architecture Decision

The separation of `memory_session_id` from `content_session_id` is intentional and critical. From the implementation comment:

> CRITICAL: memory_session_id must NEVER equal contentSessionId - that would inject memory messages into the user's transcript!

The tests should reflect and respect this architectural decision rather than assuming the two IDs are the same.
