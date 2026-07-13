# SessionStart Context Injection: Server Runtime Support

Status: implementation plan
Date: 2026-07-13
Release target: claude-mem 13 (next patch after 13.11.0)
Relationship to prior plans:

- Extends `plans/2026-05-07-server-beta-independent-bullmq-observation-runtime.md` (server runtime's independent BullMQ/Postgres path) and `plans/2026-05-25-cmem-sdk-and-server-rename.md` (canonical `CLAUDE_MEM_RUNTIME=server` literal).
- Closes one row of `docs/server-parity-map.md` (`GET /api/context/inject` — currently `unsupported`, native replacement listed as "(none yet)").
- Reopens/closes #2991 ("server-beta: SessionStart context injection is not runtime-aware (injects stale/empty context)"). That issue independently diagnosed the identical root cause and proposed an equivalent fix (query-less recent endpoint + `ServerBetaClient` method + runtime-aware `contextHandler`) but was closed by the *reporter* on 2026-06-17 ("no longer pursuing these changes... uninstalled"), not by a maintainer decision on the merits — no PR ever referenced it, and nothing has touched it since. Searched via `gh search prs`/`gh search issues` before starting this branch to confirm no one else is currently working on it.

## Problem

A deployment running Claude Code agents in ephemeral Docker containers (one per job, per customer/tenant project) wants to run claude-mem in `server` runtime only — one centralized Postgres+BullMQ-backed `claude-mem-server`/`claude-mem-worker` pair instead of one SQLite-backed worker daemon spawned per container. Motivation: the per-container worker model has two production bugs under concurrent/restart load (a worker-launcher readiness race that declares `"Worker available"` without a passing health check, and SQLite-over-network-mount lock contention across sibling containers) — both structurally avoided by a single long-lived Postgres-backed server.

Investigating the cutover surfaced a hard blocker, verified directly against source (not docs) at the exact version they run (`v13.10.2`, confirmed identical at current `main`/`13.11.0` — none of the 15 intervening commits, all cloud-sync work, touch these files):

**`src/cli/handlers/context.ts`'s `contextHandler.execute()` — the handler behind the `SessionStart` hook that injects "recent context" into every new agent session — has no server-runtime branch for the `claude-code` platform.** It unconditionally calls `executeWithWorkerFallback('/api/context/inject', 'GET')`, the legacy worker-only HTTP endpoint. The only non-worker branch in this file is `input.platform === 'codex'`, which goes through `fetchSessionStartContextViaMcp()` → `callMcpToolOnce('session_start_context', ...)` — an MCP round-trip specific to the Codex integration, not a server-runtime capability check.

In a deployment running `CLAUDE_MEM_RUNTIME=server` with no worker process anywhere (the Docker Compose topology `docker-compose.yml` in this repo actually ships — `postgres` + `valkey` + `claude-mem-server` + `claude-mem-worker`, no `claude-mem worker start` anywhere), `executeWithWorkerFallback` always resolves to `isWorkerFallback(...) === true` (no worker to reach), and the hook returns `emptyResult` — every session, permanently. Confirmed this is not merely unwired: `docs/server-parity-map.md` lists the native replacement for this route as `_(none yet)_`, i.e. no `/v1/*` endpoint has ever served this exact use case.

**What does exist, and is reusable:**

- `src/services/hooks/server-client.ts`'s `ServerClient.contextObservations()` — already implemented, calls `POST /v1/context`, returns `{ observations, context }` where `context` is exactly the pre-joined string shape `additionalContext` needs. Already production-used by the `observation_context` MCP tool (`src/servers/mcp-server.ts:612`).
- `src/services/hooks/runtime-selector.ts`'s `selectRuntime()`/`buildServerContext()` — already implemented, already used by `session-init.ts`, `observation.ts`, `summarize.ts`, and `mcp-server.ts`. `context.ts` is conspicuously the one hook handler in that group that never imports it.

**What's actually missing, and is a real gap (not just wiring):** `/v1/context` requires `query` (`ServerContextObservationsRequest.query: string`, `required: true` in the MCP `observation_context` schema). It's a full-text-search/relevance endpoint (Postgres GIN tsvector index per the `observation_search` tool's own description), not a "give me what's recent" endpoint. The worker-mode route it should replace (`/api/context/inject`) and its sibling (`/api/context/recent`) are both chronological, no query term involved. `/api/context/recent`'s own native-replacement column in the parity map is *also* `_(none yet)_` — server runtime genuinely has no recency-ordered read path today.

## Goals

- `SessionStart` context injection works identically (from the calling agent's perspective) whether `CLAUDE_MEM_RUNTIME` is `worker` or `server`.
- No new server-side storage/schema — reuse the existing `observations` table and its existing FTS index infrastructure; recency mode is an alternate ORDER BY, not a new data path.
- No change to worker-mode behavior; this is a strictly additive branch.

## Non-Goals

- Porting the rest of `docs/server-parity-map.md`'s `unsupported` rows (corpus/Chroma, data viewer, `/api/search/by-file`, etc.). Scoped to the one row blocking a server-mode-only deployment's baseline UX.
- Changing `/v1/mcp` (the hosted remote-recall MCP server) — that's a different, already-working retrieval surface (`search`/`context`/`recent` tools) for a differently-authenticated use case (a user pasting a connect link into their own Claude Code), not the in-container `SessionStart` hook path this plan addresses.

## Design

### 1. Server-side: optional `query`, recency fallback on `/v1/context`

`ServerContextObservationsRequest.query` becomes optional. The route handler and `IngestEventsService`/search-repository call it goes through: when `query` is omitted or empty, order candidate observations by `occurred_at DESC` (or the table's canonical recency column) instead of `ts_rank`/GIN match score, capped at `limit` (existing default/max unchanged: 10/50). Response shape (`{ observations, context }`) is unchanged — `context` is still the same pre-joined string builder, just fed a recency-ordered observation set instead of a relevance-ordered one.

`ServerClient.contextObservations()`'s TypeScript type for `query` changes from `string` to `string | undefined` to match. `observation_context` MCP tool's `inputSchema.required` drops `query`, so an interactive agent can also call it with no query for "what's recent" — a small, free UX improvement beyond the hook use case, consistent with `observation_search`/`observation_context` otherwise being twins.

### 2. Client-side: server-runtime branch in `contextHandler.execute()`

Mirror the existing `codex`/MCP branch's fallback shape (try the runtime-specific path; on any failure, degrade to `emptyResult` rather than propagating). Sketch:

```ts
import { selectRuntime, buildServerContext } from '../../services/hooks/runtime-selector.js';
import { isServerClientError } from '../../services/hooks/server-client.js';

// inside execute(), before the existing codex/worker branching:
if (selectRuntime() === 'server') {
  const ctx = buildServerContext();
  if (!ctx) {
    return emptyResult; // buildServerContext already logs the specific reason
  }
  try {
    const { context } = await ctx.client.contextObservations({ projectId: ctx.projectId });
    return {
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context ?? '' },
    };
  } catch (error: unknown) {
    if (isServerClientError(error)) {
      logger.warn('HOOK', `[server-context] ${error.kind}: ${error.message}`);
    }
    return emptyResult; // no worker-fallback attempt: server-runtime deployments have no worker
  }
}
// ...existing codex/worker logic unchanged below
```

Deliberately does **not** fall through to `executeWithWorkerFallback` on server-client failure — a `server`-runtime deployment by definition has no worker to fall back to (this repo's own `docker-compose.yml` never spawns `worker-service.cjs` in that topology; see its header comment), so attempting the worker path would just be a second, slower way to hit the same `isWorkerFallback` empty result. Fail straight to `emptyResult`, matching the `ServerClientError.isFallbackEligible()` semantics already established for other server-runtime call sites (timeout/transport/5xx/missing-key all degrade gracefully; a real 4xx surfaces via the warn log for observability instead of silently vanishing).

**Correction found by end-to-end testing against a live server-runtime stack (not caught by unit tests alone, since the existing test fixtures override this setting):** `showTerminalOutput`'s `coloredTimeline` path (the `colorApiPath` variant used by the CLI's live terminal display) was originally assumed out of scope on the belief that `CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT` defaults to `false`. It actually defaults to `'true'` (`SettingsDefaultsManager`), so this branch fires on every SessionStart hook by default and unconditionally called `executeWithWorkerFallback(colorApiPath, 'GET')` regardless of runtime — reintroducing exactly the wasteful/racy local-worker lazy-spawn a server-runtime-only deployment is meant to avoid. Fixed in the same branch: an `usedServerRuntime` flag set alongside `additionalContext`, and when true, `coloredTimeline` reuses the already-fetched plain `additionalContext` (no server-side "colors" variant of `/v1/context` exists — colors are cosmetic ANSI codes for interactive terminal display, not part of the model-context contract) instead of attempting a worker round-trip.

## Testing

- Unit: `contextHandler.execute()` with `CLAUDE_MEM_RUNTIME=server` + valid server settings → asserts `ServerClient.contextObservations` called with no `query`, returned `context` string flows through to `additionalContext`.
- Unit: same, with `ServerClient.contextObservations` throwing each `ServerClientErrorKind` → asserts `emptyResult`, no worker-fallback HTTP call attempted (spy/mock `executeWithWorkerFallback` and assert zero calls).
- Unit: `buildServerContext()` returning `null` (missing url/key/projectId) → asserts `emptyResult`, no client call attempted.
- Server-side: `/v1/context` with omitted `query` → asserts recency ordering (seed observations with distinct `occurred_at`, assert response order), and that an explicit `query` still gets relevance ordering (no regression to existing FTS behavior/tests).
- Existing worker-mode + `codex`-platform tests for `contextHandler` must be unaffected — this is purely an additive branch ahead of the existing logic.
- `scripts/e2e-server-docker.sh` (the existing server-beta Docker Compose e2e) is the right place to add an end-to-end assertion that a fresh `claude-mem-server` (no worker running) yields non-empty `SessionStart` `additionalContext` after at least one prior observation exists for the project — this is the actual regression this plan closes for a from-scratch server-only deployment.

## Open Questions

- Should `observation_search`'s `query` also become optional for symmetry (a "list recent, unfiltered" mode), or is that a separate, unrelated ask? Leaning toward leaving `observation_search` as-is (search without a term isn't a meaningful search) and only touching `observation_context` (which already has clear "top-N for injection" semantics independent of relevance).
- `limit` default for the no-query/recency path: reuse the existing default (10) or should recency-mode default higher, matching worker-mode's typical injected-observation count? Worker-mode's `/api/context/inject` used a project-configurable observation count (`CLAUDE_MEM_CONTEXT_OBSERVATIONS`, default 50 per `SettingsDefaultsManager`); defaulting recency-mode to 10 would inject visibly less context than worker-mode users are used to. Proposing recency-mode default to the same `CLAUDE_MEM_CONTEXT_OBSERVATIONS`-derived value the worker path already reads, rather than the FTS-mode default of 10, so a straight worker→server cutover doesn't feel like a UX regression in observation count.
