# Observer session retention fix

## Problem

Claude-mem runs internal Claude Code observer sessions with `cwd` set to
`OBSERVER_SESSIONS_DIR`. Claude Code persists those sessions as JSONL files
under its project transcript directory. Active persistence is required for
claude-mem's `resume` behavior, but completed observer transcripts are never
removed. A local rebuild with Agent SDK 0.3.207 also amplified
`queue-operation` records and produced multi-gigabyte daily growth.

Live verification exposed a second growth path. When Claude returns its usage
limit as ordinary assistant prose instead of a structured `rate_limit` event,
the worker preserves the queued batch but records no process-wide pause. Every
subsequent hook therefore starts another observer for the same quota-limited
work and appends to the transcript again.

Comparison with the 2026-07-13 incident exposed a separate retained-process
path. That repair stopped 73 orphaned uv/Chroma trees and installed a
read-only monitor, but explicitly did not patch claude-mem. During restart,
the HTTP server can already be closed when graceful cleanup begins.
`ERR_SERVER_NOT_RUNNING` aborted the remaining cleanup, and the global
shutdown deadline could also expire while observer sessions drained before
Chroma was stopped. Each restart therefore left one uv/python Chroma tree
re-parented to launchd (`PPID=1`). The old monitor saw Chroma and resource
pressure, but did not measure observer JSONL growth.

## Success criteria

- Claude-mem remains enabled and keeps active-session `resume` behavior.
- A transcript is removed only after its observer subprocess has exited and
  the matching claude-mem session has been finalized.
- Quota-paused or otherwise active sessions retain their transcripts.
- A prose or structured Claude quota response blocks new observer starts for
  a bounded cooldown while new hook data remains queued in memory.
- After cooldown, only one observer is admitted as a recovery probe. Other
  sessions remain stopped until that probe proves quota recovery.
- A paused session buffer is bounded to 200 messages and 8 MiB. Oldest
  unclaimed fragments are evicted first; claimed work is never evicted.
- Repeated hooks during cooldown do not emit one quota warning and one queue
  info line per request.
- Worker unavailability is strictly fail-open. Claude-mem may record one
  bounded diagnostic, but it never exits 2 or blocks UserPromptSubmit,
  PostToolUse, or another host workflow.
- Cleanup is constrained to one UUID-named JSONL file inside the derived
  observer project directory.
- Missing, invalid, symlinked, or undeletable files never break session
  finalization.
- The distributed worker is built with Agent SDK 0.3.202 rather than the
  locally resolved 0.3.207 regression.
- Graceful restart treats an already-closed HTTP server as idempotent, stops
  Chroma before the potentially slow observer-session drain, and leaves no
  Chroma root with `PPID=1`.
- After an abrupt worker death, the successor reaps only orphaned POSIX Chroma
  roots with the exact same persistent data directory before starting its own.
- The installed read-only leak monitor detects duplicate workers, absolute
  observer accumulation, and rapid observer growth in addition to its prior
  Chroma/swap/disk checks.

## Considered approaches

1. Set `persistSession: false`. This prevents disk writes, but Claude Code
   explicitly makes those sessions non-resumable. Rejected because it would
   degrade claude-mem continuity.
2. Set `cleanupPeriodDays: 1`. This leaves same-day growth untouched and does
   not address the observed 16 GB burst. Rejected as insufficient.
3. Keep persistence while active, then remove the exact transcript after
   successful finalization and subprocess exit. This preserves behavior and
   bounds retained data to active sessions. Selected.

## Design

Add a small observer transcript cleanup module next to the session lifecycle.
It derives the project directory using the existing Claude Code path encoding,
validates a canonical UUID, confirms the candidate remains inside the observer
directory, rejects symlinks and non-regular files, and unlinks only the exact
`<session-id>.jsonl` file. It returns a status instead of throwing and logs
non-fatal failures.

The non-quota generator-exit path already waits for the tracked Claude process
to exit before finalization. After `finalizeSession` succeeds, it calls the
cleanup module with `session.memorySessionId`, then removes the in-memory
session. The quota path returns before cleanup, preserving resume state.

