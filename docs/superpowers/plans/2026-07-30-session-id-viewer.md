# Session ID Display, Filter, and Delete — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each card's session ID in the viewer, add a session filter dropdown next to the existing project filter, and let the user delete all content (observations, summaries, prompts, and the session row itself) for a selected session.

**Architecture:** The canonical session key used for filtering/deletion is `content_session_id` (the Claude Code CLI session id), not `sdk_sessions.id`. This deviates from the committed spec (`docs/superpowers/specs/2026-07-30-session-id-viewer-design.md`), which proposed the numeric `sdk_sessions.id`. During planning it became clear the numeric id can't flow through live SSE events without extra plumbing (observations/summaries/prompts don't carry it, and there's no cheap way to add it without a join per live event), whereas `content_session_id` is **already present** on every summary and prompt row today, and only needs one additional SELECT column for observations (`sdk_sessions` is already joined in that query). This keeps the approved UX identical (native `<select>`, full ID on cards, 8-char truncation in the dropdown, confirm-before-delete, live SSE-backed session list matching the project list) while requiring less new plumbing and no risk of a delete button referencing a session id the frontend never received.

**Tech Stack:** Bun, TypeScript, Express, bun:sqlite, React (function components), esbuild. Backend tests use `bun:test` under `tests/`. There is no frontend component test setup in this repo (no RTL/vitest) — frontend tasks are verified by building and manually exercising the dev viewer (final task).

## Global Constraints

- Session ID display: full ID on cards (all three card types), first-8-characters + hover-title in the session filter dropdown.
- Session filter is a native `<select>`, matching the existing project filter exactly (not a custom dropdown).
- Deleting a session removes ALL its content (observations, summaries, prompts) AND the `sdk_sessions` row itself.
- Session delete requires a confirmation dialog before proceeding.
- The session list is populated live via SSE (initial full catalog + incremental additions), mirroring the existing project list — never a one-off fetch that goes stale.
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

### Task 8: `useSSE.ts` — live session catalog

**Files:**
- Modify: `src/ui/viewer/hooks/useSSE.ts`

**Interfaces:**
- Consumes: `SessionCatalogEntry`, `StreamEvent.sessions` from Task 7.
- Produces: `useSSE()` return value gains `sessions: SessionCatalogEntry[]` and `removeSession: (contentSessionId: string) => void`. Consumed by Task 9 (`App.tsx`).

- [ ] **Step 1: Add `sessions` state, `addSessionIfNew`, and `removeSession`**

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

  const addSessionIfNew = (entry: SessionCatalogEntry) => {
    setSessions(prev => prev.some(s => s.content_session_id === entry.content_session_id) ? prev : [...prev, entry]);
  };

  const removeSession = (contentSessionId: string) => {
    setSessions(prev => prev.filter(s => s.content_session_id !== contentSessionId));
  };
```

- [ ] **Step 2: Populate `sessions` from `initial_load` and append on new items**

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
              addSessionIfNew({
                content_session_id: data.observation.content_session_id,
                project: data.observation.project,
                platform_source: data.observation.platform_source || 'claude',
                started_at_epoch: data.observation.created_at_epoch
              });
              setObservations(prev => [data.observation!, ...prev]);
            }
            break;

          case 'new_summary':
            if (data.summary) {
              console.log('[SSE] New summary:', data.summary.id);
              addProjectIfNew(data.summary.project);
              addSessionIfNew({
                content_session_id: data.summary.session_id,
                project: data.summary.project,
                platform_source: data.summary.platform_source || 'claude',
                started_at_epoch: data.summary.created_at_epoch
              });
              setSummaries(prev => [data.summary!, ...prev]);
            }
            break;

          case 'new_prompt':
            if (data.prompt) {
              console.log('[SSE] New prompt:', data.prompt.id);
              addProjectIfNew(data.prompt.project);
              addSessionIfNew({
                content_session_id: data.prompt.content_session_id,
                project: data.prompt.project,
                platform_source: data.prompt.platform_source || 'claude',
                started_at_epoch: data.prompt.created_at_epoch
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
git commit -m "feat(viewer): track live session catalog in useSSE"
```

