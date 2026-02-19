# Anti-Pattern Cleanup Plan

**Goal:** Fix 178 error handling anti-patterns to gain visibility into binary execution failures.

**Current state:** 178 issues, 2 approved overrides across 42 files.

---

## Phase 0: Documentation (Complete)

**Detector:** `scripts/anti-pattern-test/detect-error-handling-antipatterns.ts`

**Override format:** `// [ANTI-PATTERN IGNORED]: <specific technical reason>`
- Must appear inside the catch block content
- Requires colon + reason after the tag

**Logger API:** `logger.(debug|info|warn|error)(component, message, context?, data?)`
- Components: `'HOOK' | 'WORKER' | 'SDK' | 'SYSTEM' | 'HTTP' | 'SESSION' | 'CHROMA' | 'CHROMA_MCP' | 'CHROMA_SYNC' | 'CLAUDE_MD' | 'QUEUE'` etc.
- Context: `{ sessionId?, correlationId?, [key: string]: any }`
- Pass full error object as `data` param: `error as Error`

**What counts as "has logging":** `logger.(error|warn|debug|info|failure)`, `console.(error|warn)`, `process.stderr.write`, `throw`

**Critical paths (catch-and-continue banned):** SDKAgent.ts, GeminiAgent.ts, OpenRouterAgent.ts, SessionStore.ts, worker-service.ts

**Large try threshold:** >10 significant lines (excludes comments, empty lines, lone braces)

**12 existing overrides** already in codebase (all include logging except 2 hot-path exceptions).

---

## Phase 1: Critical Path — worker-service.ts (5 CATCH_AND_CONTINUE + 1 NO_LOGGING + 1 ERROR_MESSAGE_GUESSING)

**Why first:** worker-service.ts is the core daemon. 5 catch-and-continue patterns mean errors on the critical path just silently continue. This is the most likely reason the binary setup fails without any visible error.

**File:** `src/services/worker-service.ts`

| Line | Pattern | Action |
|------|---------|--------|
| 39 | NO_LOGGING_IN_CATCH | Add `logger.debug` — Windows lock file stat failure |
| 322 | CATCH_AND_CONTINUE + GENERIC_CATCH | Read context, add logging or rethrow |
| 467 | CATCH_AND_CONTINUE | Read context, add logging or rethrow |
| 574 | ERROR_MESSAGE_GUESSING | Replace string matching with proper error type checks |
| 699 | CATCH_AND_CONTINUE | Read context, add logging or rethrow |
| 711 | CATCH_AND_CONTINUE | Read context, add logging or rethrow |
| 750 | LARGE_TRY_BLOCK (23 lines) | Scope down the try block |
| 779 | CATCH_AND_CONTINUE + GENERIC_CATCH | Read context, add logging or rethrow |
| 799 | LARGE_TRY_BLOCK (15 lines) | Scope down the try block |
| 817 | CATCH_AND_CONTINUE + GENERIC_CATCH | Read context, add logging or rethrow |

**Instructions:**
1. Read the full file first to understand each catch block's context
2. For each CATCH_AND_CONTINUE: decide if the error should (a) be logged + rethrown, (b) logged + returned with error, or (c) approved override with justification
3. For ERROR_MESSAGE_GUESSING at line 574: replace `error.message.includes(...)` chains with `instanceof` checks or error code checks
4. For LARGE_TRY_BLOCKs: narrow the try scope to only the operation that can fail

**Verification:**
```bash
bun run scripts/anti-pattern-test/detect-error-handling-antipatterns.ts 2>&1 | grep "worker-service.ts"
# Should show 0 unfixed issues
```

---

## Phase 2: Silent Failures — NO_LOGGING_IN_CATCH (23 issues across 15 files)

**Why second:** These are the visibility killers. Every one of these is a place where an error happens and nobody can see it.

**Decision framework for each catch block:**

- **Add logging** if: the error is unexpected, or you'd want to see it when debugging
- **Add override** if ALL of: (a) error is expected and frequent, (b) logging would flood, (c) there's explicit fallback logic, (d) reason is specific and technical

**Files and lines:**

