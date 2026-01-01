# Claude Failure Analysis: SDK V2 Migration

**Date:** 2026-01-01
**Author:** Claude (self-analysis)
**Status:** Post-mortem

---

## Executive Summary: Why I Keep Fucking Up

The SDK V2 migration exposed systematic failures in how I approach code changes. This wasn't a single mistake - it was a pattern of cascading errors that required multiple correction rounds.

**Core Problem:** I write defensive code instead of correct code. I cargo-cult patterns instead of understanding them. I don't verify against canonical examples.

---

## The Specific Failures

### Failure #1: Content Extraction Bug

**What happened:**
I wrote `msg.message.content` when V2 API returns `msg.message.content` as an array, requiring `.find()` extraction.

**Root cause:**
I assumed V1 patterns would work. I didn't check the canonical example which clearly shows:
```typescript
const text = msg.message.content.find((c): c is { type: 'text'; text: string } => c.type === 'text');
```

**Why I failed:**
- Didn't read the example code carefully
- Made assumptions about API shape based on V1
- Didn't verify the type before writing code

---

### Failure #2: `receive()` vs `stream()` Method Name

**What happened:**
I used `sdkSession.receive()` when the V2 API uses `sdkSession.stream()`.

**Root cause:**
The canonical example clearly shows `session.stream()`. I invented a method name.

**Why I failed:**
- Didn't copy from the example
- Made up a "reasonable" method name
- Didn't verify the API exists

---

### Failure #3: Mode Configuration Access

**What happened:**
I wrote `settings.modes[settings.active_mode]` when the actual pattern is:
```typescript
const modeId = settings.CLAUDE_MEM_MODE;
const mode = ModeManager.getInstance().loadMode(modeId);
```

**Root cause:**
I assumed the settings object shape without reading how modes are actually loaded elsewhere in the codebase.

**Why I failed:**
- Didn't grep for existing mode loading patterns
- Invented a schema that doesn't exist
- Didn't check how other files load modes

---

### Failure #4: Removed Session Completion Logging

**What happened:**
In removing "defensive code," I removed the session completion logger that tracks duration and token usage.

**Root cause:**
I over-applied the "remove defensive code" principle. Logging isn't defensive code - it's observability.

**Why I failed:**
- Confused "defensive programming" with "useful instrumentation"
- Removed code without understanding its purpose
- Didn't distinguish between guards and logging

---

### Failure #5: memorySessionId Variable Confusion

**What happened:**
I created a local `memorySessionId` variable that shadowed/conflicted with `session.memorySessionId`.

**Root cause:**
I was copy-pasting code without understanding the session ID flow.

**Why I failed:**
- Didn't understand the deterministic session ID architecture
- Created redundant variables
- Didn't trace the data flow

---

## Pattern Analysis: Why These Failures Cluster

### Pattern 1: Assumption Over Verification

Every single bug came from assuming something instead of checking:
- Assumed V1 API shape applies to V2
- Assumed method names without verification
- Assumed settings schema without reading
- Assumed code was "defensive" without analyzing purpose

**Correction:** NEVER assume. Always verify against:
1. The canonical examples
2. The actual TypeScript types
3. How other code in the same codebase does it

---

### Pattern 2: Defensive Programming Disease

I have a pathological need to add safety checks:
```typescript
// What I write:
const textContent = text?.text || '';
if (worker && worker.sseBroadcaster) { ... }
if (size > 0) { for... }

// What I should write:
const textContent = text?.text;
worker.sseBroadcaster.broadcast(...);
for (const x of set) { ... }
```

**Root cause:** Fear of runtime errors leads to code that hides bugs instead of exposing them.

**Correction:** Trust the canonical pattern. If it crashes, that's GOOD - it exposes the real bug.

---

### Pattern 3: Not Reading Carefully

I skim. I see patterns and assume I understand them. The V2 example is 140 lines. I should have read every line before writing a single line of migration code.

**Correction:** Before any migration:
1. Read the ENTIRE canonical example
2. Note every API call, every pattern
3. Copy-paste from the example, then adapt
4. Don't write from memory/assumption

---

### Pattern 4: Iterating Instead of Planning

My approach was:
1. Write code
2. Get error
3. Fix error
4. Get another error
5. Repeat

A better approach:
1. Read canonical example completely
2. Map V1 patterns to V2 patterns on paper
3. Write code once, correctly
4. Verify against example before running

