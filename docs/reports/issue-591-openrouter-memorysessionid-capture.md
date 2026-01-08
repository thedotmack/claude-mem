# Issue #591: OpenRouter Agent Fails to Capture memorySessionId for Empty Prompt History Sessions

**Report Date:** 2026-01-07
**Issue:** [#591](https://github.com/thedotmack/claude-mem/issues/591)
**Reporter:** cjdrilke
**Environment:** claude-mem 9.0.0, Provider: openrouter, Model: xiaomi/mimo-v2-flash:free, Platform: linux

---

## 1. Executive Summary

This issue describes a critical failure in the OpenRouter agent where it cannot store observations for sessions that have an empty prompt history (`prompt_counter = 0`). The error message "Cannot store observations: memorySessionId not yet captured" indicates that the `memorySessionId` is `null` when `processAgentResponse()` attempts to store observations.

**Key Finding:** Unlike the Claude SDK Agent which captures `memorySessionId` from SDK response messages, the OpenRouter Agent has **no mechanism to capture or generate a memorySessionId**. This is a fundamental architectural gap that causes all OpenRouter sessions to fail on their first observation.

**Severity:** Critical
**Priority:** P1
**Impact:** All new OpenRouter sessions fail to store observations

---

## 2. Problem Analysis

### 2.1 Error Manifestation

```
Error: Cannot store observations: memorySessionId not yet captured
```

This error originates from `ResponseProcessor.ts` line 73-75:

```typescript
// CRITICAL: Must use memorySessionId (not contentSessionId) for FK constraint
if (!session.memorySessionId) {
  throw new Error('Cannot store observations: memorySessionId not yet captured');
}
```

### 2.2 Affected Code Path

1. OpenRouter session starts via `OpenRouterAgent.startSession()`
2. Session is initialized with `memorySessionId: null`
3. OpenRouter API is queried and returns a response
4. `processAgentResponse()` is called with the response
5. **memorySessionId is still null** - no capture mechanism exists
6. Error thrown, observations not stored

### 2.3 Comparison with SDK Agent

The Claude SDK Agent successfully captures `memorySessionId` at `SDKAgent.ts` lines 120-141:

```typescript
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
```

**The OpenRouter Agent has no equivalent capture mechanism.**

---

## 3. Technical Details

### 3.1 Session ID Architecture

Claude-mem uses a dual session ID system (documented in `docs/SESSION_ID_ARCHITECTURE.md`):

| ID | Purpose | Source |
|----|---------|--------|
| `contentSessionId` | User's Claude Code conversation ID | Hook system |
| `memorySessionId` | Memory agent's internal session for resume | SDK response |

### 3.2 Session Initialization Flow

```
1. Hook creates session
   createSDKSession(contentSessionId, project, prompt)

   Database state:
   ├─ content_session_id: "user-session-123"
   └─ memory_session_id: NULL (not yet captured)

2. SessionManager.initializeSession() creates ActiveSession:
   session = {
     sessionDbId: number,
     contentSessionId: "user-session-123",
     memorySessionId: null,  // ← Critical: starts as null
     ...
   }
```

### 3.3 OpenRouter Response Format

OpenRouter uses an OpenAI-compatible API response format:

```typescript
interface OpenRouterResponse {
  choices?: Array<{
    message?: {
      role?: string;
      content?: string;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    message?: string;
    code?: string;
  };
}
```

**Critical Gap:** This response format does NOT include a `session_id` field. OpenRouter is a stateless API that does not maintain server-side session state.

### 3.4 Root Cause in OpenRouterAgent.ts

In `OpenRouterAgent.startSession()` (lines 85-133), the init response is processed:

```typescript
const initResponse = await this.queryOpenRouterMultiTurn(session.conversationHistory, apiKey, model, siteUrl, appName);

if (initResponse.content) {
  // Add response to conversation history
  session.conversationHistory.push({ role: 'assistant', content: initResponse.content });

  // ... token tracking ...

  // Process response using shared ResponseProcessor (no original timestamp for init - not from queue)
  await processAgentResponse(
    initResponse.content,
    session,  // ← memorySessionId is still null here
    this.dbManager,
    this.sessionManager,
    worker,
    tokensUsed,
    null,
    'OpenRouter',
    undefined
  );
}
```

**No memorySessionId capture occurs between session initialization and calling `processAgentResponse()`.**

---

## 4. Impact Assessment

### 4.1 Direct Impact

- **All OpenRouter sessions fail** when `prompt_counter = 0` (new sessions)
- No observations are stored for OpenRouter-based memory extraction
- Error prevents any memory from being captured via OpenRouter

### 4.2 Scope of Impact

| Affected | Not Affected |
|----------|--------------|
| All OpenRouter providers | Claude SDK Agent |
| All OpenRouter models | Gemini Agent (if implemented differently) |
| New sessions (prompt_counter = 0) | Potentially resumed sessions* |

*Note: Resumed sessions may work if they were previously processed by Claude SDK and have a captured `memorySessionId` from a fallback.

### 4.3 User Experience

Users configuring OpenRouter as their provider will:
1. See successful API calls to OpenRouter
2. Receive no stored observations
3. See error messages in logs about memorySessionId not captured
4. Have an empty memory database despite apparent processing

---

## 5. Root Cause Analysis

### 5.1 Primary Root Cause

**The OpenRouter Agent was implemented without a mechanism to generate or capture `memorySessionId`.**

Unlike the Claude SDK which returns a `session_id` in its response messages, OpenRouter's OpenAI-compatible API is stateless and does not provide session identifiers.

### 5.2 Contributing Factors

1. **Architectural Mismatch**: The `memorySessionId` concept was designed around the Claude SDK's session management, which OpenRouter does not have.

2. **Missing Initialization Logic**: Neither the OpenRouter agent nor the ResponseProcessor generates a `memorySessionId` when one is not provided by the API.

3. **Shared ResponseProcessor Assumption**: `ResponseProcessor.ts` assumes `memorySessionId` is always captured before it is called, which is true for Claude SDK but not for OpenRouter.

### 5.3 Why It Worked Before (Speculation)

This may have been masked if:
- OpenRouter fallback to Claude SDK triggered before the bug manifested
- Initial testing used existing sessions with previously captured `memorySessionId`
- The feature was added without comprehensive test coverage for new sessions

---

## 6. Recommended Solutions

### 6.1 Solution A: Generate memorySessionId for OpenRouter (Recommended)

Since OpenRouter is stateless, generate a unique `memorySessionId` when starting an OpenRouter session:

**Location:** `OpenRouterAgent.ts` in `startSession()` method, after session initialization

```typescript
async startSession(session: ActiveSession, worker?: WorkerRef): Promise<void> {
  try {
    // Generate memorySessionId for stateless providers (OpenRouter doesn't have session tracking)
    if (!session.memorySessionId) {
      const generatedMemorySessionId = `openrouter-${session.contentSessionId}-${Date.now()}`;
      session.memorySessionId = generatedMemorySessionId;

      // Persist to database
      this.dbManager.getSessionStore().updateMemorySessionId(
        session.sessionDbId,
        generatedMemorySessionId
      );

      logger.info('SESSION', `MEMORY_ID_GENERATED | sessionDbId=${session.sessionDbId} | memorySessionId=${generatedMemorySessionId} | provider=OpenRouter`, {
        sessionId: session.sessionDbId,
        memorySessionId: generatedMemorySessionId
      });
    }

    // ... rest of existing code ...
  }
}
```

**Pros:**
- Minimal code changes
- Follows existing patterns
- Works with stateless APIs
- Maintains FK integrity

**Cons:**
- Memory session ID format differs from Claude SDK
- No resume capability (OpenRouter is stateless anyway)

### 6.2 Solution B: Use contentSessionId as memorySessionId for Stateless Providers

For stateless providers, use the `contentSessionId` directly as the `memorySessionId`:

```typescript
if (!session.memorySessionId) {
  session.memorySessionId = session.contentSessionId;
  this.dbManager.getSessionStore().updateMemorySessionId(
    session.sessionDbId,
    session.contentSessionId
  );
}
```

**Pros:**
- Simpler approach
- No additional ID generation

**Cons:**
- Violates the architectural principle that memorySessionId should differ from contentSessionId
- Could cause issues with session isolation (see SESSION_ID_ARCHITECTURE.md warnings)

### 6.3 Solution C: Allow null memorySessionId with Auto-Generation in ResponseProcessor

Modify `ResponseProcessor.ts` to generate a `memorySessionId` if one is not present:

```typescript
// In processAgentResponse():
if (!session.memorySessionId) {
  const generatedId = `auto-${session.contentSessionId}-${Date.now()}`;
  session.memorySessionId = generatedId;
  // Persist to database
  dbManager.getSessionStore().updateMemorySessionId(session.sessionDbId, generatedId);
  logger.info('DB', `AUTO_GENERATED_MEMORY_ID | sessionDbId=${session.sessionDbId} | memorySessionId=${generatedId}`);
}
```

**Pros:**
- Works for any agent type
- Single point of fix

**Cons:**
- ResponseProcessor takes on responsibilities it shouldn't have
- Less explicit about provider behavior

### 6.4 Recommended Approach

**Solution A** is recommended because:
1. It explicitly handles the stateless nature of OpenRouter
2. It follows the existing pattern established by Claude SDK Agent
3. It keeps the memorySessionId generation in the agent where provider-specific logic belongs
4. It maintains clear separation of concerns

---

## 7. Priority/Severity Assessment

### 7.1 Severity Matrix

| Factor | Assessment |
|--------|------------|
| **Data Loss** | High - All observations lost for OpenRouter sessions |
| **Functionality** | Complete - OpenRouter provider is non-functional |
| **Workaround** | Exists - Use Claude SDK or Gemini providers |
| **Affected Users** | Subset - Only OpenRouter users |
| **Regression** | Unknown - May be present since OpenRouter was added |

### 7.2 Priority Assignment

**Priority: P1 (High)**

Rationale:
- Complete feature failure for affected configuration
- Users who choose OpenRouter are completely blocked
- Fix is straightforward with low regression risk

### 7.3 Recommended Timeline

| Action | Timeline |
|--------|----------|
| Hotfix development | 1-2 hours |
| Testing | 1 hour |
| Code review | 30 minutes |
| Release | Same day |

---

## 8. Testing Recommendations

### 8.1 Unit Tests to Add

```typescript
// tests/worker/openrouter-agent.test.ts

describe('OpenRouterAgent memorySessionId handling', () => {
  it('should generate memorySessionId when session has none', async () => {
    const session = createMockSession({
      memorySessionId: null,
      contentSessionId: 'test-content-123'
    });

    await openRouterAgent.startSession(session, mockWorker);

    expect(session.memorySessionId).not.toBeNull();
    expect(session.memorySessionId).toContain('openrouter-');
  });

  it('should persist generated memorySessionId to database', async () => {
    const session = createMockSession({ memorySessionId: null });

    await openRouterAgent.startSession(session, mockWorker);

    expect(mockDbManager.getSessionStore().updateMemorySessionId)
      .toHaveBeenCalledWith(session.sessionDbId, expect.any(String));
  });

  it('should not regenerate memorySessionId if already present', async () => {
    const existingId = 'existing-memory-id';
    const session = createMockSession({ memorySessionId: existingId });

    await openRouterAgent.startSession(session, mockWorker);

    expect(session.memorySessionId).toBe(existingId);
  });
});
```

### 8.2 Integration Tests to Add

```typescript
describe('OpenRouter end-to-end observation storage', () => {
  it('should successfully store observations for new OpenRouter sessions', async () => {
    // Create new session via hook
    const sessionDbId = createSDKSession(db, 'content-123', 'test-project', 'test prompt');

    // Initialize and start OpenRouter agent
    const session = sessionManager.initializeSession(sessionDbId);
    await openRouterAgent.startSession(session, mockWorker);

    // Verify observations were stored
    const observations = db.prepare('SELECT * FROM observations WHERE memory_session_id = ?')
      .all(session.memorySessionId);
    expect(observations.length).toBeGreaterThan(0);
  });
});
```

---

## 9. Related Files

| File | Relevance |
|------|-----------|
| `src/services/worker/OpenRouterAgent.ts` | Primary fix location |
| `src/services/worker/agents/ResponseProcessor.ts` | Error origin (line 73-75) |
| `src/services/worker/SessionManager.ts` | Session initialization |
| `src/services/worker/SDKAgent.ts` | Reference implementation for memorySessionId capture |
| `src/services/sqlite/sessions/create.ts` | Database session creation |
| `docs/SESSION_ID_ARCHITECTURE.md` | Architecture documentation |
| `tests/worker/agents/response-processor.test.ts` | Existing test coverage |

---

## 10. Conclusion

Issue #591 is a critical bug that renders the OpenRouter provider non-functional for new sessions. The root cause is a missing `memorySessionId` capture mechanism specific to stateless providers like OpenRouter.

The recommended fix is to generate a unique `memorySessionId` in `OpenRouterAgent.startSession()` before calling `processAgentResponse()`. This fix is straightforward, follows existing patterns, and carries low regression risk.

**Immediate Action Required:** Implement Solution A and release a hotfix.
