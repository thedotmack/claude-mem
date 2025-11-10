# JIT Context Architecture Fix Plan

## Problem Statement

JIT (Just-In-Time) context filtering is attempting to run Claude Agent SDK queries directly in the UserPromptSubmit hook. This violates the established architecture pattern where all AI processing happens in the worker service.

**Current Error:**
```
Claude Code executable not found at /Users/alexnewman/.claude/plugins/marketplaces/thedotmack/plugin/scripts/cli.js
```

**Root Cause:** Hooks execute in a sandboxed environment without access to the Claude executable path (claudePath), which the SDK requires for query operations.

## Current State Analysis

### Established Architecture Pattern

**save-hook (NON-BLOCKING):**
1. PostToolUse hook fires
2. Hook captures tool data
3. Hook sends data to worker via HTTP POST
4. Hook completes immediately (NON-BLOCKING)
5. Worker processes asynchronously using SDK (has claudePath)

**new-hook (BLOCKING for session init):**
1. UserPromptSubmit hook fires
2. Hook POSTs to `/sessions/:id/init` endpoint
3. Hook WAITS (BLOCKING) for worker response
4. Worker creates session record
5. Worker returns confirmation
6. Hook completes

### Broken Implementation

**new-hook with JIT (currently broken):**
- Line 97: Calls SDK `query()` directly in hook
- Hook environment lacks claudePath
- SDK cannot locate Claude executable
- Operation fails

### Why Both Session Init and JIT Must Be BLOCKING

1. **Session Initialization:** Other components depend on session ID existing in database
2. **JIT Context Filtering:** Filtered context must be available BEFORE Claude processes the prompt

If JIT were NON-BLOCKING, context would arrive too late to inject.

## Proposed Solution Architecture

### Move JIT Filtering to Worker, Keep BLOCKING

**Flow:**
1. UserPromptSubmit hook fires
2. Hook checks `isJitContextEnabled()` setting
3. Hook POSTs to `/sessions/:id/init` with `{ project, userPrompt, jitEnabled: true }`
4. Hook WAITS (BLOCKING) for worker response (5s timeout)
5. **Worker receives request:**
   - Creates session record
   - If `jitEnabled`, fetches recent observations from DB
   - Runs SDK query to filter 3-5 most relevant observations
   - Formats filtered observations as markdown
   - Returns `{ context: "..." }` in response
6. Hook receives response with context
7. Hook outputs context via `createHookResponse()`
8. Hook completes

### Architecture Benefits

**Consistency:** All AI processing happens in worker (save-hook, new-hook both use worker)

**Environment:** Worker has claudePath, SDK works without issues

**Timing:** BLOCKING ensures context available when needed, ~1-2s Haiku query fits within 5s fetch timeout

**Separation of Concerns:**
- Hook: Orchestration, feature flags, I/O
- Worker: AI processing, database queries, business logic

## Implementation Phases

### Phase 1: Worker Enhancement
**Goal:** Add JIT filtering capability to worker's /sessions/:id/init endpoint

**Tasks:**
1. Extract `generateJitContext()` function from `src/hooks/new-hook.ts`
2. Move function to worker service (location TBD, likely `src/services/worker/JitContext.ts`)
3. Import necessary dependencies:
   - SessionStore for DB access
   - SDK query function
   - Observation type definitions
4. Modify `/sessions/:id/init` endpoint handler:
   - Accept `jitEnabled` boolean in request body
   - If `jitEnabled`, call `generateJitContext(project, prompt)`
   - Include `context` field in response object
5. Ensure worker has access to:
   - `getContextDepth()` from shared settings
   - `claudePath` via existing SDKAgent pattern

**Verification:**
- Worker can generate JIT context when requested
- Response includes context field when jitEnabled=true
- Response omits context field when jitEnabled=false

### Phase 2: Hook Simplification
**Goal:** Remove SDK dependency from hook, consume worker's JIT context

**Tasks:**
1. Remove `generateJitContext()` function from `src/hooks/new-hook.ts` (lines 52-170)
2. Remove SDK import: `import { query } from '@anthropic-ai/claude-agent-sdk'`
3. Remove Observation interface (now only in worker)
4. Modify fetch to `/sessions/:id/init`:
   - Add `jitEnabled: isJitContextEnabled()` to request body
   - Extract `context` from response: `const { context } = await response.json()`
5. Update context handling logic:
   - If response contains `context`, use it
   - If no context in response, skip context injection
   - Remove try/catch around SDK query (no longer needed)
6. Keep existing error handling for connection/timeout errors

**Verification:**
- Hook successfully calls worker with jitEnabled flag
- Hook receives and extracts context from response
- Hook has no SDK dependencies
- Build succeeds without SDK in hook

