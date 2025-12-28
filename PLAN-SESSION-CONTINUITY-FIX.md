# Session Continuity Regression Fix - Phased Execution Plan

**Project**: claude-mem
**Issue**: Session continuity broken - each prompt creates new session instead of continuing existing one
**Root Cause**: Session SDK ID not propagated correctly from new-hook through to SDKAgent
**History**: Recurring issue over 3 months with 7 previous fix attempts that added complexity

---

## Phase 1: Add Diagnostic Logging

**Goal**: Add comprehensive logging to trace session ID and prompt number flow through the entire system.

**Context**: Session continuity requires `claudeSessionId` to flow from hook → SessionStore → SessionManager → SDKAgent. We need to verify this flow is working correctly.

**Files to Modify**:
1. `src/hooks/new-hook.ts`
2. `src/services/worker/http/routes/SessionRoutes.ts`
3. `src/services/worker/SessionManager.ts`
4. `src/services/worker/SDKAgent.ts`

**Implementation Steps**:

### 1.1 Add Logging to `src/hooks/new-hook.ts`

Add logging at these locations:

**Line ~24** (after receiving hook input):
```typescript
console.log('[NEW-HOOK] Received hook input:', {
  session_id: hookInput.session_id,
  has_prompt: !!hookInput.prompt,
  cwd: hookInput.cwd
});
```

**Line ~46-47** (before first API call):
```typescript
console.log('[NEW-HOOK] Calling /api/sessions/init:', {
  claudeSessionId: session_id,
  project,
  prompt_length: prompt?.length
});
```

**Line ~51** (after first API call):
```typescript
console.log('[NEW-HOOK] Received from /api/sessions/init:', {
  sessionDbId: sessionData.sessionDbId,
  promptNumber: sessionData.promptNumber,
  skipped: sessionData.skipped
});
```

**Line ~68** (before second API call):
```typescript
console.log('[NEW-HOOK] Calling /sessions/{sessionDbId}/init:', {
  sessionDbId: sessionData.sessionDbId,
  promptNumber: sessionData.promptNumber,
  userPrompt_length: cleanedPrompt?.length
});
```

### 1.2 Add Logging to `src/services/worker/http/routes/SessionRoutes.ts`

**In `handleSessionInitByClaudeId` method (~line 483)**:
```typescript
console.log('[SESSION-ROUTES] handleSessionInitByClaudeId called:', {
  claudeSessionId,
  project,
  prompt_length: prompt?.length
});
```

**After `createSDKSession` call (~line 493)**:
```typescript
console.log('[SESSION-ROUTES] createSDKSession returned:', {
  sessionDbId,
  claudeSessionId
});
```

**After prompt number calculation (~line 497)**:
```typescript
console.log('[SESSION-ROUTES] Calculated promptNumber:', {
  sessionDbId,
  promptNumber,
  currentCount
});
```

**In `handleSessionInit` method (~line 175)**:
```typescript
const { userPrompt, promptNumber } = req.body;
console.log('[SESSION-ROUTES] handleSessionInit called:', {
  sessionDbId,
  promptNumber,
  has_userPrompt: !!userPrompt
});
```

### 1.3 Add Logging to `src/services/worker/SessionManager.ts`

**In `initializeSession` method at start (~line 50)**:
```typescript
console.log('[SESSION-MANAGER] initializeSession called:', {
  sessionDbId,
  promptNumber,
  has_currentUserPrompt: !!currentUserPrompt
});
```

**When session exists in memory (~line 55)**:
```typescript
console.log('[SESSION-MANAGER] Returning cached session:', {
  sessionDbId,
  claudeSessionId: session.claudeSessionId,
  lastPromptNumber: session.lastPromptNumber
});
```

**After fetching from database (~line 87)**:
```typescript
console.log('[SESSION-MANAGER] Fetched session from database:', {
  sessionDbId,
  claude_session_id: dbSession.claude_session_id,
  sdk_session_id: dbSession.sdk_session_id
});
```

**When creating new session object (~line 109-116)**:
```typescript
console.log('[SESSION-MANAGER] Creating new session object:', {
  sessionDbId,
  claudeSessionId: dbSession.claude_session_id,
  lastPromptNumber: promptNumber || /* fallback value */
});
```

### 1.4 Add Logging to `src/services/worker/SDKAgent.ts`

**In `startSession` method (~line 72)**:
```typescript
console.log('[SDK-AGENT] Starting SDK query with:', {
  sessionDbId: session.sessionDbId,
  claudeSessionId: session.claudeSessionId,
  resume_parameter: session.claudeSessionId,
  lastPromptNumber: session.lastPromptNumber
});
```

