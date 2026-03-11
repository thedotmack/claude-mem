# Codex Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Codex a first-class claude-mem memory producer by wiring Codex transcript ingestion into the existing worker lifecycle, while keeping the current MCP search integration unchanged.

**Architecture:** Reuse the existing Codex transcript schema, watcher, and processor already present in the repo. Add a formal transcript command surface to the worker CLI, let the worker manage a transcript watcher process, and document the new Codex flow as "MCP for reading, transcript watcher for writing."

**Tech Stack:** TypeScript, Bun, Node.js, existing worker-service CLI, transcript watcher services, Bun test, MDX docs

---

## Summary

This repository already has almost all of the Codex-specific parsing logic:

- `src/services/transcripts/config.ts` already defines a `codex` schema
- `src/services/transcripts/cli.ts` already supports `init`, `validate`, and `watch`
- `src/services/transcripts/watcher.ts` and `src/services/transcripts/processor.ts` already implement transcript ingestion

The missing piece is not a new installer. The missing piece is a production path that starts, validates, and manages transcript watching from the existing worker lifecycle so Codex sessions actually enter claude-mem.

Out of scope for v1:

- Automatic editing of `~/.codex/config.toml`
- A new `CodexInstaller` abstraction mirroring Cursor
- Making `~/.codex/AGENTS.md` context injection a blocking requirement

## Task 1: Validate Codex transcript assumptions before wiring lifecycle

**Files:**
- Inspect: `src/services/transcripts/config.ts`
- Inspect: `src/services/transcripts/processor.ts`
- Inspect: `transcript-watch.example.json`
- Create: `tests/transcripts/codex-schema.test.ts`

**Step 1: Write the failing test**

Create `tests/transcripts/codex-schema.test.ts` covering the current Codex transcript shape:

- `session_meta` resolves `sessionId` and `cwd`
- `turn_context` updates `cwd`
- `user_message` maps to `session_init`
- `agent_message` maps to `assistant_message`
- `function_call`, `custom_tool_call`, `web_search_call` map to `tool_use`
- `function_call_output`, `custom_tool_call_output` map to `tool_result`
- current session-end mapping is explicitly asserted

The test should use representative JSON objects that match Codex transcript lines and verify the schema definitions in `config.ts` do not drift.

**Step 2: Run test to verify it fails**

Run:

```bash
bun test tests/transcripts/codex-schema.test.ts
```

Expected: failure because the transcript test file does not exist yet.

**Step 3: Write minimal implementation**

Implement the test file only. Do not change production code in this task unless the test reveals the schema is already stale. If stale, limit code changes to `src/services/transcripts/config.ts`.

**Step 4: Run test to verify it passes**

Run:

```bash
bun test tests/transcripts/codex-schema.test.ts
```

Expected: PASS with current Codex schema behavior locked down.

**Step 5: Commit**

```bash
git add tests/transcripts/codex-schema.test.ts src/services/transcripts/config.ts
git commit -m "test: lock codex transcript schema behavior"
```

## Task 2: Expose transcript commands through the worker CLI

**Files:**
- Modify: `src/services/worker-service.ts`
- Inspect: `src/services/transcripts/cli.ts`
- Create: `tests/transcripts/worker-transcript-cli.test.ts`

**Step 1: Write the failing test**

Create `tests/transcripts/worker-transcript-cli.test.ts` that exercises the worker CLI entrypoint and verifies:

- `worker-service transcript init` delegates to transcript CLI and exits `0`
- `worker-service transcript validate` delegates to transcript CLI and exits `0`
- `worker-service transcript watch` routes into transcript watcher startup

The test should stub side effects where needed and assert command dispatch, not full watcher runtime.

**Step 2: Run test to verify it fails**

Run:

```bash
bun test tests/transcripts/worker-transcript-cli.test.ts
```

Expected: failure because `worker-service.ts` does not yet expose a `transcript` command.

**Step 3: Write minimal implementation**

In `src/services/worker-service.ts`:

