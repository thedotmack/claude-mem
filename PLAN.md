# Anti-Pattern Cleanup Plan: 175 Error Handling Issues

## Overview

Fix all 175 error handling anti-patterns detected by `scripts/anti-pattern-test/detect-error-handling-antipatterns.ts`. The detector scans `src/**/*.ts` and flags 10 pattern types. Currently 2 approved overrides exist; 175 issues remain.

## Detection Rules Reference

| Pattern | Trigger | Fix Options |
|---|---|---|
| `GENERIC_CATCH` | Catch block with no `instanceof`/type check | Add type discrimination, or `// [ANTI-PATTERN IGNORED]: reason` if logging covers it |
| `NO_LOGGING_IN_CATCH` | Catch block missing logger/console/stderr/throw | Add `logger.error/warn/debug()` call, or approved override with reason |
| `LARGE_TRY_BLOCK` | Try block >10 significant lines | Split into smaller focused try-catch blocks |
| `CATCH_AND_CONTINUE_CRITICAL_PATH` | Critical path file catches error and continues | Add re-throw, or convert to explicit return with logging |
| `ERROR_STRING_MATCHING` | `error.message.includes('...')` | Replace with `instanceof` or error code checks |
| `ERROR_MESSAGE_GUESSING` | Multiple `includes()` checks on error message | Replace with proper error type discrimination |
| `EMPTY_CATCH` | `catch(e) {}` with no body | Add logging or remove try-catch |
| `PROMISE_EMPTY_CATCH` | `.catch(() => {})` | Add logging or approved override |
| `PROMISE_CATCH_NO_LOGGING` | `.catch(err => { /* no log */ })` | Add logging |
| `PARTIAL_ERROR_LOGGING` | `logger.error('...', error.message)` vs full error | Pass full error object |

## Override Format

```typescript
// [ANTI-PATTERN IGNORED]: <specific technical reason>
```

**Valid reasons**: Expected frequent errors (polling, health checks, PID loops), logger self-protection, fallback behavior with recovery logic, cleanup operations where failure is non-critical.

**Invalid reasons**: "Error is not important", "optional", "works fine", vague hand-waving.

## Logger API Reference

```typescript
import { logger } from '@/utils/logger';

// Core methods - all take (component, message, context?, data?)
logger.error('COMPONENT', 'What failed', { relevantId: value }, error as Error);
logger.warn('COMPONENT', 'Non-critical issue', { context: value }, error as Error);
logger.debug('COMPONENT', 'Expected/transient failure', { context: value }, error as Error);

// Components: 'HOOK' | 'WORKER' | 'SDK' | 'PARSER' | 'DB' | 'SYSTEM' | 'HTTP' | 'SESSION' | 'CHROMA' | 'CHROMA_MCP' | 'CHROMA_SYNC' | 'FOLDER_INDEX' | 'CLAUDE_MD' | 'QUEUE'

// happyPathError - log warning + return fallback
logger.happyPathError<string>('COMPONENT', 'Unexpected null', { context }, error, '');
```

## Critical Path Files (Stricter Rules)

These files are on `CRITICAL_PATHS` in the detector. Errors MUST be visible (logged) or fatal (thrown). Catch-and-continue is BANNED unless exceptionally justified:
- `src/services/worker-service.ts` (14 issues)
- `src/services/sqlite/SessionStore.ts` (4 issues)
- `src/services/worker/SDKAgent.ts` (1 issue)
- `src/services/worker/GeminiAgent.ts` (1 issue)
- `src/services/worker/OpenRouterAgent.ts` (1 issue)

---

## Phase 1: Critical Path Files (21 issues)

**Priority**: HIGHEST — silent failures here break core functionality.

### Files & Issues

