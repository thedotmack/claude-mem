# Technical Report: Issue #587 - Observations Not Being Stored

**Issue:** v9.0.0: Observations not being stored - SDK agent stuck on 'Awaiting tool execution data'
**Author:** chuck-boudreau
**Created:** 2026-01-07
**Report Date:** 2026-01-07
**Status:** Open
**Affected Version:** 9.0.0
**Environment:** macOS (Darwin 25.1.0)

---

## 1. Executive Summary

After upgrading to claude-mem v9.0.0, users report that observations are not being stored in the database. The SDK agent responds with "Ready to observe. Awaiting tool execution data from the primary session" instead of processing tool calls and generating observations. Investigation reveals a **two-part failure mode**:

1. **Primary Issue:** The SDK agent receives tool execution data but fails to process it into observations, returning a generic "awaiting data" message despite receiving valid input.

2. **Secondary Issue (Resolved):** A version mismatch between plugin (9.0.0) and worker (8.5.9) was causing an infinite restart loop, which was fixed in commit `e22e2bfc`. However, **even after resolving the restart loop, the observation storage issue persists**.

This report analyzes both issues, identifies potential root causes, and proposes solutions.

---

## 2. Problem Analysis

### 2.1 Symptom Description

The user reports the following behavior after upgrading to v9.0.0:

```
[INFO ] [SDK   ] [session-1] <- Response received (72 chars) {promptNumber=57} Ready to observe. Awaiting tool execution data from the primary session.
[INFO ] [DB    ] [session-1] STORED | sessionDbId=1 | memorySessionId=xxx | obsCount=0 | obsIds=[] | summaryId=none
```

Key observations:
- The SDK agent is starting correctly (`Generator auto-starting`)
- Tool executions are being received (`PostToolUse: Bash(cat ~/.claude-mem/settings.json)`)
- Messages are being queued (`ENQUEUED | messageId=596 | type=observation`)
- Messages are being claimed by the agent (`CLAIMED | messageId=596`)
- **BUT:** The agent returns "Ready to observe. Awaiting tool execution data" instead of actual observations
- Result: `obsCount=0` persists across all tool calls

### 2.2 Version Mismatch Issue (Resolved)

The user also encountered a version mismatch causing infinite restarts:

```
[INFO ] [SYSTEM] Worker version mismatch detected - auto-restarting {pluginVersion=9.0.0, workerVersion=8.5.9}
```

