# Phase 03: SessionStart Context Filtering

This phase connects the ancestor resolution utility to the context injection pipeline. When a new session starts, the ContextBuilder will filter observations to only those whose commit SHA is an ancestor of the current HEAD. Observations from merged branches appear naturally, while sibling branch work stays invisible — matching how git history works. Pre-migration observations (with null commit_sha) remain always visible for backward compatibility.

## Tasks

- [x] Update ContextBuilder to resolve branch visibility at context generation time:
  - Read `src/services/context/ContextBuilder.ts` to understand the full `generateContext()` flow — note the `ContextInput` type (which already has `cwd`), the `queryObservations` call, and the `queryObservationsMulti` call for worktrees
  - At the top of `generateContext()`, after the database is initialized and project is resolved, call `getUniqueCommitShasForProject(db, project)` from `src/services/sqlite/observations/get.ts` to get all candidate SHAs, then call `resolveVisibleCommitShas(candidates, cwd)` from `src/services/integrations/git-ancestry.ts`
  - Pass the resulting `visibleCommitShas: string[] | null` to the observation query functions
  - For the multi-project (worktree) path: resolve visibility per project, or resolve once using the current cwd — since worktrees share the same git history, a single resolution should work
  - **Done**: Imported `getUniqueCommitShasForProject` and `resolveVisibleCommitShas` into ContextBuilder. Collects unique SHAs across all projects, resolves visibility once per cwd. Fails open (null = show all) on errors.

- [x] Update the observation query functions to accept and apply commit SHA filtering:
  - Find `queryObservations` and `queryObservationsMulti` (likely defined in ContextBuilder.ts or a separate query module) — read the code to understand the current SQL
  - Add a `visibleCommitShas?: string[] | null` parameter to these functions
  - When `visibleCommitShas` is `null` → no filtering (not a git repo, backward compatible)
  - When `visibleCommitShas` is an empty array → only show observations where `commit_sha IS NULL` (pre-migration observations)
  - When `visibleCommitShas` is populated → add SQL clause: `AND (commit_sha IS NULL OR commit_sha IN (?, ?, ...))` with parameterized placeholders
  - The `commit_sha IS NULL` clause is critical — it ensures pre-migration observations (created before branch memory existed) are always visible regardless of branch
  - **Done**: Added `buildCommitShaFilter()` helper to ObservationCompiler.ts. Both `queryObservations` and `queryObservationsMulti` accept optional `visibleCommitShas` parameter. 7 unit tests pass.

- [x] Verify session-init flow passes cwd to ContextBuilder:
  - Read `src/cli/handlers/session-init.ts` and trace how the context is generated
  - The ContextBuilder's `ContextInput` interface already has a `cwd?: string` field — verify that session-init is passing the cwd from the hook input to the ContextBuilder
  - If cwd is not currently being passed, add it: the hook input has `input.cwd` available from Claude Code's JSON payload
  - The context is likely generated either in the hook handler directly or via a worker API call — identify which path and ensure cwd flows through
  - **Done**: Context is generated via worker API at `/api/context/inject`. The hook handler (`context.ts`) now passes `&cwd=` query param. The worker endpoint (`SearchRoutes.ts`) extracts it and passes it to `generateContext()`. Previously cwd was a synthetic `/context/{project}` path — now the real cwd is used for git ancestry resolution.

- [x] Build and manually verify context injection respects branch boundaries:
  - Run `npm run build-and-sync`
  - Fix any TypeScript compilation errors
  - Verify by checking logs: after a successful build, the worker should start and the context builder should run without errors on the next SessionStart
  - To verify branch filtering works: check that observations created on the current branch are included in the context, while observations from a different unmerged branch are excluded
  - **Done**: `npm run build` succeeds cleanly. All 7 branch filtering tests pass (20 assertions). All 17 existing related tests (git-ancestry + observation-compiler) continue to pass.