**src/services/worker-service.ts** (14 issues):
- Line 38: GENERIC_CATCH
- Line 322: CATCH_AND_CONTINUE_CRITICAL_PATH
- Line 467: CATCH_AND_CONTINUE_CRITICAL_PATH
- Line 574: CATCH_AND_CONTINUE_CRITICAL_PATH
- Line 699: CATCH_AND_CONTINUE_CRITICAL_PATH, NO_LOGGING_IN_CATCH, ERROR_MESSAGE_GUESSING
- Line 711: CATCH_AND_CONTINUE_CRITICAL_PATH
- Line 750: GENERIC_CATCH
- Line 779: GENERIC_CATCH
- Line 799: LARGE_TRY_BLOCK
- Line 817: GENERIC_CATCH, LARGE_TRY_BLOCK

**src/services/sqlite/SessionStore.ts** (4 issues):
- Line 668: LARGE_TRY_BLOCK
- Line 821: GENERIC_CATCH
- Line 1936: GENERIC_CATCH
- Line 1968: GENERIC_CATCH

**src/services/worker/SDKAgent.ts** (1 issue):
- Line 472: GENERIC_CATCH

**src/services/worker/GeminiAgent.ts** (1 issue):
- Line 132: LARGE_TRY_BLOCK

**src/services/worker/OpenRouterAgent.ts** (1 issue):
- Line 87: LARGE_TRY_BLOCK

### Fix Strategy

1. **Read each file** and understand each catch block's purpose
2. For CATCH_AND_CONTINUE_CRITICAL_PATH: Ensure error is logged AND either re-thrown or causes explicit early return
3. For NO_LOGGING_IN_CATCH: Add `logger.error()` with component and context
4. For GENERIC_CATCH: Add `instanceof Error` check or specific error type discrimination
5. For LARGE_TRY_BLOCK: Split into smaller focused blocks (one operation per try-catch)
6. For ERROR_MESSAGE_GUESSING: Replace string matching with proper error type checks

### Verification
```bash
bun run scripts/anti-pattern-test/detect-error-handling-antipatterns.ts 2>&1 | grep -E "(worker-service|SessionStore|SDKAgent|GeminiAgent|OpenRouterAgent)" | grep -v "APPROVED"
```
Expected: 0 non-approved issues in critical path files.

---

## Phase 2: Infrastructure & Server (26 issues)

### Files & Issues

**src/services/infrastructure/ProcessManager.ts** (20 issues):
- Lines 54, 66: LARGE_TRY_BLOCK, NO_LOGGING_IN_CATCH
- Lines 146, 160, 204, 231: GENERIC_CATCH
- Line 248: GENERIC_CATCH (has approved override for NO_LOGGING)
- Line 316: LARGE_TRY_BLOCK
- Lines 383, 410, 419: GENERIC_CATCH
- Line 452: LARGE_TRY_BLOCK
- Lines 533, 553, 561: GENERIC_CATCH
- Line 652: GENERIC_CATCH
- Lines 714: NO_LOGGING_IN_CATCH, GENERIC_CATCH
- Line 763: GENERIC_CATCH

**src/services/infrastructure/HealthMonitor.ts** (3 issues):
- Line 25: GENERIC_CATCH (has approved override for NO_LOGGING)
- Line 48: GENERIC_CATCH

**src/services/server/Server.ts** (3 issues):
- Line 208: LARGE_TRY_BLOCK
- Line 232: GENERIC_CATCH, NO_LOGGING_IN_CATCH

### Fix Strategy

ProcessManager.ts is process management code — many catch blocks legitimately handle expected failures (process already exited, PID not found, etc.). Strategy:
1. Read each catch block carefully
2. For legitimate expected-failure catches: Add logging at `debug` level + approved override comment if appropriate
3. For genuinely problematic catches: Add proper error handling with `logger.error()`
4. For LARGE_TRY_BLOCK: Evaluate whether splitting is practical — process management often needs atomic operations

### Verification
```bash
bun run scripts/anti-pattern-test/detect-error-handling-antipatterns.ts 2>&1 | grep -E "(ProcessManager|HealthMonitor|Server\.ts)" | grep -v "APPROVED"
```
Expected: 0 non-approved issues.

---

## Phase 3: CLI Layer (20 issues)

### Files & Issues

**src/cli/claude-md-commands.ts** (12 issues):
- Lines 79, 144, 190: LARGE_TRY_BLOCK
- Lines 97, 203, 314, 340, 352: GENERIC_CATCH, NO_LOGGING_IN_CATCH mix
- Lines 425, 503, 520: GENERIC_CATCH

