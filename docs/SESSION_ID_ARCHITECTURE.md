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
│    const hasReal = !!memorySessionId                        │
│    → FALSE (it's NULL)                                      │
│    → Resume NOT used (fresh SDK session)                    │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│ 3. First SDK message arrives with session_id                │
│    ensureMemorySessionIdRegistered(sessionDbId, "sdk-gen-abc123") │
│                                                              │
│    Database state:                                          │
│    ├─ content_session_id: "user-session-123"               │
│    └─ memory_session_id: "sdk-gen-abc123" (real!)          │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│ 4. Subsequent prompts may use resume                        │
│    const shouldResume =                                      │
│      !!memorySessionId && lastPromptNumber > 1 && !forceInit│
│    → TRUE only for continuation prompts in the same runtime │
│    → Resume parameter: { resume: "sdk-gen-abc123" }         │
└─────────────────────────────────────────────────────────────┘
```

### Observation Storage

**CRITICAL**: Observations are stored with the real `memorySessionId`, NOT `contentSessionId`.

```typescript
// SessionStore.ts
storeObservation(memorySessionId, project, observation, ...);
```

This means:

- Database column: `observations.memory_session_id`
- Stored value: the captured or synthesized `memorySessionId`
- Foreign key: References `sdk_sessions.memory_session_id`

Observation storage is blocked until a real `memorySessionId` is registered in `sdk_sessions`.
This is why `SDKAgent` persists the SDK-returned `session_id` immediately through
`ensureMemorySessionIdRegistered(...)` before any observation insert can succeed.

## Key Invariants

### 1. NULL-Based Detection

```typescript
const hasRealMemorySessionId = !!session.memorySessionId;
```

- When `memorySessionId` is falsy → Not yet captured
- When `memorySessionId` is truthy → Real SDK session captured

### 2. Resume Safety

**NEVER** use `contentSessionId` for resume:

```typescript
// ❌ FORBIDDEN - Would resume user's session instead of memory session!
query({ resume: contentSessionId })

// ✅ CORRECT - Only resume for a continuation prompt in a valid runtime
query({
  ...(
    !!memorySessionId &&
    lastPromptNumber > 1 &&
    !forceInit &&
    { resume: memorySessionId }
  )
})
```

`memorySessionId` is necessary but not sufficient.
Worker restart and crash-recovery paths may still carry a persisted ID while forcing a fresh INIT run.

### 3. Session Isolation

- Each `contentSessionId` maps to exactly one database session
- Each database session has one `memorySessionId` (initially NULL, then captured)
- Observations from different content sessions must NEVER mix

### 4. Foreign Key Integrity

- Observations reference `sdk_sessions.memory_session_id`
- Initially, `sdk_sessions.memory_session_id` is NULL (no observations can be stored yet)
- When SDK session ID is captured, `sdk_sessions.memory_session_id` is set to the real value
- Observations are stored using that real `memory_session_id`
- Queries can still find the session from `content_session_id`, but observation rows themselves stay keyed by `memory_session_id`

## Testing Strategy

The test suite validates all critical invariants:

### Test File

`tests/session_id_usage_validation.test.ts`

### Test Categories

1. **NULL-Based Detection** - Validates `hasRealMemorySessionId` logic
2. **Observation Storage** - Confirms observations use real `memorySessionId` values after registration
3. **Resume Safety** - Prevents `contentSessionId` and stale INIT sessions from being used for resume
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
// WRONG - Don't store observations before memorySessionId is available
storeObservation(session.contentSessionId, ...)
```

### ❌ Resuming without checking for NULL

```typescript
// WRONG - memorySessionId alone is not enough
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
// Only store after a real memorySessionId has been captured or synthesized
storeObservation(session.memorySessionId, project, obs, ...)
```

### ✅ Checking for real memory session ID

```typescript
const hasRealMemorySessionId = !!session.memorySessionId;
```

### ✅ Using resume parameter

```typescript
query({
  prompt: messageGenerator,
  options: {
    ...(
      hasRealMemorySessionId &&
      session.lastPromptNumber > 1 &&
      !session.forceInit &&
      { resume: session.memorySessionId }
    ),
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
- **Session Store**: `src/services/sqlite/SessionStore.ts`
- **Tests**: `tests/session_id_usage_validation.test.ts`
- **Related Tests**: `tests/session_id_refactor.test.ts`
