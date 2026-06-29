# Server Beta Parity Map

This document enumerates every legacy worker HTTP route under `/api/` and
records its status in the **Server beta** runtime (Phase 9 onwards).

Each row uses one of three statuses:

- `native`     — Server beta has its own implementation under `/v1/*` (or
                another non-legacy path) and clients should migrate to it.
- `adapter`    — A compatibility adapter under `src/server/compat/*` translates
                the legacy payload into a `/v1/*`-equivalent code path. Adapter
                response shapes preserve the worker's so existing clients keep
                working unchanged.
- `unsupported` — The Server beta runtime intentionally does not serve the
                route. The reason is documented inline. Clients that need
                that surface must continue using the legacy worker runtime.

The Server beta runtime is selected via `CLAUDE_MEM_RUNTIME=server-beta`. The
worker runtime remains the default for now.

## Session lifecycle (legacy `/api/sessions/*`)

| Legacy path                       | Native server-beta replacement              | Adapter                                              | Status   |
| --------------------------------- | ------------------------------------------- | ---------------------------------------------------- | -------- |
| `POST /api/sessions/init`         | `POST /v1/sessions/start`                   | _(no adapter — clients should call `/v1/sessions/start` directly)_ | native\* |
| `POST /api/sessions/observations` | `POST /v1/events`                           | `src/server/compat/SessionsObservationsAdapter.ts`   | adapter  |
| `POST /api/sessions/summarize`    | `POST /v1/sessions/:id/end`                 | `src/server/compat/SessionsSummarizeAdapter.ts`      | adapter  |
| `GET  /api/sessions/status`       | `GET /v1/sessions/:id`                      | _(no adapter)_                                       | native\* |

\* `native` rows above mark routes whose canonical replacement exists under
`/v1/*` but no automatic translation is provided. The legacy hook layer is
expected to use the new client (`ServerBetaClient`) directly. Old worker
clients that still POST `/api/sessions/init` against a Server beta port get a
404 — by design, since the contract differs (init implicitly created a
session DB id, sessions/start returns a project-scoped server_session UUID).

## Health and runtime info

| Legacy path        | Native server-beta replacement       | Adapter        | Status |
| ------------------ | ------------------------------------ | -------------- | ------ |
| `GET /api/health`  | `GET /api/health`                    | _(none — same path)_ | native |
| `GET /api/info`    | `GET /v1/info`                       | _(none)_       | native |
| `GET /healthz`     | `GET /healthz`                       | _(none — same path)_ | native |

`/api/health` is served by the shared `Server` class for both runtimes; the
JSON payload includes `runtime: "server-beta"` when the Server beta runtime
is active. `/api/info` is served by the worker runtime only and should be
replaced by `/v1/info` for Server beta clients.

## Search, context, and instructions

| Legacy path                        | Native server-beta replacement | Adapter | Status                                |
| ---------------------------------- | ------------------------------ | ------- | ------------------------------------- |
| `GET  /api/search`                 | `POST /v1/search`              | _(none)_ | unsupported (legacy GET — see note 1) |
| `GET  /api/timeline`               | _(none yet)_                   | _(none)_ | unsupported                           |
| `GET  /api/decisions`              | _(none yet)_                   | _(none)_ | unsupported                           |
| `GET  /api/changes`                | _(none yet)_                   | _(none)_ | unsupported                           |
| `GET  /api/how-it-works`           | _(none yet)_                   | _(none)_ | unsupported                           |
| `GET  /api/search/observations`    | `POST /v1/search`              | _(none)_ | unsupported (legacy shape; new clients use `/v1/search`) |
| `GET  /api/search/sessions`        | _(none yet)_                   | _(none)_ | unsupported                           |
| `GET  /api/search/prompts`         | _(none yet)_                   | _(none)_ | unsupported                           |
| `GET  /api/search/by-concept`      | _(none yet)_                   | _(none)_ | unsupported                           |
| `GET  /api/search/by-file`         | _(none yet)_                   | _(none)_ | unsupported                           |
| `GET  /api/search/by-type`         | _(none yet)_                   | _(none)_ | unsupported                           |
| `GET  /api/context/recent`         | `POST /v1/context`             | _(none)_ | unsupported (legacy GET shape)        |
| `GET  /api/context/timeline`       | _(none yet)_                   | _(none)_ | unsupported                           |
| `GET  /api/context/preview`        | _(none yet)_                   | _(none)_ | unsupported                           |
| `GET  /api/context/inject`         | _(none yet)_                   | _(none)_ | unsupported                           |
| `POST /api/context/semantic`       | `POST /v1/context`             | _(none)_ | unsupported                           |
| `GET  /api/onboarding/explainer`   | _(none yet)_                   | _(none)_ | unsupported                           |
| `GET  /api/timeline/by-query`      | _(none yet)_                   | _(none)_ | unsupported                           |
| `GET  /api/search/help`            | _(none yet)_                   | _(none)_ | unsupported                           |

