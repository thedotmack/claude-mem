# Observer Session Retention Implementation Plan

> **For agentic workers:** Execute inline in this session. Follow TDD and do not commit, push, or deploy without the repository owner's separate permission.

**Goal:** Preserve active claude-mem resume sessions while removing each completed observer JSONL, preventing the Agent SDK 0.3.207 transcript amplification, and stopping quota-driven observer respawns.

**Architecture:** A focused cleanup module resolves one UUID transcript inside Claude Code's observer project directory and deletes it best-effort. The generator exit lifecycle invokes it only after the child process exits and session finalization succeeds. A process-wide quota gate holds queued work without spawning Claude and admits one tokenized recovery probe after cooldown. The build dependency is pinned to SDK 0.3.202.

**Tech Stack:** TypeScript, Bun test, Node filesystem APIs, Claude Agent SDK, npm lockfile, esbuild bundle.

## Global Constraints

- Keep claude-mem enabled.
- Keep active-session `resume` behavior and do not set `persistSession: false`.
- Delete only a canonical UUID `.jsonl` inside the derived observer project directory.
- Do not clean a quota-paused session or a session whose finalization failed.
- Cleanup failures are non-fatal.
- Pin `@anthropic-ai/claude-agent-sdk` to exact version `0.3.202`.
- Do not modify the dirty marketplace worktree.
- Keep the separate leak monitor read-only; it may inspect processes and
  observer files but must never stop or delete them.
- Do not commit or push.

---

### Task 1: Safe observer transcript cleanup module

**Files:**
- Create: `tests/worker/observer-transcript-cleanup.test.ts`
- Create: `src/services/worker/session/ObserverTranscriptCleanup.ts`

**Interfaces:**
- Produces: `resolveObserverTranscriptPath(sessionId, claudeConfigDir?, observerSessionsDir?): string | null`
- Produces: `removeObserverTranscriptForSession(sessionId, claudeConfigDir?, observerSessionsDir?): Promise<ObserverTranscriptCleanupResult>`

- [ ] **Step 1: Write the failing tests**

Cover a canonical UUID regular file, a missing file, a traversal ID, and a symlink. Use temporary config and observer directories and derive the project slug with the production resolver.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
bun test tests/worker/observer-transcript-cleanup.test.ts
```

Expected: FAIL because `ObserverTranscriptCleanup.ts` does not exist.

- [ ] **Step 3: Implement the minimal cleanup module**

Implement canonical UUID validation, `resolve()`/`dirname()` containment, `lstat()` regular-file validation, `unlink()`, and these statuses:

```ts
export type ObserverTranscriptCleanupResult =
  | 'deleted'
  | 'missing'
  | 'invalid'
  | 'unsafe'
  | 'failed';
```

Treat `ENOENT` as `missing`; catch and log all other filesystem failures.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the same Bun command. Expected: all cleanup tests pass.

### Task 2: Integrate cleanup after successful non-quota finalization

**Files:**
- Modify: `tests/worker/poison-respawn.test.ts`
- Modify: `src/services/worker/session/GeneratorExitHandler.ts`

**Interfaces:**
- Consumes: `removeObserverTranscriptForSession` from Task 1.
- Extends: `GeneratorExitDependencies` with an optional cleanup function for deterministic lifecycle tests.

- [ ] **Step 1: Write failing lifecycle tests**

Add tests proving:

```ts
expect(events).toEqual(['finalize', 'cleanup']);
expect(removeSpy).toHaveBeenCalled();
```

and that cleanup is not called when `finalizeSession` rejects. Keep the existing quota test as the quota guard.

- [ ] **Step 2: Run the lifecycle test and verify RED**

Run:

```bash
bun test tests/worker/poison-respawn.test.ts
```

Expected: FAIL because the cleanup dependency is not called.

- [ ] **Step 3: Implement lifecycle ordering**

Import the production cleanup function. After the existing subprocess-exit wait, return early for quota. On the non-quota path, set a `finalized` flag only after `finalizeSession` resolves. In `finally`, call cleanup only when finalized, catch any unexpected cleanup rejection, then always remove the in-memory session.

- [ ] **Step 4: Run focused lifecycle and cleanup tests**

Run:

```bash
bun test tests/worker/observer-transcript-cleanup.test.ts tests/worker/poison-respawn.test.ts tests/claude-provider-resume.test.ts
```

Expected: all tests pass and resume tests remain unchanged.

### Task 3: Stop quota-driven observer respawns

**Files:**
- Modify: `tests/worker/rate-limit-store.test.ts`
- Modify: `tests/worker/poison-respawn.test.ts`
- Modify: `tests/worker/claude-setup-gate.test.ts`
- Modify: `tests/services/worker/session-message-buffer.test.ts`
- Modify: `src/services/worker/RateLimitStore.ts`
- Modify: `src/services/worker/SessionMessageBuffer.ts`
- Modify: `src/services/worker/SessionManager.ts`
- Modify: `src/services/worker/agents/ResponseProcessor.ts`
- Modify: `src/services/worker/http/routes/SessionRoutes.ts`
- Modify: `src/services/worker/ClaudeProvider.ts`
- Modify: `src/services/worker-types.ts`
- Modify: `src/shared/worker-utils.ts`
- Modify: `src/shared/SettingsDefaultsManager.ts`
- Modify: `tests/cli/hook-stream-discipline.test.ts`

- [ ] **Step 1: Write and run failing spawn-gate tests**

Prove that quota prose records a cooldown, starts are skipped during it, only
one tokenized probe is admitted at the boundary, and matching non-quota output
reopens starts.

- [ ] **Step 2: Implement the process-wide gate and session token**

Add a 15-minute cooldown and bounded probe lease to `RateLimitStore`. Gate only
Claude starts, leave queued messages untouched, and attach the probe token to
the admitted session.

- [ ] **Step 3: Wire quota and recovery signals**

Block on both prose and structured quota. Complete only the active probe token
after a non-quota Claude response. Treat direct provider rate-limit errors the
same way and preserve the existing quota exit path.

- [ ] **Step 4: Bound paused work and throttle repeated diagnostics**

Cap each session at 200 buffered messages and 8 MiB, evict oldest unclaimed
work, reject one oversized fragment, and never evict claimed work. Suppress
per-hook queue info during active cooldown and throttle skip warnings.

- [ ] **Step 5: Make worker outages strictly fail-open**

Keep the failure counter and one threshold diagnostic, but remove the
worker-unreachable `exit 2` path so claude-mem can never block a host prompt or
tool hook.

- [ ] **Step 6: Run focused tests and verify no per-hook start**

Run the three changed worker test files and inspect a live quota interval after
deployment.

### Task 4: Pin SDK, build, install, and verify live retention

**Files:**
- Create: `tests/infrastructure/agent-sdk-version-pin.test.ts`
- Modify: `package.json`
- Generated: `plugin/scripts/worker-service.cjs`

**Interfaces:**
- Produces: a 13.11.0 worker bundle embedding Agent SDK 0.3.202.

- [ ] **Step 1: Write and run the failing dependency contract**

The test reads `package.json` and the installed SDK package metadata and expects both versions to equal `0.3.202`. The root npm lockfile is intentionally ignored. Run:

```bash
bun test tests/infrastructure/agent-sdk-version-pin.test.ts
```

Expected: FAIL because the declaration is `^0.3.172` and the lock resolves 0.3.207.

- [ ] **Step 2: Pin the dependency**

Run:

```bash
npm install --save-dev --save-exact @anthropic-ai/claude-agent-sdk@0.3.202
```

Re-run the contract. Expected: PASS.

- [ ] **Step 3: Run focused and distribution tests**

Run:

```bash
bun test tests/worker/observer-transcript-cleanup.test.ts tests/worker/poison-respawn.test.ts tests/security/observer-tool-enforcement.test.ts tests/claude-provider-resume.test.ts tests/infrastructure/agent-sdk-version-pin.test.ts tests/infrastructure/plugin-distribution.test.ts tests/infrastructure/version-consistency.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 4: Build and verify the artifact**

