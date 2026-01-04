# Issue #514: Orphaned Observer Session Files Analysis

**Date:** January 4, 2026
**Status:** PARTIALLY RESOLVED - Root cause understood, fix was made but reverted
**Original Issue:** 13,000+ orphaned .jsonl session files created over 2 days

---

## Executive Summary

Issue #514 reported that the plugin created 13,000+ orphaned session .jsonl files in `~/.claude/projects/<project>/`. Each file contained only an initialization message with no actual observations. The hypothesis was that `startSessionProcessor()` in startup-recovery created new observer sessions in a loop.

**Current State:** The issue was **fixed in commit 9a7f662** with a deterministic `mem-${contentSessionId}` prefix approach, but this fix was **reverted in commit f9197b5** due to the SDK not accepting custom session IDs. The current code uses a NULL-based initialization pattern that can still create orphaned sessions under certain conditions.

---

## Evidence: Current File Analysis

Filesystem analysis of `~/.claude/projects/-Users-alexnewman-Scripts-claude-mem/`:

| Line Count | Number of Files |
|------------|-----------------|
| 0 lines (empty) | 407 |
| 1 line | **12,562** |
| 2 lines | 3,199 |
| 3+ lines | 3,546 |
| **Total** | **~19,714** |

The 12,562 single-line files are consistent with the issue description - sessions that initialized but never received observations.

Sample single-line file content:
```json
{"type":"queue-operation","operation":"dequeue","timestamp":"2025-12-28T20:41:25.484Z","sessionId":"00081a3b-9485-48a4-89f0-fd4dfccd3ac9"}
```

---

## Root Cause Analysis

### The Problem Chain

1. **Worker startup calls `processPendingQueues()`** (line 281 in worker-service.ts)
2. For each session with pending messages, it calls `initializeSession()` then `startSessionProcessor()`
3. `startSessionProcessor()` invokes `sdkAgent.startSession()` which calls the Claude Agent SDK `query()` function
4. **If `memorySessionId` is NULL**, no `resume` parameter is passed to `query()`
5. **The SDK creates a NEW .jsonl file** for each query call without a resume parameter
6. **If the query aborts before receiving a response** (timeout, crash, abort signal), the `memorySessionId` is never captured
7. On next startup, the cycle repeats - creating yet another orphaned file

### Why Sessions Abort Before Capturing memorySessionId

Looking at `startSessionProcessor()` flow:

```typescript
// worker-service.ts lines 301-321
private startSessionProcessor(session, source) {
  session.generatorPromise = this.sdkAgent.startSession(session, this)
    .catch(error => { /* error handling */ })
    .finally(() => {
      session.generatorPromise = null;
      this.broadcastProcessingStatus();
    });
}
```

And `processPendingQueues()`:

```typescript
// worker-service.ts lines 347-371
for (const sessionDbId of orphanedSessionIds) {
  const session = this.sessionManager.initializeSession(sessionDbId);
  this.startSessionProcessor(session, 'startup-recovery');
  await new Promise(resolve => setTimeout(resolve, 100));  // 100ms delay between sessions
}
```

The problem: Starting 50 sessions rapidly (100ms delay) with pending messages means:
- All 50 SDK queries start nearly simultaneously
- The SDK creates 50 new .jsonl files (since none have memorySessionId yet)
- If any query fails/aborts before the first response, its memorySessionId is never captured
- On next startup, those sessions get new files again

---

## Code Flow: Where .jsonl Files Are Created

The .jsonl files are created by the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`), not by claude-mem directly.

When `query()` is called in SDKAgent.ts:

```typescript
// SDKAgent.ts lines 89-99
const queryResult = query({
  prompt: messageGenerator,
  options: {
    model: modelId,
    // Resume with captured memorySessionId (null on first prompt, real ID on subsequent)
    ...(hasRealMemorySessionId && { resume: session.memorySessionId }),
    disallowedTools,
    abortController: session.abortController,
    pathToClaudeCodeExecutable: claudePath
  }
});
```

**Key insight:** If `hasRealMemorySessionId` is false (memorySessionId is null), no `resume` parameter is passed. The SDK then generates a new UUID and creates a new file at:
`~/.claude/projects/<dashed-cwd>/<new-uuid>.jsonl`

---

## Fix History

### Commit 9a7f662: The Original Fix (Reverted)

```
fix(sdk): always pass deterministic session ID to prevent orphaned files

Fixes #514 - Excessive observer sessions created during startup-recovery

Root cause: When memorySessionId was null, no `resume` parameter was passed
to the SDK's query(). This caused the SDK to create a NEW session file on
every call. If queries aborted before capturing the SDK's session_id, the
placeholder remained, leading to cascading creation of 13,000+ orphaned files.

Fix:
- Generate deterministic ID `mem-${contentSessionId}` upfront
- Always pass it to `resume` parameter
- Persist immediately to database before query starts
- If SDK returns different ID, capture and use that going forward
```

**This fix was correct in approach** - always passing a resume parameter prevents new file creation.

### Commit f9197b5: The Revert

```
fix(sdk): restore session continuity via robust capture-and-resume strategy

Replaces the deterministic 'mem-' ID approach with a capture-based strategy:
1. Passes 'resume' parameter ONLY when a verified memory session ID exists
2. Captures SDK-generated session ID when it differs from current ID
3. Ensures subsequent prompts resume the correctly captured session ID

