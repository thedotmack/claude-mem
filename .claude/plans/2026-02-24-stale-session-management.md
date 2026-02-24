# Implementation Plan: Stale Session Management

## Overview

Add a status bar indicator in the viewer UI header showing active session count, with a dropdown to view and close stale sessions. Sessions become "stale" when Claude Code exits abnormally and the `SessionEnd` hook never fires, leaving them stuck in `active` status. This feature gives users visibility and control over orphaned sessions directly from the viewer.

## Requirements

- **R1**: API endpoint `GET /api/sessions/active` returns active sessions with metadata (id, project, started_at, duration, is_stale flag)
- **R2**: API endpoint `POST /api/sessions/:id/close` marks a single session as completed
- **R3**: API endpoint `POST /api/sessions/close-stale` batch-closes all stale sessions
- **R4**: React component: status bar badge in header showing active session count with warning when stale sessions exist
- **R5**: React component: dropdown panel listing active sessions with individual close buttons and "Close All Stale" action
- **R6**: Stale detection threshold: session active for >1 hour (hardcoded constant, not user-configurable for v1)
- **R7**: No "current session" awareness in the viewer -- all active sessions shown equally

## Delivery Strategy

current-branch (work directly on `main`)

## Architecture Changes

- **New file**: `/home/doublefx/projects/claude-mem/src/services/sqlite/sessions/active.ts` -- DB query functions for active sessions
- **Modified file**: `/home/doublefx/projects/claude-mem/src/services/sqlite/SessionStore.ts` -- expose active session queries and close operations
- **New file**: `/home/doublefx/projects/claude-mem/src/services/worker/http/routes/ActiveSessionRoutes.ts` -- 3 new API endpoints
- **Modified file**: `/home/doublefx/projects/claude-mem/src/services/worker-service.ts` -- register ActiveSessionRoutes
- **New file**: `/home/doublefx/projects/claude-mem/src/ui/viewer/constants/sessions.ts` -- stale threshold constant
- **New file**: `/home/doublefx/projects/claude-mem/src/ui/viewer/hooks/useActiveSessions.ts` -- React hook for fetching/managing active sessions
- **New file**: `/home/doublefx/projects/claude-mem/src/ui/viewer/components/ActiveSessionsBadge.tsx` -- badge + dropdown component
- **Modified file**: `/home/doublefx/projects/claude-mem/src/ui/viewer/components/Header.tsx` -- integrate ActiveSessionsBadge
- **Modified file**: `/home/doublefx/projects/claude-mem/src/ui/viewer/constants/api.ts` -- add active session endpoint constants
- **Modified file**: `/home/doublefx/projects/claude-mem/src/ui/viewer/utils/formatters.ts` -- add relative time formatter
- **Modified file**: `/home/doublefx/projects/claude-mem/src/ui/viewer-template.html` -- CSS for badge and dropdown

## Implementation Steps

### Phase 1: Database Layer

1. **Add active session query functions** (File: `/home/doublefx/projects/claude-mem/src/services/sqlite/sessions/active.ts`)
   - Action: Create a new module with two pure functions following the existing `sessions/get.ts` pattern (database-first parameter pattern):
     - `getActiveSessions(db: Database): ActiveSessionRow[]` -- queries `sdk_sessions WHERE status = 'active'`, returns id, content_session_id, project, user_prompt, started_at_epoch
     - `closeSessionById(db: Database, sessionDbId: number): boolean` -- sets `status = 'completed'`, `completed_at`, `completed_at_epoch`, clears `subprocess_pid`. Returns true if a row was updated.
     - `closeStaleSessionsOlderThan(db: Database, thresholdMs: number): number` -- batch-closes all active sessions older than `Date.now() - thresholdMs`. Returns count of closed sessions.
   - Define `ActiveSessionRow` interface: `{ id: number; content_session_id: string; project: string; user_prompt: string | null; started_at_epoch: number }`
   - Why: Keeps DB queries in the established `sessions/` sub-module pattern, separate from business logic
   - Dependencies: None
   - Risk: Low -- pure SQL queries against existing schema, no migrations needed

