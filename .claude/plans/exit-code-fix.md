# Plan: Fix Exit Code Issues Causing Claude Startup Hang

## Problem Summary

Claude startup hangs when claude-mem plugin is built and synced.

## Root Cause

The **deprecated user-message hook** is still in `hooks.json` but references a non-existent exit code constant:

1. `hooks.json:25` still calls `hook claude-code user-message`
2. `user-message.ts:44` returns `HOOK_EXIT_CODES.USER_MESSAGE_ONLY`
3. `USER_MESSAGE_ONLY` doesn't exist in `hook-constants.ts`
4. Handler crashes → exit code 2 (blocking) → hang

## Context from Memory

Per observations #40649 and #40651 (Jan 15, 2026):
- User-message hook was **deprecated and supposed to be removed**
- Restructuring was verified complete with grep showing zero matches
- But current `hooks.json` still has the deprecated hook (changes may not have been synced)

---

## Phase 1: Remove Deprecated user-message Hook from hooks.json

### Task 1.1: Remove user-message command from SessionStart

**File**: `plugin/hooks/hooks.json`

Delete lines 23-27 (the user-message hook entry):
```json
{
  "type": "command",
  "command": "bun \"${CLAUDE_PLUGIN_ROOT}/scripts/worker-service.cjs\" hook claude-code user-message",
  "timeout": 60
}
```

### Verification
```bash
grep -c "user-message" plugin/hooks/hooks.json  # Should be 0
```

---

## Phase 2: Remove Dead Code

### Task 2.1: Delete user-message handler

**File to delete**: `src/cli/handlers/user-message.ts`

This handler is no longer called from hooks.json.

### Task 2.2: Remove from handler registry

**File**: `src/cli/handlers/index.ts`

Remove the user-message export/registration.

### Verification
```bash
grep -r "user-message" src/cli/handlers/  # Should be 0
```

---

## Phase 3: Build and Test

### Task 3.1: Build
```bash
npm run build-and-sync
```

### Task 3.2: Test startup
1. Start new Claude Code session
2. Verify no hang
3. Verify context loads

### Verification Checklist
- [ ] Build succeeds
- [ ] `grep user-message plugin/hooks/hooks.json` returns nothing
- [ ] Claude Code starts without hanging
- [ ] Context injection still works (via context hook)

---

## Anti-Pattern Guards

1. **DO NOT** add the missing `USER_MESSAGE_ONLY` constant - the hook is deprecated
2. **DO NOT** keep dead code - delete the handler since it's not used
3. **DO NOT** modify context-hook - it already handles what user-message did

---

## Summary

Remove the deprecated user-message hook that was supposed to be removed but wasn't synced. Delete the dead handler code.
