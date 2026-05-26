# Plan: Standing Directives for claude-mem (v13.3.0)

## Why (the one-line case)
Across 18,726 prompts over 7 months, the single loudest, most-repeated thing Alex wants is for
Claude to **stop forgetting the rules he keeps repeating**. claude-mem remembers WORK
(observations + summaries) but never the RULES. "Standing Directives" is a durable, first-class
layer of user rules that claude-mem captures once and re-injects at the **very top** of every
SessionStart context — so they survive `/clear`, survive context-fill (Oct #421: "at 35% context
claude forgets primary directives"), and survive Claude Code's ~2KB SessionStart truncation
(Apr #11384). It does for behavioral rules what the timeline did for work history.

## Implementer's standing rules (Alex's way — these govern the CODE, not just the feature)
- Happy path first. Fail LOUD. NO try/catch that swallows errors. NO `||` that masks missing
  values (use `??` only where a real default is correct). NO arbitrary delays. NO logic gates
  that can block a write. Detached/edge cases must not block the main path.
- KISS + DRY + YAGNI. Simplest thing that works. Share existing query/store/render code; never
  copy-paste it. Do NOT build auto-detection of directives, NLP, or extra UI. Not now.
- NO code comments. Delete cleanly; leave no commented-out code or "removed X" notes.
- Change only what the feature needs. Don't touch unrelated code.
- Directives block is FIRST in the injected context. Non-negotiable (truncation safety).
- Build/verify with `npm run build-and-sync`; confirm the worker restarts and `bun test` passes.

---

## Phase 0 — Documentation Discovery (DONE — consolidated, with sources)

**Stack:** bun:sqlite (`import { Database } from 'bun:sqlite'`), `.prepare(sql).run()/.get()/.all()`,
positional `?` binds, `RETURNING`. Express worker HTTP. Separate MCP process that reaches the
worker over HTTP. Tests: `bun test` (`npm run test:context`).

**Allowed APIs / patterns (cite when implementing):**
- Migration objects: `src/services/sqlite/migrations.ts` (migration001 lines 7–123 = CREATE TABLE
  + indexes template; migration002 lines 125–148 = ALTER template).
- Migration runner: `src/services/sqlite/migrations/runner.ts:15–41` (`runAllMigrations()` calls
  ordered private methods). Version recorded via
  `INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)` (SessionStore.ts:201).
  **Current max version = 32** (SessionStore.ts:1010 `addObservationsMetadataColumn`). Next = 33.
- Authoritative schema mirror: `src/services/sqlite/schema.sql` (table+index format at lines 28–83).
  Header says it is regenerated from migrations — keep in sync.
- Store INSERT w/ timestamps: SessionStore.ts:1709–1721 (user_prompts) and 1761–1807 (observations,
  `RETURNING id, created_at_epoch`). Timestamp idiom: `const epoch = Date.now();
  const iso = new Date(epoch).toISOString();`.
- Store SELECT by project + order: SessionStore.ts:1125–1139. UPDATE status + RETURNING:
  PendingMessageStore.ts:67–89.
- HTTP route registration: `src/services/worker/http/routes/SearchRoutes.ts:102–125`. GET handler
  example: SearchRoutes.ts:337–387. POST handler w/ Zod `validateBody`:
  `src/services/worker/http/routes/MemoryRoutes.ts:16–100`. Error wrapper:
  `BaseRouteHandler.ts:7–22` (`wrapHandler`, `badRequest`, `handleError`). Routes instantiated in
  `worker-service.ts:229–275` (`registerRoutes`) and registered via `Server.registerRoutes`.
- MCP tools: `src/servers/mcp-server.ts`. Tool def shape (name/description/inputSchema/handler):
  lines 459–481 (`search`) and 524–540 (`observation_add`). GET bridge `callWorkerAPI` lines
  65–109; POST bridge `callWorkerAPIPost` (~802–883). `TOOL_ENDPOINT_MAP` lines 65–. Tools array
  registered via `ListToolsRequestSchema`/`CallToolRequestSchema` (900–929). MCP→DB is via worker
  HTTP only (MCP is a separate process). Tool list documented in
  `plugin/skills/mem-search/SKILL.md`.
- Context assembly: `src/services/context/ContextBuilder.ts` — `buildContextOutput()` lines 64–99
  (output array; `renderHeader` pushed FIRST at line 77; `output.join('\n')` at 98);
  `generateContext()` lines 101–148 (`loadContextConfig()` at 105; queries at 123–128; early
  empty-state return after queries). Renderer shape: `sections/HeaderRenderer.ts:7–48` (returns
  `string[]`, branches on `forHuman` to Agent/Human formatters). Queries:
  `ObservationCompiler.ts:18–86` (`db.db.prepare(...).all(...)`).
- Config: `src/services/context/ContextConfigLoader.ts:6–29` (settings→ContextConfig; `parseInt`
  for counts, `=== 'true'` for bools). `ContextConfig` type in `src/services/context/types.ts`.
- Settings: `src/shared/SettingsDefaultsManager.ts` — interface lines 6–79, DEFAULTS 82–155
  (context keys at 106–115). All values are strings.
- Tests: `tests/context/observation-compiler.test.ts:1–45` (bun:test, fixtures + describe/it/expect).

**Anti-patterns to avoid:** inventing a `migrate()` helper that doesn't exist; using better-sqlite3
API; named binds; adding a `status` enum CHECK that rejects rows on the write path; querying the DB
directly from the MCP process; rendering directives anywhere but first.

---

## Phase 1 — Schema + migration + store CRUD

**Files:** `src/services/sqlite/migrations/runner.ts`, `src/services/sqlite/SessionStore.ts`,
`src/services/sqlite/schema.sql`.

1. Add a private method on the migration runner / SessionStore, modeled on the v32 method
   (`addObservationsMetadataColumn`), named `addDirectivesTable()`:
   ```sql
   CREATE TABLE IF NOT EXISTS directives (
     id                INTEGER PRIMARY KEY AUTOINCREMENT,
     scope             TEXT    NOT NULL DEFAULT 'global',
     project           TEXT,
     content           TEXT    NOT NULL,
     status            TEXT    NOT NULL DEFAULT 'active',
     source            TEXT    NOT NULL DEFAULT 'manual',
     created_at        TEXT    NOT NULL,
     created_at_epoch  INTEGER NOT NULL,
     updated_at_epoch  INTEGER NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_directives_status_project
     ON directives(status, project);
   CREATE INDEX IF NOT EXISTS idx_directives_status_scope
     ON directives(status, scope, created_at_epoch DESC);
   ```
   Guard with the version check used elsewhere (skip if version 33 already in `schema_versions`),
   run the DDL, then `INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (33, ?)`.
   Invoke it in `runAllMigrations()` after the v32 call. Do NOT add a CHECK constraint that could
   reject a write (fail-loud at the app layer, not by silently dropping rows).
2. Mirror the table + indexes into `schema.sql` (same format as the observations block).
3. Add three methods to `SessionStore` (single source of truth; context read path reuses #c):
   - a) `addDirective(content: string, scope: 'global'|'project', project: string | null): { id: number }`
     — `const epoch = Date.now(); const iso = new Date(epoch).toISOString();` INSERT ...
     `RETURNING id`. `project` is NULL when scope is 'global'.
   - b) `archiveDirective(id: number): { id: number } | null` — `UPDATE directives SET
     status='archived', updated_at_epoch=? WHERE id=? RETURNING id`.
   - c) `listActiveDirectives(projects: string[], limit: number): Directive[]` —
     `SELECT * FROM directives WHERE status='active' AND (scope='global' OR project IN (<?>))
     ORDER BY created_at_epoch ASC LIMIT ?`. Build the `IN` placeholder list like
     ObservationCompiler does. Globals always included even when `projects` is empty.