This resolves the issue where new sessions were created for every message
due to failure to capture/resume the initial session ID, without introducing
potentially invalid deterministic IDs.
```

**The revert explanation suggests the SDK rejected the `mem-` prefix IDs.**

### Commit 005b0f8: Current NULL-based Pattern

Changed `memory_session_id` initialization from `contentSessionId` (placeholder) to `NULL`:
- Simpler logic: `!!session.memorySessionId` instead of `memorySessionId !== contentSessionId`
- But still creates new files on first prompt of each session

---

## Relationship with Issue #520 (Stuck Messages)

**Issue #520 is related but distinct:**

| Aspect | Issue #514 (Orphaned Files) | Issue #520 (Stuck Messages) |
|--------|-----------------------------|-----------------------------|
| Problem | Too many .jsonl files | Messages never processed |
| Root Cause | SDK creates new file per query without resume | Old claim-process-mark pattern left messages in 'processing' state |
| Status | Partially resolved | **Fully resolved** |
| Fix | Need deterministic resume IDs | Changed to claim-and-delete pattern |

**Connection:** Both issues relate to startup-recovery. Issue #520's fix (claim-and-delete pattern) doesn't create the loop that #514 describes, but #514 can still occur when:
1. Sessions have pending messages
2. Recovery starts the generator
3. Generator aborts before capturing memorySessionId
4. Next startup repeats the cycle

---

## v8.5.7 Status

**v8.5.7 did NOT fully address Issue #514.** The major changes were:
- Modular architecture refactor
- NULL-based initialization pattern
- Comprehensive test coverage

The deterministic `mem-` prefix fix (9a7f662) was reverted before v8.5.7.

---

## Recommended Fix

### Option 1: Reintroduce Deterministic IDs with SDK Validation

```typescript
// SDKAgent.ts - In startSession()
async startSession(session: ActiveSession, worker?: WorkerRef): Promise<void> {
  // Generate deterministic ID based on database session ID (not UUID-based contentSessionId)
  // Format: "mem-<sessionDbId>" is short and unlikely to conflict
  const deterministicMemoryId = session.memorySessionId || `mem-${session.sessionDbId}`;

  // Always pass resume to prevent orphaned sessions
  const queryResult = query({
    prompt: messageGenerator,
    options: {
      model: modelId,
      resume: deterministicMemoryId,  // ALWAYS pass, even if SDK might reject
      disallowedTools,
      abortController: session.abortController,
      pathToClaudeCodeExecutable: claudePath
    }
  });

  // Capture whatever ID the SDK actually uses
  for await (const message of queryResult) {
    if (message.session_id && message.session_id !== session.memorySessionId) {
      session.memorySessionId = message.session_id;
      this.dbManager.getSessionStore().updateMemorySessionId(
        session.sessionDbId,
        message.session_id
      );
    }
    // ... rest of processing
  }
}
```

### Option 2: Limit Recovery Scope

Prevent the recovery loop by limiting how many times a session can be recovered:

```typescript
// In processPendingQueues()
for (const sessionDbId of orphanedSessionIds) {
  // Check if this session was already recovered recently
  const dbSession = this.dbManager.getSessionById(sessionDbId);
  const recoveryAttempts = dbSession.recovery_attempts || 0;

  if (recoveryAttempts >= 3) {
    logger.warn('SYSTEM', 'Session exceeded max recovery attempts, skipping', {
      sessionDbId,
      recoveryAttempts
    });
    continue;
  }

  // Increment recovery counter
  this.dbManager.getSessionStore().incrementRecoveryAttempts(sessionDbId);

  // ... rest of recovery
}
```

### Option 3: Cleanup Old Files (Mitigation, Not Fix)

Add a cleanup script that removes orphaned .jsonl files:

```bash
# Find files with only 1 line older than 7 days
find ~/.claude/projects/ -name "*.jsonl" -mtime +7 \
  -exec sh -c '[ $(wc -l < "$1") -le 1 ] && rm "$1"' _ {} \;
```

---

## Files Involved

| File | Role |
|------|------|
| `src/services/worker-service.ts` | `startSessionProcessor()`, `processPendingQueues()` |
| `src/services/worker/SDKAgent.ts` | `startSession()`, `query()` call with `resume` parameter |
| `src/services/worker/SessionManager.ts` | `initializeSession()`, session lifecycle |
| `src/services/sqlite/sessions/create.ts` | `createSDKSession()`, NULL-based initialization |
| `src/services/sqlite/PendingMessageStore.ts` | `getSessionsWithPendingMessages()` |

---

## Conclusion

Issue #514 was correctly diagnosed. The fix in commit 9a7f662 was the right approach but was reverted because the SDK may not accept arbitrary custom IDs. The current NULL-based pattern (005b0f8) is cleaner but doesn't prevent orphaned files when queries abort before capturing the SDK's session ID.

**Recommendation:** Reintroduce the deterministic ID approach with proper handling of SDK rejections (Option 1). If the SDK rejects the ID and returns a different one, capture and persist that ID immediately. This ensures at most one .jsonl file per database session, even across crashes and restarts.

---

## Appendix: Git Commit References

| Commit | Description |
|--------|-------------|
| 9a7f662 | Original fix: deterministic `mem-` prefix IDs (REVERTED) |
| f9197b5 | Revert: capture-based strategy without deterministic IDs |
| 005b0f8 | NULL-based initialization pattern (current) |
| d72a81e | Queue refactoring (related to #520) |
| eb1a78b | Claim-and-delete pattern (fixes #520) |
