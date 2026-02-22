# Implementation Plan: SDK Upgrade Phase 0 (Test Harness) + Phase 1 (Core Upgrade)

## Overview

Upgrade `@anthropic-ai/claude-agent-sdk` from `^0.1.76` (installed: 0.1.77) to `^0.2.49` on the `feat/sdk-upgrade-0.2.x` branch. Phase 0 creates a `claude -p` subprocess test harness to establish a regression baseline against 0.1.77 before upgrading. Phase 1 performs the dependency bump, resolves any conflicts, and re-runs all tests including the new harness.

## Requirements

- Create integration test harness using `claude -p` subprocess tests with `CLAUDE_CODE_SIMPLE=1`
- Separate integration tests from unit tests via vitest workspace config
- Add `npm run test:sdk` script for targeted harness execution
- Upgrade SDK dependency to `^0.2.49` and resolve Zod 4 peer dependency
- Ensure TypeScript compilation succeeds with zero errors
- All existing unit tests continue passing
- New harness tests pass against upgraded SDK

## Delivery Strategy

current-branch (`feat/sdk-upgrade-0.2.x`)

## Architecture Changes

- **New file**: `tests/integration/sdk-harness.test.ts` -- subprocess-based SDK integration tests
- **New file**: `vitest.workspace.ts` -- vitest workspace config separating unit and integration tests
- **Modified file**: `vitest.config.ts` -- renamed to unit test project config (or kept as-is with workspace override)
- **Modified file**: `package.json` -- SDK dependency bump + `test:sdk` script
- **No source changes required**: all 4 SDK import files (`SDKAgent.ts`, `worker-types.ts`, `scripts/translate-readme/index.ts`, `scripts/bug-report/index.ts`) are forward-compatible

## Implementation Steps

### Phase 0: SDK Test Harness

#### Step 0.1: Create vitest workspace config (File: `/home/doublefx/projects/claude-mem/vitest.workspace.ts`)

- **Action**: Create a vitest workspace file that defines two projects: `unit` (existing tests) and `integration` (new SDK harness tests)
- **Why**: Integration tests are slow (5-15s each, require API key) and must not run during `npm test`. Vitest workspaces allow targeted execution via `--project integration`
- **Dependencies**: None
- **Risk**: Low

```typescript
// vitest.workspace.ts
import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    extends: './vitest.config.ts',
    test: {
      name: 'unit',
      include: ['tests/**/*.test.ts'],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/*.spec.ts',
        'tests/integration/sdk-harness.test.ts',
      ],
    },
  },
  {
    test: {
      name: 'integration',
      include: ['tests/integration/sdk-harness.test.ts'],
      testTimeout: 120_000,  // 2 minutes per test (SDK subprocess is slow)
      hookTimeout: 30_000,
      pool: 'forks',
    },
  },
]);
```

- **Acceptance criteria**: `npx vitest run --project unit` runs all existing tests (excluding sdk-harness). `npx vitest run --project integration` runs only sdk-harness tests.

#### Step 0.2: Update existing vitest config (File: `/home/doublefx/projects/claude-mem/vitest.config.ts`)

- **Action**: No changes needed to the base config. The workspace file extends it and adds project-specific overrides. Verify that the existing `exclude` pattern in `vitest.config.ts` does not interfere with the workspace.
- **Why**: The workspace `extends` the base config, so base settings (pool, timeouts, globals) are inherited by the `unit` project.
- **Dependencies**: Step 0.1
- **Risk**: Low

- **Acceptance criteria**: `npm test` (which runs `vitest run`) continues to work unchanged, running the `unit` project by default.

**Note on workspace behavior**: When a `vitest.workspace.ts` exists, vitest uses it to define projects. The `npm test` command (`vitest run`) will by default run ALL workspace projects. To preserve backward compatibility, we need to either:
  - (a) Set `npm test` to `vitest run --project unit`, or
  - (b) Gate the integration project on an environment variable

Option (a) is cleaner. Update `package.json` scripts in Step 0.4.

