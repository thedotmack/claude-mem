# Plan: Cleanup worker-service.ts Unjustified Logic

**Created:** 2026-01-13
**Source:** `docs/reports/nonsense-logic.md`
**Target:** `src/services/worker-service.ts` (813 lines)
**Goal:** Address 23 identified issues, prioritizing safe deletions first

---

## Phase 0: Documentation Discovery (COMPLETED)

### Evidence Gathered

**Exit Code Strategy (CLAUDE.md:44-54):**
```
- Exit 0: Success or graceful shutdown (Windows Terminal closes tabs)
- Exit 1: Non-blocking error
- Exit 2: Blocking error
Philosophy: Exit 0 prevents Windows Terminal tab accumulation
```

**Signal Handler Pattern (ProcessManager.ts:294-317):**
- Uses mutable reference object `isShuttingDownRef`
- Factory function `createSignalHandler()` returns handler with embedded state
- Current implementation has 3-hop indirection

**MCP Client Pattern (worker-service.ts:157-160, ChromaSync.ts:124-136):**
```typescript
this.mcpClient = new Client({
  name: 'worker-search-proxy',
  version: '1.0.0'
}, { capabilities: {} });
```

**Verification Results:**
- `runInteractiveSetup` (lines 439-639): **NEVER CALLED** - grep shows only definition
- `import * as fs from 'fs'` (line 13): **UNUSED** - no `fs.` usage found
- `import { spawn } from 'child_process'` (line 14): **UNUSED** - no `spawn(` calls
- `homedir` (line 15): Only used in `runInteractiveSetup` (dead code)
- `processPendingQueues` default `= 10`: Never used, all callers pass explicit args

---

## Phase 1: Safe Deletions (Dead Code & Unused Imports)

### 1.1 Delete `runInteractiveSetup` Function

**What:** Delete lines 435-639 (~201 lines)
**Why:** Function is defined but never called. Setup happens via `handleCursorCommand()`.
**Evidence:** `grep -n "runInteractiveSetup" src/services/worker-service.ts` returns only definition

**Pattern to follow:** N/A - straight deletion

**Steps:**
1. Read worker-service.ts lines 435-650
2. Delete the entire function including section comment (lines 435-639)
3. Run `npm run build` to verify no compile errors

**Verification:**
- `grep "runInteractiveSetup" src/` returns nothing
- Build succeeds

### 1.2 Remove Unused Imports

**What:** Delete lines 13, 14, 17

**Current (delete these):**
```typescript
import * as fs from 'fs';           // Line 13 - UNUSED
import { spawn } from 'child_process';  // Line 14 - UNUSED
import * as readline from 'readline';   // Line 17 - Only in dead code
```

**Keep:**
```typescript
import { homedir } from 'os';  // Line 15 - DELETE (only in dead code)
import { existsSync, writeFileSync, readFileSync, mkdirSync } from 'fs';  // Line 16 - CHECK USAGE
```

**Steps:**
1. After deleting `runInteractiveSetup`, grep for remaining usages:
   - `grep "homedir" src/services/worker-service.ts`
   - `grep "readline" src/services/worker-service.ts`
   - `grep "detectClaudeCode\|findCursorHooksDir\|installCursorHooks\|configureCursorMcp" src/services/worker-service.ts`
2. Delete imports with zero usages
3. Run `npm run build`

**Verification:**
- No TypeScript unused import warnings
- Build succeeds

### 1.3 Clean Up Cursor Integration Imports

After deleting `runInteractiveSetup`, some CursorHooksInstaller imports become unused:
- `detectClaudeCode` - only in runInteractiveSetup
- `findCursorHooksDir` - only in runInteractiveSetup
- `installCursorHooks` - only in runInteractiveSetup
- `configureCursorMcp` - only in runInteractiveSetup

**Steps:**
1. Grep each import after dead code removal
2. Remove any that are now unused
3. Keep `updateCursorContextForProject` (re-exported) and `handleCursorCommand` (used in main)

**Verification:**
- `grep "detectClaudeCode\|findCursorHooksDir\|installCursorHooks\|configureCursorMcp" src/services/worker-service.ts` returns nothing
- Build succeeds

---

## Phase 2: Low-Risk Simplifications

### 2.1 Remove Unused Default Parameter

**What:** Line 350 - `async processPendingQueues(sessionLimit: number = 10)`
**Why:** Default never used. All callers pass explicit args (50 in startup, dynamic in HTTP)

**Change from:**
```typescript
async processPendingQueues(sessionLimit: number = 10): Promise<{...}>
```

**Change to:**
```typescript
async processPendingQueues(sessionLimit: number): Promise<{...}>
```

**Verification:**
- Build succeeds
- All call sites provide explicit values

### 2.2 Simplify onRestart Callback

**Location:** Lines 395-396 (approximate, find exact)
**Issue:** `onShutdown` and `onRestart` both call `this.shutdown()`

**Find pattern:**
```typescript
onShutdown: () => this.shutdown(),
onRestart: () => this.shutdown()
```

**Options:**
1. **Keep as-is** if restart semantically differs from shutdown (future-proofing)
2. **Add comment** explaining intentional parity
3. **Remove onRestart** if never used differently

