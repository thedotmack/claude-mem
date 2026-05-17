# Claude-Mem 13 Server Beta: Worker Parity Plus Team Features

Status: implementation plan  
Date: 2026-05-07  
Release target: claude-mem 13  
Primary goal: add `server (beta)` as an installer-selectable runtime while leaving the existing worker in place  
Relationship to prior plan: follows `plans/2026-05-07-claude-mem-server-apache-bullmq-team-auth.md`, but narrows the release strategy to full worker parity plus additive team features

## Executive Decision

Claude-Mem 13 should ship **Server (beta)** as an opt-in runtime, not as a worker replacement.

The existing worker remains:

- the default installer runtime;
- the stable compatibility path for current users;
- the implementation that current Claude Code hooks can continue to call;
- the fallback when Server beta is disabled, unhealthy, or not installed.

Server beta must reach feature parity by wrapping or copying worker behavior behind shared services before it claims to be a viable runtime. New team features are additive and must not break single-user local worker flows.

## Phase 0: Documentation Discovery

### Local Sources Read

- `plans/2026-05-07-claude-mem-server-apache-bullmq-team-auth.md`
- `/Users/alexnewman/Downloads/claude-mem-handoff-docs/claude-mem-server-plan.md`
- `/Users/alexnewman/Downloads/claude-mem-handoff-docs/apache-2-plan.md`
- `src/npx-cli/index.ts`
- `src/npx-cli/commands/install.ts`
- `src/npx-cli/commands/runtime.ts`
- `src/services/worker-service.ts`
- `src/services/worker-spawner.ts`
- `src/services/server/Server.ts`
- `src/services/worker/http/middleware.ts`
- `src/services/worker/http/routes/ViewerRoutes.ts`
- `src/services/worker/http/routes/SessionRoutes.ts`
- `src/services/worker/http/routes/DataRoutes.ts`
- `src/services/worker/http/routes/SearchRoutes.ts`
- `src/services/worker/http/routes/SettingsRoutes.ts`
- `src/services/worker/http/routes/LogsRoutes.ts`
- `src/services/worker/http/routes/MemoryRoutes.ts`
- `src/services/worker/http/routes/CorpusRoutes.ts`
- `src/services/worker/http/routes/ChromaRoutes.ts`
- `src/services/worker/http/shared.ts`
- `src/services/worker/SessionManager.ts`
- `src/services/sqlite/PendingMessageStore.ts`
- `src/services/queue/SessionQueueProcessor.ts`
- `src/services/worker/agents/ResponseProcessor.ts`
- `src/servers/mcp-server.ts`
- `plugin/hooks/hooks.json`
- `docker/claude-mem/Dockerfile`
- `docker/claude-mem/entrypoint.sh`
- `docker/claude-mem/run.sh`

### External Docs Read

- BullMQ Queues: https://docs.bullmq.io/guide/queues
- BullMQ Job IDs: https://docs.bullmq.io/guide/jobs/job-ids
- BullMQ Stalled Jobs: https://docs.bullmq.io/guide/jobs/stalled
- Better Auth Express Integration: https://better-auth.com/docs/integrations/express
- Better Auth API Key Plugin: https://better-auth.com/docs/plugins/api-key
- Better Auth Organization Plugin: https://better-auth.com/docs/plugins/organization

### Allowed APIs And Patterns

