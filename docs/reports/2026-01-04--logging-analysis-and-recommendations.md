# Logging Analysis and Recommendations

**Date**: 2026-01-04
**Status**: CRITICAL - Current logging does not prove system correctness
**Goal**: Enable operators to visually verify the system is working and quickly discover when it isn't

---

## Executive Summary

The current logging is **noisy bullshit that doesn't cover the important parts of the system**. The logging should:

1. **PROVE** the system is working correctly (not just record activity)
2. **MAKE OBVIOUS** when things break (clear error paths)
3. **TRACE** data end-to-end through the pipeline

### Critical Finding: Session ID Alignment is BROKEN and UNVERIFIABLE

The system has **three session ID types** that must stay aligned:
- `contentSessionId` - from Claude Code (user's session)
- `sessionDbId` - our internal database ID (integer)
- `memorySessionId` - from Claude SDK (enables resume)

**The [ALIGNMENT] logs exist because this mapping is STILL a regression bug.** The current logs show intermediate values but **don't prove correctness**.

---

## Critical System Operations

### 1. Session ID Mapping Chain (MOST CRITICAL)

```
contentSessionId (from hook)
    → sessionDbId (our DB lookup)
    → memorySessionId (captured from SDK)
```

**If this breaks, observations go to wrong sessions = DATA CORRUPTION**

**Current State:**
| Operation | Has Logging? | Proves Correctness? |
|-----------|-------------|---------------------|
| Hook receives contentSessionId | YES | NO - just logs receipt |
| DB creates/looks up sessionDbId | PARTIAL | NO - no verification |
| SDK response gives memorySessionId | YES | NO - no DB update verification |
| Observations stored with memorySessionId | PARTIAL | NO - doesn't show which IDs used |

**What's MISSING:**

```
[INFO] [SESSION] SESSION_CREATED | contentSessionId=abc123 → sessionDbId=42 | isNew=true
[INFO] [SESSION] MEMORY_ID_CAPTURED | sessionDbId=42 | memorySessionId=xyz789 | dbUpdateSuccess=true
[INFO] [SESSION] E2E_VERIFIED | contentSessionId=abc123 → sessionDbId=42 → memorySessionId=xyz789
```

### 2. Observation Storage Pipeline (CRITICAL)

**The pipeline:**
```
Hook captures tool use
    → Worker receives observation
    → Queued to pending_messages
    → SDK agent claims message
    → SDK processes → generates XML
    → Observations parsed
    → Stored to DB with memorySessionId
    → Synced to Chroma
```

**Current State:**
| Operation | Has Logging? | Proves Correctness? |
|-----------|-------------|---------------------|
| Hook captures tool | YES | Noise - "Received hook input" |
| Observation queued | YES | Noise - just says "queued" |
| Message claimed from queue | NO | MISSING |
| Observation parsed | NO | MISSING |
| Observation stored to DB | PARTIAL | NO - doesn't show IDs used |
| DB transaction committed | NO | MISSING |
| Chroma sync complete | DEBUG only | Should be INFO for failures |

**What's MISSING:**

```
[INFO] [QUEUE] CLAIMED | sessionDbId=42 | messageId=5 | type=observation | tool=Bash(npm test)
[INFO] [DB   ] STORED | sessionDbId=42 | memorySessionId=xyz789 | observations=2 | ids=[101,102]
[INFO] [QUEUE] COMPLETED | sessionDbId=42 | messageId=5 | processingTime=1.2s
```

### 3. Queue Processing (CRITICAL)

Messages can fail, get stuck, or be lost. Current logging doesn't show:
- When a message is claimed
- When a message is completed
- When a message fails and WHY
- Queue depth and processing latency

**Current State:**
- Queue enqueue: `logger.debug` (not visible at INFO)
- Queue claim: NO LOGGING
- Queue completion: NO LOGGING
- Queue failure: `logger.error` (exists but rare)
- Recovery of stuck messages: `logger.info` (good)

**What's MISSING:**

```
[INFO] [QUEUE] ENQUEUE | sessionDbId=42 | type=observation | queueDepth=3
[INFO] [QUEUE] CLAIM | sessionDbId=42 | messageId=5 | waitTime=0.1s
[INFO] [QUEUE] COMPLETE | sessionDbId=42 | messageId=5 | success=true
[ERROR][QUEUE] FAILED | sessionDbId=42 | messageId=5 | error="SDK timeout" | willRetry=true
```

### 4. Context Injection (IMPORTANT)

When a session starts, relevant past observations should be injected. Current logging doesn't show:
- What context was searched for
- What was found
- What was injected

**Current State:** Effectively no logging for context injection success path.

---

## What's Currently NOISE (Should Be DEBUG or Removed)

### Chatty Session Init Logs (new-hook.ts)
```typescript
// 7 INFO logs for a single session init
logger.info('HOOK', 'new-hook: Received hook input');      // WHO CARES
logger.info('HOOK', 'new-hook: Calling /api/sessions/init'); // WHO CARES
logger.info('HOOK', 'new-hook: Received from /api/sessions/init'); // WHO CARES
logger.info('HOOK', 'new-hook: Session N, prompt #M');     // CONSOLIDATE INTO ONE
logger.info('HOOK', 'new-hook: Calling /sessions/{id}/init'); // WHO CARES
```

**Should be ONE log:** `SESSION_INIT | sessionDbId=42 | promptNumber=1 | project=foo`

### Chatty SessionManager Logs
```typescript
logger.info('SESSION', 'initializeSession called');  // WHO CARES
logger.info('SESSION', 'Returning cached session');  // DEBUG
logger.info('SESSION', 'Fetched session from database'); // DEBUG
logger.info('SESSION', 'Creating new session object'); // DEBUG
logger.info('SESSION', 'Session initialized');       // GOOD - KEEP
logger.info('SESSION', 'Observation queued');        // DEBUG - happens constantly
logger.info('SESSION', 'Summarize queued');          // DEBUG - happens constantly
```

### Chatty Chroma Backfill Logs
```typescript
// Logs EVERY batch at INFO - should be DEBUG for progress
logger.info('CHROMA_SYNC', 'Backfill progress', { processed, remaining }); // DEBUG
```

**Should be START and END only at INFO level.**

### Duplicate Migration Logs
Both `SessionStore.ts` and `migrations/runner.ts` have ~25 identical log statements. **DEDUPLICATE.**

---

## [ALIGNMENT] Logs: The Problem

The [ALIGNMENT] logs were added to debug session ID issues. They're in the RIGHT places but they **don't prove anything**:

```typescript
// Current - shows values but doesn't verify
logger.info('SDK', `[ALIGNMENT] Resume Decision | contentSessionId=${...} | memorySessionId=${...}`);

// What's needed - proves correctness
logger.info('SDK', `[ALIGNMENT] VERIFIED | contentSessionId=${...} → sessionDbId=${...} → memorySessionId=${...} | dbMatch=true | resumeValid=true`);
```

**Current problems:**
1. Log values without validation
2. Don't show if DB operations succeeded
3. Don't trace end-to-end
4. Mixed in with noise - hard to see

**What they should do:**
1. Log the mapping chain ONCE with verification
2. Show DB operation success/failure
3. Provide clear end-to-end trace
4. Stand out from noise with consistent prefix

---

## Proposed Logging Architecture

### Log Levels by Purpose

| Level | Purpose | Examples |
|-------|---------|----------|
| ERROR | Something FAILED | DB write failed, SDK crashed, queue overflow |
| WARN | Something UNEXPECTED but handled | Fallback used, retry needed, timeout |
| INFO | KEY OPERATIONS completed | Session created, observation stored, queue processed |
| DEBUG | Detailed tracing | Cache hits, intermediate states, parsing details |

### Critical Path Logging (Must be INFO)

#### Session Lifecycle
```
[INFO] [SESSION] CREATED | contentSessionId=abc → sessionDbId=42 | project=foo
[INFO] [SESSION] MEMORY_ID_CAPTURED | sessionDbId=42 → memorySessionId=xyz | dbUpdated=true
[INFO] [SESSION] VERIFIED | chain: abc→42→xyz | valid=true
[INFO] [SESSION] COMPLETED | sessionDbId=42 | duration=45s | observations=12 | summaries=1
```

#### Observation Pipeline
```
[INFO] [QUEUE] ENQUEUED | sessionDbId=42 | type=observation | tool=Bash(npm test) | depth=1
[INFO] [QUEUE] CLAIMED | sessionDbId=42 | messageId=5 | waitTime=0.1s
[INFO] [DB   ] STORED | sessionDbId=42 | memorySessionId=xyz | obsIds=[101,102] | txnCommit=true
[INFO] [QUEUE] COMPLETED | sessionDbId=42 | messageId=5 | duration=1.2s
```

#### Error Conditions
```
[ERROR] [SESSION] MEMORY_ID_MISMATCH | expected=xyz | got=abc | sessionDbId=42
[ERROR] [DB     ] STORE_FAILED | sessionDbId=42 | error="FK constraint" | observations=2
[ERROR] [QUEUE  ] STUCK | sessionDbId=42 | stuckFor=5min | action=marking_failed
[ERROR] [SDK    ] CRASHED | sessionDbId=42 | error="Claude process died" | pendingWork=3
```

### Health Dashboard Output

After fixes, a healthy session should produce:
```
[INFO] [SESSION] CREATED | contentSessionId=abc → sessionDbId=42
[INFO] [SESSION] GENERATOR_STARTED | sessionDbId=42 | provider=claude-sdk
[INFO] [QUEUE  ] CLAIMED | sessionDbId=42 | messageId=1 | type=observation
[INFO] [SESSION] MEMORY_ID_CAPTURED | sessionDbId=42 → memorySessionId=xyz
[INFO] [DB     ] STORED | sessionDbId=42 | memorySessionId=xyz | obsIds=[1]
[INFO] [QUEUE  ] COMPLETED | sessionDbId=42 | messageId=1
... (more observations)
[INFO] [QUEUE  ] CLAIMED | sessionDbId=42 | messageId=5 | type=summarize
[INFO] [DB     ] STORED | sessionDbId=42 | summaryId=1
[INFO] [QUEUE  ] COMPLETED | sessionDbId=42 | messageId=5
[INFO] [SESSION] COMPLETED | sessionDbId=42 | duration=45s | observations=12
```

An UNHEALTHY session should make problems OBVIOUS:
```
[INFO] [SESSION] CREATED | contentSessionId=abc → sessionDbId=42
[INFO] [SESSION] GENERATOR_STARTED | sessionDbId=42 | provider=claude-sdk
[ERROR] [SESSION] MEMORY_ID_NOT_CAPTURED | sessionDbId=42 | waited=30s
[ERROR] [DB     ] STORE_FAILED | sessionDbId=42 | error="memorySessionId is null"
[WARN ] [QUEUE  ] STUCK | sessionDbId=42 | messageId=1 | age=60s | action=retry
[ERROR] [SESSION] GENERATOR_CRASHED | sessionDbId=42 | error="SDK timeout"
```

---

## Implementation Priorities

### P0: Fix Critical Missing Logs (Session Alignment)

1. **ResponseProcessor.ts** - Add logging BEFORE storeObservations:
   ```typescript
   logger.info('DB', 'STORING | sessionDbId=... | memorySessionId=... | count=...');
   ```

2. **SDKAgent.ts** - Verify DB update after memorySessionId capture:
   ```typescript
   const updated = store.updateMemorySessionId(sessionDbId, memorySessionId);
   logger.info('SESSION', `MEMORY_ID_CAPTURED | sessionDbId=${...} | memorySessionId=${...} | dbUpdated=${updated}`);
   ```

3. **SessionRoutes.ts** - Log session creation with verification:
   ```typescript
   logger.info('SESSION', `CREATED | contentSessionId=${...} → sessionDbId=${...} | verified=true`);
   ```

### P1: Fix Queue Processing Logs

1. **SessionQueueProcessor.ts** - Add CLAIM/COMPLETE logs
2. **PendingMessageStore.ts** - Add enqueue/dequeue logs

### P2: Reduce Noise

1. Move chatty logs to DEBUG level
2. Deduplicate migration logs
3. Consolidate hook init logs

### P3: Add Health Validation

1. Periodic verification log: `[INFO] [HEALTH] OK | sessions=3 | pending=0 | chroma=connected`
2. On-demand chain verification: `[INFO] [VERIFY] contentSessionId=abc chain is VALID`

---

## Files Requiring Changes

| File | Priority | Changes |
|------|----------|---------|
| `src/services/worker/agents/ResponseProcessor.ts` | P0 | Add pre-store logging with IDs |
| `src/services/worker/SDKAgent.ts` | P0 | Verify DB update, consolidate ALIGNMENT logs |
| `src/services/worker/http/routes/SessionRoutes.ts` | P0 | Add session creation verification log |
| `src/services/queue/SessionQueueProcessor.ts` | P1 | Add CLAIM/COMPLETE logs |
| `src/services/sqlite/PendingMessageStore.ts` | P1 | Add enqueue/dequeue logs |
| `src/services/worker/SessionManager.ts` | P2 | Move chatty logs to DEBUG |
| `src/hooks/new-hook.ts` | P2 | Consolidate to single INFO log |
| `src/services/sync/ChromaSync.ts` | P2 | Move progress to DEBUG, keep start/end INFO |
| `src/services/sqlite/SessionStore.ts` | P2 | Remove duplicate migration logs |

---

## Verification Checklist

After implementing changes, verify:

- [ ] Can trace contentSessionId → sessionDbId → memorySessionId in logs
- [ ] Can see when observation storage succeeds/fails
- [ ] Can see queue claim/complete for each message
- [ ] Errors are OBVIOUS and include context for debugging
- [ ] Noise is reduced to the point where INFO level is useful
- [ ] A "normal" session produces ~10-15 INFO logs, not 50+
