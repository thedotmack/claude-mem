# 06 — API Surface

**Purpose**: Lock the worker HTTP surface behind one Zod-based validator, delete the rate limiter and the pending-queue diagnostic endpoints, cache `viewer.html` and `/api/instructions` in-memory at boot, and consolidate the four overlapping shutdown paths and two failure-marking paths into a single function each. Net effect: fewer handlers, fewer defensive wrappers, one schema-per-route, and zero second-system endpoints added "for debugging only."

---

## Principles invoked

- **Principle 1 — No recovery code for fixable failures.** The pending-queue diagnostic endpoints exist to poke at rows a correct ingestion path should never leave behind. Deleting them is the cure; shipping them is the hidden-bug engine.
- **Principle 2 — Fail-fast over grace-degrade.** `safeParse` returns a discriminated result; on `success=false` the middleware responds 400 with the Zod `issues` array. No `try/catch` swallow, no coercion, no "best-effort" defaults.
- **Principle 6 — One helper, N callers.** One `validateBody(schema)` middleware wraps every validated POST/PUT; one `performGracefulShutdown` is the only shutdown path; one `transitionMessagesTo(status)` is the only failure/abandon writer.
- **Principle 7 — Delete code in the same PR it becomes unused.** `validateRequired`, `WorkerService.shutdown`, `runShutdownCascade` wrappers, `markSessionMessagesFailed`, `markAllSessionMessagesAbandoned`, and the rate limiter are deleted in-PR, not `@deprecated`-fenced.

---

## Phase 1 — Preflight: `npm install zod@^3.x`

Add Zod 3.x as a runtime dependency.

**Version pinning rationale**: Zod 3.x is the stable, shipped line (current minor `^3.23`). Zod 4.x is in active rework at time of writing — breaking changes to error shape and `safeParse` return signature are expected. Pinning `^3.x` gives us the ecosystem (tRPC, AI SDK, most Express middleware) without strapping into an experimental release.

Per `_reference.md` Part 4 §Confidence + gaps #4: "Zod is not currently a dep — Plan 06 Phase 1 is `npm install zod@^3.x`."

Cites principle 6 (one helper). After this phase, all runtime validation flows through Zod — no second validator, no Ajv, no hand-rolled type-guards left in `src/services/worker/http/`.

---

## Phase 2 — `validateBody` middleware

Single Express middleware using Zod `safeParse`. Returns 400 with field errors on failure; on success, replaces `req.body` with the parsed (and now typed) value and calls `next()`. Per `_reference.md` Part 2 row on `safeParse`: discriminated-union return is the fail-fast contract the middleware is designed around.

Place at `src/services/worker/http/middleware/validateBody.ts`. Every validated POST/PUT route imports this one function.

```ts
import type { RequestHandler } from 'express';
import type { ZodTypeAny } from 'zod';

export const validateBody = <S extends ZodTypeAny>(schema: S): RequestHandler =>
  (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: 'ValidationError',
        issues: result.error.issues.map(i => ({
          path: i.path,
          message: i.message,
          code: i.code,
        })),
      });
    }
    req.body = result.data;
    return next();
  };
```

Cites principle 2 (fail-fast) and principle 6 (one helper, N callers).

---

## Phase 3 — Per-route Zod schemas

One schema per POST/PUT endpoint, defined at the top of the route file that owns the endpoint. Schemas are **not** shared across routes — the `_reference.md` §API surface row shows these routes already have divergent body shapes (`SessionRoutes.ts:148` threshold-check body ≠ `DataRoutes.ts:305` processing-status body ≠ observation-ingest body). A "shared common" schema would paper over real divergence with a union or optional-everywhere object — the opposite of what Zod buys us.

**Cross-reference `05-hook-surface.md`**: the blocking `/api/session/end` endpoint pattern is defined in plan 05 (Phase 3: server-side wait-for-`summaryStoredEvent`). The Zod body schema for that endpoint lives **here** — it is one of the per-route schemas declared at the top of `SessionRoutes.ts` alongside every other validated POST on that router. Plan 05 owns the endpoint's server-side wait semantics; plan 06 owns its request-shape contract.

