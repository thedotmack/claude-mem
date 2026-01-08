# Issue #586: Race Condition in memory_session_id Capture

**Report Date:** 2026-01-07
**Issue:** [#586](https://github.com/thedotmack/claude-mem/issues/586)
**Reporter:** rocky2431
**Environment:** claude-mem 9.0.0, macOS Darwin 24.6.0, Node v22.x / Bun 1.x

---

## 1. Executive Summary

This issue describes a critical race condition where new sessions frequently have an empty (NULL) `memory_session_id` in the `sdk_sessions` table. This prevents observations from being stored, as the `ResponseProcessor` requires a valid `memorySessionId` before processing agent responses.

**Key Finding:** The race condition occurs because session initialization via `handleSessionInitByClaudeId()` creates the session with a NULL `memory_session_id`, but the SDK agent may not have responded yet to provide its session ID when subsequent `PostToolUse` hooks attempt to store observations.

**Error Message:**
```
Cannot store observations: memorySessionId not yet captured
```

**Severity:** Critical
**Priority:** P1
**Impact:** Sessions with NULL `memory_session_id` cannot store any observations, leading to data loss and incomplete session history.

---

## 2. Problem Analysis

### 2.1 Error Manifestation

The error originates from `ResponseProcessor.ts` (line 73-75):

```typescript
// CRITICAL: Must use memorySessionId (not contentSessionId) for FK constraint
if (!session.memorySessionId) {
  throw new Error('Cannot store observations: memorySessionId not yet captured');
}
```

### 2.2 Observed Symptoms

1. **Log Evidence:**
   ```log
   [2026-01-07 04:02:39.872] [INFO ] [SESSION] [session-14379] Session initialized
   {project=claude-task-master, contentSessionId=a48d7f90-27e4-4a1d-b379-bf2195ee333e,
   queueDepth=0, hasGenerator=false}
   ```
   Note: `contentSessionId` is present but `memorySessionId` is missing.

2. **Database State:**
   ```sql
   SELECT id, memory_session_id, project FROM sdk_sessions ORDER BY id DESC LIMIT 5;

   14379 | (NULL) | claude-task-master   -- Missing!
   14293 | 090b5397-... | .claude        -- OK
   14285 | (NULL) | .claude              -- Missing!
   ```

3. **Queue Accumulation:**
   - Observations are enqueued to `pending_messages` table
   - Hundreds of unprocessed items accumulate
   - Only user prompts are recorded, no AI analysis

### 2.3 Race Condition Timeline

```
Time T0: SessionStart hook triggers
         └─> new-hook.ts calls /api/sessions/init
             └─> createSDKSession() creates row with memory_session_id = NULL

Time T1: PostToolUse hook triggers (user action)
         └─> save-hook.ts calls /api/sessions/observations
             └─> Observation queued to pending_messages

Time T2: SDK Agent generator starts
         └─> Waiting for first message from Claude SDK

Time T3: First SDK message arrives (RACE CONDITION WINDOW)
         └─> updateMemorySessionId() called with captured ID
         └─> Database updated: memory_session_id = "sdk-gen-abc123"

Time T4: SDK Agent attempts to process queued observations
         └─> processAgentResponse() checks session.memorySessionId
         └─> If NULL (not yet updated): ERROR thrown
```

**The Problem:** If `PostToolUse` events arrive during the window between session creation (T0) and SDK session ID capture (T3), the `ResponseProcessor` will fail because `memorySessionId` is still NULL.

---

## 3. Technical Details

### 3.1 Session ID Architecture

Claude-mem uses a dual session ID system (documented in `docs/SESSION_ID_ARCHITECTURE.md`):

| ID | Purpose | Source | Initial Value |
|----|---------|--------|---------------|
| `contentSessionId` | User's Claude Code conversation ID | Hook system | Set immediately |
| `memorySessionId` | Memory agent's internal session ID | SDK response | NULL (captured later) |

### 3.2 Session Creation Flow

**File:** `src/services/sqlite/sessions/create.ts` (lines 24-47)

```typescript
export function createSDKSession(
  db: Database,
  contentSessionId: string,
  project: string,
  userPrompt: string
): number {
  // Pure INSERT OR IGNORE - no updates, no complexity
  // NOTE: memory_session_id starts as NULL. It is captured by SDKAgent from the first SDK
  // response and stored via updateMemorySessionId(). CRITICAL: memory_session_id must NEVER
  // equal contentSessionId - that would inject memory messages into the user's transcript!
  db.prepare(`
    INSERT OR IGNORE INTO sdk_sessions
    (content_session_id, memory_session_id, project, user_prompt, started_at, started_at_epoch, status)
    VALUES (?, NULL, ?, ?, ?, ?, 'active')
  `).run(contentSessionId, project, userPrompt, now.toISOString(), nowEpoch);
  // ...
}
```

### 3.3 Memory Session ID Capture

**File:** `src/services/worker/SDKAgent.ts` (lines 117-141)

```typescript
// Process SDK messages
for await (const message of queryResult) {
  // Capture memory session ID from first SDK message (any type has session_id)
  if (!session.memorySessionId && message.session_id) {
    session.memorySessionId = message.session_id;
    // Persist to database for cross-restart recovery
    this.dbManager.getSessionStore().updateMemorySessionId(
      session.sessionDbId,
      message.session_id
    );
    // ... verification logging ...
  }
  // ...
}
```

### 3.4 Response Processor Validation

**File:** `src/services/worker/agents/ResponseProcessor.ts` (lines 72-75)

```typescript
// CRITICAL: Must use memorySessionId (not contentSessionId) for FK constraint
if (!session.memorySessionId) {
  throw new Error('Cannot store observations: memorySessionId not yet captured');
}
```

### 3.5 Session Manager Initialization

**File:** `src/services/worker/SessionManager.ts` (lines 127-143)

```typescript
// Create active session
// Load memorySessionId from database if previously captured (enables resume across restarts)
session = {
  sessionDbId,
  contentSessionId: dbSession.content_session_id,
  memorySessionId: dbSession.memory_session_id || null,  // NULL initially!
  // ...
};
```

---

## 4. Impact Assessment

### 4.1 Direct Impact

| Impact Area | Description |
|------------|-------------|
| **Data Loss** | Observations queued during race window are never stored |
| **Queue Growth** | `pending_messages` table grows unbounded |
| **User Experience** | Session history incomplete - only prompts, no analysis |
| **System Load** | Repeated retry attempts consume resources |

### 4.2 Frequency

The issue appears **intermittent** - some sessions initialize correctly while others fail. The race condition depends on:
- System load
- Claude SDK response latency
- Hook timing relative to SDK startup

### 4.3 Related Issues

- **Issue #520** (CLOSED): Stuck messages in 'processing' status - similar queue recovery problem
- **Issue #591**: OpenRouter Agent fails to capture memorySessionId - architectural gap for stateless providers

---

## 5. Root Cause Analysis

### 5.1 Primary Root Cause

**Architectural Timing Gap:** The session initialization API (`/api/sessions/init`) creates sessions with a NULL `memory_session_id`, expecting the SDK agent to capture it from the first response. However, there is no synchronization mechanism to prevent observation processing before this capture occurs.

### 5.2 Contributing Factors

1. **Asynchronous SDK Agent Startup:** The generator starts asynchronously without blocking the hook response
2. **No Capture Wait Mechanism:** Observations are queued immediately without waiting for memorySessionId capture
3. **Strict Validation in ResponseProcessor:** The processor throws an error rather than handling the NULL case gracefully
4. **No Retry Logic:** Failed observations due to missing memorySessionId are not retried after capture

### 5.3 Timing Window Analysis

```
Hook Execution Timeline:
├─ new-hook.ts (UserPromptSubmit)
│   ├─ POST /api/sessions/init → createSDKSession(memory_session_id=NULL)
│   └─ POST /sessions/{id}/init → startSession() [async, non-blocking]
│
├─ [RACE CONDITION WINDOW OPENS]
│   └─ SDK agent waiting for Claude response
│
├─ save-hook.ts (PostToolUse) ← CAN TRIGGER DURING WINDOW
│   └─ POST /api/sessions/observations
│       └─ Queued, will fail when processed
│
├─ [SDK FIRST MESSAGE ARRIVES]
│   └─ updateMemorySessionId(captured_id)
│       └─ Database updated, session.memorySessionId set
│
├─ [RACE CONDITION WINDOW CLOSES]
│
└─ Subsequent observations process successfully
```

---

## 6. Recommended Solutions

### 6.1 Solution A: Retry Mechanism in ResponseProcessor (Recommended)

If `memorySessionId` is not available, wait briefly with exponential backoff:

```typescript
// In processAgentResponse():
async function waitForMemorySessionId(
  session: ActiveSession,
  dbManager: DatabaseManager,
  maxRetries: number = 5,
  baseDelayMs: number = 100
): Promise<boolean> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (session.memorySessionId) return true;

    // Check database for updates
    const dbSession = dbManager.getSessionById(session.sessionDbId);
    if (dbSession?.memory_session_id) {
      session.memorySessionId = dbSession.memory_session_id;
      return true;
    }

    await new Promise(resolve => setTimeout(resolve, baseDelayMs * Math.pow(2, attempt)));
  }
  return false;
}

// Usage:
const captured = await waitForMemorySessionId(session, dbManager);
if (!captured) {
  throw new Error('Cannot store observations: memorySessionId not yet captured after retries');
}
```

**Pros:**
- Non-breaking change
- Handles timing variations gracefully
- Minimal code modification

**Cons:**
- Adds latency in worst case
- Polling-based solution

### 6.2 Solution B: Lazy Capture on First PostToolUse

Capture `memorySessionId` on the first `PostToolUse` if not already set:

```typescript
// In handleObservationsByClaudeId():
if (!session.memorySessionId && session.contentSessionId) {
  // Generate a placeholder that will be updated when SDK responds
  const tempId = `pending-${session.contentSessionId}`;
  session.memorySessionId = tempId;
  store.updateMemorySessionId(sessionDbId, tempId);
  logger.warn('SESSION', 'Generated temporary memorySessionId', { tempId });
}
```

**Pros:**
- Immediate resolution
- No retry delays

**Cons:**
- Temporary IDs may cause confusion
- Requires updating when real ID is captured

### 6.3 Solution C: Use contentSessionId as Fallback

For initial observations before SDK capture, use `contentSessionId`:

```typescript
// In processAgentResponse():
const effectiveMemorySessionId = session.memorySessionId || session.contentSessionId;
```

**Pros:**
- Simple implementation
- No timing issues

**Cons:**
- **Violates architectural principle** that memorySessionId should differ from contentSessionId
- Risk of FK constraint issues
- May cause resume problems

### 6.4 Solution D: Block Until memorySessionId is Captured

Modify `handleObservationsByClaudeId` to wait for SDK capture:

```typescript
// In handleObservationsByClaudeId():
const session = this.sessionManager.getSession(sessionDbId);
if (!session?.memorySessionId) {
  // Return a "pending" response, client should retry
  res.status(202).json({
    status: 'pending',
    reason: 'awaiting_memory_session_id',
    retryAfterMs: 500
  });
  return;
}
```

**Pros:**
- Explicit handling
- Client-controlled retry

**Cons:**
- Requires hook changes
- May cause hook timeout

### 6.5 Recommended Approach

**Solution A** is recommended because:
1. Handles the race condition transparently
2. Minimal impact on existing code
3. Self-healing behavior (retries until successful)
4. Maintains architectural integrity
5. Low regression risk

---

## 7. Priority/Severity Assessment

### 7.1 Severity Matrix

| Factor | Assessment |
|--------|------------|
| **Data Loss** | High - Observations lost during race window |
| **Functionality** | Partial - Some sessions work, some don't |
| **Frequency** | Intermittent - Depends on system timing |
| **Workaround** | Manual SQL fix available |
| **Affected Users** | All users under specific timing conditions |

### 7.2 Priority Assignment

**Priority: P1 (High)**

Rationale:
- Silent data loss is occurring
- Affects core functionality (observation storage)
- Unpredictable - users may not know data is being lost
- Fix is straightforward with low regression risk

### 7.3 Recommended Timeline

| Action | Timeline |
|--------|----------|
| Implement Solution A | 2-4 hours |
| Unit tests | 1 hour |
| Integration tests | 1 hour |
| Code review | 30 minutes |
| Release | Same day |

---

## 8. Workaround

Users experiencing this issue can manually fix affected sessions:

```sql
-- Find sessions with missing memory_session_id
SELECT id, content_session_id, project
FROM sdk_sessions
WHERE memory_session_id IS NULL;

-- Option 1: Use content_session_id as memory_session_id (not recommended)
-- WARNING: May cause issues with session resume
UPDATE sdk_sessions
SET memory_session_id = content_session_id
WHERE id = <sessionDbId> AND memory_session_id IS NULL;

-- Option 2: Generate a unique ID
UPDATE sdk_sessions
SET memory_session_id = 'manual-' || content_session_id
WHERE id = <sessionDbId> AND memory_session_id IS NULL;
```

**Important:** After applying the workaround, the worker must be restarted to pick up the new `memory_session_id` values.

---

## 9. Testing Recommendations

### 9.1 Unit Tests

```typescript
describe('ResponseProcessor memorySessionId handling', () => {
  it('should wait for memorySessionId capture with retry', async () => {
    const session = createMockSession({ memorySessionId: null });

    // Simulate delayed capture
    setTimeout(() => {
      session.memorySessionId = 'captured-id';
    }, 200);

    await expect(
      processAgentResponse(text, session, dbManager, sessionManager, worker, 0, null, 'Test')
    ).resolves.not.toThrow();
  });

  it('should throw after max retries if memorySessionId never captured', async () => {
    const session = createMockSession({ memorySessionId: null });

    await expect(
      processAgentResponse(text, session, dbManager, sessionManager, worker, 0, null, 'Test')
    ).rejects.toThrow('memorySessionId not yet captured after retries');
  });
});
```

### 9.2 Integration Tests

```typescript
describe('Session initialization race condition', () => {
  it('should handle rapid PostToolUse events during SDK startup', async () => {
    // Create session
    const sessionDbId = store.createSDKSession(contentSessionId, project, prompt);

    // Immediately queue observations (before SDK responds)
    for (let i = 0; i < 5; i++) {
      sessionManager.queueObservation(sessionDbId, {
        tool_name: 'Read',
        tool_input: { file_path: '/test.txt' },
        tool_response: { content: 'test' },
        prompt_number: 1,
        cwd: '/test'
      });
    }

    // Start SDK agent (will capture memorySessionId)
    await sdkAgent.startSession(session, worker);

    // Verify all observations were stored
    const stored = db.prepare('SELECT COUNT(*) as count FROM observations WHERE memory_session_id = ?')
      .get(session.memorySessionId);
    expect(stored.count).toBeGreaterThanOrEqual(5);
  });
});
```

---

## 10. Related Files

| File | Relevance |
|------|-----------|
| `src/services/worker/agents/ResponseProcessor.ts` | Error origin (line 73-75), primary fix location |
| `src/services/worker/SessionManager.ts` | Session initialization with NULL memorySessionId |
| `src/services/worker/SDKAgent.ts` | memorySessionId capture logic |
| `src/services/sqlite/sessions/create.ts` | Session creation with NULL memory_session_id |
| `src/hooks/new-hook.ts` | Session initialization hook |
| `src/hooks/save-hook.ts` | PostToolUse observation queueing |
| `docs/SESSION_ID_ARCHITECTURE.md` | Architecture documentation |

---

## 11. Conclusion

Issue #586 describes a critical race condition in the session initialization process where `memory_session_id` is not captured before observations are processed. This results in silent data loss as observations fail to store with the error "Cannot store observations: memorySessionId not yet captured".

The recommended fix is to implement a retry mechanism in `ResponseProcessor.processAgentResponse()` that waits for the `memorySessionId` to be captured, with exponential backoff. This approach:
- Maintains the existing architectural integrity
- Handles timing variations gracefully
- Has low regression risk
- Is straightforward to implement and test

**Immediate Action Required:** Implement Solution A (Retry Mechanism) and release a hotfix to prevent ongoing data loss.
