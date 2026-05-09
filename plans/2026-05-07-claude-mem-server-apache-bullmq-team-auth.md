# Claude-Mem Server: Apache-2.0, BullMQ, Team Auth Plan

Status: implementation plan  
Date: 2026-05-07  
Primary command: `claude-mem server`  
Target runtime: deployable Docker container plus local compatibility path  
Target license: Apache-2.0 for embeddable/core code

## Executive Decision

Build Claude-Mem Server inside this repo as the canonical next runtime. Keep the current worker as a compatibility shim while moving shared server logic into typed server/core/storage modules.

Use:

- Express 5 initially, because the repo already depends on it and all current routes use `RouteHandler.setupRoutes(app)`.
- BullMQ as the queue engine for deployable server mode.
- Valkey/Redis as the Redis-compatible queue store, with Docker Compose as the first deployable path.
- Better Auth for user/org/team auth and API-key management, after the Express middleware bootstrap is refactored to satisfy Better Auth's handler-order requirements.
- SQLite as the source of truth for memory records in v0.1, with Redis/BullMQ treated as queue state.
- Apache-2.0 for the open core, server, CLI, SDKs, schemas, adapters, MCP tools, tests, examples, and public docs.

Do not build hosted Magic Recall cloud, billing, SSO/SAML/SCIM, enterprise RBAC UI, or cross-customer managed sync in this pass.

## Phase 0: Documentation Discovery

### Local Sources Read

- `/Users/alexnewman/Downloads/claude-mem-handoff-docs/apache-2-plan.md`
- `/Users/alexnewman/Downloads/claude-mem-handoff-docs/claude-mem-server-plan.md`
- `package.json`
- `src/npx-cli/index.ts`
- `src/npx-cli/commands/runtime.ts`
- `src/services/server/Server.ts`
- `src/services/worker-service.ts`
- `src/services/worker/http/middleware.ts`
- `src/services/worker/http/routes/SessionRoutes.ts`
- `src/services/worker/http/routes/SearchRoutes.ts`
- `src/services/worker/http/routes/DataRoutes.ts`
- `src/services/worker/http/routes/MemoryRoutes.ts`
- `src/services/sqlite/PendingMessageStore.ts`
- `src/services/queue/SessionQueueProcessor.ts`
- `src/services/worker/SessionManager.ts`
- `src/services/sqlite/schema.sql`
- `src/services/sqlite/migrations/runner.ts`
- `src/servers/mcp-server.ts`
- `docker/claude-mem/Dockerfile`
- `docker/claude-mem/README.md`
- `plans/2026-05-06-observation-queue-engine-deep-dive.md`
- `plans/2026-05-06-redis-dependency-strategy.md`

### External Docs Read

- BullMQ Queues: https://docs.bullmq.io/guide/queues
- BullMQ Stalled Jobs: https://docs.bullmq.io/guide/jobs/stalled
- BullMQ Job IDs: https://docs.bullmq.io/guide/jobs/job-ids
- Better Auth Express Integration: https://better-auth.com/docs/integrations/express
- Better Auth API Key Plugin: https://better-auth.com/docs/plugins/api-key
- Better Auth Organization Plugin: https://better-auth.com/docs/plugins/organization

### Allowed APIs And Patterns

- Existing route pattern: implement route classes with `setupRoutes(app: express.Application): void`, then register through `Server.registerRoutes(handler)`.
- Existing validation pattern: use `zod` schemas with `validateBody(schema)` from `src/services/worker/http/middleware/validateBody.ts`.
- Existing MCP pattern: add tools to the `tools` array in `src/servers/mcp-server.ts`, with plain JSON Schema `inputSchema` and handlers that call server/core logic.
- BullMQ queue creation: use `new Queue(name, { connection })`, then enqueue jobs with `queue.add(name, data, options)`. BullMQ stores jobs in Redis and workers can pick them up later.
- BullMQ dedupe: use a custom `jobId` or deduplication id for observation dedupe. Custom job IDs are unique per queue and duplicate adds are ignored while the previous job still exists.
- BullMQ stalled-job recovery: active jobs are locked and moved back to waiting or failed if the worker stops renewing the lock.
- Better Auth Express mount: mount `app.all("/api/auth/*splat", toNodeHandler(auth))` before `express.json()` on Express 5. Do not place global `express.json()` before the Better Auth handler.
- Better Auth API keys: use API-key plugin server methods for create, verify, update, delete, list; API keys can carry permissions and org ownership.
- Better Auth org/team support: use organization plugin with `teams: { enabled: true }` and custom project/memory permissions.