- Installer prompts use `@clack/prompts` through `p.select`, `p.confirm`, `p.tasks`, and `p.note` in `src/npx-cli/commands/install.ts`.
- Runtime commands delegate to installed plugin bundles through `spawnBunWorkerCommand(command, extraArgs)` in `src/npx-cli/commands/runtime.ts`.
- Worker lifecycle uses `ensureWorkerStarted(port, workerScriptPath)` from `src/services/worker-spawner.ts`.
- HTTP routes use `RouteHandler.setupRoutes(app)` and `Server.registerRoutes(handler)`.
- Route validation uses `zod` plus `validateBody(schema)`.
- Current ingestion should be copied through `ingestObservation`, `ingestPrompt`, and `ingestSummary` in `src/services/worker/http/shared.ts`.
- Current queue semantics should be copied from `PendingMessageStore`, `SessionQueueProcessor`, and `SessionManager.getMessageIterator`.
- Current MCP server uses low-level `@modelcontextprotocol/sdk` `Server`, `ListToolsRequestSchema`, and `CallToolRequestSchema`, with hand-written tool schemas in `src/servers/mcp-server.ts`.
- BullMQ jobs should be added through `Queue.add`, with custom job IDs or dedupe IDs for duplicate suppression.
- Better Auth Express handler must be mounted before `express.json()`. Express 5 catch-all docs use `/api/auth/*splat`.
- Better Auth API-key plugin supports create, verify, update, delete, list, permissions, metadata, rate limits, and organization-owned keys.
- Better Auth organization plugin supports organizations, members, teams, roles, permissions, and team configuration.

### Anti-Pattern Guards

- Do not remove, rename, or deprecate the worker in claude-mem 13.
- Do not make Server beta the default installer choice.
- Do not alter existing plugin hooks to require team auth.
- Do not ship Server beta without a route/command/MCP parity matrix.
- Do not put Better Auth behind global `express.json()`.
- Do not use BullMQ as the memory source of truth.
- Do not silently fall back when the user explicitly selects Server beta and BullMQ cannot start.
- Do not claim full team sync, hosted cloud, SSO, billing, or enterprise admin UI in claude-mem 13.

## Worker Parity Matrix

Server beta is not parity-complete until every item below is implemented or explicitly routed to the worker compatibility path.

### Lifecycle And CLI

- `npx claude-mem install`
- `npx claude-mem repair`
- `npx claude-mem update`
- `npx claude-mem uninstall`
- `npx claude-mem start`
- `npx claude-mem stop`
- `npx claude-mem restart`
- `npx claude-mem status`
- `npx claude-mem search <query>`
- `npx claude-mem adopt [--dry-run] [--branch <name>]`
- `npx claude-mem cleanup [--dry-run]`
- `npx claude-mem transcript watch`
- `plugin/scripts/worker-service.cjs start|stop|restart|status|cursor|gemini-cli|hook|generate|clean|adopt|cleanup|--daemon`

### Hook Compatibility

- SessionStart worker autostart hook
- SessionStart context injection hook
- UserPromptSubmit session-init hook
- PostToolUse observation hook
- file context hook
- Stop/Summarize hook
- Current JSON hook outputs with `continue: true` and `suppressOutput: true`

### HTTP Routes

- Viewer and stream: `GET /`, `GET /health`, `GET /stream`
- Core status: `GET /api/health`, `GET /api/readiness`, `GET /api/version`, `GET /api/instructions`
- Admin: `POST /api/admin/restart`, `POST /api/admin/shutdown`, `GET /api/admin/doctor`
- Session ingest: `POST /api/sessions/init`, `POST /api/sessions/observations`, `POST /api/sessions/summarize`, `GET /api/sessions/status`
- Data: `GET /api/observations`, `GET /api/summaries`, `GET /api/prompts`, `GET /api/observation/:id`, `GET /api/observations/by-file`, `POST /api/observations/batch`, `GET /api/session/:id`, `POST /api/sdk-sessions/batch`, `GET /api/prompt/:id`, `GET /api/stats`, `GET /api/projects`, `GET /api/processing-status`, `POST /api/processing`, `POST /api/import`
- Search/context: `GET /api/search`, `GET /api/timeline`, `GET /api/decisions`, `GET /api/changes`, `GET /api/how-it-works`, `GET /api/search/observations`, `GET /api/search/sessions`, `GET /api/search/prompts`, `GET /api/search/by-concept`, `GET /api/search/by-file`, `GET /api/search/by-type`, `GET /api/context/recent`, `GET /api/context/timeline`, `GET /api/context/preview`, `GET /api/context/inject`, `POST /api/context/semantic`, `GET /api/onboarding/explainer`, `GET /api/timeline/by-query`, `GET /api/search/help`
- Settings/admin UI: `GET /api/settings`, `POST /api/settings`, `GET /api/mcp/status`, `POST /api/mcp/toggle`, `GET /api/branch/status`, `POST /api/branch/switch`, `POST /api/branch/update`
- Logs: `GET /api/logs`, `POST /api/logs/clear`
- Memory: `POST /api/memory/save`
- Corpus: `POST /api/corpus`, `GET /api/corpus`, `GET /api/corpus/:name`, `DELETE /api/corpus/:name`, `POST /api/corpus/:name/rebuild`, `POST /api/corpus/:name/prime`, `POST /api/corpus/:name/query`, `POST /api/corpus/:name/reprime`
- Chroma: `GET /api/chroma/status`

