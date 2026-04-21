# Investigation: Windows 11 Max-Plan Usage Drain (v12.3.3+ regression)

**Branch:** `investigate/windows-infinite-loop-usage-drain`
**Date:** 2026-04-20
**Reporter:** Discord user (Win11 + Claude Code CLI + claude-mem latest)
**Symptoms:**
- "Going into a loop with Claude"
- "Consuming entire Max plan usage in the background"
- "Continuous failed Python hooks" in the morning after updating
- Issue stops only after uninstalling claude-mem

## TL;DR

Between v12.3.2 (last "safe") and v12.3.7 (current), the flat 3-restart cap on
SDK generator crashes was replaced with a time-windowed `RestartGuard` that
**resets its decay window on any successful message**. On Windows, where the
MCP loopback and Claude-executable resolution have additional failure modes
(observation 71051 — *"MCP loopback failure causes 91.6% session failure rate"*),
the worker enters a slow-drip crash loop that never trips the new guard, and
burns the user's Max-plan OAuth token on each restart's Claude Agent SDK call.

## Root-cause chain

1. **Auth path** — `src/shared/EnvManager.ts:215` builds an isolated env for
   every SDK subprocess spawn. When the user has no `ANTHROPIC_API_KEY` in
   `~/.claude-mem/.env`, line 255 passes through `CLAUDE_CODE_OAUTH_TOKEN` from
   the parent Claude Code session. **Every worker-driven Claude call is billed
   against the user's Max subscription.** That is by design, but it's the
   blast-radius multiplier for every other bug in the chain.

2. **Automatic replay on every worker start** —
   `src/services/worker-service.ts:592` calls `processPendingQueues(50)` during
   worker initialization. It re-spawns an SDK subprocess for every session
   with `status IN ('pending', 'processing')` messages
   (`PendingMessageStore.getSessionsWithPendingMessages()`, line 447). A single
   accumulated backlog from a previous failed run becomes a fresh storm of
   Claude calls on the next daemon restart.

3. **RestartGuard is too permissive for slow-drip failures** —
   `src/services/worker/RestartGuard.ts`:
   - `MAX_WINDOWED_RESTARTS = 10` restarts per 60 s
   - `DECAY_AFTER_SUCCESS_MS = 5 min` — on *any* `recordSuccess()` call, the
     restart timestamp array is wiped
   - `ResponseProcessor.ts:211` calls `recordSuccess()` after *any* batch where
     messages were confirmed
   If 1-of-11 SDK invocations succeeds, the window never fills, the decay
   clears history, and restarts continue indefinitely. At the observed 91.6 %
   MCP failure rate this is exactly the regime the user is in.

4. **Two divergent crash-recovery paths** —
   - `src/services/worker-service.ts:822-857` — on restart-guard trip calls
     `terminateSession()` which calls `pendingStore.markAllSessionMessagesAbandoned()`
     (PendingMessageStore.ts:293). Correct behavior.
   - `src/services/worker/http/routes/SessionRoutes.ts:318-330` — on restart-
     guard trip only `session.abortController.abort()`. **Messages remain in
     `pending` state** (explicitly acknowledged in the log message on line 325).
     Next worker startup's `processPendingQueues()` grabs them again, starting
     the loop over.