2. **Expose active session methods on SessionStore** (File: `/home/doublefx/projects/claude-mem/src/services/sqlite/SessionStore.ts`)
   - Action: Add three thin wrapper methods that delegate to the functions in `sessions/active.ts`:
     - `getActiveSessions(): ActiveSessionRow[]`
     - `closeSessionById(sessionDbId: number): boolean`
     - `closeStaleSessionsOlderThan(thresholdMs: number): number`
   - Import `ActiveSessionRow` type and re-export it from the module
   - Why: SessionStore is the public API surface that route handlers consume via `DatabaseManager.getSessionStore()`
   - Dependencies: Step 1
   - Risk: Low

### Phase 2: API Layer

3. **Add API endpoint constants** (File: `/home/doublefx/projects/claude-mem/src/ui/viewer/constants/api.ts`)
   - Action: Add three new entries to `API_ENDPOINTS`:
     ```typescript
     ACTIVE_SESSIONS: '/api/sessions/active',
     CLOSE_SESSION: '/api/sessions',        // POST /api/sessions/:id/close
     CLOSE_STALE_SESSIONS: '/api/sessions/close-stale',
     ```
   - Why: Centralized endpoint constants avoid magic strings
   - Dependencies: None
   - Risk: Low

4. **Create ActiveSessionRoutes** (File: `/home/doublefx/projects/claude-mem/src/services/worker/http/routes/ActiveSessionRoutes.ts`)
   - Action: Create a new route handler class extending `BaseRouteHandler`, following the `DataRoutes.ts` pattern:
     ```typescript
     export class ActiveSessionRoutes extends BaseRouteHandler {
       constructor(private dbManager: DatabaseManager) { super(); }
       
       setupRoutes(app: express.Application): void {
         app.get('/api/sessions/active', this.handleGetActiveSessions.bind(this));
         app.post('/api/sessions/:id/close', this.handleCloseSession.bind(this));
         app.post('/api/sessions/close-stale', this.handleCloseStale.bind(this));
       }
     }
     ```
   - **`GET /api/sessions/active`**: Calls `store.getActiveSessions()`. For each session, compute `is_stale` flag (`Date.now() - started_at_epoch > STALE_THRESHOLD_MS`) and `duration_ms`. Return `{ sessions: ActiveSessionInfo[], staleCount: number, totalCount: number }`.
   - **`POST /api/sessions/:id/close`**: Parse int param `id`, call `store.closeSessionById(id)`. Return `{ success: boolean }`. Return 404 if session not found or not active.
   - **`POST /api/sessions/close-stale`**: Call `store.closeStaleSessionsOlderThan(STALE_THRESHOLD_MS)`. Return `{ closedCount: number }`.
   - Define `STALE_THRESHOLD_MS = 60 * 60 * 1000` (1 hour) as a module constant.
   - Response type for GET:
     ```typescript
     interface ActiveSessionResponse {
       sessions: Array<{
         id: number;
         project: string;
         user_prompt: string | null;
         started_at_epoch: number;
         duration_ms: number;
         is_stale: boolean;
       }>;
       staleCount: number;
       totalCount: number;
     }
     ```
   - Why: Dedicated route file per the README's "Adding New Endpoints" guidance. Keeps active session management isolated from the lifecycle routes in `SessionRoutes.ts`.
   - Dependencies: Steps 1-2
   - Risk: Low

5. **Register ActiveSessionRoutes in WorkerService** (File: `/home/doublefx/projects/claude-mem/src/services/worker-service.ts`)
   - Action: Import `ActiveSessionRoutes` and add `this.server.registerRoutes(new ActiveSessionRoutes(this.dbManager))` in the `registerRoutes()` method, alongside the other standard route registrations (line ~219-223 area).
   - Why: Routes must be registered to be reachable
   - Dependencies: Step 4
   - Risk: Low

### Phase 3: UI Layer

6. **Add relative time formatter** (File: `/home/doublefx/projects/claude-mem/src/ui/viewer/utils/formatters.ts`)
   - Action: Add a `formatRelativeTime(epochMs: number): string` function:
     ```typescript
     export function formatRelativeTime(epochMs: number): string {
       const diffMs = Date.now() - epochMs;
       const minutes = Math.floor(diffMs / 60_000);
       if (minutes < 1) return 'just now';
       if (minutes < 60) return `${minutes}m`;
       const hours = Math.floor(minutes / 60);
       if (hours < 24) return `${hours}h`;
       const days = Math.floor(hours / 24);
       return `${days}d`;
     }
     ```
   - Why: The mockup shows durations like "2m" and "18h". No existing formatter handles this format.
   - Dependencies: None
   - Risk: Low

