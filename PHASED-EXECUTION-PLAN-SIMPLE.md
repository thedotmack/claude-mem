# Phased Execution Plan: Remove Session Management Logic

**Goal**: Delete problematic session management code while keeping schema unchanged

**Approach**: Stop using certain columns/methods, but don't change the database structure

---

## PHASE 1: Simplify createSDKSession()

**File**: `src/services/sqlite/SessionStore.ts`

**Task**: Replace `createSDKSession()` with a pure INSERT OR IGNORE version

**Current code** (~line 1142-1178):
- Does INSERT OR IGNORE
- Then tries to UPDATE project/user_prompt if they changed
- Complex logic

**New code**:
```typescript
createSDKSession(claudeSessionId: string, project: string, userPrompt: string): number {
  const now = new Date();
  const nowEpoch = now.getTime();

  // Pure INSERT OR IGNORE - no updates, no complexity
  this.db.prepare(`
    INSERT OR IGNORE INTO sdk_sessions
    (claude_session_id, sdk_session_id, project, user_prompt, started_at, started_at_epoch, status)
    VALUES (?, ?, ?, ?, ?, ?, 'active')
  `).run(claudeSessionId, claudeSessionId, project, userPrompt, now.toISOString(), nowEpoch);

  // Return existing or new ID
  const row = this.db.prepare('SELECT id FROM sdk_sessions WHERE claude_session_id = ?')
    .get(claudeSessionId) as { id: number };
  return row.id;
}
```

**Verification**:
```bash
grep -A20 "createSDKSession(" src/services/sqlite/SessionStore.ts | head -25
# Should see simple INSERT OR IGNORE, no UPDATE logic
```

**Output**: Simplified createSDKSession method

---

## PHASE 2: Add getPromptNumberFromUserPrompts() Helper

**File**: `src/services/sqlite/SessionStore.ts`

**Task**: Add a new helper method to derive prompt number from user_prompts table

**Add this method**:
```typescript
/**
 * Get current prompt number by counting user_prompts for this session
 * Replaces the prompt_counter column which is no longer maintained
 */
getPromptNumberFromUserPrompts(claudeSessionId: string): number {
  const result = this.db.prepare(`
    SELECT COUNT(*) as count FROM user_prompts WHERE claude_session_id = ?
  `).get(claudeSessionId) as { count: number };
  return result.count;
}
```

**Verification**:
```bash
grep -n "getPromptNumberFromUserPrompts" src/services/sqlite/SessionStore.ts
# Should find the new method
```

**Output**: New helper method added

---

## PHASE 3: Delete Unused Session Management Methods

**File**: `src/services/sqlite/SessionStore.ts`

**Task**: Delete these 11 methods entirely:

1. `updateSDKSessionId()` (~line 1185-1205)
2. `findActiveSDKSession()` (~line 1043-1057)
3. `findAnySDKSession()` (~line 1062-1071)
4. `reactivateSession()` (~line 1076-1084)
5. `incrementPromptCounter()` (~line 1089-1103)
6. `getPromptCounter()` (~line 1108-1114)
7. `setWorkerPort()` (~line 1210-1218)
8. `getWorkerPort()` (~line 1223-1233)
9. `markSessionCompleted()` (~line 1419-1430)
10. `markSessionFailed()` (~line 1435-1446)
11. `getSdkSessionsBySessionIds()` (~line 1017-1038) - if unused

**Verification**:
```bash
# These should return no results after deletion
grep -n "incrementPromptCounter\|getPromptCounter\|setWorkerPort\|getWorkerPort" src/services/sqlite/SessionStore.ts
grep -n "markSessionCompleted\|markSessionFailed\|reactivateSession" src/services/sqlite/SessionStore.ts
grep -n "findActiveSDKSession\|findAnySDKSession\|updateSDKSessionId" src/services/sqlite/SessionStore.ts
```

**Output**: 11 methods deleted from SessionStore.ts

---

## PHASE 4: Remove Auto-Create from storeObservation()

**File**: `src/services/sqlite/SessionStore.ts`

**Task**: Remove session auto-creation logic from storeObservation()

**Find** (~line 1291-1312): The block that checks if session exists and creates it if not

