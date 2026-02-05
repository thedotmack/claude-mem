# Bugfix Plan: Observer Sessions Authentication Failure

## Problem Summary

Observer sessions fail with "Invalid API key · Please run /login" because the `CLAUDE_CONFIG_DIR` environment variable is being set to an isolated directory (`~/.claude-mem/observer-config/`) that lacks authentication credentials.

## Root Cause

**File:** `src/services/worker/ProcessRegistry.ts` (lines 207-211)

```typescript
const isolatedEnv = {
  ...spawnOptions.env,
  CLAUDE_CONFIG_DIR: OBSERVER_CONFIG_DIR  // <-- This isolates auth credentials!
};
```

This was added in Issue #832 to prevent observer sessions from polluting the `claude --resume` list. However, it also isolates the authentication credentials, breaking the SDK's ability to authenticate with the Anthropic API.

## Evidence

1. Running Claude with alternate config dir reproduces the error:
   ```bash
   CLAUDE_CONFIG_DIR=/tmp/test-claude claude --print "hello"
   # Output: Invalid API key · Please run /login
   ```

2. The observer config directory exists but only has cached feature flags, no authentication:
   - `~/.claude-mem/observer-config/.claude.json` - feature flags only
   - No credentials copied from main `~/.claude/` directory

## Solution

The fix must allow authentication while still isolating session history. Claude Code stores different data types in `CLAUDE_CONFIG_DIR`:
- Authentication credentials (needed)
- Session history/resume list (should be isolated)
- Feature flags and settings (can be shared or isolated)

**Approach:** Do NOT override `CLAUDE_CONFIG_DIR`. Instead, find an alternative solution for Issue #832.

### Alternative Approaches for Session Isolation

1. **Use `--no-resume` flag** (if SDK supports it) - Prevent observer sessions from being resumable
2. **Accept pollution** - Observer sessions in resume list may be acceptable tradeoff
3. **Post-hoc cleanup** - Clean up observer session entries from history after completion
4. **SDK parameter** - Check if SDK has a session isolation option that doesn't affect auth

---

## Phase 0: Documentation Discovery

### Objective
Understand SDK options for session isolation without breaking authentication.

### Tasks
1. Read SDK documentation/source for:
   - Available `query()` options
   - Session isolation mechanisms
   - Authentication handling

2. Read Issue #832 context:
   - What was the original problem?
   - How bad was the pollution?
   - Are there alternative solutions mentioned?

### Verification
- [ ] List all `query()` options available
- [ ] Identify if `--no-resume` or equivalent exists
- [ ] Document the tradeoffs

---

## Phase 1: Fix Authentication

### Objective
Remove the `CLAUDE_CONFIG_DIR` override to restore authentication.

### File to Modify
`src/services/worker/ProcessRegistry.ts`

### Change
Remove lines 207-211 that override `CLAUDE_CONFIG_DIR`:

**Before:**
```typescript
const isolatedEnv = {
  ...spawnOptions.env,
  CLAUDE_CONFIG_DIR: OBSERVER_CONFIG_DIR
};
```

**After:**
```typescript
const isolatedEnv = {
  ...spawnOptions.env
  // CLAUDE_CONFIG_DIR removed - observer sessions need access to auth credentials
  // Session isolation addressed via [alternative approach]
};
```

### Verification
- [ ] Build succeeds: `npm run build`
- [ ] Observer sessions authenticate successfully
- [ ] Observations are saved to database

---

## Phase 2: Address Session Isolation (Issue #832)

### Objective
Find alternative solution to prevent observer sessions from polluting `claude --resume` list.

### Options to Evaluate

1. **Option A: Accept the tradeoff**
   - Observer sessions appear in resume list but users can ignore them
   - No code changes needed beyond Phase 1

2. **Option B: Use isSynthetic flag**
   - If SDK has a flag to mark sessions as non-resumable, use it
   - Requires SDK documentation review

3. **Option C: Post-processing cleanup**
   - After session ends, remove observer entries from history
   - More complex, may have race conditions

### Decision Point
After Phase 0 documentation review, choose the appropriate option.

### Verification
- [ ] Chosen approach documented
- [ ] If code changes made, tests pass
- [ ] Observer sessions either isolated OR tradeoff accepted

---

## Phase 3: Testing

### Manual Tests
1. Start a new Claude Code session with the plugin
2. Verify observations are being saved (check logs)
3. Check that no "Invalid API key" errors appear
4. Verify `claude --resume` behavior (acceptable level of observer entries)

### Verification Checklist
- [ ] `npm run build` succeeds
- [ ] Worker service starts without errors
- [ ] Observations save to database
- [ ] No authentication errors in logs
- [ ] Issue #832 regression acceptable or addressed

---

## Anti-Patterns to Avoid

1. **DO NOT** add `ANTHROPIC_API_KEY` to environment - authentication is handled by Claude Code's built-in credential management
2. **DO NOT** copy credential files to observer config dir - credentials may be in keychain or other secure storage
3. **DO NOT** try to "fix" authentication by adding API key loading - that creates Issue #588 (unexpected API charges)

---

## Files Involved

| File | Purpose |
|------|---------|
| `src/services/worker/ProcessRegistry.ts` | Contains the problematic `CLAUDE_CONFIG_DIR` override |
| `src/shared/paths.ts` | Defines `OBSERVER_CONFIG_DIR` constant |
| `src/services/worker/SDKAgent.ts` | Uses `createPidCapturingSpawn` which sets the env |

---

## Risk Assessment

**Low Risk:** Removing the `CLAUDE_CONFIG_DIR` override is a simple, targeted change.

**Regression Risk (Issue #832):** Observer sessions may appear in `claude --resume` list again. This is a cosmetic issue vs. complete authentication failure, so the tradeoff favors removing the override.