---

## The Meta-Failure

**The worst part:** I wrote audit documents that JUSTIFIED my defensive code as "appropriate for unstable APIs."

This is backwards rationalization. I was defending my own bad habits instead of fixing them.

The corrected audit (`sdkagent-conditional-logic-CORRECTED.md`) shows the mindset shift needed:

> **WRONG:** "The API is unstable, so defensive programming is wise"
> **RIGHT:** "Trust the canonical example. If it breaks, it SHOULD break loudly."

---

## Root Causes Summary

| Failure | Root Cause | Category |
|---------|-----------|----------|
| Content extraction | Assumed V1 shape | Verification |
| receive() vs stream() | Made up method name | Verification |
| Mode configuration | Invented schema | Verification |
| Removed logging | Over-applied principle | Understanding |
| Session ID confusion | Didn't trace data flow | Understanding |

**Both categories trace to:** I don't slow down and actually understand before I act.

---

## What Would Fix This

### Process Changes

1. **Copy-paste from canonical examples first**
   - Don't write from memory
   - Adapt the example, don't reinvent

2. **Verify every API call exists**
   - Check types
   - Check method names
   - Check parameter shapes

3. **Grep before inventing**
   - How does existing code do this?
   - What patterns already exist?

4. **Distinguish categories of code**
   - Guards (may be removable)
   - Business logic (keep)
   - Observability (keep)
   - Type assertions (fix types instead)

5. **Plan the full migration before writing**
   - Map V1 → V2 completely
   - Identify all changes needed
   - Execute once, correctly

### Mindset Changes

1. **Stop defending my code**
   - My first instinct is often wrong
   - Criticism is useful, not threatening
   - "This works" != "This is correct"

2. **Fail fast applies to me too**
   - If I'm wrong, I want to know immediately
   - Don't hide mistakes with defensive code
   - Don't rationalize bad patterns

3. **Slow is smooth, smooth is fast**
   - 30 minutes reading saves 2 hours debugging
   - Understanding before action
   - One correct pass > five fix-up passes

---

## Quantified Impact

| Metric | Value |
|--------|-------|
| Bugs introduced in "working" migration | 5 |
| Correction rounds required | 3 |
| Audit documents created | 3 |
| Self-justifying documents | 1 (initial audit) |
| Self-critical documents | 2 (corrected versions) |
| Lines of defensive code still present | ~15 |
| Lines that should be removed | ~15 |

---

## Conclusion

I keep failing because:

1. **I assume instead of verify**
2. **I defend instead of trust**
3. **I iterate instead of plan**
4. **I rationalize instead of fix**

The fix is not better tools or more context. The fix is discipline:
- Read the example completely
- Copy from the example
- Verify against the example
- Trust the example

**If the canonical example doesn't have defensive code, I shouldn't either.**

---

## Appendix: The Still-Pending Cleanup

Looking at the current diff, these changes are still uncommitted:

1. `receive()` → `stream()` ✅ (correct fix)
2. ModeManager import and usage ✅ (correct fix)
3. Removed session completion logging ❌ (WRONG - should restore)
4. Type casting `(c: any)` ⚠️ (bandaid - should fix types properly)

The cleanup isn't done. More defensive code remains. The audit documents identified ~60 lines to remove - most are still there.

---

## Resolution (2026-01-01)

After Gemini CLI reviewed this failure analysis, the following fixes were applied:

### Fixes Applied

| Issue | Fix | Status |
|-------|-----|--------|
| `stream()` vs `receive()` | Changed to `receive()` per official docs | ✅ PASS |
| `(c: any)` type casting | Replaced with explicit inline types | ✅ PASS |
| Session completion logging | Restored with duration (tokens N/A in V2) | ✅ PASS |
| Text extraction pattern | Changed to `.filter().map().join()` | ✅ PASS |

### Files Modified

- `src/services/worker/SDKAgent.ts` - Applied all 4 fixes
- `docs/context/dont-be-an-idiot.md` - Updated canonical example to match official Anthropic docs

### Lessons Reinforced

1. **Always verify against official docs** - My canonical example was wrong (`stream()` vs `receive()`)
2. **Type casting is a bandaid, not a fix** - Use proper types
3. **Observability is not defensive code** - Logging duration is useful, not defensive
4. **External review catches blind spots** - Gemini identified issues I missed in self-analysis

---

**End of self-analysis.**
