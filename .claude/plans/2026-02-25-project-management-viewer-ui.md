# Implementation Plan: Project Management in Viewer UI

## Overview

Add rename, merge, and delete operations for projects directly in the viewer UI header. Replace the native `<select>` dropdown with a custom dropdown component where each project row has a kebab (`...`) menu for rename/merge/delete actions. Operations are multi-table SQL transactions with confirmation dialogs and success/error feedback.

## Requirements

- Replace native `<select>` with a custom dropdown component in the header
- Each project row gets a `...` (kebab/ellipsis) action menu with rename, merge, delete
- **Rename**: Change project name `A -> B` where B does not already exist. UPDATE across all tables in a transaction.
- **Merge**: Move all data from project `A` into existing project `B`. Same SQL as rename but target already exists.
- **Delete**: Purge ALL data for a project. DELETE across all tables in a transaction.
- Confirmation dialog for rename/merge showing affected row counts per table
- Type-to-confirm dialog for delete (user must type project name)
- Success/error feedback after operations
- All operations happen in a single SQLite transaction
- Settings modal project dropdown (queries `observations` via `/api/projects`) is NOT modified

## Delivery Strategy

current-branch (main)

## Architecture Changes

### Backend (New Route Handler)

- `src/services/worker/http/routes/ProjectRoutes.ts` -- New route handler for project management operations
- `src/services/sqlite/ProjectOperations.ts` -- Database operations module (rename, merge, delete with row counts)
- `src/services/worker-service.ts` -- Register new ProjectRoutes

### Frontend (Custom Dropdown + Hook + Dialogs)

- `src/ui/viewer/components/ProjectDropdown.tsx` -- Custom dropdown replacing native `<select>`, with kebab menus
- `src/ui/viewer/components/ProjectActionDialog.tsx` -- Confirmation/type-to-confirm dialog for all 3 operations
- `src/ui/viewer/hooks/useProjectActions.ts` -- Hook for API calls (rename, merge, delete, preview row counts)
- `src/ui/viewer/components/Header.tsx` -- Replace `<select>` with `<ProjectDropdown>`
- `src/ui/viewer/constants/api.ts` -- Add project management endpoint constants
- `src/ui/viewer-template.html` -- CSS for custom dropdown, kebab menu, dialogs

### Tests

- `tests/sqlite/project-operations.test.ts` -- Unit tests for database operations
- `tests/worker/routes/project-routes.test.ts` -- Route handler logic tests
- `tests/ui/components/ProjectDropdown.test.ts` -- Source inspection tests for dropdown
- `tests/ui/components/ProjectActionDialog.test.ts` -- Source inspection tests for dialog
- `tests/ui/hooks/useProjectActions.test.ts` -- Hook structure tests

## Database Tables with `project` Column

Verified from schema:

| Table | Has `project` column | Operations |
|-------|---------------------|------------|
| `sdk_sessions` | YES | UPDATE/DELETE |
| `observations` | YES | UPDATE/DELETE |
| `session_summaries` | YES | UPDATE/DELETE |
| `context_injections` | YES | UPDATE/DELETE |
| `user_prompts` | NO (has `content_session_id`) | CASCADE via sdk_sessions FK |
| `pending_messages` | NO (has `session_db_id`, `content_session_id`) | CASCADE via sdk_sessions FK |

Note: `user_prompts` and `pending_messages` have FK relationships to `sdk_sessions` with `ON DELETE CASCADE`, so deleting sdk_sessions rows will cascade. For rename/merge, these tables do not need direct updates since they reference sessions by ID, not by project name.

## Implementation Steps

### Phase 1: Database Operations Layer

