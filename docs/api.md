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
- `GET /v1/audit?projectId=<id>`

When `CLAUDE_MEM_AUTH_MODE=api-key`, send `Authorization: Bearer <key>`. Read endpoints require `memories:read`; write endpoints require `memories:write`.

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
