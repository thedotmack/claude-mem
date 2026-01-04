# Session ID Refactor Test Failures Analysis

**Date:** 2026-01-04
**Test File:** `tests/session_id_refactor.test.ts`
**Status:** 8 failures out of 25 tests
**Category:** Session ID Refactor

---

## 1. Executive Summary

The test file validates the semantic renaming of session ID columns from the old naming convention (`claude_session_id`/`sdk_session_id`) to the new convention (`content_session_id`/`memory_session_id`). While the database schema migrations are correctly in place, **8 tests fail due to a fundamental design mismatch between the test expectations and the actual implementation**.

The core issue: Tests expect `memory_session_id` to be initialized equal to `content_session_id` when a session is created, but the implementation intentionally sets `memory_session_id` to `NULL` initially. This is an intentional architectural decision documented in the code, but the tests were written expecting different behavior.

---

## 2. Test Analysis

### 2.1 Failing Tests Overview

| # | Test Name | Expected Behavior | Actual Behavior |
|---|-----------|-------------------|-----------------|
| 1 | `createSDKSession` - memory_session_id initialization | `memory_session_id` equals `content_session_id` initially | `memory_session_id` is `NULL` initially |
| 2 | `updateMemorySessionId` - session capture flow | Update from initial value to new value | Works, but precondition (initial value) fails |
| 3 | `getSessionById` - memory_session_id retrieval | Returns `memory_session_id` equal to `content_session_id` | Returns `NULL` for `memory_session_id` |
| 4 | `storeObservation` - FK constraint #1 | Store observation with `content_session_id` as FK | FK constraint fails (`memory_session_id` is `NULL`) |
| 5 | `storeObservation` - FK constraint #2 | Retrieve observation by session ID | Cannot store (FK fails) |
| 6 | `storeSummary` - FK constraint #1 | Store summary with `content_session_id` as FK | FK constraint fails |
| 7 | `storeSummary` - FK constraint #2 | Retrieve summary by session ID | Cannot store (FK fails) |
| 8 | Resume functionality | Multiple observations with same session | FK constraint fails |

### 2.2 Detailed Test Expectations

#### Test: `should create session with memory_session_id initially equal to content_session_id`
```typescript
// Test expects:
expect(session.memory_session_id).toBe(contentSessionId);

// But implementation does:
// INSERT ... VALUES (?, NULL, ?, ?, ?, ?, 'active')
//                       ^^^^ memory_session_id is NULL
```

#### Test: `storeObservation - should store observation with memory_session_id as foreign key`
```typescript
// Test passes content_session_id to storeObservation:
store.storeObservation(contentSessionId, 'test-project', obs, 1);

// But memory_session_id in sdk_sessions is NULL, and FK references:
// FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id)
// Result: FOREIGN KEY constraint failed
```

---

## 3. Current Implementation Status

### 3.1 What Exists (Working)

1. **Database Schema Migration (v17)**: Column renaming is complete
   - `claude_session_id` -> `content_session_id`
   - `sdk_session_id` -> `memory_session_id`

2. **Method Signatures Updated**: All methods use new column names
   - `createSDKSession(contentSessionId, project, userPrompt)`
   - `updateMemorySessionId(sessionDbId, memorySessionId)`
   - `getSessionById(id)`
   - `storeObservation(memorySessionId, ...)`
   - `storeSummary(memorySessionId, ...)`

3. **Passing Tests (17)**: All schema-related tests pass:
   - Column existence tests (content_session_id, memory_session_id)
   - Migration version tracking
   - User prompt storage with content_session_id
   - Session idempotency

### 3.2 What's Missing/Misaligned

1. **Initial Value Mismatch**:
   - Tests expect: `memory_session_id = content_session_id` on creation
   - Implementation: `memory_session_id = NULL` on creation

2. **Foreign Key Architecture Mismatch**:
   - Tests: Pass `content_session_id` to `storeObservation()` and `storeSummary()`
   - Implementation: These functions store to `memory_session_id` column which references `sdk_sessions.memory_session_id`
   - Since `sdk_sessions.memory_session_id` is NULL, FK constraint fails

---

## 4. Root Cause Analysis

### 4.1 Intentional Design Decision vs Test Expectation Conflict

The implementation has an **intentional architectural decision** documented in the code:

```typescript
// From SessionStore.ts lines 1169-1171:
// NOTE: memory_session_id starts as NULL. It is captured by SDKAgent from the first SDK
// response and stored via updateMemorySessionId(). CRITICAL: memory_session_id must NEVER
// equal contentSessionId - that would inject memory messages into the user's transcript!
```

This is a **security-critical design**:
- `content_session_id` = User's Claude Code session (for transcript)
- `memory_session_id` = Memory agent's internal session (for resume)

These MUST be different to prevent memory agent messages from appearing in the user's transcript.

### 4.2 Test Design Flaw

The tests were written with an **incorrect assumption** that `memory_session_id` should initially equal `content_session_id`. This contradicts the documented architectural decision.

