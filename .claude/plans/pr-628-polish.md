# Plan: PR #628 Polish Items

**PR**: #628 - Windows Terminal Tab Accumulation & Windows 11 Compatibility
**Status**: APPROVED by 3 reviewers with minor suggestions
**Branch**: `feature/no-more-hook-files`

---

## Phase 0: Documentation Discovery (Completed by Orchestrator)

### Allowed APIs and Patterns

**Exit Code Constants** - `src/shared/hook-constants.ts:18-23`:
```typescript
export const HOOK_EXIT_CODES = {
  SUCCESS: 0,
  FAILURE: 1,
  BLOCKING_ERROR: 2,
} as const;
```

**Timeout Constants** - `src/shared/hook-constants.ts:1-8`:
```typescript
export const HOOK_TIMEOUTS = {
  DEFAULT: 300000,
  HEALTH_CHECK: 30000,
  WORKER_STARTUP_WAIT: 1000,
  WORKER_STARTUP_RETRIES: 300,
  PRE_RESTART_SETTLE_DELAY: 2000,
  WINDOWS_MULTIPLIER: 1.5
} as const;
```

**Platform Timeout Function** - `src/services/infrastructure/ProcessManager.ts:70-73`:
```typescript
export function getPlatformTimeout(baseMs: number): number {
  const WINDOWS_MULTIPLIER = 2.0;
  return process.platform === 'win32' ? Math.round(baseMs * WINDOWS_MULTIPLIER) : baseMs;
}
```

**Migration Guide Pattern** - `docs/public/architecture/pm2-to-bun-migration.mdx`:
- Uses MDX format with frontmatter
- Starts with `<Note>` for historical context
- Uses `<AccordionGroup>` for before/after comparisons
- Includes executive summary, key benefits, migration impact sections

**Exit Code Documentation** - `private/context/claude-code/exit-codes.md`:
- Defines exit code 0, 2, and other behaviors
- Per-hook event behavior table

### Files to Modify

| File | Change | Lines |
|------|--------|-------|
| `src/services/infrastructure/ProcessManager.ts` | Add POWERSHELL_TIMEOUT constant, reduce from 60000 to 10000 | 93, 123, 175, 241 |
| `src/shared/hook-constants.ts` | Add POWERSHELL_TIMEOUT constant | After line 8 |
| `CLAUDE.md` | Document exit code strategy | Architecture section |

### Anti-Patterns to Avoid

- DO NOT invent new exit code values (only 0, 1, 2 exist)
- DO NOT change Windows multiplier (1.5x in hooks, 2.0x in ProcessManager - they serve different purposes)
- DO NOT add upper bound PID validation (not in existing pattern, reviewers marked as "nice to have")
- DO NOT create migration guide for Cursor (shell scripts still exist in cursor-hooks/, not removed)

---

## Phase 1: Extract PowerShell Timeout Constant

### What to Implement

Add a `POWERSHELL_TIMEOUT` constant to centralize the magic number `60000` and reduce to `10000` (10 seconds) as recommended by reviewers.

### Documentation References

1. Copy constant pattern from `src/shared/hook-constants.ts:1-8`
2. Copy usage pattern from `src/services/infrastructure/ProcessManager.ts:93`

### Implementation Steps

1. **Add constant to hook-constants.ts** after line 8:
   ```typescript
   POWERSHELL_COMMAND: 10000,     // PowerShell process enumeration (10s - typically completes in <1s)
   ```

2. **Import and use in ProcessManager.ts**:
   - Import `HOOK_TIMEOUTS` from `../../shared/hook-constants.js`
   - Replace `{ timeout: 60000 }` with `{ timeout: HOOK_TIMEOUTS.POWERSHELL_COMMAND }` at lines 93, 123, 175, 241

### Verification Checklist

- [ ] `grep -n "60000" src/services/infrastructure/ProcessManager.ts` returns 0 matches
- [ ] `grep -n "POWERSHELL_COMMAND" src/services/infrastructure/ProcessManager.ts` returns 4 matches
- [ ] `npm run build` succeeds
- [ ] `npm test` passes (22/22 PowerShell tests still pass)

### Anti-Pattern Guards

- DO NOT use `getPlatformTimeout()` for PowerShell commands (they already run only on Windows)
- DO NOT change timeout values in other files (only ProcessManager.ts uses PowerShell)