**src/cli/stdin-reader.ts** (4 issues):
- Lines 32, 52, 170: NO_LOGGING_IN_CATCH
- Line 131: LARGE_TRY_BLOCK

**src/cli/hook-command.ts** (1 issue):
- Line 68: LARGE_TRY_BLOCK

**src/cli/handlers/session-complete.ts** (2 issues):
- Lines 38, 57: LARGE_TRY_BLOCK, GENERIC_CATCH

**src/cli/handlers/user-message.ts** (1 issue):
- Line 27: LARGE_TRY_BLOCK

**src/cli/handlers/observation.ts** (1 issue):
- Line 52: LARGE_TRY_BLOCK

**src/cli/handlers/file-edit.ts** (1 issue):
- Line 42: LARGE_TRY_BLOCK

**src/cli/handlers/context.ts** (1 issue):
- Line 39: LARGE_TRY_BLOCK

### Fix Strategy

CLI code runs in hooks with strict exit code requirements. Strategy:
1. For NO_LOGGING_IN_CATCH: Add `logger.error('HOOK', ...)` calls
2. For LARGE_TRY_BLOCK in handlers: These are often entire handler bodies wrapped in try-catch — split into logical sub-operations
3. For GENERIC_CATCH: Add error type discrimination where different error types need different handling

### Verification
```bash
bun run scripts/anti-pattern-test/detect-error-handling-antipatterns.ts 2>&1 | grep "src/cli/" | grep -v "APPROVED"
```
Expected: 0 non-approved issues.

---

## Phase 4: Worker Services (22 issues)

### Files & Issues

**src/services/worker/SearchManager.ts** (8 issues):
- Lines 407, 423, 657, 691: GENERIC_CATCH
- Lines 731, 759, 1340, 1355: LARGE_TRY_BLOCK

**src/services/worker/BranchManager.ts** (5 issues):
- Lines 121, 139, 301: GENERIC_CATCH
- Lines 244, 269: LARGE_TRY_BLOCK

**src/services/worker/SessionManager.ts** (2 issues):
- Lines 224, 263: GENERIC_CATCH

**src/services/worker/http/routes/SessionRoutes.ts** (2 issues):
- Lines 182, 211: GENERIC_CATCH, LARGE_TRY_BLOCK

**src/services/worker/http/routes/SettingsRoutes.ts** (1 issue):
- Line 76: GENERIC_CATCH

**src/services/worker/http/BaseRouteHandler.ts** (1 issue):
- Line 28: GENERIC_CATCH

**src/services/worker/SettingsManager.ts** (1 issue):
- Line 45: GENERIC_CATCH

**src/services/worker/ProcessRegistry.ts** (1 issue):
- Line 404: GENERIC_CATCH

**src/services/worker/PaginationHelper.ts** (1 issue):
- Line 54: GENERIC_CATCH

### Fix Strategy

1. HTTP route handlers typically have a top-level try-catch for 500 responses — these need error type discrimination and logging
2. SearchManager and BranchManager need their large try blocks broken into focused operations
3. Add `logger.error('WORKER', ...)` for all GENERIC_CATCH blocks that lack logging

### Verification
```bash
bun run scripts/anti-pattern-test/detect-error-handling-antipatterns.ts 2>&1 | grep "src/services/worker/" | grep -v "APPROVED" | grep -v "worker-service"
```
Expected: 0 non-approved issues.

---

## Phase 5: Data Layer — Search, Sync, DB, Queue (27 issues)

### Files & Issues

**src/services/worker/search/strategies/HybridSearchStrategy.ts** (6 issues):
- Lines 71, 113, 137, 178, 204, 244: GENERIC_CATCH, LARGE_TRY_BLOCK mix

**src/services/sync/ChromaMcpManager.ts** (6 issues):
- Lines 76, 266, 281, 300, 352, 366: NO_LOGGING_IN_CATCH (5), GENERIC_CATCH (1)