### Anti-Pattern Guards

- Do not create a second repo or primary `claude-mem-server` package.
- Do not replace all current worker routes at once.
- Do not put auth routes behind global `express.json()` if using Better Auth.
- Do not make MCP duplicate retrieval/storage logic.
- Do not treat Redis as the memory source of truth.
- Do not use Bee-Queue.
- Do not put sensitive prompt/tool payloads in Redis without a clear retention and redaction policy.
- Do not silently fall back to SQLite when `CLAUDE_MEM_QUEUE_ENGINE=bullmq` is explicitly configured.
- Do not claim team/org memory sync or enterprise SaaS is shipped in v0.1.

## Phase 1: License And Product Boundary

What to implement:

- Replace root `LICENSE` with official Apache License 2.0 text.
- Update `package.json` and nested manifests intended for public/core distribution to `"license": "Apache-2.0"`.
- Add `NOTICE`.
- Add `docs/license.md` and `docs/ip-boundary.md` using the handoff language from `apache-2-plan.md`.
- Update README license language.
- Add scoped SPDX headers to new `src/server`, `src/core`, `src/storage`, `src/sdk`, and `src/adapters` files as they are created.

Documentation references:

- Copy exact license text from https://www.apache.org/licenses/LICENSE-2.0.
- Use scope and commercial boundary from `/Users/alexnewman/Downloads/claude-mem-handoff-docs/apache-2-plan.md`.

Verification:

- `rg -n "AGPL|GNU Affero|Affero|GPL|copyleft|license" .`
- `rg -n "Claude-Mem™|trademark|official Anthropic|endorsed by Anthropic" .`
- `bun test tests/infrastructure/version-consistency.test.ts`
- Human review still required for contributor rights and dependency-license audit.

Anti-pattern guards:

- Do not add trademark claims around `Claude-Mem`.
- Do not move commercial/private features into the Apache-2.0 repo.

## Phase 2: Server Namespace And Compatibility CLI

What to implement:

- Add `src/npx-cli/commands/server.ts`.
- Teach `src/npx-cli/index.ts` to route:
  - `claude-mem server start`
  - `claude-mem server stop`
  - `claude-mem server restart`
  - `claude-mem server status`
  - `claude-mem server doctor`
  - `claude-mem server logs`
  - `claude-mem server migrate`
  - `claude-mem server export`
  - `claude-mem server import`
  - `claude-mem server api-key create|list|revoke`
- Keep existing `start|stop|restart|status` as worker compatibility aliases.
- Add `claude-mem worker start|stop|restart|status` aliases that call the same command implementation as `server`.
- Teach `src/services/worker-service.ts`'s internal command switch to accept the same `server` subcommands where installed plugin scripts invoke the worker bundle directly.

Documentation references:

- Copy process delegation pattern from `src/npx-cli/commands/runtime.ts`.
- Keep help formatting from `src/npx-cli/index.ts`.
- Keep worker script path conventions from `plugin/scripts/worker-service.cjs`.
- Copy worker-service command parsing shape from `src/services/worker-service.ts`.

Verification:

- `bun test tests/install-non-tty.test.ts tests/infrastructure/worker-json-status.test.ts`
- Add CLI parser tests for `server` and `worker` namespaces.
- Manual smoke:
  - `node dist/npx-cli/index.js --help`
  - `node dist/npx-cli/index.js server status`

Anti-pattern guards:

- Do not remove `npx claude-mem install`.
- Do not rename the primary npm binary.

## Phase 3: Server Bootstrap Refactor

What to implement:

- Create `src/server/create-server.ts` as the new composition root.
- Move the generic `Server` shell from `src/services/server/Server.ts` toward `src/server/http-server.ts`, but keep compatibility exports during migration.
- Split middleware registration into ordered buckets:
  - pre-body-parser routes, including Better Auth later;
  - body parser and CORS;
  - request logging and static UI;
  - route registration;
  - not-found/error handlers.
- Fix runtime dependency drift by adding `cors` to production dependencies or removing the runtime import. Current code imports `cors` but only `@types/cors` is declared.
- Update CORS `allowedHeaders` to include `Authorization` before API-key routes ship.

Documentation references:

- Copy existing server lifecycle from `src/services/server/Server.ts`.
- Copy CORS behavior from `src/services/worker/http/middleware.ts`.
- Follow Better Auth Express docs: auth handler before `express.json()`, Express 5 catch-all route uses `*splat`.

Verification:

- `bun test tests/server/server.test.ts tests/worker/middleware/cors-restriction.test.ts`
- Add a regression test proving auth routes are mounted before JSON middleware.
- `npm run typecheck:root`

Anti-pattern guards:

- Do not put global `express.json()` before Better Auth.
- Do not change current default host from `127.0.0.1` without a migration and explicit config.

## Phase 4: Core Contracts And Storage Boundary

What to implement:

- Add shared Zod schemas under `src/core/schemas/`:
  - `agent-event.ts`
  - `memory-item.ts`
  - `context-pack.ts`
  - `project.ts`
  - `session.ts`
  - `team.ts`
  - `auth.ts`
- Add `src/storage/sqlite/` repositories for new server-owned tables:
  - `projects`
  - `server_sessions`
  - `agent_events`
  - `memory_items`
  - `memory_sources`
  - `teams`
  - `team_members`
  - `api_keys` or Better Auth tables
  - `audit_log`
- Keep existing `sdk_sessions`, `observations`, `session_summaries`, `user_prompts`, and `pending_messages` readable during migration.
- Decide and document the translation layer between existing `observations` and new `memory_items`.

Documentation references:

- Use data contracts from `/Users/alexnewman/Downloads/claude-mem-handoff-docs/claude-mem-server-plan.md`.
- Copy repository style from `src/services/sqlite/*` and migration style from `src/services/sqlite/migrations/runner.ts`.

Verification:

- Add migration tests in `tests/services/sqlite/migration-runner.test.ts`.
- Add schema tests for fresh DB and upgraded DB.
- `bun test tests/services/sqlite/ tests/sqlite/`

Anti-pattern guards:

- Do not make Redis the source of truth for memories.
- Do not break existing `observations` search while adding `memory_items`.

## Phase 5: Queue Engine Boundary

What to implement:

- Add `src/server/queue/ObservationQueueEngine.ts` with an interface shaped around current behavior:

```ts
export interface ObservationQueueEngine {
  enqueue(sessionDbId: number, contentSessionId: string, message: PendingMessage): Promise<EnqueueResult>;
  createIterator(sessionDbId: number, signal: AbortSignal, onIdleTimeout?: () => void): AsyncIterableIterator<PendingMessageWithId>;
  clearPendingForSession(sessionDbId: number): Promise<number>;
  resetProcessingToPending(sessionDbId: number): Promise<number>;
  getPendingCount(sessionDbId: number): Promise<number>;
  getTotalQueueDepth(): Promise<number>;
  close(): Promise<void>;
}
```

- Implement `SqliteObservationQueueEngine` by wrapping `PendingMessageStore` and `SessionQueueProcessor`.
- Update `SessionManager` to depend on the interface instead of directly constructing `PendingMessageStore`.
- Clean up schema drift before BullMQ:
  - remove or restore `worker_pid` consistently;
  - reconcile `pending|processing` with stale `processed|failed` references;
  - remove or fix `storeObservationsAndMarkComplete()` dead-code writes.