**In `createMessageGenerator` method (~line 200)**:
```typescript
const isInitPrompt = session.lastPromptNumber === 1;
console.log('[SDK-AGENT] Creating message generator:', {
  sessionDbId: session.sessionDbId,
  claudeSessionId: session.claudeSessionId,
  lastPromptNumber: session.lastPromptNumber,
  isInitPrompt,
  promptType: isInitPrompt ? 'INIT' : 'CONTINUATION'
});
```

**Success Criteria**:
- [ ] All 15+ log points added across 4 files
- [ ] Build succeeds with no TypeScript errors
- [ ] Worker service restarts successfully

**Handoff to Phase 2**: After adding logging, build with `npm run build-and-sync`

---

## Phase 2: Test and Gather Diagnostic Data

**Goal**: Execute test conversation and collect logs to identify where session ID propagation breaks.

**Prerequisites**: Phase 1 completed, logging in place, worker service running

**Test Procedure**:

### 2.1 Start Fresh Conversation

In a new Claude Code session:
1. Clear any existing logs: `bun ~/.claude/plugins/marketplaces/thedotmack/scripts/worker-service.cjs > /tmp/worker-logs.txt 2>&1 &`
2. Send first prompt: "test prompt 1"
3. Send second prompt: "test prompt 2"
4. Send third prompt: "test prompt 3"

### 2.2 Collect Logs

View worker logs:
```bash
tail -f /tmp/worker-logs.txt | grep -E '\[NEW-HOOK\]|\[SESSION-ROUTES\]|\[SESSION-MANAGER\]|\[SDK-AGENT\]'
```

### 2.3 Check Database State

**Query 1 - Check sessions table**:
```bash
cd ~/.claude-mem
sqlite3 claude-mem.db "SELECT id, claude_session_id, sdk_session_id, status, started_at FROM sdk_sessions ORDER BY id DESC LIMIT 10;"
```

**Expected**: Same `claude_session_id` for all 3 prompts

**Query 2 - Check user prompts table**:
```bash
sqlite3 claude-mem.db "SELECT claude_session_id, prompt_number, created_at FROM user_prompts ORDER BY created_at DESC LIMIT 10;"
```

**Expected**: Same `claude_session_id` with prompt_number: 1, 2, 3

### 2.4 Analyze Data Flow

For each prompt (1, 2, 3), trace in logs:

1. **NEW-HOOK** receives `session_id` from Claude Code
2. **SESSION-ROUTES** receives `claudeSessionId` in API call
3. **SESSION-ROUTES** creates/gets `sessionDbId`
4. **SESSION-ROUTES** calculates `promptNumber`
5. **SESSION-MANAGER** fetches/creates session with `claudeSessionId`
6. **SDK-AGENT** uses `claudeSessionId` as resume parameter
7. **SDK-AGENT** selects INIT vs CONTINUATION prompt

**Key Questions to Answer**:
- [ ] Does `session_id` from hook stay the same across all 3 prompts?
- [ ] Does `claudeSessionId` match across all log entries for same conversation?
- [ ] Does `promptNumber` increment: 1, 2, 3?
- [ ] Does `lastPromptNumber` match `promptNumber` in SessionManager?
- [ ] Does SDK-AGENT receive correct `resume` parameter on prompts 2+?
- [ ] Does SDK-AGENT select CONTINUATION prompt for prompts 2+?

**Success Criteria**:
- [ ] Logs collected for 3 test prompts
- [ ] Database queries run and results saved
- [ ] Data flow analysis completed
- [ ] Failure point identified

**Handoff to Phase 3**: Document exact failure point (which log entry shows incorrect value) and move to fix implementation

---

## Phase 3: Implement Fix Based on Findings

**Goal**: Fix the identified root cause of session continuity failure.

**Prerequisites**: Phase 2 completed, failure point identified from logs/database

**Common Fix Scenarios**:

### Scenario A: Hook Receives Different `session_id` Each Time

**Symptom in Logs**:
```
[NEW-HOOK] Received hook input: { session_id: 'abc-123', ... }  // Prompt 1
[NEW-HOOK] Received hook input: { session_id: 'def-456', ... }  // Prompt 2 - DIFFERENT!
```

**Root Cause**: Hook not receiving consistent session ID from Claude Code

**Fix Location**: This is external to codebase - investigate Claude Code hook configuration or report bug

**Action**: Create GitHub issue in claude-code repo with evidence

### Scenario B: `promptNumber` Not Passed or Calculated Correctly

