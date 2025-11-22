# Endless Mode Continuity Bug Analysis

**Date**: 2025-11-20
**Branch**: `feature/endless-mode-beta-release`
**Comparison**: vs `main`

## Executive Summary

The continuity issue is caused by the addition of the "WHEN TO SKIP" section to the continuation prompt (`buildContinuationPrompt`) when Endless Mode is disabled (the default). This tells the SDK agent to skip "routine operations" for prompt #2+, but the main branch never had this section in continuation prompts - it always created observations for all tool uses.

## Root Cause

### Key Commit: `8534fe6` - "Enhance session handling with continuation support"

This commit modified `src/sdk/prompts.ts` to add an `observeEverything` parameter to both:
1. `buildInitPrompt()`
2. `buildContinuationPrompt()`

When `observeEverything = false` (the default), both prompts now show:

```
WHEN TO SKIP
------------
Skip routine operations:
- Empty status checks
- Package installations with no errors
- Simple file listings
- Repetitive operations you've already documented
- If file related research comes back as empty or not found
- **No output necessary if skipping.**
```

### The Problem

**On main branch:**
- Init prompt (prompt #1): Had "WHEN TO SKIP" section ✅
- Continuation prompt (prompt #2+): Did NOT have "WHEN TO SKIP" - just said "Continue generating observations" ✅

**On feature branch:**
- Init prompt (prompt #1): Has "WHEN TO SKIP" when `observeEverything=false` ✅ (same as main)
- Continuation prompt (prompt #2+): **NOW ALSO has "WHEN TO SKIP"** when `observeEverything=false` ❌ (NEW - this is the bug!)

### Why observeEverything Defaults to False

From `src/services/worker/EndlessModeConfig.ts` line 86-90:

```typescript
const observeEverything = getBooleanSetting(
  settings.env?.CLAUDE_MEM_OBSERVE_EVERYTHING,
  process.env.CLAUDE_MEM_OBSERVE_EVERYTHING,
  enabled  // <-- Defaults to same as CLAUDE_MEM_ENDLESS_MODE
);
```

Since Endless Mode is disabled by default, `observeEverything` is also false by default.

## Impact

When users run multi-turn sessions (prompt #2, #3, #4, etc.), the SDK agent now skips creating observations for "routine operations" that it previously would have observed. This causes:

1. **Incomplete session summaries** - missing important context from later turns
2. **Loss of continuity** - observations from prompt #1 exist, but subsequent turns are sparsely recorded
3. **Broken search** - users can't find work done in later turns of a session

## Changes Involved

### File: `src/sdk/prompts.ts`

**Modified functions:**
- `buildInitPrompt()` - Added `observeEverything` parameter with conditional "WHEN TO SKIP" vs "OBSERVATION REQUIREMENTS"
- `buildContinuationPrompt()` - Added `observeEverything` parameter with conditional sections (THIS IS THE BUG)

### File: `src/services/worker/SDKAgent.ts`

**Key changes:**
- Line 202: Gets `observeEverything` from `EndlessModeConfig.getConfig()`
- Line 212: Passes `observeEverything` to `buildInitPrompt()`
- Line 213: Passes `observeEverything` to `buildContinuationPrompt()`
- Line 230: NEW - continuation message handling (for prompt #2+ in same session)

### File: `src/services/worker-service.ts`

**Key changes:**
- Line 349-361: NEW - checks if session exists, if so queues continuation instead of starting new generator
- This is what enables prompt #2+ to work in the same session

### File: `src/services/worker/SessionManager.ts`

**Key changes:**
- Line 192-219: NEW - `queueContinuation()` method to queue continuation prompts

## Fix Options

### Option 1: Remove WHEN TO SKIP from Continuation Prompts (Recommended)

**Rationale**: Continuation prompts should always observe everything to maintain continuity across turns, regardless of Endless Mode setting.

**Changes needed:**
```typescript
// src/sdk/prompts.ts - buildContinuationPrompt()
export function buildContinuationPrompt(
  userPrompt: string,
  promptNumber: number,
  claudeSessionId: string,
  observeEverything = false  // Parameter still exists for consistency
): string {
  return `
Hello memory agent, you are continuing to observe the primary Claude session.

<observed_from_primary_session>
  <user_request>${userPrompt}</user_request>
  <requested_at>${new Date().toISOString().split('T')[0]}</requested_at>
</observed_from_primary_session>

You do not have access to tools. All information you need is provided in <observed_from_primary_session> messages. Create observations from what you observe - no investigation needed.

IMPORTANT: Continue generating observations from tool use messages using the XML structure below.

OUTPUT FORMAT
-------------
...
`;
}
```

**Pros:**
- Minimal change - just remove the conditional section from continuation prompt
- Maintains backwards compatibility with main branch behavior
- Continuity is preserved across all turns
- Endless Mode still works (it passes observeEverything=true explicitly)

**Cons:**
- Continuation prompts will always observe everything (but this was the behavior on main)

### Option 2: Change Default for observeEverything in Continuations

**Changes needed:**
```typescript
// src/services/worker/SDKAgent.ts - createMessageGenerator()
// For continuation messages, always observe everything
if (message.type === 'continuation') {
  // ...
  yield {
    type: 'user',
    message: {
      role: 'user',
      content: buildContinuationPrompt(
        session.userPrompt,
        session.lastPromptNumber,
        session.claudeSessionId,
        true  // <-- Force observeEverything=true for continuations
      )
    },
    // ...
  };
}
```

**Pros:**
- Preserves the conditional logic in prompts.ts
- Explicit about the behavior difference between init and continuation

**Cons:**
- More complex - requires changes in multiple places
- Less obvious why continuations behave differently

### Option 3: Document and Accept the Behavior

**Not recommended** - this breaks existing functionality that users depend on.

## Recommendation

**Use Option 1**: Remove the conditional "WHEN TO SKIP" section from `buildContinuationPrompt()` entirely.

This restores the main branch behavior where continuation prompts always observe everything, which is correct for maintaining session continuity. The Endless Mode functionality will continue to work because when it's enabled, `observeEverything` is true anyway, so the prompt explicitly tells the agent to observe everything.

## Testing Plan

After implementing the fix:

1. **Test multi-turn session on main (baseline)**:
   - Run a 3-turn session with various operations
   - Check that observations are created for all turns
   - Verify session summary includes all turns

2. **Test multi-turn session on feature branch (after fix)**:
   - Run same 3-turn session
   - Check observations match main branch behavior
   - Verify session summary has same completeness

3. **Test Endless Mode still works**:
   - Enable Endless Mode
   - Run multi-turn session
   - Verify all observations are created (because observeEverything=true)

4. **Regression test**:
   - Compare session summaries between main and fixed feature branch
   - Should be equivalent for same sequence of operations

## Related Files

### Changed in feature branch:
- `src/sdk/prompts.ts` - Prompt templates
- `src/services/worker/SDKAgent.ts` - SDK agent logic
- `src/services/worker-service.ts` - Worker service endpoints
- `src/services/worker/SessionManager.ts` - Session management
- `src/services/worker/EndlessModeConfig.ts` - Configuration

### Need to review:
- `src/hooks/save-hook.ts` - May have related changes
- `src/hooks/new-hook.ts` - May have related changes
- `src/hooks/summary-hook.ts` - May have related changes

## Commits to Review

1. `a5c185b` - Remove prompt truncation (most recent)
2. `8534fe6` - **Enhance session handling with continuation support (ROOT CAUSE)**
3. `cc5f93f` - Refactor Endless Mode Configuration
4. `5fe4498` - Refactor Endless Mode transformation logic
5. `8bbf689` - Implement deferred transformation

## Next Steps

1. Implement Option 1 fix
2. Run test suite to verify no regressions
3. Compare session output with main branch
4. Consider cherry-picking just the continuation support changes to main (without the WHEN TO SKIP addition)