**src/services/sync/ChromaSync.ts** (5 issues):
- Lines 512, 678, 735, 736, 775: LARGE_TRY_BLOCK (2), ERROR_STRING_MATCHING (2), GENERIC_CATCH (1)

**src/services/worker/search/strategies/SQLiteSearchStrategy.ts** (2 issues):
- Lines 67, 99: LARGE_TRY_BLOCK, GENERIC_CATCH

**src/services/worker/search/strategies/ChromaSearchStrategy.ts** (2 issues):
- Lines 66, 140: LARGE_TRY_BLOCK, GENERIC_CATCH

**src/services/sqlite/SessionSearch.ts** (2 issues):
- Lines 351, 369: NO_LOGGING_IN_CATCH

**src/services/sqlite/timeline/queries.ts** (2 issues):
- Lines 113, 145: GENERIC_CATCH

**src/services/queue/SessionQueueProcessor.ts** (2 issues):
- Lines 37, 67: LARGE_TRY_BLOCK, GENERIC_CATCH

**src/services/context/ObservationCompiler.ts** (2 issues):
- Lines 153, 173: LARGE_TRY_BLOCK, GENERIC_CATCH

**src/services/context/ContextBuilder.ts** (1 issue):
- Line 52: GENERIC_CATCH

### Fix Strategy

1. **ChromaMcpManager.ts** is the worst — 5 NO_LOGGING_IN_CATCH. Add `logger.warn('CHROMA_MCP', ...)` or `logger.error('CHROMA_MCP', ...)` to all catch blocks
2. **ChromaSync.ts** has ERROR_STRING_MATCHING — replace `error.message.includes(...)` with `instanceof` checks or error code comparisons
3. Search strategies need their large try blocks split by operation phase (build query → execute → parse results)
4. Queue processor needs logging in catch blocks

### Verification
```bash
bun run scripts/anti-pattern-test/detect-error-handling-antipatterns.ts 2>&1 | grep -E "(search/strategies|ChromaMcp|ChromaSync|SessionSearch|timeline|Queue|ObservationCompiler|ContextBuilder)" | grep -v "APPROVED"
```
Expected: 0 non-approved issues.

---

## Phase 6: Utilities & Shared (20 issues)

### Files & Issues

**src/utils/logger.ts** (5 issues):
- Lines 63, 87, 155, 292: GENERIC_CATCH, NO_LOGGING_IN_CATCH
- Note: Logger can't log its own failures — these likely need approved overrides with `stderr` fallback

**src/utils/worktree.ts** (2 issues):
- Lines 41, 55: NO_LOGGING_IN_CATCH

**src/utils/claude-md-utils.ts** (2 issues):
- Lines 414, 448: LARGE_TRY_BLOCK, GENERIC_CATCH

**src/utils/project-filter.ts** (1 issue):
- Line 66: NO_LOGGING_IN_CATCH

**src/utils/agents-md-utils.ts** (1 issue):
- Line 30: GENERIC_CATCH

**src/shared/EnvManager.ts** (3 issues):
- Lines 122, 132, 170: GENERIC_CATCH, LARGE_TRY_BLOCK

**src/shared/SettingsDefaultsManager.ts** (2 issues):
- Lines 198, 218: GENERIC_CATCH

**src/shared/worker-utils.ts** (2 issues):
- Lines 114, 146: GENERIC_CATCH, LARGE_TRY_BLOCK

**src/shared/paths.ts** (1 issue):
- Line 113: GENERIC_CATCH

**src/shared/timeline-formatting.ts** (1 issue):
- Line 19: GENERIC_CATCH

### Fix Strategy

1. **logger.ts** is special — logger can't log its own errors. Use `process.stderr.write()` as fallback and add approved overrides with explicit reason: "Logger cannot log its own failures, using stderr as last resort"
2. For utility functions: Most GENERIC_CATCH blocks should either add `instanceof Error` checks or approved overrides with logging
3. For shared modules: These are imported widely — be conservative, ensure fixes don't change return behavior