| File | Lines | Context (read before fixing) |
|------|-------|-----|
| `src/services/infrastructure/ProcessManager.ts` | 67, 750 | Binary lookup (`which`/`where`), process alive check |
| `src/utils/project-filter.ts` | 66 | Invalid glob pattern |
| `src/utils/worktree.ts` | 41, 55 | Git worktree detection |
| `src/utils/logger.ts` | 90, 158 | Logger self-initialization |
| `src/shared/AuthTokenManager.ts` | 34 | Atomic file create race |
| `src/cli/stdin-reader.ts` | 32, 52, 170 | Bun stdin bugs, JSON parse |
| `src/cli/claude-md-commands.ts` | 144, 190, 203, 340 | JSON parse on DB data |
| `src/services/transcripts/watcher.ts` | 46, 155, 176 | File stat races |
| `src/services/transcripts/processor.ts` | 278 | Optional JSON parse |
| `src/services/transcripts/field-utils.ts` | 145 | User-provided regex |
| `src/services/server/Server.ts` | 232 | Instruction loading |
| `src/services/sqlite/SessionSearch.ts` | 351, 369 | JSON parse on DB data |
| `src/services/integrations/CursorHooksInstaller.ts` | 575 | hooks.json diagnostic parse |
| `src/services/sync/ChromaMcpManager.ts` | 266, 281, 352, 366 | MCP response, health check, certs |

**Instructions:**
1. Read each file at the specified line
2. Apply the decision framework above
3. For logging: use `logger.debug` for expected failures, `logger.warn` for unexpected ones
4. For overrides: use exact format `// [ANTI-PATTERN IGNORED]: <specific reason>`

**Verification:**
```bash
bun run scripts/anti-pattern-test/detect-error-handling-antipatterns.ts 2>&1 | grep "NO_LOGGING_IN_CATCH" | grep -v "APPROVED"
# Should show 0 unfixed NO_LOGGING issues
```

---

## Phase 3: ProcessManager.ts Deep Clean (19 issues)

**Why third:** ProcessManager is the second-most-affected file and directly controls binary/worker spawning. 10 GENERIC_CATCH, 4 LARGE_TRY_BLOCK, 2 NO_LOGGING (covered in Phase 2).

**File:** `src/services/infrastructure/ProcessManager.ts`

| Lines | Pattern | Context |
|-------|---------|---------|
| 55 | LARGE_TRY_BLOCK (11 lines) | lookupBinaryInPath |
| 148 | GENERIC_CATCH | readPidFile |
| 162 | GENERIC_CATCH | removePidFile |
| 206 | GENERIC_CATCH | getChildProcesses |
| 233 | GENERIC_CATCH | forceKillProcess |
| 250 | GENERIC_CATCH | waitForProcessesExit (has override for NO_LOGGING) |
| 318 | LARGE_TRY_BLOCK (43 lines) | cleanupOrphanedProcesses |
| 385 | GENERIC_CATCH | cleanupOrphanedProcesses catch |
| 412, 421 | GENERIC_CATCH | cleanup kill loops |
| 454 | LARGE_TRY_BLOCK (55 lines) | aggressiveStartupCleanup |
| 535, 555, 563 | GENERIC_CATCH | aggressive cleanup catches |
| 679 | GENERIC_CATCH | spawnDaemon |
| 799 | GENERIC_CATCH | signal handler |

**Instructions:**
1. For GENERIC_CATCH: most already have logging via existing overrides. Add `instanceof` checks or `.code` property checks where the error type matters (e.g., EPERM, ESRCH, ENOENT)
2. For LARGE_TRY_BLOCKs at 318 and 454: these are the big cleanup functions. Extract inner operations into helper functions to narrow try scope
3. For cleanly-overridden catches (already have logging): add the error type narrowing

**Verification:**
```bash
bun run scripts/anti-pattern-test/detect-error-handling-antipatterns.ts 2>&1 | grep "ProcessManager.ts"
# Count should be significantly reduced
```

---

## Phase 4: GENERIC_CATCH Sweep (remaining ~85 issues across 30+ files)

**Why fourth:** Highest volume. These all handle every error identically. Less urgent than silent failures but still reduce debugging capability.

**Approach:** Group by fix type, not by file.

### Group A: HTTP route handlers (add `instanceof` + specific status codes)
Files: Server.ts, BaseRouteHandler.ts, SettingsRoutes.ts, SessionRoutes.ts, SearchManager.ts

