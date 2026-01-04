# Issue #532: Memory Leak in SessionManager - Analysis Report

**Date**: 2026-01-04
**Issue**: Memory leak causing 54GB+ VS Code memory consumption after several days of use
**Reported Root Causes**:
1. Sessions never auto-cleanup after SDK agent completes
2. `conversationHistory` array grows unbounded (never trimmed)

---

## Executive Summary

This analysis confirms **both issues exist in the current codebase** (v8.5.7). While v8.5.7 included a major modular refactor, it did **not address either memory leak issue**. The `SessionManager` holds sessions indefinitely in memory with no TTL/cleanup mechanism, and `conversationHistory` arrays grow unbounded within each session (with only OpenRouter implementing partial mitigation).

---

## 1. SessionManager Session Storage Analysis

### Location
`/Users/alexnewman/Scripts/claude-mem/src/services/worker/SessionManager.ts`

### Current Implementation

```typescript
export class SessionManager {
  private sessions: Map<number, ActiveSession> = new Map();
  private sessionQueues: Map<number, EventEmitter> = new Map();
  // ...
}
```

Sessions are stored in an in-memory `Map<number, ActiveSession>` with the session database ID as the key.

### Session Lifecycle

| Event | Method | Behavior |
|-------|--------|----------|
| Session created | `initializeSession()` | Added to `this.sessions` Map (line 152) |
| Session deleted | `deleteSession()` | Removed from `this.sessions` Map (line 293) |
| Worker shutdown | `shutdownAll()` | Calls `deleteSession()` on all sessions |

### The Problem: No Automatic Cleanup

Looking at `/Users/alexnewman/Scripts/claude-mem/src/services/worker/http/routes/SessionRoutes.ts` (lines 213-216), the session completion handling has this comment:

```typescript
// NOTE: We do NOT delete the session here anymore.
// The generator waits for events, so if it exited, it's either aborted or crashed.
// Idle sessions stay in memory (ActiveSession is small) to listen for future events.
```

**Critical Finding**: Sessions are **intentionally never deleted** after the SDK agent completes. They persist indefinitely "to listen for future events."

### When Sessions ARE Deleted

Sessions are only deleted when:
1. Explicit `DELETE /sessions/:sessionDbId` HTTP request (manual cleanup)
2. `POST /sessions/:sessionDbId/complete` HTTP request (cleanup-hook callback)
3. Worker service shutdown (`shutdownAll()`)

There is **NO automatic cleanup mechanism** based on:
- Session age/TTL
- Session inactivity timeout
- Memory pressure
- Completed/failed status

---

## 2. conversationHistory Analysis

### Location
`/Users/alexnewman/Scripts/claude-mem/src/services/worker-types.ts` (line 34)

### Type Definition

```typescript
export interface ActiveSession {
  // ...
  conversationHistory: ConversationMessage[];  // Shared conversation history for provider switching
  // ...
}
```

### Usage Pattern

The `conversationHistory` array is populated by three agent implementations:

1. **SDKAgent** (`/Users/alexnewman/Scripts/claude-mem/src/services/worker/SDKAgent.ts`)
   - Adds user messages at lines 247, 280, 302
   - Assistant responses added via `ResponseProcessor`

2. **GeminiAgent** (`/Users/alexnewman/Scripts/claude-mem/src/services/worker/GeminiAgent.ts`)
   - Adds user messages at lines 143, 196, 232
   - Adds assistant responses at lines 148, 202, 238

3. **OpenRouterAgent** (`/Users/alexnewman/Scripts/claude-mem/src/services/worker/OpenRouterAgent.ts`)
   - Adds user messages at lines 103, 155, 191
   - Adds assistant responses at lines 108, 161, 197
   - **Implements truncation**: See `truncateHistory()` at lines 262-301

4. **ResponseProcessor** (`/Users/alexnewman/Scripts/claude-mem/src/services/worker/agents/ResponseProcessor.ts`)
   - Adds assistant responses at line 57

### The Problem: Unbounded Growth

**For Claude SDK and Gemini agents**, there is **no limit or trimming** of `conversationHistory`. Every message is `push()`ed without checking array size.

**OpenRouter ONLY** has mitigation via `truncateHistory()`:

```typescript
private truncateHistory(history: ConversationMessage[]): ConversationMessage[] {
  const MAX_CONTEXT_MESSAGES = parseInt(settings.CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES) || 20;
  const MAX_ESTIMATED_TOKENS = parseInt(settings.CLAUDE_MEM_OPENROUTER_MAX_TOKENS) || 100000;

  // Sliding window: keep most recent messages within limits
  // ...
}
```

However, this only truncates the copy sent to OpenRouter API - **it does NOT truncate the actual `session.conversationHistory` array**. The original array still grows unbounded.

### Memory Impact Calculation

Each `ConversationMessage` contains:
- `role`: 'user' | 'assistant' (small string)
- `content`: string (can be very large - full prompts/responses)

A typical session with 100 tool uses could have:
- 1 init prompt (~2KB)
- 100 observation prompts (~5KB each = 500KB)
- 100 responses (~1KB each = 100KB)
- 1 summary prompt + response (~5KB)

**Per session**: ~600KB in `conversationHistory` alone

After several days with many sessions, this adds up to gigabytes.

---

## 3. v8.5.7 Refactor Assessment

The v8.5.7 release (2026-01-04) focused on modular architecture refactoring:

### What v8.5.7 DID:
- Extracted SQLite repositories into `/src/services/sqlite/`
- Extracted worker agents into `/src/services/worker/agents/`
- Extracted search strategies into `/src/services/worker/search/`
- Extracted context generation into `/src/services/context/`
- Extracted infrastructure into `/src/services/infrastructure/`
- Added 595 tests across 36 test files