Extend the process-wide Claude rate-limit store with a spawn gate. A quota
response starts a 15-minute cooldown. Once it expires, an atomic permit admits
one probe and gives it a bounded lease; concurrent hook requests remain
blocked. The probe token is stored on its active session. A non-quota response
completes only the matching token and opens normal starts again. Another quota
response invalidates any probe and restarts the cooldown. This prevents both
per-hook respawn and a fan-out of all queued sessions at the retry boundary.

Apply the same gate when Claude fails with a direct `rate_limit` or
`quota_exhausted` provider error. Honor a longer provider retry delay when it
is available. Re-check the gate after process-slot and credential awaits so
starts admitted before the quota signal cannot leak through later.

Bound each in-memory session buffer by both message count and estimated encoded
bytes. At capacity, evict the oldest unclaimed fragments and retain recent
work. Reject a single oversized fragment and never evict claimed work. Capacity
warnings and quota-skip diagnostics are throttled to once per minute.

Remove the historical fail-loud hook escalation. The consecutive-failure
counter remains useful for one telemetry/diagnostic event at its threshold,
but every worker-unavailable call returns the existing fallback with
`continue: true`. Blocking feedback remains reserved for genuinely
unrecoverable hook-handler errors, not an optional memory daemon outage.

Pin `@anthropic-ai/claude-agent-sdk` to exact version 0.3.202 in the tracked
build dependency. The repository intentionally ignores its root npm lockfile.
This keeps rebuilt bundles aligned with the clean
13.11.0 runtime that stopped the 0.3.207 amplification.

Make worker teardown idempotent. Ignore only Node's
`ERR_SERVER_NOT_RUNNING` from `server.close()`, then stop Chroma before
waiting for Claude observer processes. This preserves the overall shutdown
deadline without letting a slow session drain skip shared-process cleanup.
On POSIX local-Chroma startup, inspect the process table and tree-kill only
roots with `PPID=1`, a `chroma-mcp` command, and the exact configured
`--data-dir`; live children and unrelated Chroma directories are excluded.

Extend the separate read-only LaunchAgent monitor with observer JSONL count,
logical size, per-interval growth, and worker count. Alert at 1 GiB or 250
files, or at growth of 256 MiB or 50 files in one five-minute interval. The
monitor still never removes files or stops processes.

## Error handling and safety

- Null or malformed session IDs are skipped.
- Path traversal cannot produce a candidate outside the observer project.
- The config root is canonicalized and every path component below it is
  rejected if it is a symlink or non-directory.
- Symlinks and non-regular entries are skipped.
- `ENOENT` is treated as an already-clean state.
- Other filesystem failures are logged and do not fail finalization.
- No general age-based or recursive deletion is introduced.

## Tests and rollout

- Unit tests cover exact deletion, missing files, invalid IDs, and leaf or
  parent-directory symlinks.
- Lifecycle tests prove cleanup runs after successful non-quota finalization
  and does not run on quota pause or finalization failure.
- Spawn-gate tests prove text quota starts the cooldown, only one retry probe is
  admitted, and a matching successful probe reopens normal starts.
- Buffer tests prove count and byte limits, claimed-work protection, and dedup
  correctness after eviction.
- Hook stream tests prove worker-unavailable accounting has no blocking-error
  call, while unrelated unrecoverable handler errors retain their existing
  feedback channel.
- A dependency contract test proves the SDK is declared and installed as 0.3.202.
- Shutdown tests prove cleanup continues when HTTP is already closed and
  Chroma stop runs before a blocked session drain.
- Chroma singleton tests prove startup reaps only a matching orphan root and
  spares live children and unrelated data directories.
- Monitor tests prove duplicate workers, observer accumulation, and rapid
  observer growth transition to leak status without destructive actions.
- Run focused tests, the relevant worker/session test set, the build, and the
  repository's distribution/version checks.
- Install only the rebuilt worker artifact into the Claude and Codex runtime
  caches, restart the worker, then measure live observer-directory growth.

## Scope

This change does not delete user Claude Code conversations, claude-mem's
SQLite database, observations, summaries, or active observer transcripts.
The startup orphan sweep signals only stale claude-mem Chroma process trees;
it does not remove their persistent database.