### Group B: Database operations (add error code checks)
Files: SessionStore.ts, SessionSearch.ts, timeline/queries.ts

### Group C: Process/system operations (add `.code` property checks)
Files: ProcessManager.ts (covered in Phase 3), CursorHooksInstaller.ts, BranchManager.ts

### Group D: JSON parse operations (add `instanceof SyntaxError`)
Files: SettingsDefaultsManager.ts, EnvManager.ts, paths.ts, agents-md-utils.ts, timeline-formatting.ts

### Group E: Agent/SDK operations
Files: SDKAgent.ts, GeminiAgent.ts, OpenRouterAgent.ts, ChromaSync.ts, ChromaMcpManager.ts

### Group F: UI hooks (viewer - lowest priority)
Files: useStats.ts, useTheme.ts, useContextPreview.ts

**Instructions:**
- For each catch block: add the minimum type discrimination needed
- Pattern: `if (error instanceof SyntaxError)` or `if ((error as NodeJS.ErrnoException).code === 'ENOENT')`
- When discrimination isn't practical (truly any error), add an override with reason

**Verification:**
```bash
bun run scripts/anti-pattern-test/detect-error-handling-antipatterns.ts 2>&1 | grep "GENERIC_CATCH" | grep -v "APPROVED" | wc -l
# Should be 0 or near-0
```

---

## Phase 5: LARGE_TRY_BLOCK Reduction (48 issues)

**Why fifth:** These are structural improvements. Important for long-term maintainability but less urgent than visibility fixes.

### Worst offenders (>50 lines — fix these first):
| File | Line | Size |
|------|------|------|
| `SessionStore.ts` | 673 | 118 lines |
| `GeminiAgent.ts` | 132 | 126 lines |
| `OpenRouterAgent.ts` | 87 | 113 lines |
| `ChromaSync.ts` | 536 | 106 lines |
| `ProcessManager.ts` | 454 | 55 lines |
| `claude-md-commands.ts` | 352 | 56 lines |
| `ChromaSearchStrategy.ts` | 66 | 54 lines |

### Medium offenders (20-50 lines):
CursorHooksInstaller.ts (49, 28, 21 lines), ProcessManager.ts (43 lines), ChromaSync.ts (35 lines), worker-utils.ts, EnvManager.ts, claude-md-utils.ts, HybridSearchStrategy.ts, etc.

### Small offenders (11-20 lines):
Most remaining files — narrow scope or extract helpers.

**Instructions:**
- For massive blocks (>50 lines): extract the body into a helper function, wrap only the call
- For medium blocks: identify which specific operation can fail, narrow the try to just that
- For small blocks (11-15 lines): often fine as-is, but check if scope can be narrowed

**Verification:**
```bash
bun run scripts/anti-pattern-test/detect-error-handling-antipatterns.ts 2>&1 | grep "LARGE_TRY_BLOCK" | wc -l
# Should be 0 or near-0
```

---

## Phase 6: Remaining Patterns (3 issues)

| File | Line | Pattern | Action |
|------|------|---------|--------|
| `worker-service.ts` | 574 | ERROR_MESSAGE_GUESSING | Covered in Phase 1 |
| `ChromaSync.ts` | 759 | ERROR_STRING_MATCHING ("ECONNREFUSED") | Replace with `.code === 'ECONNREFUSED'` check |
| `ChromaSync.ts` | 760 | ERROR_STRING_MATCHING ("ENOTFOUND") | Replace with `.code === 'ENOTFOUND'` check |

---

## Phase 7: Final Verification

```bash
# Full scan
bun run scripts/anti-pattern-test/detect-error-handling-antipatterns.ts

# Expected result:
# Found 0 anti-patterns that must be fixed
# APPROVED OVERRIDES: N (justified overrides)

# Build check
npm run build-and-sync

# Verify worker starts
curl -s http://localhost:37777/api/health
```

---

## Execution Notes

- **Each phase is independent** — can be run in a separate session
- **Phases 1-2 are the highest impact** for the binary visibility problem
- **Phase 1 alone** (worker-service.ts critical path) will likely surface the binary failure
- **Run the detector after each phase** to track progress
- **Don't batch-approve overrides** — evaluate each catch block individually
