# Session ID Display, Filter, and Delete — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each card's session ID in the viewer, replace the flat card feed's main view with collapsible session cards (one per session, grouped, name + full ID + live item count) that link to a per-session detail page showing that session's cards, and let the user delete all content for a session (observations, summaries, prompts, and the session row itself) from a per-card menu.

**Architecture:** The canonical session key used for filtering/deletion is `content_session_id` (the Claude Code CLI session id), not `sdk_sessions.id`. This deviates from the committed spec (`docs/superpowers/specs/2026-07-30-session-id-viewer-design.md`), which proposed the numeric `sdk_sessions.id`. During planning it became clear the numeric id can't flow through live SSE events without extra plumbing (observations/summaries/prompts don't carry it, and there's no cheap way to add it without a join per live event), whereas `content_session_id` is **already present** on every summary and prompt row today, and only needs one additional SELECT column for observations (`sdk_sessions` is already joined in that query).

**Mid-execution redesign (after Tasks 1-7 shipped):** the frontend UX originally specced (a session filter `<select>` next to the project dropdown, a delete button beside it, a session-ID badge on every card) was replaced with a session-card + detail-page design: the main view becomes a list of one card per session (not per observation/summary/prompt), each showing a name, full ID, and item count, with a 3-dot menu (Open/Delete). Opening a session navigates to `/?session=<content_session_id>` — a real, bookmarkable URL via `history.pushState`, not a new dependency or backend route (the server already serves `/` unconditionally; query strings don't affect Express path matching) — which reuses the existing `Feed`/`ObservationCard`/`SummaryCard`/`PromptCard` components, scoped to that one session via the `contentSessionId` pagination filter Tasks 2 and 6 already built. Everything from Tasks 1-7 is unaffected and still used, just consumed differently: Task 2's backend pagination filter now powers the detail page instead of a main-view dropdown; Task 6's bulk-delete endpoint now powers the per-card menu's Delete action instead of a header button; Task 7's `SessionCatalogEntry` type gains two fields (below) for the card's name and count. The per-card session-ID badge (old Task 11) is dropped as redundant — the session card's own header already shows the full ID once per session, so showing it again on every individual card underneath would be repetitive without adding information.

**Tech Stack:** Bun, TypeScript, Express, bun:sqlite, React (function components), esbuild. Backend tests use `bun:test` under `tests/`. There is no frontend component test setup in this repo (no RTL/vitest) — frontend tasks are verified by building and manually exercising the dev viewer (final task).

## Global Constraints

- Session ID display: full ID on cards (all three card types, via Task 1 — already shipped), and full ID on each session card's header (name + ID), not truncated.
- Session card name: the session's `custom_title` if set, else the project name.
- Session card shows a live item count styled as "N memories" (1 → "1 memory"), summing observations + summaries + prompts for that session.
- No separate session filter `<select>` and no per-card session-ID badge on individual cards — superseded by the session-card redesign. The existing project filter `<select>` stays, filtering which session cards are shown.
- Session cards do not expand inline. Clicking the card body, or the card menu's "Open" action, navigates to that session's detail page.
- Session detail page navigation uses a real URL (`/?session=<content_session_id>`, via `history.pushState`/`popstate`, no router library) so back/forward/refresh/sharing all work; the detail page reuses the existing `Feed` component and card components unchanged.
- Each session card has a 3-dot menu — a small custom popover (click-outside or Escape closes it), not a native `<select>` — with "Open" and "Delete" actions.
- Deleting a session removes ALL its content (observations, summaries, prompts) AND the `sdk_sessions` row itself, behind a confirmation dialog before proceeding.
- The session list is populated live via SSE (initial full catalog + incremental additions/count updates), mirroring the existing project list — never a one-off fetch that goes stale.
- Canonical session key for filtering/deletion: `content_session_id` (string), not the numeric `sdk_sessions.id` — see Architecture note above.
- No new abstractions beyond what's needed: reuse the existing single-row cloud-sync delete safety logic (extracted into two small shared helpers) rather than inventing a new sync-safety mechanism.

---

### Task 1: Expose `content_session_id` on Observation (paginated + live)

Every `Summary` and `UserPrompt` row already carries a `content_session_id`-equivalent field (`session_id` and `content_session_id` respectively). `Observation` is the only one missing it — it only has `memory_session_id`. This task adds `content_session_id` to `Observation` everywhere it's produced, so all three entity types expose a session key usable for filtering.

**Files:**
- Modify: `src/services/worker/worker-types.ts:113-131` (`Observation` interface)
- Modify: `src/services/worker/PaginationHelper.ts:55-112` (`getObservations` SQL)
- Modify: `src/services/worker/agents/types.ts:9-25` (`ObservationSSEPayload`)
- Modify: `src/services/worker/agents/ResponseProcessor.ts:604-621` (`broadcastObservation` call)
- Modify: `src/ui/viewer/types.ts:1-19` (frontend `Observation` interface)
- Test: `tests/worker/pagination-helper-content-session-id.test.ts` (new)

**Interfaces:**
- Produces: `Observation.content_session_id: string` (backend `worker-types.ts` and frontend `types.ts`), populated in both the paginated REST path and the live SSE path. Later tasks (7, 9, 11) read this field.

- [ ] **Step 1: Write the failing test**

Create `tests/worker/pagination-helper-content-session-id.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { PaginationHelper } from '../../src/services/worker/PaginationHelper.js';

describe('PaginationHelper.getObservations content_session_id', () => {
  let store: SessionStore;
  let helper: PaginationHelper;

  beforeEach(() => {
    store = new SessionStore(':memory:');
    helper = new PaginationHelper({ getSessionStore: () => store } as any);
  });

  afterEach(() => {
    store.close();
  });

  it('includes the owning session\'s content_session_id on each observation', () => {
    const sessionDbId = store.createSDKSession('content-abc', 'proj', 'hello');
    store.db.prepare(`
      INSERT INTO observations (memory_session_id, project, type, title, created_at, created_at_epoch)
      SELECT memory_session_id, 'proj', 'discovery', 'obs 1', '2026-07-20T00:00:00.000Z', 1752969600000
      FROM sdk_sessions WHERE id = ?
    `).run(sessionDbId);

    const result = helper.getObservations(0, 20);

    expect(result.items).toHaveLength(1);
    expect(result.items[0].content_session_id).toBe('content-abc');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/worker/pagination-helper-content-session-id.test.ts`
Expected: FAIL — `result.items[0].content_session_id` is `undefined` (property doesn't exist yet).

- [ ] **Step 3: Add the field to both `Observation` type definitions**

In `src/services/worker/worker-types.ts`, inside the `Observation` interface (after `memory_session_id: string;` on line 115):

```typescript
export interface Observation {
  id: number;
  memory_session_id: string;  
  content_session_id: string;
  project: string;
  merged_into_project: string | null;
  platform_source: string;
  type: string;
  title: string;
  subtitle: string | null;
  text: string | null;
  narrative: string | null;
  facts: string | null;
  concepts: string | null;
  files_read: string | null;
  files_modified: string | null;
  prompt_number: number;
  created_at: string;
  created_at_epoch: number;
}
```

In `src/ui/viewer/types.ts`, inside the `Observation` interface (after `memory_session_id: string;` on line 3):

```typescript
export interface Observation {
  id: number;
  memory_session_id: string;
  content_session_id: string;
  project: string;
  merged_into_project?: string | null;
  platform_source: string;
  type: string;
  title: string | null;
  subtitle: string | null;
  narrative: string | null;
  text: string | null;
  facts: string | null;
  concepts: string | null;
  files_read: string | null;
  files_modified: string | null;
  prompt_number: number | null;
  created_at: string;
  created_at_epoch: number;
}
```

- [ ] **Step 4: Add the column to the `getObservations` SQL**

In `src/services/worker/PaginationHelper.ts`, in `getObservations` (line 55), add `s.content_session_id` to the SELECT list (the `LEFT JOIN sdk_sessions s` is already present on line 77):

```typescript
  getObservations(offset: number, limit: number, project?: string, platformSource?: string, contentSessionId?: string): PaginatedResult<Observation> {
    const db = this.dbManager.getSessionStore().db;
    let query = `
      SELECT
        o.id,
        o.memory_session_id,
        s.content_session_id,
        o.project,
        o.merged_into_project,
        COALESCE(s.platform_source, 'claude') as platform_source,
        o.type,
        o.title,
        o.subtitle,
        o.narrative,
        o.text,
        o.facts,
        o.concepts,
        o.files_read,
        o.files_modified,
        o.prompt_number,
        o.created_at,
        o.created_at_epoch
      FROM observations o
      LEFT JOIN sdk_sessions s ON o.memory_session_id = s.memory_session_id
    `;
    const params: SQLQueryBindings[] = [];
    const conditions: string[] = [];

    if (project) {
      conditions.push('(o.project = ? OR o.merged_into_project = ?)');
      params.push(project, project);
    } else {
      conditions.push('o.project != ?');
      params.push(OBSERVER_SESSIONS_PROJECT);
    }
    if (platformSource) {
      conditions.push(`COALESCE(s.platform_source, 'claude') = ?`);
      params.push(platformSource);
    }
    if (contentSessionId) {
      conditions.push('s.content_session_id = ?');
      params.push(contentSessionId);
    }
    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }
```

(Leave the rest of the method — `ORDER BY`/`LIMIT`/`OFFSET`/pagination/sanitize logic — unchanged. The `contentSessionId` parameter added here is unused until Task 2 wires it up from the route; that's fine, it's additive.)

- [ ] **Step 5: Add `content_session_id` to the live SSE observation payload**

In `src/services/worker/agents/types.ts`, add the field to `ObservationSSEPayload` (after `session_id: string;` on line 12):

```typescript
export interface ObservationSSEPayload {
  id: number;
  memory_session_id: string | null;
  session_id: string;
  content_session_id: string;
  platform_source: string;
  type: string;
  title: string | null;
  subtitle: string | null;
  text: string | null;
  narrative: string | null;
  facts: string;  
  concepts: string;  
  files_read: string;  
  files_modified: string;  
  project: string;
  prompt_number: number;
  created_at_epoch: number;
}
```

In `src/services/worker/agents/ResponseProcessor.ts`, add the field to the `broadcastObservation` call (around line 604-621):

```typescript
    broadcastObservation(worker, {
      id: obsId,
      memory_session_id: session.memorySessionId,
      session_id: session.contentSessionId,
      content_session_id: session.contentSessionId,
      platform_source: session.platformSource,
      type: obs.type,
      title: obs.title,
      subtitle: obs.subtitle,
      text: null,
      narrative: obs.narrative || null,
      facts: JSON.stringify(obs.facts || []),
      concepts: JSON.stringify(obs.concepts || []),
      files_read: JSON.stringify(obs.files_read || []),
      files_modified: JSON.stringify(obs.files_modified || []),
      project: context.project,
      prompt_number: context.promptNumber,
      created_at_epoch: result.createdAtEpoch
    });
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test tests/worker/pagination-helper-content-session-id.test.ts`
Expected: PASS

- [ ] **Step 7: Type-check the whole backend, not just the new test**

`Observation` is now a required field on a type used across `src/services/context/` (`ObservationCompiler.ts`, `ContextBuilder.ts`, `TimelineRenderer.ts`) and elsewhere. `bun test` transpiles TypeScript without type-checking, so it will NOT catch a missed object-literal construction site. Run the project's real typecheck instead:

Run: `npm run typecheck`
Expected: PASS. If it fails, the error will point at a file constructing an `Observation`-typed object literal without `content_session_id` — add the field there too (thread through whatever session id is available at that call site; do not stub it with an empty string).

- [ ] **Step 8: Run the full existing test suite to check for regressions**

Run: `bun test`
Expected: PASS (no existing test asserted an exact key set on `ObservationSSEPayload` or `Observation` that this additive field would break; if something fails, inspect it before proceeding — do not silence it).

- [ ] **Step 9: Commit**

```bash
git add src/services/worker/worker-types.ts src/services/worker/PaginationHelper.ts src/services/worker/agents/types.ts src/services/worker/agents/ResponseProcessor.ts src/ui/viewer/types.ts tests/worker/pagination-helper-content-session-id.test.ts
git commit -m "feat(viewer): expose content_session_id on Observation"
```

---

### Task 2: Session-scoped pagination (`contentSessionId` filter on observations/summaries/prompts)

The project filter is applied server-side during pagination (`GET /api/observations?project=...`), so "load more" only ever fetches relevant rows. The session filter needs the same treatment — otherwise selecting a narrow session while scrolled through a large project would make "load more" fetch many irrelevant rows before the client-side filter (Task 9) discards them.

**Files:**
- Modify: `src/services/worker/PaginationHelper.ts` (`getSummaries`, `getPrompts` — `getObservations` already updated in Task 1)
- Modify: `src/services/worker/http/routes/DataRoutes.ts:350-357` (`parsePaginationParams`) and the three `handleGet*` handlers (lines 105-121)
- Test: `tests/worker/pagination-helper-content-session-id.test.ts` (extend from Task 1)

**Interfaces:**
- Consumes: `Observation.content_session_id`-producing SQL join pattern from Task 1.
- Produces: `PaginationHelper.getObservations/getSummaries/getPrompts(offset, limit, project?, platformSource?, contentSessionId?)` — the 5th parameter, consumed by Task 9's `usePagination` changes via the `GET /api/observations|summaries|prompts?contentSessionId=...` query param.

- [ ] **Step 1: Write the failing tests**

Extend `tests/worker/pagination-helper-content-session-id.test.ts` (from Task 1) with two more `it` blocks in the same `describe`:

```typescript
  it('filters observations by contentSessionId', () => {
    const sessionA = store.createSDKSession('content-a', 'proj', 'a');
    const sessionB = store.createSDKSession('content-b', 'proj', 'b');
    for (const [sessionDbId, title] of [[sessionA, 'obs-a'], [sessionB, 'obs-b']] as const) {
      store.db.prepare(`
        INSERT INTO observations (memory_session_id, project, type, title, created_at, created_at_epoch)
        SELECT memory_session_id, 'proj', 'discovery', ?, '2026-07-20T00:00:00.000Z', 1752969600000
        FROM sdk_sessions WHERE id = ?
      `).run(title, sessionDbId);
    }

    const result = helper.getObservations(0, 20, undefined, undefined, 'content-a');

    expect(result.items).toHaveLength(1);
    expect(result.items[0].title).toBe('obs-a');
  });

  it('filters summaries and prompts by contentSessionId', () => {
    const sessionA = store.createSDKSession('content-a', 'proj', 'a');
    const sessionB = store.createSDKSession('content-b', 'proj', 'b');
    store.db.prepare(`
      INSERT INTO session_summaries (memory_session_id, project, request, created_at, created_at_epoch)
      SELECT memory_session_id, 'proj', 'summary-a', '2026-07-20T00:00:00.000Z', 1752969600000
      FROM sdk_sessions WHERE id = ?
    `).run(sessionA);
    store.db.prepare(`
      INSERT INTO session_summaries (memory_session_id, project, request, created_at, created_at_epoch)
      SELECT memory_session_id, 'proj', 'summary-b', '2026-07-20T00:00:00.000Z', 1752969600000
      FROM sdk_sessions WHERE id = ?
    `).run(sessionB);
    store.db.prepare(`
      INSERT INTO user_prompts (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, 'content-a', 1, 'prompt-a', '2026-07-20T00:00:00.000Z', 1752969600000)
    `).run(sessionA);
    store.db.prepare(`
      INSERT INTO user_prompts (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, 'content-b', 1, 'prompt-b', '2026-07-20T00:00:00.000Z', 1752969600000)
    `).run(sessionB);

    const summaries = helper.getSummaries(0, 20, undefined, undefined, 'content-a');
    expect(summaries.items).toHaveLength(1);
    expect(summaries.items[0].request).toBe('summary-a');

    const prompts = helper.getPrompts(0, 20, undefined, undefined, 'content-a');
    expect(prompts.items).toHaveLength(1);
    expect(prompts.items[0].prompt_text).toBe('prompt-a');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/worker/pagination-helper-content-session-id.test.ts`
Expected: FAIL — `getObservations`/`getSummaries`/`getPrompts` don't accept/apply a 5th `contentSessionId` argument yet (the filter test observes both rows instead of one).

- [ ] **Step 3: Add `contentSessionId` filtering to `getSummaries` and `getPrompts`**

In `src/services/worker/PaginationHelper.ts`, `getSummaries` (line 114):

```typescript
  getSummaries(offset: number, limit: number, project?: string, platformSource?: string, contentSessionId?: string): PaginatedResult<Summary> {
    const db = this.dbManager.getSessionStore().db;

    let query = `
      SELECT
        ss.id,
        s.content_session_id as session_id,
        COALESCE(s.platform_source, 'claude') as platform_source,
        ss.request,
        ss.investigated,
        ss.learned,
        ss.completed,
        ss.next_steps,
        ss.project,
        ss.created_at,
        ss.created_at_epoch
      FROM session_summaries ss
      JOIN sdk_sessions s ON ss.memory_session_id = s.memory_session_id
    `;
    const params: any[] = [];

    const conditions: string[] = [];

    if (project) {
      conditions.push('(ss.project = ? OR ss.merged_into_project = ?)');
      params.push(project, project);
    } else {
      conditions.push('ss.project != ?');
      params.push(OBSERVER_SESSIONS_PROJECT);
    }

    if (platformSource) {
      conditions.push(`COALESCE(s.platform_source, 'claude') = ?`);
      params.push(platformSource);
    }

    if (contentSessionId) {
      conditions.push('s.content_session_id = ?');
      params.push(contentSessionId);
    }

    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }
```

(Rest of the method unchanged.)

`getPrompts` (line 168):

```typescript
  getPrompts(offset: number, limit: number, project?: string, platformSource?: string, contentSessionId?: string): PaginatedResult<UserPrompt> {
    const db = this.dbManager.getSessionStore().db;

    let query = `
      SELECT
        up.id,
        up.content_session_id,
        s.project,
        COALESCE(s.platform_source, 'claude') as platform_source,
        up.prompt_number,
        up.prompt_text,
        up.created_at,
        up.created_at_epoch
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
    `;
    const params: any[] = [];

    const conditions: string[] = [];

    if (project) {
      conditions.push('s.project = ?');
      params.push(project);
    } else {
      conditions.push('s.project != ?');
      params.push(OBSERVER_SESSIONS_PROJECT);
    }

    if (platformSource) {
      conditions.push(`COALESCE(s.platform_source, 'claude') = ?`);
      params.push(platformSource);
    }

    if (contentSessionId) {
      conditions.push('up.content_session_id = ?');
      params.push(contentSessionId);
    }

    conditions.push(`
```

(The rest — the `NOT EXISTS` dedupe clause and everything after — stays exactly as-is.)

- [ ] **Step 4: Wire the query param through `DataRoutes.ts`**

In `src/services/worker/http/routes/DataRoutes.ts`, `parsePaginationParams` (line 350):

```typescript
  private parsePaginationParams(req: Request): { offset: number; limit: number; project?: string; platformSource?: string; contentSessionId?: string } {
    const offset = parseInt(req.query.offset as string, 10) || 0;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100); 
    const project = req.query.project as string | undefined;
    const platformSource = this.getOptionalPlatformSourceFromRequest(req);
    const contentSessionId = req.query.contentSessionId as string | undefined;

    return { offset, limit, project, platformSource, contentSessionId };
  }
```

Update the three handlers (lines 105-121) to pass it through:

```typescript
  private handleGetObservations = this.wrapHandler((req: Request, res: Response): void => {
    const { offset, limit, project, platformSource, contentSessionId } = this.parsePaginationParams(req);
    const result = this.paginationHelper.getObservations(offset, limit, project, platformSource, contentSessionId);
    res.json(result);
  });

  private handleGetSummaries = this.wrapHandler((req: Request, res: Response): void => {
    const { offset, limit, project, platformSource, contentSessionId } = this.parsePaginationParams(req);
    const result = this.paginationHelper.getSummaries(offset, limit, project, platformSource, contentSessionId);
    res.json(result);
  });

  private handleGetPrompts = this.wrapHandler((req: Request, res: Response): void => {
    const { offset, limit, project, platformSource, contentSessionId } = this.parsePaginationParams(req);
    const result = this.paginationHelper.getPrompts(offset, limit, project, platformSource, contentSessionId);
    res.json(result);
  });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/worker/pagination-helper-content-session-id.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/services/worker/PaginationHelper.ts src/services/worker/http/routes/DataRoutes.ts tests/worker/pagination-helper-content-session-id.test.ts
git commit -m "feat(viewer): add contentSessionId filter to paginated observations/summaries/prompts"
```

---

### Task 3: `SessionStore.getAllSessions()`

Backend catalog method for the session dropdown, mirroring the existing `getAllProjects`/`getProjectCatalog` pattern.

**Files:**
- Modify: `src/services/sqlite/SessionStore.ts` (add method near `getProjectCatalog`, after line 2097)
- Test: `tests/session_store.test.ts` (extend)

**Interfaces:**
- Produces: `SessionStore.getAllSessions(platformSource?: string): SessionCatalogRow[]` where `SessionCatalogRow = { content_session_id: string; project: string; platform_source: string; started_at_epoch: number }`. Consumed by Task 4's `GET /api/sessions` route.

- [ ] **Step 1: Write the failing test**

Add to `tests/session_store.test.ts` (inside the existing `describe('SessionStore', ...)` block):

```typescript
  it('lists all sessions for the catalog, newest first, excluding empty projects', () => {
    store.createSDKSession('content-old', 'proj-a', 'first');
    store.db.prepare(`UPDATE sdk_sessions SET started_at_epoch = 1000 WHERE content_session_id = 'content-old'`).run();
    store.createSDKSession('content-new', 'proj-b', 'second');
    store.db.prepare(`UPDATE sdk_sessions SET started_at_epoch = 2000 WHERE content_session_id = 'content-new'`).run();

    const sessions = store.getAllSessions();

    expect(sessions.map(s => s.content_session_id)).toEqual(['content-new', 'content-old']);
    expect(sessions[0]).toMatchObject({ project: 'proj-b', platform_source: 'claude', started_at_epoch: 2000 });
  });

  it('filters the session catalog by platform source', () => {
    store.createSDKSession('content-claude', 'proj-a', 'a', undefined, 'claude');
    store.createSDKSession('content-codex', 'proj-a', 'b', undefined, 'codex');

    const claudeSessions = store.getAllSessions('claude');

    expect(claudeSessions.map(s => s.content_session_id)).toEqual(['content-claude']);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/session_store.test.ts`
Expected: FAIL — `store.getAllSessions is not a function`.

- [ ] **Step 3: Implement `getAllSessions`**

In `src/services/sqlite/SessionStore.ts`, add this method directly after `getProjectCatalog()` (after line 2097):

```typescript
  getAllSessions(platformSource?: string): Array<{
    content_session_id: string;
    project: string;
    platform_source: string;
    started_at_epoch: number;
  }> {
    const normalizedPlatformSource = platformSource ? normalizePlatformSource(platformSource) : undefined;
    let query = `
      SELECT
        content_session_id,
        project,
        COALESCE(platform_source, '${DEFAULT_PLATFORM_SOURCE}') as platform_source,
        started_at_epoch
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
        AND project != ?
    `;
    const params: SQLQueryBindings[] = [OBSERVER_SESSIONS_PROJECT];

    if (normalizedPlatformSource) {
      query += ' AND COALESCE(platform_source, ?) = ?';
      params.push(DEFAULT_PLATFORM_SOURCE, normalizedPlatformSource);
    }

    query += ' ORDER BY started_at_epoch DESC';

    return this.db.prepare(query).all(...params) as Array<{
      content_session_id: string;
      project: string;
      platform_source: string;
      started_at_epoch: number;
    }>;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/session_store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/sqlite/SessionStore.ts tests/session_store.test.ts
git commit -m "feat(viewer): add SessionStore.getAllSessions for the session catalog"
```

---

### Task 4: `GET /api/sessions` route + SSE `initial_load` catalog

**Files:**
- Modify: `src/services/worker/http/routes/DataRoutes.ts` (add route + handler)
- Modify: `src/services/worker/http/routes/ViewerRoutes.ts:90-98` (`initial_load` payload)
- Test: `tests/worker/http/routes/data-routes-sessions-catalog.test.ts` (new)

**Interfaces:**
- Consumes: `SessionStore.getAllSessions()` from Task 3.
- Produces: `GET /api/sessions` → `{ sessions: SessionCatalogRow[] }`; SSE `initial_load` event gains a `sessions: SessionCatalogRow[]` field. Consumed by Task 7's `useSSE.ts`.

- [ ] **Step 1: Write the failing test**

Create `tests/worker/http/routes/data-routes-sessions-catalog.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Request, Response } from 'express';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { DataRoutes } from '../../../../src/services/worker/http/routes/DataRoutes.js';

describe('GET /api/sessions', () => {
  let db: Database;
  let store: SessionStore;
  let handlers: Map<string, (req: Request, res: Response) => void>;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new SessionStore(db);
    store.createSDKSession('content-catalog', 'proj-catalog', 'hi');

    const routes = new DataRoutes(
      {} as any,
      { getSessionStore: () => store, getCloudSync: () => null } as any,
      {} as any,
      {} as any,
      {} as any,
      Date.now(),
    );
    handlers = new Map();
    routes.setupRoutes({
      get: mock((path: string, handler: (req: Request, res: Response) => void) => {
        handlers.set(path, handler);
      }),
      post: mock(() => {}),
      delete: mock(() => {}),
    } as any);
  });

  afterEach(() => {
    db.close();
  });

  it('returns the session catalog', () => {
    let responseBody: any;
    const response = { json(value: unknown) { responseBody = value; return this; } } as unknown as Response;

    handlers.get('/api/sessions')!({ query: {}, get: () => undefined } as unknown as Request, response);

    expect(responseBody.sessions).toHaveLength(1);
    expect(responseBody.sessions[0]).toMatchObject({ content_session_id: 'content-catalog', project: 'proj-catalog' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/worker/http/routes/data-routes-sessions-catalog.test.ts`
Expected: FAIL — no handler registered for `/api/sessions` (`handlers.get('/api/sessions')` is `undefined`, so the call throws).

- [ ] **Step 3: Add the route and handler**

In `src/services/worker/http/routes/DataRoutes.ts`, register the route in `setupRoutes` (after the `/api/projects` line, ~line 98):

```typescript
    app.get('/api/projects', this.handleGetProjects.bind(this));
    app.get('/api/sessions', this.handleGetSessions.bind(this));
```

Add the handler near `handleGetProjects` (after line 342):

```typescript
  private handleGetSessions = this.wrapHandler((req: Request, res: Response): void => {
    const store = this.dbManager.getSessionStore();
    const platformSource = this.getOptionalPlatformSourceFromRequest(req);
    res.json({ sessions: store.getAllSessions(platformSource) });
  });
```

- [ ] **Step 4: Add `sessions` to the SSE `initial_load` payload**

In `src/services/worker/http/routes/ViewerRoutes.ts`, extend the `initial_load` broadcast (lines 91-98):

```typescript
    const projectCatalog = this.dbManager.getSessionStore().getProjectCatalog();
    const sessions = this.dbManager.getSessionStore().getAllSessions();
    this.sseBroadcaster.broadcast({
      type: 'initial_load',
      projects: projectCatalog.projects,
      sources: projectCatalog.sources,
      projectsBySource: projectCatalog.projectsBySource,
      sessions,
      timestamp: Date.now()
    });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/worker/http/routes/data-routes-sessions-catalog.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/services/worker/http/routes/DataRoutes.ts src/services/worker/http/routes/ViewerRoutes.ts tests/worker/http/routes/data-routes-sessions-catalog.test.ts
git commit -m "feat(viewer): add GET /api/sessions and include session catalog in initial_load"
```

---

### Task 5: Extract shared row-delete helpers (no behavior change)

Refactor the existing single-row `deleteSyncedContent` into two reusable pieces — a pure safety check and a mutation — so Task 6's bulk session delete can reuse the exact same cloud-sync safety logic instead of duplicating it. This task must not change any observable behavior of the existing `DELETE /api/observation/:id` etc. endpoints.

**Files:**
- Modify: `src/services/worker/http/routes/DataRoutes.ts:233-283` (`deleteSyncedContent`)
- Test: `tests/worker/http/routes/data-routes-delete-sync.test.ts` (existing — must still pass unmodified)

**Interfaces:**
- Produces: `DataRoutes.assertRowDeletable(cloudSync, store, kind, originLocalId)` and `DataRoutes.commitRowDelete(cloudSync, store, kind, table, originLocalId)` (private methods). Consumed by Task 6's bulk delete handler.

- [ ] **Step 1: Confirm the baseline test passes before refactoring**

Run: `bun test tests/worker/http/routes/data-routes-delete-sync.test.ts`
Expected: PASS (this is the safety net for the refactor — if it's not green before you start, stop and investigate first).

- [ ] **Step 2: Extract the two helpers and rewrite `deleteSyncedContent` to use them**

In `src/services/worker/http/routes/DataRoutes.ts`, add this import at the top (near the other type-only imports, e.g. after line 20):

```typescript
import type { CloudSync } from '../../../sync/CloudSync.js';
```

Replace `deleteSyncedContent` (lines 234-283) with:

```typescript
  /** Pure safety check: can this row be deleted right now without stranding a replica? No mutation. */
  private assertRowDeletable(
    cloudSync: CloudSync | null,
    store: ReturnType<DatabaseManager['getSessionStore']>,
    kind: ContentKind,
    originLocalId: string,
  ): { ok: true } | { ok: false; status: number; error: string } {
    if (cloudSync?.isConfigured()) {
      if (!cloudSync.status().deviceId) {
        return { ok: false, status: 503, error: 'cloud sync identity unavailable; refusing an unreplicated delete' };
      }
      return { ok: true };
    }
    // A row with an acknowledged entity head must never be silently deleted
    // while its sync identity is unavailable: that would strand replicas.
    const acknowledged = store.db.prepare(`
      SELECT 1 AS found FROM sync_entity_heads
      WHERE kind = ? AND origin_local_id = ? LIMIT 1
    `).get(kind, originLocalId) as { found: number } | undefined;
    if (acknowledged) {
      return { ok: false, status: 503, error: 'cloud sync unavailable; refusing an unreplicated delete' };
    }
    return { ok: true };
  }

  /** Mutation only — caller must have already called assertRowDeletable for this row. */
  private commitRowDelete(
    cloudSync: CloudSync | null,
    store: ReturnType<DatabaseManager['getSessionStore']>,
    kind: ContentKind,
    table: 'observations' | 'session_summaries' | 'user_prompts',
    originLocalId: string,
  ): string | null {
    if (cloudSync?.isConfigured()) {
      return cloudSync.queueDelete(kind, originLocalId);
    }
    store.db.prepare(
      `DELETE FROM ${table} WHERE id = ? AND origin_device_id IS NULL`
    ).run(originLocalId);
    return null;
  }

  /** Production deletion surface: safety check and row delete for a single content row. */
  private deleteSyncedContent(
    req: Request,
    res: Response,
    kind: ContentKind,
    table: 'observations' | 'session_summaries' | 'user_prompts',
  ): void {
    let originLocalId: string;
    try {
      originLocalId = assertCanonicalDecimal(req.params.id, { positive: true });
    } catch {
      this.badRequest(res, 'id must be a positive canonical decimal string');
      return;
    }

    const store = this.dbManager.getSessionStore();
    const row = store.db.prepare(`
      SELECT CAST(id AS TEXT) AS id FROM ${table}
      WHERE id = ? AND origin_device_id IS NULL
    `).get(originLocalId) as { id: string } | undefined;
    if (!row) {
      this.notFound(res, `${kind} #${originLocalId} not found`);
      return;
    }

    const cloudSync = this.dbManager.getCloudSync();
    const check = this.assertRowDeletable(cloudSync, store, kind, originLocalId);
    if (!check.ok) {
      res.status(check.status).json({ error: check.error });
      return;
    }

    const entityRev = this.commitRowDelete(cloudSync, store, kind, table, originLocalId);

    res.json({ success: true, id: originLocalId, kind, entity_rev: entityRev });
  }
```

- [ ] **Step 3: Run the existing test to confirm no behavior changed**

Run: `bun test tests/worker/http/routes/data-routes-delete-sync.test.ts`
Expected: PASS, identical output to Step 1 (same response shapes, same `entity_rev: '2'` values, same tombstone rows).

- [ ] **Step 4: Run the full suite**

Run: `bun test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/worker/http/routes/DataRoutes.ts
git commit -m "refactor(viewer): extract shared row-delete safety check from deleteSyncedContent"
```

---

### Task 6: `DELETE /api/sessions/:contentSessionId` bulk delete endpoint

**Files:**
- Modify: `src/services/worker/http/routes/DataRoutes.ts` (add route + handler)
- Test: `tests/worker/http/routes/data-routes-session-delete.test.ts` (new)

**Interfaces:**
- Consumes: `assertRowDeletable`/`commitRowDelete` from Task 5.
- Produces: `DELETE /api/sessions/:contentSessionId` → `{ success: true, contentSessionId, deletedCounts: { observations, summaries, prompts } }` on success, `404` if the session doesn't exist, `503` (nothing deleted) if any row fails the pre-flight safety check. Consumed by Task 9's `App.tsx` delete handler.

- [ ] **Step 1: Write the failing tests**

Create `tests/worker/http/routes/data-routes-session-delete.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Request, Response } from 'express';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { CloudSync } from '../../../../src/services/sync/CloudSync.js';
import { DataRoutes } from '../../../../src/services/worker/http/routes/DataRoutes.js';

function seedSession(db: Database, contentSessionId: string, memorySessionId: string, project: string) {
  db.prepare(`
    INSERT INTO sdk_sessions
      (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
    VALUES (?, ?, ?, '2026-07-20T00:00:00.000Z', 1752969600000, 'completed')
  `).run(contentSessionId, memorySessionId, project);
  const sessionDbId = (db.prepare(`SELECT id FROM sdk_sessions WHERE content_session_id = ?`).get(contentSessionId) as { id: number }).id;
  db.prepare(`
    INSERT INTO observations (memory_session_id, project, type, title, created_at, created_at_epoch)
    VALUES (?, ?, 'discovery', 'obs', '2026-07-20T00:00:00.000Z', 1752969600000)
  `).run(memorySessionId, project);
  db.prepare(`
    INSERT INTO session_summaries (memory_session_id, project, request, created_at, created_at_epoch)
    VALUES (?, ?, 'req', '2026-07-20T00:00:00.000Z', 1752969600000)
  `).run(memorySessionId, project);
  db.prepare(`
    INSERT INTO user_prompts (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
    VALUES (?, ?, 1, 'prompt', '2026-07-20T00:00:00.000Z', 1752969600000)
  `).run(sessionDbId, contentSessionId);
  return sessionDbId;
}

function callDelete(handlers: Map<string, (req: Request, res: Response) => void>, contentSessionId: string) {
  let status = 200;
  let body: any;
  const response = {
    status(code: number) { status = code; return this; },
    json(value: unknown) { body = value; return this; },
  } as unknown as Response;
  handlers.get('/api/sessions/:contentSessionId')!(
    { params: { contentSessionId }, query: {}, get: () => undefined } as unknown as Request,
    response,
  );
  return { status, body };
}

describe('DELETE /api/sessions/:contentSessionId', () => {
  let db: Database;
  let tempDir: string;
  let store: SessionStore;
  let sync: CloudSync;
  let handlers: Map<string, (req: Request, res: Response) => void>;

  function setup(cloudSync: CloudSync | null) {
    const routes = new DataRoutes(
      {} as any,
      { getSessionStore: () => store, getCloudSync: () => cloudSync } as any,
      {} as any,
      {} as any,
      {} as any,
      Date.now(),
    );
    handlers = new Map();
    routes.setupRoutes({
      get: mock(() => {}),
      post: mock(() => {}),
      delete: mock((path: string, handler: (req: Request, res: Response) => void) => {
        handlers.set(path, handler);
      }),
    } as any);
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cmem-session-delete-'));
    db = new Database(':memory:');
    store = new SessionStore(db);
    sync = new CloudSync(db, {
      CLAUDE_MEM_CLOUD_SYNC_TOKEN: 'test-token',
      CLAUDE_MEM_CLOUD_SYNC_USER_ID: 'test-user',
      CLAUDE_MEM_CLOUD_SYNC_HUB_URL: 'https://hub.test',
      CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: 'device-session-delete',
      CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME: 'test',
    }, {
      settingsPath: join(tempDir, 'settings.json'),
      fetchImpl: mock(async () => new Response('{}', { status: 500 })) as typeof fetch,
    });
  });

  afterEach(() => {
    sync.stop();
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('deletes all content for the session plus the session row, tombstoning each child row', () => {
    seedSession(db, 'content-del', 'memory-del', 'proj-del');
    setup(sync);

    const { status, body } = callDelete(handlers, 'content-del');

    expect(status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      contentSessionId: 'content-del',
      deletedCounts: { observations: 1, summaries: 1, prompts: 1 },
    });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM observations`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM session_summaries`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM user_prompts`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sdk_sessions`).get()).toEqual({ n: 0 });

    const outbox = db.prepare(`SELECT kind FROM sync_content_outbox ORDER BY id`).all() as Array<{ kind: string }>;
    expect(outbox.map(row => row.kind).sort()).toEqual(['observation', 'prompt', 'summary']);
  });

  it('404s for an unknown session and deletes nothing', () => {
    setup(sync);
    const { status } = callDelete(handlers, 'does-not-exist');
    expect(status).toBe(404);
  });

  it('refuses and deletes nothing when a child row is already sync-acknowledged and cloud sync is unavailable', () => {
    const sessionDbId = seedSession(db, 'content-guard', 'memory-guard', 'proj-guard');
    const obsId = (db.prepare(`SELECT id FROM observations WHERE memory_session_id = 'memory-guard'`).get() as { id: number }).id;
    db.prepare(`
      INSERT INTO sync_entity_heads (entity_id, kind, origin_device_id, origin_local_id, entity_rev, operation_sha256, deleted, updated_at_epoch)
      VALUES ('entity-1', 'observation', 'some-other-device', ?, '1', 'sha', 0, 1752969600000)
    `).run(String(obsId));

    setup(null); // cloud sync unavailable

    const { status } = callDelete(handlers, 'content-guard');

    expect(status).toBe(503);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM observations`).get()).toEqual({ n: 1 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM session_summaries`).get()).toEqual({ n: 1 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sdk_sessions`).get()).toEqual({ n: 1 });
    void sessionDbId;
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/worker/http/routes/data-routes-session-delete.test.ts`
Expected: FAIL — no handler registered for `/api/sessions/:contentSessionId`.

- [ ] **Step 3: Add the route and handler**

In `src/services/worker/http/routes/DataRoutes.ts`, register the route in `setupRoutes` (after the `/api/sessions` line added in Task 4):

```typescript
    app.get('/api/sessions', this.handleGetSessions.bind(this));
    app.delete('/api/sessions/:contentSessionId', this.handleDeleteSession.bind(this));
```

Add the handler after `handleGetSessions`:

```typescript
  private handleDeleteSession = this.wrapHandler((req: Request, res: Response): void => {
    const contentSessionId = this.toStringParam(req.params.contentSessionId);
    if (!contentSessionId) {
      this.badRequest(res, 'contentSessionId is required');
      return;
    }

    const store = this.dbManager.getSessionStore();
    const platformSource = this.getOptionalPlatformSourceFromRequest(req);

    const sessionRow = store.db.prepare(`
      SELECT id, memory_session_id
      FROM sdk_sessions
      WHERE content_session_id = ?
        AND (? IS NULL OR COALESCE(platform_source, 'claude') = ?)
    `).get(contentSessionId, platformSource ?? null, platformSource ?? null) as
      { id: number; memory_session_id: string | null } | undefined;

    if (!sessionRow) {
      this.notFound(res, `Session ${contentSessionId} not found`);
      return;
    }

    type ChildRow = { kind: ContentKind; table: 'observations' | 'session_summaries' | 'user_prompts'; id: string };
    const childRows: ChildRow[] = [];

    if (sessionRow.memory_session_id) {
      const observations = store.db.prepare(
        `SELECT CAST(id AS TEXT) AS id FROM observations WHERE memory_session_id = ? AND origin_device_id IS NULL`
      ).all(sessionRow.memory_session_id) as Array<{ id: string }>;
      childRows.push(...observations.map(row => ({ kind: 'observation' as ContentKind, table: 'observations' as const, id: row.id })));

      const summaries = store.db.prepare(
        `SELECT CAST(id AS TEXT) AS id FROM session_summaries WHERE memory_session_id = ? AND origin_device_id IS NULL`
      ).all(sessionRow.memory_session_id) as Array<{ id: string }>;
      childRows.push(...summaries.map(row => ({ kind: 'summary' as ContentKind, table: 'session_summaries' as const, id: row.id })));
    }

    const prompts = store.db.prepare(
      `SELECT CAST(id AS TEXT) AS id FROM user_prompts WHERE session_db_id = ? AND origin_device_id IS NULL`
    ).all(sessionRow.id) as Array<{ id: string }>;
    childRows.push(...prompts.map(row => ({ kind: 'prompt' as ContentKind, table: 'user_prompts' as const, id: row.id })));

    const cloudSync = this.dbManager.getCloudSync();

    // Pre-flight: validate every row can be safely deleted BEFORE mutating any of them.
    for (const row of childRows) {
      const check = this.assertRowDeletable(cloudSync, store, row.kind, row.id);
      if (!check.ok) {
        res.status(check.status).json({ error: check.error });
        return;
      }
    }

    const deletedCounts = { observations: 0, summaries: 0, prompts: 0 };
    for (const row of childRows) {
      this.commitRowDelete(cloudSync, store, row.kind, row.table, row.id);
      if (row.kind === 'observation') deletedCounts.observations++;
      else if (row.kind === 'summary') deletedCounts.summaries++;
      else deletedCounts.prompts++;
    }

    store.db.prepare(`DELETE FROM sdk_sessions WHERE id = ?`).run(sessionRow.id);

    res.json({ success: true, contentSessionId, deletedCounts });
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/worker/http/routes/data-routes-session-delete.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full suite**

Run: `bun test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/services/worker/http/routes/DataRoutes.ts tests/worker/http/routes/data-routes-session-delete.test.ts
git commit -m "feat(viewer): add bulk session delete endpoint (DELETE /api/sessions/:contentSessionId)"
```

---

### Task 7: Frontend types + API endpoint constant

**Files:**
- Modify: `src/ui/viewer/types.ts` (add `SessionCatalogEntry`, extend `StreamEvent`)
- Modify: `src/ui/viewer/constants/api.ts` (add `SESSIONS` endpoint)

**Interfaces:**
- Produces: `SessionCatalogEntry { content_session_id: string; project: string; platform_source: string; started_at_epoch: number }`, `StreamEvent.sessions?: SessionCatalogEntry[]`, `API_ENDPOINTS.SESSIONS = '/api/sessions'`. Consumed by Tasks 8, 9, 10.

- [ ] **Step 1: Add `SessionCatalogEntry` and extend `StreamEvent`**

In `src/ui/viewer/types.ts`, add after the `UserPrompt` interface (after line 42, before `FeedItem`):

```typescript
export interface SessionCatalogEntry {
  content_session_id: string;
  project: string;
  platform_source: string;
  started_at_epoch: number;
}
```

Extend `StreamEvent` (lines 49-60) to add a `sessions` field:

```typescript
export interface StreamEvent {
  type: 'initial_load' | 'new_observation' | 'new_summary' | 'new_prompt' | 'processing_status';
  observations?: Observation[];
  summaries?: Summary[];
  prompts?: UserPrompt[];
  projects?: string[];
  sessions?: SessionCatalogEntry[];
  observation?: Observation;
  summary?: Summary;
  prompt?: UserPrompt;
  isProcessing?: boolean;
  queueDepth?: number;
}
```

- [ ] **Step 2: Add the `SESSIONS` API endpoint constant**

In `src/ui/viewer/constants/api.ts`:

```typescript
export const API_ENDPOINTS = {
  OBSERVATIONS: '/api/observations',
  SUMMARIES: '/api/summaries',
  PROMPTS: '/api/prompts',
  SETTINGS: '/api/settings',
  SESSIONS: '/api/sessions',
  STREAM: '/stream',
} as const;
```

- [ ] **Step 3: Type-check the viewer build**

Run: `npx tsc --noEmit -p src/ui/viewer/tsconfig.json`
Expected: no new errors (Task 1 already made `Observation.content_session_id` required on the frontend type; this task only adds new optional/standalone types, so nothing should break yet — card components don't reference `content_session_id` until Task 11, and `Observation` objects are only constructed by the backend/SSE, not by frontend code, so there's no frontend call site that needs updating here).

- [ ] **Step 4: Commit**

```bash
git add src/ui/viewer/types.ts src/ui/viewer/constants/api.ts
git commit -m "feat(viewer): add SessionCatalogEntry type and /api/sessions endpoint constant"
```

---

### Task 8: Backend — `item_count` + `custom_title` on the session catalog

**Files:**
- Modify: `src/services/sqlite/SessionStore.ts` (`getAllSessions` method)
- Modify: `src/ui/viewer/types.ts` (`SessionCatalogEntry`)
- Test: `tests/session_store.test.ts` (extend)

**Interfaces:**
- Produces: `SessionStore.getAllSessions()` rows gain `custom_title: string | null` and `item_count: number` (observations + summaries + prompts for that session). `SessionCatalogEntry` (frontend) matches the new shape. Consumed by Task 9 (`useSSE.ts`) and Task 10 (`SessionCard.tsx`).
- No route changes needed: `GET /api/sessions` (Task 4) already passes `getAllSessions()`'s return value straight through, so the richer shape flows automatically.

- [ ] **Step 1: Write the failing tests**

Add to `tests/session_store.test.ts` (inside the existing `describe('SessionStore', ...)` block, alongside the Task 3 tests for `getAllSessions`):

```typescript
  it('includes custom_title and a combined item_count across observations/summaries/prompts', () => {
    const sessionDbId = store.createSDKSession('content-counts', 'proj-counts', 'first', 'My Custom Title');
    store.ensureMemorySessionIdRegistered(sessionDbId, 'mem-counts');
    store.db.prepare(`
      INSERT INTO observations (memory_session_id, project, type, title, created_at, created_at_epoch)
      VALUES ('mem-counts', 'proj-counts', 'discovery', 'obs 1', '2026-07-20T00:00:00.000Z', 1752969600000)
    `).run();
    store.db.prepare(`
      INSERT INTO observations (memory_session_id, project, type, title, created_at, created_at_epoch)
      VALUES ('mem-counts', 'proj-counts', 'discovery', 'obs 2', '2026-07-20T00:00:00.000Z', 1752969600000)
    `).run();
    store.db.prepare(`
      INSERT INTO session_summaries (memory_session_id, project, request, created_at, created_at_epoch)
      VALUES ('mem-counts', 'proj-counts', 'a summary', '2026-07-20T00:00:00.000Z', 1752969600000)
    `).run();
    store.db.prepare(`
      INSERT INTO user_prompts (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, 'content-counts', 1, 'a prompt', '2026-07-20T00:00:00.000Z', 1752969600000)
    `).run(sessionDbId);

    const sessions = store.getAllSessions();
    const row = sessions.find(s => s.content_session_id === 'content-counts');

    expect(row).toBeDefined();
    expect(row!.custom_title).toBe('My Custom Title');
    expect(row!.item_count).toBe(4);
  });

  it('reports item_count 0 and custom_title null for a session with no content and no title', () => {
    store.createSDKSession('content-empty', 'proj-empty', 'first');

    const sessions = store.getAllSessions();
    const row = sessions.find(s => s.content_session_id === 'content-empty');

    expect(row).toBeDefined();
    expect(row!.custom_title).toBeNull();
    expect(row!.item_count).toBe(0);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/session_store.test.ts`
Expected: FAIL — `row!.custom_title` and `row!.item_count` are `undefined` (properties don't exist on the current return shape).

- [ ] **Step 3: Replace `getAllSessions` with the richer query**

In `src/services/sqlite/SessionStore.ts`, replace the existing `getAllSessions` method (added in Task 3) entirely with:

```typescript
  getAllSessions(platformSource?: string): Array<{
    content_session_id: string;
    project: string;
    platform_source: string;
    custom_title: string | null;
    started_at_epoch: number;
    item_count: number;
  }> {
    const normalizedPlatformSource = platformSource ? normalizePlatformSource(platformSource) : undefined;
    let query = `
      SELECT
        s.content_session_id,
        s.project,
        COALESCE(s.platform_source, '${DEFAULT_PLATFORM_SOURCE}') as platform_source,
        s.custom_title,
        s.started_at_epoch,
        (
          (SELECT COUNT(*) FROM observations o WHERE o.memory_session_id = s.memory_session_id)
          + (SELECT COUNT(*) FROM session_summaries ss WHERE ss.memory_session_id = s.memory_session_id)
          + (SELECT COUNT(*) FROM user_prompts up WHERE up.session_db_id = s.id)
        ) as item_count
      FROM sdk_sessions s
      WHERE s.project IS NOT NULL AND s.project != ''
        AND s.project != ?
    `;
    const params: SQLQueryBindings[] = [OBSERVER_SESSIONS_PROJECT];

    if (normalizedPlatformSource) {
      query += ' AND COALESCE(s.platform_source, ?) = ?';
      params.push(DEFAULT_PLATFORM_SOURCE, normalizedPlatformSource);
    }

    query += ' ORDER BY s.started_at_epoch DESC';

    return this.db.prepare(query).all(...params) as Array<{
      content_session_id: string;
      project: string;
      platform_source: string;
      custom_title: string | null;
      started_at_epoch: number;
      item_count: number;
    }>;
  }
```

The three correlated subqueries each hit an existing index (`idx_observations_sdk_session` on `memory_session_id`, `idx_session_summaries_sdk_session` on `memory_session_id`, `idx_user_prompts_session` on `session_db_id`), so this stays fast at catalog scale.

- [ ] **Step 4: Update the frontend `SessionCatalogEntry` type**

In `src/ui/viewer/types.ts`, replace the `SessionCatalogEntry` interface (added in Task 7):

```typescript
export interface SessionCatalogEntry {
  content_session_id: string;
  project: string;
  platform_source: string;
  custom_title: string | null;
  started_at_epoch: number;
  item_count: number;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/session_store.test.ts`
Expected: PASS

- [ ] **Step 6: Type-check**

Run: `npm run typecheck`
Expected: no errors (nothing constructs a `SessionCatalogEntry` object literal yet — `useSSE.ts` doesn't touch it until Task 9 — so this is a safe additive type change).

- [ ] **Step 7: Commit**

```bash
git add src/services/sqlite/SessionStore.ts src/ui/viewer/types.ts tests/session_store.test.ts
git commit -m "feat(viewer): add item_count and custom_title to the session catalog"
```

---

### Task 9: `useSSE.ts` — live session catalog with count tracking

**Files:**
- Modify: `src/ui/viewer/hooks/useSSE.ts`

**Interfaces:**
- Consumes: the richer `SessionCatalogEntry` shape from Task 8.
- Produces: `useSSE()` return value gains `sessions: SessionCatalogEntry[]` and `removeSession: (contentSessionId: string) => void`, unchanged in shape from before, but the session list is now kept accurate as items stream in (a brand-new session starts at `item_count: 1`; a session already known has its count incremented, not duplicated). Consumed by Task 11 (`App.tsx`).

- [ ] **Step 1: Add `sessions` state, `touchSession`, and `removeSession`**

In `src/ui/viewer/hooks/useSSE.ts`, update the imports and add the new state (after line 10):

```typescript
import { useState, useEffect, useRef } from 'react';
import { Observation, Summary, UserPrompt, SessionCatalogEntry, StreamEvent } from '../types';
import { API_ENDPOINTS } from '../constants/api';
import { TIMING } from '../constants/timing';

export function useSSE() {
  const [observations, setObservations] = useState<Observation[]>([]);
  const [summaries, setSummaries] = useState<Summary[]>([]);
  const [prompts, setPrompts] = useState<UserPrompt[]>([]);
  const [projects, setProjects] = useState<string[]>([]);
  const [sessions, setSessions] = useState<SessionCatalogEntry[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [queueDepth, setQueueDepth] = useState(0);
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | undefined>(undefined);

  const addProjectIfNew = (project: string) => {
    setProjects(prev => prev.includes(project) ? prev : [...prev, project]);
  };

  const touchSession = (item: {
    content_session_id: string;
    project: string;
    platform_source: string;
    created_at_epoch: number;
  }) => {
    setSessions(prev => {
      const existingIndex = prev.findIndex(s => s.content_session_id === item.content_session_id);
      if (existingIndex === -1) {
        return [
          ...prev,
          {
            content_session_id: item.content_session_id,
            project: item.project,
            platform_source: item.platform_source,
            custom_title: null,
            started_at_epoch: item.created_at_epoch,
            item_count: 1
          }
        ];
      }
      const next = [...prev];
      next[existingIndex] = { ...next[existingIndex], item_count: next[existingIndex].item_count + 1 };
      return next;
    });
  };

  const removeSession = (contentSessionId: string) => {
    setSessions(prev => prev.filter(s => s.content_session_id !== contentSessionId));
  };
```

- [ ] **Step 2: Populate `sessions` from `initial_load` and touch on new items**

In the `eventSource.onmessage` switch (lines 50-89), update each case:

```typescript
        switch (data.type) {
          case 'initial_load':
            console.log('[SSE] Initial load:', {
              projects: data.projects?.length || 0,
              sessions: data.sessions?.length || 0
            });
            setProjects(data.projects || []);
            setSessions(data.sessions || []);
            break;

          case 'new_observation':
            if (data.observation) {
              console.log('[SSE] New observation:', data.observation.id);
              addProjectIfNew(data.observation.project);
              touchSession({
                content_session_id: data.observation.content_session_id,
                project: data.observation.project,
                platform_source: data.observation.platform_source || 'claude',
                created_at_epoch: data.observation.created_at_epoch
              });
              setObservations(prev => [data.observation!, ...prev]);
            }
            break;

          case 'new_summary':
            if (data.summary) {
              console.log('[SSE] New summary:', data.summary.id);
              addProjectIfNew(data.summary.project);
              touchSession({
                content_session_id: data.summary.session_id,
                project: data.summary.project,
                platform_source: data.summary.platform_source || 'claude',
                created_at_epoch: data.summary.created_at_epoch
              });
              setSummaries(prev => [data.summary!, ...prev]);
            }
            break;

          case 'new_prompt':
            if (data.prompt) {
              console.log('[SSE] New prompt:', data.prompt.id);
              addProjectIfNew(data.prompt.project);
              touchSession({
                content_session_id: data.prompt.content_session_id,
                project: data.prompt.project,
                platform_source: data.prompt.platform_source || 'claude',
                created_at_epoch: data.prompt.created_at_epoch
              });
              setPrompts(prev => [data.prompt!, ...prev]);
            }
            break;

          case 'processing_status':
            if (typeof data.isProcessing === 'boolean') {
              console.log('[SSE] Processing status:', data.isProcessing, 'Queue depth:', data.queueDepth);
              setIsProcessing(data.isProcessing);
              setQueueDepth(data.queueDepth || 0);
            }
            break;
        }
```

- [ ] **Step 3: Return `sessions` and `removeSession`**

Update the hook's return statement (lines 105-112):

```typescript
  return {
    observations,
    summaries,
    prompts,
    projects,
    sessions,
    removeSession,
    isProcessing,
    queueDepth
  };
}
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit -p src/ui/viewer/tsconfig.json`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/ui/viewer/hooks/useSSE.ts
git commit -m "feat(viewer): track live session catalog with item counts in useSSE"
```

---

### Task 10: `SessionCard.tsx` + `SessionCardMenu.tsx` components

Two new, self-contained presentational components — no wiring into `App.tsx` yet (that's Task 11). Both type-check standalone since their props are fully specified here.

**Files:**
- Create: `src/ui/viewer/components/SessionCard.tsx`
- Create: `src/ui/viewer/components/SessionCardMenu.tsx`
- Modify: `src/ui/viewer-template.html` (new CSS)

**Interfaces:**
- Consumes: `SessionCatalogEntry` (Task 8), `formatDate` from `src/ui/viewer/utils/formatters.ts` (existing).
- Produces: `<SessionCard session={SessionCatalogEntry} onOpen={() => void} onDelete={() => void} />`. Consumed by Task 11 (`App.tsx`).

- [ ] **Step 1: Create `SessionCardMenu.tsx`**

Create `src/ui/viewer/components/SessionCardMenu.tsx`:

```typescript
import React, { useEffect, useRef } from 'react';

interface SessionCardMenuProps {
  onClose: () => void;
  onOpen: () => void;
  onDelete: () => void;
}

export function SessionCardMenu({ onClose, onOpen, onDelete }: SessionCardMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  return (
    <div className="session-card-menu" ref={menuRef} onClick={e => e.stopPropagation()}>
      <button className="session-card-menu-item" onClick={() => { onClose(); onOpen(); }}>
        Open
      </button>
      <button className="session-card-menu-item session-card-menu-item--danger" onClick={() => { onClose(); onDelete(); }}>
        Delete
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Create `SessionCard.tsx`**

Create `src/ui/viewer/components/SessionCard.tsx`:

```typescript
import React, { useState } from 'react';
import { SessionCatalogEntry } from '../types';
import { formatDate } from '../utils/formatters';
import { SessionCardMenu } from './SessionCardMenu';

interface SessionCardProps {
  session: SessionCatalogEntry;
  onOpen: () => void;
  onDelete: () => void;
}

export function SessionCard({ session, onOpen, onDelete }: SessionCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const name = session.custom_title || session.project;
  const date = formatDate(session.started_at_epoch);
  const memoriesLabel = session.item_count === 1 ? '1 memory' : `${session.item_count} memories`;

  return (
    <div
      className="session-card"
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="session-card-header">
        <div className="session-card-title-group">
          <span className="session-card-name">{name}</span>
          <span className="session-card-id" title={session.content_session_id}>
            {session.content_session_id}
          </span>
        </div>
        <div className="session-card-actions">
          <span className="session-card-count">{memoriesLabel}</span>
          <button
            className="session-card-menu-trigger"
            onClick={e => {
              e.stopPropagation();
              setMenuOpen(prev => !prev);
            }}
            aria-label="Session actions"
            title="Session actions"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="12" cy="5" r="1.5"></circle>
              <circle cx="12" cy="12" r="1.5"></circle>
              <circle cx="12" cy="19" r="1.5"></circle>
            </svg>
          </button>
          {menuOpen && (
            <SessionCardMenu
              onClose={() => setMenuOpen(false)}
              onOpen={onOpen}
              onDelete={onDelete}
            />
          )}
        </div>
      </div>
      <div className="session-card-meta">
        <span className="session-card-project">{session.project}</span>
        <span className="session-card-date">{date}</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Add the CSS**

In `src/ui/viewer-template.html`, add this block right before the closing `</style>` tag:

```css
    .session-list {
      flex: 1;
      overflow-y: scroll;
      height: 100vh;
      padding: 24px 18px;
      display: flex;
      justify-content: center;
    }

    .session-list-content {
      max-width: 650px;
      width: 100%;
    }

    .session-card {
      background: var(--color-bg-card);
      border: 1px solid var(--color-border-primary);
      border-radius: 8px;
      padding: 16px 20px;
      margin-bottom: 12px;
      cursor: pointer;
      transition: all 0.15s ease;
      position: relative;
    }

    .session-card:hover {
      border-color: var(--color-border-focus);
      background: var(--color-bg-card-hover);
    }

    .session-card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .session-card-title-group {
      display: flex;
      align-items: baseline;
      gap: 10px;
      min-width: 0;
      flex: 1;
    }

    .session-card-name {
      font-weight: 600;
      font-size: 15px;
      color: var(--color-text-title);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .session-card-id {
      font-family: 'Monaspace Radon', 'Monaco', 'Menlo', monospace;
      font-size: 11px;
      color: var(--color-text-muted);
      opacity: 0.75;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .session-card-actions {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-shrink: 0;
      position: relative;
    }

    .session-card-count {
      font-size: 12px;
      color: var(--color-text-secondary);
      white-space: nowrap;
    }

    .session-card-menu-trigger {
      background: transparent;
      border: 1px solid transparent;
      border-radius: 6px;
      width: 28px;
      height: 28px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      color: var(--color-text-secondary);
      transition: all 0.15s ease;
    }

    .session-card-menu-trigger:hover {
      background: var(--color-bg-card-hover);
      border-color: var(--color-border-primary);
      color: var(--color-text-primary);
    }

    .session-card-menu {
      position: absolute;
      top: 100%;
      right: 0;
      margin-top: 4px;
      background: var(--color-bg-card);
      border: 1px solid var(--color-border-primary);
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      overflow: hidden;
      z-index: 10;
      min-width: 120px;
    }

    .session-card-menu-item {
      display: block;
      width: 100%;
      text-align: left;
      padding: 8px 14px;
      background: transparent;
      border: none;
      cursor: pointer;
      font-size: 13px;
      color: var(--color-text-primary);
    }

    .session-card-menu-item:hover {
      background: var(--color-bg-card-hover);
    }

    .session-card-menu-item--danger {
      color: #dc2626;
    }

    .session-card-menu-item--danger:hover {
      background: rgba(220, 38, 38, 0.1);
    }

    .session-card-meta {
      display: flex;
      gap: 12px;
      margin-top: 8px;
      font-size: 12px;
      color: var(--color-text-muted);
    }

    .session-detail-header {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 16px 24px;
      border-bottom: 1px solid var(--color-border-primary);
    }

    .session-detail-back {
      background: var(--color-bg-card);
      border: 1px solid var(--color-border-primary);
      border-radius: 6px;
      padding: 8px 14px;
      font-size: 13px;
      font-weight: 500;
      color: var(--color-text-secondary);
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .session-detail-back:hover {
      background: var(--color-bg-card-hover);
      border-color: var(--color-border-focus);
      color: var(--color-text-primary);
    }

    .session-detail-id {
      font-family: 'Monaspace Radon', 'Monaco', 'Menlo', monospace;
      font-size: 12px;
      color: var(--color-text-muted);
    }
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit -p src/ui/viewer/tsconfig.json`
Expected: no errors (both components are self-contained; nothing imports them yet, which is fine — an unused-export is not a type error).

- [ ] **Step 5: Commit**

```bash
git add src/ui/viewer/components/SessionCard.tsx src/ui/viewer/components/SessionCardMenu.tsx src/ui/viewer-template.html
git commit -m "feat(viewer): add SessionCard and SessionCardMenu components"
```

---

### Task 11: `App.tsx` routing + `SessionDetailPage.tsx`

The main view becomes a list of `SessionCard`s (project-filtered); opening one navigates (via `history.pushState`, `?session=<id>` in the URL) to a new `SessionDetailPage` that reuses the existing `Feed` unchanged, scoped to that session via the `contentSessionId` pagination filter (Task 2). This is where `App.tsx`'s current per-project pagination logic relocates to (scoped to a session instead), and where `SessionCard`/`SessionCardMenu` (Task 10) get wired in.

**Files:**
- Modify: `src/ui/viewer/hooks/usePagination.ts`
- Modify: `src/ui/viewer/App.tsx`
- Create: `src/ui/viewer/components/SessionDetailPage.tsx`

**Interfaces:**
- Consumes: `sessions`/`removeSession` from Task 9; `SessionCard`/`SessionCardMenu` from Task 10; `contentSessionId` pagination param from Task 2; `API_ENDPOINTS.SESSIONS` from Task 7; `Feed` (existing, unchanged).
- Produces: `SessionDetailPage({ contentSessionId, observations, summaries, prompts, onBack })` — a full page reusing `Feed`.

- [ ] **Step 1: Add session-filter awareness to `usePagination.ts`**

In `src/ui/viewer/hooks/usePagination.ts`, update `usePaginationFor` to accept and react to a second filter:

```typescript
function usePaginationFor<TItem extends DataItem>(
  endpoint: string,
  dataType: DataType,
  currentFilter: string,
  currentSessionFilter: string
) {
  const [state, setState] = useState<PaginationState>({
    isLoading: false,
    hasMore: true
  });

  const offsetRef = useRef(0);
  const lastSelectionKeyRef = useRef(`${currentFilter} ${currentSessionFilter}`);
  const stateRef = useRef(state);

  const loadMore = useCallback(async (): Promise<TItem[]> => {
    const selectionKey = `${currentFilter} ${currentSessionFilter}`;
    const filterChanged = lastSelectionKeyRef.current !== selectionKey;

    if (filterChanged) {
      offsetRef.current = 0;
      lastSelectionKeyRef.current = selectionKey;

      const newState = { isLoading: false, hasMore: true };
      setState(newState);
      stateRef.current = newState;
    }

    if (!filterChanged && (stateRef.current.isLoading || !stateRef.current.hasMore)) {
      return [];
    }

    stateRef.current = { ...stateRef.current, isLoading: true };
    setState(prev => ({ ...prev, isLoading: true }));

    const params = new URLSearchParams({
      offset: offsetRef.current.toString(),
      limit: UI.PAGINATION_PAGE_SIZE.toString()
    });

    if (currentFilter) {
      params.append('project', currentFilter);
    }
    if (currentSessionFilter) {
      params.append('contentSessionId', currentSessionFilter);
    }

    const response = await fetch(`${endpoint}?${params}`);

    if (!response.ok) {
      throw new Error(`Failed to load ${dataType}: ${response.statusText}`);
    }

    const data = await response.json() as { items: TItem[], hasMore: boolean };

    const nextState = {
      ...stateRef.current,
      isLoading: false,
      hasMore: data.hasMore
    };
    stateRef.current = nextState;

    setState(prev => ({
      ...prev,
      isLoading: false,
      hasMore: data.hasMore
    }));

    offsetRef.current += UI.PAGINATION_PAGE_SIZE;

    return data.items;
  }, [currentFilter, currentSessionFilter, endpoint, dataType]);

  return {
    ...state,
    loadMore
  };
}

export function usePagination(currentFilter: string, currentSessionFilter: string) {
  const observations = usePaginationFor<Observation>(API_ENDPOINTS.OBSERVATIONS, 'observations', currentFilter, currentSessionFilter);
  const summaries = usePaginationFor<Summary>(API_ENDPOINTS.SUMMARIES, 'summaries', currentFilter, currentSessionFilter);
  const prompts = usePaginationFor<UserPrompt>(API_ENDPOINTS.PROMPTS, 'prompts', currentFilter, currentSessionFilter);

  return {
    observations,
    summaries,
    prompts
  };
}
```

- [ ] **Step 2: Create `SessionDetailPage.tsx`**

Create `src/ui/viewer/components/SessionDetailPage.tsx`:

```typescript
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Feed } from './Feed';
import { usePagination } from '../hooks/usePagination';
import { Observation, Summary, UserPrompt } from '../types';
import { mergeAndDeduplicateByProject } from '../utils/data';

interface SessionDetailPageProps {
  contentSessionId: string;
  observations: Observation[];
  summaries: Summary[];
  prompts: UserPrompt[];
  onBack: () => void;
}

export function SessionDetailPage({ contentSessionId, observations, summaries, prompts, onBack }: SessionDetailPageProps) {
  const [paginatedObservations, setPaginatedObservations] = useState<Observation[]>([]);
  const [paginatedSummaries, setPaginatedSummaries] = useState<Summary[]>([]);
  const [paginatedPrompts, setPaginatedPrompts] = useState<UserPrompt[]>([]);

  const pagination = usePagination('', contentSessionId);

  const matchesSession = useCallback((item: { content_session_id?: string; session_id?: string }) => {
    const itemSessionId = item.content_session_id ?? item.session_id;
    return itemSessionId === contentSessionId;
  }, [contentSessionId]);

  const allObservations = useMemo(() => {
    const live = observations.filter(matchesSession);
    const paginated = paginatedObservations.filter(matchesSession);
    return mergeAndDeduplicateByProject(live, paginated);
  }, [observations, paginatedObservations, matchesSession]);

  const allSummaries = useMemo(() => {
    const live = summaries.filter(matchesSession);
    const paginated = paginatedSummaries.filter(matchesSession);
    return mergeAndDeduplicateByProject(live, paginated);
  }, [summaries, paginatedSummaries, matchesSession]);

  const allPrompts = useMemo(() => {
    const live = prompts.filter(matchesSession);
    const paginated = paginatedPrompts.filter(matchesSession);
    return mergeAndDeduplicateByProject(live, paginated);
  }, [prompts, paginatedPrompts, matchesSession]);

  const handleLoadMore = useCallback(async () => {
    try {
      const [newObservations, newSummaries, newPrompts] = await Promise.all([
        pagination.observations.loadMore(),
        pagination.summaries.loadMore(),
        pagination.prompts.loadMore()
      ]);

      if (newObservations.length > 0) {
        setPaginatedObservations(prev => [...prev, ...newObservations]);
      }
      if (newSummaries.length > 0) {
        setPaginatedSummaries(prev => [...prev, ...newSummaries]);
      }
      if (newPrompts.length > 0) {
        setPaginatedPrompts(prev => [...prev, ...newPrompts]);
      }
    } catch (error) {
      console.error('Failed to load more data:', error);
    }
  }, [pagination.observations, pagination.summaries, pagination.prompts]);

  useEffect(() => {
    setPaginatedObservations([]);
    setPaginatedSummaries([]);
    setPaginatedPrompts([]);
    handleLoadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentSessionId]);

  return (
    <>
      <div className="session-detail-header">
        <button className="session-detail-back" onClick={onBack}>
          ← Back to sessions
        </button>
        <span className="session-detail-id" title={contentSessionId}>{contentSessionId}</span>
      </div>
      <Feed
        observations={allObservations}
        summaries={allSummaries}
        prompts={allPrompts}
        onLoadMore={handleLoadMore}
        isLoading={pagination.observations.isLoading || pagination.summaries.isLoading || pagination.prompts.isLoading}
        hasMore={pagination.observations.hasMore || pagination.summaries.hasMore || pagination.prompts.hasMore}
      />
    </>
  );
}
```

- [ ] **Step 3: Rewrite `App.tsx`**

Replace the full contents of `src/ui/viewer/App.tsx`:

```typescript
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Header } from './components/Header';
import { SessionCard } from './components/SessionCard';
import { SessionDetailPage } from './components/SessionDetailPage';
import { ContextSettingsModal } from './components/ContextSettingsModal';
import { LogsDrawer } from './components/LogsModal';
import { WelcomeCard, getStoredWelcomeDismissed, setStoredWelcomeDismissed } from './components/WelcomeCard';
import { useSSE } from './hooks/useSSE';
import { useSettings } from './hooks/useSettings';
import { useTheme } from './hooks/useTheme';
import { SessionCatalogEntry } from './types';
import { API_ENDPOINTS } from './constants/api';

type Route = { view: 'list' } | { view: 'session'; contentSessionId: string };

function routeFromLocation(): Route {
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get('session');
  return sessionId ? { view: 'session', contentSessionId: sessionId } : { view: 'list' };
}

export function App() {
  const [currentFilter, setCurrentFilter] = useState('');
  const [contextPreviewOpen, setContextPreviewOpen] = useState(false);
  const [logsModalOpen, setLogsModalOpen] = useState(false);
  const [welcomeDismissed, setWelcomeDismissed] = useState<boolean>(getStoredWelcomeDismissed);
  const [route, setRoute] = useState<Route>(routeFromLocation);

  const { observations, summaries, prompts, projects, sessions, removeSession, isProcessing, queueDepth } = useSSE();
  const { settings, saveSettings, isSaving, saveStatus } = useSettings();
  const { preference, setThemePreference } = useTheme();

  useEffect(() => {
    const onPopState = () => setRoute(routeFromLocation());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (currentFilter && !projects.includes(currentFilter)) {
      setCurrentFilter('');
    }
  }, [projects, currentFilter]);

  const navigateToSession = useCallback((contentSessionId: string) => {
    const url = `${window.location.pathname}?session=${encodeURIComponent(contentSessionId)}`;
    window.history.pushState({}, '', url);
    setRoute({ view: 'session', contentSessionId });
  }, []);

  const navigateToList = useCallback(() => {
    window.history.pushState({}, '', window.location.pathname);
    setRoute({ view: 'list' });
  }, []);

  const handleDeleteSession = useCallback(async (session: SessionCatalogEntry) => {
    const confirmed = window.confirm(
      `Delete all content for session ${session.content_session_id}? This removes every observation, summary, and prompt from this session and cannot be undone.`
    );
    if (!confirmed) return;

    const params = `?platformSource=${encodeURIComponent(session.platform_source)}`;
    const response = await fetch(`${API_ENDPOINTS.SESSIONS}/${encodeURIComponent(session.content_session_id)}${params}`, {
      method: 'DELETE'
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      console.error('[Session Delete] Failed:', body);
      return;
    }
    removeSession(session.content_session_id);
  }, [removeSession]);

  const toggleContextPreview = useCallback(() => {
    setContextPreviewOpen(prev => !prev);
  }, []);

  const toggleLogsModal = useCallback(() => {
    setLogsModalOpen(prev => !prev);
  }, []);

  const visibleSessions = useMemo(() => {
    return sessions
      .filter(s => !currentFilter || s.project === currentFilter)
      .sort((a, b) => b.started_at_epoch - a.started_at_epoch);
  }, [sessions, currentFilter]);

  return (
    <>
      <Header
        projects={projects}
        currentFilter={currentFilter}
        onFilterChange={setCurrentFilter}
        isProcessing={isProcessing}
        queueDepth={queueDepth}
        themePreference={preference}
        onThemeChange={setThemePreference}
        onContextPreviewToggle={toggleContextPreview}
        onShowHelp={() => {
          setStoredWelcomeDismissed(false);
          setWelcomeDismissed(false);
        }}
      />

      {route.view === 'list' ? (
        <div className="session-list">
          <div className="session-list-content">
            {visibleSessions.map(session => (
              <SessionCard
                key={session.content_session_id}
                session={session}
                onOpen={() => navigateToSession(session.content_session_id)}
                onDelete={() => handleDeleteSession(session)}
              />
            ))}
            {visibleSessions.length === 0 && (
              <div style={{ textAlign: 'center', padding: '40px', color: '#8b949e' }}>
                No sessions to display
              </div>
            )}
          </div>
        </div>
      ) : (
        <SessionDetailPage
          contentSessionId={route.contentSessionId}
          observations={observations}
          summaries={summaries}
          prompts={prompts}
          onBack={navigateToList}
        />
      )}

      {!welcomeDismissed && (
        <WelcomeCard onDismiss={() => setWelcomeDismissed(true)} />
      )}

      <ContextSettingsModal
        isOpen={contextPreviewOpen}
        onClose={toggleContextPreview}
        settings={settings}
        onSave={saveSettings}
        isSaving={isSaving}
        saveStatus={saveStatus}
      />

      <button
        className="console-toggle-btn"
        onClick={toggleLogsModal}
        title="Toggle Console"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="4 17 10 11 4 5"></polyline>
          <line x1="12" y1="19" x2="20" y2="19"></line>
        </svg>
      </button>

      <LogsDrawer
        isOpen={logsModalOpen}
        onClose={toggleLogsModal}
      />
    </>
  );
}
```

Note what's gone from the old `App.tsx`: `paginatedObservations`/`paginatedSummaries`/`paginatedPrompts` state, the top-level `usePagination(currentFilter)` call, `matchesSelection`, and the `mergeAndDeduplicateByProject`-based `allObservations`/`allSummaries`/`allPrompts` — all of that relocated into `SessionDetailPage.tsx` (Step 2), scoped to one session instead of one project. `Header` no longer receives any session-related props — it's unchanged from before Task 9 ever touched it (project filter only).

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit -p src/ui/viewer/tsconfig.json`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/ui/viewer/hooks/usePagination.ts src/ui/viewer/App.tsx src/ui/viewer/components/SessionDetailPage.tsx
git commit -m "feat(viewer): replace card feed with session-card list + session detail page routing"
```

---

### Task 12: Build, sync, and manually verify in the live viewer

There is no automated frontend test harness in this repo for the viewer (Tasks 7-11 were verified via `tsc --noEmit` only). This task is the actual behavioral verification.

**Files:** none (build + manual verification only)

- [ ] **Step 1: Run the full backend test suite**

Run: `bun test`
Expected: PASS (everything from Tasks 1-8, plus no regressions elsewhere).

- [ ] **Step 2: Build and sync the plugin**

Run: `npm run build-and-sync`
Expected: builds successfully, restarts the worker, no build errors from the viewer bundle (esbuild) or the backend TypeScript.

- [ ] **Step 3: Open the viewer and verify the session list**

Open `http://localhost:37777` in a browser. Confirm the main view shows one card per session (not per observation/summary/prompt), each with a name (project name, unless a session has a custom title), its full session ID, and an "N memories" count. Confirm the existing project filter dropdown in the header still works and narrows the session-card list to one project.

- [ ] **Step 4: Verify navigation**

Click a session card's body (not the 3-dot menu) — confirm it navigates to a detail page showing that session's observation/summary/prompt cards (same look as the old feed), with a "← Back to sessions" button. Confirm the browser URL now reads `?session=<the-session-id>`. Click Back — confirm it returns to the session list and the URL loses the query param. Use the browser's back/forward buttons instead of the in-app Back button — confirm they also work. Reload the page while on a session's detail URL — confirm it opens directly into that session's detail page (not the list).

- [ ] **Step 5: Verify the 3-dot menu**

Click a session card's 3-dot button — confirm a small menu appears with "Open" and "Delete", and clicking elsewhere on the page (or pressing Escape) closes it without navigating or deleting. Click "Open" — confirm it navigates the same as clicking the card body.

- [ ] **Step 6: Verify delete**

Open a session card's 3-dot menu and click "Delete" — confirm a browser `confirm()` dialog appears naming the session. Cancel it — confirm nothing changes. Delete again and accept — confirm the session card disappears from the list without a page reload. Reload the page and confirm it still doesn't reappear (i.e. it was actually deleted from the database, not just hidden client-side).

- [ ] **Step 7: Verify live behavior**

Start a new Claude Code session in a project claude-mem is tracking, and let it produce at least one observation. Confirm a new session card appears in the list without reloading the viewer page, starting at "1 memory"; if that same session produces a second observation shortly after, confirm the existing card's count updates to "2 memories" instead of a duplicate card appearing.

- [ ] **Step 8: Report results**

If any manual check fails, note exactly which step and what was observed instead — do not mark this task complete on a failing check.

---

## Self-Review Notes

**Original plan (Tasks 1-7 execution):**
- **Spec coverage:** Every item from the originally approved design (`docs/superpowers/specs/2026-07-30-session-id-viewer-design.md`) was covered by the original Task 1-12 plan. Tasks 1-7 (backend + types) shipped exactly as planned and are unaffected by the mid-execution redesign below.
- **Placeholder scan:** no TBD/TODO markers; every step has complete, concrete code.
- **Type consistency:** `Observation.content_session_id`, `Summary.session_id`, `UserPrompt.content_session_id` are used consistently across `PaginationHelper` (Tasks 1-2), SSE payload types (Task 1), and `SessionCatalogEntry` (Tasks 7-8). `assertRowDeletable`/`commitRowDelete` signatures (Task 5) match their call sites in both `deleteSyncedContent` (Task 5) and the bulk handler (Task 6).

**Revised plan (Tasks 8-12, session-card + detail-page redesign):**
- **Spec coverage:** the user's revised request is covered end to end — session cards with name + full ID + count replacing the flat feed as the main view (Tasks 8, 10, 11), 3-dot menu with Open/Delete (Task 10), Open navigates via a real URL to a per-session detail page reusing the existing card components (Task 11), Delete reuses the existing confirm-then-`DELETE /api/sessions/:contentSessionId` flow (Task 11, backed by Task 6), project filter retained (Task 11), live SSE-driven session list including count updates (Tasks 8-9). Per the user's own fallback ("if we can't find an appropriate name we can skip that"), a name was found and used ("N memories") — no skip needed.
- **Placeholder scan:** no TBD/TODO markers in Tasks 8-12; every step has complete, concrete code including all CSS and full component/file bodies (`App.tsx` and `SessionDetailPage.tsx` given in full, not diffs, since the restructuring touches most of the file).
- **Type consistency:** the richer `SessionCatalogEntry` (Task 8: adds `custom_title`, `item_count`) is constructed consistently in exactly two places — `useSSE.ts`'s `touchSession` (Task 9, for live-streamed items, `item_count` starts at 1 and increments) and the backend `getAllSessions` SQL (Task 8, for the initial catalog and any full reload) — both produce the same six fields. `SessionCard`/`SessionCardMenu` (Task 10) and `App.tsx`/`SessionDetailPage` (Task 11) reference `SessionCatalogEntry` fields (`content_session_id`, `project`, `platform_source`, `custom_title`, `started_at_epoch`, `item_count`) consistently with the Task 8 definition. `usePagination`'s two-argument signature (Task 11) matches its only two call sites: unused in the new `App.tsx` (list view needs no pagination) and used in `SessionDetailPage.tsx` with `('', contentSessionId)`.
- **Scope check:** Task 12 (verification) was updated to check the new UX end to end rather than the old dropdown; nothing from the old Tasks 9-11 (dropdown, Header delete button, per-card badge) survives, and the plan's Architecture section explains why each piece was dropped or repurposed instead of silently vanishing.