- add a new `case 'transcript':`
- read `process.argv[3]` as subcommand
- forward `process.argv.slice(4)` into `runTranscriptCommand(...)`
- exit with the returned code for `init` and `validate`
- preserve long-running behavior for `watch`

Import `runTranscriptCommand` from `src/services/transcripts/cli.ts` instead of duplicating logic.

**Step 4: Run test to verify it passes**

Run:

```bash
bun test tests/transcripts/worker-transcript-cli.test.ts
```

Expected: PASS with worker CLI transcript routing verified.

**Step 5: Commit**

```bash
git add src/services/worker-service.ts tests/transcripts/worker-transcript-cli.test.ts
git commit -m "feat: expose transcript commands from worker cli"
```

## Task 3: Let worker start and manage Codex transcript watching

**Files:**
- Modify: `src/services/worker-service.ts`
- Inspect: `src/services/transcripts/watcher.ts`
- Inspect: `src/services/transcripts/state.ts`
- Create: `tests/transcripts/worker-managed-watch.test.ts`

**Step 1: Write the failing test**

Create `tests/transcripts/worker-managed-watch.test.ts` covering worker-managed transcript behavior:

- `start` or daemon startup attempts to initialize transcript watching using the default transcript config
- duplicate starts do not spawn duplicate watchers
- stop/shutdown cleans up watcher resources
- watcher startup failure is logged and does not crash the worker HTTP API process

Use mocks for watcher creation and shutdown rather than spinning a real filesystem watch.

**Step 2: Run test to verify it fails**

Run:

```bash
bun test tests/transcripts/worker-managed-watch.test.ts
```

Expected: failure because worker startup does not currently manage transcript watching.

**Step 3: Write minimal implementation**

In `src/services/worker-service.ts`:

- create a small transcript-watch manager abstraction local to the worker module or a focused helper under `src/services/transcripts/`
- on worker start/daemon path:
  - load transcript config from the default location if present
  - if missing, allow startup to continue without watcher unless explicitly requested by `transcript watch`
  - start a single watcher instance and keep a reference for shutdown
- on `SIGTERM`, `SIGINT`, and worker stop paths:
  - stop the watcher cleanly before process exit
- ensure logs clearly distinguish:
  - transcript config missing
  - transcript watcher started
  - transcript watcher failed

Do not introduce a separate installer or a TOML dependency.

**Step 4: Run test to verify it passes**

Run:

```bash
bun test tests/transcripts/worker-managed-watch.test.ts
```

Expected: PASS with transcript watcher lifecycle managed by the worker.

**Step 5: Run targeted regression tests**

Run:

```bash
bun test tests/worker-spawn.test.ts tests/infrastructure/worker-json-status.test.ts
```

Expected: PASS with no regression in existing worker startup behavior.

**Step 6: Commit**

```bash
git add src/services/worker-service.ts tests/transcripts/worker-managed-watch.test.ts
git commit -m "feat: manage transcript watcher from worker lifecycle"
```

## Task 4: Verify Codex events become observations and file edits

**Files:**
- Inspect: `src/services/transcripts/processor.ts`
- Inspect: `src/services/transcripts/field-utils.ts`
- Create: `tests/transcripts/processor-codex-ingestion.test.ts`

**Step 1: Write the failing test**

Create `tests/transcripts/processor-codex-ingestion.test.ts` that feeds Codex-like transcript entries through `TranscriptEventProcessor` and verifies:

- `session_init` calls the existing session init handler
- tool-use and tool-result pairs become observations
- `apply_patch` tool input generates file-edit events
- assistant messages update summary context
- session-end triggers completion flow

Mock existing handlers from `src/cli/handlers/` and assert the processor calls them with the expected normalized fields.

**Step 2: Run test to verify it fails**

Run:

```bash
bun test tests/transcripts/processor-codex-ingestion.test.ts
```

Expected: failure because the processor path is not yet covered by Codex-specific assertions.

**Step 3: Write minimal implementation**

Only change production code if the new test reveals a real mismatch between the current Codex schema and processor expectations. Prefer changing `src/services/transcripts/config.ts` before changing `processor.ts`.