**Symptom in Logs**:
```
[SESSION-ROUTES] Calculated promptNumber: { promptNumber: 1, currentCount: 1 }  // Prompt 2 - WRONG!
```

**Root Cause**: User prompt not being saved to database, or count query failing

**Fix Location**: `src/services/worker/http/routes/SessionRoutes.ts` line 520

**Fix**:
```typescript
// Add error handling around saveUserPrompt
try {
  this.dbManager.getSessionStore().saveUserPrompt(
    claudeSessionId,
    promptNumber,
    cleanedPrompt
  );
  console.log('[SESSION-ROUTES] Successfully saved user prompt:', {
    claudeSessionId,
    promptNumber
  });
} catch (error) {
  console.error('[SESSION-ROUTES] Failed to save user prompt:', error);
  throw new Error(`Failed to save user prompt: ${error.message}`);
}
```

### Scenario C: Session Manager Uses Wrong Fallback Logic

**Symptom in Logs**:
```
[SESSION-MANAGER] Creating new session object: { lastPromptNumber: 1 }  // Prompt 2 - WRONG!
```

**Root Cause**: Fragile `||` operator causing incorrect fallback when `promptNumber` is valid

**Fix Location**: `src/services/worker/SessionManager.ts` line 116

**Fix**:
```typescript
// Replace fragile || with explicit undefined check
lastPromptNumber: promptNumber !== undefined
  ? promptNumber
  : this.dbManager.getSessionStore().getPromptNumberFromUserPrompts(dbSession.claude_session_id),
```

### Scenario D: Database Session Not Found

**Symptom in Logs**:
```
[SESSION-MANAGER] Fetched session from database: { claude_session_id: undefined }
```

**Root Cause**: `createSDKSession` INSERT failed silently, or session was deleted

**Fix Location**: `src/services/sqlite/SessionStore.ts` line 1086-1101

**Fix**:
```typescript
// Add validation after INSERT OR IGNORE
const result = this.db.prepare(`
  INSERT OR IGNORE INTO sdk_sessions
  (claude_session_id, sdk_session_id, project, user_prompt, started_at, started_at_epoch, status)
  VALUES (?, ?, ?, ?, ?, ?, 'active')
`).run(claudeSessionId, claudeSessionId, project, userPrompt, now, nowEpoch, 'active');

// Verify session exists
const row = this.db.prepare('SELECT id FROM sdk_sessions WHERE claude_session_id = ?')
  .get(claudeSessionId);

if (!row) {
  throw new Error(`Failed to create or retrieve SDK session for claudeSessionId: ${claudeSessionId}`);
}

return row.id;
```

### Scenario E: SDK Agent Receives Empty `claudeSessionId`

**Symptom in Logs**:
```
[SDK-AGENT] Starting SDK query with: { claudeSessionId: undefined, resume_parameter: undefined }
```

**Root Cause**: SessionManager created session object with missing `claudeSessionId`

**Fix Location**: `src/services/worker/SessionManager.ts` line 109

**Fix**:
```typescript
// Add validation before using database values
if (!dbSession.claude_session_id) {
  throw new Error(`Database session ${sessionDbId} has no claude_session_id`);
}

session = {
  sessionDbId,
  claudeSessionId: dbSession.claude_session_id,
  // ... rest of session object
};
```

**Success Criteria**:
- [ ] Fix implemented at identified failure point
- [ ] Validation added to fail loudly on errors
- [ ] Build succeeds
- [ ] Worker service restarts successfully

**Handoff to Phase 4**: Build and deploy fix, then run verification tests

---

## Phase 4: Verify Fix and Test Session Continuity

**Goal**: Confirm session continuity is working correctly after fix.

**Prerequisites**: Phase 3 completed, fix deployed, worker service running

**Verification Procedure**:

### 4.1 Run Full Test Conversation

In a fresh Claude Code session:

1. **Prompt 1**: "This is test prompt one for session continuity"
2. **Prompt 2**: "This is test prompt two, continuing the session"
3. **Prompt 3**: "This is test prompt three, still continuing"
4. **Prompt 4**: "Final test prompt four"

### 4.2 Check Logs

Verify in worker logs:

**All prompts show same `session_id`**:
```
[NEW-HOOK] Received hook input: { session_id: 'abc-123' }  // All 4 prompts
```

**Prompt numbers increment**:
```
[SESSION-ROUTES] Calculated promptNumber: { promptNumber: 1 }  // Prompt 1
[SESSION-ROUTES] Calculated promptNumber: { promptNumber: 2 }  // Prompt 2
[SESSION-ROUTES] Calculated promptNumber: { promptNumber: 3 }  // Prompt 3
[SESSION-ROUTES] Calculated promptNumber: { promptNumber: 4 }  // Prompt 4
```

