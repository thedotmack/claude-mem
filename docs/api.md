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
