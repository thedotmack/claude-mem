# Phase 01: Merge PR #745 - Isolated Credentials

**PR:** https://github.com/thedotmack/claude-mem/pull/745
**Branch:** `fix/isolated-credentials-733`
**Status:** Has conflicts, needs rebase
**Review:** Approved by bayanoj330-dev
**Priority:** HIGH - Foundation for credential isolation, required by PR #847

## Summary

Fixes API key hijacking issue (#733) where SDK would use `ANTHROPIC_API_KEY` from random project `.env` files instead of Claude Code CLI subscription billing.

**Root Cause:** The SDK's `query()` function inherits from `process.env` when no `env` option is passed.

**Solution:** Centralized credential management via `~/.claude-mem/.env` with `EnvManager.ts`.

## Files Changed

| File | Change |
|------|--------|
| `src/shared/EnvManager.ts` | NEW: Centralized credential storage and isolated env builder |
| `src/services/worker/SDKAgent.ts` | Pass isolated env to SDK `query()` |
| `src/services/worker/GeminiAgent.ts` | Use `getCredential()` instead of `process.env` |
| `src/services/worker/OpenRouterAgent.ts` | Use `getCredential()` instead of `process.env` |
| `src/shared/SettingsDefaultsManager.ts` | Add `CLAUDE_MEM_CLAUDE_AUTH_METHOD` setting |

## Dependencies

- **None** - This is a foundation PR

## Tasks

- [x] Checkout PR branch `fix/isolated-credentials-733` and rebase onto main to resolve conflicts
  - ✓ Resolved 4 conflicts (3 build artifacts, 1 source file)
  - ✓ Merged both main's zombie process cleanup and PR's isolated credentials into SDKAgent.ts
  - ✓ Commit 006ff401 now sits on top of main (aedee33c)
- [x] Review `EnvManager.ts` implementation for security and correctness
  - ✓ **Security Assessment - PASS**:
    - Credentials stored in user-private location (`~/.claude-mem/.env`) with standard file permissions
    - `buildIsolatedEnv()` explicitly excludes `process.env` credentials, preventing Issue #733
    - Only whitelisted essential system vars (PATH, HOME, NODE_ENV, etc.) are passed to subprocesses
    - Quote stripping in `.env` parser handles both single and double quotes correctly
    - No credential logging - keys are never written to logs
  - ✓ **Correctness Assessment - PASS**:
    - `loadClaudeMemEnv()` gracefully returns empty object if `.env` doesn't exist (enables CLI billing fallback)
    - `saveClaudeMemEnv()` preserves existing keys and creates directory if needed
    - `getCredential()` used correctly by GeminiAgent and OpenRouterAgent
    - SDKAgent passes `isolatedEnv` to SDK query() options, blocking random API key pollution
    - Auth method description properly reflects whether CLI billing or explicit API key is used
  - ✓ **Code Quality - GOOD**:
    - Well-documented with JSDoc comments explaining Issue #733 fix
    - Type-safe with `ClaudeMemEnv` interface
    - Essential vars list covers cross-platform needs (Windows, Linux, macOS)
- [x] Verify build succeeds after rebase
  - ✓ Build completed successfully: worker-service (1788KB), mcp-server (332KB), context-generator (61KB), viewer UI
- [x] Run test suite to ensure no regressions
  - ✓ Fixed console.log/console.error usage in EnvManager.ts (replaced with logger calls per project standards)
  - ✓ All 797 tests pass (0 fail, 3 skip)
- [x] Merge PR #745 to main with admin override if needed
  - ✓ Merged with `--no-ff` to preserve commit history
  - ✓ Commit 486570d2 on main includes all 4 PR commits
  - ✓ GitHub branch protection bypassed with admin privileges
  - ✓ PR #745 auto-closed by GitHub upon detecting commits in main
  - ✓ Build verified successful after merge
- [x] Verify auth method shows "Claude Code CLI (subscription billing)" in logs after merge
  - ✓ Rebuilt and synced local code (v9.0.14 release predated PR merge, so needed fresh build)
  - ✓ Restarted worker with PR #745 code
  - ✓ Confirmed log output: `authMethod=Claude Code CLI (subscription billing)`
  - ✓ Verified `getAuthMethodDescription()` correctly detects no API key in `~/.claude-mem/.env`

## Verification

```bash
# After merge, check logs for correct auth method
grep -i "authMethod" ~/.claude-mem/logs/*.log | tail -5
```

## Notes

- This PR creates the `EnvManager.ts` module that PR #847 depends on
- The isolated env approach ensures SDK subprocess never sees random API keys from parent process
- If no `ANTHROPIC_API_KEY` is in `~/.claude-mem/.env`, Claude Code CLI billing is used (default)
