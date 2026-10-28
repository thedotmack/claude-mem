# Codex hook performance measurements

Measured on Windows on 2026-10-28. The final paired run is `2026-10-28T01-08-33-068Z-66212`.
The sanitized [sample evidence](benchmarks/codex-hooks-windows-2026-10-28.json)
includes every final sample and the earlier run aborted during process cleanup.

## Implementation

The hook entry loads 771,801 bytes instead of the 4,304,520-byte full
worker bundle (82.1% smaller). Eligible local-worker Codex hooks run inside the
existing Node launcher, avoiding an additional Bun process. File-context keeps
Bun SQLite and its atomic deduplication; server runtime and remote spool retain
their Bun execution path. The file-context handler loads lazily.

The launcher consumes a complete JSON object without waiting for stdin EOF.
Node exits naturally after HTTP handles drain. Forced exit reproduced a Windows
Node 24.15.0 assertion during development; the real-HTTP regression test exercises
Node with a failing Bun shim, so fallback cannot hide a recurrence.

## Full Windows command comparison

Three samples per variant per hook, paired in alternating order. Timings include
the exact frozen `commandWindows` through Windows PowerShell 5.1, process startup,
hook work, and process exit. Complete JSON stdin stays open. Isolated data roots
and a local HTTP fixture verify output, routes, durable spooling, and the pending
compaction gate. The continuation runs the actual PostToolUse Windows command and
is timed separately. No production memories or provider requests are generated.

| Hook | Before median (s) | After median (s) | After max (s) | Limit (s) | Breaches before / after |
| --- | ---: | ---: | ---: | ---: | ---: |
| SessionStart | 13.08 | 12.63 | 17.83 | 20 | 1 / 0 |
| UserPromptSubmit | 8.95 | 7.29 | 9.88 | 20 | 0 / 0 |
| PreToolUse | 9.87 | 14.22 | 16.33 | 30 | 0 / 0 |
| PostToolUse | 10.48 | 8.57 | 8.81 | 20 | 0 / 0 |
| Stop | 7.64 | 6.78 | 7.46 | 60 | 0 / 0 |
| PostCompact | 7.63 | 6.95 | 7.79 | 20 | 0 / 0 |
| SubagentStart | 7.60 | 6.83 | 7.32 | 20 | 0 / 0 |
| PostToolUse after compaction | 11.56 | 7.42 | 9.89 | 20 | 0 / 0 |

The final run recorded 1 baseline and 0 optimized deadline breaches,
and 0 optimized samples with invalid behavior. Deadline breaches count even
when a hook eventually returns valid output. A hard timeout is censored at the
profiler's cutoff, with cleanup measured separately. Medians use behavior-valid
samples; the JSON evidence also retains every invalid or timed-out sample.

Approximate per-sample host CPU utilization ranged from 67.7% to 100.0%
(median 98.2%). Three samples under changing load do not establish
a statistically reliable speedup. The earlier aborted run also included an
optimized continuation exceeding 20 seconds; its incomplete status is preserved.
These measurements establish synthetic command behavior, not native Codex
callback invocation or automatic capture in the currently open conversation.

## Installation and verification

Installed the runner and new hook bundle/map in all three local plugin copies,
with matching marketplace source changes (14 files total). The previous
files and measurement reports are backed up under the user's claude-mem backups.
An isolated probe of the installed Codex plugin returned the expected context in
6.73 seconds, exit code 0, without invoking Bun.
The worker daemon did not require a restart.

The frozen resolver requires `node_modules` for an explicit plugin root but
accepts a dependency-free install through its cache search. The Codex cache has
no `node_modules`; the isolated installed probe used a cache junction pointing
to that actual copy. Normal commands can fall back to the Claude Code cache,
which received the same update. The resolver was left unchanged along with the
rest of the hook definition.

All hook definitions and commands stayed unchanged during this performance work.
The worktree and all three installed Codex hook manifests retain SHA-256
`bcc109f98d27611d5bfb36c7b925de1b6bfa216eb41a86d855301f02935ce6af`. Trust records were not edited.
The existing PostToolUse wall-time limit is 20 seconds and its server-request
budget remains 2 seconds.

Validation: 102 unique focused tests passed, three platform-specific cases were
skipped, and root and viewer TypeScript checks passed. Coverage includes fragmented
UTF-8 stdin, real HTTP shutdown with open stdin, runtime/fallback selection,
packaged execution without node_modules, SQLite deduplication, compaction
reinjection, profiler validation and owned process-tree cleanup.

## Process startup controls

Earlier controls on 2026-10-27 started each executable three times, writing only
`ok`. PowerShell used `-NoLogo -NoProfile -NonInteractive`. These are sequential
samples, not controlled OS cold-cache measurements.

| Child | Samples (ms) | Median (ms) |
| --- | --- | --- |
| Node | 3410, 2120, 466 | 2120 |
| Bun | 2066, 164, 133 | 164 |
| Windows PowerShell 5.1 | 2791, 4209, 3704 | 3704 |

The controls show variable process startup cost; they do not identify its cause
and cannot be added or subtracted as constants from the full-command timings.
Run the profiler with `node scripts/profile-claude-mem-hooks.cjs --samples 3`
after preparing its immutable before/after artifact manifest as described in the
script. Canonical reports explicitly show running/failed states and never reuse
an earlier successful result after a failed run.