### 4.3 FK Constraint Architecture Issue

The FK constraint design creates a chicken-and-egg problem:

```sql
-- observations.memory_session_id references sdk_sessions.memory_session_id
FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id)

-- But sdk_sessions.memory_session_id is NULL until updateMemorySessionId() is called
-- So observations cannot be stored until the memory session ID is captured
```

---

## 5. Recommended Fixes

### Option A: Fix the Tests (Align with Implementation)

**Rationale:** The implementation's design is intentional and security-critical. Tests should reflect actual behavior.

**Changes Required:**

1. **Update test for `createSDKSession`**:
   ```typescript
   it('should create session with memory_session_id initially NULL', () => {
     const sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'Test');
     const session = store.db.prepare(
       'SELECT memory_session_id FROM sdk_sessions WHERE id = ?'
     ).get(sessionDbId);

     expect(session.memory_session_id).toBeNull();
   });
   ```

2. **Update storeObservation/storeSummary tests** to first call `updateMemorySessionId()`:
   ```typescript
   it('should store observation after memory_session_id is set', () => {
     const contentSessionId = 'obs-test-session';
     const memorySessionId = 'captured-memory-id';

     const sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'Test');
     store.updateMemorySessionId(sessionDbId, memorySessionId);  // Must set before storing

     const result = store.storeObservation(memorySessionId, 'test-project', obs, 1);
     // ... assertions
   });
   ```

3. **Update resume tests** similarly.

**Effort:** Low (test changes only)
**Risk:** None - aligns tests with documented behavior

### Option B: Change Implementation (Align with Tests)

**Rationale:** If the initial equality is desired for simplicity.

**Changes Required:**

1. **Modify `createSDKSession()` to set initial value**:
   ```typescript
   this.db.prepare(`
     INSERT OR IGNORE INTO sdk_sessions
     (content_session_id, memory_session_id, project, user_prompt, ...)
     VALUES (?, ?, ?, ?, ...)  -- memory_session_id = content_session_id initially
   `).run(contentSessionId, contentSessionId, project, userPrompt, ...);
   ```

2. **Document the risk** of session ID confusion in user transcripts.

**Effort:** Low (one line change)
**Risk:** HIGH - Security concern documented in code comments

### Option C: Hybrid - Separate FK Column

**Rationale:** Allow observations to be stored before memory_session_id is captured.

**Changes Required:**

1. Add `content_session_id` as FK in observations/summaries tables
2. Use `content_session_id` for linking initially
3. Keep `memory_session_id` for resume functionality

**Effort:** High (schema migration, code changes)
**Risk:** Medium - More complex schema

---

## 6. Priority and Effort Estimate

| Option | Priority | Effort | Risk | Recommendation |
|--------|----------|--------|------|----------------|
| A: Fix Tests | P1 | 2 hours | Low | **Recommended** |
| B: Change Implementation | P2 | 1 hour | High | Not recommended |
| C: Hybrid FK | P3 | 8 hours | Medium | Future consideration |

### Recommendation

**Option A: Fix the tests to align with the documented implementation.**

The implementation's design decision is security-critical and intentional. The tests were written with incorrect assumptions about the `memory_session_id` initialization behavior.

### Specific Code Changes for Option A

1. **Line 95-105**: Change expectation from `toBe(contentSessionId)` to `toBeNull()`
2. **Lines 126-146**: Add `updateMemorySessionId()` call before assertions
3. **Lines 178-186**: Change expectation to `toBeNull()` or add `updateMemorySessionId()`
4. **Lines 189-236**: Add `updateMemorySessionId()` call before `storeObservation()`
5. **Lines 239-284**: Add `updateMemorySessionId()` call before `storeSummary()`
6. **Lines 359-403**: Add `updateMemorySessionId()` call in test setup

---

## 7. Appendix: Test File Location and Structure

**File:** `/Users/alexnewman/Scripts/claude-mem/tests/session_id_refactor.test.ts`

**Test Suites:**
- `Database Migration 17 - Column Renaming` (7 tests, all passing)
- `createSDKSession - Session ID Initialization` (3 tests, 1 failing)
- `updateMemorySessionId - Memory Agent Session Capture` (2 tests, 1 failing)
- `getSessionById - Session Retrieval` (2 tests, 1 failing)
- `storeObservation - Memory Session ID Reference` (2 tests, 2 failing)
- `storeSummary - Memory Session ID Reference` (2 tests, 2 failing)
- `saveUserPrompt - Content Session ID Reference` (3 tests, all passing)
- `getLatestUserPrompt - Joined Query` (1 test, passing)
- `getAllRecentUserPrompts - Joined Query` (1 test, passing)
- `Resume Functionality - Memory Session ID Usage` (2 tests, 1 failing)

**Implementation File:** `/Users/alexnewman/Scripts/claude-mem/src/services/sqlite/SessionStore.ts`