### MCP Tools

- `__IMPORTANT`
- `search`
- `timeline`
- `get_observations`
- `smart_search`
- `smart_unfold`
- `smart_outline`
- `build_corpus`
- `list_corpora`
- `prime_corpus`
- `query_corpus`
- `rebuild_corpus`
- `reprime_corpus`

### Runtime Capabilities

- SQLite observation/session/source storage
- Chroma optional semantic search and health probe
- Claude/Gemini/OpenRouter providers
- Provider auth methods and env isolation
- User prompts, summaries, observations, session summaries
- Project catalog and platform source filtering
- Context injection and welcome hint behavior
- Smart file read/search tools
- Knowledge corpus build/prime/query lifecycle
- SSE viewer updates and processing-status broadcasts
- Settings file creation/update/validation
- Branch status/switch/update compatibility
- Logs tail and clear behavior
- Transcript watcher
- Worktree adoption and v12.4.3 cleanup
- MCP status/toggle compatibility
- Privacy skip behavior with `<private>` and excluded projects
- Tool skip rules and `session-memory` meta skip rules
- Queue dedupe, FIFO, idle timeout, restart recovery, and queue depth

## Phase 1: Runtime Selection In Installer

What to implement:

- Add installer runtime selection after provider/model prompts and before worker autostart:
  - `Worker (stable, recommended)`
  - `Server (beta)`
- Add non-interactive flags:
  - `--runtime worker`
  - `--runtime server-beta`
  - `--queue sqlite|bullmq`
  - `--redis-url <url>`
  - `--no-server-beta-autostart`
- Persist runtime settings:
  - `CLAUDE_MEM_RUNTIME=worker|server-beta`
  - `CLAUDE_MEM_SERVER_BETA_ENABLED=true|false`
  - `CLAUDE_MEM_SERVER_PORT`
  - `CLAUDE_MEM_SERVER_HOST`
  - `CLAUDE_MEM_QUEUE_ENGINE=sqlite|bullmq`
- For claude-mem 13, default to worker in interactive and non-interactive installs unless the user explicitly selects Server beta.
- If Server beta is selected, still install the worker bundle and keep worker commands available.

Documentation references:

- Copy prompt style from `promptProvider()` and `promptClaudeModel()` in `src/npx-cli/commands/install.ts`.
- Copy settings merge pattern from `mergeSettings(...)` in `src/npx-cli/commands/install.ts`.
- Copy autostart task structure from the existing `Starting worker daemon` task.

Verification checklist:

- Add tests for interactive runtime selection by unit-testing option parsing and settings writes.
- Add non-interactive tests for `--runtime worker`, `--runtime server-beta`, unknown runtime values, and default behavior.
- Verify `npx claude-mem install --no-auto-start` still skips worker/server startup.

Anti-pattern guards:

- Do not make Server beta the default.
- Do not skip worker installation when Server beta is selected.
- Do not change current provider/model prompt order unless tests cover it.

## Phase 2: Dual Runtime Lifecycle

What to implement:

- Add `src/npx-cli/commands/server-runtime.ts` or extend runtime command helpers with server-aware variants.
- Add `claude-mem server start|stop|restart|status|doctor|logs`.
- Keep `claude-mem start|stop|restart|status` mapped to the selected runtime, but in claude-mem 13 default that selection is worker.
- Add explicit stable aliases:
  - `claude-mem worker start`
  - `claude-mem worker stop`
  - `claude-mem worker restart`
  - `claude-mem worker status`
- Add PID/port files for server beta separate from worker:
  - `.server.pid`
  - `.server.port`
  - `server-YYYY-MM-DD.log`
- Add server-spawner equivalent to `ensureWorkerStarted(...)`.

Documentation references:

- Copy `spawnBunWorkerCommand` from `src/npx-cli/commands/runtime.ts`.
- Copy PID safety and daemon spawn patterns from `src/services/worker-spawner.ts` and `src/services/infrastructure/ProcessManager.ts`.

Verification checklist:

- `claude-mem worker status` works with existing worker.
- `claude-mem server status` does not lie when server beta is not installed.
- Starting server beta does not stop the worker unless the user explicitly asks.
- PID files do not conflict.

Anti-pattern guards:

- Do not overload `.worker.pid` or `.worker.port` for server beta.
- Do not change plugin hook autostart to server beta in this phase.

## Phase 3: Compatibility Router For `/api/*`

What to implement:

- Create `src/server/compat/worker-api-routes.ts`.
- Register all current `/api/*`, `/`, `/health`, and `/stream` routes in Server beta.
- For the first implementation, copy route classes and inject shared dependencies rather than rewriting route behavior.
- Keep output shapes byte-compatible enough for existing viewer, MCP, hooks, and docs.
- Add parity snapshots for response fields on health, readiness, stats, projects, processing status, search, observations batch, settings, logs, and Chroma status.

Documentation references:

- Copy route class pattern from every file under `src/services/worker/http/routes`.
- Copy `Server.registerRoutes(...)` usage from `WorkerService.registerRoutes()`.
- Copy middleware gates from `src/services/worker-service.ts` for initialization readiness.

Verification checklist:

- Add `tests/server/parity/routes.test.ts` that asserts every route from the parity matrix is registered.
- Add integration smoke tests for representative GET/POST routes.
- Run existing worker route tests against worker and server beta where feasible.

Anti-pattern guards:

- Do not introduce `/v1` routes as a substitute for `/api/*` parity.
- Do not change viewer or MCP clients before compatibility routes pass.

## Phase 4: Shared Runtime Services

What to implement:

- Extract a runtime composition layer that both worker and server beta can use:
  - database manager;
  - session manager;
  - provider agents;
  - SSE broadcaster;
  - settings manager;
  - corpus store/builder/knowledge agent;
  - Chroma manager;
  - transcript watcher.
- Keep `WorkerService` as the stable wrapper.
- Add `ServerBetaService` as a parallel wrapper that composes the same service graph.

Documentation references:

- Copy constructor wiring from `WorkerService.constructor`.
- Copy background initialization from `WorkerService.initializeBackground()`.
- Copy provider status logic from `WorkerService` server options.

Verification checklist:

- Worker tests still pass after extraction.
- Server beta starts with the same DB/search initialization behavior.
- Chroma disabled/enabled behavior remains unchanged.

Anti-pattern guards:

- Do not create a second implementation of search, context injection, corpus, or settings logic.
- Do not move Bun-only imports into the Node MCP bundle.

## Phase 5: Queue Parity Then BullMQ

What to implement:

- First, put the current SQLite queue behind an `ObservationQueueEngine` interface.
- Run the same queue contract tests against worker and server beta using SQLite.
- Only after SQLite parity is green, add `BullMqObservationQueueEngine` for Server beta.
- For claude-mem 13, allow:
  - worker plus SQLite queue;
  - server beta plus SQLite queue;
  - server beta plus BullMQ queue.