**Verify:** `sqlite3 ~/.claude-mem/claude-mem.db ".schema directives"` shows table + both indexes
after worker start; `SELECT version FROM schema_versions WHERE version=33` returns a row.

**Anti-pattern guards:** no `||` defaults on `content` (a missing content is a real error — throw);
no try/catch around the INSERT that swallows; do not duplicate the SELECT in the read path (Phase 4
calls `listActiveDirectives`).

---

## Phase 2 — Worker HTTP routes

**Files:** new `src/services/worker/http/routes/DirectiveRoutes.ts` (mirror `MemoryRoutes.ts`),
`src/services/worker/worker-service.ts` (register).

Endpoints (DirectiveRoutes extends BaseRouteHandler, ctor takes the `SessionStore`/`DatabaseManager`):
- `POST /api/directive/add` — Zod `validateBody` schema `{ content: string (min 1), scope?:
  'global'|'project' (default 'global'), project?: string }`. If scope is 'project', `project` is
  required → `badRequest` if missing. Calls `store.addDirective(...)`. Returns
  `res.json({ success: true, id, content, scope, project })`.
- `GET /api/directive/list?projects=a,b` — parse `projects` like `handleContextInject` (split/trim),
  default to all when absent; calls `store.listActiveDirectives(projects, max)`; `res.json({
  directives })`.
