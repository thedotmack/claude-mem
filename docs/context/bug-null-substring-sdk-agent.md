# Bug Report: Null Pointer Error in SDK Agent (`substring` crash)

**Date:** 2025-11-13
**Severity:** High (Production crash)
**Status:** Ready to Fix
**Estimated Time:** 30-60 minutes

---

## Problem Statement

The worker service crashes with a null pointer error when processing observations:

```
[2025-11-13 21:01:54.171] [ERROR] [SDK   ] ✗ Agent error {sessionDbId=17} Cannot read properties of null (reading 'substring')
[2025-11-13 21:01:54.174] [ERROR] [SDK   ] [session-17] ✗ SDK agent error Cannot read properties of null (reading 'substring')
```

**Impact:**
- PostToolUse hook fails when this error occurs
- Observations are not stored
- User sees hook errors in terminal
- Worker continues running but drops observations

**Workaround:** Restart worker with `cd ~/.claude/plugins/marketplaces/thedotmack && npx pm2 restart claude-mem-worker`

---

## Root Cause Analysis (Core 4 Framework)

### Context: What Information Led to This Bug?
- User was actively using claude-mem plugin during a session
- Worker was processing tool observations from PostToolUse hook
- Error occurred during SDK agent processing (prompt number 5, session 17)
- Right before crash, agent successfully processed an observation about "Complexity Philosophy"

### Model: What Component Failed?
- **Component:** SDK Agent (observation processing)
- **File Location:** Likely `src/services/worker/SDKAgent.ts` OR `src/sdk/parser.ts`
- **Operation:** Parsing observation XML response or extracting metadata

### Prompt: What Was Being Processed?
From logs, the SDK agent was processing:
```
[2025-11-13 21:01:54.169] [INFO] [SDK] [session-17] ← Response received (3068 chars) {promptNumber=5}
<observation>
  <type>discovery</type>
  <title>Complexity Philosophy: Documented Target of <...
```

Something in this observation triggered the `.substring()` call on a null value.

### Tools: What Code Path Failed?

**Known TypeScript errors in related files:**
1. `src/sdk/parser.ts` - Lines 150-154: Type `string | null` not assignable to `string`
2. `src/services/worker/SDKAgent.ts` - Potential null access on `obs.title`

**Hypothesis:** The parser or SDK agent tries to call `.substring()` on:
- `obs.title` (could be null)
- `obs.subtitle` (could be null)
- `obs.narrative` (could be null)
- Some extracted text field

---

## Evidence

### PM2 Logs
```bash
# Error log location
~/.pm2/logs/claude-mem-worker-error.log

# Last occurrence
[2025-11-13 21:01:54.171] [ERROR] [SDK] Cannot read properties of null (reading 'substring')
```

### TypeScript Errors (42 total)
Running `npx tsc --noEmit` shows related errors:
- `parser.ts:150-154` - Null handling issues
- `SDKAgent.ts` - Missing null guards

### Reproduction
1. Start worker: `cd ~/.claude/plugins/marketplaces/thedotmack && npx pm2 start plugin/scripts/worker-service.cjs --name claude-mem-worker`
2. Use Claude Code normally
3. Observe PostToolUse hook errors
4. Check logs: `npx pm2 logs claude-mem-worker --err --lines 50`

---

## Solution Approach

### Step 1: Find the `.substring()` Call
**Search strategy:**
```bash
# Search for substring calls in SDK agent and parser
grep -n "\.substring" src/services/worker/SDKAgent.ts src/sdk/parser.ts

# Check for property access without null checks
grep -n "obs\.title\|obs\.subtitle\|obs\.narrative" src/services/worker/SDKAgent.ts
```

### Step 2: Add Defensive Null Check
**Pattern to apply:**
```typescript
// ❌ BEFORE (crashes if field is null)
const excerpt = obs.title.substring(0, 100);

// ✅ AFTER (safe)
const excerpt = obs.title?.substring(0, 100) || '';
// OR
const excerpt = (obs.title || '').substring(0, 100);
```

### Step 3: Verify the Fix
```bash
# 1. Rebuild
npm run build

# 2. Sync to plugin
npm run sync-marketplace

# 3. Restart worker
cd ~/.claude/plugins/marketplaces/thedotmack && npx pm2 restart claude-mem-worker

# 4. Monitor logs
npx pm2 logs claude-mem-worker --err

# 5. Verify no more substring errors
```

