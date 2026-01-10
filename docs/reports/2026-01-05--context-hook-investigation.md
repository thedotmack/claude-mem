# Context Hook Investigation Report

**Date:** 2026-01-05
**Branch:** `feature/no-more-hook-files`
**Status:** Partial fix committed, additional issues identified

## Problem

User reported no startup context appearing when testing the new unified CLI hook architecture.

## Root Cause Identified

**SessionStart hooks don't receive stdin data from Claude Code.**

The unified CLI architecture assumed all hooks receive stdin JSON data. When `readJsonFromStdin()` returns `undefined` for SessionStart, the platform adapters crashed:

```
TypeError: undefined is not an object (evaluating 'e.session_id')
```

**Location:** `src/cli/adapters/claude-code.ts:6` and `src/cli/adapters/cursor.ts:7`

The adapters did `const r = raw as any;` then accessed `r.session_id`, which fails when `raw` is `undefined`.

## Fix Applied

Changed both adapters to handle undefined input:

```typescript
// Before
const r = raw as any;

// After
const r = (raw ?? {}) as any;
```

**Commit:** `78c2a0ef` - Pushed to `feature/no-more-hook-files`

## Additional Issue Discovered (Not Yet Fixed)

There's a **path mismatch** in the hooks.json that may cause issues:

- hooks.json references: `${CLAUDE_PLUGIN_ROOT}/scripts/worker-service.cjs`
- Actual file location: `${CLAUDE_PLUGIN_ROOT}/plugin/scripts/worker-service.cjs`

The marketplace sync copies the whole repo structure, so files end up in a `plugin/` subdirectory. Need to verify what `CLAUDE_PLUGIN_ROOT` resolves to and whether the paths are correct.

## Verification Needed

1. Start a new Claude Code session and verify context appears
2. Check that `CLAUDE_PLUGIN_ROOT` points to correct directory
3. Verify hooks.json paths match actual file locations

## Files Changed

- `src/cli/adapters/claude-code.ts` - Added null coalescing for stdin
- `src/cli/adapters/cursor.ts` - Added null coalescing for stdin
- `plugin/scripts/worker-service.cjs` - Rebuilt with fix

## Next Steps

1. Test the fix in a live Claude Code session
2. Investigate the `CLAUDE_PLUGIN_ROOT` path resolution
3. Fix paths in hooks.json if needed