### Phase 3: Configuration Consistency
**Goal:** Ensure JIT feature flag properly controls behavior end-to-end

**Tasks:**
1. Verify `isJitContextEnabled()` in `src/shared/settings.ts`:
   - Reads from settings.json → env var → default false
   - Returns boolean
2. Confirm hook passes correct flag value to worker
3. Verify worker respects flag (only runs JIT when true)
4. Test all three states:
   - Setting not present (default false)
   - Setting explicitly true
   - Setting explicitly false

**Verification:**
- JIT context disabled by default (backward compatible)
- Enabling `CLAUDE_MEM_JIT_CONTEXT_ENABLED=true` activates feature
- Worker only performs AI processing when flag is true

### Phase 4: Build and Deployment
**Goal:** Compile changes and sync to user's plugin directory

**Tasks:**
1. Run `npm run build`:
   - Verify hooks compile successfully
   - Verify worker service compiles successfully
   - Check build output for errors
2. Run `npm run sync-marketplace`:
   - Sync to `~/.claude/plugins/marketplaces/thedotmack/`
   - Verify hooks and worker updated
3. Run `npm run worker:restart`:
   - Restart PM2 worker to load new code
   - Verify worker starts successfully
   - Check worker logs for startup errors

**Verification:**
- Build completes without errors
- Files synced to marketplace directory
- Worker running with new code
- PM2 shows worker in "online" status

### Phase 5: Integration Testing
**Goal:** Verify JIT context feature works end-to-end

**Test Cases:**

1. **JIT Disabled (default behavior):**
   - Start new Claude Code session
   - Verify no JIT context appears
   - Verify no errors in hook or worker logs
   - Confirm session initializes normally

2. **JIT Enabled, no relevant context:**
   - Enable `CLAUDE_MEM_JIT_CONTEXT_ENABLED=true`
   - Start new session in project with no observations
   - Verify feedback message: "No previous observations found"
   - Confirm no errors

3. **JIT Enabled, with relevant context:**
   - Enable JIT feature
   - Start session in project with existing observations
   - Submit prompt related to past work
   - Verify filtered context appears in session start
   - Confirm context contains 3-5 relevant observations
   - Verify format matches expected markdown structure

4. **Timeout handling:**
   - Monitor response times (should be <5s)
   - Verify hook doesn't timeout waiting for worker
   - Confirm fetch timeout protection works

5. **Worker failure scenarios:**
   - Test with worker not running (should show restart message)
   - Test with invalid jitEnabled value
   - Verify graceful error handling

**Success Criteria:**
- All test cases pass
- No "Claude Code executable not found" errors
- JIT context appears when enabled
- Performance acceptable (<2s for Haiku filtering)
- Feature flag properly controls behavior

## Technical Notes

### Timing Constraints
- Haiku SDK query: ~1-2 seconds
- Fetch timeout: 5 seconds
- Hook timeout: ~120 seconds
- Buffer: 3-4 seconds (comfortable margin)

### Files Modified

**Phase 1 (Worker):**
- `src/services/worker-service.ts` - Modify `/sessions/:id/init` endpoint
- New: `src/services/worker/JitContext.ts` (optional, for organization)

**Phase 2 (Hook):**
- `src/hooks/new-hook.ts` - Remove SDK code, consume worker response

**Phase 3 (Config):**
- No file changes, verification only

**Phase 4 (Build):**
- `plugin/scripts/new-hook.js` - Built output
- `plugin/scripts/worker-service.cjs` - Built output

### Dependencies
- SDK remains dependency for worker (already used by SDKAgent)
- SDK removed as dependency for hooks
- Shared settings utility used by both hook and worker

### Backward Compatibility
- JIT disabled by default (`CLAUDE_MEM_JIT_CONTEXT_ENABLED=false`)
- Existing behavior preserved when feature not enabled
- No breaking changes to session initialization flow

## Risk Assessment

**Low Risk:**
- Worker already uses SDK successfully (proven pattern)
- BLOCKING pattern already works for session init (proven pattern)
- Changes isolated to new-hook and worker init endpoint

**Mitigation:**
- Keep feature flag defaulting to false (opt-in)
- Preserve existing session init behavior when JIT disabled
- Add comprehensive error handling for worker failures
- Include timeout protection on fetch (already present)

## Rollback Plan

If implementation fails:
1. Set `CLAUDE_MEM_JIT_CONTEXT_ENABLED=false` (immediate mitigation)
2. Revert `src/hooks/new-hook.ts` to remove JIT logic entirely
3. Revert worker endpoint changes
4. Rebuild and sync
5. Restart worker

This restores system to pre-JIT state while keeping session init working.