> Note 1: legacy `GET /api/search` accepts query-string parameters and
> returns a denormalized SQLite-shaped result. The Server beta `/v1/search`
> POST API takes a JSON body `{projectId, query, limit}` and returns a
> normalized observation array. We deliberately do not adapt the legacy
> shape because (a) legacy callers are already in a phased migration to
> the MCP search tool which goes through `/v1/search`, (b) supporting the
> SQLite shape would require shimming a SQLite read layer back into the
> Postgres runtime, which contradicts the Phase 9 anti-pattern guard.

## Memory write paths

| Legacy path             | Native server-beta replacement | Adapter | Status        |
| ----------------------- | ------------------------------ | ------- | ------------- |
| `POST /api/memory/save` | `POST /v1/memories`            | _(none)_ | unsupported (legacy schema — new clients use `/v1/memories`) |

## Settings and runtime control

| Legacy path                  | Native server-beta replacement | Adapter | Status |
| ---------------------------- | ------------------------------ | ------- | ------ |
| `GET  /api/settings`         | _(none — settings are env vars in server-beta)_ | _(none)_ | unsupported |
| `POST /api/settings`         | _(none — settings are env vars in server-beta)_ | _(none)_ | unsupported |
| `GET  /api/mcp/status`       | `GET /v1/info`                 | _(none)_ | unsupported (legacy shape) |
| `POST /api/mcp/toggle`       | _(none — server-beta MCP is always on)_ | _(none)_ | unsupported |
| `GET  /api/branch/status`    | _(none yet)_                   | _(none)_ | unsupported |
| `POST /api/branch/switch`    | _(none yet)_                   | _(none)_ | unsupported |
| `POST /api/branch/update`    | _(none yet)_                   | _(none)_ | unsupported |

Settings in Server beta are environment variables and the API key surface in
`api_keys`; there is no mutable user-settings JSON file. The branch routes
were a worker-specific feature and are not exposed by Server beta.

## Logs

| Legacy path             | Native server-beta replacement      | Adapter | Status                    |
| ----------------------- | ----------------------------------- | ------- | ------------------------- |
| `GET  /api/logs`        | _(none — server-beta logs to stdout)_ | _(none)_ | unsupported              |
| `POST /api/logs/clear`  | _(none — log is append-only stream)_ | _(none)_ | unsupported              |

## Data viewer (read-only legacy data)

