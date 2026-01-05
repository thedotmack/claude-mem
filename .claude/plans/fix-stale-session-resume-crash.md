# Plan: Fix Stale Session Resume Crash

## Problem Summary

The worker crashes repeatedly with "Claude Code process exited with code 1" when attempting to resume into a stale/non-existent SDK session.

**Root Cause:** In `SDKAgent.ts:94`, the resume parameter is passed whenever `memorySessionId` exists in the database, regardless of whether this is an INIT prompt or CONTINUATION prompt. When a worker restarts or re-initializes a session, it loads a stale `memorySessionId` from a previous SDK session and tries to resume into a session that no longer exists in Claude's context.

**Evidence from logs:**
```
[17:30:21.773] Starting SDK query {
  hasRealMemorySessionId=true,           ← DB has old memorySessionId
  resume_parameter=5439891b-...,         ← Trying to resume with it
  lastPromptNumber=1                     ← But this is a NEW SDK session!
}
[17:30:24.450] Generator failed {error=Claude Code process exited with code 1}
```

---

## Phase 0: Documentation Discovery (COMPLETED)

### Allowed APIs (from subagent research)

**V1 SDK API (currently used):**
```typescript
// From @anthropic-ai/claude-agent-sdk
function query(options: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options: {
    model: string;
    resume?: string;  // SESSION ID - only use for CONTINUATION
    disallowedTools?: string[];
    abortController?: AbortController;
    pathToClaudeCodeExecutable?: string;
  }
}): AsyncIterable<SDKMessage>
```

**Resume Parameter Rules (from docs/context/agent-sdk-v2-preview.md and SESSION_ID_ARCHITECTURE.md):**
- `resume` should only be used when continuing an existing SDK conversation
- For INIT prompts (first prompt in a fresh SDK session), no resume parameter should be passed
- Session ID is captured from first SDK message and stored for subsequent prompts

### Anti-Patterns to Avoid
- Passing `resume` parameter with INIT prompts (causes crash)
- Using `contentSessionId` for resume (contaminates user session)
- Assuming memorySessionId validity without checking prompt context

---

## Phase 1: Fix the Resume Parameter Logic

### What to Implement

Modify `src/services/worker/SDKAgent.ts` line 94 to check BOTH conditions:
1. `hasRealMemorySessionId` - memorySessionId exists and is non-null
2. `session.lastPromptNumber > 1` - this is a CONTINUATION, not an INIT prompt

### Current Code (line 89-99):
```typescript
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

### Fixed Code:
```typescript
const queryResult = query({
  prompt: messageGenerator,
  options: {
    model: modelId,
    // Only resume if BOTH: (1) we have a memorySessionId AND (2) this isn't the first prompt
    // On worker restart, memorySessionId may exist from a previous SDK session but we
    // need to start fresh since the SDK context was lost
    ...(hasRealMemorySessionId && session.lastPromptNumber > 1 && { resume: session.memorySessionId }),
    disallowedTools,
    abortController: session.abortController,
    pathToClaudeCodeExecutable: claudePath
  }
});
```

### Also Update the Comment at Line 66-68:
```typescript
// CRITICAL: Only resume if:
// 1. memorySessionId exists (was captured from a previous SDK response)
// 2. lastPromptNumber > 1 (this is a continuation within the same SDK session)
// On worker restart or crash recovery, memorySessionId may exist from a previous
// SDK session but we must NOT resume because the SDK context was lost.
// NEVER use contentSessionId for resume - that would inject messages into the user's transcript!
```

### Verification Checklist
- [ ] `grep "hasRealMemorySessionId && session.lastPromptNumber > 1" src/services/worker/SDKAgent.ts` returns the fix
- [ ] Build succeeds: `npm run build`
- [ ] No TypeScript errors

---

## Phase 2: Add Logging for Debugging

### What to Implement

Enhance the alignment log at line 81-85 to clearly indicate when resume is skipped due to INIT prompt:

```typescript
// Debug-level alignment logs for detailed tracing
if (session.lastPromptNumber > 1) {
  const willResume = hasRealMemorySessionId;
  logger.debug('SDK', `[ALIGNMENT] Resume Decision | contentSessionId=${session.contentSessionId} | memorySessionId=${session.memorySessionId} | prompt#=${session.lastPromptNumber} | hasRealMemorySessionId=${hasRealMemorySessionId} | willResume=${willResume} | resumeWith=${willResume ? session.memorySessionId : 'NONE'}`);
} else {
  // INIT prompt - never resume even if memorySessionId exists (stale from previous session)
  const hasStaleMemoryId = hasRealMemorySessionId;
  logger.debug('SDK', `[ALIGNMENT] First Prompt (INIT) | contentSessionId=${session.contentSessionId} | prompt#=${session.lastPromptNumber} | hasStaleMemoryId=${hasStaleMemoryId} | action=START_FRESH | Will capture new memorySessionId from SDK response`);
  if (hasStaleMemoryId) {
    logger.warn('SDK', `Skipping resume for INIT prompt despite existing memorySessionId=${session.memorySessionId} - SDK context was lost (worker restart or crash recovery)`);
  }
}
```

### Verification Checklist
- [ ] Build succeeds: `npm run build`
- [ ] Log message appears when running with stale session scenario

---

## Phase 3: Add Unit Tests

### What to Implement

Create tests in `tests/sdk-agent-resume.test.ts` following patterns from `tests/session_id_usage_validation.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';

