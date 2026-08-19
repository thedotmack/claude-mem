# Phase 04: Hook Lifecycle — Stop Hook Loop and Output Isolation

The Stop hook creates an infinite loop because its summarize output gets interpreted as new instructions by Claude Code (#987). The fix is ensuring Stop/Summary hooks return `suppressOutput: true` and never emit stdout. Secondary: stderr from hooks shows as error UI in Claude Code (#1181). These are specific, targeted fixes — not a rate limiter framework.

**Issues resolved:** #987, #984, #975 (Stop hook loop), #1181 (stderr as errors), #598 (conversation pollution), #784 (agent output leaks)

## Root Cause Validation

**Stop hook loop** — The Stop hook generates summarization output. Claude Code interprets any stdout from a hook as instructions, creating a feedback loop. The fix is `suppressOutput: true` in the hook response, not a rate limiter.

**stderr as UI errors** — Claude Code displays stderr content to users as error messages. The logger or hook code writes to stderr for diagnostic purposes, which users see as errors. Fix: suppress stderr in hook context.

## Tasks

- [x] Fix the Stop hook infinite loop:
  - Find the Stop/SessionEnd handler — search for `session-complete` in `src/cli/handlers/`
  - Ensure the handler returns `{ continue: true, suppressOutput: true }` — no stdout content
  - Find the hook response builder (`src/cli/adapters/claude-code.ts` or `src/hooks/hook-response.ts`) and ensure Stop/Summary hook types always set `suppressOutput: true`
  - Fix the "Unknown event type: session-complete" error (#984) — find the event type dispatcher and add `session-complete` as a recognized type
  - This is a property set, not a new system
  - DONE: All already implemented — `session-complete` handler exists with `suppressOutput: true`, adapter defaults to `suppressOutput: true`, unknown event types return no-op with exit 0.

- [x] Fix stderr showing as errors in Claude Code UI (#1181):
  - Check `src/utils/logger.ts` — if it writes to stderr, add a check: when running in hook context (detect via env var or process context), suppress stderr output
  - The simplest fix: in hook entry points (the built scripts), redirect stderr to a log file before any imports: `process.stderr.write = () => true` or pipe to the log file
  - Do NOT create a "hook-mode flag" system — just suppress stderr at the entry point
  - DONE: Added `process.stderr.write = (() => true)` at start of `hookCommand()` with `finally` block restore. Converted `console.error()` to `logger.warn()`/`logger.error()` in `hook-command.ts` and `handlers/index.ts`.

- [x] Fix conversation history pollution (#598, #784):
  - This is the same root cause as the Stop hook loop: hook output leaking to the conversation
  - Audit all hook handlers in `src/cli/handlers/` — every handler that returns output should set `suppressOutput: true` unless it's specifically injecting context (like SessionStart context injection)
  - For the `--continue` case (#784), the memory agent's internal processing output should never be visible — ensure the summarization flow uses `suppressOutput: true`
  - DONE: Audited all 7 handlers — all return `suppressOutput: true`. Adapter defaults to `suppressOutput: true`. Context handler uses `hookSpecificOutput` (correct for context injection). stderr suppression from task 2 covers the remaining conversation pollution vector.

- [x] Run `npm test` and fix any failures
  - DONE: 10 new tests added in `tests/hook-lifecycle.test.ts`, all passing. 52 total hook-related tests pass. Full suite: 954 pass, 21 fail (all pre-existing baseline failures, none from TRIAGE-04 changes).