### Verification
```bash
bun run scripts/anti-pattern-test/detect-error-handling-antipatterns.ts 2>&1 | grep -E "(src/utils/|src/shared/)" | grep -v "APPROVED"
```
Expected: 0 non-approved issues.

---

## Phase 7: Integrations, Transcripts, UI, Misc (39 issues)

### Files & Issues

**src/services/integrations/CursorHooksInstaller.ts** (11 issues):
- Lines 118, 264, 315, 385, 407, 424, 464, 508, 543, 570, 607: Mix of GENERIC_CATCH, LARGE_TRY_BLOCK, NO_LOGGING_IN_CATCH

**src/services/transcripts/watcher.ts** (4 issues):
- Lines 46, 155, 176, 212: NO_LOGGING_IN_CATCH (3), GENERIC_CATCH (1)

**src/services/transcripts/processor.ts** (2 issues):
- Lines 277, 353: NO_LOGGING_IN_CATCH, LARGE_TRY_BLOCK

**src/services/transcripts/field-utils.ts** (1 issue):
- Line 145: NO_LOGGING_IN_CATCH

**src/services/domain/ModeManager.ts** (3 issues):
- Lines 146, 163, 173: GENERIC_CATCH

**src/bin/import-xml-observations.ts** (7 issues):
- Lines 62, 134, 152, 167, 183, 329, 361: LARGE_TRY_BLOCK, GENERIC_CATCH mix

**src/servers/mcp-server.ts** (3 issues):
- Lines 56, 101, 146: LARGE_TRY_BLOCK, GENERIC_CATCH

**src/sdk/prompts.ts** (2 issues):
- Lines 98, 107: GENERIC_CATCH

**src/ui/viewer/hooks/useStats.ts** (1 issue):
- Line 13: GENERIC_CATCH

**src/ui/viewer/hooks/useTheme.ts** (2 issues):
- Lines 19, 64: GENERIC_CATCH

**src/ui/viewer/hooks/useContextPreview.ts** (1 issue):
- Line 31: GENERIC_CATCH

### Fix Strategy

1. **CursorHooksInstaller.ts** — integration code has many fallback patterns. Add logging where missing, add approved overrides for legitimate fallback behavior
2. **Transcript files** — watcher/processor need logging for silent failures
3. **UI hooks** — React error boundaries mean generic catches are often appropriate. Add approved overrides where the catch provides a safe default state
4. **MCP server** — split large try blocks, add error type discrimination
5. **import-xml-observations.ts** — CLI tool, add proper error logging

### Verification
```bash
bun run scripts/anti-pattern-test/detect-error-handling-antipatterns.ts 2>&1 | grep -E "(integrations|transcripts|domain|bin/|servers/|sdk/|ui/viewer)" | grep -v "APPROVED"
```
Expected: 0 non-approved issues.

---

## Phase 8: Final Verification & Build

### Steps

1. Run full detector — expect 0 non-approved issues:
```bash
bun run scripts/anti-pattern-test/detect-error-handling-antipatterns.ts
```

2. Count approved overrides and ensure each has a specific, technical reason:
```bash
grep -r "\[ANTI-PATTERN IGNORED\]" src/ | wc -l
```

3. Verify no behavioral regressions — build and run tests:
```bash
npm run build-and-sync
bun test
```

4. Review override quality — grep all overrides and verify reasons are specific:
```bash
grep -rn "\[ANTI-PATTERN IGNORED\]" src/
```

### Expected Final State
- 0 non-approved issues
- All approved overrides have specific, technical justifications
- Build succeeds
- Tests pass
- No behavioral changes to existing functionality

---

## Anti-Pattern Guards (What NOT To Do)

1. **Don't blindly add overrides** — Each catch block must be understood before deciding the fix
2. **Don't add `try-catch` where none existed** — Only fix existing anti-patterns
3. **Don't change return types or error propagation** — Fixes should be additive (logging) not behavioral
4. **Don't use `console.log/console.error`** — Use the `logger` singleton
5. **Don't catch and ignore on critical paths** — worker-service.ts errors must be visible or fatal
6. **Don't split try blocks that are intentionally atomic** — Some large try blocks protect a single logical operation
