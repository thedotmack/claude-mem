# Phase 02: Viewer UI Branch Metadata Display

The React viewer at `http://localhost:37777` displays observation cards with type, project, title, subtitle, facts, narrative, and metadata — but no branch information. The database already stores `branch` and `commit_sha` on every observation (migrations 24-25), and the PaginationHelper query that feeds the viewer intentionally omits these columns. This phase adds branch visibility to observation cards so users can see which git branch produced each observation, completing the visual layer of branch-memory.

## Tasks

- [x] Add `branch` and `commit_sha` to the viewer's TypeScript type system:
  - In `src/ui/viewer/types.ts`: Add `branch?: string | null` and `commit_sha?: string | null` to the `Observation` interface (currently has 15 fields ending with `created_at_epoch` at line ~16)
  - These fields are optional to maintain backward compatibility with observations that predate the branch-memory feature

- [x] Update `PaginationHelper.getObservations()` in `src/services/worker/PaginationHelper.ts` to include branch metadata:
  - At line ~77, the SELECT column list is hardcoded: `'id, memory_session_id, project, type, title, subtitle, narrative, text, facts, concepts, files_read, files_modified, prompt_number, created_at, created_at_epoch'`
  - Append `, branch, commit_sha` to this string
  - This is the only change needed — the result is typed generically via `paginate<Observation>()` and the Observation type update from the previous task handles the rest
  - **Done**: Also added `branch` and `commit_sha` to the `Observation` interface in `src/services/worker-types.ts` which PaginationHelper imports from

- [x] Update `ObservationCard.tsx` in `src/ui/viewer/components/ObservationCard.tsx` to display branch metadata:
  - Add a branch badge in the card header, next to the existing project badge (line ~55 area, inside `card-header-left` div)
  - Only render the badge when `observation.branch` is truthy (many pre-migration observations will have null branch)
  - Use a git-branch icon (simple SVG fork icon) followed by the branch name, styled similarly to the existing `card-project` span
  - Optionally show abbreviated commit_sha (first 7 chars) as a secondary detail next to or below the branch name
  - Style the branch badge with a distinct color from the project badge — suggest using `var(--color-text-muted)` with a subtle background
  - Add CSS for the new `.card-branch` class:
    - Font size matching `card-project` (~11px)
    - Subtle background color (e.g., `var(--color-surface-hover)`)
    - Rounded corners matching existing badges
    - Monospace font for the commit SHA portion

- [x] Build the viewer and verify the changes render correctly:
  - Check how the viewer is built — look for build scripts in `package.json` (likely `build-viewer` or part of `build-and-sync`)
  - Run the appropriate build command
  - The built output goes to `plugin/ui/viewer.html` (single-file HTML with embedded CSS/JS)
  - Verify the build completes without errors

- [x] Run tests and verify the full build:
  - Run `npm test` to ensure no regressions
  - Run `npm run build-and-sync` for full production build
  - Fix any TypeScript compilation errors or test failures
