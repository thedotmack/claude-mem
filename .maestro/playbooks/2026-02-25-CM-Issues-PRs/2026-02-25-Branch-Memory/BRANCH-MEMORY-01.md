# Phase 01: Schema, Types, Branch Detection, and Write Path

This phase establishes the foundation for branch memory by adding database columns, creating a branch detection utility, and threading branch metadata through the entire observation pipeline — from the hook layer through the worker to the database. By the end, every new observation will be stored with its git branch name and commit SHA. This is the critical foundation that all subsequent phases build on.

## Tasks

- [x] Add schema migration and update observation types:
  - In `src/services/sqlite/migrations/runner.ts`, add a new private method `addObservationBranchColumns()` as migration 24 following the exact pattern of `addSessionCustomTitleColumn()` (migration 23): check `schema_versions` for version 24, use `PRAGMA table_info(observations)` to guard each column, `ALTER TABLE observations ADD COLUMN branch TEXT`, `ALTER TABLE observations ADD COLUMN commit_sha TEXT`, insert version 24 into `schema_versions`
  - Add `this.addObservationBranchColumns();` as the last call in `runAllMigrations()`
  - In `src/services/sqlite/observations/types.ts`, add `branch?: string` and `commit_sha?: string` to `ObservationInput`
  - In the same file, add `branch?: string | string[]` and `commit_sha?: string | string[]` to `GetObservationsByIdsOptions` (array support enables ancestry-based IN clause filtering later)
  - In the same file, add `branch?: string | null` and `commit_sha?: string | null` to `AllRecentObservationRow`

- [x] Create git branch detection utility:
  - Create new file `src/services/integrations/git-branch.ts`
  - Export an interface `BranchInfo { branch: string | null; commitSha: string | null; }`
  - Export `async function detectCurrentBranch(cwd: string): Promise<BranchInfo>`
  - Use `Bun.spawn` (check existing codebase for spawn patterns first — search for `Bun.spawn` or `child_process` usage to match the project's convention) to run `git rev-parse --abbrev-ref HEAD` for branch name and `git rev-parse HEAD` for commit SHA, both with `{ cwd }` option
  - **Critical**: Wrap the entire function in try/catch — return `{ branch: null, commitSha: null }` on any failure (no git repo, git not installed, etc.). This function runs inside hooks where stderr is suppressed and errors must never crash the process
  - Handle detached HEAD: when `git rev-parse --abbrev-ref HEAD` returns `"HEAD"`, set branch to `null` but still capture the commit SHA
  - Trim whitespace from command output (stdout often has trailing newline)

- [x] Thread branch metadata through hook layer to worker POST body:
  - Find the `NormalizedHookInput` type definition (search for `interface NormalizedHookInput` across the codebase) and add optional `branch?: string` and `commitSha?: string` fields
  - In `src/cli/hook-command.ts`, after the `input.platform = platform;` line, add branch detection: import `detectCurrentBranch` from the new utility, call it with `input.cwd` (only if `input.cwd` is truthy), assign results to `input.branch` and `input.commitSha`
  - In `src/cli/handlers/observation.ts`, add `branch: input.branch ?? null` and `commit_sha: input.commitSha ?? null` to the JSON body of the `fetch()` POST to `/api/sessions/observations` (the body currently contains `contentSessionId`, `tool_name`, `tool_input`, `tool_response`, `cwd`)

- [x] Thread branch metadata through worker internals to database storage:
  - In `src/services/worker/http/routes/SessionRoutes.ts`, in the `handleObservationsByClaudeId` method, extract `branch` and `commit_sha` from `req.body`. Pass them through to `sessionManager.queueObservation()` — add them to whatever data object is passed as the second argument
  - Trace the full flow from `sessionManager.queueObservation` through to where `storeObservation()` is actually called. Read each file in the chain (`SessionManager.ts` → likely `SDKAgent.ts` or an observation processor). Add `branch` and `commit_sha` to each intermediate data structure/interface so they reach the store call. Branch and commit_sha are **metadata** — they should be passed alongside the observation content, not into the SDK agent's prompt
  - In `src/services/sqlite/observations/store.ts`:
    - Add `branch?: string` and `commitSha?: string` parameters to `storeObservation()` after the `discoveryTokens` parameter
    - Expand the INSERT column list from 15 to 17 by adding `branch, commit_sha` after `created_at_epoch`
    - Add `branch ?? null` and `commitSha ?? null` to the VALUES bind array (add two more `?` placeholders too)
    - Ensure the placeholder count in `VALUES (?, ?, ...)` matches the column count
  - In the same file, update `computeObservationContentHash()`: change the hash input from `(memorySessionId || '') + (title || '') + (narrative || '')` to `(memorySessionId || '') + (branch || '') + (title || '') + (narrative || '')` — this prevents cross-branch deduplication where identical observations on different branches would be silently dropped within the 30-second dedup window

- [x] Build the project and verify the migration works:
  - Run `npm run build-and-sync` to compile all TypeScript and sync the plugin
  - Fix any TypeScript compilation errors that arise from the changes
  - After successful build, verify the migration runs by checking the database: run `sqlite3 ~/.claude-mem/claude-mem.db "PRAGMA table_info(observations);"` and confirm `branch` and `commit_sha` columns appear
  - Verify no regressions by checking the worker starts successfully
