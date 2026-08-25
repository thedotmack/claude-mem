# Phase 09: Low — Quality & Maintenance

These are low-severity issues that don't cause data loss or crashes but represent technical debt, test reliability problems, and minor correctness issues. Fixing them improves the project's long-term health and prevents them from becoming real bugs later.

**Issues addressed:** #1156, #1299, #1219, #1259, #1335, #1137, #1218, #1163
**Prerequisite:** Phases 01-08 should be complete.

## Tasks

- [ ] Move `np` from dependencies to devDependencies (#1156). The npm publish tool `np` is incorrectly listed as a runtime dependency, bloating installation:
  - Read `package.json` — find `np` in the `dependencies` section
  - Move it to `devDependencies`
  - Run `npm install` to update the lockfile
  - Verify no runtime code imports or references `np` — search for `require('np')` or `import.*np`

- [ ] Fix mock.module() leak in test suite (#1299). The `context-reinjection-guard` test uses `mock.module()` which pollutes parallel test workers:
  - Search for `mock.module` in `tests/` to find the affected test file
  - The fix: use `jest.mock()` with proper cleanup in `afterEach`/`afterAll`, OR isolate the test to run in its own worker with `--runInBand` or equivalent
  - Check if Bun's test runner has module mock scoping — if so, use the scoped API
  - Ensure the mock is restored after the test to prevent interference with other tests

- [ ] Fix version mismatch in plugin.json (#1219). The version in `plugin/.claude-plugin/plugin.json` falls behind `package.json`:
  - Read both `package.json` and `plugin/.claude-plugin/plugin.json` — compare versions
  - If they differ, update plugin.json to match package.json
  - The real fix: ensure the build process keeps them in sync. Check `scripts/build-hooks.js` or the version bump script
  - Search for the version-bump skill or script: it should update ALL version locations. If it misses plugin.json, add it

- [ ] Document Gemini model compatibility (#1259). Gemini Flash Lite produces hallucinated observations while Gemini 2.5 Flash works correctly:
  - Search for model validation or model selection logic in `src/` — find where the SDK agent model is configured
  - Add a minimum-model-quality check or recommendation: if the configured model is in a known-bad list (`gemini-flash-lite`, etc.), log a warning at startup: `Warning: ${model} may produce low-quality observations. Recommended: gemini-2.5-flash or claude-*`
  - Add the known-bad models as a constant, not a setting — this is product guidance, not user configuration
  - Close #1259 with a comment documenting which models are known to work well and which don't

- [ ] Fix ECC observer session conflict (#1335). Observer sessions trigger External Claude Code's `observe.sh` hook, causing a double Haiku loop and `/rename` history pollution:
  - Search for `observer`, `observe`, `ECC`, `subagent` in the codebase to understand how observer sessions are detected
  - The fix: in the hook layer, detect when the current session is a claude-mem SDK agent (observer) session and skip firing external hooks
  - Search for `CLAUDE_MEM_AGENT` or similar env vars that identify observer sessions
  - Add a guard at the top of the observation handler: if this is an observer session, return early

- [ ] Address stuck processing messages (#1137, #1218). Plan mode and long sessions cause messages to get stuck in `processing` state:
  - The `PendingMessageStore` already has self-healing (60s stale threshold resets to `pending`). Check if this is working correctly:
    - Read `src/services/sqlite/PendingMessageStore.ts` `claimNextMessage()` — verify the stale detection logic
    - The Phase 02 fix (24h max age, 50-message batch limit) should help prevent accumulation
  - If messages are still getting stuck, the issue may be in `SessionQueueProcessor` — check the idle timeout (3 minutes) and whether it properly aborts stuck SDK agent processes
  - Add a periodic cleanup job: every 5 minutes, run `resetStaleProcessingMessages()` regardless of queue activity
  - Close #1137 and #1218 with comments explaining the multi-layer fix (Phase 02 queue bounds + this periodic cleanup)

- [ ] Fix Claude provider failure behind API proxy (#1163). The SDK spawn fails when used behind an API proxy or in nested Claude Code environments:
  - Search for how the Claude SDK agent is spawned — look in `src/services/worker/SessionManager.ts` or related files
  - Check if proxy environment variables (`HTTP_PROXY`, `HTTPS_PROXY`, `ANTHROPIC_API_BASE`) are forwarded to the spawned subprocess
  - The fix: explicitly pass proxy-related env vars to the subprocess spawn options
  - Also check for nested Claude Code detection — if `CLAUDE_CODE_SESSION_ID` is already set, the subprocess may conflict with the parent session

- [ ] Run tests and build:
  - Run `npm test` — all 1123+ tests should pass
  - Run `npm run build-and-sync`
  - Verify the version in plugin.json matches package.json