### What v8.5.7 DID NOT address:
- No session TTL or automatic cleanup mechanism
- No `conversationHistory` size limits for Claude SDK or Gemini
- No memory pressure monitoring for sessions
- The "sessions stay in memory" design comment was already present

**Relevant v8.5.2 Note**: There was a related fix for SDK Agent child process memory leak (orphaned Claude processes), but that addressed process cleanup, not in-memory session state.

---

## 4. Specific Code Locations Requiring Fixes

### Fix Location 1: SessionManager needs cleanup mechanism
**File**: `/Users/alexnewman/Scripts/claude-mem/src/services/worker/SessionManager.ts`

Add automatic session cleanup based on:
- Session completion (when generator finishes and no pending work)
- Session age TTL (e.g., 1 hour after last activity)
- Memory pressure (configurable max sessions)

### Fix Location 2: conversationHistory needs bounds
**Files**:
- `/Users/alexnewman/Scripts/claude-mem/src/services/worker/SDKAgent.ts`
- `/Users/alexnewman/Scripts/claude-mem/src/services/worker/GeminiAgent.ts`
- `/Users/alexnewman/Scripts/claude-mem/src/services/worker/agents/ResponseProcessor.ts`

Apply sliding window truncation similar to OpenRouterAgent's approach, but mutate the original array.

### Fix Location 3: Session cleanup on completion
**File**: `/Users/alexnewman/Scripts/claude-mem/src/services/worker/http/routes/SessionRoutes.ts`

Remove the design decision to keep idle sessions in memory. Add cleanup timer after generator completes.

---

## 5. Recommended Fixes

### Fix 1: Add Session TTL and Cleanup Timer

```typescript
// In SessionManager.ts

private readonly SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
private cleanupTimers: Map<number, NodeJS.Timeout> = new Map();

/**
 * Schedule automatic cleanup for idle sessions
 */
scheduleSessionCleanup(sessionDbId: number): void {
  // Clear existing timer if any
  const existingTimer = this.cleanupTimers.get(sessionDbId);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  // Schedule cleanup after TTL
  const timer = setTimeout(() => {
    const session = this.sessions.get(sessionDbId);
    if (session && !session.generatorPromise) {
      // Only delete if no active generator
      this.deleteSession(sessionDbId);
      logger.info('SESSION', 'Session auto-cleaned due to TTL', { sessionDbId });
    }
  }, this.SESSION_TTL_MS);

  this.cleanupTimers.set(sessionDbId, timer);
}

/**
 * Cancel cleanup timer (call when session receives new work)
 */
cancelSessionCleanup(sessionDbId: number): void {
  const timer = this.cleanupTimers.get(sessionDbId);
  if (timer) {
    clearTimeout(timer);
    this.cleanupTimers.delete(sessionDbId);
  }
}
```

### Fix 2: Add conversationHistory Bounds

```typescript
// In src/services/worker/SessionManager.ts or new utility file

const MAX_CONVERSATION_HISTORY_LENGTH = 50; // Configurable

/**
 * Trim conversation history to prevent unbounded growth
 * Keeps the most recent messages
 */
export function trimConversationHistory(session: ActiveSession): void {
  if (session.conversationHistory.length > MAX_CONVERSATION_HISTORY_LENGTH) {
    const toRemove = session.conversationHistory.length - MAX_CONVERSATION_HISTORY_LENGTH;
    session.conversationHistory.splice(0, toRemove);
    logger.debug('SESSION', 'Trimmed conversation history', {
      sessionDbId: session.sessionDbId,
      removed: toRemove,
      remaining: session.conversationHistory.length
    });
  }
}
```

Then call this after each message is added in SDKAgent, GeminiAgent, and ResponseProcessor.

### Fix 3: Update SessionRoutes Generator Completion

```typescript
// In SessionRoutes.ts, update the finally block (around line 164)

.finally(() => {
  const sessionDbId = session.sessionDbId;
  const wasAborted = session.abortController.signal.aborted;

  if (wasAborted) {
    logger.info('SESSION', `Generator aborted`, { sessionId: sessionDbId });
  } else {
    logger.info('SESSION', `Generator completed naturally`, { sessionId: sessionDbId });
  }

  session.generatorPromise = null;
  session.currentProvider = null;
  this.workerService.broadcastProcessingStatus();

  // Check for pending work
  const pendingStore = this.sessionManager.getPendingMessageStore();
  const pendingCount = pendingStore.getPendingCount(sessionDbId);

  if (pendingCount > 0 && !wasAborted) {
    // Restart for pending work
    // ... existing restart logic ...
  } else {
    // No pending work - schedule cleanup instead of keeping forever
    this.sessionManager.scheduleSessionCleanup(sessionDbId);
  }
});
```

---

## 6. Configuration Recommendations

Add these to `settings.json` defaults:

```json
{
  "CLAUDE_MEM_SESSION_TTL_MINUTES": 60,
  "CLAUDE_MEM_MAX_CONVERSATION_HISTORY": 50,
  "CLAUDE_MEM_MAX_ACTIVE_SESSIONS": 100
}
```

---

## 7. Testing Recommendations

Add tests for:
1. Session cleanup after TTL expires
2. `conversationHistory` trimming at various sizes
3. Memory monitoring under sustained load
4. Cleanup timer cancellation on new work

---

## Summary

| Issue | Status in v8.5.7 | Fix Required |
|-------|------------------|--------------|
| Sessions never auto-cleanup | NOT FIXED | Yes - add TTL/cleanup mechanism |
| conversationHistory unbounded | NOT FIXED (except partial OpenRouter mitigation) | Yes - add trimming to all agents |

Both memory leaks are confirmed to exist in the current codebase and require the fixes outlined above.