- `POST /api/directive/archive` — body `{ id: number }`; calls `store.archiveDirective(id)`;
  `res.json({ success: true, id })` or `badRequest` if not found.

Register in `worker-service.ts registerRoutes()` next to the SearchRoutes/MemoryRoutes block:
`this.server.registerRoutes(new DirectiveRoutes(this.dbManager.getSessionStore()))`.

**Verify:** `curl -XPOST 127.0.0.1:$PORT/api/directive/add -d '{"content":"read files in full,
never grep","scope":"global"}'` → JSON with an id; `curl '127.0.0.1:$PORT/api/directive/list'`
shows it. Use the wrapHandler error path (errors surface, not swallowed).

**Anti-pattern guards:** reuse `wrapHandler`/`badRequest`/`handleError`; no new error handling
abstraction; no fallback that returns success on failure.

---

## Phase 3 — MCP tools + capture instruction

**Files:** `src/servers/mcp-server.ts`, `plugin/skills/mem-search/SKILL.md`.

1. Add to `TOOL_ENDPOINT_MAP`: `'directive_list': '/api/directive/list'`. For the two writes, use
   the existing POST bridge (`callWorkerAPIPost`) to `/api/directive/add` and `/api/directive/archive`.
2. Add three tool defs to the `tools` array (mirror `search` and `observation_add` shapes):
   - `directive_add` — desc: "Save a STANDING DIRECTIVE (a durable user rule) that re-injects at the
     top of every future session. Use when the user states a lasting rule ('always…', 'never…',
     'from now on…', 'stop doing…'). Params: content (required), scope ('global'|'project', default
     global), project (required if scope=project)." `required: ['content']`.
   - `directive_list` — desc: "List active standing directives. Params: projects (comma-sep, optional)."
   - `directive_archive` — desc: "Archive (deactivate) a standing directive by id. Params: id (required)."
3. In `plugin/skills/mem-search/SKILL.md`, add one short subsection: "Capturing standing directives
   — when the user states a durable rule about how you should work, call `directive_add` once. They
   re-inject at the top of every session." (No auto-detection logic; this is guidance only.)

**Verify:** restart MCP; `directive_add` then `directive_list` round-trips; `directive_list` shows
in the tool list. (User restarts the MCP; note that in the do-phase handoff.)

**Anti-pattern guards:** MCP must not touch SQLite directly — route through the worker HTTP API like
every other tool.

---

## Phase 4 — Inject at the TOP of SessionStart context

**Files:** new `src/services/context/sections/DirectivesRenderer.ts`, new formatter funcs in
`src/services/context/formatters/AgentFormatter.ts` + `HumanFormatter.ts`,
`src/services/context/types.ts`, `src/services/context/ContextConfigLoader.ts`,
`src/services/context/ContextBuilder.ts`, `src/shared/SettingsDefaultsManager.ts`.