describe('SDKAgent Resume Parameter Logic', () => {
  describe('hasRealMemorySessionId check', () => {
    it('should NOT pass resume parameter when lastPromptNumber === 1 even if memorySessionId exists', () => {
      // Scenario: Worker restart with stale memorySessionId
      const session = {
        memorySessionId: 'stale-session-id-from-previous-run',
        lastPromptNumber: 1,  // INIT prompt
      };

      const hasRealMemorySessionId = !!session.memorySessionId;
      const shouldResume = hasRealMemorySessionId && session.lastPromptNumber > 1;

      expect(hasRealMemorySessionId).toBe(true);  // memorySessionId exists
      expect(shouldResume).toBe(false);  // but should NOT resume
    });

    it('should pass resume parameter when lastPromptNumber > 1 AND memorySessionId exists', () => {
      // Scenario: Normal continuation within same SDK session
      const session = {
        memorySessionId: 'valid-session-id',
        lastPromptNumber: 2,  // CONTINUATION prompt
      };

      const hasRealMemorySessionId = !!session.memorySessionId;
      const shouldResume = hasRealMemorySessionId && session.lastPromptNumber > 1;

      expect(hasRealMemorySessionId).toBe(true);
      expect(shouldResume).toBe(true);
    });

    it('should NOT pass resume parameter when memorySessionId is null', () => {
      // Scenario: Fresh session, no captured ID yet
      const session = {
        memorySessionId: null,
        lastPromptNumber: 1,
      };

      const hasRealMemorySessionId = !!session.memorySessionId;
      const shouldResume = hasRealMemorySessionId && session.lastPromptNumber > 1;

      expect(hasRealMemorySessionId).toBe(false);
      expect(shouldResume).toBe(false);
    });
  });
});
```

### Documentation Reference
- Pattern: `tests/session_id_usage_validation.test.ts` lines 1-50 for test structure
- Mock pattern: `tests/worker/agents/response-processor.test.ts` for session mocking

### Verification Checklist
- [ ] Tests pass: `bun test tests/sdk-agent-resume.test.ts`
- [ ] Test file follows project conventions

---

## Phase 4: Build and Deploy

### What to Implement

1. Build the plugin: `npm run build-and-sync`
2. Verify worker restarts with fix applied

### Verification Checklist
- [ ] `npm run build-and-sync` succeeds
- [ ] Worker health check passes: `curl http://localhost:37777/api/health`
- [ ] No "Claude Code process exited with code 1" errors in logs after restart

---

## Phase 5: Final Verification

### Verification Commands

```bash
# 1. Verify fix is in place
grep -n "hasRealMemorySessionId && session.lastPromptNumber > 1" src/services/worker/SDKAgent.ts

# 2. Verify no crashes in recent logs
tail -100 ~/.claude-mem/logs/claude-mem-$(date +%Y-%m-%d).log | grep -c "exited with code 1"

# 3. Run tests
bun test tests/sdk-agent-resume.test.ts

# 4. Check for anti-patterns (should return 0 results)
grep -n "hasRealMemorySessionId && { resume" src/services/worker/SDKAgent.ts
```

### Success Criteria
- [ ] Fix in place at SDKAgent.ts:94
- [ ] Zero "exited with code 1" errors related to stale resume
- [ ] All tests pass
- [ ] Worker stable for 10+ minutes without crash loop

---

## Files to Modify

1. `src/services/worker/SDKAgent.ts` - Fix resume logic (Phase 1 & 2)
2. `tests/sdk-agent-resume.test.ts` - New test file (Phase 3)

## Estimated Complexity

- **Phase 1**: Low - Single line change with updated condition
- **Phase 2**: Low - Enhanced logging
- **Phase 3**: Medium - New test file following existing patterns
- **Phase 4-5**: Low - Standard build/verify process