**Resolution:** This issue was fixed in commit `e22e2bfc` (PR #567) by:
1. Updating `plugin/package.json` from 8.5.10 to 9.0.0
2. Rebuilding all hooks and worker service with correct version injection
3. Adding version consistency tests

However, the user reports that **even after resolving the restart loop, observations still weren't being created**.

---

## 3. Technical Details

### 3.1 Architecture Overview

The claude-mem observation pipeline works as follows:

```
User Session -> PostToolUse Hook -> Worker HTTP API -> Session Queue -> SDK Agent -> Database
                (save-hook.ts)     (/api/sessions/     (SessionManager)  (SDKAgent.ts)
                                    observations)
```

### 3.2 SDK Agent Prompt System

The SDK agent uses a mode-based prompt system loaded from `/plugin/modes/code.json`:

1. **Initial Prompt (`buildInitPrompt`)**: Full initialization with system identity, observer role, recording focus
2. **Continuation Prompt (`buildContinuationPrompt`)**: For subsequent tool observations in the same session
3. **Observation Prompt (`buildObservationPrompt`)**: Wraps tool execution data in XML format

**Key files:**
- `/src/services/worker/SDKAgent.ts` - Agent implementation (lines 100-213)
- `/src/sdk/prompts.ts` - Prompt building functions (lines 29-235)
- `/plugin/modes/code.json` - Mode configuration with prompt templates

### 3.3 Message Flow Analysis

From the logs, the flow appears correct up to SDK query:

```
1. PostToolUse hook fires -> /api/sessions/observations
2. SessionManager.queueObservation() persists to PendingMessageStore
3. EventEmitter notifies SDK agent
4. SDK agent yields observation prompt to Claude SDK
5. Claude SDK returns response -> "Ready to observe. Awaiting tool execution data"
6. No observations parsed -> obsCount=0
```

### 3.4 Suspicious Log Entry

```
promptType=CONTINUATION
lastPromptNumber=57
```

The `promptNumber=57` suggests this is a continuation of an existing session, not a fresh start. The `CONTINUATION` prompt type is used when `session.lastPromptNumber > 1`.

**Potential Issue:** If the SDK session context was lost (e.g., due to the restart loop), the `memorySessionId` may be stale, but the system is attempting to resume a session that no longer exists in the Claude SDK's context.

### 3.5 Code Analysis: Resume Logic

From `SDKAgent.ts` (lines 71-114):

```typescript
// CRITICAL: Only resume if:
// 1. memorySessionId exists (was captured from a previous SDK response)
// 2. lastPromptNumber > 1 (this is a continuation within the same SDK session)
// On worker restart or crash recovery, memorySessionId may exist from a previous
// SDK session but we must NOT resume because the SDK context was lost.

const hasRealMemorySessionId = !!session.memorySessionId;

const queryResult = query({
  prompt: messageGenerator,
  options: {
    model: modelId,
    // Only resume if BOTH: (1) we have a memorySessionId AND (2) this isn't the first prompt
    ...(hasRealMemorySessionId && session.lastPromptNumber > 1 && { resume: session.memorySessionId }),
    // ...
  }
});
```

**Critical Finding:** The code attempts to resume the SDK session if `memorySessionId` exists AND `lastPromptNumber > 1`. However, if the worker restarted (due to version mismatch), the SDK context is lost but the `memorySessionId` may still exist in the database from a previous session.

The code at lines 92-98 attempts to detect this:
```typescript
// INIT prompt - never resume even if memorySessionId exists (stale from previous session)
if (hasStaleMemoryId) {
  logger.warn('SDK', `Skipping resume for INIT prompt despite existing memorySessionId=${session.memorySessionId} - SDK context was lost (worker restart or crash recovery)`);
}
```

But this only applies when `lastPromptNumber === 1`. If `lastPromptNumber > 1`, the code still attempts to resume with a potentially stale `memorySessionId`.

---

## 4. Impact Assessment

### 4.1 Severity: **Critical**

- **Data Loss:** Observations are not being persisted, resulting in complete loss of session memory
- **Core Functionality Broken:** The primary purpose of claude-mem (persistent memory) is non-functional
- **User Experience:** Users see no value from the plugin after upgrade

### 4.2 Scope

- **Affected Users:** All users who upgraded to v9.0.0 and had existing sessions
- **Trigger Condition:** Appears to occur when:
  1. Worker restarts (due to version mismatch or other reasons)
  2. Session has existing `memorySessionId` in database
  3. Session has `lastPromptNumber > 1`

### 4.3 Workaround

Users can work around by:
1. Clearing the database: `rm ~/.claude-mem/claude-mem.db`
2. Starting fresh sessions

However, this results in loss of all historical observations.

---

## 5. Root Cause Analysis

### 5.1 Primary Hypothesis: Stale Session Resume

**Root Cause:** The SDK agent attempts to resume a session using a `memorySessionId` that no longer exists in the Claude SDK's context (because the SDK process was terminated during the restart loop).

**Evidence:**
1. `promptNumber=57` suggests continuation of existing session
2. `promptType=CONTINUATION` indicates resume path is being taken
3. The response "Ready to observe. Awaiting tool execution data" suggests the SDK received a continuation prompt without the necessary context

**Code Path:**
1. Worker restarts due to version mismatch
2. Session is reloaded from database with `memory_session_id` and `lastPromptNumber=57`
3. `SDKAgent.startSession()` evaluates `hasRealMemorySessionId=true` and `lastPromptNumber > 1`
4. Adds `resume: memorySessionId` to query options
5. Claude SDK attempts to resume non-existent session
6. Claude SDK responds with generic "awaiting data" message instead of processing observations

### 5.2 Secondary Hypothesis: Prompt Format Issue

The SDK agent might not be receiving the observation data in the expected format. The `buildObservationPrompt` function formats tool data as:

```xml
<observed_from_primary_session>
  <what_happened>Bash</what_happened>
  <occurred_at>2026-01-07T...</occurred_at>
  <parameters>...</parameters>
  <outcome>...</outcome>
</observed_from_primary_session>
```

If the Claude model doesn't recognize this as actionable tool data (expecting a different format), it might respond with the generic message.

### 5.3 Tertiary Hypothesis: Mode Configuration Issue

The mode system loads configuration from `/plugin/modes/code.json`. If the mode fails to load or loads incorrectly, the prompts may be malformed.

From `ModeManager.ts`:
```typescript
loadMode(modeId: string): ModeConfig {
  // Falls back to 'code' if mode not found
  // Throws only if 'code.json' is missing
}
```

---

## 6. Recommended Solutions

### 6.1 Immediate Fix: Invalidate Stale Session IDs on Worker Restart

**Priority:** Critical
**Effort:** Low
**File:** `src/services/worker/SDKAgent.ts`

Add detection for worker restart scenarios and invalidate stale `memorySessionId`:

```typescript
// Before starting SDK query, check if this is a recovery scenario
// If worker restarted but session was mid-flight, the SDK context is lost
// We should start fresh instead of attempting to resume
if (session.memorySessionId && !isWorkerSameProcess(session.memorySessionId)) {
  logger.warn('SDK', 'Invalidating stale memorySessionId due to worker restart', {
    sessionDbId: session.sessionDbId,
    staleMemorySessionId: session.memorySessionId
  });
  session.memorySessionId = null;
  this.dbManager.getSessionStore().updateMemorySessionId(session.sessionDbId, null);
}
```

### 6.2 Short-Term Fix: Add Resume Validation

**Priority:** High
**Effort:** Medium
**File:** `src/services/worker/SDKAgent.ts`

Before attempting resume, validate that the session exists in the SDK:

```typescript
// Validate memorySessionId before attempting resume
if (hasRealMemorySessionId && session.lastPromptNumber > 1) {
  const isValidSession = await this.validateSDKSession(session.memorySessionId);
  if (!isValidSession) {
    logger.warn('SDK', 'memorySessionId no longer valid, starting fresh', {
      sessionDbId: session.sessionDbId,
      invalidMemorySessionId: session.memorySessionId
    });
    session.memorySessionId = null;
    session.lastPromptNumber = 1; // Reset to trigger INIT prompt
  }
}
```

### 6.3 Long-Term Fix: Add Worker Instance Tracking

**Priority:** Medium
**Effort:** High
**Files:** Multiple

Track worker instance ID in the database to detect restart scenarios:

1. Generate unique worker instance ID on startup
2. Store with each session's `memorySessionId`
3. On session load, compare worker instance ID
4. If mismatch, invalidate `memorySessionId` and restart fresh

### 6.4 Additional Recommendations

1. **Add diagnostic logging:** Log the full prompt being sent to SDK for debugging
2. **Add retry logic:** If SDK returns generic response, retry with INIT prompt
3. **Add health check:** Validate SDK session state before processing observations
4. **Update VERSION_FIX.md:** Document the observation storage issue as a related symptom

---

## 7. Priority/Severity Assessment

| Aspect | Rating | Justification |
|--------|--------|---------------|
| **Severity** | Critical | Core functionality completely broken |
| **Impact** | High | All v9.0.0 users with existing sessions affected |
| **Urgency** | High | Users currently losing all observation data |
| **Complexity** | Medium | Root cause identified, fix is localized |
| **Risk** | Low | Fix is additive, doesn't change happy path |

### Recommended Priority: **P0 - Critical**

This should be addressed immediately with a patch release (v9.0.1).

---

## 8. References

### Relevant Files
- `/src/services/worker/SDKAgent.ts` - SDK agent implementation
- `/src/sdk/prompts.ts` - Prompt building functions
- `/src/services/worker/SessionManager.ts` - Session lifecycle management
- `/src/services/infrastructure/HealthMonitor.ts` - Version checking
- `/docs/VERSION_FIX.md` - Documentation of version mismatch fix

### Related Issues
- PR #567 - Fix version mismatch causing infinite worker restart loop
- Commit `e22e2bfc` - Version mismatch fix

### Test Files
- `/tests/infrastructure/version-consistency.test.ts` - Version consistency tests

---

## 9. Appendix: Full Log Excerpt

```
[INFO ] [HOOK  ] -> PostToolUse: Bash(cat ~/.claude-mem/settings.json) {workerPort=37777}
[INFO ] [HTTP  ] -> POST /api/sessions/observations {requestId=POST-xxx}
[INFO ] [QUEUE ] [session-1] ENQUEUED | sessionDbId=1 | messageId=596 | type=observation | tool=Bash(...) | depth=1
[INFO ] [SESSION] [session-1] Generator auto-starting (observation) using Claude SDK {queueDepth=0, historyLength=0}
[INFO ] [SDK   ] Starting SDK query {sessionDbId=1, ..., lastPromptNumber=57, isInitPrompt=false, promptType=CONTINUATION}
[INFO ] [SDK   ] Creating message generator {..., promptType=CONTINUATION}
[INFO ] [QUEUE ] [session-1] CLAIMED | sessionDbId=1 | messageId=596 | type=observation
[INFO ] [SDK   ] [session-1] <- Response received (72 chars) {promptNumber=57} Ready to observe. Awaiting tool execution data from the primary session.
[INFO ] [DB    ] [session-1] STORED | sessionDbId=1 | ... | obsCount=0 | obsIds=[] | summaryId=none
```
