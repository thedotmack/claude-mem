# [plan-01] Hook IO Discipline — typed stdout/stderr/exit channel separation

## Defect

claude-mem's lifecycle hooks still conflate stdout (model context), stderr (diagnostics), and exit codes (blocking signal). On constrained or non-POSIX hosts the result is a family of identical-looking failures: `printf: write error: Permission denied` aborts the hook, Codex emits hook-output fields the host rejects, and a hook can block the main conversation by synchronously awaiting the worker. Each is the same missing contract — every emit point must declare an intent (DIAGNOSTIC / MODEL_CONTEXT / USER_HINT / BLOCKING_FEEDBACK / EXIT_SIGNAL) and route to the correct channel, and the worker round-trip must never sit on the conversation's critical path.

## Children

- #2766 — Windows: Stop hook fails with `printf: write error: Permission denied` + path not found
- #2707 — Windows (PowerShell 7): UserPromptSubmit hook fails — `printf: write error: Permission denied`
- #2709 — UserPromptSubmit blocked — `printf` write error (Windows Chinese username, GBK/UTF-8)
- #2722 — [Codex] PreToolUse hook exits 1 on log-write EPERM
- #2765 — Regression: Codex hooks still emit unsupported `suppressOutput` (v13.4.0)
- #2721 — Stop/PostToolUse hooks block the conversation by awaiting worker completion

## Fix sequence

Design doc: `plans/01-hook-io-discipline.md`. Route every emit through an intent→channel wrapper; make `printf` writes failure-tolerant (never abort the hook on a closed/again pipe); strip host-unsupported output fields per-IDE; move the worker round-trip off the critical path (fire-and-forget + dedicated diagnostic surface).

## Test matrix

| Host | Shell | Required behavior |
|---|---|---|
| Windows | PowerShell 7 / Git-bash / GBK locale | hook never aborts on write-error; exit 0 unless BLOCKING |
| Codex | host runtime | no unsupported output fields; non-zero exit only on real block |
| any | any | Stop/PostToolUse return without awaiting worker completion |

## Out of scope

Spawn/templating of the hook command line (plan-02); worker supervision (plan-03).