Documentation references:

- Copy current semantics from `src/services/sqlite/PendingMessageStore.ts`.
- Copy async iterator behavior from `src/services/queue/SessionQueueProcessor.ts`.
- Preserve provider contract consumed by Claude/Gemini/OpenRouter providers through `SessionManager`.

Verification:

- Shared queue contract test suite.
- `bun test tests/services/sqlite/PendingMessageStore.test.ts tests/services/queue/SessionQueueProcessor.test.ts`
- Add tests for dedupe, FIFO, restart reset, idle timeout, and queue depth.

Anti-pattern guards:

- Do not model this as generic stateless jobs only. The current queue is a per-session stream feeding provider generators.
- Do not change `_persistentId` and `_originalTimestamp` semantics.

## Phase 6: BullMQ And Valkey Runtime

What to implement:

- Add dependencies:
  - `bullmq`
  - `ioredis` if BullMQ usage requires direct connection management beyond BullMQ exports.
- Add settings:
  - `CLAUDE_MEM_QUEUE_ENGINE=sqlite|bullmq`
  - `CLAUDE_MEM_REDIS_URL`
  - `CLAUDE_MEM_REDIS_HOST`
  - `CLAUDE_MEM_REDIS_PORT`
  - `CLAUDE_MEM_REDIS_MODE=external|managed|docker`
  - `CLAUDE_MEM_QUEUE_REDIS_PREFIX`
- Add `BullMqObservationQueueEngine`.
- Use one queue per active session at first, with effective concurrency `1`, to preserve per-session FIFO without BullMQ Pro groups.
- Use safe hashed job IDs:
  - observation: `obs_${sha256(contentSessionId + "\0" + toolUseId)}`
  - summarize: `sum_${sha256(contentSessionId + "\0" + createdAtEpoch + "\0" + messageKind)}`
- Store only queue payloads needed to resume processing. Keep memory records in SQLite.
- Add Redis health to `/api/health` and `server status` only when BullMQ is enabled.

Documentation references:

- BullMQ docs: `Queue.add(...)` stores jobs in Redis and workers can process later.
- BullMQ job IDs: duplicate custom IDs are ignored while the prior job still exists.
- BullMQ stalled jobs: active jobs are lock-renewed and moved back or failed when stalled.
- Copy configuration strategy from `plans/2026-05-06-redis-dependency-strategy.md`.

Verification:

- Unit tests with mocked BullMQ queue where possible.
- Integration tests gated by `CLAUDE_MEM_REDIS_URL`.
- Docker Compose test with Valkey:
  - enqueue, kill server, restart, process;
  - duplicate `tool_use_id` suppressed;
  - per-session FIFO;
  - stalled job returns or fails as configured.

Anti-pattern guards:

- Do not use one high-concurrency global queue until same-session ordering is proven.
- Do not silently drop messages if Redis is unavailable.
- Do not use `:` in custom job IDs.

## Phase 7: Auth, Teams, And API Keys

What to implement:

- Add Better Auth after Phase 3 server bootstrap is complete.
- Add auth dependencies:
  - `better-auth`
  - `@better-auth/api-key`
- Create `src/server/auth/auth.ts` with:
  - Better Auth core config;
  - API-key plugin;
  - organization plugin with teams enabled;
  - custom access statements for projects and memories.
- Create `src/server/middleware/auth.ts`:
  - read `Authorization: Bearer <key>`;
  - verify API keys with Better Auth;
  - attach `authContext` containing `userId`, `organizationId`, `teamId`, scopes, and key id;
  - allow localhost unauthenticated reads only if `CLAUDE_MEM_AUTH_MODE=local-dev`.
- Create CLI commands:
  - `claude-mem server api-key create --team <team> --scope memories:read,memories:write`
  - `claude-mem server api-key list`
  - `claude-mem server api-key revoke <id>`
- Add team/project scoping to memory storage and retrieval.
- Add audit rows when memories are served, written, forgotten, imported, or exported.

Documentation references:

- Better Auth API Key plugin supports create, manage, verify, rate limiting, permissions, metadata, custom prefixes, and organization-owned keys.
- Better Auth Organization plugin supports organizations, members, teams, roles, permissions, and `hasPermission`.
- Better Auth Express integration requires the auth handler before body parser.

Verification:

- Auth route tests:
  - unauthenticated write denied;
  - API key with read scope cannot write;
  - revoked key denied;
  - team A key cannot read team B memory;
  - local-only mode does not bind publicly.
- `bun test tests/server/ tests/worker/middleware/`

Anti-pattern guards:

- Do not add SSO/SAML/SCIM in v0.1.
- Do not make API keys plaintext in SQLite. Store only hashed keys and show the raw key once at creation.
- Do not expose memory over LAN by default.

## Phase 8: REST API V1

What to implement:

- Add `src/server/routes/v1/*`:
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
  - `POST /v1/memories/:id/supersede`
  - `POST /v1/forget`
  - `POST /v1/search`
  - `POST /v1/context`
  - `GET /v1/audit`
  - `POST /v1/export`
  - `POST /v1/import`
  - `POST /v1/reindex`
- Keep legacy `/api/*` routes for current hooks, MCP, and viewer.
- Add OpenAPI generation from Zod schemas using existing `zod-to-json-schema`, or add a focused OpenAPI helper only if needed.

Documentation references:

- Copy route class and validation patterns from existing worker route files.
- Copy endpoint list from `claude-mem-server-plan.md`.

Verification:

- Add REST integration tests under `tests/server/v1/`.
- Add OpenAPI snapshot/schema tests.
- Legacy smoke: current `/api/sessions/init`, `/api/sessions/observations`, `/api/search`, `/api/context/inject` still work.

Anti-pattern guards:

- Do not delete `/api/*` compatibility routes in this phase.
- Do not implement MCP as a separate memory stack.

## Phase 9: Adapter Migration

What to implement:

- Add `src/adapters/claude-code/mapper.ts` to map existing hook payloads to `AgentEvent`.
- Add `src/adapters/generic-rest/examples.ts` with Codex/OpenCode/OpenClaw/custom examples.
- Refactor `SessionRoutes` ingestion to call the same event-ingestion service used by `POST /v1/events`.
- Preserve current hook fields:
  - `contentSessionId`
  - `tool_name`
  - `tool_input`
  - `tool_response`
  - `cwd`
  - `agentId`
  - `agentType`
  - `platformSource`
  - `tool_use_id` / `toolUseId`

Documentation references:

- Copy field handling from `src/services/worker/http/routes/SessionRoutes.ts`.
- Copy platform normalization from `src/shared/platform-source.ts`.

Verification:

- Existing hook tests continue passing.
- Add mapper tests for Claude Code, Codex transcript watcher, and generic REST event payloads.

Anti-pattern guards:

- Do not make Claude Code the core data model.
- Do not throw away raw event payloads before redaction/classification decisions are applied.

## Phase 10: MCP Surface On Server Core

What to implement:

- Add `src/server/mcp/tools.ts`, `resources.ts`, `prompts.ts`, and `register.ts`.
- Keep existing `src/servers/mcp-server.ts` as a thin stdio entrypoint.
- Implement tools:
  - `memory_add`
  - `memory_search`
  - `memory_context`
  - `memory_forget`
  - `memory_list_recent`
  - `memory_record_decision`
- Keep existing search/timeline/get-observations tools during migration.

Documentation references:

- Copy low-level SDK usage from `src/servers/mcp-server.ts`.
- Use MCP tool schema tests from `tests/servers/mcp-tool-schemas.test.ts`.

Verification:

- MCP list/call tests for new tools.
- Build guard in `scripts/build-hooks.js` still prevents Bun-only worker code from bloating the MCP bundle.

Anti-pattern guards:

- Do not import Bun-only SQLite/worker internals into the Node MCP bundle.
- Do not bypass auth/team scoping in MCP tools.

