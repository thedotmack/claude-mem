# Plan 11: http-server-routes (clean)

Implements flowchart §3.9 of `PATHFINDER-2026-04-21/05-clean-flowcharts.md`.
Introduces Zod + `validateBody(schema)` middleware, deletes the rate limiter, caches the two served static files at boot, and strips per-route hand-rolled shape-validation. Bullshit-inventory items **#37 (per-route validation boilerplate)**, **#39 (rate limit)**, **#40 (oversized-body special handling)** are eliminated. **#38 (admin endpoints)** is explicitly preserved per the inventory note.

## Header

- **Target flowchart**: `PATHFINDER-2026-04-21/05-clean-flowcharts.md` §3.9 "http-server-routes (clean)" (lines 382-420).
- **Before state**: `PATHFINDER-2026-04-21/01-flowcharts/http-server-routes.md`.
- **Upstream dependencies**: *none*. Zod adoption is orthogonal to every other plan; this plan OWNS the Zod introduction.
- **Downstream dependencies**: *none*. Other plans land unaffected; they gain `validateBody(schema)` validation by attaching a schema to their routes at landing time, not by rewriting this plan.
- **Coordination note**: Plan 09 (lifecycle-hooks) collapses `SessionRoutes` from 10 → 4 endpoints (V9 finding). This plan MUST land **after** Plan 09 so the Zod schemas here target the final 4-endpoint surface, not the legacy 10. If landing order flips, re-attach schemas to whichever route names survive.
- **Verified findings cited**: V2 (legacy `/sessions/*` vs `/api/sessions/*`, SessionRoutes.ts:378-389); V9 (SessionRoutes has 10 endpoints, not 8); V20 (rate limiter at `src/services/worker/http/middleware.ts:45-79`, 300 req/min IP map, keyed by `::ffff:127.0.0.1`-normalized IP).

## Anti-patterns prohibited in every phase

- **A**: No invented Zod methods. Every API used must be verified against the installed zod version (Phase 1). In particular, use `schema.safeParse(body)` + `result.success ? result.data : result.error.flatten()` — no `ZodUtil.assertBody`, no `schema.validateOrThrow`.
- **D**: No per-route validation blocks of 5+ if statements. Any block that currently does `if (typeof x !== 'string') ... if (!body.foo) ... if (!body.bar) ...` collapses to a single `validateBody(schema)` middleware call.
- **E**: No two validation paths. If a route gets a Zod schema, the hand-rolled checks in the handler body get deleted in the same commit. "Defense in depth" via duplicate validation is forbidden.

---

## Phase 1 — Confirm Zod availability; add if absent

**Outcome**: `zod` is a first-class dependency in `package.json`, installed in `node_modules`, with a known version so every schema in Phase 3 uses a stable API.

### (a) What to implement

