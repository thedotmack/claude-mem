# Phase 01: PR Review, Merge & Duplicate Closure

This phase tackles the 22+ open issues that already have corresponding PRs ready for review. By merging these PRs and closing duplicate issues, we eliminate the largest batch of open work in a single pass. This is the highest-ROI phase — every merge here closes 1-3 issues with code that's already written and waiting.

## Duplicate Issues to Close

Before merging PRs, close these duplicate issue pairs with cross-reference comments so the issue tracker is clean.

## Tasks

- [x] Close duplicate issues with cross-reference comments using `gh issue close`. For each pair below, close the SECOND issue with a comment linking to the first (which has the tracking PR):
  - Close #1250 as duplicate of #1248 — both are chroma-mcp CPU runaway on Apple Silicon. Comment: `Closing as duplicate of #1248 (identical root cause: HNSW index reconstruction). Will be addressed together.`
  - Close #1235 as duplicate of #1234 — both are stop hook crashes in git worktrees. Comment: `Closing as duplicate of #1234. Both addressed by PR #1326.`
  - Close #1290 as duplicate of #1288 — both are stop hook output format issues. Comment: `Closing as duplicate of #1288. Both addressed by PR #1291.`
  - Close #1317 as duplicate of #1256 — both are basename(cwd) project detection fragmentation. Comment: `Closing as duplicate of #1256. PR #1298 addresses the root cause (git root detection).`
  - Close #1232 as duplicate of #1261 — both are Chroma connection/setup failures. Comment: `Closing as duplicate of #1261. Both are Chroma connection failures on different platforms.`
  - Close #1296 as duplicate of #1226 — both are orphaned/zombie process accumulation. Comment: `Closing as duplicate of #1226. PR #1325 addresses zombie subprocess accumulation.`

- [x] Review and merge critical bug fix PRs — Batch 1 (data correctness). For each PR: read the diff with `gh pr diff <number>`, check for obvious issues, then merge with `gh pr merge <number> --squash --delete-branch`. If merge fails due to conflicts, skip and document:
  - PR #1345 fixes #1312 — prevents LLM from using `<observation>` tags in summary responses (summary parser fallback) ✅ MERGED
  - PR #1344 fixes #1303 — respects env vars and settings.json for DATA_DIR resolution (paths override) ✅ MERGED
  - PR #1343 fixes #1324 — respects dateStart/dateEnd filters in Chroma search path ✅ MERGED
  - PR #1337 fixes #1253 — smart-install.js outputs valid JSON for hook contract ✅ MERGED
  - PR #1336 fixes #1294 — null guard getChromaSync() when Chroma disabled ✅ MERGED

- [x] Review and merge lifecycle and hook fix PRs — Batch 2. Same process: `gh pr diff`, review, `gh pr merge --squash --delete-branch`. Skip and document any that fail:
  - PR #1330 fixes #1314 — moves session-complete from Stop to SessionEnd hook (prevents SDK agent kill during summary) ✅ MERGED
  - PR #1325 fixes #1226 — prevents zombie subprocess accumulation (also closes #1296) ✅ MERGED
  - PR #1291 fixes #1288 + #1290 — removes unrecognized fields from Stop hook output (fixes JSON validation and infinite loop) ✅ MERGED
  - PR #1326 fixes #1234 + #1235 — gracefully handles missing transcript files in worktree sessions ✅ MERGED
  - PR #1264 — older worktree transcript fix. #1326 supersedes this entirely (includes same graceful handling plus worktree path resolution). ✅ CLOSED as superseded

- [x] Review and merge data integrity and infrastructure PRs — Batch 3. Same review-then-merge process:
  - PR #1315 fixes #1313 — includes SSE live data when project filter is active ✅ MERGED
  - PR #1308 fixes #1307 — auto-repairs malformed database schema from cross-version sync ✅ MERGED
  - PR #1302 fixes #1260 — adds content-hash dedup to batch observation store methods ✅ MERGED
  - PR #1301 fixes #1242 + #1289 — hardens hook fallback and MCP node resolution ⚠️ SKIPPED (merge conflict after Batch 3 merges, needs rebase)

- [x] Review and merge standalone fix PRs — Batch 4. These PRs address open issues indirectly or fix standalone bugs:
  - PR #1341 — merges SessionStart hooks to run sequentially (addresses #1346 port collision on concurrent sessions) ✅ MERGED
  - PR #1334 — prevents infinite restart loop on FK constraint errors ✅ MERGED
  - PR #1306 — handles missing session_id when Cursor runs claude-code hooks ⚠️ SKIPPED (merge conflict after Batch 4 merges, needs rebase)
  - PR #1286 — always passes --ssl flag to chroma-mcp in remote mode ✅ MERGED

- [x] Review feature PRs — Batch 5. These are feature additions that close open feature requests. Review more carefully for scope and quality:
  - PR #1321 fixes #1320 — per-project disable/exclude functionality ⚠️ SKIPPED (merge conflict after prior batch merges, needs rebase). Code review: APPROVED — well-scoped, clean implementation with `.claude-mem-disable` touch file + settings-based exclusion, early exits in all 4 hook handlers, CLI commands, tests included.
  - PR #1319 fixes #1318 — workspace-based memory isolation ⚠️ NEEDS REWORK — Code review identified critical issues: (1) Dead code: all 7 files are new but NO existing files modified — handler not wired into hooks.json, WorkspaceDatabaseManager not used by worker-service.ts, feature does nothing at runtime. (2) DRY violation: session-init-workspace.ts is a near-copy of session-init.ts. (3) Dual path system: paths-workspace.ts duplicates exports from paths.ts with @deprecated tags. Recommendation: integrate workspace support into existing handlers/services rather than creating parallel code paths.
  - For each: read the full diff, check that the feature is well-scoped and doesn't introduce unnecessary complexity, then merge with `gh pr merge --squash --delete-branch`

- [x] Run full test suite and build verification after all merges:
  - Pull latest main: `git checkout main && git pull`
  - Run `npm test` — all tests must pass
  - Run `npm run build-and-sync` — build must succeed
  - If any tests fail, document which tests broke and which PR likely caused the regression. Do NOT revert — just document in the triage report
  - ✅ VERIFIED: 1135 tests passed, 3 skipped, 0 failures across 66 test files (19.48s). Build succeeded — all artifacts generated (worker-service.cjs, mcp-server.cjs, context-generator.cjs, smart-install.js, viewer.html, viewer-bundle.js). Synced to marketplace.

- [x] Create triage report at `/Users/alexnewman/Scripts/claude-mem/Auto Run Docs/2026-03-12-CM-Issues-PRs/2026-03-12-Issues-PRs-Triage/Working/phase-01-triage-report.md`:
  - Use YAML front matter: `type: report`, `title: Phase 01 PR Triage Report`, `created: 2026-03-12`, `tags: [triage, pr-merge, issues]`
  - List every PR reviewed with its status: merged, skipped (conflict), skipped (quality concern), or needs-manual-review
  - List every issue closed (both duplicates and issues resolved by merged PRs)
  - List any test failures with probable cause
  - List remaining open issues that still need code fixes (these feed into Phases 02-10)
  - List remaining open PRs that were NOT part of this phase (stale PRs, feature PRs, etc.)