1. **Create `ProjectOperations.ts`** (File: `src/services/sqlite/ProjectOperations.ts`)
   - Action: Create a standalone module with pure functions that take a `Database` instance
   - Functions:
     - `getProjectRowCounts(db, project)` -- Returns `{ sdk_sessions: number, observations: number, session_summaries: number, context_injections: number }` for preview dialog
     - `renameProject(db, oldName, newName)` -- Validates newName does not exist, then UPDATEs all 4 tables in a transaction. Returns row counts updated per table.
     - `mergeProject(db, sourceProject, targetProject)` -- Validates targetProject exists, then UPDATEs all 4 tables in a transaction. Returns row counts updated per table.
     - `deleteProject(db, project)` -- DELETEs from all 4 tables in a transaction. Returns row counts deleted per table. Note: `sdk_sessions` DELETE cascades to `user_prompts` and `pending_messages`.
   - Pattern: Pure functions taking `Database` as first argument (similar to `src/services/sqlite/sessions/active.ts`)
   - Why: Isolates testable database logic from HTTP layer
   - Dependencies: None
   - Risk: Low -- straightforward SQL operations

2. **Write database operation tests** (File: `tests/sqlite/project-operations.test.ts`)
   - Action: Test all 4 functions with in-memory SQLite database
   - Pattern: Follow `tests/worker/routes/active-session-routes.test.ts` pattern (ClaudeMemDatabase + in-memory store)
   - Test cases:
     - `getProjectRowCounts` returns correct counts for existing project
     - `getProjectRowCounts` returns zeros for non-existent project
     - `renameProject` updates all 4 tables
     - `renameProject` throws if target name already exists
     - `renameProject` throws if source project does not exist
     - `mergeProject` moves all data from source to target
     - `mergeProject` throws if target does not exist
     - `deleteProject` removes from all 4 tables
     - `deleteProject` cascades to user_prompts and pending_messages
     - All operations are atomic (transaction)
   - Dependencies: Step 1
   - Risk: Low

### Phase 2: API Route Handler

3. **Create `ProjectRoutes.ts`** (File: `src/services/worker/http/routes/ProjectRoutes.ts`)
   - Action: New route handler extending `BaseRouteHandler`
   - Constructor: Takes `DatabaseManager` (same as `ActiveSessionRoutes`)
   - Endpoints:
     - `GET /api/projects/:name/counts` -- Returns row counts per table for a project (for preview dialog)
     - `POST /api/projects/:name/rename` -- Body: `{ newName: string }`. Calls `renameProject`, returns updated counts.
     - `POST /api/projects/:name/merge` -- Body: `{ targetProject: string }`. Calls `mergeProject`, returns merged counts.
     - `DELETE /api/projects/:name` -- Calls `deleteProject`, returns deleted counts.
   - Validation: Project name URL-decoded, max length 500 chars, non-empty
   - Response shape: `{ success: boolean, counts: { sdk_sessions: number, observations: number, session_summaries: number, context_injections: number } }`
   - Error shape: `{ error: string }` with appropriate HTTP status codes (400, 404, 409)
   - Why: Clean separation of HTTP concerns from database logic
   - Dependencies: Step 1
   - Risk: Low

4. **Register routes in worker-service** (File: `src/services/worker-service.ts`)
   - Action: Import `ProjectRoutes` and register via `this.server.registerRoutes(new ProjectRoutes(this.dbManager))`
   - Place after `ActiveSessionRoutes` registration (line ~225)
   - Dependencies: Step 3
   - Risk: Low

5. **Write route handler tests** (File: `tests/worker/routes/project-routes.test.ts`)
   - Action: Test route handler logic following `active-session-routes.test.ts` pattern
   - Test cases:
     - Rename succeeds and returns counts
     - Rename fails with 409 if target exists
     - Merge succeeds and returns counts
     - Merge fails with 404 if target does not exist
     - Delete succeeds and returns counts
     - Delete fails with 404 if project does not exist
     - Get counts returns correct numbers
     - ProjectRoutes class can be imported and constructed
   - Dependencies: Steps 3, 4
   - Risk: Low

### Phase 3: Frontend API Constants and Hook