If multiple session-end event types are observed in current Codex transcripts, extend the schema match in `config.ts` instead of adding Codex-specific branches to the processor.

**Step 4: Run test to verify it passes**

Run:

```bash
bun test tests/transcripts/processor-codex-ingestion.test.ts
```

Expected: PASS with Codex transcript ingestion covered end-to-end at the processor layer.

**Step 5: Commit**

```bash
git add tests/transcripts/processor-codex-ingestion.test.ts src/services/transcripts/config.ts src/services/transcripts/processor.ts
git commit -m "test: verify codex transcript ingestion flow"
```

## Task 5: Document the Codex integration model

**Files:**
- Modify: `README.md`
- Modify: `docs/public/installation.mdx`
- Modify: `docs/public/platform-integration.mdx`

**Step 1: Write the failing doc assertion**

Add or update doc tests only if the repo already validates docs automatically. Otherwise skip synthetic doc tests and use reviewable content changes.

**Step 2: Write minimal documentation**

Document these points consistently:

- Codex MCP integration already covers memory search
- Codex transcript watching is required for memory capture
- the worker can manage transcript watching directly
- default transcript config location is `~/.claude-mem/transcript-watch.json`
- default watch path is `~/.codex/sessions/**/*.jsonl`
- `~/.codex/AGENTS.md` is optional and not required for v1 success

Include concrete commands:

```bash
bun plugin/scripts/worker-service.cjs transcript init
bun plugin/scripts/worker-service.cjs transcript validate
bun plugin/scripts/worker-service.cjs start
```

Explain the read/write split clearly:

- MCP = read memory
- transcript watcher = write memory

**Step 3: Review docs for consistency**

Check that README and docs do not imply Codex memory capture is automatic from MCP registration alone.

**Step 4: Commit**

```bash
git add README.md docs/public/installation.mdx docs/public/platform-integration.mdx
git commit -m "docs: explain codex transcript-based integration"
```

## Task 6: Final verification

**Files:**
- Verify only

**Step 1: Run focused tests**

Run:

```bash
bun test tests/transcripts/codex-schema.test.ts
bun test tests/transcripts/worker-transcript-cli.test.ts
bun test tests/transcripts/worker-managed-watch.test.ts
bun test tests/transcripts/processor-codex-ingestion.test.ts
```

Expected: all PASS.

**Step 2: Run worker regression tests**

Run:

```bash
bun test tests/worker-spawn.test.ts tests/infrastructure/worker-json-status.test.ts tests/integration/worker-api-endpoints.test.ts
```

Expected: PASS with no startup/status regressions.

**Step 3: Manual acceptance check**

Run:

```bash
bun plugin/scripts/worker-service.cjs transcript init
bun plugin/scripts/worker-service.cjs transcript validate
bun plugin/scripts/worker-service.cjs start
```

Then create a real Codex session containing at least one tool call and verify:

- transcript files appear under `~/.codex/sessions/`
- claude-mem worker remains healthy
- Codex observations appear in the database or viewer
- MCP `search` can find the new Codex session content

**Step 4: Final commit**

```bash
git status --short
```

Review changed files, then create a final commit summarizing the Codex transcript integration work.

## Acceptance Criteria

- Codex transcript ingestion can be initialized, validated, and watched from the worker CLI
- Worker startup can manage transcript watching without breaking existing HTTP API behavior
- Codex transcript events become claude-mem observations using the existing handler pipeline
- No TOML dependency or Codex-specific installer is introduced for v1
- Documentation clearly explains that Codex uses MCP for reading and transcript watching for writing

## Notes For The Implementer

- Prefer reusing existing transcript modules over adding new integration abstractions.
- Keep Codex-specific behavior declarative in `src/services/transcripts/config.ts` where possible.
- If real Codex transcripts reveal schema drift, fix the schema before adding processor branches.
- Treat `~/.codex/AGENTS.md` as optional follow-up work, not core scope for this implementation.