---

### Task 9: `usePagination.ts` + `App.tsx` — session filter wiring

**Files:**
- Modify: `src/ui/viewer/hooks/usePagination.ts`
- Modify: `src/ui/viewer/App.tsx`

**Interfaces:**
- Consumes: `sessions`/`removeSession` from Task 8; `contentSessionId` pagination param from Task 2; `API_ENDPOINTS.SESSIONS` from Task 7.
- Produces: `App.tsx` state `currentSessionFilter`, `isDeletingSession`, handler `handleSessionFilterChange`, `handleDeleteSession` — consumed by Task 10 (`Header.tsx` props).

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
  const lastSelectionKeyRef = useRef(`${currentFilter} ${currentSessionFilter}`);
  const stateRef = useRef(state);

  const loadMore = useCallback(async (): Promise<TItem[]> => {
    const selectionKey = `${currentFilter} ${currentSessionFilter}`;
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

- [ ] **Step 2: Wire session state, filtering, and delete into `App.tsx`**

In `src/ui/viewer/App.tsx`, update state, `matchesSelection`, `usePagination` call, the filter-reset effect, and add the delete handler:

```typescript
export function App() {
  const [currentFilter, setCurrentFilter] = useState('');
  const [currentSessionFilter, setCurrentSessionFilter] = useState('');
  const [isDeletingSession, setIsDeletingSession] = useState(false);
  const [contextPreviewOpen, setContextPreviewOpen] = useState(false);
  const [logsModalOpen, setLogsModalOpen] = useState(false);
  const [welcomeDismissed, setWelcomeDismissed] = useState<boolean>(getStoredWelcomeDismissed);
  const [paginatedObservations, setPaginatedObservations] = useState<Observation[]>([]);
  const [paginatedSummaries, setPaginatedSummaries] = useState<Summary[]>([]);
  const [paginatedPrompts, setPaginatedPrompts] = useState<UserPrompt[]>([]);

  const { observations, summaries, prompts, projects, sessions, removeSession, isProcessing, queueDepth } = useSSE();
  const { settings, saveSettings, isSaving, saveStatus } = useSettings();
  const { preference, setThemePreference } = useTheme();
  const pagination = usePagination(currentFilter, currentSessionFilter);

  const matchesSelection = useCallback((item: { project: string; content_session_id?: string; session_id?: string }) => {
    const projectMatches = !currentFilter || item.project === currentFilter;
    const itemSessionId = item.content_session_id ?? item.session_id;
    const sessionMatches = !currentSessionFilter || itemSessionId === currentSessionFilter;
    return projectMatches && sessionMatches;
  }, [currentFilter, currentSessionFilter]);

  useEffect(() => {
    if (currentFilter && !projects.includes(currentFilter)) {
      setCurrentFilter('');
    }
  }, [projects, currentFilter]);

  useEffect(() => {
    if (currentSessionFilter && !sessions.some(s => s.content_session_id === currentSessionFilter)) {
      setCurrentSessionFilter('');
    }
  }, [sessions, currentSessionFilter]);
```

Update the reset-on-filter-change effect (previously `}, [currentFilter]);`):

```typescript
  useEffect(() => {
    setPaginatedObservations([]);
    setPaginatedSummaries([]);
    setPaginatedPrompts([]);
    handleLoadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFilter, currentSessionFilter]);
```

Add the delete handler (after `toggleLogsModal`, before `handleLoadMore` or anywhere in the component body before the `return`):

```typescript
  const handleDeleteSession = useCallback(async () => {
    if (!currentSessionFilter) return;
    const entry = sessions.find(s => s.content_session_id === currentSessionFilter);
    const label = entry ? `${entry.project} (${currentSessionFilter.slice(0, 8)})` : currentSessionFilter;
    const confirmed = window.confirm(
      `Delete all content for session ${label}? This removes every observation, summary, and prompt from this session and cannot be undone.`
    );
    if (!confirmed) return;

    setIsDeletingSession(true);
    try {
      const params = entry ? `?platformSource=${encodeURIComponent(entry.platform_source)}` : '';
      const response = await fetch(`${API_ENDPOINTS.SESSIONS}/${encodeURIComponent(currentSessionFilter)}${params}`, {
        method: 'DELETE'
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        console.error('[Session Delete] Failed:', body);
        return;
      }
      removeSession(currentSessionFilter);
      setCurrentSessionFilter('');
    } finally {
      setIsDeletingSession(false);
    }
  }, [currentSessionFilter, sessions, removeSession]);
```

Add the `API_ENDPOINTS` import at the top of `App.tsx` (it isn't imported there yet):

```typescript
import { API_ENDPOINTS } from './constants/api';
```

Finally, pass the new props to `<Header />` (Task 10 adds them to `HeaderProps`):

```typescript
      <Header
        projects={projects}
        currentFilter={currentFilter}
        onFilterChange={setCurrentFilter}
        sessions={sessions}
        currentSessionFilter={currentSessionFilter}
        onSessionFilterChange={setCurrentSessionFilter}
        onDeleteSession={handleDeleteSession}
        isDeletingSession={isDeletingSession}
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
```

Also update the three `allObservations`/`allSummaries`/`allPrompts` `useMemo` dependency arrays — they already depend on `matchesSelection`, which now also depends on `currentSessionFilter`, so no further change is needed there (the existing `[observations, paginatedObservations, matchesSelection]` etc. dependency arrays pick it up transitively through the `matchesSelection` reference changing).

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit -p src/ui/viewer/tsconfig.json`
Expected: errors referencing `HeaderProps` not yet accepting the new props — expected until Task 10. Confirm the *only* errors are in `App.tsx`'s `<Header ... />` call about excess/missing props on `HeaderProps`, nothing else.

- [ ] **Step 4: Commit**

```bash
git add src/ui/viewer/hooks/usePagination.ts src/ui/viewer/App.tsx
git commit -m "feat(viewer): wire session filter state, pagination, and delete handler into App"
```

---

### Task 10: `Header.tsx` — session dropdown + delete button

**Files:**
- Modify: `src/ui/viewer/components/Header.tsx`
- Modify: `src/ui/viewer-template.html` (delete button styling)

**Interfaces:**
- Consumes: `sessions`, `currentSessionFilter`, `onSessionFilterChange`, `onDeleteSession`, `isDeletingSession` props from Task 9.

- [ ] **Step 1: Extend `HeaderProps` and render the session dropdown + delete button**

In `src/ui/viewer/components/Header.tsx`, update imports and props:

```typescript
import React from 'react';
import { ThemeToggle } from './ThemeToggle';
import { ThemePreference } from '../hooks/useTheme';
import { GitHubStarsButton } from './GitHubStarsButton';
import { useSpinningFavicon } from '../hooks/useSpinningFavicon';
import { SessionCatalogEntry } from '../types';

interface HeaderProps {
  projects: string[];
  currentFilter: string;
  onFilterChange: (filter: string) => void;
  sessions: SessionCatalogEntry[];
  currentSessionFilter: string;
  onSessionFilterChange: (sessionId: string) => void;
  onDeleteSession: () => void;
  isDeletingSession: boolean;
  isProcessing: boolean;
  queueDepth: number;
  themePreference: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  onContextPreviewToggle: () => void;
  onShowHelp?: () => void;
}

export function Header({
  projects,
  currentFilter,
  onFilterChange,
  sessions,
  currentSessionFilter,
  onSessionFilterChange,
  onDeleteSession,
  isDeletingSession,
  isProcessing,
  queueDepth,
  themePreference,
  onThemeChange,
  onContextPreviewToggle,
  onShowHelp
}: HeaderProps) {
```

Render the session `<select>` and delete button right after the existing project `<select>` (after line 91, `</select>`, before `<ThemeToggle`):

```typescript
        <select
          value={currentFilter}
          onChange={e => onFilterChange(e.target.value)}
        >
          <option value="">All Projects</option>
          {projects.map(project => (
            <option key={project} value={project}>{project}</option>
          ))}
        </select>
        <select
          value={currentSessionFilter}
          onChange={e => onSessionFilterChange(e.target.value)}
        >
          <option value="">All Sessions</option>
          {sessions.map(session => (
            <option
              key={session.content_session_id}
              value={session.content_session_id}
              title={session.content_session_id}
            >
              {session.content_session_id.slice(0, 8)} · {session.project}
            </option>
          ))}
        </select>
        <button
          className="settings-btn danger"
          onClick={onDeleteSession}
          disabled={!currentSessionFilter || isDeletingSession}
          title={currentSessionFilter ? 'Delete this session' : 'Select a session to delete'}
          aria-label="Delete selected session"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            <line x1="10" y1="11" x2="10" y2="17"></line>
            <line x1="14" y1="11" x2="14" y2="17"></line>
          </svg>
        </button>
        <ThemeToggle
          preference={themePreference}
          onThemeChange={onThemeChange}
        />
```

- [ ] **Step 2: Style the disabled and danger-hover states for the delete button**

In `src/ui/viewer-template.html`, add right after the `.settings-btn.active` rule (after line 429):

```css
    .settings-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
      transform: none;
      box-shadow: none;
    }

    .settings-btn.danger:hover:not(:disabled) {
      background: rgba(220, 38, 38, 0.1);
      border-color: rgba(220, 38, 38, 0.4);
      color: #dc2626;
    }
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit -p src/ui/viewer/tsconfig.json`
Expected: no errors (this resolves the `HeaderProps` mismatch flagged at the end of Task 9).

- [ ] **Step 4: Commit**

```bash
git add src/ui/viewer/components/Header.tsx src/ui/viewer-template.html
git commit -m "feat(viewer): add session filter dropdown and delete button to Header"
```

---

### Task 11: Card badges — session ID on Observation/Summary/Prompt cards

**Files:**
- Modify: `src/ui/viewer/components/ObservationCard.tsx`
- Modify: `src/ui/viewer/components/SummaryCard.tsx`
- Modify: `src/ui/viewer/components/PromptCard.tsx`
- Modify: `src/ui/viewer-template.html` (`.card-session-id` / `.summary-session-id-badge` styles)

**Interfaces:**
- Consumes: `Observation.content_session_id` (Task 1), `Summary.session_id` and `UserPrompt.content_session_id` (already existed).

- [ ] **Step 1: Add the badge to `ObservationCard.tsx`**

In `src/ui/viewer/components/ObservationCard.tsx`, add the badge to `.card-header-left` (after the `card-project` span, before the `merged_into_project` block, i.e. after line 51):

```typescript
          <span className="card-project">{observation.project}</span>
          <span className="card-session-id" title={observation.content_session_id}>
            {observation.content_session_id}
          </span>
          {observation.merged_into_project && (
```

- [ ] **Step 2: Add the badge to `SummaryCard.tsx`**

In `src/ui/viewer/components/SummaryCard.tsx`, add to `.summary-badge-row` (after the `summary-project-badge` span, i.e. after line 27):

```typescript
          <span className="summary-project-badge">{summary.project}</span>
          <span className="summary-session-id-badge" title={summary.session_id}>
            {summary.session_id}
          </span>
        </div>
```

- [ ] **Step 3: Add the badge to `PromptCard.tsx`**

In `src/ui/viewer/components/PromptCard.tsx`, add to `.card-header-left` (after the `card-project` span, i.e. after line 20):

```typescript
          <span className="card-project">{prompt.project}</span>
          <span className="card-session-id" title={prompt.content_session_id}>
            {prompt.content_session_id}
          </span>
        </div>
```

- [ ] **Step 4: Add the CSS**

In `src/ui/viewer-template.html`, add right after the `.card-merged-badge` rule (after line 850):

```css
    .card-session-id {
      color: var(--color-text-muted);
      font-size: 9px;
      opacity: 0.75;
      font-family: 'Monaspace Radon', 'Monaco', 'Menlo', monospace;
    }
```

Add right after the `[data-theme="dark"] .summary-project-badge` rule (after line 912):

```css
    .summary-session-id-badge {
      font-family: 'Monaspace Radon', 'Monaco', 'Menlo', monospace;
      font-size: 9px;
      color: var(--color-text-muted);
      opacity: 0.75;
    }
```

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit -p src/ui/viewer/tsconfig.json`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/ui/viewer/components/ObservationCard.tsx src/ui/viewer/components/SummaryCard.tsx src/ui/viewer/components/PromptCard.tsx src/ui/viewer-template.html
git commit -m "feat(viewer): display session ID badge on observation, summary, and prompt cards"
```

---

### Task 12: Build, sync, and manually verify in the live viewer

There is no automated frontend test harness in this repo for the viewer (Tasks 7-11 were verified via `tsc --noEmit` only). This task is the actual behavioral verification.

**Files:** none (build + manual verification only)

- [ ] **Step 1: Run the full backend test suite**

Run: `bun test`
Expected: PASS (everything from Tasks 1-6, plus no regressions elsewhere).

- [ ] **Step 2: Build and sync the plugin**

Run: `npm run build-and-sync`
Expected: builds successfully, restarts the worker, no build errors from the viewer bundle (esbuild) or the backend TypeScript.

- [ ] **Step 3: Open the viewer and verify session IDs render**

Open `http://localhost:37777` in a browser. For each of an observation card, a summary card, and a prompt card: confirm a small session-ID badge is visible next to the project badge, and that it's the full ID (not truncated).

- [ ] **Step 4: Verify the session filter dropdown**

Confirm a second dropdown ("All Sessions") appears next to the project dropdown, with entries labeled as `xxxxxxxx · project-name` (8-char prefix). Hover an option and confirm the browser tooltip shows the full session ID. Select a session and confirm the feed narrows to only that session's cards. Select a project AND a session together and confirm both filters apply (AND, not OR).

- [ ] **Step 5: Verify delete**

With no session selected, confirm the trash-icon button next to the session dropdown is disabled. Select a session, click delete, confirm the browser `confirm()` dialog appears naming the session. Cancel it — confirm nothing changes. Click delete again and accept — confirm the cards for that session disappear from the feed, the session filter resets to "All Sessions", and the deleted session's entry is gone from the dropdown without a page reload. Reload the page and confirm the session still doesn't reappear (i.e. it was actually deleted from the database, not just hidden client-side).

- [ ] **Step 6: Verify live behavior**

Start a new Claude Code session in a project claude-mem is tracking, and let it produce at least one observation. Confirm the new session appears in the session dropdown without reloading the viewer page (live SSE-driven addition, matching how new projects already appear live).

- [ ] **Step 7: Report results**

If any manual check fails, note exactly which step and what was observed instead — do not mark this task complete on a failing check.

---

## Self-Review Notes

- **Spec coverage:** Every item from the approved design (`docs/superpowers/specs/2026-07-30-session-id-viewer-design.md`) is covered: card display (Task 11), session filter dropdown behaving like the project filter (Tasks 9-10), delete button next to the dropdown with confirmation (Tasks 9-10, 6), deletes all content + the `sdk_sessions` row (Task 6), live SSE-backed session list (Tasks 4, 8). The one deliberate deviation (canonical key is `content_session_id`, not `sdk_sessions.id`) is called out in the Architecture section and does not change any user-facing behavior described in the spec.
- **Placeholder scan:** no TBD/TODO markers; every step has complete, concrete code.
- **Type consistency:** `Observation.content_session_id`, `Summary.session_id`, `UserPrompt.content_session_id` are used consistently across PaginationHelper (Tasks 1-2), SSE payload types (Task 1), `useSSE.ts` (Task 8), `App.tsx`'s `matchesSelection` (Task 9), and the three card components (Task 11). `assertRowDeletable`/`commitRowDelete` signatures (Task 5) match their call sites in both `deleteSyncedContent` (Task 5) and the bulk handler (Task 6).
