# Session ID display, filter, and delete — Design

Date: 2026-07-30
Status: Approved for planning

## Problem

The claude-mem viewer (`src/ui/viewer/`) shows observation/summary/prompt cards with a
badge row (type | source | project) and a project filter dropdown, but has no way to see
or act on which Claude Code session produced a given card. The session ID is already
fetched into every card's data (`Observation.memory_session_id`, `Summary.session_id`,
`UserPrompt.content_session_id`) but never displayed. There is also no way to delete all
content belonging to one session (e.g. a throwaway/experimental session cluttering the
feed).

## Goals

1. Show the full session ID on every card, in the existing badge header row.
2. Add a session filter dropdown, alongside the existing project filter dropdown,
   behaving the same way (single-select, narrows the visible list; AND'd with the
   project filter when both are set).
3. Add a way to delete all content (observations, summaries, prompts) belonging to a
   selected session, including the session's own `sdk_sessions` row.

## Non-goals

- Real "grouped" views with section headers (per-project or per-session) — the existing
  project control is a filter, not a grouping view, and the session control follows the
  same pattern.
- A custom dropdown widget with inline per-row delete controls — the session filter stays
  a native `<select>`, matching the project filter.
- Multi-session (batch) delete.

## Design

### 1. Card display

`ObservationCard.tsx`, `SummaryCard.tsx`, and `PromptCard.tsx` each add a new badge to
the existing header row (after type/source/project): the full session ID
(`memory_session_id` / `session_id` / `content_session_id` respectively), rendered in a
new `card-session-id` CSS class — visually smaller/muted than the existing badges — with
a `title` attribute carrying the same full ID (for consistency with the dropdown's
hover-for-full-ID behavior, even though the card already shows it in full).

No backend field changes are required for card display — these fields are already
present on every fetched row.

### 2. Session catalog (backend)

- `SessionStore.getAllSessions(platformSource?)` — mirrors `getProjectCatalog()`.
  Queries `sdk_sessions` for `id, memory_session_id, project, platform_source,
  started_at_epoch`, excluding the internal observer project and empty projects (same
  filter as `getAllProjects`), ordered by `started_at_epoch DESC`.
- `GET /api/sessions` route in `DataRoutes.ts`, for parity with `GET /api/projects`
  (not consumed directly by the viewer, which uses the SSE stream instead — see below —
  but kept consistent with the existing project catalog's REST + SSE dual exposure).
- `ViewerRoutes.ts`'s `initial_load` SSE payload gains a `sessions` array: `{ id,
  project, platform_source, started_at_epoch }` per session, sourced from
  `getAllSessions()`.
- Wherever `new_observation` / `new_summary` / `new_prompt` SSE events are broadcast,
  the broadcaster also ensures the owning session is included in the live session list
  (mirrors `addProjectIfNew` — the first time a session is seen, it's added).

### 3. Frontend session list & filter

- `useSSE.ts` gains `sessions` state (array of session records) and an
  `addSessionIfNew` helper, populated from the `initial_load` event and appended to as
  `new_observation`/`new_summary`/`new_prompt` events arrive — this exactly mirrors the
  existing `projects` / `addProjectIfNew` pattern.
- `Header.tsx` gets a second native `<select>` next to the project filter dropdown.
  Each session's `sdk_sessions.id` (numeric) is the option *value* (used for filtering
  and passed to the delete endpoint). The option *label* is the first 8 characters of
  that session's `memory_session_id` (the canonical UUID-style identifier, also what
  observation cards display — the most common card type), with the full
  `memory_session_id` in the option's `title` attribute for hover. ("All Sessions" is
  the empty-value default option, matching "All Projects".)
  Note: `session_summaries`/`user_prompts` rows display `session_id`/
  `content_session_id` on their cards respectively (different string values than
  `memory_session_id` for the same underlying session, per the `sdk_sessions` schema —
  see "Known limitation" below), but the dropdown itself only needs one canonical label
  per session, so it standardizes on `memory_session_id`.
- `App.tsx` adds `currentSessionFilter` state. `matchesSelection` is extended to AND
  both the project and session filters (each optional — an empty filter matches
  everything).
- A delete (trash icon) button sits next to the session dropdown. It is disabled when no
  session is selected (`currentSessionFilter === ''`). Clicking it opens a native
  `confirm()` dialog naming the session and warning the action is irreversible. On
  confirm, it calls the new delete endpoint (below); on success, the deleted session is
  removed from local `sessions` state and the session filter resets to "All Sessions".

### 4. Bulk delete endpoint (backend)

`DELETE /api/session/:id` in `DataRoutes.ts`, where `:id` is the numeric
`sdk_sessions.id` (matching the existing `GET /api/session/:id` convention — not the
UUID `memory_session_id`/`content_session_id`).

The existing single-row delete path (`deleteSyncedContent` in `DataRoutes.ts`) tombstones
one row via `cloudSync.queueDelete(kind, originLocalId)` when cloud sync is configured,
or refuses (503) if an already-synced row exists without cloud sync configured (to avoid
stranding replicas). This per-row safety logic is extracted into a shared helper so both
the single-row and the new bulk-by-session path use identical logic.

The new endpoint, in a single DB transaction:

1. Look up the `sdk_sessions` row by `id` (404 if missing).
2. For each child table — `observations` (matched by `memory_session_id`),
   `session_summaries` (matched by `memory_session_id`), `user_prompts` (matched by
   `session_db_id`) — select the matching row IDs, then run the shared per-row
   tombstone-or-refuse helper for each row (kinds `observation`, `summary`, `prompt`
   respectively).
   - If any row can't be safely deleted (cloud sync configured but identity
     unavailable, or an unsynced acknowledged row exists without cloud sync configured),
     the entire operation aborts (503) before any row is deleted or tombstoned.
3. Delete the matched child rows.
4. Delete the `sdk_sessions` row itself directly (plain local `DELETE` — sessions are
   not a synced `ContentKind`; only `observation`/`summary`/`prompt` are, per
   `CanonicalContent.ts`).

Response mirrors the single-row delete shape: `{ success: true, id, deletedCounts: {
observations, summaries, prompts } }`.

### 5. Styling

New `.card-session-id` rule in the viewer's stylesheet (smaller, muted text, consistent
with the existing badge styling conventions).

## Testing

- Backend: unit/integration tests for `getAllSessions`, the new `GET /api/sessions`
  route, and the bulk delete endpoint (happy path; cloud-sync-configured path;
  cloud-sync-unavailable-with-acknowledged-row refusal path; 404 for unknown session
  id).
- Frontend: manual verification via the dev viewer — card session ID renders correctly
  for all three card types, session filter narrows the list and composes correctly with
  the project filter, delete button is disabled with no selection, confirms before
  deleting, and updates local state on success.

## Known limitation

Each card type displays a different underlying column as "the session ID"
(`memory_session_id` for observations, `session_id` for summaries, `content_session_id`
for prompts). These are different string values for the same logical session (a single
`sdk_sessions` row stores both a `memory_session_id` and a `content_session_id`), so a
user visually comparing an observation card's session ID against a prompt card's session
ID for the same session will see two different strings. This isn't fixed by this design
— it reflects the existing per-entity data model — but is worth knowing when reading the
UI. Filtering/deleting is unaffected since both work off the numeric `sdk_sessions.id`.

## Open questions

None — all decisions were confirmed during brainstorming (native `<select>` for
sessions, full ID on cards, 8-char truncation + hover in the dropdown, session delete
removes all content including the `sdk_sessions` row, confirmation dialog required, live
SSE-backed session list matching the existing project list pattern).