**Delete** this pattern:
```typescript
// DELETE THIS BLOCK:
let sessionId = this.db.prepare(`SELECT id FROM sdk_sessions WHERE sdk_session_id = ?`).get(sdkSessionId);
if (!sessionId) {
  // auto-create session...
}
```

**Keep**: Just the INSERT INTO observations statement

The method should assume the session already exists. If it doesn't, the INSERT will fail with a foreign key error - which is correct behavior (means the hook is broken).

**Verification**:
```bash
grep -B5 -A15 "storeObservation(" src/services/sqlite/SessionStore.ts | grep -i "insert.*sdk_sessions"
# Should return nothing - no session creation in storeObservation
```

**Output**: storeObservation() no longer auto-creates sessions

---

## PHASE 5: Remove Auto-Create from storeSummary()

**File**: `src/services/sqlite/SessionStore.ts`

**Task**: Remove session auto-creation logic from storeSummary()

**Find** (~line 1367-1388): Similar pattern to storeObservation

**Delete** the session existence check and auto-create block

**Keep**: Just the INSERT INTO session_summaries statement

**Verification**:
```bash
grep -B5 -A15 "storeSummary(" src/services/sqlite/SessionStore.ts | grep -i "insert.*sdk_sessions"
# Should return nothing - no session creation in storeSummary
```

**Output**: storeSummary() no longer auto-creates sessions

---

## PHASE 6: Update SessionRoutes - Replace getPromptCounter

**File**: `src/services/worker/http/routes/SessionRoutes.ts`

**Task**: Replace calls to `getPromptCounter()` with `getPromptNumberFromUserPrompts()`

**Find**: All calls to `store.getPromptCounter(sessionDbId)`

**Replace with**: `store.getPromptNumberFromUserPrompts(claudeSessionId)`

Note: The new method takes `claudeSessionId` (string), not `sessionDbId` (number)

**Verification**:
```bash
grep -n "getPromptCounter" src/services/worker/http/routes/SessionRoutes.ts
# Should return nothing

grep -n "getPromptNumberFromUserPrompts" src/services/worker/http/routes/SessionRoutes.ts
# Should find the new calls
```

**Output**: SessionRoutes uses new prompt counting method

---

## PHASE 7: Update SessionManager - Replace getPromptCounter

**File**: `src/services/worker/SessionManager.ts`

**Task**: Replace call to `getPromptCounter()` in `initializeSession()`

**Find** (~line 116): `this.dbManager.getSessionStore().getPromptCounter(sessionDbId)`

**Replace with**:
```typescript
this.dbManager.getSessionStore().getPromptNumberFromUserPrompts(dbSession.claude_session_id)
```

**Verification**:
```bash
grep -n "getPromptCounter" src/services/worker/SessionManager.ts
# Should return nothing
```

**Output**: SessionManager uses new prompt counting method

---

## PHASE 8: Update SessionCompletionHandler

**File**: `src/services/worker/session/SessionCompletionHandler.ts`

**Task**: Remove call to `findActiveSDKSession()` and simplify

**Find**: Call to `store.findActiveSDKSession(claudeSessionId)`

**Replace**: Use a simpler query or remove the lookup if not needed

If the method just needs to find the session to delete it, we can query sdk_sessions directly:
```typescript
const session = store.db.prepare(
  'SELECT id FROM sdk_sessions WHERE claude_session_id = ?'
).get(claudeSessionId);
```

**Verification**:
```bash
grep -n "findActiveSDKSession" src/services/worker/session/SessionCompletionHandler.ts
# Should return nothing
```

**Output**: SessionCompletionHandler no longer uses deleted method

---

## PHASE 9: Update SDKAgent - Remove markSessionCompleted

**File**: `src/services/worker/SDKAgent.ts`

**Task**: Remove call to `markSessionCompleted()`

**Find** (~line 148): `this.dbManager.getSessionStore().markSessionCompleted(session.sessionDbId)`

**Action**: Delete this line entirely. We no longer track session status.

**Verification**:
```bash
grep -n "markSessionCompleted\|markSessionFailed" src/services/worker/SDKAgent.ts
# Should return nothing
```

**Output**: SDKAgent no longer marks sessions as completed

---

## PHASE 10: Update DatabaseManager - Remove markSessionComplete

**File**: `src/services/worker/DatabaseManager.ts`