- Preserve:
  - per-session FIFO;
  - one active provider consumer per session;
  - `_persistentId`;
  - `_originalTimestamp`;
  - duplicate suppression by `tool_use_id`;
  - idle timeout;
  - restart reset/reclaim;
  - queue depth and processing status.

Documentation references:

- Copy current queue behavior from `PendingMessageStore`, `SessionQueueProcessor`, and `SessionManager.getMessageIterator`.
- Copy BullMQ job-id guidance from BullMQ docs.
- Copy BullMQ stalled-job handling assumptions from BullMQ docs.

Verification checklist:

- Shared queue contract test suite:
  - enqueue;
  - claim;
  - FIFO;
  - dedupe;
  - idle timeout;
  - crash/restart;
  - queue depth;
  - clear on response.
- BullMQ tests gated by `CLAUDE_MEM_REDIS_URL` or Docker Compose.

Anti-pattern guards:

- Do not introduce BullMQ until SQLite queue parity is green.
- Do not use BullMQ Pro-only grouping features.
- Do not store canonical memories in Redis.

## Phase 6: Team Data Model

What to implement:

- Add team-aware tables while preserving local single-user behavior:
  - `users`
  - `organizations`
  - `teams`
  - `team_members`
  - `projects.team_id`
  - `memory_items.team_id`
  - `agent_events.team_id`
  - `audit_log.team_id`
- Create a default local user, organization, and team for existing data:
  - `local-user`
  - `local-org`
  - `personal`
- Backfill existing observations/sessions/projects to the default team without changing existing project names or search output.
- Add migration guardrails and rollback-safe backups.

Documentation references:

- Use team/org concepts from Better Auth organization docs.
- Copy migration style from `src/services/sqlite/migrations/runner.ts`.
- Copy existing data access patterns from `src/services/sqlite/SessionStore.ts`.

Verification checklist:

- Fresh DB creates default team.
- Existing DB migration backfills all rows.
- Existing search/context routes still return the same single-user results when no team filter is provided.
- Team IDs are indexed on all new team-scoped tables.

Anti-pattern guards:

- Do not require login for existing local worker usage.
- Do not rewrite historical project names during backfill.

## Phase 7: Better Auth Integration For Server Beta

What to implement:

- Add Better Auth only to Server beta in claude-mem 13.
- Add auth route mount before JSON middleware.
- Add API-key auth middleware for Server beta `/v1/*` and team admin routes.
- Keep legacy `/api/*` compatibility routes in local-dev mode by default for current hooks.
- Add API-key CLI:
  - `claude-mem server api-key create`
  - `claude-mem server api-key list`
  - `claude-mem server api-key revoke`
- Add team CLI:
  - `claude-mem server team create`
  - `claude-mem server team list`
  - `claude-mem server team invite`
  - `claude-mem server team members`
  - `claude-mem server team switch`
- Add permissions:
  - `memories:read`
  - `memories:write`
  - `memories:forget`
  - `events:write`
  - `projects:read`
  - `projects:write`
  - `admin:read`
  - `admin:write`

Documentation references:

- Better Auth Express docs for handler order.
- Better Auth API Key plugin docs for create/verify/list/update/delete and permissions.
- Better Auth Organization plugin docs for organizations, teams, and roles.

Verification checklist:

- Auth handler works before body parser.
- API keys are shown once on creation.
- Raw API keys are not stored.
- Revoked keys fail.
- Read-only keys cannot write.
- Team-scoped keys cannot read another team's memories.
- Worker local routes still work without API keys.

Anti-pattern guards:

- Do not enable Better Auth on the worker stable path in claude-mem 13.
- Do not require browser login for CLI/hook flows.
- Do not add SSO/SAML/SCIM.

## Phase 8: Team-Aware REST API

What to implement:

- Add `/v1/*` routes for Server beta:
  - `GET /v1/info`
  - `GET /v1/me`
  - `GET /v1/teams`
  - `POST /v1/teams`
  - `GET /v1/projects`
  - `POST /v1/projects`
  - `POST /v1/events`
  - `POST /v1/events/batch`
  - `POST /v1/memories`
  - `GET /v1/memories/:id`
  - `PATCH /v1/memories/:id`
  - `POST /v1/search`
  - `POST /v1/context`
  - `POST /v1/forget`
  - `GET /v1/audit`
  - `POST /v1/export`
  - `POST /v1/import`
