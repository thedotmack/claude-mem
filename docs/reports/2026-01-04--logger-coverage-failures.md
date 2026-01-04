# Logger Coverage Test Failures Report

**Date**: 2026-01-04
**Category**: Logger Coverage
**Failing Tests**: 2
**Test File**: `tests/logger-coverage.test.ts`

---

## 1. Executive Summary

The Logger Coverage test suite enforces consistent logging practices across the claude-mem codebase. Two tests are failing:

1. **Console.log usage in background services** - 2 files using `console.log/console.error` where logs are invisible
2. **Missing logger imports in high-priority files** - 34 files in critical paths without logger instrumentation

These failures represent a significant observability gap. Background services run in processes where console output is discarded, making debugging production issues extremely difficult.

---

## 2. Test Analysis

### What the Tests Enforce

The test suite (`tests/logger-coverage.test.ts`) implements the following rules:

#### High-Priority File Patterns (require logger import)
```typescript
/^services\/worker\/(?!.*types\.ts$)/    // Worker services
/^services\/sqlite\/(?!types\.ts$|index\.ts$)/  // SQLite services
/^services\/sync\//                       // Sync services
/^services\/context-generator\.ts$/       // Context generator
/^hooks\/(?!hook-response\.ts$)/          // All hooks except hook-response
/^sdk\/(?!.*types?\.ts$)/                 // SDK files
/^servers\/(?!.*types?\.ts$)/             // Server files
```

#### Excluded Patterns (not required to have logger)
```typescript
/types\//           // Type definition files
/constants\//       // Pure constants
/\.d\.ts$/          // Declaration files
/^ui\//             // UI components
/^bin\//            // CLI utilities
/index\.ts$/        // Re-export files
/logger\.ts$/       // Logger itself
/hook-response\.ts$/
/hook-constants\.ts$/
/paths\.ts$/
/bun-path\.ts$/
/migrations\.ts$/
```

#### Console.log Detection
- Hook files (`src/hooks/*`) ARE allowed to use console.log for final output response
- All other files MUST NOT use console.log/console.error/console.warn/console.info/console.debug
- Rationale: Background services run in processes where console output goes nowhere

---

## 3. Files Missing Logger Import (34 files)

### SQLite Layer (22 files)

| File Path | Module | Notes |
|-----------|--------|-------|
| `src/services/sqlite/Summaries.ts` | Summaries facade | Database operations |
| `src/services/sqlite/Prompts.ts` | Prompts facade | Database operations |
| `src/services/sqlite/Observations.ts` | Observations facade | Database operations |
| `src/services/sqlite/Sessions.ts` | Sessions facade | Database operations |
| `src/services/sqlite/Timeline.ts` | Timeline facade | Database operations |
| `src/services/sqlite/Import.ts` | Import facade | Database operations |
| `src/services/sqlite/transactions.ts` | Transaction wrapper | Critical path |
| `src/services/sqlite/sessions/get.ts` | Session retrieval | |
| `src/services/sqlite/sessions/types.ts` | Session types | Type file in non-excluded path |
| `src/services/sqlite/sessions/create.ts` | Session creation | |
| `src/services/sqlite/summaries/get.ts` | Summary retrieval | |
| `src/services/sqlite/summaries/recent.ts` | Recent summaries | |
| `src/services/sqlite/summaries/types.ts` | Summary types | Type file in non-excluded path |
| `src/services/sqlite/summaries/store.ts` | Summary storage | |
| `src/services/sqlite/prompts/get.ts` | Prompt retrieval | |
| `src/services/sqlite/prompts/types.ts` | Prompt types | Type file in non-excluded path |
| `src/services/sqlite/prompts/store.ts` | Prompt storage | |
| `src/services/sqlite/observations/get.ts` | Observation retrieval | |
| `src/services/sqlite/observations/recent.ts` | Recent observations | |
| `src/services/sqlite/observations/types.ts` | Observation types | Type file in non-excluded path |
| `src/services/sqlite/observations/files.ts` | File observations | |
| `src/services/sqlite/observations/store.ts` | Observation storage | |
| `src/services/sqlite/import/bulk.ts` | Bulk import | |

### Worker Services (10 files)

| File Path | Module | Notes |
|-----------|--------|-------|
| `src/services/worker/Search.ts` | Search coordinator | Core search functionality |
| `src/services/worker/agents/FallbackErrorHandler.ts` | Error handling agent | Error recovery |
| `src/services/worker/agents/ObservationBroadcaster.ts` | SSE broadcast agent | Real-time updates |
| `src/services/worker/agents/SessionCleanupHelper.ts` | Cleanup agent | Session management |
| `src/services/worker/search/filters/TypeFilter.ts` | Type filtering | Search filter |
| `src/services/worker/search/filters/ProjectFilter.ts` | Project filtering | Search filter |
| `src/services/worker/search/filters/DateFilter.ts` | Date filtering | Search filter |
| `src/services/worker/search/strategies/SearchStrategy.ts` | Base strategy | Search abstraction |
| `src/services/worker/search/ResultFormatter.ts` | Result formatting | Output formatting |
| `src/services/worker/search/TimelineBuilder.ts` | Timeline construction | Timeline feature |

