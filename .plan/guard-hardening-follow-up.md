# Guard Hardening Follow-Up Plan

Goal: harden the v12.7.3 reliability guards so they keep stopping the retry-loop and schema/startup regressions without unintentionally blocking normal recovery, upgrade, summary, install, or export workflows.

This plan follows the `claude-mem:make-plan` workflow. Phase 0 was documentation discovery with subagent extraction; implementation phases below cite concrete source/test patterns to copy.

## Phase 0: Documentation Discovery

### Discovery Sources

Generator/provider retry semantics:

- `src/services/worker/provider-errors.ts:2-31`
- `src/services/worker/retry.ts:37-44`, `58-130`
- `src/services/worker/ClaudeProvider.ts:37-99`, `197-225`, `260-312`
- `src/services/worker/GeminiProvider.ts:47-115`
- `src/services/worker/OpenRouterProvider.ts:43-108`
- `src/services/worker-service.ts:491-585`, `623-645`
- `src/services/worker/session/GeneratorExitHandler.ts:14-20`, `35-151`
- `tests/worker/provider-classifiers.test.ts:13-238`
- `tests/services/worker/generator-exit-handler.test.ts:55-128`

SQLite/schema and worker upgrade safety:

- `src/services/sqlite/SessionStore.ts:68-131`, `914-966`
- `src/services/sqlite/PendingMessageStore.ts:32-147`
- `src/services/sqlite/schema.sql:12-18`, `122-153`
- `src/services/worker/DatabaseManager.ts:17-21`
- `src/services/worker-service.ts:334-347`
- `src/services/infrastructure/HealthMonitor.ts:130-156`
- `src/npx-cli/commands/install.ts:1040-1064`
- `src/services/install/shutdown-helper.ts:6-38`
- `src/supervisor/index.ts:155-198`
- `src/supervisor/process-registry.ts:56-116`
- `tests/services/sqlite/PendingMessageStore.test.ts:110-315`
- `tests/supervisor/index.test.ts:15-87`

Hook/install/export behavior:

- `src/cli/hook-command.ts:8-116`
- `src/cli/types.ts:1-46`
- `src/cli/handlers/summarize.ts:11-89`
- `src/shared/transcript-parser.ts:17-143`
- `src/sdk/parser.ts:26-84`
- `src/services/worker/agents/ResponseProcessor.ts:99-155`, `255-267`
- `src/npx-cli/install/setup-runtime.ts:241-287`
- `plugin/scripts/version-check.js:35-68`
- `scripts/export-memories.ts:18-153`
- `tests/hook-command.test.ts:4-180`
- `tests/setup-runtime.test.ts:43-133`
- `tests/plugin-version-check.test.ts:35-64`
- `tests/scripts/export-memories.test.ts:39-227`

### Allowed APIs

- Provider errors: `ClassifiedProviderError`, `ProviderErrorClass`, `isClassified`, provider classifier functions, `withRetry`, `isRetryableKind`, `computeBackoffMs`.
- Generator exit: `handleGeneratorExit(session, reason, deps)`, `RestartGuard.recordRestart()`, `RestartGuard.recordSuccess()`, `ActiveSession.abortReason`.
- Queue/schema: `new SessionStore(dbOrPath)`, `PendingMessageStore.enqueue`, `claimNextMessage`, `clearPendingForSession`, `resetProcessingToPending`, `getPendingCount`, `peekPendingTypes`.
- Worker/process: `validateWorkerPidFile`, `verifyPidFileOwnership`, `runShutdownCascade`, `getRunningWorkerVersion`, `checkVersionMatch`, `shutdownWorkerAndWait`.
- Hooks: `hookCommand`, `isNonBlockingHookInputError`, `isWorkerUnavailableError`, `NormalizedHookInput`, `HookResult`, `EventHandler`, `getPlatformAdapter`, `getEventHandler`.
- Install/export: `readInstallMarker`, `writeInstallMarker`, `isInstallCurrent`, `exportMemories`.

### Anti-Patterns To Avoid

- Do not resurrect string-matching `unrecoverablePatterns`; dispatch uses `ClassifiedProviderError.kind`.
- Do not duck-type classified errors; `isClassified` is `instanceof ClassifiedProviderError`.
- Do not assume every `abortReason` string is terminal; only the hard-stop values in `GeneratorExitHandler` are terminal.
- Do not reintroduce queue fields or statuses removed from current schema: `worker_pid`, `retry_count`, `failed_at_epoch`, `completed_at_epoch`, `processed`, `failed`.
- Do not put worker-critical schema repair only in `MigrationRunner`; workers instantiate `SessionStore` directly.
- Do not assume a live PID means the running worker is the right version.
- Do not add a new CLI parser dependency; local scripts use manual `process.argv` parsing.
- Do not emit Claude Code hook fields that the adapter intentionally strips.
- Do not claim exports are partial unless an explicit partial mode is implemented.

## Phase 1: Provider Guard Boundary Tests

### Provider Guard Implementation

Add focused tests proving recoverable provider errors remain recoverable after v12.7.3.