Example, in `DataRoutes.ts` (observations ingest):

```ts
import { z } from 'zod';
import { validateBody } from '../middleware/validateBody';

const ObservationBody = z.object({
  session_id: z.string().min(1),
  content: z.string(),
  // ...per-endpoint fields stay colocated with the handler that reads them
});

router.post('/api/observations', validateBody(ObservationBody), handler);
```

Cites principle 6 (one middleware wraps many per-route schemas — not N middlewares).

---

## Phase 4 — Delete hand-rolled validation

Grep-and-delete every `validateRequired(...)` call, every inline `typeof req.body.x !== 'string'` check, and every `coerce*` helper across `src/services/worker/http/routes/`. Each deletion is justified by the `validateBody(schema)` wrapper that now runs before the handler — the handler sees a parsed object or the request is already 400'd.

Cites principle 7 (delete in-PR, no `@deprecated` fence) and principle 2 (no coercion in handlers).

---

## Phase 5 — Delete rate limiter

The worker listens on `127.0.0.1:37777`. There is no untrusted caller. Rate limiting a localhost process is a second-system effect — it masks contention from a real concurrency bug rather than fixing the bug. If two callers are actually colliding on a shared resource, the cure is to find the collision (missing `UNIQUE` constraint, non-transactional claim, shared mutable state) and fix it in the relevant plan:

- Claim-side contention → `01-data-integrity.md` Phase 3 (self-healing claim).
- Ingestion duplicates → `01-data-integrity.md` Phase 4 (`UNIQUE(session_id, tool_use_id)` + `ON CONFLICT DO NOTHING`).

Cites principle 1 (no recovery code for fixable failures) and the anti-pattern guard "No new HTTP endpoint for diagnostic / manual-repair purposes" — the rate limiter is the HTTP-handler analogue of that pattern.

---

## Phase 6 — Cache `viewer.html` + `/api/instructions` in memory

At worker boot, read both files into `Buffer` once and serve the buffered bytes from the route handler. No `fs.watch`, no TTL, no "refresh in background" — per-process lifecycle. If the build changes the file, the next worker start picks it up; mid-process mutation is not a supported scenario.

```ts
// at module init for ViewerRoutes / instructions handler
const viewerHtmlBytes: Buffer = fs.readFileSync(VIEWER_HTML_PATH);
const instructionsBytes: Buffer = fs.readFileSync(INSTRUCTIONS_MD_PATH);
```

Handlers return the cached `Buffer` with the correct `Content-Type`. Cites principle 1 (no watcher-plus-TTL "cache-invalidation" recovery code) and principle 4 (event-driven — process restart is the event).

---

## Phase 7 — Delete diagnostic endpoints

Per `_reference.md` Part 1 §API surface at `DataRoutes.ts:305, 475, 510, 529, 548`:

- **DELETE** `/api/pending-queue` GET at `DataRoutes.ts:475` — inspection endpoint. Use the viewer.
- **DELETE** `/api/pending-queue/process` POST at `DataRoutes.ts:510` — manual kick. Correct ingestion does not need a kick; if it does, the bug is in the claim query (fixed by `01-data-integrity.md` Phase 3).
- **DELETE** `/api/pending-queue/failed` DELETE at `DataRoutes.ts:529` — manual purge of failed rows. Retention is a boot-once concern or a user-purge concern, not an always-on endpoint.
- **DELETE** `/api/pending-queue/all` DELETE at `DataRoutes.ts:548` — nuke-the-queue button. Never correct to expose.
- **KEEP** `/api/processing-status` at `DataRoutes.ts:305` — this is observability for a live system, not a repair lever. It reads and reports; it does not mutate.
- **KEEP** `/health` at `ViewerRoutes.ts:32` — liveness check used by `ensureWorkerRunning` in plan 05. It reads and reports; it does not mutate.

Cites principle 1 (recovery endpoints hide primary-path bugs) and the anti-pattern guard "No new HTTP endpoint for diagnostic / manual-repair purposes" — the deletions here are that guard applied retroactively.

---

## Phase 8 — Consolidate shutdown paths