### Step 4: Test Coverage
Add test case to prevent regression:
```typescript
// tests/sdk-agent.test.ts or tests/parser.test.ts
it('should handle null title without crashing', () => {
  const obs = { title: null, subtitle: 'test', narrative: 'text' };
  const result = extractExcerpt(obs); // Should not throw
  assert.strictEqual(result, '');
});
```

---

## Files to Investigate (Priority Order)

### 1. `/workspaces/claude-mem/src/services/worker/SDKAgent.ts`
**Why:** Processes observation responses, likely accesses obs.title/subtitle/narrative
**Lines to check:** Any `.substring()` calls, property access without null checks
**Current issues:** TypeScript warning about potential null access

### 2. `/workspaces/claude-mem/src/sdk/parser.ts`
**Why:** Parses XML observation responses, extracts fields
**Lines to check:** 150-154 (known TypeScript error about `string | null`)
**Current issues:** Return type `string | null` not compatible with `string`

### 3. `/workspaces/claude-mem/src/sdk/prompts.ts`
**Why:** Builds observation prompts, might format observation data
**Lines to check:** Any string manipulation of observation fields

---

## Quick Start for Fresh Claude

**Your mission:** Fix the null pointer bug causing worker crashes.

**Context you need:**
1. Worker service processes observations from Claude Code sessions
2. SDK agent uses Claude API to extract structured observations
3. Parser converts XML responses to observation objects
4. Something tries to call `.substring()` on a null field

**What to do:**
1. Search for `.substring()` calls in SDKAgent.ts and parser.ts
2. Find which observation field (title, subtitle, narrative) is null
3. Add null check before the `.substring()` call
4. Test by rebuilding, syncing, and restarting worker
5. Verify PM2 logs show no more "substring" errors

**Success criteria:**
- ✅ No "Cannot read properties of null (reading 'substring')" errors
- ✅ PostToolUse hook works without errors
- ✅ Observations are successfully stored
- ✅ TypeScript error count reduced (42 → 41)

**Commands you'll need:**
```bash
# Find the bug
grep -n "\.substring" src/services/worker/SDKAgent.ts src/sdk/parser.ts

# After fixing
npm run build
npm run sync-marketplace
cd ~/.claude/plugins/marketplaces/thedotmack && npx pm2 restart claude-mem-worker

# Verify
npx pm2 logs claude-mem-worker --err --lines 20
```

---

## Core 4 Summary (For Next Claude)

**Context:**
- Worker crashes with null pointer error during observation processing
- Error: "Cannot read properties of null (reading 'substring')"
- Occurs in SDK agent when processing observation XML responses

**Model:**
- SDK Agent component (processes observations)
- Parser component (parses XML to objects)
- One of these has a `.substring()` call without null check

**Prompt:**
- Find the `.substring()` call
- Add defensive null check
- Test and verify fix

**Tools:**
- grep (search for substring calls)
- TypeScript (shows null handling errors)
- PM2 logs (verify fix works)
- npm run build/sync-marketplace (deploy fix)

---

## Additional Context

**This is Quick Win #1** from the contribution roadmap:
- Time: 30-60 minutes
- Impact: Fixes production crash
- Part of fixing 42 TypeScript errors
- Good first contribution

**Related Issues:**
- TypeScript has 42 compilation errors (this is one of them)
- Only 4.7% test coverage (no tests for SDK agent/parser)
- No null safety guards in observation processing

**After this fix:**
- Consider adding tests for null handling
- Could fix other TypeScript errors in same files
- Could add defensive programming pattern to other components

---

## References

**Logs location:** `~/.pm2/logs/claude-mem-worker-error.log`
**Build command:** `npm run build && npm run sync-marketplace`
**Worker restart:** `cd ~/.claude/plugins/marketplaces/thedotmack && npx pm2 restart claude-mem-worker`
**Health check:** `curl http://localhost:37777/health`

**Related Documentation:**
- `/workspaces/claude-mem/CLAUDE.md` - Project architecture
- `/workspaces/claude-mem/docs/context/worker-service-overhead.md` - Worker service analysis
- TypeScript errors: Run `npx tsc --noEmit` to see all 42 errors

---

## Success Story Template (After Fix)

When you fix this, document:
1. Which file had the bug (SDKAgent.ts or parser.ts?)
2. Which field was null (title, subtitle, narrative?)
3. What line number had the `.substring()` call
4. What null check pattern you used
5. How you verified it works (PM2 logs clean)

This helps future contributors understand the codebase better!