5. **Exponential-backoff ceiling amplifies damage** —
   `SessionRoutes.ts:348` and `worker-service.ts` both cap backoff at 8 s after
   4+ restarts. Steady state is ~7 restarts/minute ≈ 10 000 SDK invocations/day
   before the guard trips — if it ever does (see #3).

6. **OAuth-expiry has no special handling** — the `unrecoverablePatterns` list
   (`worker-service.ts:713-727`) matches on `'Invalid API key'`, `'API_KEY_INVALID'`,
   `'API key expired'`, `'API key not valid'`. None of these match OAuth-token
   failures. An expired/revoked `CLAUDE_CODE_OAUTH_TOKEN` produces errors that
   the worker treats as transient and retries. Observation 55605 records PR
   #1180 as a prior "OAuth Token Expiry Infinite Retry Loop" fix — the same
   class of bug has re-surfaced against a new token type.

## "Failed Python hooks"

The user's wording is a misattribution. claude-mem's hooks are TypeScript
compiled to `plugin/scripts/*-hook.cjs` and run via Bun/Node. However:

- `uv` (Python toolchain) is installed for ChromaDB, and the `ChromaMcpManager`
  spawns a Python process for vector sync.
- When Chroma sync fails, errors surface in the hook's stderr alongside the
  real Bun/Node hook failure.
- On Windows the message the user most likely saw was the Chroma uv/Python
  subprocess failing, conflated with the hook wrapper's own failure output.

It is **not** that hooks themselves are Python. The underlying bug is the
worker's SDK retry loop.

## Windows-specific amplifiers

- `SDKAgent.ts:466-473` — `where claude.cmd` resolution is tried first on Win32.
  Any environment where `PATHEXT` or `where` behaves oddly (mingw, Git Bash
  with stripped PATH) returns an error that is caught silently and falls
  through to the generic "Claude executable not found". That string IS in
  `unrecoverablePatterns`, so it should abort cleanly — but only if the SDK
  surfaces it. In practice, transient subprocess spawn races on Windows surface
  as generic errors that **don't** match the list, and then restart.
- `worker-spawner.ts:39` — the Windows spawn-cooldown lock (2 min) only
  suppresses *daemon* spawn attempts, not the SDK subprocess spawn-storm
  described here.
- `hook-constants.ts:30-34` — Windows gets a hook-timeout multiplier. Longer
  hook windows = more time for the crash loop to run per session.

## What changed vs v12.3.2

```
src/services/worker/RestartGuard.ts              | 70 ++++++ (NEW)
src/services/worker/http/routes/SessionRoutes.ts | 24 +/-    (MAX=3 → RestartGuard)
src/services/worker-service.ts                   | 28 +/-    (MAX=3 → RestartGuard)
src/services/sqlite/PendingMessageStore.ts       | 19 ++     (clearFailed → clearFailedOlderThan(1h))
```

The regression is squarely in the restart-guard swap. The old flat counter
would have tripped after 3 crashes and stopped the SDK spawn, regardless of
whether anything eventually succeeded.

## Recommended fixes (in priority order)

1. **SessionRoutes.ts restart-guard trip must call `terminateSession`** (or
   `markAllSessionMessagesAbandoned`) — mirror the behavior in
   `worker-service.ts:837`. Today it explicitly leaves messages pending, which
   guarantees re-replay on daemon restart.

2. **Tighten RestartGuard decay** — either
   - require N consecutive successes before decay, not a single one, or
   - track a separate failure rate; if fail-rate > 50 % over the window, trip
     regardless of `recordSuccess()` calls.

3. **Add OAuth-expiry to `unrecoverablePatterns`** — common SDK error strings
   from expired OAuth tokens (`Unauthorized`, `OAuth token expired`,
   `token has been revoked`, 401 responses) should be treated the same as
   `'Invalid API key'`.

4. **Cap absolute restart count per session-lifetime** — RestartGuard caps per
   window but has no absolute ceiling. A hard cap (e.g. 50 restarts regardless
   of window) protects users from the decay-loop regime.

5. **Kill-switch** — a `CLAUDE_MEM_PAUSE_WORKER` setting the user can flip
   without uninstalling, so the next Discord user isn't forced to uninstall
   to stop the bleeding. Hook entrypoints would short-circuit if set.

6. **Telemetry on worker startup** — emit a warning if
   `processPendingQueues()` finds > N orphaned sessions or > M orphaned
   messages. Today the auto-recovery is silent for backlogs of any size.

## Files to touch for the fix

- `src/services/worker/http/routes/SessionRoutes.ts:318-330` — call
  `terminateSession` instead of bare `abort()`.
- `src/services/worker/RestartGuard.ts` — stricter decay semantics + absolute
  cap.
- `src/services/worker-service.ts:713-727` — extend `unrecoverablePatterns`.
- `src/shared/SettingsDefaultsManager.ts` — `CLAUDE_MEM_PAUSE_WORKER` flag.

## What the user should do *right now*

Until a fix ships, the Discord user's mitigation (uninstall) is correct. As
a less-drastic workaround:

1. Stop the worker: `curl -X POST http://localhost:37777/api/shutdown` (or
   kill the `bun` process in Task Manager).
2. Delete `~/.claude-mem/claude-mem.db-wal` and empty the `pending_messages`
   table via sqlite3 to break any stored replay queue.
3. Remove the plugin from `~/.claude.json` until the fix ships.