#### Step 0.3: Create SDK harness test file (File: `/home/doublefx/projects/claude-mem/tests/integration/sdk-harness.test.ts`)

- **Action**: Create the integration test file with three test cases:
  1. **JSON stream validation**: Spawn `claude -p "Say hello" --max-turns 1 --output-format stream-json` with `CLAUDE_CODE_SIMPLE=1`, collect output, assert the stream contains at least one `assistant` message and one `result` message
  2. **Process cleanup after SIGTERM**: Spawn a long-running query, send SIGTERM after first data, assert the process exits (not null exit code) and no orphan PID remains
  3. **Session resume round-trip**: Create a session, capture `session_id` from the stream, resume it with `--resume`, assert the resumed session produces a `result` message

- **Why**: These tests validate the core SDK wire protocol that claude-mem depends on. Running them before and after the upgrade creates a regression gate.
- **Dependencies**: None (can be written independently)
- **Risk**: Medium (tests require an authenticated `claude` CLI, are inherently non-deterministic)

- **Key implementation details**:
  - Use `spawn` from `node:child_process` (not the SDK's `query()`) to test the CLI subprocess directly
  - Set `CLAUDE_CODE_SIMPLE=1` in the subprocess env to disable hooks, MCP, CLAUDE.md, and attachments (this also prevents claude-mem plugin from activating since it uses hooks)
  - Use `--max-turns 1` to keep tests fast and cheap
  - Use `--output-format stream-json` for structured output parsing (per Claude Code docs: returns newline-delimited JSON)
  - Use `--no-session-persistence` on tests that don't need session resume (avoids polluting the session store with test sessions)
  - Use `describe.skipIf(process.env.SKIP_SDK_TESTS)` for opt-out skipping. The `claude` CLI works with both API keys AND subscription login (OAuth), so checking for `ANTHROPIC_API_KEY` would wrongly skip tests for subscription users
  - Each test should have its own `AbortController` with a safety timeout (60s) to prevent hanging

```typescript
// Sketch of test structure
import { spawn, type ChildProcess } from 'node:child_process';
import { describe, it, expect, afterEach } from 'vitest';

const HARNESS_ENV: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([, v]) => v !== undefined) as [string, string][]
  ),
  CLAUDE_CODE_SIMPLE: '1',
  // CLAUDE_CODE_SIMPLE=1 already disables hooks (including claude-mem plugin)
};

function spawnClaude(args: string[]): ChildProcess {
  return spawn('claude', [...args, '--output-format', 'stream-json'], {
    env: HARNESS_ENV,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

async function collectMessages(child: ChildProcess): Promise<unknown[]> {
  const messages: unknown[] = [];
  const chunks: Buffer[] = [];
  child.stdout!.on('data', (chunk: Buffer) => chunks.push(chunk));
  await new Promise<void>((resolve) => child.on('exit', () => resolve()));
  const output = Buffer.concat(chunks).toString('utf-8');
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    try { messages.push(JSON.parse(line)); } catch { /* skip non-JSON lines */ }
  }
  return messages;
}

// Opt-out skip: tests run by default, set SKIP_SDK_TESTS=1 to skip (e.g. in CI without auth)
describe.skipIf(process.env.SKIP_SDK_TESTS === '1')('SDK subprocess harness', () => {
  const processes: ChildProcess[] = [];

  afterEach(() => {
    for (const proc of processes) {
      if (!proc.killed && proc.exitCode === null) {
        proc.kill('SIGKILL');
      }
    }
    processes.length = 0;
  });

  it('spawns claude -p and receives valid JSON stream', async () => { /* ... */ });
  it('validates process cleanup after SIGTERM', async () => { /* ... */ });
  it('validates session resume round-trip', async () => { /* ... */ });
});
```

- **Acceptance criteria**:
  - All 3 tests pass against current SDK (0.1.77) with an authenticated `claude` CLI (API key or subscription)
  - Tests skip gracefully when `SKIP_SDK_TESTS=1` is set
  - No orphan processes left after test suite completes
  - Total test suite runtime < 90 seconds

#### Step 0.4: Add npm scripts (File: `/home/doublefx/projects/claude-mem/package.json`)

- **Action**: Add/update these scripts:
  ```json
  {
    "test": "vitest run --project unit",
    "test:sdk": "vitest run --project integration"
  }
  ```
- **Why**: `npm test` should remain fast (unit tests only). `npm run test:sdk` provides a targeted way to run the harness.
- **Dependencies**: Steps 0.1, 0.3
- **Risk**: Low

- **Acceptance criteria**: `npm test` runs unit tests only (no integration). `npm run test:sdk` runs SDK harness tests only.

#### Step 0.5: Run harness against current SDK (baseline)

- **Action**: Execute `npm run test:sdk` against the current SDK (0.1.77) and verify all 3 tests pass. This establishes the baseline before upgrading.
- **Why**: If tests fail against 0.1.77, it's a harness bug, not an upgrade regression.
- **Dependencies**: Steps 0.1 through 0.4
- **Risk**: Low

- **Acceptance criteria**: All 3 harness tests pass. `npm test` also passes (no regression to unit tests).

### Phase 1: Core SDK Upgrade

#### Step 1.1: Update SDK dependency (File: `/home/doublefx/projects/claude-mem/package.json`)

- **Action**: Change the SDK dependency specifier:
  ```
  "@anthropic-ai/claude-agent-sdk": "^0.1.76"  -->  "@anthropic-ai/claude-agent-sdk": "^0.2.49"
  ```
- **Why**: Core upgrade target.
- **Dependencies**: Phase 0 complete (baseline established)
- **Risk**: Low

- **Acceptance criteria**: `package.json` shows `"@anthropic-ai/claude-agent-sdk": "^0.2.49"`.

#### Step 1.2: Run npm install and resolve conflicts

- **Action**: Run `npm install`. Check for:
  1. Zod peer dependency warnings -- the current tree already has `zod@4.3.6` via deduplication, and SDK 0.2.49 requires `zod@^4.0.0`, so no conflict expected
  2. `zod-to-json-schema@^3.24.6` peer dep is `zod@^3.24.1 || ^4` (installed: 3.25.1), so it supports Zod 4 -- no conflict expected
  3. Any other dependency resolution issues
- **Why**: Dependency resolution is the first gate. Must succeed before compilation.
- **Dependencies**: Step 1.1
- **Risk**: Low-Medium (pre-analysis shows no conflicts, but npm resolution can surprise)

- **Verification command**: `npm ls zod` should show all packages using `zod@4.x` with no conflicting `zod@3.x` trees.
- **Acceptance criteria**: `npm install` completes without errors or unresolved peer dependency warnings.

#### Step 1.3: Verify TypeScript compilation (Command: `npm run build`)

- **Action**: Run `npm run build` and fix any TypeScript compilation errors.
- **Why**: The type export structure changed (multi-file to single `sdk.d.ts`). Although the top-level exports should be compatible, subtle type changes could surface.
- **Dependencies**: Step 1.2
- **Risk**: Low (analysis shows all used types are present and structurally compatible in 0.2.49)

**Files to watch for errors (in priority order):**

1. `/home/doublefx/projects/claude-mem/src/services/worker/SDKAgent.ts`
   - Imports: `query` -- present in 0.2.49, signature compatible
   - Uses: `Options.resume`, `Options.model`, `Options.cwd`, `Options.disallowedTools`, `Options.abortController`, `Options.pathToClaudeCodeExecutable`, `Options.spawnClaudeCodeProcess`, `Options.env` -- all present in 0.2.49
   - Response types: `message.type === 'assistant'`, `message.type === 'result'`, `message.session_id`, `message.subtype === 'success'` -- all compatible
   - **Likely result**: Compiles cleanly

2. `/home/doublefx/projects/claude-mem/src/services/worker-types.ts`
   - Re-exports: `SDKUserMessage` -- present in 0.2.49
   - **Likely result**: Compiles cleanly

3. `/home/doublefx/projects/claude-mem/scripts/translate-readme/index.ts`
   - Imports: `query`, `SDKMessage`, `SDKResultMessage` -- all present in 0.2.49
   - Uses: `result.total_cost_usd` -- need to verify this field exists on `SDKResultSuccess` in 0.2.49
   - Uses: `message.type === 'stream_event'`, `message.event` -- need to verify `SDKStreamEvent` type
   - **Likely result**: Compiles cleanly, but `total_cost_usd` and `stream_event` need verification

4. `/home/doublefx/projects/claude-mem/scripts/bug-report/index.ts`
   - Same imports and patterns as translate-readme
   - **Likely result**: Same as translate-readme

**If compilation errors occur**, likely fixes:
- Type narrowing issues: Add explicit type assertions or update discriminated union checks
- Missing type exports: Check if type was renamed or restructured in 0.2.49's flat `sdk.d.ts`
- `total_cost_usd` field: If removed from `SDKResultMessage`, extract from a different location or make optional

- **Acceptance criteria**: `npm run build` completes with zero errors.

#### Step 1.4: Run unit tests (Command: `npm test`)

- **Action**: Run `npm test` and verify all existing unit tests pass.
- **Why**: Ensures no behavioral regression from the SDK upgrade. Even though claude-mem doesn't import SDK types in most test files, the `sdk-agent-resume.test.ts` file tests resume logic that depends on SDK semantics.
- **Dependencies**: Step 1.3
- **Risk**: Low (unit tests don't exercise the actual SDK, they test isolated logic)

- **Acceptance criteria**: All unit tests pass. Zero failures, zero new warnings.

#### Step 1.5: Run SDK harness against upgraded SDK (Command: `npm run test:sdk`)

- **Action**: Run `npm run test:sdk` to execute the harness tests against the upgraded SDK (0.2.49).
- **Why**: This is the critical regression check. The harness exercises the actual CLI subprocess that the SDK bundles. If the upgrade broke subprocess behavior, JSON stream format, or session resume, this will catch it.
- **Dependencies**: Steps 1.3, 1.4
- **Risk**: Medium (the bundled CLI changed from Claude Code v2.0.78 to v2.1.49, behavioral differences possible)

**If harness tests fail**, likely causes and fixes:
- **JSON stream format changed**: Update `collectMessages` parser to handle new message format
- **Session resume behavior changed**: Update the resume test to match new session ID format or flow
- **Process cleanup changed**: Adjust SIGTERM timing or add longer waits
- **New required flags**: Check if `--output-format stream-json` syntax changed

- **Acceptance criteria**: All 3 harness tests pass against SDK 0.2.49.

#### Step 1.6: Verify build-and-sync (Command: `npm run build-and-sync`)

- **Action**: Run `npm run build-and-sync` to build and deploy to the local marketplace.
- **Why**: Final integration check -- ensures the upgraded SDK works in the full plugin deployment pipeline.
- **Dependencies**: Steps 1.4, 1.5
- **Risk**: Low

- **Acceptance criteria**: Build completes, worker restarts successfully, no errors in worker logs (`npm run worker:logs`).

## Testing Strategy

- **Unit tests**: All existing tests in `tests/` continue passing via `npm test` (unchanged)
- **Integration tests**: New harness in `tests/integration/sdk-harness.test.ts` via `npm run test:sdk`
  - Test 1: JSON stream validation (spawn + collect + assert message types)
  - Test 2: Process cleanup after SIGTERM (spawn + kill + assert exit)
  - Test 3: Session resume round-trip (spawn + capture session_id + resume + assert)
- **E2E tests**: Manual smoke test via `npm run build-and-sync` (not automated in this plan)

## Risks & Mitigations

- **Risk**: Harness tests are flaky due to LLM non-determinism
  - Mitigation: Use `--max-turns 1` to minimize response variability. Assert on structural properties (message types, field presence) not content. Add retry logic if needed.

- **Risk**: Claude CLI not authenticated in all environments
  - Mitigation: `describe.skipIf(process.env.SKIP_SDK_TESTS === '1')` allows opt-out. The `claude` CLI works with both API keys and subscription login (OAuth).

- **Risk**: SDK 0.2.49 bundles Claude Code v2.1.49 which has different subprocess behavior than v2.0.78
  - Mitigation: The harness tests validate the actual wire protocol, so any breaking changes will be caught. The source code itself doesn't need changes (analysis confirms forward compatibility).

- **Risk**: `total_cost_usd` or `stream_event` types changed in 0.2.49, breaking scripts
  - Mitigation: Scripts (`translate-readme`, `bug-report`) are non-core utilities. If they fail to compile, fix them with updated type assertions. They can be deprioritized if complex.

- **Risk**: Vitest workspace changes break existing `npm test` behavior
  - Mitigation: Step 0.2 explicitly verifies `npm test` still works after workspace setup. The `--project unit` flag ensures isolation.

## Success Criteria

- [ ] `vitest.workspace.ts` exists with `unit` and `integration` projects
- [ ] `tests/integration/sdk-harness.test.ts` exists with 3 test cases
- [ ] `npm test` runs unit tests only (excludes sdk-harness), all pass
- [ ] `npm run test:sdk` runs integration tests only, all pass (when `claude` CLI is authenticated)
- [ ] `package.json` shows `"@anthropic-ai/claude-agent-sdk": "^0.2.49"`
- [ ] `npm install` resolves cleanly (no peer dependency conflicts)
- [ ] `npm run build` compiles with zero TypeScript errors
- [ ] `npm test` passes after SDK upgrade (unit tests)
- [ ] `npm run test:sdk` passes after SDK upgrade (harness tests)
- [ ] `npm run build-and-sync` succeeds (end-to-end deployment)

## Reference Documentation

When encountering unexpected behavior, type errors, or API mismatches during implementation, consult these docs:

### Claude Code CLI

- **CLI reference** (flags, env vars, `CLAUDE_CODE_SIMPLE`): https://code.claude.com/docs/en/cli-reference.md
- **Headless / `-p` mode**: https://code.claude.com/docs/en/headless.md
- **Settings & env vars**: https://code.claude.com/docs/en/settings.md
- **Full docs index**: https://code.claude.com/docs/llms.txt

### Agent SDK (TypeScript)

- **TS SDK reference** (`query()`, `Options`, `SDKMessage` types, `Query` interface): https://platform.claude.com/docs/en/agent-sdk/typescript
- **SDK overview**: https://platform.claude.com/docs/en/agent-sdk/overview
- **Streaming output**: https://platform.claude.com/docs/en/agent-sdk/streaming-output
- **Structured outputs**: https://platform.claude.com/docs/en/agent-sdk/structured-outputs

### Key Facts (verified 2026-02-22)

- `CLAUDE_CODE_SIMPLE=1` disables: hooks, MCP, CLAUDE.md, attachments. Enables only: Bash, Read, Edit
- `--no-session-persistence` prevents sessions from being saved to disk (print mode only)
- `--output-format stream-json` returns newline-delimited JSON objects (each line is an `SDKMessage`)
- `claude` CLI works with both `ANTHROPIC_API_KEY` AND subscription login (OAuth) -- do NOT gate tests on API key presence
- `Query` interface methods (per docs): `interrupt()`, `rewindFiles()`, `setPermissionMode()`, `setModel()`, `setMaxThinkingTokens()`, `supportedCommands()`, `supportedModels()`, `mcpServerStatus()`, `accountInfo()` -- `close()` is NOT documented
- `SDKResultMessage` success variant includes `total_cost_usd`, `usage`, `modelUsage`, `structured_output`
- `SDKPartialAssistantMessage` has `type: "stream_event"` (only when `includePartialMessages` is true)