## Phase 11: Docker Deployment

What to implement:

- Add `docker/server/Dockerfile` or update `docker/claude-mem/Dockerfile` for server mode.
- Add `docker-compose.yml` with services:
  - `claude-mem-server`
  - `valkey`
  - optional `chroma` if Chroma remains enabled in server profile
- Server container defaults:
  - `CLAUDE_MEM_HOST=0.0.0.0` inside container
  - published port explicitly configured by compose
  - `CLAUDE_MEM_QUEUE_ENGINE=bullmq`
  - `CLAUDE_MEM_REDIS_URL=redis://valkey:6379`
  - persisted `/data/claude-mem`
- Add healthcheck using `GET /healthz`.
- Keep local auth credential mounting patterns from current Docker docs.

Documentation references:

- Copy Bun/uv/Claude Code install style from `docker/claude-mem/Dockerfile`.
- Copy credential handling conventions from `docker/claude-mem/README.md` and `entrypoint.sh`.
- Copy Valkey config guidance from `plans/2026-05-06-redis-dependency-strategy.md`.

Verification:

- `docker compose up --build`
- `curl http://127.0.0.1:<port>/healthz`
- `curl -H "Authorization: Bearer <key>" http://127.0.0.1:<port>/v1/info`
- Kill/restart server container and verify queued events survive.

Anti-pattern guards:

- Do not auto-install Docker Desktop.
- Do not bind public host ports without documented auth.
- Do not run Redis/Valkey without persistence in deployable examples.

## Phase 12: Docs And Migration

What to implement:

- Add:
  - `docs/server.md`
  - `docs/api.md`
  - `docs/adapters.md`
  - `docs/security.md`
  - `docs/docker.md`
  - `docs/migration-worker-to-server.md`
- Update README to introduce Claude-Mem Server first and worker as compatibility language.
- Document:
  - local dev mode;
  - Docker deployment;
  - API-key creation;
  - team/project scoping;
  - generic agent ingestion;
  - queue engine settings;
  - privacy/redaction baseline.

Documentation references:

- Use public docs style from `docs/public/*.mdx`.
- Use handoff docs for product wording and explicit non-goals.

Verification:

- `rg -n "worker service|Worker Service|worker-first" README.md docs`
- Ensure docs still mention compatibility commands where needed.

Anti-pattern guards:

- Do not imply hosted cloud or enterprise features are available.
- Do not call Claude-Mem an official Anthropic project.

## Final Verification Phase

Run:

```sh
npm run typecheck:root
bun test tests/server/ tests/services/queue/ tests/services/sqlite/ tests/servers/
bun test tests/integration/worker-api-endpoints.test.ts
npm run build
docker compose up --build
```

Manual acceptance checklist:

- `npx claude-mem install` still works.
- `claude-mem server start|status|stop` works.
- `claude-mem worker start|status|stop` aliases work.
- Existing Claude Code hooks still write observations.
- Generic REST client can write and search memory.
- MCP tools use the same server/core logic.
- API-key protected writes fail without auth.
- Team-scoped search cannot cross team boundaries.
- BullMQ/Valkey mode survives server container restart.
- SQLite remains canonical source of memory truth.
- Apache-2.0 migration is complete and stale AGPL messaging is removed from public package/docs.

## Suggested Execution Order

1. Phase 1: Apache-2.0 boundary.
2. Phase 2: CLI namespace and aliases.
3. Phase 3: Server bootstrap refactor.
4. Phase 5: Queue boundary and SQLite contract cleanup.
5. Phase 6: BullMQ/Valkey backend.
6. Phase 4: New core/storage contracts.
7. Phase 7: Auth/team/API-key layer.
8. Phase 8: REST V1.
9. Phase 9: Adapter migration.
10. Phase 10: MCP server-core surface.
11. Phase 11: Docker deployment.
12. Phase 12: Docs and migration guide.

The order intentionally moves the middleware and queue boundaries before Better Auth and REST V1. Those two boundaries are the highest-risk coupling points in the current codebase.
