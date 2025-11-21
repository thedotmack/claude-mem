# Bug Report: Continuation Prompt Not Injected on Prompt #2+

**Status**: Fixed in `feature/endless-mode-beta-release`, needs merge to `main`
**Severity**: High - Affects all multi-prompt sessions
**Scope**: Core architecture bug, NOT endless-mode-specific
**Date**: 2025-01-20

---

## Summary

When a user submits multiple prompts in the same session (prompt #1, then prompt #2, etc.), the SDK memory agent continues using the **original prompt #1 context** instead of injecting fresh context for prompt #2. This causes:

- Mixed observations combining context from both prompts
- Observations generated with stale user request context
- "Duplicate-style" observations where the SDK seems confused about what it's tracking

---

## How to Reproduce

### Test Case: Two Prompts in One Session

**Prompt #1**: "Help me implement user authentication"
- SDK agent receives init prompt with "implement user authentication"
- Generator starts, processes tool uses
- Creates observations correctly

**Prompt #2**: "Now add rate limiting to the API"
- NEW user request: "add rate limiting"
- SDK agent SHOULD receive continuation prompt with NEW context
- BUT ACTUALLY: Generator keeps using prompt #1's "user authentication" context
- Creates observations that mix both prompts' contexts

### Expected Behavior

```
Prompt #1 → Init Prompt("implement user authentication") → Observations about auth
Prompt #2 → Continuation Prompt("add rate limiting") → Observations about rate limiting
```

### Actual Behavior (Bug)

```
Prompt #1 → Init Prompt("implement user authentication") → Observations about auth
Prompt #2 → (no continuation prompt injected) → Observations mixing auth + rate limiting
```

---

## Root Cause Analysis

### The Architecture

The SDK memory agent runs as a **persistent generator** that yields prompts to Claude:

1. **Prompt #1**: `new-hook` calls `/sessions/{id}/init` → Worker starts SDK generator
2. **Generator startup**: Yields ONE initial prompt (init or continuation)
3. **Generator loop**: Consumes message queue, yields observation/summary prompts
4. **Prompt #2**: `new-hook` calls `/sessions/{id}/init` again with NEW user prompt

### The Bug

The generator yields the initial prompt **ONLY ONCE** at startup:

```typescript
// SDKAgent.ts - createMessageGenerator
async *createMessageGenerator(session: ActiveSession) {
  // This runs ONCE when generator starts (prompt #1)
  yield {
    content: session.lastPromptNumber === 1
      ? buildInitPrompt(session.userPrompt)           // Used
      : buildContinuationPrompt(session.userPrompt)   // Never reached!
  };

  // Then loops forever yielding only observation/summarize
  for await (const message of queue) {
    if (message.type === 'observation') { yield observationPrompt; }
    else if (message.type === 'summarize') { yield summaryPrompt; }
    // No handling for continuation messages!
  }
}
```

**Problem**: The continuation prompt code exists but is **unreachable** because:
- Generator starts on prompt #1, so `lastPromptNumber` is 1
- When prompt #2 arrives, generator is already running
- The initial yield never re-executes

### Why This Fails

```
Prompt #1:
  ├─ new-hook calls /init → sessionDbId=123, promptNumber=1
  ├─ worker-service.handleSessionInit → initializeSession(123, "auth prompt", 1)
  ├─ session.lastPromptNumber = 1
  ├─ Start generator → yields buildInitPrompt("auth prompt")
  └─ Generator enters loop, processing observations...

Prompt #2:
  ├─ new-hook calls /init → sessionDbId=123, promptNumber=2
  ├─ worker-service.handleSessionInit → initializeSession(123, "rate limit prompt", 2)
  ├─ session.userPrompt updated to "rate limit prompt"
  ├─ session.lastPromptNumber updated to 2
  ├─ BUT generator is already running from prompt #1!
  ├─ Generator NEVER re-yields initial prompt
  └─ Continues with OLD context from prompt #1
```

---

## The Fix

### Changes Required (4 files)

#### 1. **worker-types.ts**: Add `'continuation'` message type

```typescript
export interface PendingMessage {
  type: 'observation' | 'summarize' | 'continuation';  // Added 'continuation'
  // ... existing fields
  user_prompt?: string; // For continuation messages
}
```

#### 2. **SessionManager.ts**: Add `queueContinuation()` method

```typescript
queueContinuation(sessionDbId: number, userPrompt: string, promptNumber: number): void {
  const session = this.sessions.get(sessionDbId);
  if (!session) {
    throw new Error(`Cannot queue continuation for non-existent session ${sessionDbId}`);
  }

  session.pendingMessages.push({
    type: 'continuation',
    user_prompt: userPrompt,
    prompt_number: promptNumber
  });

  const emitter = this.sessionQueues.get(sessionDbId);
  emitter?.emit('message');
}
```

#### 3. **worker-service.ts**: Detect existing sessions and queue continuation

```typescript
private handleSessionInit(req: Request, res: Response): void {
  const sessionDbId = parseInt(req.params.sessionDbId, 10);
  const { userPrompt, promptNumber } = req.body;

  // Check if session already exists (prompt #2+)
  const existingSession = this.sessionManager.getSession(sessionDbId);
  const isNewSession = !existingSession;

  const session = this.sessionManager.initializeSession(sessionDbId, userPrompt, promptNumber);

  // ... (Chroma sync, SSE broadcasts, etc.)

  // For prompt #2+: queue continuation message instead of starting new generator
  if (!isNewSession) {
    this.sessionManager.queueContinuation(sessionDbId, userPrompt, promptNumber);
    res.json({ status: 'continuation_queued', sessionDbId, port: getWorkerPort() });
    return;
  }

  // For prompt #1: Start SDK agent
  session.generatorPromise = this.sdkAgent.startSession(session, this);
  res.json({ status: 'initialized', sessionDbId, port: getWorkerPort() });
}
```

#### 4. **SDKAgent.ts**: Handle continuation messages in generator loop

```typescript
async *createMessageGenerator(session: ActiveSession) {
  // Yield initial prompt (prompt #1)
  yield {
    content: session.lastPromptNumber === 1
      ? buildInitPrompt(session.userPrompt)
      : buildContinuationPrompt(session.userPrompt) // Still unreachable, but kept for safety
  };

  // Loop: now handles continuation messages!
  for await (const message of this.sessionManager.getMessageIterator(session.sessionDbId)) {
    if (message.type === 'continuation') {
      // Update session state
      if (message.prompt_number !== undefined) {
        session.lastPromptNumber = message.prompt_number;
      }
      if (message.user_prompt) {
        session.userPrompt = message.user_prompt;
      }

      // Yield continuation prompt to inject new context
      yield {
        type: 'user',
        message: {
          role: 'user',
          content: buildContinuationPrompt(
            session.userPrompt,
            session.lastPromptNumber,
            session.claudeSessionId,
            observeEverything
          )
        },
        session_id: session.claudeSessionId,
        parent_tool_use_id: null,
        isSynthetic: true
      };
    }
    else if (message.type === 'observation') { /* ... */ }
    else if (message.type === 'summarize') { /* ... */ }
  }
}
```

---

## Verification Steps

### Test in a Fresh Session

1. **Start new session** (prompt #1):
   ```
   User: "Help me implement user authentication"
   ```
   - Check worker logs: Should see "Generator starting (new session)"
   - SDK agent receives init prompt with "user authentication"

2. **Continue session** (prompt #2):
   ```
   User: "Now add rate limiting"
   ```
   - Check worker logs: Should see "Queueing continuation (existing session)"
   - SDK agent should receive continuation prompt with "add rate limiting"
   - Observations should ONLY reference rate limiting, NOT authentication

3. **Verify observations**:
   - Prompt #1 observations: About authentication
   - Prompt #2 observations: About rate limiting (NO mixed context)

### Log Output to Look For

**Prompt #1** (new session):
```
[SESSION] Generator starting (new session) { sessionId: 123, promptNum: 1 }
[SDK] Response received { sessionId: 123, promptNumber: 1 }
```

**Prompt #2** (continuation):
```
[SessionManager] Updating userPrompt for continuation { sessionDbId: 123, promptNumber: 2 }
[SESSION] Queueing continuation (existing session) { sessionId: 123, promptNum: 2 }
[SESSION] Continuation queued (0→1) { sessionId: 123, promptNumber: 2 }
[SDK] Response received { sessionId: 123, promptNumber: 2 }
```

### What NOT to See (Bug Symptoms)

- ❌ "Generator starting" on prompt #2 (should only start once)
- ❌ Observations on prompt #2 that reference prompt #1's user request
- ❌ Mixed observations combining both prompts' contexts

---

## Affected Code Paths

### Main Branch: YES (Bug Exists)
- `worker-service.ts`: No check for existing sessions
- `worker-types.ts`: No `'continuation'` message type
- `SDKAgent.ts`: Continuation prompt code unreachable

### feature/endless-mode-beta-release: FIXED
- All 4 files updated with fix
- Bug no longer exists

### Non-Endless-Mode: YES (Bug Exists)
- This is NOT an endless-mode bug
- Affects ALL multi-prompt sessions
- Endless mode just made it more visible

---

## Recommendation

**Merge this fix to `main` immediately.**

This is a critical bug affecting core functionality:
- Breaks multi-prompt sessions (common usage pattern)
- Causes context confusion in memory agent
- Results in incorrect/mixed observations
- NOT specific to endless mode - affects everyone

---

## Additional Notes

### Why This Bug Wasn't Caught Earlier

1. **Single-prompt sessions work fine**: Most testing focuses on one prompt per session
2. **Subtle symptoms**: Mixed context isn't immediately obvious without careful observation inspection
3. **Continuation prompt code exists**: The presence of `buildContinuationPrompt` suggested the feature worked

### Why Endless Mode Exposed It

Endless mode creates observations for EVERY tool use, making the mixed context much more visible. Without endless mode, the SDK might skip some observations, hiding the problem.

### Related Issue: WHEN TO SKIP Section

Secondary issue found during investigation: `buildContinuationPrompt` was missing the "WHEN TO SKIP" guidance when `observeEverything=false`. This was also fixed by adding the same ternary logic as `buildInitPrompt`.

---

## Files Changed

1. `src/services/worker-types.ts` - Added 'continuation' to PendingMessage type
2. `src/services/worker/SessionManager.ts` - Added queueContinuation() method
3. `src/services/worker-service.ts` - Modified handleSessionInit to detect existing sessions
4. `src/sdk/prompts.ts` - Added WHEN TO SKIP section to buildContinuationPrompt
5. `src/services/worker/SDKAgent.ts` - Handle continuation messages in generator loop

---

## Testing Checklist

- [ ] Fresh session (prompt #1) → Init prompt works
- [ ] Continuation (prompt #2) → Continuation prompt injected
- [ ] Observations isolated per prompt (no mixed context)
- [ ] Worker logs show "Queueing continuation" on prompt #2
- [ ] Generator only starts once per session
- [ ] Session state (userPrompt, lastPromptNumber) updates correctly
- [ ] Works with endless mode enabled
- [ ] Works with endless mode disabled
