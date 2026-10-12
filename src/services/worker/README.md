# Worker Service

The worker is the local HTTP runtime used by hooks, the viewer, MCP search, and
background observation generation. It is built into `plugin/scripts/worker-service.cjs`
and managed by Bun.

The port comes from `CLAUDE_MEM_WORKER_PORT`; if unset, the default is
`37700 + (uid % 100)`. The host comes from `CLAUDE_MEM_WORKER_HOST` and defaults
to `127.0.0.1`.

## Request Flow

```text
Hook or MCP client
  -> HTTP request to worker on configured host/port
    -> route handler in src/services/worker/http/routes/
      -> service layer, SQLite, Chroma, or MCP search logic
```

## Main Routes

- `GET /health` - worker health and version status
- `GET /` - viewer UI
- `GET /stream` - server-sent events for live viewer updates
- `/api/settings` - user settings and dependency health
- `/api/mcp/*` - MCP enable/disable status
- `/api/observations`, `/api/summaries`, `/api/prompts`, `/api/projects` - stored data
- `/api/search`, `/api/timeline`, `/api/context/*` - search and context preview/injection
- `/api/corpus/*` - knowledge-agent corpora
- `/api/logs` - local worker logs
- `/api/chroma/status` - Chroma integration status

There are no worker HTTP endpoints for switching git branches. Non-stable
release lines are run from source; see `docs/public/branches.mdx`.

## Route Layout

Route handlers live in `src/services/worker/http/routes/`:

- `ViewerRoutes.ts`
- `SettingsRoutes.ts`
- `SessionRoutes.ts`
- `DataRoutes.ts`
- `SearchRoutes.ts`
- `CorpusRoutes.ts`
- `MemoryRoutes.ts`
- `LogsRoutes.ts`
- `ChromaRoutes.ts`

Keep new endpoints in the nearest existing route class unless the behavior is a
new top-level API area.