| Legacy path                       | Native server-beta replacement | Adapter | Status                       |
| --------------------------------- | ------------------------------ | ------- | ---------------------------- |
| `GET  /api/observations`          | `POST /v1/search` / `/v1/context` | _(none)_ | unsupported (see note 2)   |
| `GET  /api/summaries`             | _(none yet)_                   | _(none)_ | unsupported (note 2)         |
| `GET  /api/prompts`               | _(none yet)_                   | _(none)_ | unsupported (note 2)         |
| `GET  /api/observation/:id`       | _(none yet)_                   | _(none)_ | unsupported                  |
| `GET  /api/observations/by-file`  | _(none yet)_                   | _(none)_ | unsupported                  |
| `POST /api/observations/batch`    | _(none yet)_                   | _(none)_ | unsupported                  |
| `GET  /api/session/:id`           | `GET /v1/sessions/:id`         | _(none)_ | unsupported (legacy shape)   |
| `POST /api/sdk-sessions/batch`    | _(none yet)_                   | _(none)_ | unsupported                  |
| `GET  /api/prompt/:id`            | _(none yet)_                   | _(none)_ | unsupported                  |
| `GET  /api/stats`                 | _(none yet)_                   | _(none)_ | unsupported                  |
| `GET  /api/projects`              | `GET /v1/projects` (planned)   | _(none)_ | unsupported                  |
| `GET  /api/processing-status`     | _(none yet)_                   | _(none)_ | unsupported                  |
| `POST /api/processing`            | _(none yet)_                   | _(none)_ | unsupported                  |
| `POST /api/import`                | _(none yet)_                   | _(none)_ | unsupported                  |

> Note 2: the legacy data viewer routes return SQLite-shaped rows joined
> across worker-specific tables (e.g. `sdk_sessions.message_id`). Server
> beta stores data in Postgres with a different normalized shape. Reproducing
> the legacy join shapes would require a translation layer that competes
> with the canonical `/v1/*` API. **Out of scope for Phase 9.** The viewer
> UI continues to use the worker's `/api/*` data routes for now; in Server
> beta-only deployments the viewer is expected to call `/v1/*` directly
> (planned for a follow-up phase). Listed as `unsupported` so that callers
> know they MUST run the worker runtime if they need the legacy SQLite
> data viewer.

## Corpus and skills

| Legacy path                         | Native server-beta replacement | Adapter | Status        |
| ----------------------------------- | ------------------------------ | ------- | ------------- |
| `POST /api/corpus`                  | _(none yet)_                   | _(none)_ | unsupported   |
| `GET  /api/corpus`                  | _(none yet)_                   | _(none)_ | unsupported   |
| `GET  /api/corpus/:name`            | _(none yet)_                   | _(none)_ | unsupported   |
| `DELETE /api/corpus/:name`          | _(none yet)_                   | _(none)_ | unsupported   |
| `POST /api/corpus/:name/rebuild`    | _(none yet)_                   | _(none)_ | unsupported   |
| `POST /api/corpus/:name/prime`      | _(none yet)_                   | _(none)_ | unsupported   |
| `POST /api/corpus/:name/query`      | _(none yet)_                   | _(none)_ | unsupported   |
| `POST /api/corpus/:name/reprime`    | _(none yet)_                   | _(none)_ | unsupported   |

Corpora are a Chroma-backed worker feature. The Server beta storage layer is
Postgres-only. Migration of the corpus subsystem to Server beta is out of
scope for Phase 9.

## Chroma vector status

| Legacy path                | Native server-beta replacement | Adapter | Status      |
| -------------------------- | ------------------------------ | ------- | ----------- |
| `GET /api/chroma/status`   | _(none — server-beta is Postgres-only)_ | _(none)_ | unsupported |

## Anti-pattern guards (referenced in Phase 9)

The following grep MUST return zero matches:

```
rg -n "services/worker/http/routes|WorkerService" src/server/compat src/server/runtime
rg -n "from '.*services/worker" src/server/compat
```

Compat adapters live in `src/server/compat/` and call only:

- `src/server/services/IngestEventsService.ts`
- `src/server/services/EndSessionService.ts`
- `src/storage/postgres/*`
- `src/server/middleware/postgres-auth.ts`

They never reach into worker route classes, the worker DatabaseManager, or
the WorkerService — which is the load-bearing decoupling Phase 9 enforces.