Copy the classifier-test style from `tests/worker/provider-classifiers.test.ts:13-238` and the generator-exit mock style from `tests/services/worker/generator-exit-handler.test.ts:1-128`.

Cover:

- Claude 429 classifies as `rate_limit`, not `quota_exhausted`.
- Claude 5xx/529/overload classifies as `transient`.
- Gemini/OpenRouter 429 classifies as `rate_limit`.
- Gemini/OpenRouter 5xx with no quota wording classifies as `transient`.
- `handleGeneratorExit` restarts pending work for non-hard-stop reasons.
- Unknown `abortReason` strings are not treated as hard stops.

### Provider Guard Documentation References

- `src/services/worker/provider-errors.ts:2-31`
- `src/services/worker/retry.ts:37-44`
- `src/services/worker/session/GeneratorExitHandler.ts:14-20`, `101-150`
- `tests/worker/provider-classifiers.test.ts:13-238`
- `tests/services/worker/generator-exit-handler.test.ts:55-128`

### Provider Guard Verification Checklist

- Run `bun test tests/worker/provider-classifiers.test.ts tests/services/worker/generator-exit-handler.test.ts`.
- Confirm tests fail if `rate_limit` or `transient` starts mapping to a hard-stop path.
- Confirm existing hard-stop tests for `overflow`, `quota`, and `quota:*` still pass.

### Provider Guard Anti-Pattern Guards

- Do not map generic 429s to `quota:*`.
- Do not add new pending-message retry counters.
- Do not use private provider helpers as public plan APIs.

## Phase 2: Recovery Count Failure Safety

### Recovery Count Implementation

Make `handleGeneratorExit` less destructive when `pendingStore.getPendingCount(sessionDbId)` fails for a temporary SQLite condition.

Copy the guarded finalization pattern from `src/services/worker/session/GeneratorExitHandler.ts:53-78`, but split count failures into:

- temporary DB-busy/locked errors: log, remove only the in-memory generator state or schedule a short retry without clearing pending rows.
- schema/corruption/unexpected errors: keep current leak-prevention behavior.

Add tests beside `tests/services/worker/generator-exit-handler.test.ts` using the existing `createDeps` mock scaffold.

### Recovery Count Documentation References

- `src/services/worker/session/GeneratorExitHandler.ts:89-99`
- `src/services/sqlite/PendingMessageStore.ts:116-123`
- `tests/services/worker/generator-exit-handler.test.ts:1-128`
- `src/services/sqlite/SessionStore.ts:99-131` as the local pattern for no-stamp/no-destructive-progress-on-failure.

### Recovery Count Verification Checklist

- Run `bun test tests/services/worker/generator-exit-handler.test.ts`.
- Add one test where `getPendingCount` throws a simulated busy/locked SQLite error and `clearPendingForSession` is not called.
- Add one test where `getPendingCount` throws a non-temporary error and current cleanup behavior remains explicit.

### Recovery Count Anti-Pattern Guards

- Do not silently swallow all count failures.
- Do not leave `generatorPromise` set after an exit.
- Do not clear session rows on temporary DB lock pressure.

## Phase 3: Mixed-Version Worker Upgrade Safety

### Worker Upgrade Implementation

Prevent destructive schema cleanup from running while an old worker can still write old `pending_messages` columns.

Use the existing worker version/shutdown APIs rather than inventing process discovery:

- `getRunningWorkerVersion(port)` / `checkVersionMatch(port)` from `src/services/infrastructure/HealthMonitor.ts:130-156`
- `shutdownWorkerAndWait(port, timeoutMs)` from `src/services/install/shutdown-helper.ts:6-38`
- install pre-overwrite shutdown pattern from `src/npx-cli/commands/install.ts:1040-1064`
- PID ownership checks from `src/supervisor/index.ts:155-198`

Plan the implementation so worker startup or install startup detects a live but mismatched worker and shuts it down before schema cleanup can drop legacy columns.

### Worker Upgrade Documentation References

- `src/services/worker-service.ts:334-347`
- `src/services/infrastructure/HealthMonitor.ts:130-156`
- `src/npx-cli/commands/install.ts:1040-1064`
- `src/services/install/shutdown-helper.ts:6-38`
- `src/services/sqlite/SessionStore.ts:76-131`
- `tests/supervisor/index.test.ts:15-87`

### Worker Upgrade Verification Checklist

- Add tests for version mismatch detection around the existing health/version helpers.
- Add a startup/install test proving mismatched live worker is asked to shut down before dependency/schema repair proceeds.
- Run `bun test tests/infrastructure/health-monitor.test.ts tests/supervisor/index.test.ts` plus the new focused test.

### Worker Upgrade Anti-Pattern Guards

- Do not assume PID alive means compatible.
- Do not stamp schema versions after a failed drop.
- Do not reintroduce `worker_pid` compatibility into current queue writes.

## Phase 4: Summary Skip Visibility

### Summary Skip Implementation

Keep missing transcript and skipped-summary behavior non-blocking, but make repeated skips visible.

Copy existing skip-success patterns from `src/cli/handlers/summarize.ts:13-65` and hook classification tests from `tests/hook-command.test.ts:4-29`.

