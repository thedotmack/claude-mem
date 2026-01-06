# Plan: Fix 81 Test Failures from Incomplete Logger Mocks

## Problem Summary

**Root Cause**: NOT circular dependency (which is handled gracefully), but **incomplete logger mocks** that pollute across test files when Bun runs tests in alphabetical order.

When `tests/context/` runs before `tests/utils/`, the incomplete mocks replace the real logger module globally, causing subsequent tests to fail with `TypeError: logger.formatTool is not a function`.

## Phase 0: Documentation Discovery (COMPLETED)

### Sources Consulted
- `src/utils/logger.ts` - Full logger interface (lines 136, 289-373)
- `tests/context/context-builder.test.ts` - Mock pattern (lines 22-29)
- `tests/context/observation-compiler.test.ts` - Mock pattern (lines 4-10)
- `tests/server/server.test.ts` - Mock pattern (lines 4-11)
- `tests/server/error-handler.test.ts` - Mock pattern (lines 5-12)
- `tests/worker/agents/response-processor.test.ts` - Mock pattern (lines 32-39)

### Logger Methods (Complete List)
All 11 methods that must be in any logger mock:
1. `formatTool(toolName: string, toolInput?: any): string` (line 136)
2. `debug(component, message, context?, data?): void` (line 289)
3. `info(component, message, context?, data?): void` (line 293)
4. `warn(component, message, context?, data?): void` (line 297)
5. `error(component, message, context?, data?): void` (line 301)
6. `dataIn(component, message, context?, data?): void` (line 308)
7. `dataOut(component, message, context?, data?): void` (line 315)
8. `success(component, message, context?, data?): void` (line 322)
9. `failure(component, message, context?, data?): void` (line 329)
10. `timing(component, message, durationMs, context?): void` (line 336)
11. `happyPathError<T>(message, context?): T` (line 362)

### Files Requiring Updates
1. `tests/context/observation-compiler.test.ts` (lines 4-10)
2. `tests/context/context-builder.test.ts` (lines 22-29)
3. `tests/server/server.test.ts` (lines 4-11)
4. `tests/server/error-handler.test.ts` (lines 5-12)
5. `tests/worker/agents/response-processor.test.ts` (lines 32-39)

---

## Phase 1: Create Shared Logger Mock Utility

### Objective
Create a reusable complete logger mock to avoid duplication and ensure consistency.

### Implementation

**Create new file**: `tests/test-utils/mock-logger.ts`

```typescript
/**
 * Complete logger mock for tests.
 * Includes ALL logger methods to prevent mock pollution across test files.
 */
import { mock } from 'bun:test';

export function createMockLogger() {
  return {
    logger: {
      // Core logging methods
      debug: mock(() => {}),
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),

      // Data flow logging
      dataIn: mock(() => {}),
      dataOut: mock(() => {}),

      // Status logging
      success: mock(() => {}),
      failure: mock(() => {}),

      // Performance logging
      timing: mock(() => {}),

      // Tool formatting - returns string
      formatTool: mock((toolName: string, _toolInput?: any) => toolName),

      // Error helper - returns the message
      happyPathError: mock((message: string, _context?: any) => message),
    },
  };
}
```

### Verification Checklist
- [ ] File created at `tests/test-utils/mock-logger.ts`
- [ ] All 11 logger methods included
- [ ] `formatTool` returns string (not void)
- [ ] `happyPathError` returns the message (not void)
- [ ] File compiles without errors: `bunx tsc --noEmit tests/test-utils/mock-logger.ts`

### Anti-Patterns to Avoid
- ❌ Don't forget `formatTool` - it returns a string, not void
- ❌ Don't forget `happyPathError` - it's generic and returns the message
- ❌ Don't use `() => {}` for methods that return values

---

## Phase 2: Update Affected Test Files

### Objective
Replace incomplete logger mocks with the complete shared mock.

### Files to Update (5 total)

#### 2.1 `tests/context/observation-compiler.test.ts`

**Current (lines 4-10)**:
```typescript
mock.module('../../src/utils/logger.js', () => ({
  logger: {
    debug: mock(() => {}),
    failure: mock(() => {}),
    error: mock(() => {}),
  },
}));
```