Per `_reference.md` Part 1 §Worker / lifecycle, `GracefulShutdown.ts:52-86` owns the canonical 6-step shutdown: HTTP server close → sessions → MCP → Chroma → DB → supervisor. Three wrappers currently front it:

- `WorkerService.shutdown` — calls `performGracefulShutdown` after clearing timers (`worker-service.ts:1094-1120`).
- `runShutdownCascade` at `src/supervisor/shutdown.ts:22-99` — supervisor-side SIGTERM/SIGKILL cascade.
- `stopSupervisor` — supervisor teardown wrapper.

**Delete all three wrappers.** Timer cleanup and process-group teardown move into `performGracefulShutdown` directly (or are deleted entirely by `02-process-lifecycle.md`, which removes the `setInterval` callers at `worker-service.ts:547, 567, 581` that create the timers in the first place).

**Cross-reference `02-process-lifecycle.md`**: plan 02 Phase 3 defines the process-group teardown (`process.kill(-pgid, 'SIGTERM')` replaces the per-PID cascade in `runShutdownCascade`). Plan 06 must **not** re-wrap that teardown — the canonical call lives inside `performGracefulShutdown`, nowhere else.

After this phase, there is one shutdown path — `performGracefulShutdown` — called by the worker's `SIGTERM`/`SIGINT` handler and nowhere else. Cites principle 6 (one helper, N callers — but here N=1 caller is correct) and principle 7 (delete the wrappers, don't `@deprecated` them).

---

## Phase 9 — Consolidate failure-marking paths

Two methods currently mark messages as non-`processing`:

- `markSessionMessagesFailed` at `SessionRoutes.ts:256` — marks a session's messages `failed` (per `_reference.md` Part 1 §API surface).
- `markAllSessionMessagesAbandoned` at `worker-service.ts:943` — marks everything abandoned during shutdown.

Both are thin UPDATE-with-WHERE wrappers. Replace both with one method on `PendingMessageStore`:

```ts
transitionMessagesTo(status: 'failed' | 'abandoned', filter: { session_id?: string }): number
```

Callers pass the target status and the optional session-id filter. One SQL path, one place to add a new terminal status later, zero divergence between the two call sites.

Cites principle 6 (one helper, N callers) and principle 7 (delete both wrappers in the same PR).

---

## `validateBody` middleware (copy-paste pattern)

```ts
import type { RequestHandler } from 'express';
import type { ZodTypeAny } from 'zod';

export const validateBody = <S extends ZodTypeAny>(schema: S): RequestHandler =>
  (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: 'ValidationError',
        issues: result.error.issues.map(i => ({
          path: i.path,
          message: i.message,
          code: i.code,
        })),
      });
    }
    req.body = result.data;
    return next();
  };
```

## Example per-route schema (observations)

```ts
import { z } from 'zod';
import { validateBody } from '../middleware/validateBody';

const ObservationBody = z.object({
  session_id: z.string().min(1),
  content: z.string(),
  // ...
});

router.post('/api/observations', validateBody(ObservationBody), handler);
```

---

## Verification

- [ ] `grep -rn "validateRequired\|rateLimit" src/services/worker/http/` → 0
- [ ] `grep -rn "/api/pending-queue" src/` → 0
- [ ] `grep -rn "markSessionMessagesFailed\|markAllSessionMessagesAbandoned" src/` → 0 (or 1, only inside `transitionMessagesTo`)
- [ ] `grep -rn "WorkerService.prototype.shutdown\|runShutdownCascade\|stopSupervisor" src/` → 0 (or 1 at the canonical call site)
- [ ] **Integration test**: `POST /api/observations` with malformed body → 400 response, body contains `{ error: 'ValidationError', issues: [...] }` (not 500, not silent pass).
- [ ] **Integration test**: first request for `viewer.html` after boot, then second request while blocking read on `VIEWER_HTML_PATH` — second request still succeeds (served from memory, no disk read after boot).

---

## Anti-pattern guards (verbatim)

- Do NOT add per-route middleware stacks; one middleware for all validated POST/PUT.
- Do NOT add a diagnostic endpoint "for debugging only."
- Do NOT keep a shutdown wrapper "for backward compat."