6. **Add API endpoint constants** (File: `src/ui/viewer/constants/api.ts`)
   - Action: Add `PROJECTS_BASE: '/api/projects'` to `API_ENDPOINTS`
   - Why: Centralized endpoint management
   - Dependencies: None
   - Risk: Low

7. **Create `useProjectActions` hook** (File: `src/ui/viewer/hooks/useProjectActions.ts`)
   - Action: Custom hook providing project management API calls
   - Pattern: Follow `useActiveSessions.ts` pattern (useState/useCallback/AbortController)
   - Interface:
     ```typescript
     interface ProjectRowCounts {
       sdk_sessions: number;
       observations: number;
       session_summaries: number;
       context_injections: number;
     }

     interface UseProjectActionsResult {
       getRowCounts: (project: string) => Promise<ProjectRowCounts>;
       renameProject: (project: string, newName: string) => Promise<ProjectRowCounts>;
       mergeProject: (source: string, target: string) => Promise<ProjectRowCounts>;
       deleteProject: (project: string) => Promise<ProjectRowCounts>;
       isLoading: boolean;
       error: string | null;
     }
     ```
   - Why: Separates API logic from UI components
   - Dependencies: Step 6
   - Risk: Low

8. **Write hook structure tests** (File: `tests/ui/hooks/useProjectActions.test.ts`)
   - Action: Source inspection tests following `tests/ui/hooks/useActiveSessions.test.ts` pattern
   - Test: Exports, function signatures, AbortController usage, error handling
   - Dependencies: Step 7
   - Risk: Low

### Phase 4: UI Components

9. **Create `ProjectActionDialog.tsx`** (File: `src/ui/viewer/components/ProjectActionDialog.tsx`)
   - Action: Modal dialog component for rename/merge/delete confirmations
   - Three modes based on `action` prop:
     - **rename**: Text input for new name + row counts preview + Confirm/Cancel buttons
     - **merge**: Dropdown to select target project + row counts preview + Confirm/Cancel buttons
     - **delete**: Row counts preview + type-to-confirm input (must match project name) + Delete/Cancel buttons
   - Props:
     ```typescript
     interface ProjectActionDialogProps {
       action: 'rename' | 'merge' | 'delete';
       project: string;
       projects: string[];  // For merge target selection
       rowCounts: ProjectRowCounts | null;
       isLoading: boolean;
       error: string | null;
       onConfirm: (params: { newName?: string; targetProject?: string }) => void;
       onCancel: () => void;
     }
     ```
   - Visual: Row counts shown as a table (table name | count). Delete dialog has red warning styling.
   - Why: Reusable dialog for all three operations
   - Dependencies: None (pure presentational)
   - Risk: Low