**Replace with**:
```typescript
import { createMockLogger } from '../test-utils/mock-logger.js';

mock.module('../../src/utils/logger.js', () => createMockLogger());
```

#### 2.2 `tests/context/context-builder.test.ts`

**Current (lines 22-29)**:
```typescript
mock.module('../../src/utils/logger.js', () => ({
  logger: {
    debug: mock(() => {}),
    failure: mock(() => {}),
    error: mock(() => {}),
    info: mock(() => {}),
  },
}));
```

**Replace with**:
```typescript
import { createMockLogger } from '../test-utils/mock-logger.js';

mock.module('../../src/utils/logger.js', () => createMockLogger());
```

#### 2.3 `tests/server/server.test.ts`

**Current (lines 4-11)**:
```typescript
mock.module('../../src/utils/logger.js', () => ({
  logger: {
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
  },
}));
```

**Replace with**:
```typescript
import { createMockLogger } from '../test-utils/mock-logger.js';

mock.module('../../src/utils/logger.js', () => createMockLogger());
```

#### 2.4 `tests/server/error-handler.test.ts`

**Current (lines 5-12)**:
```typescript
mock.module('../../src/utils/logger.js', () => ({
  logger: {
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
  },
}));
```

**Replace with**:
```typescript
import { createMockLogger } from '../test-utils/mock-logger.js';

mock.module('../../src/utils/logger.js', () => createMockLogger());
```

#### 2.5 `tests/worker/agents/response-processor.test.ts`

**Current (lines 32-39)**:
```typescript
mock.module('../../../src/utils/logger.js', () => ({
  logger: {
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
  },
}));
```

**Replace with**:
```typescript
import { createMockLogger } from '../../test-utils/mock-logger.js';

mock.module('../../../src/utils/logger.js', () => createMockLogger());
```

### Verification Checklist
- [ ] All 5 files updated with import statement
- [ ] All 5 files use `createMockLogger()` instead of inline mock
- [ ] Import paths are correct (relative to each file's location)
- [ ] Each file still has `mock.module` BEFORE the module imports it mocks

### Anti-Patterns to Avoid
- ❌ Don't place import AFTER the mock.module call
- ❌ Don't use wrong relative path (../test-utils vs ../../test-utils)
- ❌ Don't forget the .js extension in imports

---

## Phase 3: Verification

### Objective
Confirm all 81 failures are fixed.

### Test Commands

```bash
# 1. Run individual test groups first
bun test tests/context/
bun test tests/server/
bun test tests/utils/
bun test tests/shared/
bun test tests/worker/

# 2. Run full suite
bun test

# 3. Verify specific test counts
# Expected: 733+ tests pass (was 652 before)
```

### Verification Checklist
- [ ] `bun test tests/context/` - all pass
- [ ] `bun test tests/server/` - all pass
- [ ] `bun test tests/utils/` - all pass (including 56 formatTool tests)
- [ ] `bun test tests/shared/` - all pass (including 27 settings tests)
- [ ] `bun test` - 730+ tests pass, 0 failures
- [ ] No `TypeError: logger.formatTool is not a function` errors

### Anti-Pattern Grep Checks

```bash
# Check no incomplete logger mocks remain
grep -r "logger: {" tests/ --include="*.ts" | grep -v mock-logger

# Verify all test files use createMockLogger
grep -r "createMockLogger" tests/ --include="*.ts"
```

---

## Phase 4: Commit

### Commit Message

```
fix(tests): complete logger mocks to prevent cross-test pollution

The 81 test failures were caused by incomplete logger mocks that
polluted the module cache when tests ran in alphabetical order.

Changes:
- Create shared mock-logger.ts with all 11 logger methods
- Update 5 test files to use complete mock
- Fix TypeError: logger.formatTool is not a function

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
```

---

## Summary

| Phase | Files Changed | Purpose |
|-------|--------------|---------|
| 1 | 1 new file | Create shared mock utility |
| 2 | 5 files | Update to use shared mock |
| 3 | 0 files | Verification only |
| 4 | 0 files | Commit |

**Total**: 6 files changed, fixing all 81 test failures.
