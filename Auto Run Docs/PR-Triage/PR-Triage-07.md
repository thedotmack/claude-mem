# Phase 07: Session Init & CLAUDE.md Path Fixes

Two related areas: session initialization race conditions and CLAUDE.md file generation bugs.

## Session Init Fixes

These PRs all touch `src/cli/handlers/session-init.ts` — review together to avoid conflicts.

- [x] Review PR #828 (`fix: wait for database initialization before processing session-init requests` by @rajivsinclair). Files: `src/cli/handlers/session-init.ts`, `src/services/worker-service.ts`. The session-init handler processes requests before the database is ready. Steps: (1) `gh pr checkout 828` (2) Review — should add a readiness check before DB operations (3) Verify the approach doesn't reintroduce blocking startup (conflicts with Phase 05 #930) (4) Run `npm run build` (5) If compatible with non-blocking startup: `gh pr merge 828 --rebase --delete-branch`
  - **MERGED** (2026-02-05): Adds server-side DB readiness wait on `/api/sessions/init` endpoint following the existing `/api/context/inject` pattern. HTTP server still starts immediately (no startup blocking); only the session-init endpoint waits for DB init (30s timeout). Build passes, no merge conflicts. Also bundles empty prompt handling fix (PR #829 overlap — evaluate #829 for redundancy). Note: client-side already handled 500 gracefully, but server-side fix ensures sessions actually get created rather than silently skipping.

- [x] Review PR #829 (`fix: gracefully handle empty prompts in session-init hook` by @rajivsinclair). File: `src/cli/handlers/session-init.ts`. Steps: (1) `gh pr checkout 829` (2) Review — empty prompt should result in valid exit (not crash) (3) Small change, low risk (4) Run `npm run build` (5) If clean: `gh pr merge 829 --rebase --delete-branch`
  - **CLOSED AS REDUNDANT** (2026-02-05): The empty prompt handling fix (`!prompt || !prompt.trim()` → `return { continue: true, suppressOutput: true }`) was already merged as part of PR #828 (commit 9789a196). Main branch already has this fix at `src/cli/handlers/session-init.ts` lines 24-27. No action needed.

- [x] Review PR #928 (`Fix: Allow image-only prompts in session-init handler` by @iammike). File: `src/cli/handlers/session-init.ts`. Image-only prompts have no text content, causing the handler to reject them. Steps: (1) `gh pr checkout 928` (2) Review — should check for content blocks (images) not just text (3) Run `npm run build` (4) If clean: `gh pr merge 928 --rebase --delete-branch`
  - **CLOSED — FIX APPLIED ON MAIN** (2026-02-05): PR was based on outdated code (pre-#828 refactor) and would have merge conflicts. The concept was valid: image-only prompts had empty text causing session init to be skipped entirely, losing memory tracking. Applied the fix directly on main at `src/cli/handlers/session-init.ts` lines 22-26: empty/undefined prompts now use `[media prompt]` placeholder instead of returning early, so sessions are still created and tracked. Build passes. Credit to @iammike for identifying the issue (#927).

- [x] Review PR #932 (`fix: prevent duplicate generator spawns in handleSessionInit` by @jayvenn21). File: `src/services/worker/http/routes/SessionRoutes.ts`. Steps: (1) `gh pr checkout 932` (2) Review idempotency guard — should check if generator already exists before spawning (3) Run `npm run build` (4) If clean: `gh pr merge 932 --rebase --delete-branch`
  - **MERGED** (2026-02-05): Clean 2-line fix replacing `startGeneratorWithProvider(session, ...)` with `ensureGeneratorRunning(sessionDbId, 'init')` on the legacy `handleSessionInit` endpoint (`/sessions/:sessionDbId/init`). This aligns it with `handleObservations` and `handleSummarize` which already use the idempotent helper. The `ensureGeneratorRunning` method checks `session.generatorPromise` before spawning, preventing duplicate generators from rapid-fire or retried init calls. Build passes, no conflicts. Note: the newer `/api/sessions/init` endpoint doesn't start generators (they're started on first observation), so this only affects the legacy path.

## CLAUDE.md Path & Generation Fixes

These all modify `src/utils/claude-md-utils.ts` — review together.

- [x] Review PR #974 (`fix: prevent race condition when editing CLAUDE.md (#859)` by @cheapsteak). Files: `src/utils/claude-md-utils.ts`, tests. Race condition where concurrent edits corrupt CLAUDE.md. Steps: (1) `gh pr checkout 974` (2) Review locking/atomic write approach (3) Check test coverage (4) Run `npm run build` (5) If clean: `gh pr merge 974 --rebase --delete-branch`
  - **CLOSED — FIX APPLIED ON MAIN** (2026-02-05): PR had merge conflicts on built files (plugin/scripts/*.cjs) but source changes were clean and well-designed. Applied the exact approach to main: two-pass detection where first pass identifies folders containing CLAUDE.md files that appear in the observation's file paths, second pass skips those folders during CLAUDE.md updates. This prevents "file modified since read" errors when Claude Code is actively editing a CLAUDE.md file. All 6 new tests pass (43 total), build passes. Credit to @cheapsteak for the fix and comprehensive test coverage.

- [ ] Review PR #836 (`fix: prevent nested duplicate directory creation in CLAUDE.md paths` by @Glucksberg). File: `src/utils/claude-md-utils.ts`. Steps: (1) `gh pr checkout 836` (2) Review path deduplication logic (3) Run `npm run build` (4) If clean: `gh pr merge 836 --rebase --delete-branch`

- [ ] Review PR #834 (`fix: detect subdirectories inside git repos to prevent CLAUDE.md pollution` by @Glucksberg). File: `src/utils/claude-md-utils.ts`. Steps: (1) `gh pr checkout 834` (2) Review git repo detection — should check for `.git` directory to avoid creating CLAUDE.md inside nested repos (3) Run `npm run build` (4) If clean: `gh pr merge 834 --rebase --delete-branch`

- [ ] Review PR #929 (`Prevent CLAUDE.md generation in Android res/ and other unsafe directories` by @jayvenn21). File: `src/utils/claude-md-utils.ts`. Steps: (1) `gh pr checkout 929` (2) Review exclusion list — should include `res/`, `node_modules/`, `.git/`, etc. (3) Run `npm run build` (4) If clean: `gh pr merge 929 --rebase --delete-branch`

## Folder CLAUDE.md Setting (winner from Phase 02 dedup)

- [ ] Review and merge PR #913 (`fix: respect CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED setting` by @superbiche). Files: `src/services/worker/agents/ResponseProcessor.ts`, `src/services/worker/http/routes/SettingsRoutes.ts`, `src/shared/SettingsDefaultsManager.ts`. This is the chosen PR from the 4-way duplicate group. Steps: (1) `gh pr checkout 913` (2) Verify the setting check is in the right place (before generating, not after) (3) Run `npm run build` (4) If clean: `gh pr merge 913 --rebase --delete-branch`