1. Settings (`SettingsDefaultsManager.ts`): add to interface + DEFAULTS (after
   `CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT`):
   `CLAUDE_MEM_CONTEXT_SHOW_DIRECTIVES: 'true'`, `CLAUDE_MEM_CONTEXT_DIRECTIVES_MAX: '25'`.
2. `types.ts ContextConfig`: add `showDirectives: boolean; directivesMax: number;`.
3. `ContextConfigLoader.ts`: add `showDirectives: settings.CLAUDE_MEM_CONTEXT_SHOW_DIRECTIVES ===
   'true'` and `directivesMax: parseInt(settings.CLAUDE_MEM_CONTEXT_DIRECTIVES_MAX, 10)`.
4. `DirectivesRenderer.ts`: `renderDirectives(directives: Directive[], config: ContextConfig,
   forHuman: boolean): string[]` → returns `[]` when `!config.showDirectives` or
   `directives.length === 0`; else a compact block, FIRST in output:
   ```
   ⚡ STANDING DIRECTIVES — always apply, you committed to these:
   1. read files in full, never grep
   2. happy path first; fail loud, no swallowed errors
   …
   (trailing '')
   ```
   Branch `forHuman` to Agent/Human formatter funcs (numbered list; agent variant plain, human
   variant may color). Mirror HeaderRenderer style.
5. `ContextBuilder.ts`:
   - `generateContext()`: after the obs/summaries queries, add
     `const directives = config.showDirectives ? db.listActiveDirectives(projects, config.directivesMax) : [];`
     Pass `directives` into `buildContextOutput`.
   - **Empty-state fix:** the early `renderEmptyState` return (when obs & summaries are both empty)
     must STILL show directives. Change: if `directives.length > 0`, prepend
     `renderDirectives(...)` to the empty-state output instead of bailing without them.
   - `buildContextOutput()`: make the **first** push `output.push(...renderDirectives(directives,
     config, forHuman));` — BEFORE `renderHeader` at line 77. Add `directives` as a new param.

**Verify:** `node` invoke the context generator / `curl '/api/context/inject?projects=claude-mem'`
shows the ⚡ STANDING DIRECTIVES block as the FIRST lines, above the header/timeline, for both
`colors=true` and default. Toggling `CLAUDE_MEM_CONTEXT_SHOW_DIRECTIVES=false` removes it.

**Anti-pattern guards:** directives query is read-only and reuses `listActiveDirectives` (no dup
SELECT); no truncation of directive content; block must be position 0 in `output`.

---

## Phase 5 — Tests + build + ship-readiness

**Files:** `tests/context/directives-renderer.test.ts`, `tests/sqlite/directives-store.test.ts`
(mirror existing test files), plus a context-ordering assertion.

1. Store test (in-memory bun:sqlite): add → list (active only, globals always included) → archive →
   list excludes archived. Migration creates the table + indexes.
2. Renderer test: `showDirectives=false` → `[]`; empty directives → `[]`; N directives → numbered
   block with trailing ''; forHuman true/false branches.
3. Ordering test: build context with ≥1 directive + ≥1 observation; assert the directives block is
   the first non-empty line group (index 0) — proves truncation safety.
4. `npm run test:context` and the new sqlite test pass. Then `npm run build-and-sync`; confirm the
   worker restarts cleanly and a real SessionStart injection shows directives first.

**Verify (final):** grep the diff for anti-patterns: no new `catch {}`/swallowed catches in the
added files, no `||` masking on required fields, no code comments in new files. Confirm version
bumped to 33 and `schema.sql` matches the migration.

---

## Out of scope (YAGNI — explicitly deferred)
- Auto-detection of directives from natural language (fragile; the agent calls `directive_add`).
- Viewer UI for managing directives (HTTP API is enough for now; viewer is a fast-follow).
- A `/remember` plugin slash command (nice-to-have; the MCP tool + SKILL.md guidance suffices).
- Per-directive priority/ordering beyond created order. Overconfidence-flagging (#15993) and
  "insights mode" PreToolUse nudges (#16026) — adjacent features, separate plans.