### Context Services (1 file)

| File Path | Module | Notes |
|-----------|--------|-------|
| `src/services/context-generator.ts` | Context generation | Core feature |

### Additional Non-High-Priority Files Without Logger (18 files)

These files don't trigger test failures but lack logging:

- `src/utils/error-messages.ts`
- `src/services/context/sections/SummaryRenderer.ts`
- `src/services/context/sections/HeaderRenderer.ts`
- `src/services/context/sections/TimelineRenderer.ts`
- `src/services/context/sections/FooterRenderer.ts`
- `src/services/context/ContextConfigLoader.ts`
- `src/services/context/formatters/ColorFormatter.ts`
- `src/services/context/formatters/MarkdownFormatter.ts`
- `src/services/context/types.ts`
- `src/services/context/TokenCalculator.ts`
- `src/services/Context.ts`
- `src/services/server/Middleware.ts`
- `src/services/sqlite/types.ts`
- `src/services/worker-types.ts`
- `src/services/integrations/types.ts`
- `src/services/worker/agents/types.ts`
- `src/services/worker/search/types.ts`
- `src/services/domain/types.ts`

---

## 4. Files Using Console.log (2 files)

### File 1: `src/services/worker-service.ts`

**Console.log occurrences**: 45 lines
**Line numbers**: 425, 435, 452, 454, 457, 459, 461, 463, 465, 466, 467, 475, 477, 478, 486, 488, 491, 492, 500, 502, 505, 508, 509, 510, 511, 521, 525, 529, 530, 541, 544, 545, 547, 551, 557, 559, 563, 573, 578, 581, 612, 724, 725, 726, 727, 729

**Impact**: HIGH - This is the main worker service. All console.log output is lost when running as a background process.

### File 2: `src/services/integrations/CursorHooksInstaller.ts`

**Console.log occurrences**: 45 lines
**Line numbers**: 210, 211, 217, 249, 250, 254, 270, 274, 306, 308, 349, 356, 374, 376, 393, 408, 432, 437, 444, 448, 468, 475, 483, 489, 492, 493, 497, 506, 527, 528, 538, 540, 542, 544, 553, 555, 562, 564, 568, 570, 574, 615, 616, 635, 640

**Impact**: MEDIUM - Integration installer, runs during setup. Some console output may be visible during CLI operations, but background operations will lose logs.

---

## 5. Recommended Fix Strategy

### Option A: Bulk Fix (Recommended)

**Pros**:
- Single PR, atomic change
- Consistent implementation
- Faster to complete

**Cons**:
- Large PR to review
- Higher risk of merge conflicts

**Approach**:
1. Create script to auto-inject logger imports
2. Run sed/find-replace for console.log -> logger.debug
3. Manual review of each file for appropriate log levels
4. Run tests to verify

### Option B: Incremental Fix

**Pros**:
- Smaller, reviewable PRs
- Lower risk per change

**Cons**:
- Multiple PRs to track
- Longer time to completion

**Approach**:
1. Fix console.log files first (2 files, highest impact)
2. Fix SQLite layer (22 files)
3. Fix Worker services (10 files)
4. Fix Context generator (1 file)

### Recommended Order

1. **Immediate** (blocks other debugging): Fix console.log usage
   - `src/services/worker-service.ts`
   - `src/services/integrations/CursorHooksInstaller.ts`

2. **High Priority** (core data path): SQLite layer
   - All 22 files in `src/services/sqlite/`

3. **Medium Priority** (feature modules): Worker services
   - All 10 files in `src/services/worker/`

4. **Standard Priority**: Context generator
   - `src/services/context-generator.ts`

---

## 6. Priority/Effort Estimate

### Effort by Task

| Task | Files | Estimated Effort | Priority |
|------|-------|------------------|----------|
| Replace console.log in worker-service.ts | 1 | 1-2 hours | P0 - Critical |
| Replace console.log in CursorHooksInstaller.ts | 1 | 1 hour | P0 - Critical |
| Add logger to SQLite facade files | 6 | 2 hours | P1 - High |
| Add logger to SQLite subdirectory files | 16 | 3 hours | P1 - High |
| Add logger to Worker service files | 10 | 2 hours | P2 - Medium |
| Add logger to context-generator.ts | 1 | 30 min | P2 - Medium |

**Total Estimated Effort**: 9-10 hours

### Complexity Notes

1. **Type files** (`*/types.ts`) matched by high-priority patterns may not need actual logging - consider updating test exclusions
2. **Console.log replacement** requires judgment on log levels (debug vs info vs warn)
3. **Some console.log** may be intentional CLI output - need manual review

---

## 7. Test Coverage Statistics

From the test output:

```
Total files analyzed: 114
Files with logger: 62 (54.4%)
Files without logger: 52
Total logger calls: 428
Excluded files: 34
```

**Current Coverage**: 54.4%
**Target Coverage**: 100% of high-priority files (34 files to fix)

---

## 8. Appendix: Logger Import Pattern

Files should import logger using:

```typescript
import { logger } from "../utils/logger.js";
// or appropriate relative path
```

The test detects this pattern:
```typescript
/import\s+.*logger.*from\s+['"].*logger(\.(js|ts))?['"]/
```