7. **Add stale threshold constant** (File: `/home/doublefx/projects/claude-mem/src/ui/viewer/constants/sessions.ts`)
   - Action: Create constants file:
     ```typescript
     /** Sessions active longer than this are considered stale (1 hour) */
     export const STALE_THRESHOLD_MS = 60 * 60 * 1000;
     /** Polling interval for active sessions (30 seconds) */
     export const ACTIVE_SESSIONS_POLL_INTERVAL_MS = 30_000;
     ```
   - Why: Shared between hook and component; avoids magic numbers
   - Dependencies: None
   - Risk: Low

8. **Create useActiveSessions hook** (File: `/home/doublefx/projects/claude-mem/src/ui/viewer/hooks/useActiveSessions.ts`)
   - Action: Create a React hook following the existing hooks pattern (e.g., `useStats.ts`, `useAnalytics.ts`):
     ```typescript
     interface ActiveSession {
       id: number;
       project: string;
       user_prompt: string | null;
       started_at_epoch: number;
       duration_ms: number;
       is_stale: boolean;
     }
     
     interface UseActiveSessionsResult {
       sessions: ActiveSession[];
       staleCount: number;
       totalCount: number;
       isLoading: boolean;
       closeSession: (id: number) => Promise<void>;
       closeAllStale: () => Promise<void>;
       refresh: () => Promise<void>;
     }
     ```
   - Fetch from `API_ENDPOINTS.ACTIVE_SESSIONS` on mount and poll every 30 seconds using `setInterval`
   - `closeSession(id)`: POST to `/api/sessions/${id}/close`, then refresh
   - `closeAllStale()`: POST to `/api/sessions/close-stale`, then refresh
   - Use `AbortController` for cleanup on unmount (matching existing hook patterns)
   - Why: Encapsulates all active session state and operations for the badge component
   - Dependencies: Steps 3, 6, 7
   - Risk: Low

9. **Create ActiveSessionsBadge component** (File: `/home/doublefx/projects/claude-mem/src/ui/viewer/components/ActiveSessionsBadge.tsx`)
   - Action: Create component with badge + dropdown:
     ```typescript
     interface ActiveSessionsBadgeProps {
       sessions: ActiveSession[];
       staleCount: number;
       totalCount: number;
       onCloseSession: (id: number) => Promise<void>;
       onCloseAllStale: () => Promise<void>;
     }
     ```
   - Badge: Shows `Sessions: [N]` in the header status area. If `staleCount > 0`, show warning indicator (yellow/amber text). Badge is a `<button>` that toggles the dropdown.
   - Dropdown: Positioned absolutely below the badge (right-aligned). Lists all active sessions sorted by `started_at_epoch` desc. Each session shows:
     - Status indicator: `●` (green dot) for fresh, `⚠` (amber) for stale
     - Truncated project name (last path segment, max ~20 chars)
     - Relative duration from `formatRelativeTime(started_at_epoch)`
     - `[Close]` button (only for stale sessions, to avoid accidental closure of active work)
   - Footer: "Close All Stale" button (only shown when `staleCount > 0`)
   - Click outside closes dropdown (use `useEffect` with document click listener)
   - Why: Self-contained component with clear props interface
   - Dependencies: Steps 6, 8
   - Risk: Medium -- dropdown positioning and click-outside handling need care

10. **Integrate ActiveSessionsBadge into Header** (File: `/home/doublefx/projects/claude-mem/src/ui/viewer/components/Header.tsx`)
    - Action: Import and render `ActiveSessionsBadge` inside the `.status` div, between the `AnalyticsBar` and the `SearchBar`. Pass props from `useActiveSessions` hook.
    - The hook will be called in the parent component (`App.tsx` or wherever `Header` is rendered) and results passed down as props, OR the hook can be called directly inside `Header` since it is self-contained and does not share state with other components.
    - Decision: Call `useActiveSessions()` directly inside `Header.tsx` to keep the change minimal and avoid modifying `App.tsx`. The hook is fully self-contained.
    - Why: Minimal integration point -- just add the component to the existing header layout
    - Dependencies: Steps 8, 9
    - Risk: Low

### Phase 4: CSS Styling

