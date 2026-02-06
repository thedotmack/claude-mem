# Phase 11: Miscellaneous Bug Fixes

Standalone bug fixes that don't group neatly into other phases.

## Parser Fixes

- [x] Review PR #835 (`fix: handle nested XML tags in parser extractField and extractArrayElements` by @Glucksberg). File: `src/sdk/parser.ts`. Nested XML tags break field extraction. Steps: (1) `gh pr checkout 835` (2) Review regex/parser changes — should handle `<field><inner>content</inner></field>` patterns (3) Run `npm run build` (4) If correct: `gh pr merge 835 --rebase --delete-branch`
  - **Merged.** Clean regex fix: `[^<]*` → `[\s\S]*?` (non-greedy) in `extractField()` and `extractArrayElements()`. Also adds empty element filtering. Greptile 5/5 confidence. Build failure is pre-existing (dompurify dep), not introduced by this PR. TypeScript compilation passes for parser.ts.

- [x] Review PR #862 (`fix: handle missing assistant messages gracefully in transcript parser` by @DennisHartrampf). File: `src/shared/transcript-parser.ts`. Missing assistant messages cause parser crash. Steps: (1) `gh pr checkout 862` (2) Review — should skip or handle gracefully, not crash (3) Run `npm run build` (4) If clean: `gh pr merge 862 --rebase --delete-branch`
  - **Merged.** One-line fix: `throw new Error(...)` → `return ''` in `extractLastMessage()` when no message of requested role is found. Consistent with the function's existing behavior (already returns `''` at line 64 for found-but-empty cases). Fixes crash in summarize hook when user exits before assistant responds.

## Gemini Model Name

- [ ] Review PR #831 (`fix: correct Gemini model name from gemini-3-flash to gemini-3-flash-preview` by @Glucksberg). Files: 12 files including GeminiAgent.ts, docs, UI. Steps: (1) `gh pr checkout 831` (2) Verify the correct model name from Gemini docs (is it `gemini-3-flash-preview` or something else as of today?) (3) If model name is correct and changes are sound: `gh pr merge 831 --rebase --delete-branch`

## Config/Environment

- [ ] Review PR #634 (`fix: respect CLAUDE_CONFIG_DIR for plugin paths (#626)` by @Kuroakira). Files: 14 files across paths, hooks, and services. Steps: (1) `gh pr checkout 634` (2) Review — should use `CLAUDE_CONFIG_DIR` env var instead of hardcoded `~/.claude/` path (3) Large changeset — verify it doesn't break default behavior when env var is not set (4) Run `npm run build` (5) If clean: `gh pr merge 634 --rebase --delete-branch`

- [ ] Review PR #712 (`Fix environment variables` by @cjpeterein). Files: SettingsDefaultsManager.ts + build artifacts + tests. Steps: (1) `gh pr checkout 712` (2) Review — what env var fix? Check the diff for specifics (3) Run `npm run build` (4) If clean and focused: `gh pr merge 712 --rebase --delete-branch`

- [ ] Review PR #524 (`fix: add minimum bun version check to smart-install.js` by @quicktime). File: `plugin/scripts/smart-install.js`. Steps: (1) `gh pr checkout 524` (2) Review version check logic — what minimum version? Is it still relevant? (3) If clean: `gh pr merge 524 --rebase --delete-branch`

- [ ] Review PR #771 (`fix: handle stdin unavailability and timeout to prevent hook hangs` by @rajivsinclair). File: `src/cli/stdin-reader.ts`. Steps: (1) `gh pr checkout 771` (2) Review — stdin may not be available in all environments (CI, some Windows configs) (3) Should add timeout and graceful fallback (4) Run `npm run build` (5) If clean: `gh pr merge 771 --rebase --delete-branch`

## Cursor Integration

- [ ] Review PR #721 (`fix(cursor): use bun runtime and fix hooks directory detection` by @polux0). Files: 5 cursor-related files. Steps: (1) `gh pr checkout 721` (2) Review Cursor hook changes — should use bun-runner.js pattern (consistent with v9.0.17) (3) Run `npm run build` (4) If compatible with current architecture: `gh pr merge 721 --rebase --delete-branch`

## Database

- [ ] Review PR #889 (`fix(db): prevent FK constraint failures on worker restart` by @Et9797). File: `src/services/sqlite/...` (FK constraints). Steps: (1) `gh pr checkout 889` (2) Review — FK constraint failures on restart suggest orphaned references. Should the fix be proper cleanup or deferred FK checks? (3) Run `npm run build` (4) If clean: `gh pr merge 889 --rebase --delete-branch`

- [ ] Review PR #833 (`fix: add PRAGMA foreign_keys to cleanup-duplicates.ts` by @Glucksberg). Steps: (1) `gh pr checkout 833` (2) Check if the cleanup script context still exists and if PRAGMA foreign_keys is needed there (3) v8.5.6 fixed FK constraints — this may be stale. If so: `gh pr close 833 --comment "FK constraint issues were addressed in v8.5.6. If a specific scenario remains, please describe and reopen. Thank you!"`

## Session Complete Hook

- [ ] Review PR #844 (`fix: add session-complete handler and hook to enable orphan reaper cleanup` by @thusdigital). Steps: (1) `gh pr checkout 844` (2) Review — does the orphan reaper need a session-complete signal to work? Check if the 5-min reaper interval is sufficient without it. (3) If the hook adds meaningful cleanup triggers: `gh pr merge 844 --rebase --delete-branch`. If reaper already handles this: close.
