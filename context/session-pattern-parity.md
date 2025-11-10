# Session Pattern Parity Analysis
## SDKAgent.ts - Regular vs JIT Sessions

**Date**: 2025-11-09
**Purpose**: Ensure consistent patterns between regular memory creation sessions and JIT context filtering sessions

---

## Overview

SDKAgent manages two types of SDK sessions:
1. **Regular Sessions** - Background memory creation (observations/summaries)
2. **JIT Sessions** - Just-in-time context filtering for relevance

Both use the Agent SDK `query()` function with similar patterns but different lifecycles.

---

## Critical Pattern: Session ID Usage

### ✅ CORRECT PATTERN (Both sessions now follow this)

All message yields MUST use session IDs from the session object, NOT construct them inline.

**Regular Session:**
```typescript
// In createMessageGenerator(session)
yield {
  type: 'user',
  message: { role: 'user', content: '...' },
  session_id: session.claudeSessionId,  // ✅ From session object
  parent_tool_use_id: null,
  isSynthetic: true
};
```

**JIT Session:**
```typescript
// In createJitMessageGenerator(sessionDbId, observations)
const session = this.sessionManager.getSession(sessionDbId);
yield {
  type: 'user',
  message: { role: 'user', content: '...' },
  session_id: session.jitSessionId,  // ✅ From session object
  parent_tool_use_id: null,
  isSynthetic: true
};
```

### ❌ WRONG PATTERN (What we fixed)

```typescript
// DON'T DO THIS - Creates session ID inline instead of using session object
session_id: `jit-filter-${sessionDbId}`,  // ❌ WRONG - Not from session
```

**Why this breaks:**
- Claude Code SDK requires consistent session_id across all messages in a session
- Inline construction can create mismatches or conflicts
- Session object is the single source of truth

---

## Pattern Comparison Table

| Aspect | Regular Session | JIT Session | Parity Status |
|--------|----------------|-------------|---------------|
| **Session ID field** | `session.claudeSessionId` | `session.jitSessionId` | ✅ Both from session object |
| **Abort Controller** | `session.abortController` | `session.jitAbortController` | ✅ Separate by design |
| **Generator signature** | `createMessageGenerator(session)` | `createJitMessageGenerator(sessionDbId, observations)` | ⚠️ Different approach |
| **Generator gets session** | From parameter | Fetches via `sessionManager.getSession()` | ⚠️ Inconsistent |
| **Session ID in yields** | `session.claudeSessionId` | `session.jitSessionId` | ✅ Consistent pattern |
| **Response processor** | `processSDKResponse()` | `processJitFilterResponse()` | ✅ Different by design |
| **Cleanup method** | `sessionManager.deleteSession()` | `cleanupJitSession()` | ✅ Different by design |

---

## Architecture Decisions

### Why Different Abort Controllers?

**Design Rationale:**
- Regular sessions run once per user prompt, then complete
- JIT sessions are persistent across multiple filter queries
- JIT session needs independent lifecycle (can be aborted separately)

**Session object fields:**
```typescript
interface ActiveSession {
  abortController: AbortController;      // For regular session
  jitAbortController?: AbortController;  // For JIT session (optional)
  jitSessionId?: string;                 // JIT session ID (optional)
  jitGeneratorPromise?: Promise<void>;   // JIT generator (optional)
}
```

### Why Different Session IDs?

**Design Rationale:**
- Regular: Uses Claude's actual session_id from user's session
- JIT: Uses derived ID (`jit-${claudeSessionId}`) to avoid conflicts
- JIT session is synthetic and shouldn't interfere with real session

---

## Generator Signature Inconsistency

### Current Implementation

**Regular:**
```typescript
private async *createMessageGenerator(session: ActiveSession): AsyncIterableIterator<SDKUserMessage> {
  // Session passed as parameter - immediate access
  yield {
    session_id: session.claudeSessionId,
    // ...
  };
}
```

**JIT:**
```typescript
private async *createJitMessageGenerator(
  sessionDbId: number,
  observations: Array<{id: number, type: string, title: string}>
): AsyncIterableIterator<SDKUserMessage> {
  // Session fetched inside generator
  const session = this.sessionManager.getSession(sessionDbId);
  if (!session || !session.jitSessionId) {
    throw new Error(`No JIT session ID for session ${sessionDbId}`);
  }

  yield {
    session_id: session.jitSessionId,
    // ...
  };
}
```

