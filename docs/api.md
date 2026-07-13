# Server API

REST V1 is mounted under `/v1`; legacy worker routes remain under `/api`.

Available beta endpoints:

- `GET /healthz`
- `GET /v1/info`
- `GET /v1/projects`
- `POST /v1/projects`
- `GET /v1/projects/:id`
- `POST /v1/sessions/start`
- `POST /v1/sessions/:id/end`
- `GET /v1/sessions/:id`
- `POST /v1/events`
- `POST /v1/events/batch`
- `GET /v1/events/:id`
- `POST /v1/memories`
- `GET /v1/memories/:id`
- `PATCH /v1/memories/:id`
- `POST /v1/search`
- `POST /v1/context`
- `ALL /v1/mcp` (remote MCP recall — see below)
- `POST /v1/keys`
- `GET /v1/connect`
- `GET /v1/usage`
- `DELETE /v1/memories/:id`
- `DELETE /v1/projects/:projectId/memory`
- `GET /v1/audit?projectId=<id>`

When `CLAUDE_MEM_AUTH_MODE=api-key`, send `Authorization: Bearer <key>`. Read endpoints require `memories:read`; write endpoints require `memories:write`.

## Rate limiting, quota, and usage metering

These paid-readiness guards run after auth and are **opt-in via env** — unset (the
default) means no rate limit, no quota, and no metering, so behavior is unchanged.

- `CLAUDE_MEM_RATE_LIMIT_PER_MIN` — max requests per API key per minute. Over the
  limit returns `429` with `Retry-After` (and `X-RateLimit-*` headers). Fail-open.
- `CLAUDE_MEM_MONTHLY_REQUEST_CAP` — max requests per team per calendar month
  (UTC). At the cap, returns `402 quota_exceeded`. Fail-open.
- `CLAUDE_MEM_MONTHLY_TOKEN_CAP` — max provider tokens per team per month. Gates
  **writes only** (ingestion drives generation = token spend); reads stay
  available so a team over budget can still recall. `402` at the cap. Fail-open.
- `CLAUDE_MEM_USAGE_METERING=1` — record one `request` usage event per
  authenticated call (fire-and-forget). Token/observation metering writes to the
  same `usage_events` table from the generation worker.

`GET /v1/usage` returns the caller team's per-kind totals for the current month:

```json
{ "since": "2026-06-01T00:00:00.000Z", "usage": { "request": 1280, "observation": 44 } }
```

## Connecting an MCP client (key issuance + connect)

- `POST /v1/keys` (**write** scope) mints a **read-only** API key for the caller's
  team and returns the paste-ready connect command. The raw key is shown **once**.
  Body: `{ "expiresInDays"?: number }`. Minting requires write scope so a read key
  can't escalate into more keys.

  ```json
  {
    "id": "...", "apiKey": "cm_...", "scopes": ["memories:read"], "expiresAt": null,
    "mcpUrl": "https://<host>/v1/mcp",
    "connectCommand": "claude mcp add --transport http claude-mem https://<host>/v1/mcp --header \"Authorization: Bearer cm_...\""
  }
  ```

- `GET /v1/connect` (read scope) returns the same command with a `<YOUR_API_KEY>`
  placeholder (a GET never mints). `mcpUrl` is built from `CLAUDE_MEM_PUBLIC_URL`
  (recommended behind a proxy) or the request host.

> Cold-start note: minting the team's *first* key still needs a session-gated path
> (web dashboard). better-auth's `apiKey()` plugin exists but writes to a separate
> store than the Postgres `api_keys` these routes authenticate against — wiring the
> better-auth org → Server Beta team mapping is the remaining piece.

## Event generation semantics

`POST /v1/events` accepts two query flags that control observation generation:

- `generate=false` — write the event but do not enqueue a generation job.
- `wait=true` — return the `generationJob` descriptor in the response, so
  callers can poll `GET /v1/jobs/:id` for completion.

Without `wait=true`, the response includes the new event row and a best-
effort `generationJob` field. With `wait=true`, the `generationJob` field is
always populated (or `null` only when generation was explicitly disabled).
The actual provider call happens in a separate BullMQ worker process
(`claude-mem server worker start`); the HTTP path never blocks on a
provider response.

## Remote MCP endpoint

`/v1/mcp` is a streamable-HTTP [MCP](https://modelcontextprotocol.io) server —
the secure, authenticated link a user pastes into Claude Code (or any MCP
client) to recall their cloud memory. It is read-only and authenticated by the
same API key as the REST routes (`memories:read`); the key's team (and project,
if the key is project-scoped) bound every read.

Connect:

```bash
claude mcp add --transport http claude-mem <server-base>/v1/mcp \
  --header "Authorization: Bearer cm_..."
```

Tools:

- `search` — `{ projectId, query, limit? }` → matching observations (FTS, same
  path as `POST /v1/search`).
- `context` — `{ projectId, query, limit? }` → observations plus a concatenated
  `context` string ready for prompt injection (same path as `POST /v1/context`).
- `recent` — `{ projectId, limit? }` → the newest observations for a project.

The transport is stateless: one MCP server + transport per request, so it needs
no session affinity behind a load balancer. Mutating tools are intentionally
absent — a pasted recall link cannot write.

## Data deletion (forget)

Right-to-erasure. Both require **write** scope and are scoped to the caller's team.

- `DELETE /v1/memories/:id` — delete a single observation (its sources cascade). `404` if it doesn't exist for the team.
- `DELETE /v1/projects/:projectId/memory` — purge ALL captured content for a project (observations, agent events, sessions, generation jobs); keeps the project shell. Returns per-table `counts`. `404` if the project doesn't belong to the team. Both are audited (`observation.deleted` / `project.memory_purged`).