11. **Add CSS for badge and dropdown** (File: `/home/doublefx/projects/claude-mem/src/ui/viewer-template.html`)
    - Action: Add CSS rules in the `<style>` section, near the existing `.status` styles:
    - **Badge styles** (`.active-sessions-badge`):
      - Inline-flex, aligned center, gap 4px
      - Background: subtle card background (`var(--color-bg-card)`)
      - Border: 1px solid `var(--color-border-primary)`, rounded 6px
      - Padding: 4px 10px, font-size 12px
      - Cursor: pointer, hover state with border highlight
      - Warning state (`.active-sessions-badge--warning`): amber/yellow text color
    - **Dropdown styles** (`.active-sessions-dropdown`):
      - Position: absolute, top: calc(100% + 4px), right: 0
      - Background: `var(--color-bg-card)`, border, rounded 8px, shadow
      - Min-width: 260px, max-height: 320px, overflow-y auto
      - Z-index: 100 (above other content)
    - **Session item styles** (`.active-sessions-item`):
      - Flex row, padding 8px 12px, border-bottom
      - Status dot (`.active-sessions-item__dot`): 8px circle, green or amber
      - Project name: truncated with ellipsis
      - Duration: muted text, right-aligned
      - Close button: small, subtle, red on hover
    - **Footer styles** (`.active-sessions-footer`):
      - Padding 8px 12px, border-top, text-align center
      - "Close All Stale" button: full-width, warning color
    - **Responsive**: Hide badge text on mobile, show only the count number
    - Why: Follows existing CSS patterns (inline in template, CSS variables for theming, consistent spacing)
    - Dependencies: Step 9
    - Risk: Low

## Testing Strategy

- **Unit tests** (files to create):
  - `/home/doublefx/projects/claude-mem/tests/services/sqlite/sessions/active.test.ts` -- test `getActiveSessions`, `closeSessionById`, `closeStaleSessionsOlderThan` with in-memory SQLite
  - `/home/doublefx/projects/claude-mem/tests/ui/viewer/utils/formatters.test.ts` -- test `formatRelativeTime` edge cases (0ms, 30s, 59m, 1h, 23h, 2d)
  - `/home/doublefx/projects/claude-mem/tests/ui/viewer/hooks/useActiveSessions.test.ts` -- test hook with mocked fetch (loading, polling, close actions)

- **Integration tests**:
  - `/home/doublefx/projects/claude-mem/tests/services/worker/routes/active-sessions.test.ts` -- test all 3 endpoints against a real in-memory DB via supertest (if the project uses supertest, otherwise via direct handler invocation)

- **Manual testing**:
  - Start worker, create sessions via API, verify badge shows correct count
  - Wait >1h (or temporarily lower threshold) to verify stale detection
  - Click Close on individual sessions, verify they disappear
  - Click "Close All Stale", verify batch operation

## Risks & Mitigations

- **Risk**: Polling every 30s creates unnecessary API calls when viewer is idle
  - Mitigation: The endpoint is a simple `SELECT` on an indexed column (`status`), so overhead is negligible. Could add `document.hidden` check to pause polling when tab is not visible (nice-to-have, not blocking).

- **Risk**: Race condition between "close" action and SSE session lifecycle events
  - Mitigation: The close endpoints are idempotent -- closing an already-completed session is a no-op (the `WHERE status = 'active'` guard prevents double-completion). Refresh after close ensures UI reflects latest state.

- **Risk**: Dropdown positioning on small screens
  - Mitigation: Use `right: 0` positioning anchored to the badge's parent. On mobile, the `.status` area already scrolls horizontally, so the dropdown will follow naturally. Add `max-width: calc(100vw - 32px)` as a safety bound.

- **Risk**: No "current session" concept means users might close an actively-running session
  - Mitigation: Only show `[Close]` button on stale sessions (>1h). Fresh active sessions show as informational only. The label "stale" provides clear visual distinction.

## Success Criteria

- [ ] `GET /api/sessions/active` returns active sessions with correct `is_stale` flags
- [ ] `POST /api/sessions/:id/close` successfully marks an active session as completed
- [ ] `POST /api/sessions/close-stale` batch-closes only stale sessions, returns correct count
- [ ] Badge appears in viewer header showing active session count
- [ ] Badge shows warning indicator (amber) when stale sessions exist
- [ ] Clicking badge opens dropdown listing all active sessions
- [ ] Stale sessions show `[Close]` button; fresh sessions do not
- [ ] "Close All Stale" button closes all stale sessions and refreshes the list
- [ ] Dropdown closes when clicking outside
- [ ] Badge auto-refreshes every 30 seconds
- [ ] All unit tests pass
- [ ] No regressions to existing session lifecycle (SessionRoutes still works correctly)
