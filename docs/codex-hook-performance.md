# Codex hook performance measurements

Measured on Windows on 2026-10-27 while investigating hook timeout reports.
The measurement includes process startup, not just HTTP request duration.

## Process startup control

A Node process used `spawnSync` to start each executable three times in sequence,
timing from immediately before spawn until child exit. Each child only wrote
`ok`, exited successfully, and emitted no stderr. PowerShell used `-NoLogo
-NoProfile -NonInteractive`. These are first-process and subsequent samples,
not controlled OS cold-cache measurements.

| Child | Samples (ms) | Median (ms) |
| --- | --- | --- |
| Node | 3410, 2120, 466 | 2120 |
| Bun | 2066, 164, 133 | 164 |
| Windows PowerShell 5.1 | 2791, 4209, 3704 | 3704 |

The control demonstrates substantial and variable Windows process-start cost.
It does not attribute that cost to antivirus, scheduling, or another cause.
The full hook command starts several processes, so these controls must not be
subtracted as constants or added together to predict a hook's duration.

Earlier individual installed-hook probes took 5455 ms through the Node runner
and 13170 ms through the complete Windows command. Both held stdin open after
a complete JSON object. They establish successful execution, not a per-hook
latency distribution.

## Per-hook comparison

Systematic measurements and implementation optimization are in progress in
`scripts/profile-claude-mem-hooks.*`. The harness must use isolated settings and
worker fixtures, verify handler execution, keep stdin open, and measure the
unchanged Windows command. Fixture results exclude live provider processing and
do not establish native Codex hook invocation or production worker health.

Hook definitions are frozen during this comparison. All three installed copies
and the worktree's `plugin/hooks/codex-hooks.json` have SHA-256
`bcc109f98d27611d5bfb36c7b925de1b6bfa216eb41a86d855301f02935ce6af`.
The current limits are 20 seconds for SessionStart, UserPromptSubmit,
PostToolUse, PostCompact and SubagentStart; 30 seconds for PreToolUse; and
60 seconds for Stop.
