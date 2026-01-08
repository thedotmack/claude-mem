# Plan: Address PR #610 Review Issues

## Overview
This plan addresses the issues identified in the PR review for PR #610 "fix: Update hooks for Claude Code 2.1.0/1 - SessionStart no longer shows user messages".

## Phase 0: Verification and Discovery

### 0.1 Verify Test Failure
- **File**: `tests/hook-constants.test.ts`
- **Issue**: Lines 61-63 test for `HOOK_EXIT_CODES.USER_MESSAGE_ONLY` which was removed
- **Verification**: Run `bun test tests/hook-constants.test.ts` to confirm failure

### 0.2 Verify No Code References USER_MESSAGE_ONLY
- **Finding**: Grep found references only in:
  - `tests/hook-constants.test.ts` (test file - needs fix)
  - `src/services/CLAUDE.md` (memory context - auto-generated, not code)
  - `plugin/scripts/CLAUDE.md` (memory context - auto-generated, not code)
- **Conclusion**: Only the test file needs updating; CLAUDE.md files are memory records

### 0.3 Verify CLAUDE.md Files Are Legitimate
- **Clarification**: The PR reviewer mentioned "user-specific CLAUDE.md files starting with ~/"
- **Finding**: All CLAUDE.md files in the commit are within the repository (`docs/`, `src/`, `plugin/`)
- **Conclusion**: These are legitimate in-repo context files, not user-specific paths

---

## Phase 1: Fix Test File (REQUIRED)

### Task 1.1: Remove USER_MESSAGE_ONLY Test
**File**: `tests/hook-constants.test.ts`
**Action**: Delete lines 61-63 that test for the removed constant

```typescript
// DELETE THESE LINES:
it('should define USER_MESSAGE_ONLY exit code', () => {
  expect(HOOK_EXIT_CODES.USER_MESSAGE_ONLY).toBe(3);
});
```

### Task 1.2: Add Test for BLOCKING_ERROR
**File**: `tests/hook-constants.test.ts`
**Action**: Add test for the new `BLOCKING_ERROR` constant (exit code 2) that replaced it

```typescript
// ADD THIS TEST:
it('should define BLOCKING_ERROR exit code', () => {
  expect(HOOK_EXIT_CODES.BLOCKING_ERROR).toBe(2);
});
```

### Verification
- Run `bun test tests/hook-constants.test.ts`
- Expect: All tests pass

---

## Phase 2: Documentation Consistency (NICE TO HAVE)

### Issue
Three similar notes about Claude Code 2.1.0 have slightly different wording:

1. `docs/public/architecture/hooks.mdx:254`:
   > "SessionStart hooks no longer display any user-visible messages. Context is still injected via `hookSpecificOutput.additionalContext` but users don't see startup output in the UI."

2. `docs/public/hooks-architecture.mdx:31`:
   > "SessionStart hooks no longer display any user-visible messages. Context is silently injected via `hookSpecificOutput.additionalContext`."

3. `docs/public/hooks-architecture.mdx:441`:
   > "SessionStart hooks output is never displayed to users. Context is injected silently via `hookSpecificOutput.additionalContext`."

### Task 2.1: Standardize Note Wording
**Action**: Use consistent wording across all three locations

**Standard text**:
```
As of Claude Code 2.1.0 (ultrathink update), SessionStart hooks no longer display user-visible messages. Context is silently injected via `hookSpecificOutput.additionalContext`.
```

### Files to Update
1. `docs/public/architecture/hooks.mdx:253-255` - Update Note block
2. `docs/public/hooks-architecture.mdx:30-32` - Update Note block
3. `docs/public/hooks-architecture.mdx:440-442` - Update Note block

### Verification
- Grep for the standard text in all three files
- Visual review of documentation

---

## Phase 3: Code Quality Improvements (OPTIONAL)

### Issue 3.1: Hardcoded Promotional Message
**File**: `src/hooks/context-hook.ts:66-68`
**Current code**:
```typescript
const enhancedContext = `${text}

Access 300k tokens of past research & decisions for just 19,008t. Use MCP search tools to access memories by ID.`;
```

### Options
1. **Leave as-is**: The token count is a rough estimate and doesn't need to be exact
2. **Make configurable**: Add to settings (over-engineering for this use case)
3. **Remove hardcoded numbers**: Use relative language instead

### Recommendation
Leave as-is for now. The token counts are marketing copy, not critical functionality. Creating a PR just for this adds unnecessary complexity.

---

## Phase 4: Final Verification

### 4.1 Run Full Test Suite
```bash
bun test
```

### 4.2 Build Verification
```bash
npm run build
```

### 4.3 Grep Verification
```bash
grep -r "USER_MESSAGE_ONLY" src/ --include="*.ts" --include="*.js"
```
Expected: No results (CLAUDE.md files excluded as they're memory records)

---

## Summary

| Phase | Priority | Effort | Description |
|-------|----------|--------|-------------|
| 1 | REQUIRED | 5 min | Fix test file - remove USER_MESSAGE_ONLY test, add BLOCKING_ERROR test |
| 2 | Nice to have | 10 min | Standardize documentation note wording |
| 3 | Skip | - | Hardcoded token counts are fine as-is |
| 4 | REQUIRED | 5 min | Run tests and build to verify |

## Expected Outcome
- All tests pass
- Build succeeds
- No code references to removed USER_MESSAGE_ONLY constant
- Documentation uses consistent wording (if Phase 2 is done)
