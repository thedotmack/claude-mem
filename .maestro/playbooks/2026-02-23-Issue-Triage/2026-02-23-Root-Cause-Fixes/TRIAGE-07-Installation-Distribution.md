# Phase 07: Installation & Distribution — Fixing the Getting-Started Experience

New users hit install failures: missing node_modules in cache installs, skills/ directory not copied, and np (a publish tool) incorrectly listed as a runtime dependency. These prevent the plugin from working at all.

**Issues resolved:** #1128, #1166 (missing node_modules), #1187 (missing skills/), #1156 (np runtime dep), #979 (migration failure), #1041 (marketplace not found)

## Tasks

- [x] Audit and fix `plugin/package.json` dependencies:
  - Read `plugin/package.json` and compare against actual runtime imports in `plugin/scripts/*.js`
  - Since v10.3.0 uses chroma-mcp via uvx (not the npm chromadb package), search for `require('chromadb')` in plugin scripts
  - If chromadb is no longer needed at runtime, remove it from dependencies and update any error messages that reference it
  - Check the root `package.json` — move `np` to `devDependencies` if it's in `dependencies`
  > **Verified 2026-02-23**: All dependencies are correct. `plugin/package.json` has only `@chroma-core/default-embed` (needed by bundled worker-service.cjs for ONNX embeddings). No `chromadb` references exist in any plugin scripts or error messages. `np` is already in root `devDependencies`. No changes required.

- [x] Fix missing `node_modules` in cache-based installs:
  - Find the install/setup script (check `scripts/smart-install.js` or similar)
  - After extracting the plugin to the marketplace directory, ensure `npm install --production` runs
  - Add a post-install check: verify critical modules are resolvable before declaring success
  > **Fixed 2026-02-23**: Root cause was `plugin/scripts/smart-install.js` had a hardcoded path to `~/.claude/plugins/marketplaces/thedotmack` that doesn't work for cache-based installs. Replaced with `resolveRoot()` that uses `CLAUDE_PLUGIN_ROOT` env var (set by Claude Code for all hooks), falls back to script location via `import.meta.url`, then XDG and legacy paths. Also fixed incorrect `installCLI()` path (`ROOT/plugin/scripts/` → `ROOT/scripts/`). Added `verifyCriticalModules()` post-install check that verifies all `package.json` dependencies exist in `node_modules/` before declaring success, with npm fallback on failure. Updated both `plugin/scripts/smart-install.js` (distributed) and `scripts/smart-install.js` (dev) to use identical resolution logic. Tests added in `tests/smart-install.test.ts` (8 tests passing).

- [x] Fix missing `skills/` directory after install:
  - Check if the build script copies `plugin/skills/` to the output
  - Verify the skill paths in the plugin JSON match the actual filesystem layout
  - Ensure `plugin/skills/mem-search/SKILL.md` is included in the distribution
  > **Fixed 2026-02-23**: `plugin/skills/mem-search/SKILL.md` is already committed to git and correctly located in the `plugin/` distribution directory. The build script (`scripts/build-hooks.js`) doesn't need to copy it — skills are source files, not build outputs. Distribution is covered by: (1) `sync-marketplace.cjs` syncs entire `plugin/` to both marketplace and cache paths, (2) root `package.json` `"files"` field includes `"plugin"` for npm publishes, (3) `plugin.json` doesn't reference skills because Claude Code discovers them by convention (`skills/*/SKILL.md`). Added build-time verification in `scripts/build-hooks.js` that fails the build if `plugin/skills/mem-search/SKILL.md`, `plugin/hooks/hooks.json`, or `plugin/.claude-plugin/plugin.json` are missing. Added 10 regression tests in `tests/infrastructure/plugin-distribution.test.ts` covering: skill file existence, YAML frontmatter validity, 3-layer workflow documentation, required distribution files, hooks.json integrity with CLAUDE_PLUGIN_ROOT references, package.json files field, and build script verification step.

- [x] Fix MigrationRunner schema initialization (#979):
  - Find migrations in `src/services/sqlite/MigrationRunner.ts`
  - Ensure the initial schema uses `CREATE TABLE IF NOT EXISTS` for all core tables
  - Test from a fresh database (the migration must be idempotent)
  > **Fixed 2026-02-23**: Root cause was two parallel migration systems (old `DatabaseManager` migrations 1-7 and new `MigrationRunner` migrations 4-22) sharing the same `schema_versions` table. Version numbers 5, 6, 7 conflicted — old system's version 5 drops orphaned tables, new system's version 5 adds `worker_port` column. When old versions were pre-recorded, `initializeSchema()` skipped core table creation (`maxApplied > 0` gate) and migrations 5-7 were incorrectly considered "already applied". **Fixes applied**: (1) Removed `maxApplied === 0` gate in `initializeSchema()` — core tables now always created via `CREATE TABLE IF NOT EXISTS` regardless of version state. (2) Migrations 5-7 now check actual database state (column/constraint existence) rather than trusting version tracking alone. (3) Added crash-safety: temp table rebuild migrations (7, 9, 21) now `DROP TABLE IF EXISTS xxx_new` before creating temp tables, preventing failures from previously-crashed runs. (4) Added missing migration 21 (`addOnUpdateCascadeToForeignKeys`) to `MigrationRunner` — was only in `SessionStore`. (5) Added `ON UPDATE CASCADE` to FK definitions in `initializeSchema()`. All changes applied to both `runner.ts` and `SessionStore.ts`. Added 13 regression tests in `tests/services/sqlite/migration-runner.test.ts` covering: fresh database initialization, idempotency (run twice), version conflict scenario (old versions 1-7 pre-recorded), crash recovery (leftover temp tables), FK cascade constraints, and data integrity preservation.

- [x] Run `npm test` and fix any failures
  > **Fixed 2026-02-23**: 21 test failures across 8 test files. Root causes and fixes:
  > 1. **Server health endpoint (12 tests)**: `ServerOptions` interface added `workerPath` and `getAiStatus` properties but 3 test files (`server.test.ts`, `hook-execution-e2e.test.ts`, `worker-api-endpoints.test.ts`) weren't updated. Added missing properties to all mock/inline `ServerOptions` objects.
  > 2. **Logger usage standards (1 test)**: `src/services/transcripts/cli.ts` uses `console.log` for user-facing CLI output but was flagged as a background service. Added exclusion pattern.
  > 3. **MarkdownFormatter (2 tests)**: Tests expected "MCP tools" and "MCP" strings but source was refactored to reference "mem-search skill" and "claude-mem skill" instead. Updated test expectations.
  > 4. **SettingsDefaultsManager (1 test)**: `getBool` test used `CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS` (default changed to `'false'`). Updated to use `CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT` (default `'true'`).
  > 5. **ChromaSync (3 tests)**: Tests checked internal `client`, `transport`, `connected` properties that no longer exist after refactor to `ChromaMcpManager` singleton. Updated tests to verify transport cleanup in `ChromaMcpManager.ts` source instead.
  > 6. **OpenClaw (2 tests)**: Tests expected `memory_` tool skipping and response truncation but source code lacked these features. Added `memory_` prefix check to skip recursive observation loops and `MAX_TOOL_RESPONSE_LENGTH = 1000` truncation to `openclaw/src/index.ts`.
  > Final result: 1008 pass, 0 fail, 3 skip across 57 files.