**SDK Agent uses continuation prompts**:
```
[SDK-AGENT] Creating message generator: { promptType: 'INIT' }          // Prompt 1
[SDK-AGENT] Creating message generator: { promptType: 'CONTINUATION' }  // Prompt 2
[SDK-AGENT] Creating message generator: { promptType: 'CONTINUATION' }  // Prompt 3
[SDK-AGENT] Creating message generator: { promptType: 'CONTINUATION' }  // Prompt 4
```

### 4.3 Verify Database State

**Check sessions table**:
```bash
sqlite3 ~/.claude-mem/claude-mem.db "SELECT id, claude_session_id, sdk_session_id FROM sdk_sessions ORDER BY id DESC LIMIT 5;"
```

**Expected**: Only ONE session record for the 4 prompts, `claude_session_id` and `sdk_session_id` are identical

**Check user_prompts table**:
```bash
sqlite3 ~/.claude-mem/claude-mem.db "SELECT claude_session_id, prompt_number, created_at FROM user_prompts ORDER BY created_at DESC LIMIT 5;"
```

**Expected**: 4 records with same `claude_session_id`, prompt_number values: 4, 3, 2, 1

### 4.4 Functional Test

Verify actual session continuity behavior:

1. **Prompt 1**: "My favorite color is blue"
2. **Prompt 2**: "What is my favorite color?"
   - **Expected**: Response mentions "blue"
3. **Prompt 3**: "Change it to red"
4. **Prompt 4**: "What is my favorite color now?"
   - **Expected**: Response mentions "red"

**Success Criteria**:
- [x] Same `session_id` across all 4 prompts in logs
- [x] Prompt numbers increment: 1, 2, 3, 4
- [x] INIT prompt only for first prompt
- [x] CONTINUATION prompts for prompts 2, 3, 4
- [x] Only one session record in database
- [x] Four user_prompts records with incremental prompt_number
- [x] Functional test shows session continuity working

**Handoff to Phase 5**: If all criteria pass, proceed to cleanup. If any fail, return to Phase 2 with new diagnostic focus.

---

## Phase 5: Cleanup and Documentation

**Goal**: Remove excessive logging, update documentation, close issues.

**Prerequisites**: Phase 4 completed successfully, session continuity verified working

**Cleanup Steps**:

### 5.1 Reduce Logging Verbosity (Optional)

You can either:
- **Keep all diagnostic logging** for future debugging (recommended)
- **Remove logging** to reduce noise in production logs
- **Convert to debug level** if logging framework supports it

If removing logging, remove the `console.log` statements added in Phase 1 from:
- `src/hooks/new-hook.ts`
- `src/services/worker/http/routes/SessionRoutes.ts`
- `src/services/worker/SessionManager.ts`
- `src/services/worker/SDKAgent.ts`

### 5.2 Update Documentation

If the fix revealed any architectural insights, update:
- `CLAUDE.md` - Add any new gotchas or patterns discovered
- `README.md` - Update if user-facing behavior changed
- Code comments - Document the fix rationale

### 5.3 Create Regression Test (Future Work)

Consider adding automated test:
```typescript
describe('Session Continuity', () => {
  it('should use same session ID across multiple prompts', async () => {
    // Test that verifies session ID propagation
  });

  it('should increment prompt numbers correctly', async () => {
    // Test that verifies prompt number calculation
  });
});
```

### 5.4 Close Related Issues

Search GitHub for related issues:
```bash
gh issue list --search "session continuity" --state open
gh issue list --search "session persistence" --state open
gh issue list --search "new session" --state open
```

Close with comment explaining the fix.

**Success Criteria**:
- [ ] Logging cleaned up as desired
- [ ] Documentation updated
- [ ] Related GitHub issues closed
- [ ] No regressions introduced

---

## Quick Reference

### Key Files and What They Do

| File | Purpose | Critical Lines |
|------|---------|----------------|
| `src/hooks/new-hook.ts` | Hook entry point, receives session_id from Claude Code | 24, 34, 46-47, 63-68 |
| `src/services/worker/http/routes/SessionRoutes.ts` | HTTP endpoints for session init, calculates prompt numbers | 482-533, 171-227 |
| `src/services/sqlite/SessionStore.ts` | Database operations for sessions and user prompts | 1086-1101, 1053-1058 |
| `src/services/worker/SessionManager.ts` | In-memory session management, bridges DB and SDK | 49-141, esp. 109, 116 |
| `src/services/worker/SDKAgent.ts` | SDK integration, sends resume parameter and prompts | 68-77, 195-218, 200-202 |
| `src/sdk/prompts.ts` | Init and continuation prompt templates | 30-87, 169-229 |