### Analysis

**Why the difference?**
- JIT generator needs `observations` array for initial prompt
- Regular generator gets everything from session object
- Regular generator is called once per session init
- JIT generator is called once but yields multiple times for filter queries

**Is this a problem?**
- ⚠️ **Minor inconsistency** but acceptable
- Both ultimately use session object for session_id (correct)
- JIT needs to fetch session multiple times in the generator loop
- Fixing would require adding observations to session object (unnecessary complexity)

**Recommendation:**
- **KEEP AS IS** - The inconsistency is justified by different requirements
- Document why they differ
- Ensure both fetch session correctly when needed

---

## Abort Controller Access Pattern

### Regular Session
```typescript
// Passed to SDK query once
const queryResult = query({
  // ...
  abortController: session.abortController,
});
```

### JIT Session
```typescript
// JIT generator accesses abort controller multiple times
const abortController = session.jitAbortController;

while (!abortController.signal.aborted) {
  // Use abort signal in event loop
  abortController.signal.addEventListener('abort', () => {
    // Cleanup
  });
}
```

**Parity Status:** ✅ Consistent approach - both get controller from session object

---

## Message Yield Pattern (CRITICAL)

### Rule: ALL yields MUST follow this pattern

```typescript
const session = /* get session object */;

yield {
  type: 'user',
  message: {
    role: 'user',
    content: /* prompt content */
  },
  session_id: session.claudeSessionId,  // Or session.jitSessionId for JIT
  parent_tool_use_id: null,
  isSynthetic: true
};
```

### What NOT to do

```typescript
// ❌ DON'T construct session_id inline
session_id: `jit-filter-${sessionDbId}`,

// ❌ DON'T use database ID directly
session_id: sessionDbId.toString(),

// ❌ DON'T use hardcoded values
session_id: 'my-session',
```

---

## Checklist for Adding New Session Types

If you add a new session type in the future:

- [ ] Add session ID field to `ActiveSession` interface (e.g., `mySessionId`)
- [ ] Set session ID in session initialization (e.g., `session.mySessionId = ...`)
- [ ] Add abort controller field if needed (e.g., `myAbortController`)
- [ ] Pass full `session` object to generator OR fetch it inside with `sessionManager.getSession()`
- [ ] ALL yields use `session_id: session.mySessionId` (from session object)
- [ ] Never construct session_id inline in yield statements
- [ ] Test with multiple prompts to ensure session continuity
- [ ] Add cleanup method if needed (see `cleanupJitSession`)

---

## Testing Verification

### How to verify session parity

1. **Check session_id consistency:**
   ```bash
   grep -n "session_id:" src/services/worker/SDKAgent.ts
   ```
   Every occurrence should reference `session.claudeSessionId` or `session.jitSessionId`

2. **Check generator signatures:**
   ```bash
   grep -n "createMessageGenerator\|createJitMessageGenerator" src/services/worker/SDKAgent.ts
   ```
   Both should accept parameters they need, fetch session object when needed

3. **Check abort controller usage:**
   ```bash
   grep -n "abortController" src/services/worker/SDKAgent.ts
   ```
   Regular uses `session.abortController`, JIT uses `session.jitAbortController`

4. **Runtime test:**
   - Enable JIT context: `CLAUDE_MEM_JIT_CONTEXT_ENABLED=true`
   - Start new session
   - Check worker logs for session ID consistency
   - Verify no "session not found" errors

---

## Current Status

### ✅ Fixed Issues
- Session ID now consistently sourced from session object in all yields
- JIT session uses `session.jitSessionId` instead of inline construction
- Abort controller properly sourced from session object

### ⚠️ Acceptable Differences
- Generator signatures differ (justified by different requirements)
- Response processors differ (different purposes)
- Cleanup methods differ (different lifecycles)

### 🟢 Overall Assessment
**PARITY ACHIEVED** - Critical patterns are now consistent. Remaining differences are by design and properly documented.

---

## References

**File:** `src/services/worker/SDKAgent.ts`

**Key Lines:**
- Regular session_id: Line 335, 360, 376
- JIT session_id: Line 224, 273
- Regular generator: Line 325-382
- JIT generator: Line 197-279
- Session initialization: Line 140 (jitSessionId), Line 139 (jitAbortController)

**Related Files:**
- `src/services/worker/SessionManager.ts` - Session lifecycle management
- `src/services/worker-types.ts` - ActiveSession interface definition