- Make every `/v1` route team-aware through `authContext.teamId`.
- Keep `/api/*` as compatibility routes and do not force team scoping into their public response shape.

Documentation references:

- Copy Zod validation style from worker route schemas.
- Use data contracts from `claude-mem-server-plan.md`.

Verification checklist:

- OpenAPI or JSON schema generated from Zod schemas.
- Every `/v1` write requires auth.
- Every `/v1` read is scoped to the active team.
- `/api/search` still behaves like worker for local compatibility.

Anti-pattern guards:

- Do not make `/v1` silently fall back to unscoped global reads.
- Do not break MCP tool response formats while adding `/v1`.

## Phase 9: MCP Parity Plus Team MCP

What to implement:

- Keep all current MCP tools working against worker and server beta:
  - `search`
  - `timeline`
  - `get_observations`
  - smart file tools
  - corpus tools
- Add optional team-aware MCP tools for Server beta:
  - `memory_add`
  - `memory_search`
  - `memory_context`
  - `memory_forget`
  - `memory_list_recent`
  - `memory_record_decision`
  - `team_list`
  - `team_switch`
- Add auth config path for MCP clients:
  - local worker mode: no API key required;
  - server beta team mode: API key required for team tools.

Documentation references:

- Copy existing tool declaration and request handler pattern from `src/servers/mcp-server.ts`.
- Copy MCP schema tests from `tests/servers/mcp-tool-schemas.test.ts`.

Verification checklist:

- Existing MCP tool snapshots unchanged.
- New team tools require API key when server beta team mode is enabled.
- MCP server bundle size guard still passes.

Anti-pattern guards:

- Do not import server beta auth or BullMQ into smart file-read tools unless needed.
- Do not remove the 3-layer search workflow guidance.

## Phase 10: Hook Routing Strategy

What to implement:

- Keep plugin hooks calling `worker-service.cjs` in claude-mem 13 by default.
- When installer selects Server beta, write setting `CLAUDE_MEM_RUNTIME=server-beta` and have hook handlers route to server beta only after server beta health is confirmed.
- If server beta is unhealthy, hook handler should fall back to worker and log a warning.
- Preserve hook JSON output and timeout behavior.
- Add a runtime status line in `/api/health` and `/v1/info`:
  - `runtime: worker|server-beta`
  - `compatWorkerAvailable: boolean`
  - `serverBetaEnabled: boolean`

Documentation references:

- Copy hook commands from `plugin/hooks/hooks.json`.
- Copy hook handler routing from `src/services/worker-service.ts` cases `hook`, `generate`, and daemon startup.

Verification checklist:

- Existing hooks still pass lifecycle tests.
- Server beta selected install routes hooks to server only when healthy.
- Server beta down means worker fallback and no hook failure.
- Hook outputs remain valid JSON where expected.

Anti-pattern guards:

- Do not make user sessions fail because Server beta is down.
- Do not change hook command lines until fallback tests exist.

## Phase 11: Viewer And Admin UX Parity

What to implement:

- Make existing viewer work against worker and server beta compatibility routes.
- Add non-invasive Server beta status to the existing viewer:
  - runtime;
  - queue engine;
  - Redis/Valkey status when BullMQ is enabled;
  - active team in server beta mode.
- Add team switcher only when Server beta team features are enabled.
- Keep current single-user worker UI unchanged by default.

Documentation references:

- Copy viewer route behavior from `ViewerRoutes`.
- Copy current UI API calls from `src/ui/viewer`.

Verification checklist:

- Viewer loads at `/` in worker.
- Viewer loads at `/` in server beta.
- SSE stream works in both.
- Team UI is hidden in worker mode.

