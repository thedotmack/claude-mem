# Session ID Architecture

## Overview

Claude-mem uses **two distinct session IDs** to track conversations and memory:

1. **`contentSessionId`** - The user's Claude Code conversation session ID
2. **`memorySessionId`** - The SDK agent's internal session ID for resume functionality

## Critical Architecture

### Initialization Flow

```
┌─────────────────────────────────────────────────────────────┐
│ 1. Hook creates session                                     │
│    createSDKSession(contentSessionId, project, prompt)      │
│                                                              │
│    Database state:                                          │
│    ├─ content_session_id: "user-session-123"               │
│    └─ memory_session_id: NULL (not yet captured)           │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│ 2. SDKAgent starts, checks hasRealMemorySessionId           │
│    const hasReal = memorySessionId !== null                 │
│    → FALSE (it's NULL)                                      │
│    → Resume NOT used (fresh SDK session)                    │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│ 3. First SDK message arrives with session_id                │
│    updateMemorySessionId(sessionDbId, "sdk-gen-abc123")     │
│                                                              │
│    Database state:                                          │
│    ├─ content_session_id: "user-session-123"               │
│    └─ memory_session_id: "sdk-gen-abc123" (real!)          │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│ 4. Subsequent prompts use resume                            │
│    const hasReal = memorySessionId !== null                 │
│    → TRUE (it's not NULL)                                   │
│    → Resume parameter: { resume: "sdk-gen-abc123" }         │
└─────────────────────────────────────────────────────────────┘
```

### Observation Storage

**CRITICAL**: Observations are stored with `contentSessionId`, NOT the captured SDK `memorySessionId`.

```typescript
// SDKAgent.ts line 332-333
this.dbManager.getSessionStore().storeObservation(
  session.contentSessionId,  // ← contentSessionId, not memorySessionId!
  session.project,
  obs,
  // ...
);
```

Even though the parameter is named `memorySessionId`, it receives `contentSessionId`. This means:

- Database column: `observations.memory_session_id`
- Stored value: `contentSessionId` (the user's session ID)
- Foreign key: References `sdk_sessions.memory_session_id`

The observations are linked to the session via `contentSessionId`, which remains constant throughout the session lifecycle.

## Key Invariants

### 1. NULL-Based Detection

```typescript
const hasRealMemorySessionId = session.memorySessionId !== null;
```

- When `memorySessionId === null` → Not yet captured
- When `memorySessionId !== null` → Real SDK session captured

### 2. Resume Safety

**NEVER** use `contentSessionId` for resume:

```typescript
// ❌ FORBIDDEN - Would resume user's session instead of memory session!
query({ resume: contentSessionId })

// ✅ CORRECT - Only resume when we have real memory session ID
query({
  ...(hasRealMemorySessionId && { resume: memorySessionId })
})
```

### 3. Session Isolation

- Each `contentSessionId` maps to exactly one database session
- Each database session has one `memorySessionId` (initially NULL, then captured)
- Observations from different content sessions must NEVER mix

### 4. Foreign Key Integrity

- Observations reference `sdk_sessions.memory_session_id`
- Initially, `sdk_sessions.memory_session_id` is NULL (no observations can be stored yet)
- When SDK session ID is captured, `sdk_sessions.memory_session_id` is set to the real value
- Observations are stored using `contentSessionId` and remain retrievable via `contentSessionId`

## Testing Strategy

The test suite validates all critical invariants:

### Test File

`tests/session_id_usage_validation.test.ts`

### Test Categories

1. **NULL-Based Detection** - Validates `hasRealMemorySessionId` logic
2. **Observation Storage** - Confirms observations use `contentSessionId`
3. **Resume Safety** - Prevents `contentSessionId` from being used for resume
4. **Cross-Contamination Prevention** - Ensures session isolation
5. **Foreign Key Integrity** - Validates cascade behavior
6. **Session Lifecycle** - Tests create → capture → resume flow
7. **Edge Cases** - Handles NULL, duplicate IDs, etc.

### Running Tests

```bash
# Run all session ID tests
bun test tests/session_id_usage_validation.test.ts

# Run all tests
bun test

# Run with verbose output
bun test --verbose
```

## Common Pitfalls

### ❌ Using memorySessionId for observations

```typescript
// WRONG - Don't use the captured SDK session ID
storeObservation(session.memorySessionId, ...)
```

### ❌ Resuming without checking for NULL

```typescript
// WRONG - memorySessionId could be NULL!
if (session.memorySessionId) {
  query({ resume: session.memorySessionId })
}
```

### ❌ Assuming memorySessionId is always set

```typescript
// WRONG - Can be NULL before SDK session is captured
const resumeId = session.memorySessionId
```

## Correct Usage Patterns

### ✅ Storing observations

```typescript
// Always use contentSessionId
storeObservation(session.contentSessionId, project, obs, ...)
```

### ✅ Checking for real memory session ID

```typescript
const hasRealMemorySessionId = session.memorySessionId !== null;
```

### ✅ Using resume parameter

```typescript
query({
  prompt: messageGenerator,
  options: {
    ...(hasRealMemorySessionId && { resume: session.memorySessionId }),
    // ... other options
  }
})
```

## Debugging Tips

### Check session state

```sql
-- See both session IDs
SELECT
  id,
  content_session_id,
  memory_session_id,
  CASE
    WHEN memory_session_id IS NULL THEN 'NOT_CAPTURED'
    ELSE 'CAPTURED'
  END as state
FROM sdk_sessions
WHERE content_session_id = 'your-session-id';
```

### Find orphaned observations

```sql
-- Should return 0 rows if FK integrity is maintained
SELECT o.*
FROM observations o
LEFT JOIN sdk_sessions s ON o.memory_session_id = s.memory_session_id
WHERE s.id IS NULL;
```

### Verify observation linkage

```sql
-- See which observations belong to a session
SELECT
  o.id,
  o.title,
  o.memory_session_id,
  s.content_session_id,
  s.memory_session_id as session_memory_id
FROM observations o
JOIN sdk_sessions s ON o.memory_session_id = s.memory_session_id
WHERE s.content_session_id = 'your-session-id';
```

## References

- **Implementation**: `src/services/worker/SDKAgent.ts` (lines 72-94)
- **Database Schema**: `src/services/sqlite/SessionStore.ts` (line 95-104)
- **Tests**: `tests/session_id_usage_validation.test.ts`
- **Related Tests**: `tests/session_id_refactor.test.ts`