**Investigation needed:** Grep for `onRestart` usage in Server.ts to understand contract

**Steps:**
1. Grep `onRestart` in `src/services/server/`
2. If Server.ts treats them identically, add clarifying comment
3. If different, document why both map to shutdown

### 2.3 Fix Over-Commented Lines (Sample Only)

**Strategy:** Do NOT strip all comments. Only remove comments that describe obvious code.

**Anti-pattern (remove):**
```typescript
// WHAT: Imports centralized logging utility with structured output
// WHY: All worker logs go through this for consistent formatting
import { logger } from '../utils/logger.js';
```

**Pattern to follow:** Remove WHAT/WHY on simple imports. Keep architectural comments.

**Scope:** Sample 5-10 obvious comment removals to demonstrate approach, not exhaustive

---

## Phase 3: Medium-Risk Improvements

### 3.1 Simplify Signal Handler Pattern

**Current (worker-service.ts:180-192 + ProcessManager.ts:294-317):**
```typescript
// 3-hop indirection with mutable reference
const shutdownRef = { value: this.isShuttingDown };
const handler = createSignalHandler(() => this.shutdown(), shutdownRef);
process.on('SIGTERM', () => {
  this.isShuttingDown = shutdownRef.value;  // Sync back
  handler('SIGTERM');
});
```

**Simplified approach:**
```typescript
private registerSignalHandlers(): void {
  const handler = async (signal: string) => {
    if (this.isShuttingDown) {
      logger.warn('SYSTEM', `Received ${signal} but shutdown already in progress`);
      return;
    }
    this.isShuttingDown = true;
    logger.info('SYSTEM', `Received ${signal}, shutting down...`);
    try {
      await this.shutdown();
      process.exit(0);
    } catch (error) {
      logger.error('SYSTEM', 'Error during shutdown', {}, error as Error);
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => handler('SIGTERM'));
  process.on('SIGINT', () => handler('SIGINT'));
}
```

**Decision needed:** Does `createSignalHandler` serve other callers? If yes, keep factory but simplify worker usage.

**Steps:**
1. Grep `createSignalHandler` usage across codebase
2. If only worker-service uses it, inline and simplify
3. If shared, simplify worker's usage while keeping factory

### 3.2 Unify Dual Initialization Tracking

**Current (lines 111, 129-130):**
```typescript
private initializationCompleteFlag: boolean = false;
private initializationComplete: Promise<void>;
```

**Recommendation:** Keep both but add clarifying comments:
- Promise: For async waiters (HTTP handlers)
- Flag: For sync checks (status endpoints)

**Alternative:** Use Promise with inspection pattern:
```typescript
private initializationComplete = false;
private initializationPromise: Promise<void>;
// Flag derived from promise state via finally() callback
```

**Steps:**
1. Add documentation comment explaining dual tracking purpose
2. Consider if flag can be derived from promise state instead

### 3.3 Reduce 5-Minute Timeout

**Location:** Lines 464-478 (approximate)
**Current:** `const timeoutMs = 300000; // 5 minutes`
**Recommendation:** Reduce to 30-60 seconds for HTTP handler, keep 5min for MCP init

**Caution:** MCP initialization can legitimately be slow (ChromaDB, model loading). May need different timeouts per use case.

**Steps:**
1. Find exact line for context inject timeout
2. Verify this is separate from MCP init timeout
3. Reduce HTTP handler timeout to 30-60 seconds
4. Keep MCP init timeout at 5 minutes

---

## Phase 4: Deferred / Low Priority

These items are noted but NOT part of this cleanup:

| Issue | Reason to Defer |
|-------|-----------------|
| Exit code 0 always | Documented Windows Terminal workaround - intentional |
| Re-export for circular import | Works correctly, architectural fix is separate work |
| Fallback agent verification | Behavioral change, needs feature design |
| MCP version hardcoding | Low impact, separate version management issue |
| Empty capabilities | Documentation issue only |
| Unsafe `as Error` casts | Common TS pattern, low risk |

---

## Phase 5: Verification

### 5.1 Build Verification
```bash
npm run build
```
Expected: No errors

### 5.2 Test Suite
```bash
npm test
```
Expected: All tests pass

### 5.3 Grep for Anti-patterns
```bash
# Verify dead code removed
grep -r "runInteractiveSetup" src/

# Verify unused imports removed
grep "import \* as fs from 'fs'" src/services/worker-service.ts
grep "import { spawn }" src/services/worker-service.ts
```
Expected: No matches

### 5.4 Runtime Check
```bash
npm run build-and-sync
# Start worker and verify basic operation
```

---

## Summary

| Phase | Items | Estimated Reduction |
|-------|-------|---------------------|
| Phase 1 | Dead code + unused imports | ~210 lines |
| Phase 2 | Low-risk simplifications | ~5 lines + clarity |
| Phase 3 | Medium-risk improvements | ~30 lines |
| Total | | ~245 lines (~30% reduction) |

**Execution Order:** Phase 1 → Phase 2 → Phase 3 → Phase 5 (verification after each)