---

## Phase 2: Document Exit Code Strategy in CLAUDE.md

### What to Implement

Add an "Exit Code Strategy" section to the main CLAUDE.md to explain the graceful exit philosophy adopted in this PR.

### Documentation References

1. Copy exit code definitions from `private/context/claude-code/exit-codes.md`
2. Follow format of existing CLAUDE.md sections

### Implementation Steps

1. **Add section after "File Locations"** in `/Users/alexnewman/Scripts/claude-mem/CLAUDE.md`:

```markdown
## Exit Code Strategy

Claude-mem hooks use specific exit codes per Claude Code's hook contract:

- **Exit 0**: Success or graceful shutdown (Windows Terminal closes tabs)
- **Exit 1**: Non-blocking error (stderr shown to user, continues)
- **Exit 2**: Blocking error (stderr fed to Claude for processing)

**Philosophy**: Worker/hook errors exit with code 0 to prevent Windows Terminal tab accumulation. The wrapper/plugin layer handles restart logic. ERROR-level logging is maintained for diagnostics.

See `private/context/claude-code/exit-codes.md` for full hook behavior matrix.
```

### Verification Checklist

- [ ] `grep -n "Exit Code Strategy" CLAUDE.md` returns 1 match
- [ ] Section appears after "File Locations" section
- [ ] No duplicate sections added

### Anti-Pattern Guards

- DO NOT copy the full exit-codes.md table (keep it brief, reference the source)
- DO NOT change actual exit code behavior in code files

---

## Phase 3: Update Tests for New Timeout Constant

### What to Implement

Add test coverage for the new `POWERSHELL_COMMAND` timeout constant.

### Documentation References

1. Copy test pattern from `tests/hook-constants.test.ts:26-48`

### Implementation Steps

1. **Add test to hook-constants.test.ts** after line 42:
   ```typescript
   test('POWERSHELL_COMMAND timeout is 10000ms', () => {
     expect(HOOK_TIMEOUTS.POWERSHELL_COMMAND).toBe(10000);
   });
   ```

### Verification Checklist

- [ ] `npm test -- tests/hook-constants.test.ts` passes
- [ ] New test appears in test output
- [ ] All 22 PowerShell parsing tests still pass

### Anti-Pattern Guards

- DO NOT modify PowerShell parsing tests (they test parsing, not timeouts)
- DO NOT add integration tests for actual PowerShell execution (out of scope)

---

## Phase 4: Final Verification

### Verification Checklist

1. **Build passes**: `npm run build`
2. **All tests pass**: `npm test`
3. **No magic numbers remain**: `grep -rn "60000" src/services/infrastructure/ProcessManager.ts` returns 0
4. **Exit code documentation exists**: `grep -n "Exit Code Strategy" CLAUDE.md` returns 1
5. **Constant is used**: `grep -rn "POWERSHELL_COMMAND" src/` returns multiple matches

### Anti-Pattern Grep Checks

- [ ] `grep -rn "timeout: 60000" src/` returns 0 matches (no hardcoded 60s timeouts in ProcessManager)
- [ ] `grep -rn "process.exit(3)" src/` returns 0 matches (exit code 3 not used)

### Commit Message Template

```
polish: extract PowerShell timeout constant and document exit code strategy

- Extract magic number 60000ms to HOOK_TIMEOUTS.POWERSHELL_COMMAND (10000ms)
- Reduce PowerShell timeout from 60s to 10s per review feedback
- Document exit code strategy in CLAUDE.md
- Add test coverage for new constant

Addresses review feedback from PR #628

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
```

---

## Summary

| Phase | Description | Files Changed | Verification |
|-------|-------------|---------------|--------------|
| 0 | Documentation Discovery | N/A | Patterns identified |
| 1 | Extract PowerShell timeout | hook-constants.ts, ProcessManager.ts | grep + build + test |
| 2 | Document exit strategy | CLAUDE.md | grep |
| 3 | Add test coverage | hook-constants.test.ts | npm test |
| 4 | Final verification | N/A | All checks pass |

**Estimated Changes**: ~20 lines added/modified across 4 files
**Risk Level**: Low (constants extraction, documentation only)
**Breaking Changes**: None