- Run `npm ls zod` in the repo root.
- If present (transitive or direct): pin the resolved major version in `package.json` dependencies (move from transitive to explicit so future `npm ci` can't drop it).
- If absent (confirmed state as of 2026-04-22 — see findings below): `npm install zod@^3.23.8` (current stable 3.x line). Commit `package.json` + `package-lock.json`.
- Record the resolved version in the PR description. All subsequent phases use this version's API surface.

Copy from: nothing — this is a dependency add. Reference the `package.json` structure at `/Users/alexnewman/.superset/worktrees/claude-mem/vivacious-teeth/package.json:111-125` (current `dependencies` block).

### (b) Docs

- §3.9 "Deleted" bullet 2 ("Per-route hand-rolled validation (Zod middleware replaces)").
- `06-implementation-plan.md` line 55: "Zod — `z.object({...})`, `schema.safeParse(body)`, `result.success ? result.data : result.error.flatten()`. (Not yet a dep; Phase 12 adds `zod` via npm; already shipped transitively via `@anthropic-ai/sdk` — confirm before landing.)"
- V9 (06-implementation-plan.md:36) confirms the SessionRoutes endpoint count that Phase 3 must schema.
- Live file:line: `package.json:111-125` (dependencies block); `package.json:124` (`zod-to-json-schema` — sibling package, *not* zod itself).

### (c) Verification

- `npm ls zod` prints a single resolved path, not "(empty)".
- `node -e "require('zod')"` exits 0.
- Grep: `grep -n '"zod"' package.json` → **≥1** match in dependencies (not just `zod-to-json-schema`).
- `git diff package.json` shows `zod` added; `package-lock.json` shows resolved version.

### (d) Anti-pattern guards

- **A**: Don't pin to `@latest`; pin to the major line installed now (3.x). Record the exact minor in the plan PR.
- **E**: Don't add `zod` to both `dependencies` and `devDependencies` — runtime code imports it, so `dependencies` only.

---

## Phase 2 — Write `validateBody(schema)` middleware

**Outcome**: One Express middleware file, ~40 lines, that accepts any Zod schema and rejects non-conforming bodies with a uniform 400 shape. Zero per-route boilerplate.

### (a) What to implement

Create `src/services/worker/http/middleware/validateBody.ts`:

```ts
import { RequestHandler } from 'express';
import { ZodType } from 'zod';

export function validateBody<T>(schema: ZodType<T>): RequestHandler {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({
        error: 'validation_failed',
        message: 'Request body failed schema validation',
        code: 'VALIDATION_FAILED',
        fields: result.error.flatten()
      });
      return;
    }
    req.body = result.data;
    next();
  };
}
```

Copy error-shape keys (`error`, `message`, `code`) from the existing `BaseRouteHandler.handleError` response shape at `/Users/alexnewman/.superset/worktrees/claude-mem/vivacious-teeth/src/services/worker/http/BaseRouteHandler.ts:82-99`, extended with `fields` (per 06-implementation-plan.md:546, 553, 563).

Create the directory: `src/services/worker/http/middleware/` (new; sibling to `middleware.ts`). One file, one export.

### (b) Docs

- §3.9 flowchart node D: `validateBody(schema) middleware (Zod per route)` → node E `Valid? → 400 with field errors` (05-clean-flowcharts.md:388-391).
- 06-implementation-plan.md Phase 12, lines 542-548 (middleware signature + `safeParse` + 400 with `fields`).
- Live file:line: existing error shape at `src/services/worker/http/BaseRouteHandler.ts:82-99` (fields: `error`, `code`, `details`).

### (c) Verification

- `grep -n "export function validateBody" src/services/worker/http/middleware/validateBody.ts` → 1 match.
- `grep -rn "res.status(400)" src/services/worker/http/middleware/validateBody.ts` → exactly 1 (the single 400 response).
- Unit test: schema `z.object({ foo: z.string() })` accepts `{foo:"bar"}`, rejects `{foo:42}` with 400 and `fields.fieldErrors.foo` populated.
- TypeScript: `tsc --noEmit` succeeds — the generic `<T>` signature must compile.

### (d) Anti-pattern guards

- **A**: `safeParse` only — no `.parse()` with try/catch wrapper, no `assertSafe`, no `ZodUtil` helper class. The Express middleware contract already provides error isolation.
- **D**: This file is the *only* place a Zod parse happens in the HTTP layer. If a future PR adds a second `safeParse` call inside a handler, it is a duplicate validation path — delete it.
- **E**: `next()` only on success. On failure, `res.status(400).json(...)` **and return**. Never both call `next()` and send a response.

---

## Phase 3 — Per-route Zod schemas; attach via middleware

**Outcome**: Every POST / PUT / DELETE-with-body endpoint has a Zod schema sitting next to its route registration. `validateBody(schema)` is inserted into the middleware chain for that route.

### (a) What to implement

For each route file, add a top-of-file `schemas` block (plain `const X = z.object({...})` — do NOT build a `schemas/` parallel directory; inline at top of file keeps the schema co-located with its handler). Attach via the route registration:

Before (`CorpusRoutes.ts:28`):
```ts
app.post('/api/corpus', this.handleBuildCorpus.bind(this));
```

After:
```ts
app.post('/api/corpus', validateBody(BuildCorpusSchema), this.handleBuildCorpus.bind(this));
```

**Schemas required (one per endpoint with a body). Target list assumes Plan 09 has already collapsed SessionRoutes to the 4-endpoint surface per §3.1.** If Plan 09 has not landed, also schema the legacy `/sessions/:sessionDbId/*` endpoints at `src/services/worker/http/routes/SessionRoutes.ts:377-382` — they're deleted by Plan 09 but must not be left unvalidated in the interim.

| Route file | Endpoint | Schema name | Core fields |
|---|---|---|---|
| `SessionRoutes.ts` | `POST /api/session/start` (post-Plan 09) | `SessionStartSchema` | `{ project: string, contentSessionId: string, platformSource?: string, customTitle?: string }` |
| `SessionRoutes.ts` | `POST /api/session/prompt` | `SessionPromptSchema` | `{ sessionDbId: number, prompt: string }` |
| `SessionRoutes.ts` | `POST /api/session/observation` | `SessionObservationSchema` | `{ sessionDbId: number, tool_use_id: string, name: string, input: unknown, output: unknown, cwd?: string }` |
| `SessionRoutes.ts` | `POST /api/session/end` | `SessionEndSchema` | `{ sessionDbId: number, last_assistant_message: string }` |
| `DataRoutes.ts` | `POST /api/observations/batch` | `ObservationsBatchSchema` | `{ ids: z.array(z.number().int()), orderBy?: z.enum(['date_desc','date_asc']), limit?: number, project?: string }` |
| `DataRoutes.ts` | `POST /api/sdk-sessions/batch` | `SdkSessionsBatchSchema` | `{ memorySessionIds: z.array(z.string()) }` |
| `DataRoutes.ts` | `POST /api/processing` | `SetProcessingSchema` | `{ isProcessing: z.boolean() }` (verify field name in handler) |
| `DataRoutes.ts` | `POST /api/pending-queue/process` | `ProcessQueueSchema` | (likely empty — `z.object({}).strict()`) |
| `DataRoutes.ts` | `POST /api/import` | `ImportSchema` | per handler's body shape |
| `MemoryRoutes.ts` | `POST /api/memory/save` | `MemorySaveSchema` | `{ text: z.string().min(1), title?: string, project?: string }` |
| `CorpusRoutes.ts` | `POST /api/corpus` | `BuildCorpusSchema` | `{ name: z.string().min(1), description?: string, project?: string, types?: z.array(z.string()), concepts?: z.array(z.string()), files?: z.array(z.string()), query?: string, date_start?: string, date_end?: string, limit?: z.number().int().positive() }` |
| `CorpusRoutes.ts` | `POST /api/corpus/:name/query` | `QueryCorpusSchema` | `{ question: z.string().min(1) }` |
| `CorpusRoutes.ts` | `POST /api/corpus/:name/rebuild` | `RebuildCorpusSchema` | `z.object({}).strict()` or per handler |
| `SettingsRoutes.ts` | `POST /api/settings` | `UpdateSettingsSchema` | **see note below** |
| `SettingsRoutes.ts` | `POST /api/mcp/toggle` | `ToggleMcpSchema` | `{ enabled: z.boolean() }` |
| `SettingsRoutes.ts` | `POST /api/branch/switch` | `SwitchBranchSchema` | `{ branch: z.enum(['main', 'beta/7.0', 'feature/bun-executable']) }` |
| `SettingsRoutes.ts` | `POST /api/branch/update` | `UpdateBranchSchema` | `z.object({}).strict()` |
| `LogsRoutes.ts` | `POST /api/logs/clear` | `ClearLogsSchema` | `z.object({}).strict()` or per handler |
| `ViewerRoutes.ts` | (GET-only) | — | no body schemas needed |
| `SearchRoutes.ts` | `POST /api/context/semantic` | `SemanticContextSchema` | per handler at `src/services/worker/http/routes/SearchRoutes.ts:41` |

**Special case — `POST /api/settings`**: the existing `validateSettings(settings)` function at `src/services/worker/http/routes/SettingsRoutes.ts:237-385` is ~148 lines of domain validation (valid providers, port ranges, Python version regex, URL parse). That is **domain validation, not shape validation.** Keep it. The Zod schema here validates only that each field, if present, is of the right primitive type (`z.string().optional()`, `z.number().optional()`, `z.boolean().optional()` as appropriate per the `settingKeys` array at `SettingsRoutes.ts:88-128`). The domain validation stays in the handler. This is the correct application of rule D: delete only shape checks, not domain checks.

Copy-ready pattern to replicate: `CorpusRoutes.ts:238-244` — the `QueryCorpusSchema` replaces exactly this block. Cleanest single-field existing check in the codebase.

### (b) Docs

- §3.9 flowchart node D (`validateBody(schema) middleware (Zod per route)`, 05-clean-flowcharts.md:388).
- Bullshit-inventory item #37: "Per-route validation boilerplate × 8 files" → "`validateBody(schema)` middleware; per-route Zod schema" (05-clean-flowcharts.md:55).
- 06-implementation-plan.md Phase 12 task 3 (line 547): "Per-route schemas in a parallel `schemas/` directory (or inline at top of each route file). One `z.object({…})` per endpoint." **This plan chooses inline** (co-location wins over directory partition at this scale — 8 files × ~3 schemas each = ~24 schemas; a separate directory adds import overhead with no clarity gain).
- V9 (06-implementation-plan.md:36): confirms SessionRoutes endpoint count pre/post Plan 09.
- Live file:line per row in the schema table above.

### (c) Verification

- `grep -rn "^import.*from 'zod'" src/services/worker/http/routes/` → **≥1 per route file with a POST endpoint** (7 of 8 files — ViewerRoutes is GET-only).
- `grep -rn "validateBody(" src/services/worker/http/routes/` → count matches the POST/PUT endpoint total in the table above (~18 endpoints).
- For each schema: a successful request round-trips unchanged; an invalid-shape request returns 400 with `{error:'validation_failed', fields:...}`.

### (d) Anti-pattern guards

- **A**: Every schema uses published zod 3.x methods (`z.object`, `z.string`, `z.number`, `z.array`, `z.enum`, `z.boolean`, `.optional`, `.min`, `.int`, `.positive`). Anything else — verify against the resolved zod version from Phase 1. **Do not invent** `.isPositiveInt()` or `.nonEmptyString()` helper methods; use the built-in chain.
- **E**: No schema duplicated. If two endpoints share a shape (e.g. `contentSessionId` appears in multiple SessionRoutes handlers), extract to a shared `const SessionIdField = z.string()` at the top of the file and reuse. Duplicated literal `z.object({...})` with identical fields across files = delete one.
- **D**: Inline schemas only. Do not build `schemas/SessionSchemas.ts` / `schemas/DataSchemas.ts` — that re-introduces the parallel-directory anti-pattern the plan text at 06-implementation-plan.md:547 warns about.

---

## Phase 4 — Delete hand-rolled validation blocks

**Outcome**: Every shape-validation block (type check, presence check, array check) inside a route handler is deleted. Only domain validation remains.

### (a) What to implement

Delete (exact line ranges, to be deleted alongside the Phase 3 schema attachment for each route):

| File | Line range to delete | What | Replaced by |
|---|---|---|---|
| `src/services/worker/http/routes/CorpusRoutes.ts` | `44-51` | `if (!req.body.name) { res.status(400).json({error:'Missing required field: name', fix:..., example:...}); return; }` | `BuildCorpusSchema` in Phase 3 |
| `src/services/worker/http/routes/CorpusRoutes.ts` | `55-69` | Coercion calls for `types`, `concepts`, `files`, `limit` (`coerceStringArray`, `coercePositiveInteger`) | Zod coerces via `z.coerce.number()`, `z.string().transform(s => s.split(','))` as needed |
| `src/services/worker/http/routes/CorpusRoutes.ts` | `88-125` | `coerceStringArray` + `coercePositiveInteger` helper methods | Zod schema coercion replaces both helpers entirely |
| `src/services/worker/http/routes/CorpusRoutes.ts` | `238-245` | `QueryCorpus` question presence + type check | `QueryCorpusSchema` in Phase 3 |
| `src/services/worker/http/routes/DataRoutes.ts` | `118-123` | `path` query-param check (note: query-param, not body — keep as-is OR migrate to `validateQuery(schema)` if the middleware is extended; for this plan, leave) | — |
| `src/services/worker/http/routes/DataRoutes.ts` | `144-163` | `ids` coerce + array-check + integer-check for `POST /api/observations/batch` | `ObservationsBatchSchema` |
| `src/services/worker/http/routes/DataRoutes.ts` | `196-206` | `memorySessionIds` coerce + array-check for `POST /api/sdk-sessions/batch` | `SdkSessionsBatchSchema` |
| `src/services/worker/http/routes/SessionRoutes.ts` | `570-572` | `if (!contentSessionId) return this.badRequest(...)` in `handleObservationsByClaudeId` | Pre-Plan 09: keep as-is until routes collapse; post-Plan 09: replaced by `SessionObservationSchema` |
| `src/services/worker/http/routes/SessionRoutes.ts` | `672-676` | `contentSessionId` check in `handleSummarizeByClaudeId` | Same |
| `src/services/worker/http/routes/SessionRoutes.ts` | `724-728` | `contentSessionId` query-param check in `handleStatusByClaudeId` (GET — query not body; leave) | — |
| `src/services/worker/http/routes/SessionRoutes.ts` | `767-771` | `contentSessionId` check in `handleCompleteByClaudeId` | `SessionEndSchema` post-Plan 09 |
| `src/services/worker/http/routes/SessionRoutes.ts` | `831-835` | `this.validateRequired(req, res, ['contentSessionId'])` in `handleSessionInitByClaudeId` | `SessionStartSchema` post-Plan 09 |
| `src/services/worker/http/routes/SettingsRoutes.ts` | `159-164` | `enabled` boolean type check in `handleToggleMcp` | `ToggleMcpSchema` |
| `src/services/worker/http/routes/SettingsRoutes.ts` | `184-198` | `branch` presence + allowlist check in `handleSwitchBranch` | `SwitchBranchSchema` (`z.enum([...])` handles both presence and allowlist) |
| `src/services/worker/http/routes/MemoryRoutes.ts` | `33-36` | `text` presence + type + non-empty check | `MemorySaveSchema` |
| `src/services/worker/http/routes/BaseRouteHandler.ts` | `54-62` | `validateRequired(req, res, params)` helper method | **Delete entire method.** No caller remains after this phase. Keep `parseIntParam`, `badRequest`, `notFound`, `handleError`, `wrapHandler`. |

Total hand-rolled-validation lines deleted: approximately **125 LOC** across 5 files.

**`SettingsRoutes.validateSettings` at lines 237-385 is NOT deleted** — that is domain validation (provider allowlists, port ranges, URL parse) and stays in the handler as-is. Zod handles only shape. Cite rule D: "per-route validation blocks of 5+ if statements — collapsed to validateBody(schema)" applies to shape blocks; domain blocks are orthogonal and survive.

### (b) Docs

- §3.9 "Deleted" bullet 2: "Per-route hand-rolled validation (Zod middleware replaces)" (05-clean-flowcharts.md:414).
- Bullshit-inventory #37 (05-clean-flowcharts.md:55).
- 06-implementation-plan.md Phase 12 task 4 (line 548): "Delete per-route boilerplate: manual `typeof x !== 'string'` checks, `if (!body.foo) return res.status(400)…`."
- Live line ranges per row in the table above.

### (c) Verification

- `grep -rn "validateRequired" src/services/worker/http/` → **0**.
- `grep -rn "typeof .* !== 'string'" src/services/worker/http/routes/` → **0** for body validation; any surviving matches must be for non-body purposes (e.g., narrowing a union type inside business logic).
- `grep -rn "res.status(400)" src/services/worker/http/routes/` drops significantly (from ~12 to ≤ 2 domain-specific 400s in `SettingsRoutes.validateSettings` path and corpus `404 → 400` edge).
- `grep -n "coerceStringArray\|coercePositiveInteger" src/` → **0**.
- Happy-path tests for each endpoint: response shape unchanged.

### (d) Anti-pattern guards

- **D**: If a handler still has a `typeof` check on a body field after this phase, the schema is missing a constraint. Fix the schema, not the handler.
- **E**: No fall-through: after `validateBody` accepts, the handler does NOT re-validate the same field. Example: `SwitchBranchSchema` uses `z.enum(['main','beta/7.0','feature/bun-executable'])` — the handler must not re-check `if (!allowedBranches.includes(branch))`.
- **A**: Don't replace `validateRequired` with a similarly-named Zod wrapper. Delete the method outright.

---

## Phase 5 — Delete rate-limit middleware

**Outcome**: The rate limiter at `src/services/worker/http/middleware.ts:45-79` (300 req/min IP map, keyed by `::ffff:127.0.0.1`-normalized IP) is deleted. Bullshit item #39 removed.

### (a) What to implement

Delete the following from `src/services/worker/http/middleware.ts`:

- **Lines 45-50**: comment block + `requestCounts` map + `RATE_LIMIT_WINDOW_MS` + `RATE_LIMIT_MAX_REQUESTS` constants.
- **Lines 52-77**: the `rateLimiter` RequestHandler.
- **Line 79**: `middlewares.push(rateLimiter);`.

Total: **35 LOC deleted from middleware.ts**.

No change needed in `Server.ts` — it registers middleware via `createMiddleware(summarizeRequestBody)` at `src/services/server/Server.ts:156`, which returns the array. Removing the `.push(rateLimiter)` call is sufficient; the caller loops over whatever middleware returns.

### (b) Docs

- §3.9 "Deleted" bullet 1: "In-memory rate limiter (300/min IP map) — localhost trust model everywhere else makes this theater" (05-clean-flowcharts.md:413).
- Bullshit-inventory #39 (05-clean-flowcharts.md:57).
- V20 (06-implementation-plan.md:47): "Rate limiter 300/min — Confirmed at `src/services/worker/http/middleware.ts:45-79`. Constants at `:49-50`. Keyed by IP, normalizes `::ffff:127.0.0.1`. Phase 14 deletes."
- 06-implementation-plan.md Phase 14 task 1 (line 612).
- Live file:line: `src/services/worker/http/middleware.ts:45-79`.

### (c) Verification

- `grep -n "RATE_LIMIT_WINDOW_MS\|RATE_LIMIT_MAX_REQUESTS\|requestCounts\|rateLimiter" src/` → **0 matches**.
- `grep -n "429" src/services/worker/http/` → **0** (the only 429 in the codebase is the rate limiter; survey the repo with `grep -rn "429" src/` to confirm).
- `curl -s -w "%{http_code}" -o /dev/null http://localhost:37777/api/health` repeated 1000× returns 200 every time — no 429 after request #300.
- Build green: `tsc --noEmit`.

### (d) Anti-pattern guards

- **B** (from 06-implementation-plan.md:623): "Don't re-introduce the rate limiter as a 'config flag'. Localhost trust model is explicit." No `if (settings.rateLimitEnabled)` conditional reintroduction.
- **D**: Do not leave the function in place "commented out" — delete the lines.
- **A**: Do not repurpose the `requestCounts` Map for a "request-counting telemetry" feature. Delete the Map.

---

## Phase 6 — Cache viewer.html and /api/instructions at boot

**Outcome**: The sync `readFileSync` on every `GET /` and `GET /api/instructions` request is replaced by an in-memory `Buffer` loaded once at worker boot.

> **Cache lifecycle contract (Preflight edit 2026-04-22 — reconciliation C10)**: The cached `Buffer` lives for the **lifetime of the worker process** — re-read on every worker boot, never refreshed mid-process. This is the contract plan 12's T1 regression test (SHA-256 of `GET /`) assumes when it mandates re-baselining after every worker restart. If the viewer.html content includes a per-boot bearer-token injection (observation 71147), the Buffer captures that token at constructor time and serves it consistently until the next boot. **Do not** add any hot-reload / file-watcher / TTL cache invalidation. If an operator edits `viewer.html` in place, they must restart the worker to see the change — documented tradeoff, not a regression.

### (a) What to implement

**`/` (viewer.html)** — currently at `src/services/worker/http/routes/ViewerRoutes.ts:54-72`:

Refactor `ViewerRoutes` constructor (currently `src/services/worker/http/routes/ViewerRoutes.ts:19-25`) to resolve + read `viewer.html` once and store as a module-level or instance-level `Buffer`:

```ts
private viewerHtml: Buffer;

constructor(...) {
  super();
  const packageRoot = getPackageRoot();
  const candidates = [
    path.join(packageRoot, 'ui', 'viewer.html'),
    path.join(packageRoot, 'plugin', 'ui', 'viewer.html')
  ];
  const found = candidates.find(existsSync);
  if (!found) throw new Error('Viewer UI not found at boot');
  this.viewerHtml = readFileSync(found);  // Buffer
}

private handleViewerUI = this.wrapHandler((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(this.viewerHtml);
});
```

Delete `readFileSync` + `existsSync` calls from inside the request handler (lines 63-71 of current file).

**`/api/instructions`** — currently at `src/services/server/Server.ts:202-234`:

The endpoint supports 4 `topic` values × N `operation` values. Option (a): pre-compute the 4 section strings at boot. Option (b): pre-read `SKILL.md` once and read `operations/*.md` lazily (these are rarer).

Recommended: Option (a). At `Server` constructor time, call `loadInstructionContent(undefined, 'all')` once, extract all 4 sections, store as `Record<string, Buffer>`. Store a `Map<string, Buffer>` for `operations/*.md` populated lazily on first hit (or eagerly if the operations directory is small — enumerate at boot).

Preserve path-traversal security: the `operationPath.startsWith(OPERATIONS_BASE_DIR + path.sep)` check at `Server.ts:218` stays. Caching does not bypass validation — the cache key is the already-validated operation name.

Preserve the `ALLOWED_TOPICS` + `ALLOWED_OPERATIONS` allowlist at `Server.ts:207-213`.

Copy-ready pattern: the current `extractInstructionSection` function at `Server.ts:350-359` already partitions content into a `sections` record — that IS the cache structure; just hoist it from per-request to boot.

### (b) Docs

- §3.9 "Deleted" bullet 3: "Synchronous file read for `/` and `/api/instructions` (replace with cached `Buffer` loaded at boot)" (05-clean-flowcharts.md:415).
- §3.10 flowchart node HTML: "viewer.html (cached at boot)" (05-clean-flowcharts.md:426).
- 06-implementation-plan.md Phase 14 task 2 (line 613): "Cache `viewer.html` and `/api/instructions` content in memory at boot; serve from `Buffer` instead of `fs.readFile`."
- Live file:line: `src/services/worker/http/routes/ViewerRoutes.ts:54-72` (viewer.html); `src/services/server/Server.ts:202-234` (instructions endpoint); `src/services/server/Server.ts:337-345` (loader); `src/services/server/Server.ts:350-359` (section extractor).

### (c) Verification

- Static file reads happen once at boot: add a `logger.info('WORKER', 'viewer.html cached', { bytes: this.viewerHtml.length })` at constructor time; grep logs after 100 `GET /` requests to confirm the message fires exactly once.
- `lsof -p $(pidof node) | grep viewer.html` at steady-state: either zero (Buffer held in memory, no open FD) or exactly one (memory-mapped).
- `grep -n "readFileSync.*viewer.html\|readFileSync.*SKILL.md\|readFileSync.*operations" src/services/worker/ src/services/server/` → **0** matches inside request handlers (module-scope or constructor-scope matches are fine; per-request matches fail).
- Response body unchanged (byte-for-byte) across a request pair before and after the change.

### (d) Anti-pattern guards

- **E**: Do not keep the `readFileSync` path "as a fallback" for when the Buffer is undefined. If the file isn't found at boot, throw — fail-fast aligns with global standard #3. No silent fallback.
- **D**: The viewer-path-candidate array at `ViewerRoutes.ts:58-61` is not a duplicate validation — it's install-layout probing. Keep both candidates for boot-time resolution. After the first successful read, the candidate list is discarded.
- **A**: Do not wrap the Buffer in a `StaticFileCache` class. Hold it as a private field on the route class. One field, one assignment.

---

## Phase 7 — Delete oversized-body special handling

**Outcome**: The 5MB JSON parse limit stays (cheap; bullshit item #40 keep-clause). Any `if (body.size > …) specialHandler()` or hand-rolled 413 logic is deleted — Express's built-in 413 from the `express.json({ limit: '5mb' })` middleware is sufficient.

### (a) What to implement

Survey the route files and `middleware.ts` for body-size special handling:

- `src/services/worker/http/middleware.ts:25` — `express.json({ limit: '5mb' })` — **KEEP**. This is the one-line limit per item #40.
- Any handler that inspects `req.body.length`, `req.headers['content-length']`, or returns a custom 413: **DELETE**.

Based on the grep survey in Phase 0, **no custom oversized-body handling currently exists in `src/services/worker/http/`**. This phase is a verification pass confirming absence. If any is discovered during implementation, delete it without replacement — the `express.json()` middleware already emits 413 with `entity.too.large` on oversized bodies.

If any handler catches the Express 413 and remaps it to a different shape, delete the catch — uniform error handling via `BaseRouteHandler.handleError` (`src/services/worker/http/BaseRouteHandler.ts:82-99`) is already in place.

### (b) Docs

- Bullshit-inventory #40 (05-clean-flowcharts.md:58): "JSON parse 5MB limit on every request — Keep (cheap), but delete any special handling for oversized — 413 is fine."
- Live file:line: `src/services/worker/http/middleware.ts:25` (the `express.json` call to preserve).

### (c) Verification

- `grep -rn "413\|'entity.too.large'\|PayloadTooLarge" src/services/worker/http/` → **0 matches in handler code** (framework-internal uses do not appear in our source).
- `grep -rn "content-length\|contentLength\|Content-Length" src/services/worker/http/routes/` → **0** matches in route handlers (header-inspection by handlers is the anti-pattern to find).
- Sending a 6MB body returns Express default 413. Sending a 4MB body round-trips.

### (d) Anti-pattern guards

- **D**: If a grep hit appears, delete it. Do not "improve" it.
- **A**: Don't add a `RequestSizeGuard` middleware. `express.json({ limit })` already guards.
- **E**: Don't let a handler's try/catch swallow a 413 and remap to 400. The Express error shape for 413 is Express's; uniformity below that boundary is enforced by `handleError`.

---

## Phase 8 — Verification

**Outcome**: Whole §3.9 diagram is reality. All greps clean, route smoke tests pass, deleted-line count matches estimate.

### (a) What to implement

Execute the verification checklist below. This phase does not modify production code; it runs scripts/tests and fixes regressions uncovered.

### (b) Docs

- §3.9 full diagram (05-clean-flowcharts.md:384-410).
- §3.9 "Deleted" block (lines 412-416).
- §3.9 "Kept" block (line 418): "All user-facing routes, SSE, middleware chain, admin endpoints (used by tooling)." — the admin endpoints (`/api/admin/restart`, `/api/admin/shutdown`, `/api/admin/doctor` at `src/services/server/Server.ts:237-330`) are explicitly preserved; item #38 (05-clean-flowcharts.md:56).
- 06-implementation-plan.md Phase 15 (line 631-656): timer census + grep pass + full test suite.

### (c) Verification checklist

- [ ] **Rate limiter gone**: `grep -rn "RATE_LIMIT_WINDOW_MS\|RATE_LIMIT_MAX_REQUESTS\|requestCounts\|rateLimiter" src/` → **0**.
- [ ] **Zod present**: `grep -rn "^import .* from 'zod'" src/services/worker/http/` → **≥8** matches (middleware + 7 route files with POSTs).
- [ ] **validateBody attached**: `grep -rn "validateBody(" src/services/worker/http/routes/" → **~18** matches (one per schemaed POST/PUT).
- [ ] **validateRequired deleted**: `grep -rn "validateRequired" src/` → **0**.
- [ ] **Static-file reads hoisted**: `grep -rn "readFileSync.*viewer.html" src/services/worker/` → 0 matches inside request handlers; OK in constructor/module-scope.
- [ ] **SSE preserved**: `GET /stream` returns `text/event-stream` with initial `initial_load` event (manual smoke test).
- [ ] **Admin preserved**: `POST /api/admin/doctor` from localhost returns JSON; from non-localhost returns 403 (per `requireLocalhost` at `src/services/worker/http/middleware.ts:121-143`). Used by version-bump per item #38.
- [ ] **Route smoke tests per endpoint (curl or integration suite)**:
  - `GET /` → 200 HTML (from cached Buffer).
  - `GET /health` → 200 JSON `{status:'ok', activeSessions:N}`.
  - `GET /stream` → 200 SSE stream.
  - `POST /api/memory/save` with `{text:""}` → 400 `{error:'validation_failed', fields:...}`.
  - `POST /api/memory/save` with `{text:"hi"}` → 200 `{success:true, id:...}`.
  - `POST /api/corpus` with `{name:"t", query:"hooks"}` → 200 metadata.
  - `POST /api/corpus` with `{}` → 400 validation_failed with `fields.fieldErrors.name`.
  - `POST /api/mcp/toggle` with `{enabled:"yes"}` → 400; `{enabled:true}` → 200.
  - `POST /api/branch/switch` with `{branch:"nonexistent"}` → 400; `{branch:"main"}` → 200.
  - `GET /api/instructions?topic=workflow` → 200 JSON content (served from cache).
  - `POST /api/admin/restart` from localhost → 200 `{status:'restarting'}`.
- [ ] **Build green**: `npm run build` succeeds.
- [ ] **Worker boots**: `npm run build-and-sync` and verify `GET /health` answers within 2s.
- [ ] **Deleted-lines tally**: approximately **35 LOC** (rate limiter, Phase 5) + **~125 LOC** (hand-rolled validation + helpers, Phase 4) + **~9 LOC** (`BaseRouteHandler.validateRequired` method, Phase 4) + **~10 LOC** (per-request `readFileSync`/`existsSync` probes moved to constructor, Phase 6) ≈ **~180 LOC net deleted**, offset by **~60 LOC added** (new `validateBody` + ~24 schemas averaging 2-3 lines each) = **~120 LOC net deletion**.

### (d) Anti-pattern guards

- **D** (whole plan): if any verification grep finds unexpected matches, do not "fix forward" — delete the offending code.
- **E**: If a route smoke test fails due to schema over-constraint (e.g., an optional field rejected), **relax the schema, do not re-add a hand-rolled fallback.**
- **A**: Do not add integration tests that fake the Zod surface. Use the installed zod.

---

## Reporting summary

**Phase count**: 8.

**Estimated deletion**: ~180 LOC gross, ~60 LOC added, **~120 LOC net**. Primary deletes: rate limiter (35), hand-rolled validation blocks (125), `validateRequired` helper (9), per-request file-read probing (10). Primary additions: `validateBody.ts` (~40), Zod schemas inline (~60 across 7 files).

**Sources consulted**:
- `PATHFINDER-2026-04-21/05-clean-flowcharts.md` (full); §3.9 (lines 382-420) canonical; Part 1 items #37-40 (lines 55-58); Part 2 decisions (lines 65-79).
- `PATHFINDER-2026-04-21/06-implementation-plan.md`: V2 (line 29), V9 (line 36), V20 (line 47); allowed-APIs block (lines 49-55); anti-patterns (line 59); Phase 12 (lines 530-565); Phase 14 (lines 600-627); Phase 15 (lines 631-656).
- `PATHFINDER-2026-04-21/01-flowcharts/http-server-routes.md` (before state).
- Live codebase (9 files): `src/services/worker/http/middleware.ts`, `src/services/worker/http/BaseRouteHandler.ts`, `src/services/worker/http/routes/{ViewerRoutes,SearchRoutes,SessionRoutes,DataRoutes,SettingsRoutes,MemoryRoutes,CorpusRoutes,LogsRoutes}.ts`, `src/services/server/Server.ts`.
- `package.json` (dependencies block lines 111-125) + `npm ls zod` + filesystem probe of `node_modules/zod`.

**Concrete findings**:

- **Zod presence check** (2026-04-22 10:18 PDT): `npm ls zod` returns `(empty)`. `node_modules/zod/package.json` does not exist. Transitively it is NOT shipped — the only zod-adjacent package is `zod-to-json-schema@^3.24.6` at `package.json:124`, which does not pull in `zod` itself. **Phase 1 MUST add `zod` via `npm install zod@^3.x`.** Verified findings block at `06-implementation-plan.md:55` should be updated: "already shipped transitively via `@anthropic-ai/sdk`" is false for this repo (the SDK is `@anthropic-ai/claude-agent-sdk`, not `@anthropic-ai/sdk`).
- **Route-file inventory with validation styles** (8 files, `src/services/worker/http/routes/`):
  - `ViewerRoutes.ts` (116 LOC): GET-only, no body schemas needed.
  - `SearchRoutes.ts` (421 LOC): 1 POST (`/api/context/semantic` at line 41), mostly query-param validation.
  - `SessionRoutes.ts` (958 LOC): 10 POST endpoints per V9 (6 legacy `/sessions/:id/*` at lines 377-382 + 4 under `/api/sessions/*` at lines 385-389, plus `/api/sessions/status` GET). Uses `this.validateRequired` (line 833) and inline `if (!contentSessionId)` checks (lines 570, 674, 726, 769). Post-Plan 09 collapses to 4.
  - `DataRoutes.ts` (562 LOC): 5 POST endpoints. Uses `this.badRequest` + inline `typeof` checks (lines 120-123, 149-163, 203-206). Contains ad-hoc coerce logic (JSON.parse-or-split-by-comma) at lines 145-147, 199-201 — Zod `z.preprocess` subsumes this.
  - `SettingsRoutes.ts` (434 LOC): 5 POST endpoints. Has a 148-line **domain-validation** function `validateSettings` (lines 237-385) — **preserve**; the shape-validation is inline at lines 161-164, 185-197 — **delete**.
  - `MemoryRoutes.ts` (93 LOC): 1 POST. Validation block at lines 33-36. Cleanest single-endpoint pattern in the codebase — **copy-ready template for Phase 3**.
  - `CorpusRoutes.ts` (283 LOC): 5 POST endpoints. Validation at lines 44-51, 238-245 plus two coerce helpers at lines 88-125 (~38 LOC of helper boilerplate deletable).
  - `LogsRoutes.ts` (165 LOC): 1 POST (`/api/logs/clear` at line 102). Minimal body.
- **Static file endpoints**:
  - `GET /` serves `viewer.html` — `ViewerRoutes.ts:54-72` does per-request `readFileSync` over 2 candidate paths. Move to constructor.
  - `GET /api/instructions` — `Server.ts:202-234` does per-request `fs.promises.readFile` via `loadInstructionContent` (line 337). 4 topic sections (extractable at boot) + operation files (lazy-cache OK). Allowlist at `Server.ts:207-213` (`ALLOWED_TOPICS`, `ALLOWED_OPERATIONS`) stays; path-traversal check at line 218 stays.
  - Static assets (`js`, `css`, fonts) served via `express.static(uiDir)` at `middleware.ts:110-112` — **already cached by Express; no change**.
- **Copy-ready snippet locations**:
  - Cleanest single-field validation example to replicate: `CorpusRoutes.ts:238-244` (the `question` check for `QueryCorpus`) — this exact shape replaces one-to-one with a `QueryCorpusSchema = z.object({ question: z.string().min(1) })`.
  - Cleanest presence check to Zod-ify: `MemoryRoutes.ts:33-36` (the `text` check) — maps to `MemorySaveSchema = z.object({ text: z.string().min(1), title: z.string().optional(), project: z.string().optional() })`.
  - Error-shape template to mirror in `validateBody`: `BaseRouteHandler.ts:82-99` (existing `{error, code, details}` shape) — extend with `fields`.

**Confidence + gaps**:

- **High confidence**: rate-limiter deletion (V20 verified exact lines), static-file caching (exact file:line confirmed), validation-block locations (grep returned matching line numbers), BaseRouteHandler method cleanup.
- **Gap 1 — Plan 09 landing order**: This plan assumes the §3.1 4-endpoint SessionRoutes surface is the target. If Plan 09 has not landed when this plan begins Phase 3, the plan must attach schemas to the 10 legacy endpoints (`src/services/worker/http/routes/SessionRoutes.ts:377-389`) and then refactor in lockstep when Plan 09 merges. Coordination required — add `[blocked-on: plan-09]` gate on the Phase 3 PR, or land Plan 09 first.
- **Gap 2 — Zod version lock-in for the whole refactor**: Phase 1 picks the zod 3.x version; if a future phase in another plan wants a zod 4.x-only API, this plan's schemas become incompatible. Mitigation: schemas use only the stable `z.object/string/number/array/enum/boolean/optional/min/int/positive` surface, which is unchanged between 3.x majors and 4.x. Still, a breaking upgrade must be coordinated here.