**Task**: Remove the `markSessionComplete()` method

**Find** (~line 116-118): The `markSessionComplete` method

**Action**: Delete the entire method

**Verification**:
```bash
grep -n "markSessionComplete" src/services/worker/DatabaseManager.ts
# Should return nothing
```

**Output**: DatabaseManager no longer has session completion method

---

## PHASE 11: Search for Any Remaining References

**Task**: Find and fix any remaining references to deleted methods

**Search**:
```bash
# Search for all deleted method names
grep -rn "incrementPromptCounter\|getPromptCounter\|setWorkerPort\|getWorkerPort" src/ --include="*.ts"
grep -rn "markSessionCompleted\|markSessionFailed\|reactivateSession" src/ --include="*.ts"
grep -rn "findActiveSDKSession\|findAnySDKSession\|updateSDKSessionId" src/ --include="*.ts"
```

**Action**: Fix any remaining references found

**Output**: No references to deleted methods remain

---

## PHASE 12: Build and Test

**Task**: Verify everything compiles and works

**Commands**:
```bash
# Build
npm run build

# If build fails, fix TypeScript errors and rebuild
```

**Verification**:
- Build completes without errors
- No TypeScript errors about missing methods

**Output**: Clean build

---

## PHASE 13: Integration Test

**Task**: Test the complete flow

**Test steps**:
1. Start a new Claude Code session
2. Submit a prompt (triggers new-hook → createSDKSession)
3. Use some tools (triggers save-hook → storeObservation)
4. End session (triggers summary-hook → storeSummary)

**Verify in database**:
```bash
sqlite3 ~/.claude-mem/claude-mem.db "SELECT id, claude_session_id, project, status FROM sdk_sessions ORDER BY id DESC LIMIT 3;"
sqlite3 ~/.claude-mem/claude-mem.db "SELECT id, sdk_session_id, type, title FROM observations ORDER BY id DESC LIMIT 5;"
```

**Expected**:
- Sessions created with status='active' (never updated, that's fine)
- Observations saved correctly
- No errors in worker logs

**Output**: System works end-to-end

---

## PHASE 14: Cleanup Plan Files

**Task**: Delete the planning files

```bash
rm PLAN-REMOVE-SESSION-MANAGEMENT.md
rm PHASED-EXECUTION-PLAN.md
rm PHASED-EXECUTION-PLAN-SIMPLE.md
```

**Commit**:
```bash
git add -A
git commit -m "refactor: remove session management complexity

- Simplify createSDKSession to pure INSERT OR IGNORE
- Remove auto-create logic from storeObservation/storeSummary
- Delete 11 unused session management methods
- Derive prompt_number from user_prompts count
- Keep sdk_sessions table schema unchanged for compatibility"
```

**Output**: Clean commit with simplified session handling

---

## SUCCESS CRITERIA

After all phases complete, verify:

- [ ] `createSDKSession()` is pure INSERT OR IGNORE (no updates)
- [ ] `storeObservation()` has no session auto-create logic
- [ ] `storeSummary()` has no session auto-create logic
- [ ] 11 session management methods deleted
- [ ] `getPromptNumberFromUserPrompts()` exists and is used
- [ ] Build completes without errors
- [ ] Normal flow works (prompt → tools → observations → summary)
- [ ] No references to deleted methods in codebase
- [ ] Database schema unchanged (no migration needed)

---

## WHAT WE STOPPED USING (BUT DIDN'T DELETE FROM SCHEMA)

These columns in `sdk_sessions` are now dead:

| Column | Previously | Now |
|--------|-----------|-----|
| `status` | Updated to 'completed'/'failed' | Always 'active', never updated |
| `completed_at` | Set on session end | Never set |
| `completed_at_epoch` | Set on session end | Never set |
| `worker_port` | Tracked which worker | Never set |
| `prompt_counter` | Incremented per prompt | Ignored, derived from user_prompts |

These columns still work fine but we just don't write to them anymore. Existing data is preserved.

---

## PHILOSOPHY

**Before**: Complex session lifecycle management with status tracking, port assignment, prompt counting, auto-creation fallbacks

**After**: Simple lookup table. INSERT OR IGNORE on first prompt. That's it.

If data is missing, it's a bug in the hook. Fail loudly, don't paper over it.