Add lightweight observability:

- log structured skip reasons for missing transcript/no assistant message/extraction failure.
- optionally expose skip reason through existing `ingestSummary` event flow for parsed `<skip_summary/>`, without storing skipped summaries as normal `session_summaries`.

### Summary Skip Documentation References

- `src/cli/hook-command.ts:46-99`
- `src/cli/handlers/summarize.ts:13-65`
- `src/shared/transcript-parser.ts:17-25`
- `src/sdk/parser.ts:26-35`, `48-63`
- `src/services/worker/agents/ResponseProcessor.ts:145-155`, `255-267`
- `tests/cli/handlers/summarize-subagent-skip.test.ts:48-114`

### Summary Skip Verification Checklist

- Run `bun test tests/hook-command.test.ts tests/cli/handlers/summarize-subagent-skip.test.ts tests/cli/handlers/summarize-tag-stripping.test.ts`.
- Confirm Stop hooks still exit success when transcript data is unavailable.
- Confirm skipped summaries do not create normal summary rows.

### Summary Skip Anti-Pattern Guards

- Do not make Stop hook transcript failures blocking again.
- Do not assume `extractLastMessage` throws on missing path.
- Do not emit adapter output keys that platform adapters strip by contract.

## Phase 5: Install Marker Currentness

### Install Marker Implementation

Reduce false stale installs without weakening real dependency freshness.

Use `readInstallMarker` legacy compatibility and `version-check.js` behavior as the source of truth for version-only legacy markers. Adjust `isInstallCurrent` so a matching legacy marker plus present `node_modules` can be accepted or migrated in place, instead of always forcing reinstall when Bun is present but marker lacks `bun`.

Copy tests from `tests/setup-runtime.test.ts:43-133`.

### Install Marker Documentation References

- `src/npx-cli/install/setup-runtime.ts:241-287`
- `plugin/scripts/version-check.js:35-68`
- `tests/setup-runtime.test.ts:43-133`
- `tests/plugin-version-check.test.ts:35-64`

### Install Marker Verification Checklist

- Run `bun test tests/setup-runtime.test.ts tests/plugin-version-check.test.ts`.
- Add/adjust a test for matching legacy marker with `node_modules` and Bun available.
- Keep tests proving wrong version and missing `node_modules` are stale.

### Install Marker Anti-Pattern Guards

- Do not treat malformed markers as valid.
- Do not skip dependency checks when `node_modules` is missing.
- Do not make version-check fail loud in hooks for legacy markers.

## Phase 6: Explicit Partial Export Mode

### Partial Export Implementation

Keep strict export as the default, but add an explicit partial mode for salvage/debug workflows.

Copy the manual parser style from `scripts/export-memories.ts:137-149`. Extend `exportMemories` with an options object rather than adding positional booleans.

Target shape:

- strict default: SDK metadata failure throws and writes no output.
- `--allow-partial`: SDK metadata failure records warning metadata in the export and writes observations/summaries/prompts with `sessions: []`.

### Partial Export Documentation References

- `scripts/export-memories.ts:50-153`
- `tests/scripts/export-memories.test.ts:39-227`
- `src/services/worker/http/routes/DataRoutes.ts:56-67`, `191-197`
- `tests/worker/http/routes/data-routes-coercion.test.ts:151-221`

### Partial Export Verification Checklist

- Run `bun test tests/scripts/export-memories.test.ts tests/worker/http/routes/data-routes-coercion.test.ts`.
- Preserve existing strict failure tests.
- Add tests for `--allow-partial` writing output and marking metadata incomplete.
- Confirm export still sends canonical `memorySessionIds`.

### Partial Export Anti-Pattern Guards

- Do not send `sdkSessionIds` from export code.
- Do not make partial mode the default.
- Do not add a new command parser dependency.

## Final Phase: Verification

Run focused verification first:

```bash
bun test \
  tests/worker/provider-classifiers.test.ts \
  tests/services/worker/generator-exit-handler.test.ts \
  tests/setup-runtime.test.ts \
  tests/plugin-version-check.test.ts \
  tests/scripts/export-memories.test.ts \
  tests/hook-command.test.ts \
  tests/cli/handlers/summarize-subagent-skip.test.ts \
  tests/cli/handlers/summarize-tag-stripping.test.ts \
  tests/worker/http/routes/data-routes-coercion.test.ts
```

Then run source checks:

```bash
git diff --check
rg -n "worker_pid|retry_count|completed_at_epoch|failed_at_epoch|processed|failed" src/services/sqlite src/services/worker
rg -n "sdkSessionIds" scripts/export-memories.ts
rg -n "unrecoverablePatterns|kind:" src/services/worker-service.ts src/services/worker
```

Expected outcomes:

- Hard-stop guard still stops overflow/quota retry loops.
- Transient/rate-limit provider errors remain retryable.
- Temporary DB count failures do not delete pending work.
- Schema cleanup does not race a mismatched old worker.
- Stop hook transcript failures remain non-blocking but visible.
- Matching legacy install markers do not force unnecessary reinstalls.
- Exports stay strict by default and partial only when explicit.