10. **Create `ProjectDropdown.tsx`** (File: `src/ui/viewer/components/ProjectDropdown.tsx`)
    - Action: Custom dropdown component replacing native `<select>`
    - Structure:
      - Trigger button showing current selection ("All Projects" or project name)
      - Dropdown panel (absolutely positioned) with:
        - "All Projects" option at top
        - Project rows, each with project name + `...` kebab button
        - Clicking project name selects it (calls `onFilterChange`)
        - Clicking `...` opens an inline action menu with Rename / Merge / Delete
    - State: `isOpen` (dropdown), `activeMenu` (which project's kebab is open), `dialogState` (which dialog is shown)
    - Integrates `useProjectActions` hook internally
    - Opens `ProjectActionDialog` when an action is selected from kebab menu
    - After successful operation: calls `onProjectsChanged()` callback to trigger SSE reconnect or project list refresh
    - Props:
      ```typescript
      interface ProjectDropdownProps {
        projects: string[];
        currentFilter: string;
        onFilterChange: (filter: string) => void;
        onProjectsChanged: () => void;  // Called after rename/merge/delete to refresh
      }
      ```
    - Keyboard: Escape closes dropdown, click outside closes dropdown
    - Why: Core UI component for the feature
    - Dependencies: Steps 7, 9
    - Risk: Medium -- custom dropdown requires careful positioning, click-outside handling, and keyboard management

11. **Write component tests** (Files: `tests/ui/components/ProjectDropdown.test.ts`, `tests/ui/components/ProjectActionDialog.test.ts`)
    - Action: Source inspection tests following `tests/ui/components/Header.test.ts` pattern
    - ProjectDropdown tests:
      - Exports ProjectDropdown function
      - Contains kebab menu (`...` or `\u22EE`)
      - Contains "All Projects" option
      - Has `aria-label` for accessibility
      - Does NOT use native `<select>`
      - Renders ProjectActionDialog
      - Has click-outside handler
    - ProjectActionDialog tests:
      - Exports ProjectActionDialog function
      - Has rename mode with text input
      - Has merge mode with project selector
      - Has delete mode with type-to-confirm
      - Shows row counts table
      - Has confirm and cancel buttons
    - Dependencies: Steps 9, 10
    - Risk: Low

### Phase 5: Integration

12. **Update Header component** (File: `src/ui/viewer/components/Header.tsx`)
    - Action:
      - Import `ProjectDropdown`
      - Replace native `<select>` block (lines 77-86) with `<ProjectDropdown>`
      - Add `onProjectsChanged` prop to `HeaderProps`
      - Pass through `projects`, `currentFilter`, `onFilterChange`, `onProjectsChanged`
    - Why: Wire the new component into the existing header
    - Dependencies: Step 10
    - Risk: Low

13. **Update App.tsx** (File: `src/ui/viewer/App.tsx`)
    - Action:
      - Add a `refreshProjects` callback that triggers project list refresh
      - Implementation approach: Add a `projectRefreshKey` state variable. When incremented, trigger a fetch to `/api/projects` (the same endpoint used by settings modal) or simply re-trigger SSE reconnect.
      - Simpler approach: Since `useSSE` provides `projects` from `initial_load`, add a `refreshProjects` function that fetches `/api/projects` and merges/replaces the SSE project list. This can be done by adding a `setProjects` export from `useSSE` or by adding a separate fetch.
      - Best approach: Add an `onProjectsChanged` callback in App.tsx that:
        1. Fetches fresh project list from a new lightweight endpoint or existing `/api/projects`
        2. Updates the `projects` state
        3. If the currently selected project was renamed/deleted, resets the filter to "All Projects"
      - Pass `onProjectsChanged` to `Header` and then to `ProjectDropdown`
    - Dependencies: Step 12
    - Risk: Low

14. **Update useSSE to expose setProjects** (File: `src/ui/viewer/hooks/useSSE.ts`)
    - Action: Add `setProjects` to the return object so App.tsx can update the project list after management operations
    - Single-line change: `return { observations, summaries, prompts, projects, setProjects, isProcessing, queueDepth, isConnected, initialActiveSession };`
    - Why: Allows project list refresh without SSE reconnect
    - Dependencies: None
    - Risk: Low

15. **Update Header test** (File: `tests/ui/components/Header.test.ts`)
    - Action:
      - Remove test "renders a `<select>` for project filtering" (this will be replaced by custom dropdown)
      - Add test "imports ProjectDropdown"
      - Add test "renders `<ProjectDropdown`"
      - Keep "renders All Projects option" -- but this will be in ProjectDropdown, so update to check ProjectDropdown source instead
      - Keep accessibility test but update to check ProjectDropdown
    - Dependencies: Steps 12, 13
    - Risk: Low

### Phase 6: CSS Styling

16. **Add CSS for custom dropdown and dialogs** (File: `src/ui/viewer-template.html`)
    - Action: Add CSS rules for:
      - `.project-dropdown` -- container with `position: relative`
      - `.project-dropdown__trigger` -- styled like the existing select (reuse `.status select` styles)
      - `.project-dropdown__menu` -- absolutely positioned panel (follow `.active-sessions-dropdown` pattern)
      - `.project-dropdown__item` -- row with project name + kebab button
      - `.project-dropdown__item--selected` -- highlight for currently selected project
      - `.project-dropdown__kebab` -- `...` button, subtle, shows on hover
      - `.project-dropdown__action-menu` -- small popup for rename/merge/delete (positioned next to kebab)
      - `.project-action-dialog` -- modal overlay
      - `.project-action-dialog__content` -- centered dialog box
      - `.project-action-dialog__counts` -- table showing row counts
      - `.project-action-dialog__danger` -- red styling for delete mode
      - `.project-action-dialog__confirm-input` -- type-to-confirm input
    - Responsive: Hide kebab on mobile (480px), keep dropdown functional
    - Theme: Use existing CSS variables (`--color-bg-card`, `--color-border-primary`, etc.)
    - Why: Consistent with existing UI patterns
    - Dependencies: None (can be done in parallel with component work)
    - Risk: Low

## Testing Strategy

### Unit Tests
- `tests/sqlite/project-operations.test.ts` -- Database CRUD operations with in-memory SQLite
- `tests/worker/routes/project-routes.test.ts` -- Route handler logic (no Express, direct function calls)

### Component Tests (Source Inspection)
- `tests/ui/components/ProjectDropdown.test.ts` -- Structure verification via source inspection
- `tests/ui/components/ProjectActionDialog.test.ts` -- Structure verification via source inspection
- `tests/ui/hooks/useProjectActions.test.ts` -- Hook export and structure verification
- `tests/ui/components/Header.test.ts` -- Updated to verify ProjectDropdown integration

### Integration Tests
- The existing `tests/integration/worker-api-endpoints.test.ts` can be extended if needed
- E2E testing via Playwright (out of scope for this plan, but the components are structured for it)

## Risks & Mitigations

- **Risk**: Custom dropdown click-outside handling can be tricky with portals and event bubbling
  - Mitigation: Use a simple `useEffect` with `document.addEventListener('mousedown', ...)` pattern, which is proven in the existing `ActiveSessionsBadge` component

- **Risk**: Race condition if SSE delivers a project_list update during a rename/merge/delete operation
  - Mitigation: After successful operation, immediately fetch fresh project list and overwrite SSE state. The SSE will eventually send an updated list on next connection.

- **Risk**: Delete cascade through FK may have unintended side effects on `user_prompts` and `pending_messages`
  - Mitigation: The preview counts dialog shows exactly what will be affected. Tests verify cascade behavior.

- **Risk**: Large projects with many rows could cause slow operations
  - Mitigation: SQLite transactions are atomic and efficient. The multi-table UPDATE/DELETE will be fast for typical project sizes. No risk of timeout for the viewer use case.

- **Risk**: Concurrent project operations from multiple browser tabs
  - Mitigation: SQLite WAL mode handles concurrent writes. Each operation is a single transaction. Last-write-wins is acceptable for this admin-level feature.

## Success Criteria

- [ ] Custom dropdown renders in place of native `<select>` in header
- [ ] Each project row shows a `...` kebab menu on hover
- [ ] Kebab menu offers Rename, Merge, Delete actions
- [ ] Rename dialog: text input + row counts preview + Confirm/Cancel
- [ ] Merge dialog: target project selector + row counts preview + Confirm/Cancel
- [ ] Delete dialog: row counts preview + type-to-confirm + Delete/Cancel
- [ ] All operations update all 4 tables (`sdk_sessions`, `observations`, `session_summaries`, `context_injections`) in a single transaction
- [ ] Project list refreshes after any operation
- [ ] If current filter was the renamed/deleted project, filter resets to "All Projects"
- [ ] Error feedback displayed in dialog on failure
- [ ] Settings modal project dropdown is NOT affected
- [ ] All tests pass
- [ ] No TypeScript strict mode violations
