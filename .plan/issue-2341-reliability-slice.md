# Issue 2341 Reliability Slice Plan

Scope: first PR from the consolidated issue triage. This PR should not try to
solve the full backlog. It should remove a few high-confidence paper cuts from
the first two buckets: install/startup contract and DB/export contract.

## Phase 0: Documentation Discovery

Allowed APIs and patterns:

- Install marker helpers live in `src/npx-cli/install/setup-runtime.ts`.
  Existing tests are in `tests/setup-runtime.test.ts`.
- Runtime startup warning logic lives in `plugin/scripts/version-check.js`.
  It currently resolves the plugin root from `CLAUDE_PLUGIN_ROOT`, then from the
  script directory.
- Export script reads worker settings via `SettingsDefaultsManager.loadFromFile`.
  Worker settings must respect `CLAUDE_MEM_DATA_DIR`, because shared path helpers
  and settings defaults already expose that environment override.
- `/api/sdk-sessions/batch` is registered in
  `src/services/worker/http/routes/DataRoutes.ts` and expects
  `memorySessionIds`. Existing coercion tests are in
  `tests/worker/http/routes/data-routes-coercion.test.ts`.
- Current `PendingMessageStore` writes and reads `tool_use_id`, but no longer
  reads `worker_pid`, `retry_count`, `failed_at_epoch`, or
  `completed_at_epoch`. Current schema guardrails should match code that runs
  today, not old migration intent.

Anti-pattern guards:

- Do not reintroduce `worker_pid` in `pending_messages` unless the current claim
  query starts using it again.
- Do not rely only on `schema_versions` for columns that current SQL references.
- Do not add another install marker format. Read both legacy plain text and the
  current JSON format, but keep writing the JSON marker.
- Do not make `export-memories.ts` fall back to `~/.claude-mem` when
  `CLAUDE_MEM_DATA_DIR` is set.

## Phase 1: Install Marker Compatibility

What to implement:

- Teach `readInstallMarker()` to parse legacy plain-text marker files that only
  contain a version string.
- Teach `plugin/scripts/version-check.js` to accept the same legacy marker shape.
- Keep `writeInstallMarker()` unchanged so new installs write the canonical JSON
  schema.

Verification:

- Add `tests/setup-runtime.test.ts` coverage for a plain-text `.install-version`.
- Add a focused test for `plugin/scripts/version-check.js` behavior, or extend an
  existing plugin script test if one exists.
- Run `bun test tests/setup-runtime.test.ts`.

## Phase 2: Export Script Contract Repair

What to implement:

- Update `scripts/export-memories.ts` to load settings from
  `CLAUDE_MEM_DATA_DIR/settings.json` instead of always using
  `~/.claude-mem/settings.json`.
- Change the `/api/sdk-sessions/batch` request body from `sdkSessionIds` to
  `memorySessionIds`.
- Optionally allow `DataRoutes` to accept the legacy `sdkSessionIds` alias as a
  compatibility bridge, but prefer the canonical field in scripts.

Verification:

- Add or update tests around the SDK-session batch route alias/coercion.
- Add a script-level test if practical; otherwise verify by grep that
  `scripts/export-memories.ts` no longer sends `sdkSessionIds` and no longer
  hardcodes `homedir(), '.claude-mem'`.
- Run the focused route/export tests.

## Phase 3: Current Pending Queue Shape Guardrails

What to implement:

- Add a regression test that initializes a DB whose `schema_versions` claims old
  pending-message migrations are applied while `pending_messages.tool_use_id` is
  missing. Constructing `SessionStore` should still add the missing column
  because current enqueue SQL requires it.
- Add a regression test asserting the current fresh DB shape does not require
  `worker_pid`, since the current claim query does not use it.
- If tests expose a real source/schema mismatch, update docs/schema comments to
  match current code rather than reintroducing unused columns.

Verification:

- Run focused sqlite tests for `SessionStore` / `PendingMessageStore`.
- Grep for live `worker_pid` reads in TypeScript before deciding whether it is
  still a required current column.

## Final Verification

- Run focused tests changed by this PR.
- Run `npm run typecheck:root` if dependencies are available.
- Run `git diff --check`.
- Open a non-draft PR against the upstream default branch.
- Do not merge, release, or ship without explicit user approval.