Anti-pattern guards:

- Do not turn the viewer into an enterprise admin console in claude-mem 13.
- Do not require auth for local worker viewer.

## Phase 12: Docker Compose Beta Profile

What to implement:

- Add Docker Compose profile for Server beta:
  - `claude-mem-server-beta`
  - `valkey`
  - optional `chroma`
- Keep existing `docker/claude-mem` harness available.
- Persist:
  - SQLite data;
  - logs;
  - Valkey AOF data;
  - generated API keys/auth DB.
- Add healthchecks:
  - `GET /healthz`
  - Valkey `PING`
- Add docs for local-only vs container-bound host settings.

Documentation references:

- Copy current Docker auth/credential mounting from `docker/claude-mem/entrypoint.sh` and `run.sh`.
- Copy Valkey config guidance from `plans/2026-05-06-redis-dependency-strategy.md`.

Verification checklist:

- `docker compose --profile server-beta up --build`
- Server beta health passes.
- Queue survives server container restart.
- API-key protected `/v1/info` works.

Anti-pattern guards:

- Do not remove existing Docker harness.
- Do not bind unauthenticated team server to public interfaces.

## Phase 13: Docs, Labels, And Release Guardrails

What to implement:

- Update install docs with:
  - Worker stable path;
  - Server beta option;
  - what beta means;
  - fallback behavior;
  - known gaps;
  - team feature scope.
- Add `docs/server-beta.md`.
- Add `docs/server-beta-parity.md` with the parity matrix and test commands.
- Add `docs/team-features.md`.
- Add changelog language for claude-mem 13:
  - "Server beta is opt-in."
  - "Worker remains the stable default."
  - "Team features are beta and server-only."

Documentation references:

- Copy public docs tone from `docs/public/*.mdx`.
- Copy product boundary from handoff docs.

Verification checklist:

- `rg -n "server beta|Server \\(beta\\)|worker stable|team features" README.md docs`
- No docs imply worker removal.
- No docs imply hosted cloud/SSO/billing is included.

Anti-pattern guards:

- Do not call Server beta production-stable.
- Do not imply team memory sync is complete unless implemented.

## Final Verification Phase

Run:

```sh
npm run typecheck:root
bun test tests/server/ tests/services/queue/ tests/services/sqlite/ tests/servers/
bun test tests/integration/worker-api-endpoints.test.ts
bun test tests/hook-lifecycle.test.ts tests/worker-spawn.test.ts tests/services/worker-spawner.test.ts
npm run build
docker compose --profile server-beta up --build
```

Parity acceptance:

- Worker is still default after `npx claude-mem install`.
- Installer can select `Server (beta)`.
- `claude-mem worker start|status|stop` works.
- `claude-mem server start|status|stop` works.
- Current Claude Code hooks continue working in worker mode.
- Server beta can run the current hook ingestion path.
- Every route in the parity matrix is present in Server beta or explicitly proxied to the worker.
- Every current MCP tool still works.
- Viewer and SSE work in both runtimes.
- SQLite queue parity passes before BullMQ is enabled.
- BullMQ mode passes Redis/Valkey integration tests.
- Team API keys enforce read/write/team boundaries.
- Existing local single-user workflows do not require API keys.

## Recommended Execution Order

1. Installer runtime selection with worker as default.
2. Dual runtime lifecycle and separate PID/port files.
3. `/api/*` compatibility router and route parity tests.
4. Shared runtime service extraction.
5. SQLite queue parity interface.
6. Server beta starts with SQLite queue and full worker parity.
7. Better Auth team model and API keys in Server beta only.
8. `/v1` team-aware API.
9. BullMQ/Valkey Server beta queue option.
10. MCP team additions.
11. Hook runtime routing with health-checked fallback.
12. Viewer beta status and optional team switcher.
13. Docker Compose Server beta profile.
14. Docs and release guardrails.

The key release rule: **claude-mem 13 can ship Server beta only when worker remains fully intact and Server beta has an explicit parity test report.**
