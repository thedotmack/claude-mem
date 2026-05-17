# Hook IO Discipline — Stop Conflating stdout / stderr / Exit Codes

**Goal:** Establish a single, typed IO discipline across claude-mem's 6 lifecycle hooks (Setup, SessionStart, UserPromptSubmit, PreToolUse:Read, PostToolUse, Stop). Every emit point must declare an *intent* (DIAGNOSTIC, MODEL_CONTEXT, USER_HINT, BLOCKING_FEEDBACK, EXIT_SIGNAL) and route through a wrapper module that maps intent → channel correctly. Fix issue #2292 (recordWorkerUnreachable diagnostic silently swallowed) along the way.

**Net effect:**
- `process.stderr.write` is no longer monkey-patched at the boundary. Diagnostic stderr (logger, fail-loud counter, bun-runner #2188) reaches the user as the hook contract intends.
- Handlers become *pure*: they return a `HookResult` and never touch process streams directly.
- A single `src/cli/hook-io.ts` module is the only place that calls `console.log`, `process.stderr.write`, and `process.exit` for the hook execution path. `hookCommand` orchestrates that module.
- Adapter `formatOutput` shapes are validated once at the emit boundary.
- The CLAUDE.md exit-code strategy (worker/hook errors exit 0 to prevent Windows Terminal tab pileup) is preserved verbatim and codified in the wrapper.
- A grep-based CI check forbids direct stream writes in `src/cli/handlers/**` and `src/cli/adapters/**`.

**Out of scope:**
- Logger redesign (the existing `src/utils/logger.ts` keeps its API; only its stderr fallback path changes call site).
- Worker-side HTTP API responses (this plan is *only* about the hook execution edge).
- bun-runner.js stdin handling (issue #2188 diagnostic stays — only its emit channel is reviewed).
- Subagent / Task tool propagation (orthogonal).

---

## Phase 0 — Documentation Discovery (already complete)

The orchestrator did the discovery during planning; subsequent phases cite by line number rather than re-deriving. The audit table in Phase 1 is the canonical artifact — treat it as the source of truth for "where things write right now."

### Allowed APIs / patterns to copy

| Item | Location | What to copy |
|---|---|---|
| Existing exit-code constants | `src/shared/hook-constants.ts:15–20` | `HOOK_EXIT_CODES = { SUCCESS: 0, FAILURE: 1, BLOCKING_ERROR: 2, USER_MESSAGE_ONLY: 3 }` — no new constants needed. |
| Adapter `formatOutput` contract | `src/cli/types.ts:39–42` and `src/cli/adapters/claude-code.ts:27–41` | `formatOutput(result: HookResult): unknown` — the new `emitModelContext` MUST call this and `JSON.stringify` the result, exactly once. |
| `HookResult` shape (already supports `systemMessage`) | `src/cli/types.ts:23–37` | `systemMessage` is the *existing* field for user-visible advisory. New work adds an explicit `userHint` only if `systemMessage` semantics differ per platform — see Phase 3. |
| Logger fallback write | `src/utils/logger.ts:271,274` | `process.stderr.write` happens here when log file write fails and as the normal stderr fallback when no log file is configured. Phase 4 routes both through `emitDiagnostic`. |
| Fail-loud counter | `src/shared/worker-utils.ts:401–417` | `recordWorkerUnreachable` is the canonical "must surface to user" path. The threshold-triggered branch (lines 410–415) is the *only* current call site that legitimately writes to stderr + exits non-zero. The plan keeps that intent but routes through `emitBlockingError`. |
| `HookCommandOptions.skipExit` test seam | `src/cli/hook-command.ts:8–10` | Tests use this to assert exit codes without calling `process.exit`. The new wrapper preserves it. |
| Plan format & verification-checklist style | `plans/2026-04-29-installer-streamline.md` | Phase numbering, edit-by-line-number specificity, explicit "Anti-pattern guards" per phase. |

### Anti-patterns / methods that DO NOT exist (avoid inventing)

- There is no existing `hook-io.ts` module — Phase 3 creates it.
- There is no `userHint` field on `HookResult` today (`src/cli/types.ts`). Phase 3 decides whether to add one or reuse `systemMessage`. Recommendation: **reuse `systemMessage`** — every adapter already routes it. Adding `userHint` would force adapter changes for no gain.
- `console.warn` and `console.info` are NOT used in `src/cli/`; do not introduce them. Stay with `logger.*` for diagnostics.
- `process.stdout.write` is NOT used in the hook path; the only stdout emit is `console.log(JSON.stringify(...))` in `hook-command.ts:66,86,94`. Do not switch to `process.stdout.write` — `console.log` adds the trailing newline that Claude Code's parser expects.
- Do not "fix" the swallow by deleting it without an audit. Phase 1 first, Phase 2 second. Some libraries imported by handlers (e.g. `@anthropic-ai/sdk` retries) DO write to stderr unprompted, and that *is* what the swallow was originally guarding against.
- The exit-0-on-error strategy is non-negotiable per CLAUDE.md ("Worker/hook errors exit with code 0 to prevent Windows Terminal tab accumulation. The wrapper/plugin layer handles restart logic."). Any phase that proposes exit 1/2 must justify it as either (a) blocking feedback the model must see, or (b) the existing fail-loud counter that already does this.

### File inventory used by this plan

| File | Lines | Disposition |
|---|---|---|
| `src/cli/hook-command.ts` | 117 | Edited heavily (Phase 2, Phase 3) |
| `src/cli/hook-io.ts` | NEW | CREATED (Phase 3) |
| `src/cli/handlers/user-message.ts` | 38 | Edited (Phase 4 — drop direct stderr write) |
| `src/cli/handlers/context.ts` | 83 | Light edit (Phase 4 — annotate intent, no behavior change) |
| `src/cli/handlers/observation.ts` | 54 | Light edit (Phase 4 — confirm pure) |
| `src/cli/handlers/file-context.ts` | 248 | Light edit (Phase 4 — confirm pure) |
| `src/cli/handlers/session-init.ts` | 124 | Light edit (Phase 4 — confirm pure) |
| `src/cli/handlers/summarize.ts` | 90 | Light edit (Phase 4 — confirm pure) |
| `src/cli/adapters/claude-code.ts` | 43 | Light edit (Phase 4 — confirm `formatOutput` returns plain object) |
| `src/cli/adapters/codex.ts`, `cursor.ts`, `gemini-cli.ts`, `raw.ts`, `windsurf.ts`, `codex-file-context.ts` | misc | Confirm-only (Phase 4 audit pass) |
| `src/shared/worker-utils.ts` | ~600 | Edited (Phase 4 — recordWorkerUnreachable routes through `emitBlockingError`) |
| `src/utils/logger.ts` | ~310 | Edited (Phase 4 — stderr fallback routes through `emitDiagnostic`) |
| `src/services/worker-service.ts` | ~900 | Light edit (Phase 4 — `case 'hook'` block at 846–864 documents intent only; no behavior change) |
| `plugin/scripts/bun-runner.js` | 206 | Edited (Phase 4 — diagnostic emit annotated, exit-code policy documented inline) |
| `plugin/scripts/version-check.js` | 70 | Edited (Phase 4 — extract `emitUpgradeHint` into shared helper or document why dual-channel stays) |
| `plugin/hooks/hooks.json` | 88 | Confirm-only (Phase 4 — verify `echo` statements and `exit 1` on missing `_P` are EXIT_SIGNAL intent) |
| `tests/hook-io.test.ts` | NEW | CREATED (Phase 5) |
| `tests/hook-stream-discipline.test.ts` | NEW | CREATED (Phase 5) |
| `scripts/check-hook-io-discipline.cjs` | NEW | CREATED (Phase 6 — grep-based CI check) |
| `CLAUDE.md` | misc | Edited (Phase 6 — Exit Code Strategy section) |

---

## Phase 1 — Audit every emit point

**What to implement:** A complete table of every `process.stderr.write`, `process.stdout.write`, `console.log`, `console.error`, `console.warn`, `process.exit`, and `throw` reachable from a hook execution. The audit is the deliverable; no code changes in this phase. The table goes into the PR description (and is summarized below).

**Files to grep:**
```
src/cli/hook-command.ts
src/cli/handlers/*.ts
src/cli/adapters/*.ts
src/shared/worker-utils.ts
src/shared/hook-constants.ts
src/services/worker-service.ts            # only the `case 'hook':` arm at 846–864
src/utils/logger.ts
plugin/scripts/bun-runner.js
plugin/scripts/version-check.js
plugin/scripts/worker-cli.js
plugin/hooks/hooks.json                   # the bash dispatchers' echo + exit 1
```

**Audit columns (one row per call site):**

| File:Line | Call | Intent (declared) | Channel (current) | Audience (real) | Gap |
|---|---|---|---|---|---|

**Intent vocabulary** (use these exact tokens):
- `DIAGNOSTIC` — operator-visible logs, never reaches the model. Stderr.
- `MODEL_CONTEXT` — content the assistant should consume. Stdout JSON only.
- `USER_HINT` — short advisory shown to the human user (e.g. "OAuth token stale"). Stderr OR `systemMessage` field, NEVER mixed with model context.
- `BLOCKING_FEEDBACK` — error message Claude Code feeds back to the model (per its hook contract: stderr + exit 2).
- `EXIT_SIGNAL` — pure status, no payload (e.g. `process.exit(0)`).

**Pre-populated audit findings** (the orchestrator already grepped — copy this into the PR and verify each row before Phase 2):

| File:Line | Call | Intent (declared) | Channel (current) | Audience (real) | Gap |
|---|---|---|---|---|---|
| `src/cli/hook-command.ts:66` | `console.log(JSON.stringify(output))` | MODEL_CONTEXT | stdout | model | ok |
| `src/cli/hook-command.ts:69` | `process.exit(exitCode)` | EXIT_SIGNAL | exit | OS | ok |
| `src/cli/hook-command.ts:75–76` | replace `process.stderr.write` with no-op | (defensive guard) | n/a | n/a | **#2292: swallows ALL stderr including legitimate diagnostic + fail-loud** |
| `src/cli/hook-command.ts:86,94` | `console.log(JSON.stringify({continue:true,suppressOutput:true}))` | MODEL_CONTEXT | stdout | model | ok |
| `src/cli/hook-command.ts:88,96,103` | `process.exit(SUCCESS)` | EXIT_SIGNAL | exit | OS | ok per CLAUDE.md |
| `src/cli/hook-command.ts:108` | `logger.error('HOOK', …)` | DIAGNOSTIC | stderr (via logger) | operator | **swallowed by lines 75–76** |
| `src/cli/hook-command.ts:110` | `process.exit(BLOCKING_ERROR)` | BLOCKING_FEEDBACK | exit (no stderr msg!) | model | **gap: model gets exit 2 but no stderr message — useless** |
| `src/cli/hook-command.ts:114` | restore `process.stderr.write` | (cleanup) | n/a | n/a | only runs after exit; restore is dead code in production |
| `src/cli/handlers/user-message.ts:27` | `process.stderr.write("…Claude-Mem Context Loaded…")` | USER_HINT (banner) | stderr | user (Claude Code shows stderr inline) | **mixed concern: handler is not pure; bypasses HookResult shape** |
| `src/cli/handlers/context.ts:74–80` | return `hookSpecificOutput.additionalContext` + `systemMessage` | MODEL_CONTEXT + USER_HINT | result object | model + user | ok in shape, but no enforcement that handlers can't ALSO write stderr |
| `src/cli/handlers/observation.ts` | (pure — only `logger.*` calls) | DIAGNOSTIC | stderr (logger) | operator | swallowed by hookCommand wrapper |
| `src/cli/handlers/file-context.ts` | (pure — only `logger.*` calls) | DIAGNOSTIC | stderr (logger) | operator | swallowed |
| `src/cli/handlers/session-init.ts` | (pure — only `logger.*` calls) | DIAGNOSTIC | stderr (logger) | operator | swallowed |
| `src/cli/handlers/summarize.ts` | (pure — only `logger.*` calls) | DIAGNOSTIC | stderr (logger) | operator | swallowed |
| `src/cli/adapters/claude-code.ts:27–41` | `formatOutput` returns plain object | (data shape) | n/a | model (via stdout JSON) | ok |
| `src/shared/worker-utils.ts:411` | `process.stderr.write('claude-mem worker unreachable for N consecutive hooks.\n')` | BLOCKING_FEEDBACK / USER_HINT (the one message that MUST surface) | stderr | user + model | **#2292: swallowed by hookCommand wrapper** |
| `src/shared/worker-utils.ts:414` | `process.exit(BLOCKING_ERROR)` | BLOCKING_FEEDBACK | exit 2 | model | exits 2 but stderr is swallowed → model gets nothing |
| `src/shared/worker-utils.ts:469,479…` | `logger.warn('SYSTEM', …)` | DIAGNOSTIC | stderr (logger) | operator | swallowed |
| `src/utils/logger.ts:271` | `process.stderr.write('[LOGGER] Failed to write to log file…')` | DIAGNOSTIC | stderr | operator | swallowed when called inside hook |
| `src/utils/logger.ts:274` | `process.stderr.write(logLine + '\n')` | DIAGNOSTIC | stderr | operator | swallowed when called inside hook |
| `src/services/worker-service.ts:850–853` | `console.error('Usage: …')` + `process.exit(1)` | DIAGNOSTIC + EXIT_SIGNAL | stderr + exit 1 | operator (CLI misuse, not a hook) | ok — this is CLI usage, not the hook lifecycle |
| `plugin/scripts/bun-runner.js:172` | `console.error(diagnostic)` (issue #2188 empty-stdin) | USER_HINT (visible) + DIAGNOSTIC (logged) | stderr | user (Claude Code shows it) | ok — bun-runner is BEFORE hookCommand swallow; runs in its own node process |
| `plugin/scripts/bun-runner.js:186` | `console.error('[bun-runner] failed to persist diagnostic…')` | DIAGNOSTIC | stderr | operator | ok |
| `plugin/scripts/bun-runner.js:191` | `process.exit(0)` | EXIT_SIGNAL | exit 0 | OS | ok per CLAUDE.md (Windows Terminal rationale documented inline at lines 174–178) |
| `plugin/scripts/bun-runner.js:196–198` | `console.error('Failed to start Bun…')` + `process.exit(1)` | BLOCKING_FEEDBACK | stderr + exit 1 | user | **gap: exit 1 violates exit-0-on-error policy. Bun-not-found is a *user* problem, not a hook bug — exit 1 is arguably correct here, but CLAUDE.md says exit 0. Decide in Phase 2.** |
| `plugin/scripts/bun-runner.js:204` | `process.exit(code || 0)` | EXIT_SIGNAL | exit | OS | ok — propagates child exit code |
| `plugin/scripts/version-check.js:24,32` | `console.log(JSON.stringify({hookSpecificOutput:…}))` for Codex; `console.error(message)` for default | MODEL_CONTEXT (Codex path) / USER_HINT (default path) | stdout / stderr | model / user | ok in intent, but the dual-channel branch is duplicated logic — extract or document |
| `plugin/hooks/hooks.json` Setup line 11 | `echo "claude-mem: version-check.js not found" >&2; exit 1` | BLOCKING_FEEDBACK (resolution failure) | stderr + exit 1 | user | gap: exit 1 here is correct (we cannot run; user MUST see). Document the exception. |
| `plugin/hooks/hooks.json` other hook lines | `echo "claude-mem: plugin scripts not found" >&2; exit 1` | BLOCKING_FEEDBACK | stderr + exit 1 | user | same — document exception |
| `plugin/hooks/hooks.json` SessionStart line 24 | `echo '{"continue":true,"suppressOutput":true}'` | MODEL_CONTEXT | stdout | model | ok |

**Verification checklist:**
- [ ] Re-run each grep listed above and confirm row count matches the audit table
- [ ] For every row marked "gap", Phase 2/3/4 has a concrete edit
- [ ] Audit table is committed to the PR description (or as `plans/01-hook-io-discipline-audit.md`)

**Anti-pattern guards:**
- Do not skip rows because they're in third-party code paths — if they're imported by a handler, they're in scope.
- Do not collapse rows with "(misc logger calls)". Each `logger.warn`/`logger.error` inside a handler is one row, because the swallow affects each one.
- Do not extend the audit to non-hook code paths (e.g. `npx-cli/`, `transcripts/`, `viewer/`). Out of scope.

---

## Phase 2 — Fix #2292 stderr swallow

**What to implement:** Replace the blanket no-op (`src/cli/hook-command.ts:75–76`) with a typed, opt-in capture buffer. Diagnostic writes from `logger.*` and `recordWorkerUnreachable` flow through unimpeded; the original "guard against unsolicited library stderr" intent is preserved by *capturing* unmarked writes to a buffer and discarding them on graceful exit (or flushing them on blocking error).

### Decision: Option (c) — capture buffer with typed bypass

Three options were considered:

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| (a) Drop swallow entirely | Simplest. Fixes #2292 immediately. | Reverts the guard against noisy library writes (e.g. SDK retry warnings, `node:util` deprecation prints). Those WILL leak to model context if any handler imports a chatty library. | Reject — leaves a regression door open. |
| (b) Stream-filter proxy via sentinel marker | Preserves selective filtering. | Requires every legitimate diagnostic site to opt in (logger, fail-loud, bun-runner). Sentinel detection is fragile; a missed prefix = silent loss. | Reject — too easy to forget the sentinel. |
| (c) Capture buffer + typed bypass | All `process.stderr.write` calls go to a buffer instead of the real fd. The buffer is FLUSHED to real stderr only on `emitDiagnostic`/`emitBlockingError` (i.e. when claude-mem CHOSE to surface). On graceful exit (exit 0, success), buffer is dropped (current behavior preserved). | Slightly more state. | **Accept** — gives us the swallow behavior on success and the surface behavior on legitimate diagnostics, with no per-call sentinel discipline. |

### Edit 2A — Refactor `hookCommand` to use a buffered stderr

File: `src/cli/hook-command.ts`

- Lines 75–76: replace direct no-op assignment with a call into the new `installHookStderrBuffer()` helper from `src/cli/hook-io.ts` (created in Phase 3). Helper returns a `{ flush(): void; restore(): void; drop(): void }` controller.
- Lines 113–115: replace `process.stderr.write = originalStderrWrite` with `controller.restore()`.
- Lines 100–106 (worker-unavailable branch): call `controller.flush()` BEFORE `process.exit(SUCCESS)` so any `recordWorkerUnreachable` write that fired during this hook surfaces. (Currently the `recordWorkerUnreachable` *path* runs INSIDE `executeWithWorkerFallback`, which is invoked from the handler call inside `executeHookPipeline` — so the write happens during the buffered window. Without flush, it stays buffered.)
- Lines 108–112 (catch-all error branch): call `controller.flush()` BEFORE `process.exit(BLOCKING_ERROR)` so the model receives the `logger.error` line as blocking feedback per Claude Code's hook contract (exit 2 + stderr).

### Edit 2B — Document the rationale at the call site

Add a comment block immediately above the new `installHookStderrBuffer()` call in `hookCommand`:

```ts
// Hook IO Discipline (issue #2292):
// We BUFFER stderr during handler execution so that unsolicited writes from
// third-party libraries don't leak into model context. The buffer is FLUSHED
// only when we choose to surface (logger errors at the catch-all branch,
// fail-loud counter from worker-utils, blocking-error path). Successful exits
// drop the buffer — preserving the original "quiet on success" behavior.
//
// To bypass the buffer for a specific write, use emitDiagnostic / emitBlockingError
// from src/cli/hook-io.ts. Direct process.stderr.write calls are buffered.
```

### Edit 2C — Decide bun-runner.js exit-1-on-Bun-not-found

(From audit row `bun-runner.js:196–198`.) The current code exits 1 when Bun cannot be spawned. Per CLAUDE.md exit-code strategy, hook errors should exit 0. But this is *before* any hook runs — Bun is the prerequisite, not the hook itself.

**Decision:** Keep `exit 1` for the Bun-not-found case (and `exit 1` for the missing-arg usage at line 83). Justification: this is BLOCKING_FEEDBACK to the *user* (their environment is broken), not a transient hook failure. Document the exception inline:

```js
// EXCEPTION to CLAUDE.md exit-0-on-error: Bun-not-found is a user environment
// problem, not a hook execution failure. Surfacing exit 1 here forces Claude
// Code to display the stderr message rather than silently retrying.
```

**Verification checklist:**
- [ ] `grep -n "process.stderr.write = " src/cli/hook-command.ts` returns no direct assignment (the no-op replacement is gone)
- [ ] `installHookStderrBuffer` is the ONLY symbol that mutates `process.stderr.write` in `src/`
- [ ] Manual: invoke a hook with `CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD=1`, kill the worker, observe the "claude-mem worker unreachable" message on stderr (it was previously swallowed)

**Anti-pattern guards:**
- Do not flush the buffer on every handler call. Buffering is the whole point — flush only when claude-mem code explicitly chooses to surface.
- Do not move the buffer install into `executeHookPipeline` — it must wrap the catch block too.
- Do not export the buffer controller from `hook-io.ts` for handler use. Handlers don't need it; they use `emitDiagnostic` instead.

---

## Phase 3 — Create `src/cli/hook-io.ts` (typed IO discipline)

**What to implement:** A new module that owns every stdout/stderr/exit emission for the hook execution path. `hookCommand` is its only consumer; handlers stay pure.

**File to create:** `src/cli/hook-io.ts`

### API surface (these names are used by Phase 2 and Phase 4 — do not rename)

```ts
import type { PlatformAdapter, HookResult } from './types.js';
import { HOOK_EXIT_CODES } from '../shared/hook-constants.js';

export interface HookStderrBuffer {
  flush(): void;        // write buffered bytes to real stderr
  drop(): void;         // discard buffered bytes
  restore(): void;      // un-replace process.stderr.write (idempotent)
}

/**
 * Replace process.stderr.write with a buffered writer. Diagnostics from
 * emitDiagnostic / emitBlockingError bypass the buffer. Direct
 * process.stderr.write calls (including library noise) are captured.
 */
export function installHookStderrBuffer(): HookStderrBuffer;

/**
 * Operator-visible diagnostic. Always reaches real stderr (bypasses the
 * Phase 2 buffer). Use for logger fallback, fail-loud counter, and any
 * "we want this in the operator's terminal" message.
 */
export function emitDiagnostic(line: string): void;

/**
 * Emit the model-bound JSON payload to stdout, exactly once per hook
 * invocation. Calls adapter.formatOutput(result) and JSON.stringify.
 * Throws if called twice in the same hook (caught by hookCommand).
 */
export function emitModelContext(adapter: PlatformAdapter, result: HookResult): void;

/**
 * User-visible advisory routed via the HookResult.systemMessage path. This
 * function does NOT write to a stream — it returns a HookResult mutation
 * that the caller MUST merge into the result before emitModelContext.
 * Reason: systemMessage is platform-specific (claude-code surfaces it,
 * codex ignores it) and must go through the adapter.
 */
export function withUserHint(result: HookResult, hint: string): HookResult;

/**
 * Stderr message + exit 2. The model receives `msg` per Claude Code's hook
 * contract. Flushes the stderr buffer first so any logger.error lines
 * preceding this call also reach the model.
 */
export function emitBlockingError(msg: string, options?: { skipExit?: boolean }): never | void;

/**
 * Exit 0 with no further output. The Phase 2 buffer is DROPPED (the
 * Windows Terminal tab-accumulation rationale: silent success).
 * Use this for the worker-unavailable success path.
 */
export function exitGraceful(options?: { skipExit?: boolean }): never | void;
```

### Implementation notes (for the implementer; do NOT inline in the plan)

- `installHookStderrBuffer` keeps a `Buffer[]` and a single bound bypass channel (the original `process.stderr.write`). `emitDiagnostic` writes via the bypass; everything else accumulates in the array.
- `emitModelContext` uses a module-scoped `hasEmitted` boolean flag. Throws `Error('emitModelContext called twice')` on second call. Reset by `hookCommand` between invocations (or, more cleanly: `hookCommand` constructs a fresh emitter via a factory — see optional refinement below).
- `emitBlockingError`: flushes buffer, writes `msg` to real stderr, exits with code 2 unless `skipExit` is set. Test seam matches `hookCommand`'s existing `skipExit` option.
- `exitGraceful`: drops buffer, calls `process.exit(0)`. NO stdout write — caller is expected to have already called `emitModelContext` if a JSON envelope is required (e.g. `{continue:true,suppressOutput:true}`).
- `withUserHint`: returns `{ ...result, systemMessage: hint }` (or merges if `result.systemMessage` is already set — in that case append with `\n\n`).

### Optional refinement: factory pattern

If global mutable state in `hook-io.ts` is unwelcome, expose a factory:

```ts
export interface HookEmitter {
  emitDiagnostic(line: string): void;
  emitModelContext(adapter: PlatformAdapter, result: HookResult): void;
  withUserHint(result: HookResult, hint: string): HookResult;
  emitBlockingError(msg: string, options?: { skipExit?: boolean }): void;
  exitGraceful(options?: { skipExit?: boolean }): void;
  buffer: HookStderrBuffer;
}

export function createHookEmitter(): HookEmitter;
```

`hookCommand` calls `createHookEmitter()` once per invocation. This avoids the "called twice" race in long-running test contexts. **Prefer this pattern.**

### Edit 3A — Update `hookCommand` to use the emitter

File: `src/cli/hook-command.ts`

After Phase 2's buffer integration, switch the `console.log(JSON.stringify(...))` at lines 66, 86, 94 to `emitter.emitModelContext(adapter, result)` (or `emitter.emitModelContext(adapter, { continue: true, suppressOutput: true })` for the early-return cases).

The `process.exit(...)` calls become `emitter.exitGraceful(options)` and `emitter.emitBlockingError(message, options)` respectively. The `skipExit` option propagates from `HookCommandOptions`.

The `logger.error('HOOK', …)` at line 108 stays — it routes through `emitDiagnostic` because the logger's stderr fallback (Phase 4 edit to `logger.ts`) does so.

**Verification checklist:**
- [ ] `src/cli/hook-io.ts` exports the API surface verbatim (names match Phase 4 imports)
- [ ] `grep -n "console.log\|console.error\|process.stderr.write\|process.exit" src/cli/hook-command.ts` returns ONLY commented-out historical references and the `skipExit` option propagation
- [ ] `tsc --noEmit` clean
- [ ] `emitModelContext` test: call twice → throws

**Anti-pattern guards:**
- Do not export `installHookStderrBuffer` from the package's top-level barrel. It's an internal-to-cli helper.
- Do not add a `emitUserHint` that writes to stderr — that path is now `withUserHint` + adapter routing. Direct stderr USER_HINT bypasses platform shape contracts.
- Do not let `emitDiagnostic` accept structured data (`{key: value}`) — it takes a string. Keep `logger.*` as the structured-logging path; `emitDiagnostic` is the raw stderr escape hatch.

---

## Phase 4 — Migrate call sites

**What to implement:** Concrete edits per file. Group by direction (handlers, adapters, shared utils, plugin scripts) so the implementer can work file-by-file.

### Edit 4A — `src/cli/handlers/user-message.ts` (drop direct stderr write)

Currently lines 27–33 do `process.stderr.write("…Claude-Mem Context Loaded…")` to surface the banner inline. This is a USER_HINT that bypasses HookResult.

**Replace with:** Build the banner string, return it via `systemMessage` on the HookResult. The `formatOutput` of the claude-code adapter already maps `systemMessage` to the platform JSON shape (see `src/cli/adapters/claude-code.ts:31–33,37–39`).

Specifically:
- Drop lines 27–33 entirely.
- Build the same string as `bannerText`.
- Return `{ exitCode: HOOK_EXIT_CODES.SUCCESS, systemMessage: bannerText }`.

This makes the handler PURE. The adapter routes `systemMessage` to the right field; Claude Code surfaces it identically to a stderr write but inside the contract.

### Edit 4B — `src/cli/handlers/context.ts` (annotate intent, no behavior change)

The dual-emit (`hookSpecificOutput.additionalContext` for model + `systemMessage` for user) is already correct and pure. Add a docstring at the top of the handler explicitly calling out the two intents:

```ts
// IO discipline:
// - additionalContext  → MODEL_CONTEXT (model consumes; passed via stdout JSON)
// - systemMessage      → USER_HINT (user-visible; passed via stdout JSON systemMessage field)
// This handler MUST NOT call process.stderr.write or console.* directly.
```

No code change beyond the docstring. Confirm `logger.*` calls (lines 43) are the only stderr emissions and they route through the buffer (which is fine — they're DIAGNOSTIC).

### Edit 4C — `src/cli/handlers/{observation,file-context,session-init,summarize}.ts` (confirm pure)

For each, add the same IO-discipline docstring as 4B. Audit confirms these handlers are already pure (only `logger.*` and `throw` for unrecoverable input, which `hookCommand` catches and routes through `emitBlockingError`).

### Edit 4D — `src/cli/adapters/*.ts` (confirm formatOutput shape)

Audit each adapter's `formatOutput` and confirm:
1. Returns a plain object (not a promise, not a string).
2. Every field corresponds to a documented Claude Code / Codex / Cursor / Gemini hook output field.
3. Does not call `console.*` or `process.*`.

This is a CONFIRM-ONLY pass. The adapters are clean today; the goal is to lock that in via the Phase 6 grep CI check.

### Edit 4E — `src/shared/worker-utils.ts:401–417` (recordWorkerUnreachable)

Current behavior:
- Increments persistent counter.
- If counter ≥ threshold: writes `'claude-mem worker unreachable for N consecutive hooks.\n'` to stderr, then `process.exit(BLOCKING_ERROR)`.

**Edit:** Replace the direct `process.stderr.write` + `process.exit` with `emitBlockingError` from `src/cli/hook-io.ts`:

```ts
import { emitBlockingError } from '../cli/hook-io.js';
// …
if (next.consecutiveFailures >= threshold) {
  emitBlockingError(
    `claude-mem worker unreachable for ${next.consecutiveFailures} consecutive hooks.`
  );
}
return next.consecutiveFailures;
```

`emitBlockingError` flushes the buffered stderr (so any preceding `logger.warn` lines reach the operator) and exits 2.

**This is the #2292 fix.** The diagnostic is no longer swallowed because `emitBlockingError` writes via the bypass channel.

**Note on the dependency direction:** `src/shared/` importing from `src/cli/` is unusual (shared usually has fewer deps). If this is a problem, invert: move `hook-io.ts` to `src/shared/hook-io.ts`. The orchestrator favors leaving it in `src/cli/` because the emitter is conceptually part of the hook pipeline; if the linter/architecture rules complain, move it.

### Edit 4F — `src/utils/logger.ts:271,274` (fallback stderr writes)

Current behavior: when `logFilePath` is null OR `appendFileSync` throws, write to `process.stderr.write`. Inside a hook this hits the buffer.

**Edit:** Replace both `process.stderr.write` calls with `emitDiagnostic` from `src/cli/hook-io.ts`. Logger remains usable outside the hook context (worker daemon, CLI commands) because `emitDiagnostic` falls back to `process.stderr.write` (bypass channel) which is unaffected when the buffer is not installed.

```ts
import { emitDiagnostic } from '../cli/hook-io.js';
// line 271
emitDiagnostic(`[LOGGER] Failed to write to log file: ${error instanceof Error ? error.message : String(error)}\n`);
// line 274
emitDiagnostic(logLine + '\n');
```

Same dependency-direction caveat as 4E. If `src/utils/` → `src/cli/` is forbidden by lint, move `hook-io.ts` to `src/shared/`.

### Edit 4G — `src/services/worker-service.ts:846–864` (case 'hook')

Confirm-only edit. The `case 'hook':` arm currently does:
- `console.error('Usage: …')` + `process.exit(1)` — ok, this is CLI usage feedback, not a hook execution path.
- `logger.warn` if worker fails to start — ok.
- `await hookCommand(platform, event)` — ok; hookCommand owns its own IO from here.

Add a comment block above line 846:

```ts
// IO discipline: this case is the entry point to the hook execution path.
// Once hookCommand is invoked, src/cli/hook-io.ts owns all stdout/stderr/exit.
// Pre-hookCommand error paths (missing args, worker failed to start) are
// CLI-style: console.error + exit 1 is acceptable because these errors
// occur BEFORE the buffered window opens.
```

### Edit 4H — `plugin/scripts/bun-runner.js` (annotate)

No behavior change. Add a comment block above line 159 explaining that the issue-#2188 diagnostic is intentionally USER_HINT-on-stderr + persistent-marker-file (dual channel), and exit 0 is intentional per CLAUDE.md.

The existing comment at lines 174–178 already documents this; expand it slightly to reference Phase 1's intent vocabulary:

```js
// IO discipline:
// - stderr write here is a USER_HINT (Claude Code surfaces it inline).
// - CAPTURE_BROKEN marker file is a DIAGNOSTIC durable signal for the next session.
// - exit 0 is the EXIT_SIGNAL per CLAUDE.md (Windows Terminal tab management);
//   the marker file, not the exit code, is the durable failure signal.
```

For lines 196–198 (Bun-not-found `exit 1`), see Phase 2 Edit 2C — keep `exit 1` and document the exception inline.

### Edit 4I — `plugin/scripts/version-check.js` (extract emitUpgradeHint helper or document)

The current `emitUpgradeHint` function (lines 22–33) already handles the dual-channel emit (Codex JSON-on-stdout vs default stderr). This is the canonical pattern.

**Edit:** Add a comment block explaining the pattern, and rename the function to `emitVersionHint` for consistency with Phase 3's `emitDiagnostic`/`emitUserHint` vocabulary if desired (low priority).

```js
// IO discipline:
// - Codex hook contract: hookSpecificOutput JSON on stdout (MODEL_CONTEXT path)
// - All other platforms: bare stderr (USER_HINT — Claude Code surfaces inline)
// This dual-channel emit is the version-check.js way of being polyglot
// across hook frameworks. Other plugin scripts should copy this pattern
// rather than invent a new one.
```

No code change required beyond the comment. (If Phase 6's CI check flags this file, add it to the allowlist as documented dual-channel.)

### Edit 4J — `plugin/hooks/hooks.json` (confirm bash dispatcher echo+exit)

Confirm-only. The `echo "claude-mem: … not found" >&2; exit 1` pattern in each hook's bash command is correct BLOCKING_FEEDBACK: if the plugin scripts can't be located, the user MUST see the error and Claude Code MUST stop trying to run the hook.

This is the only legitimate `exit 1` in the hook execution path. Document the rationale in CLAUDE.md (Phase 6).

**Verification checklist:**
- [ ] `grep -n "process.stderr.write\|console\\.error\|console\\.log" src/cli/handlers/` returns ONLY logger calls (none)
- [ ] `grep -n "process.stderr.write\|console\\.error\|console\\.log" src/cli/adapters/` returns nothing
- [ ] `recordWorkerUnreachable` calls `emitBlockingError` — `grep -n "emitBlockingError" src/shared/worker-utils.ts` returns 1+ hits
- [ ] `logger.ts` fallback uses `emitDiagnostic` — `grep -n "emitDiagnostic" src/utils/logger.ts` returns 2 hits
- [ ] `tsc --noEmit` clean
- [ ] `npm run build-and-sync` succeeds

**Anti-pattern guards:**
- Do not introduce `process.stdout.write` anywhere. Stay with `console.log` (which `emitModelContext` uses internally).
- Do not change `bun-runner.js` exit codes — the `exit 0` semantics are load-bearing for Windows Terminal.
- Do not "tidy" `version-check.js` by collapsing the dual-channel emit. The Codex/Claude Code split is intentional.
- Do not add a stderr write inside `withUserHint` — it's a pure result-mutation function.
- Do not migrate `worker-service.ts:850–853` to `emitDiagnostic` — those are CLI usage errors, not hook errors. They run before the buffer is installed.

---

## Phase 5 — Test plan

**What to implement:** Two new test files. The first (`hook-io.test.ts`) exercises the wrapper module in isolation. The second (`hook-stream-discipline.test.ts`) exercises the 6 hooks end-to-end as a child process and asserts stream separation.

### Edit 5A — `tests/hook-io.test.ts` (unit tests for hook-io.ts)

Cover, with the existing test framework (likely `bun:test` or `vitest` per `package.json` scripts):

1. `installHookStderrBuffer()` returns a controller; subsequent `process.stderr.write('hello')` calls do NOT reach a piped stderr capture.
2. After `controller.flush()`, the previously-buffered bytes appear on real stderr.
3. After `controller.drop()`, the buffer is empty and a subsequent `flush()` writes nothing.
4. `controller.restore()` un-replaces `process.stderr.write`; subsequent writes go to real stderr immediately.
5. `emitDiagnostic('x\n')` writes to real stderr even when the buffer is installed (bypass channel works).
6. `emitModelContext(adapter, result)` calls `adapter.formatOutput(result)` and `JSON.stringify`s the result to stdout.
7. `emitModelContext` called twice throws `Error('emitModelContext called twice')`.
8. `withUserHint(result, 'hi')` returns a new object with `systemMessage: 'hi'`.
9. `withUserHint(result, 'hi')` on a result that already has `systemMessage: 'world'` returns `systemMessage: 'world\n\nhi'` (or whatever the chosen merge rule is — pin it down in Phase 3 implementation).
10. `emitBlockingError('boom', { skipExit: true })` writes `'boom\n'` to real stderr and does NOT exit.
11. `emitBlockingError` flushes the buffer before its own write (assert ordering by interleaving buffered writes).
12. `exitGraceful({ skipExit: true })` drops the buffer (assert by checking that buffered bytes never reach captured stderr).

### Edit 5B — `tests/hook-stream-discipline.test.ts` (integration: 6 hooks × 3 scenarios)

Spawn the built `plugin/scripts/worker-service.cjs` as a child process via `child_process.spawn`, pipe a JSON payload to stdin, capture stdout and stderr separately, and assert the contract.

**Test harness sketch:**

```ts
import { spawn } from 'child_process';
import { join } from 'path';

interface HookOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

async function runHook(
  platform: 'claude-code' | 'codex' | 'cursor' | 'gemini-cli' | 'raw',
  event: 'context' | 'session-init' | 'observation' | 'file-context' | 'summarize' | 'user-message',
  stdinJson: object,
  envOverrides: Record<string, string> = {},
): Promise<HookOutcome> {
  const workerCjs = join(__dirname, '..', 'plugin', 'scripts', 'worker-service.cjs');
  const child = spawn(process.execPath, [workerCjs, 'hook', platform, event], {
    env: { ...process.env, ...envOverrides },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end(JSON.stringify(stdinJson));
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (c) => stdout.push(c));
  child.stderr.on('data', (c) => stderr.push(c));
  const exitCode = await new Promise<number | null>((resolve) => child.on('close', resolve));
  return {
    stdout: Buffer.concat(stdout).toString('utf-8'),
    stderr: Buffer.concat(stderr).toString('utf-8'),
    exitCode,
  };
}
```

**Test matrix (6 hooks × 3 scenarios = 18 tests):**

For each `event` ∈ {context, session-init, observation, file-context, summarize, user-message}:

| Scenario | Setup | Assertions |
|---|---|---|
| (a) Success | Worker running, valid input | `exitCode === 0`. `stdout` parses as JSON. `stdout` contains no diagnostic strings (`'[INFO]'`, `'[WARN]'`, `'claude-mem worker unreachable'`). `stderr` may contain DIAGNOSTIC lines — that's fine. The MODEL_CONTEXT field structure matches the adapter's `formatOutput` shape. |
| (b) Worker unreachable below threshold | Worker not running, `CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD=10`, counter starts at 0 | `exitCode === 0`. `stdout` is empty OR contains `{continue:true, suppressOutput:true}`. `stderr` is silent (no fail-loud message yet). |
| (c) Worker unreachable at fail-loud threshold | Worker not running, `CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD=1`, counter forced to threshold | `exitCode === 2`. `stderr` contains `'claude-mem worker unreachable for'`. **This is the #2292 regression test.** Today this test FAILS (stderr is empty); after Phase 2/4 it passes. |

**Additional cross-cutting tests:**

| Scenario | Setup | Assertions |
|---|---|---|
| (d) Adapter rejection (invalid cwd) | Send `{ cwd: '/no/such/path' }` | `exitCode === 0`. `stdout` parses as `{continue:true, suppressOutput:true}`. `stderr` contains the warn line about adapter rejection. |
| (e) Unknown event | Run `hook claude-code blarghhh` | `exitCode === 0` (the dispatcher returns a no-op handler — see worker-service.cjs `cne` function). `stderr` contains `'Unknown event type: blarghhh'`. |
| (f) Unrecoverable handler error | Mock the worker to throw on `/api/sessions/observations` | `exitCode === 2`. `stderr` contains `'Hook error:'` from `logger.error`. Model receives the error message per the hook contract. |
| (g) Banner from user-message handler | Run user-message with worker up | `stdout` JSON contains `systemMessage` field with the banner text (NOT `process.stderr.write` of the banner). `stderr` does NOT contain the banner emoji 📝 line. **This is the Edit 4A regression test.** |
| (h) Stream separation invariant | Run any hook that returns hookSpecificOutput | `stderr` MUST NOT contain the substring of `additionalContext`. The model-bound text must not leak to stderr. |

### Edit 5C — Tab-accumulation rationale

The Windows Terminal tab-accumulation behavior cannot be tested cross-platform in CI. Add a comment block at the top of `hook-stream-discipline.test.ts`:

```ts
// Windows Terminal tab-accumulation rationale (per CLAUDE.md):
// Hooks that fail with non-zero exit codes cause Windows Terminal to keep
// the tab open in an error state, which accumulates over time. The exit-0-
// on-error policy is intentional. These tests assert exit codes match the
// policy: SUCCESS for transient errors, BLOCKING_ERROR (2) only for the
// fail-loud counter or unrecoverable handler errors.
```

The decision point from the spec ("worker unreachable at fail-loud threshold — still exit 2 or exit 0 per current behavior — call out the discrepancy and decide"): **exit 2 stays.** The fail-loud counter exists precisely BECAUSE silent retries (exit 0) hide systemic failures. After N consecutive failures the user MUST see the message, and the model MUST stop trying. Exit 2 is the right contract for that one threshold-tripped path. Single-failure paths remain exit 0.

### Edit 5D — Optional: fuzz test for double emit

Spin up `createHookEmitter`, call `emitModelContext` twice, assert it throws. Already covered by 5A test 7; only add as a fuzz harness if the implementer wants more confidence around the global-state-vs-factory choice.

**Verification checklist:**
- [ ] `tests/hook-io.test.ts` exists; all 12 unit tests pass
- [ ] `tests/hook-stream-discipline.test.ts` exists; all 18 + 5 = 23 integration tests pass
- [ ] The #2292 regression test (scenario c) FAILS on a checkout of `main` (audit baseline) and PASSES on this branch
- [ ] The user-message banner test (scenario g) FAILS on `main` and PASSES on this branch
- [ ] `npm test` is green

**Anti-pattern guards:**
- Do not test `process.exit` calls by mocking `process.exit` — use `skipExit: true` option on `emitBlockingError`/`exitGraceful` and assert return values.
- Do not skip platform variants (`codex`, `cursor`, `gemini-cli`). Stream separation must hold for all adapters; codex's JSON-on-stdout for upgrade hints is a known dual-channel pattern.
- Do not test handler internals (worker calls, DB writes) in `hook-stream-discipline.test.ts`. Stream contract only.
- Do not run integration tests against a real worker by default — mock or run a fixture worker on a test port.

---

## Phase 6 — Docs + lint

**What to implement:** Update CLAUDE.md, add a grep-based CI check, add a hook author guide section.

### Edit 6A — Update `CLAUDE.md` Exit Code Strategy section

Locate the existing section ("Exit Code Strategy"). Replace the body with:

```md
## Exit Code Strategy

Claude-mem hooks use specific exit codes per Claude Code's hook contract:

- **Exit 0**: Success or graceful shutdown (Windows Terminal closes tabs).
- **Exit 1**: Pre-hook environment failure (Bun missing, plugin scripts not found). Reserved for the bash dispatchers in `plugin/hooks/hooks.json` and the bun-runner.js Bun-not-found path. Hook handlers themselves NEVER exit 1.
- **Exit 2**: Blocking error fed to the model. Reserved for (a) the fail-loud counter in `recordWorkerUnreachable` after N consecutive failures, and (b) unrecoverable handler errors in `hookCommand`'s catch-all.

**Philosophy**: Worker/hook errors exit with code 0 to prevent Windows Terminal tab accumulation. The wrapper/plugin layer handles restart logic. ERROR-level logging is maintained for diagnostics.

### Hook IO Discipline

All stdout / stderr / exit emits during a hook execution route through `src/cli/hook-io.ts`:

- `emitDiagnostic(line)` — operator-visible stderr (logger fallback, version-check, fail-loud).
- `emitModelContext(adapter, result)` — JSON to stdout via the platform adapter's `formatOutput`. Exactly once per hook.
- `withUserHint(result, hint)` — user-visible advisory, returned via `HookResult.systemMessage`. Adapters route per-platform.
- `emitBlockingError(msg)` — stderr message + exit 2. The model receives `msg`.
- `exitGraceful()` — exit 0, drops any buffered stderr.

Handler authors: write your handler as a pure function returning `HookResult`. **Never call `process.stderr.write`, `console.log`, `console.error`, or `process.exit` from a handler.** A grep-based CI check enforces this in `src/cli/handlers/**` and `src/cli/adapters/**`.

The Phase 2 stderr buffer (installed by `installHookStderrBuffer`) captures unsolicited library writes during handler execution. Buffered bytes are dropped on `exitGraceful` and flushed on `emitDiagnostic` / `emitBlockingError`. Use `emitDiagnostic` whenever you'd want a message visible in the operator's terminal.
```

### Edit 6B — Add a hook author guide

New file: `docs/architecture/hook-author-guide.md` (or co-locate in `docs/public/hooks-architecture.mdx` if that file exists — discovery showed it does, per the prior installer-streamline plan).

Cover:
1. The 6 lifecycle hooks and what each is for.
2. The intent vocabulary (DIAGNOSTIC, MODEL_CONTEXT, USER_HINT, BLOCKING_FEEDBACK, EXIT_SIGNAL).
3. The `hook-io.ts` API with examples.
4. The exit-code policy (with Windows Terminal rationale).
5. Common mistakes (calling `console.error` directly, returning twice from a handler, forgetting to set `exitCode` on the result).
6. How to write a new handler in 15 lines (template).

### Edit 6C — Add grep-based CI check

New file: `scripts/check-hook-io-discipline.cjs`

Logic:
1. Walk `src/cli/handlers/**/*.ts` and `src/cli/adapters/**/*.ts`.
2. For each file, fail if any of these patterns appear (outside of comments):
   - `process.stderr.write`
   - `process.stdout.write`
   - `console.log`
   - `console.error`
   - `console.warn`
   - `console.info`
   - `process.exit`
3. Allowlist: none. Handlers and adapters are pure.
4. Walk `src/utils/logger.ts`, `src/shared/worker-utils.ts`. For each:
   - Allow `process.stderr.write` ONLY if the same line includes `// HOOK_IO_BYPASS` (or the file is on the allowlist by full path).
   - This is a defense in depth — Phase 4 routes them through `emitDiagnostic`, so post-migration the patterns shouldn't appear at all. The allowlist is for any future emergency bypass.
5. Return non-zero on any violation, with file:line and the offending pattern.

Wire into `package.json` as `npm run lint:hook-io` and into the CI pipeline (or as a `pre-push` hook).

### Edit 6D — Update README/docs index if needed

If `README.md` mentions hook authoring or has a "for contributors" section, link to the new author guide. Otherwise no edit.

**Verification checklist:**
- [ ] `node scripts/check-hook-io-discipline.cjs` exits 0 on this branch
- [ ] `node scripts/check-hook-io-discipline.cjs` exits non-zero if you intentionally add `console.error('test')` to `src/cli/handlers/observation.ts`
- [ ] `CLAUDE.md`'s Exit Code Strategy section reflects the new helper functions
- [ ] Hook author guide exists and covers all 6 lifecycle hooks
- [ ] `npm test` is still green
- [ ] CI pipeline runs the new lint check (visible in PR checks)

**Anti-pattern guards:**
- Do not allowlist individual handlers or adapters. The whole point is the rule has no exceptions for those directories.
- Do not write the lint check in TypeScript — it should run before any compile step. Pure CJS or pure JS via `node` directly.
- Do not edit CHANGELOG.md (per CLAUDE.md).
- Do not add `// eslint-disable` style escape hatches to the new ESLint rule (if ESLint chosen over grep). Use `// HOOK_IO_BYPASS` only on the deliberate bypass paths in `worker-utils.ts` / `logger.ts` if any remain.

---

## Phase 7 — Build, test, manual verify

### Edit 7A — Build

```bash
npm run build-and-sync
```

This rebuilds `plugin/scripts/worker-service.cjs` from `src/services/worker-service.ts` (which transitively pulls in the new `src/cli/hook-io.ts` and the migrated handlers).

### Edit 7B — Run tests

```bash
npm test
```

Expected outcomes:
- All 12 hook-io.test.ts unit tests pass.
- All 23 hook-stream-discipline.test.ts integration tests pass.
- All pre-existing tests still pass.
- `npm run lint:hook-io` exits 0.

### Edit 7C — Manual verification

1. **#2292 regression check:**
   - Stop the worker: `claude-mem stop` (or kill the daemon).
   - Set `CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD=1` in the shell.
   - In Claude Code, send a prompt that triggers UserPromptSubmit.
   - **Expected:** stderr message `claude-mem worker unreachable for 1 consecutive hooks.` is visible.
   - **Pre-fix behavior:** message was silently swallowed.

2. **Banner relocation check (user-message handler):**
   - Trigger a user-message hook on claude-code platform.
   - **Expected:** banner ("📝 Claude-Mem Context Loaded …") appears via `systemMessage` in the JSON envelope, NOT as a stderr write.
   - Inspect via `claude-mem hook claude-code user-message < fixture.json` and observe stdout vs stderr separately.

3. **Windows Terminal tab behavior:**
   - On Windows (or WSL with Windows Terminal): kill the worker, send several prompts under threshold, observe NO tab accumulation (exit 0 path).
   - Once the threshold trips, observe the tab stays open with the error message visible (exit 2 path) — this is desired.

4. **Adapter rejection path:**
   - Send a hook payload with an invalid `cwd` (e.g. `/nonexistent/blah`).
   - **Expected:** stdout JSON `{continue:true,suppressOutput:true}`, exit 0, stderr has the warn line.

5. **Logger fallback:**
   - Set `CLAUDE_MEM_DATA_DIR` to a path the user cannot write to.
   - Trigger any hook.
   - **Expected:** the `[LOGGER] Failed to write to log file:` message appears on stderr (via `emitDiagnostic`).

### Edit 7D — Commit and PR

Per the standard PR creation flow. Don't auto-merge; this is a cross-cutting refactor that benefits from a review loop.

**Verification checklist:**
- [ ] `npm run build-and-sync` exits 0
- [ ] `npm test` exits 0
- [ ] `npm run lint:hook-io` exits 0
- [ ] All 5 manual checks pass
- [ ] PR description includes the Phase 1 audit table

**Anti-pattern guards:**
- Do not skip the manual #2292 regression check. The whole point of this PR is that the diagnostic surfaces.
- Do not bump the version — version-bump skill handles that separately.
- Do not merge without confirming Windows behavior (or noting in the PR that Windows verification is deferred to a Windows reviewer).

---

## Summary of file changes

| Type | Path | Phase |
|---|---|---|
| Created | `src/cli/hook-io.ts` | 3 |
| Edited | `src/cli/hook-command.ts` | 2, 3 |
| Edited | `src/cli/handlers/user-message.ts` | 4A |
| Edited | `src/cli/handlers/context.ts` | 4B |
| Edited | `src/cli/handlers/observation.ts` | 4C |
| Edited | `src/cli/handlers/file-context.ts` | 4C |
| Edited | `src/cli/handlers/session-init.ts` | 4C |
| Edited | `src/cli/handlers/summarize.ts` | 4C |
| Confirm-only | `src/cli/adapters/*.ts` | 4D |
| Edited | `src/shared/worker-utils.ts` | 4E |
| Edited | `src/utils/logger.ts` | 4F |
| Edited | `src/services/worker-service.ts` | 4G |
| Edited | `plugin/scripts/bun-runner.js` | 4H, 2C |
| Edited | `plugin/scripts/version-check.js` | 4I |
| Confirm-only | `plugin/hooks/hooks.json` | 4J |
| Created | `tests/hook-io.test.ts` | 5A |
| Created | `tests/hook-stream-discipline.test.ts` | 5B |
| Edited | `CLAUDE.md` | 6A |
| Created | `docs/architecture/hook-author-guide.md` (or section in hooks-architecture.mdx) | 6B |
| Created | `scripts/check-hook-io-discipline.cjs` | 6C |
| Edited | `package.json` (add `lint:hook-io` script) | 6C |

Estimated diff: **+650 / −80 lines** (net addition; mostly new tests and the wrapper module).

---

## Risk assessment

| Risk | Likelihood | Mitigation |
|---|---|---|
| Buffer flush ordering bug (logger.error fires AFTER emitBlockingError so the error message lands before the diagnostic context) | Medium | Phase 5 test (b) interleaves a buffered write and asserts ordering |
| `src/shared/` → `src/cli/` import causes circular dep | Medium | If the dep cycle is real, move `hook-io.ts` to `src/shared/`. Decision deferred to implementation. |
| Tests rely on a running worker; CI doesn't have one | High | Use `executeWithWorkerFallback`'s natural fall-through (worker unreachable returns the fallback object); test scenarios (b) and (c) rely on this. Scenarios (a) and (g) need a fixture worker — sketch one in `tests/fixtures/fake-worker.ts`. |
| Phase 4 dependency direction breaks build | Medium | `tsc --noEmit` after each handler edit catches this immediately. |
| `console.log` inside `emitModelContext` adds extra newlines that break Codex's JSON parser | Low | Codex adapter test in scenario (a) catches this. If broken, switch to `process.stdout.write(JSON.stringify(...) + '\n')`. |
| The Windows Terminal tab-accumulation rationale gets argued away in review | Medium | CLAUDE.md preserves it; Phase 6 doc edit reinforces. Cite the rationale in PR description. |

---

## Review checklist (for the reviewer)

- [ ] Audit table (Phase 1) covers every emit point in scope
- [ ] `hookCommand`'s blanket no-op is gone; replaced with a typed buffer
- [ ] `recordWorkerUnreachable` calls `emitBlockingError` (#2292 fixed)
- [ ] No handler or adapter calls `process.*` or `console.*` directly
- [ ] `emitModelContext` is the ONLY stdout JSON emitter; called exactly once per hook
- [ ] CLAUDE.md Exit Code Strategy section reflects the new helpers
- [ ] CI lint check is wired and green
- [ ] All 18 + 5 integration tests pass (3 scenarios × 6 hooks + 5 cross-cutting)
- [ ] Manual #2292 reproduction confirms the diagnostic surfaces
- [ ] Windows Terminal tab-accumulation rationale is preserved (no exit-1-on-recoverable-error in handler paths)
