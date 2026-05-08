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