Run:

```bash
npm run build
```

Verify the worker contains Agent SDK 0.3.202 and the cleanup log strings, and does not contain Agent SDK 0.3.207 as its embedded version.

- [ ] **Step 5: Back up and install only the worker artifact**

Stop the worker, copy both current runtime workers into a new timestamped recovery directory, copy the rebuilt `plugin/scripts/worker-service.cjs` into the Claude and Codex 13.11.0 caches, and restart. Do not overwrite the dirty marketplace worktree.

- [ ] **Step 6: Verify live behavior**

Check worker health and plugin enablement. Exercise a fresh observer session, confirm its JSONL exists while active, finish the session, and confirm the exact JSONL disappears. Measure observer directory size and APFS free space over repeated intervals. Record commands and results without claiming anything not freshly verified.

### Task 5: Eliminate restart-created Chroma orphans and widen detection

**Files:**
- Modify: `src/services/infrastructure/GracefulShutdown.ts`
- Modify: `src/services/sync/ChromaMcpManager.ts`
- Modify: `tests/infrastructure/graceful-shutdown.test.ts`
- Modify: `tests/services/sync/chroma-mcp-manager-singleton.test.ts`
- Modify in headquarters: `codex/bin/claude-mem-leak-watch.py`
- Modify in headquarters: `codex/tests/test_claude_mem_leak_watch.py`

- [ ] **Step 1: Reproduce and explain the prior incident**

Load only the relevant gbrain records. Confirm that the 2026-07-13 action
stopped orphaned processes and installed monitoring but did not patch the
program root. Compare that incident with the observer JSONL/quota path.

- [ ] **Step 2: Write failing shutdown and orphan-recovery tests**

Prove an already-closed HTTP server cannot abort cleanup, Chroma stop runs
before a blocked session drain, and startup reaps only `PPID=1` Chroma roots
for the exact local data directory.

- [ ] **Step 3: Make shutdown idempotent and self-healing**

Ignore only `ERR_SERVER_NOT_RUNNING`, move Chroma stop before session drain,
and add a POSIX startup sweep for exact matching orphan roots. Keep the sweep
best-effort and leave unrelated/live processes untouched.

- [ ] **Step 4: Extend the existing read-only monitor**

Track worker count, observer JSONL count/size, and five-minute growth. Alert on
duplicate workers, 1 GiB or 250 files, or 256 MiB/50 files of interval growth.
Retain the destructive-operation source guard.

- [ ] **Step 5: Prove the live restart invariant**

Run a controlled restart with the final bundle. Require an orderly Chroma stop,
`Worker shutdown complete`, one successor worker, one active Chroma root, zero
orphan roots, and no successor-side orphan reap for that cycle.

### Task 6: Review and handoff

**Files:**
- Review all files listed above.

- [ ] **Step 1: Inspect scoped diff and unrelated state**

Run `git status --short` and `git diff --check` in the isolated worktree, and separately verify the original marketplace worktree's pre-existing dirty files are unchanged.

- [ ] **Step 2: Run final verification gate**

Re-run the focused tests, worker status, runtime hashes, JSONL count/size, `df`, and swap usage.

- [ ] **Step 3: Report without commit or push**

List modified and generated files, exact checks, remaining risks, current free space, and state that no commit or push was performed.