### Build and Deploy Commands

```bash
# Build TypeScript
npm run build

# Sync to marketplace and restart worker
npm run build-and-sync

# Restart worker only
killall bun
bun ~/.claude/plugins/marketplaces/thedotmack/scripts/worker-service.cjs &

# Check worker is running
curl http://localhost:37777/health
```

### Database Queries

```bash
# Check sessions
sqlite3 ~/.claude-mem/claude-mem.db "SELECT * FROM sdk_sessions ORDER BY id DESC LIMIT 10;"

# Check user prompts
sqlite3 ~/.claude-mem/claude-mem.db "SELECT * FROM user_prompts ORDER BY created_at DESC LIMIT 10;"

# Count prompts per session
sqlite3 ~/.claude-mem/claude-mem.db "SELECT claude_session_id, COUNT(*) as prompt_count FROM user_prompts GROUP BY claude_session_id ORDER BY prompt_count DESC LIMIT 10;"
```

### Debugging Tips

1. **Check worker is running**: `curl http://localhost:37777/health`
2. **View worker logs**: `tail -f /tmp/worker-logs.txt`
3. **Check hook output**: Logs appear in Claude Code's stderr
4. **Database locked**: `killall bun` then restart worker
5. **Stale build**: `rm -rf plugin/scripts/*.js && npm run build`

---

## Phase Execution Checklist

Use this checklist when executing phases in new chat contexts:

**Phase 1: Diagnostic Logging**
- [ ] Read this plan document
- [ ] Read the 4 files to modify
- [ ] Add all 15+ log points
- [ ] Build with `npm run build-and-sync`
- [ ] Verify worker restarts
- [ ] Mark phase complete, handoff to Phase 2

**Phase 2: Test and Gather Data**
- [ ] Read Phase 2 section
- [ ] Run 3 test prompts
- [ ] Collect and save logs
- [ ] Run database queries
- [ ] Trace data flow
- [ ] Identify failure point
- [ ] Document failure point
- [ ] Mark phase complete, handoff to Phase 3

**Phase 3: Implement Fix**
- [ ] Read Phase 3 section
- [ ] Review failure point from Phase 2
- [ ] Select applicable scenario
- [ ] Implement fix
- [ ] Add validation
- [ ] Build and deploy
- [ ] Mark phase complete, handoff to Phase 4

**Phase 4: Verify Fix**
- [ ] Read Phase 4 section
- [ ] Run 4 test prompts
- [ ] Check logs for correct behavior
- [ ] Verify database state
- [ ] Run functional test
- [ ] All success criteria pass
- [ ] Mark phase complete, handoff to Phase 5

**Phase 5: Cleanup**
- [ ] Read Phase 5 section
- [ ] Clean up logging (optional)
- [ ] Update documentation
- [ ] Close GitHub issues
- [ ] Mark phase complete
- [ ] Session continuity regression FIX COMPLETE ✅

---

## Context for New Chat Sessions

When starting a new phase, provide this context:

**I'm working on Phase [X] of the Session Continuity Regression Fix for claude-mem.**

**Background**: Session continuity is broken - each prompt creates a new session instead of continuing. This has been a recurring issue for 3 months. The root cause is that session SDK ID is not being propagated correctly from new-hook through to SDKAgent.

**Current Status**: [Briefly describe what previous phases accomplished]

**This Phase Goal**: [Copy the goal from the phase section]

**Plan Document**: Read `/Users/alexnewman/Scripts/claude-mem/PLAN-SESSION-CONTINUITY-FIX.md` for full context.

---

## Success Metrics

**Overall Fix Success**:
- [ ] Same session ID used across multiple prompts in one conversation
- [ ] Prompt numbers increment correctly (1, 2, 3, ...)
- [ ] Init prompt only sent on first prompt
- [ ] Continuation prompts sent on subsequent prompts
- [ ] SDK receives correct resume parameter
- [ ] Only one session record created per conversation
- [ ] Functional session continuity test passes
- [ ] No new regressions introduced

**Regression Prevention**:
- [ ] Validation added to fail loudly on errors
- [ ] No silent fallbacks that hide bugs
- [ ] Database queries verified
- [ ] Session ID propagation explicitly tested

---

**Last Updated**: 2025-12-27
**Author**: Claude (investigating 3-month recurring session continuity regression)
