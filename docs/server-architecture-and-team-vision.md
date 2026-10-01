# Server-Beta: Architecture, Team Vision, and the "It Just Works" Future

> A long-form report on what was built across server-beta Phases 4–13, how it integrates with the rest of claude-mem, what changes for single users, and how the substrate is shaped for team-scale shared memory. Concludes with concrete product ideas that fall out of the architecture and an honest list of what hasn't been built yet.

---

## 1. TL;DR

Server-beta turns claude-mem from a single-machine SQLite tool into a multi-tenant runtime backed by Postgres + BullMQ, while preserving the property that made claude-mem worth using in the first place: **the dev does nothing different**. Hooks, MCP tools, the viewer UI, and the search skill all keep their existing contract. Underneath, every event now carries a full identity triad — `api_key_id` × `actor_id` × `request_id` — and lands in a tenant-scoped substrate that supports teams, projects, scopes, audit chains, and split-process generation workers.

PR #2383 lands phases 4–13 (~13K LOC across 72 files) and is **APPROVED + CLEAN** after five rounds of automated review and ~20 fixes ranging from a P1 race in `provider.generate()` to escaping XML in prompts. The result is a substrate that can power solo dev memory, squad-shared memory, and org-scale federated memory using the same code path.

---

## 2. The seed problem

claude-mem's original pitch is: install once, work normally, your AI suddenly has cross-session memory that "just works". The capture layer (lifecycle hooks) writes events; an asynchronous worker calls Claude, parses observations, persists them; a search skill makes them retrievable. None of this requires the developer to think about it.

That works beautifully for **one developer, one machine, one SQLite file**. It breaks the moment you want any of:

- A second developer on the same team to benefit from the first's observations.
- Multiple AI agents (CI, MCP clients, IDE extensions) writing into the same memory pool.
- An audit trail that survives "who told the AI this?" questions from a security or compliance review.
- Two profiles on the same machine without port collisions.
- Horizontal scale of generation (a slow Anthropic call shouldn't block the HTTP path).

The legacy `worker-service.cjs` runtime can't grow into any of these without abandoning its single-process / single-tenant assumption. Server-beta is the parallel runtime that does, while leaving the legacy worker available for users who don't need any of it.

---

## 3. What got built — Phases 4–13 catalog

Phases 1–3 (already merged in #2351) delivered the substrate: Postgres schema (`src/storage/postgres/schema.ts`), tenant-scoped repositories (`agent-events.ts`, `generation-jobs.ts`, `server-sessions.ts`, `auth.ts`, `observations.ts`, `audit-logs.ts`), and the `ServerJobQueue` BullMQ wrapper. PR #2383 builds everything that runs on top.

| Phase | Deliverable | Key files |
|------:|-------------|-----------|
| 4 | Event-to-job pipeline (transactional outbox + ingest service) | `src/server/services/IngestEventsService.ts`, `src/server/jobs/outbox.ts` |
| 5 | Provider observation generator (Claude / Gemini / OpenRouter) | `src/server/generation/ProviderObservationGenerator.ts`, `src/server/generation/providers/*` |
| 6 | Independent server session semantics + 3-policy scheduling | `src/storage/postgres/server-sessions.ts`, `src/server/runtime/SessionGenerationPolicy.ts` |
| 7 | Hooks routed via HTTP (no worker dependency) | `src/services/hooks/runtime-selector.ts`, `src/services/hooks/server-client.ts`, `src/services/hooks/server-bootstrap.ts` |
| 8 | Dedicated MCP server backed by `/v1/*` core | `src/servers/mcp-server.ts` |
| 9 | Compatibility adapters for legacy worker payloads | `src/server/compat/SessionsObservationsAdapter.ts`, `src/server/compat/SessionsSummarizeAdapter.ts` |
| 10 | Docker stack — split-process deployable | `docker-compose.yml`, `docker/claude-mem/Dockerfile`, `scripts/e2e-server-docker.sh` |
| 11 | Team-aware generation + audit chain | scope checks + audit writes inside `ProviderObservationGenerator.ts`; identity context in `IngestEventsService.ts`; `audit_logs` plumbing throughout |
| 12 | Observability + operations | `src/server/middleware/request-id.ts`, request_id in BullMQ payload, `/api/health` queue lanes, `src/cli/server-jobs.ts`, operator routes (`POST /v1/jobs/:id/retry`, `POST /v1/jobs/:id/cancel`) |
| 13 | Release readiness audit | `docs/server-release-readiness.md` |

Five rounds of reviewer feedback then landed ~20 follow-up fixes:

- **P1**: provider double-call when BullMQ redelivers a stalled job; operator retry re-enqueueing the wrong payload; TOCTOU in `resolveServerSession` causing 500s under concurrent compat load; batch endpoint stamping every event with the first event's `sourceAdapter`; retrying a `completed` job duplicating observations.
- **Major**: XML injection via raw `server_session_id`; double-counted `stalled` events between worker + QueueEvents; static vs dynamic imports for `PostgresObservationRepository`; ignored `generate` flag in MCP `observation_record_event`; `jsonb_set` null guard on `markGenerationFailed`.
- **Minor**: NaN-coalesce bug in debounce default, hardcoded Postgres credentials in `docker-compose.yml`, unbounded `api-key list` query (cross-tenant disclosure), `wait=true` not actually waiting, `endSession` breaking idempotency on `updated_at`, hardcoded `37877` server-beta port (multi-account isolation), test pool cleanup, markdown polish.

Each one is its own audit trail entry in the PR — but the more interesting story is what the substrate looks like once they all land together.

---

## 4. Anatomy of a single event flow

Reading the code top-down, here's what happens when one Claude Code hook fires a tool-use event with `wait=true`:

```
Hook → bun-runner → POST /v1/events?wait=true (X-API-Key: cmem_…)
                     │
                     ▼
            requestIdMiddleware()  [src/server/middleware/request-id.ts]
                     │   mints uuid (or honors X-Request-Id)
                     ▼
       requirePostgresServerAuth(scopes: ['memories:write'])
                     │   resolves api_key_id, team_id, project_id, scopes, actor_id
                     ▼
       IngestEventsService.ingestOne()         [transactional]
         INSERT agent_events row
         pre-generate outbox id (newId())
         build BullMQ payload {
           kind: 'event',
           team_id, project_id, source_type, source_id,
           generation_job_id, agent_event_id,
           api_key_id, actor_id, source_adapter, request_id
         }
         INSERT observation_generation_jobs (status=queued, payload=<canonical bullmq payload>)
         APPEND generation_job_events (eventType=queued)
         tx commits
                     │
                     ▼
       publishEventJob() → SessionGenerationPolicy.buildEnqueueEventDecision()
         policy: per-event | debounce | end-of-session
                     │
                     ▼
          BullMQ Queue.add(deterministic jobId, payload)
                     │
                     ▼
       auditWrite('event.received', request_id, …)
                     │
                     ▼
       waitForTerminalJob()  [polls outbox row, 100ms × up to 30s]
                     │
                     ▼
       HTTP 201 { event, generationJob: { status: 'completed' | 'failed' | … } }
```

In parallel (or shortly after, depending on the worker pool):

```
BullMQ delivers job to ProviderObservationGenerator.process()
   │
   ├─ assertServerGenerationJobPayload(job.data)        ← shape validation
   ├─ scope check: payload.team_id === canonical row?   ← refuses cross-tenant
   ├─ api-key revocation check
   ├─ lockOutbox(): atomic queued→processing, OR skip if processing already
   │     (the P1 fix — without it, a redelivered stalled job would call
   │      provider.generate() twice and cost real money)
   ├─ loadEvents() — pulls the agent_event(s) for this source
   ├─ provider.generate({ job, events, project }) — Anthropic / Gemini / OpenRouter
   ├─ processGeneratedResponse() — parse XML, persist observations + sources,
   │   transition outbox to completed, write 'generation.completed' audit
   │   carrying bullmqJobId + requestId + duration + model_id
   └─ BullMQ removes the job
```

If a worker dies mid-generation, `reconcileOnStartup` (`src/server/jobs/outbox.ts:133`) re-publishes any rows stuck in `queued` or `processing` using their persisted payload — which, after the P1 retry fix, is the canonical BullMQ payload, not just metadata. The deterministic BullMQ job id ensures duplicates collapse on the queue.

That's the spine. Every other surface of the system reuses fragments of this flow.

---

## 5. System integration map

The plugin's hook layer hasn't changed — `plugin/hooks/hooks.json` still dispatches to `plugin/scripts/worker-service.cjs` (built from `src/services/worker-service.ts`). What changed is what happens after.

```
┌──────────────────────────────────────────────────────────┐
│  Claude Code session                                     │
│   ├─ UserPromptSubmit hook                              │
│   ├─ PreToolUse / PostToolUse hooks                     │
│   ├─ Stop hook                                           │
│   └─ Setup / SessionStart hooks                         │
└──────────────────────────────────────────────────────────┘
                       │
                       ▼ bun-runner.js dispatches subcommand
┌──────────────────────────────────────────────────────────┐
│  worker-service.cjs                                      │
│   ├─ runtime-selector.ts decides:                       │
│   │    • CLAUDE_MEM_RUNTIME=worker     → legacy SQLite  │
│   │    • CLAUDE_MEM_RUNTIME=server-beta → HTTP client   │
│   └─ ServerBetaClient.recordEvent(input) → /v1/events   │
└──────────────────────────────────────────────────────────┘
                       │
                       ▼
       ┌──────────────────────────────────────────────────┐
       │  claude-mem-server (HTTP)                       │
       │   /v1/events            ← hook event ingest     │
       │   /v1/events/batch      ← batch ingest          │
       │   /v1/sessions/start    ← session creation      │
       │   /v1/sessions/:id/end  ← summary trigger       │
       │   /v1/search            ← FTS search            │
       │   /v1/context           ← context pack          │
       │   /v1/memories          ← direct insert         │
       │   /v1/observations/:id  ← scoped read           │
       │   /v1/jobs/:id/retry    ← operator             │
       │   /v1/jobs/:id/cancel   ← operator             │
       │   /api/health           ← per-lane queue stats │
       │                                                  │
       │  + auth middleware, request_id middleware,      │
       │    compat adapters mounted at /api/sessions/*   │
       └──────────────────────────────────────────────────┘
                       │             │
       Postgres ◄──────┘             └──────► Valkey (BullMQ)
                                                 │
                                                 ▼
                                  ┌──────────────────────────┐
                                  │ claude-mem-worker        │
                                  │  ProviderObservationGen  │
                                  │  (no HTTP listener)      │
                                  └──────────────────────────┘
                                                 │
                                                 ▼
                                  Postgres observations + audit
```

The same `/v1` surface is hit by:

- **Hooks**, via `ServerBetaClient` from inside `worker-service.cjs`.
- **MCP clients** (Claude Desktop, Cursor, etc.), via `src/servers/mcp-server.ts` translating MCP tool calls to `/v1/events`, `/v1/search`, `/v1/context`, `/v1/memories`.
- **The viewer UI** (`plugin/ui/viewer.html`), which reads `/api/health` for queue lanes and the `/v1` read endpoints for memory lists.
- **The mem-search skill** (`plugin/skills/mem-search/`), which calls `/v1/search` regardless of runtime.
- **The legacy compat shims**, which translate old `POST /api/sessions/observations` and `/api/sessions/summarize` payloads into the same `IngestEventsService` and `EndSessionService` calls used by the canonical `/v1/*` routes.

That last point matters: any client written against the legacy worker keeps working through the compat adapters without needing to be rewritten. The compat layer is a thin translator, not a parallel implementation — anti-pattern guarded into a single shared service.

---

## 6. The single-user model

For a developer running claude-mem on one machine, server-beta is invisible. Here's what their first run looks like:

1. `npx claude-mem install` (or upgrading to a server-beta-enabled build).
2. `bootstrapServerApiKey()` (`src/services/hooks/server-bootstrap.ts`) runs on first hook fire. It:
   - finds-or-creates a `local-hook-team` row in `teams`,
   - finds-or-creates a `local-hook-project` row in `projects`,
   - generates a 48-byte url-safe random api key, hashes it (sha256), and creates an `api_keys` row scoped to that team+project with hook-only scopes (`events:write`, `sessions:write`, `observations:read`, `jobs:read`),
   - writes the raw key + project id + server URL into `~/.claude-mem/settings.json` so subsequent hook fires can authenticate.
3. The server-beta daemon starts on a UID-derived port: `37877 + (uid % 100)`. (This was a Phase-12 review fix — previously it hardcoded `37877` and two profiles on the same machine collided.)
4. Hooks now `POST /v1/events` to that local port with the api key. From the user's perspective, their context still appears in their next session, search still returns relevant observations, the viewer still works.

The single-user case is "team_id = local-hook-team, project_id = local-hook-project, you are the only `actor_id`". Everything multi-tenant degrades cleanly to single-tenant with that mapping.

Multi-account on the same machine: set `CLAUDE_MEM_DATA_DIR=$HOME/.claude-mem-work` for the work profile. Every path (DB, settings, pid, port file) derives from it. The UID-derived port plus per-user data dir means two profiles cohabit without conflict.

---

## 7. The multi-user model

Once you cross the boundary into "more than one human or service account uses this", the substrate's real shape becomes visible. Three identity dimensions thread every row in the system:

- **`team_id` × `project_id`** — the tenant scope. Every read query is keyed on this pair. There is no API surface that returns rows from a different scope to an unauthorized caller.
- **`api_key_id`** — transport identity. The HTTP key that authenticated the call. Revocable. Per-machine, per-CI-job, per-service-account. Audit rows record this for every action.
- **`actor_id`** — semantic identity. A human-interpretable identifier (`human:alice@org`, `system:server-beta-cli`, `system:ci-runner`) the api key is acting on behalf of. Multiple keys can map to the same actor (e.g. an engineer with keys on laptop + workstation).
- **`request_id`** — per-call correlation, minted at the HTTP boundary. Flows into the BullMQ payload, into worker log lines, into audit rows. Pivot point for support.

`requirePostgresServerAuth` (`src/server/middleware/postgres-auth.ts`) does the heavy lifting on every write/read:

1. Hashes the incoming `X-API-Key` header (or `Authorization: Bearer …`).
2. Looks up the `api_keys` row scoped to that hash.
3. Checks `revoked_at`, `expires_at`, scope match against required scopes (`memories:write`, `memories:read`, etc.).
4. Populates `req.authContext = { apiKeyId, teamId, projectId, scopes, actorId }`.
5. Refuses with 401 (revoked / unknown key), 403 (insufficient scope), or 400 (malformed) — never silently skipping.

Phase 11 then added defense in depth at the worker. The BullMQ payload carries the team/project, but workers don't trust the payload — they reload the canonical `observation_generation_jobs` row from Postgres and refuse to act if `payload.team_id !== canonical.team_id` (audited as `generation_job.scope_violation`). A poisoned BullMQ payload can't escape its tenancy.

The Phase-12 audit chain captures:

- `event.received`, `event.batch_received` — every ingest
- `session.start`, `session.end` — session lifecycle
- `generation_job.processing`, `generation_job.completed`, `generation_job.failed` — every generation
- `generation_job.retried_by_operator`, `generation_job.cancelled_by_operator` — operator actions
- `generation_job.scope_violation`, `generation_job.revoked_key` — security refusals
- `api_key.create`, `api_key.revoke` — key lifecycle
- `memory.write`, `observation.read` — direct memory operations

Every row carries `(team_id, project_id, api_key_id, actor_id, request_id)`. That's the chain a SOC2 / ISO 27001 audit needs, surfaced as a Postgres table you can join against.

The cross-tenant disclosure threats are explicitly fenced at every layer:

- API: scope check before any read/write.
- Worker: re-validation of canonical row vs payload.
- CLI: `api-key list` is now `LIMIT/OFFSET` + optional `--team` filter (Phase 12 fix).
- Compat: TOCTOU in `resolveServerSession` catches `23505` unique-violation and re-fetches instead of returning 500 (round-2 review fix).

---

## 8. Team scale playbooks

The substrate is the same regardless of size. What changes is how you wire up teams, projects, keys, and search.

### 8.1 Small team (2–5 devs, e.g. a startup squad)

**Topology**: one team, one project per repo (or one project total for a monorepo).

**Wiring**:
- Bootstrap a shared team via `claude-mem server api-key create --team <id> --project <id> --scope memories:write,memories:read`. This is a one-time setup by whoever owns the deployment.
- Each developer gets their own api key (so revocation is per-person). `actor_id` = `human:alice@org`.
- All hooks write into the shared (team, project). Observations land in a team pool.

**Search becomes social**: `mem-search "BullMQ stalled jobs"` returns observations from anyone on the team who's worked on that. No coordination required; it just works.

**Onboarding**: a new hire's first session can run `observation_search` queries and immediately see what the team has learned. Time-to-productivity drops because the implicit context is now explicit.

**CI**: a service api key (`actor_id = system:ci`) writes events for build failures, deploy summaries, test flake detection. The team's AI sessions can search "what's been failing this week" and get real answers.

### 8.2 Medium team (5–50, multiple squads)

**Topology**: one team per squad, one project per service or repo. A "platform" team that holds shared infrastructure.

**Wiring**:
- Per-squad team rows. Each squad's developers have keys scoped to that team.
- Per-project keys for finer access control (a backend dev who shouldn't be writing to the frontend team's memory).
- A platform team with read-only keys scoped to multiple projects (`scopes: ['observations:read']`, `team_id = platform`, `project_id = NULL` is a valid read scope; cross-project reads filtered by team).
- CI/CD service accounts per squad, with `actor_id = system:ci-<squad>`.

**Cross-squad federation**: when squad A wants to know what squad B has learned about a shared dependency, a "federation key" can grant read-only cross-team access. Audit chain shows the federation transfer.

**Observability**: per-team queue lanes via `/api/health`. A squad's runaway generation cost shows up in their lane metrics, not the platform's.

**Governance**: keys rotate via `claude-mem server api-key revoke` + `create`. The audit chain records both the revocation and the new key's first use. Compliance teams can grep for `api_key.revoke` events.

### 8.3 Large team (50+, regulated / enterprise)

**Topology**: teams as organizational units — engineering, data-platform, security. Projects per repo or microservice. A federation team for org-wide read access.

**Wiring**:
- Per-engineer api keys with short expiry (rotated by a key-rotation cron).
- Per-service-account keys for every CI job, deploy bot, and AI agent.
- A "compliance" team key with org-wide `observations:read` and `audit:read` scopes (the latter is future work).
- Multi-region Postgres + Valkey deployments behind a router that hashes by team_id.
- Observability stack consumes `/api/health` per region per team.
- `request_id` flows into the SIEM so a security incident can be traced back to specific HTTP calls and the AI sessions that generated them.

**Privacy**: `<private>` tags strip at the hook layer (edge processing) before content reaches the substrate. So personal scratch never gets to the team substrate, let alone the org. For regulated environments, an opt-in default-private mode (every observation `<private>` unless explicitly opted-in) is a future configuration.

**Cost attribution**: every generation row has `team_id`, `model_id`, `attempts`, and timestamps. A nightly job can `SUM(duration_ms)` and `COUNT(*)` GROUP BY `team_id, model_id` for chargeback dashboards.

**Audit-driven compliance**: an investigator asks "what did our AI know about customer X between dates A and B?". The query is a tenant-scoped FTS over `observations` joined against `audit_logs` filtered by `team_id` and date range. Subpoena-ready.

---

## 9. Conceptual architecture

Memory in claude-mem is **a write-mostly event log with a derived observation view**. The architecture stacks three loosely-coupled layers:

```
            ┌────────────────────────────────────┐
            │  READ LAYER                        │
            │   /v1/search (FTS GIN)             │
            │   /v1/context (context pack)       │
            │   /v1/observations/:id             │
            │   Chroma vector embeddings         │
            └────────────────────────────────────┘
                       ▲
                       │ derived view
            ┌────────────────────────────────────┐
            │  GENERATION LAYER                  │
            │   ProviderObservationGenerator     │
            │   processGeneratedResponse         │
            │   processSessionSummaryResponse    │
            │   (BullMQ workers, scaled            │
            │    horizontally, decoupled from     │
            │    HTTP latency)                    │
            └────────────────────────────────────┘
                       ▲
                       │ outbox + queue lanes
            ┌────────────────────────────────────┐
            │  CAPTURE LAYER                     │
            │   IngestEventsService              │
            │   EndSessionService                │
            │   compat adapters                  │
            │   (single transactional unit:      │
            │    event row + outbox row + audit)  │
            └────────────────────────────────────┘
```

**Capture is cheap and synchronous.** A hook fire is one HTTP call, one transaction, three INSERTs. Latency is bounded.

**Generation is async and horizontally scalable.** The outbox pattern means the queue is a transport optimization; durability lives in Postgres. Scale workers up or down without affecting HTTP latency.

**Reads are tenant-scoped FTS + (future) vector search.** GIN indexes on tsvector columns give sub-100ms search for typical workloads. Chroma plugs in for semantic recall.

### 9.1 Two queue lanes

- **Event lane** — per-event observations. Fed by `/v1/events` and the compat sessions/observations adapter. Throughput-heavy. Scaled with worker concurrency.
- **Summary lane** — session-end summaries. Fed by `/v1/sessions/:id/end` and the compat sessions/summarize adapter. Lower volume, larger payloads (entire session context).

`SessionGenerationPolicy` decides which lane and when:
- `per-event` (default) — every event triggers an event-lane job immediately.
- `debounce` — events within a window collapse via deterministic job id; `delay: <window>` schedules and re-adds replace.
- `end-of-session` — per-event jobs are skipped; only the session-end summary fires.

The policy is per-team-configurable (env var today, per-team table tomorrow).

### 9.2 Deterministic job ids

`buildServerJobId({ kind, team_id, project_id, source_type, source_id })` produces a stable id like `event:t123:p456:agent_event:e789`. BullMQ enforces uniqueness on jobId, so:

- Re-enqueueing the same logical job is a no-op on the queue side.
- Debouncing works by re-adding the same id and replacing the delayed payload.
- Retries (operator-triggered or stalled-job recovery) collide cleanly.
- Reconciliation can address rows by id without keeping side state.

That single design choice makes the entire job-lifecycle story idempotent without requiring a distributed lock.

### 9.3 Identity triad

Every audit row, every BullMQ payload, every log line includes:

| Field | Lifecycle | Used for |
|-------|-----------|----------|
| `api_key_id` | Created via CLI or bootstrap; revocable | "Which key fired this call?" — security |
| `actor_id` | Set on api key at create time | "Which human/service?" — analytics, attribution |
| `request_id` | Minted at HTTP edge per call | "What was the full lifecycle of this one HTTP request?" — support, debugging |
| `team_id × project_id` | Inherent to the api key | Tenant scope on every read query |

The triad is what turns "the AI remembered X" from a black box into a traceable, attributable, revocable claim.

### 9.4 Provider abstraction

`ProviderObservationGenerator` is provider-agnostic via a small interface. Today's providers: Claude (Anthropic SDK), Gemini (Google Generative AI), OpenRouter (any model behind their gateway). Adding a new provider is implementing one method (`generate(input) → { rawText, modelId, providerLabel }`) and registering it. The XML response format and `processGeneratedResponse` stay the same.

This is the "we don't pick winners" property: a team that prefers Gemini for cost, or wants OpenRouter for failover, just sets `CLAUDE_MEM_SERVER_PROVIDER` and the substrate doesn't care.

### 9.5 Observability primitives

- **`request_id` end-to-end**: one identifier traverses HTTP → audit → BullMQ payload → worker log lines → completion audit. Support pivot is `SELECT * FROM audit_logs WHERE request_id = '<uuid>' ORDER BY created_at`.
- **Per-lane queue metrics**: `/api/health` and `/v1/info` return `{ waiting, active, completed, failed, delayed, stalled }` per lane. Sufficient for a Grafana dashboard or a Kubernetes HPA.
- **Per-job lifecycle events**: `observation_generation_job_events` records every transition with `attempt`, `details`, `event_type`. The audit + lifecycle tables together reconstruct any job's full history.
- **Stalled-event dedup**: the recent `ServerJobQueue` review fix means a stalled jobId is counted exactly once even though BullMQ surfaces it via both `worker.on('stalled')` and `QueueEvents 'stalled'`.

---

## 10. Developer experience walkthrough

**Day one (single user).** `npx claude-mem install`. Open Claude Code. Type. Observations capture. After a few sessions, search returns relevant prior context. Nothing else to learn.

**Day one (team).** A team admin runs `docker compose up -d` against the project's `docker-compose.yml`. They mint api keys for each developer:

```bash
POSTGRES_USER=… POSTGRES_PASSWORD=… POSTGRES_DB=… docker compose exec claude-mem-server \
  bun /opt/claude-mem/scripts/server-service.cjs server api-key create \
    --team <team_id> --project <project_id> \
    --scope events:write,sessions:write,observations:read,jobs:read \
    --name alice-laptop
```

The output is a JSON blob with the raw key. Each developer pastes it into their `~/.claude-mem/settings.json` `CLAUDE_MEM_SERVER_BETA_API_KEY`. Done. They use Claude Code normally; their hooks now write to the team substrate.

**Day two — operator path**. Something stuck in `processing`?

```bash
claude-mem server jobs list --team <team_id> --status processing
claude-mem server jobs retry <job_id>     # if cancelled or failed
claude-mem server jobs cancel <job_id>    # active jobs ride out their lifecycle
```

The retry endpoint is now safe across all states (after the Phase-12 + round-4 review fixes): no-op on `queued`, 409 on `processing`, 409 on `completed` (would otherwise duplicate observations due to LLM non-determinism), reset+re-enqueue on `failed`/`cancelled`.

**Day three — debugging a slow query.** A developer asks "why did this take 30s?". They grab the `request_id` from the HTTP response, then in Postgres:

```sql
SELECT created_at, action, details
FROM audit_logs
WHERE request_id = '<uuid>'
ORDER BY created_at;
```

That returns the full lifecycle: `event.received` (HTTP boundary), `generation_job.processing` (worker locked the row), `generation_job.completed` (worker finished, with model_id and duration). Pivot complete.

**Day four — testing automation**. They want to write a test that does "POST event, expect observations to be generated". With the `wait=true` polling fix, this is one call:

```bash
curl -X POST 'http://server:37877/v1/events?wait=true' \
  -H 'X-API-Key: cmem_…' \
  -d '{ "projectId": "<id>", "eventType": "test", "occurredAtEpoch": 0, "sourceType": "api" }'
# returns: { event: {…}, generationJob: { status: "completed", … } }
```

No polling loop, no race. The endpoint blocks until the outbox row reaches a terminal state or 30s elapses (returns `waitTimedOut: true` if the cap is hit).

**Day five — MCP**. A teammate is using Cursor via MCP. They invoke the `observation_record_event` tool with `generate: false` (because they want to log a metadata-only event without paying for generation). With the round-2 review fix, that flag now actually flows through to `?generate=false` on the REST endpoint instead of being silently dropped.

---

## 11. What developers gain

A condensed list:

- **Cross-session memory at team scope.** "Sarah figured this out last Thursday" is searchable.
- **Multi-account isolation.** Two profiles on the same Mac, no port collision.
- **Read-after-write semantics.** `?wait=true` actually waits.
- **Provider-agnostic generation.** Switch Anthropic → Gemini with one env var.
- **Compliance-grade audit.** Every action attributable to (api_key_id, actor_id, request_id, team_id, project_id).
- **Operator surface.** Retry, cancel, list, paginate.
- **Privacy by default.** `<private>` tags strip at edge.
- **Horizontal scale.** `--scale claude-mem-worker=N`.
- **Crash-safe persistence.** `reconcileOnStartup` recovers in-flight rows.
- **Tenant defense in depth.** Auth at HTTP, scope check at worker, ON CONFLICT at storage, audit on every refusal.
- **Identity-grounded suggestions.** Future: AI suggestions can carry "based on observation X by actor Y at time Z" because the substrate already knows.

The substrate itself is a product surface. Everything above is unlocked by code that's already merged.

---

## 12. The "it just works" ethos extended

The original claude-mem promise: install once, work normally, get memory as a side effect. The team-mode promise has to be the same — anything less and adoption stalls because somebody has to convince every engineer to opt in.

Server-beta deliberately preserves this by making the hook contract identical:

- Same hook scripts in `plugin/hooks/hooks.json`.
- Same MCP tools (`observation_record_event`, `observation_search`, `observation_context`).
- Same viewer UI port and surface.
- Same search skill behavior.

What changes is the substrate, and substrate changes are invisible to the developer at the call site. A team admin sets up the deployment once; everyone else uses claude-mem the way they always did.

This is the property that makes it possible to layer products on top:

- **Auto-attribution in surfaced context.** When a teammate's observation appears in your context, the substrate already knows whose `actor_id` authored it. Surfacing "this came from Alice's session 3 days ago" is a UI change, not a substrate change.
- **Stale memory detection.** When a new observation contradicts an older one (same `source_id`, different `content`), the data model can flag it. No new ingest pipeline needed.
- **Live activity feeds.** Subscribe to `audit_logs` filtered by `team_id`, project an SSE stream into Slack, Linear, or a sidecar dashboard.
- **Trust labels.** Every suggestion the AI surfaces can carry "verified observation N times" or "single observation, low confidence" because the substrate counts cites.
- **Cost dashboards.** `SUM(duration_ms) GROUP BY team_id, model_id` is one query; chargeback is one cron job away.
- **Audit-as-a-service.** "Show every observation generated by api_key X between dates A and B" is one query. Compliance reports become trivial.

The pattern: **the substrate models everything; products are thin views on top.**

---

## 13. What we can build on top

Brainstormed product ideas that fall out of the substrate without new infrastructure:

### 13.1 Memory feeds
A Slack bot subscribed to `audit_logs WHERE action = 'memory.write' AND team_id = …` posts a daily digest of new observations into the squad channel. Zero capture work; the AI is doing it as a side effect of normal sessions.

### 13.2 PR-aware AI review
When a PR opens, a service account queries `/v1/search` with the diff's file paths and function names. The AI reviewer surfaces "the team's prior reasoning about this code" as a PR comment. The diff context plus team memory lifts review quality without any explicit knowledge curation.

### 13.3 Onboarding companion
A new hire's first session. Their MCP `observation_search` query "how does authentication work" returns the team's actual lived answer — including the bugs hit, the dead ends, the why behind the structure — instead of a stale README.

### 13.4 Stale-context warnings
When an observation is more than N weeks old AND its source file has been touched since, flag it as potentially stale in the search results. The data model already has `agent_events.created_at` and source file paths in payload metadata.

### 13.5 Cross-project federation
A "platform" team key with `observations:read` scoped to multiple projects. Platform engineers see their dependents' memory without dependents doing anything.

### 13.6 Cost dashboards
Per-team, per-model token spend. One SQL query against the `observation_generation_jobs` table joined against `audit_logs`. Build a Grafana panel; ship.

### 13.7 Compliance reports
"Show all observations created by `api_key_id <X>` between dates A–B for `team <T>`." Subpoena-ready in one query.

### 13.8 AI agent memory marketplace
Open-source observation packs. "React 19 patterns", "Postgres performance", "AWS CDK gotchas". Mountable as a read-only `team_id` namespace for any deployment. Curated content with attribution preserved.

### 13.9 Privacy-first synthesis
Aggregate observations across team members. `<private>` stripping happens at edge so personal scratch never crosses the boundary, but distilled lessons do. The substrate's two-layer privacy (per-content tags + per-tenant scope) makes this safe.

### 13.10 Cross-team learning propagation
A security incident in one team. An observation propagation service copies relevant observations to the security team's space, with audit chain showing the cross-team transfer (and the `api_key_id` that authorized it).

### 13.11 Voice-to-memory standup bots
A daily standup bot asks "what's blocking you?". The answer becomes an observation against the right project, with `actor_id = human:<engineer>`. End-of-week, the AI summarizes blockers across the team — already in the same memory pool the AI uses for code suggestions.

### 13.12 Documentation that writes itself
Filter observations by `kind = 'decision'` or `kind = 'architecture'`. Generate ADRs (architecture decision records) automatically with author attribution from `actor_id` and timestamps from `created_at`. The substrate captures the reasoning in the moment; a thin transformer layer renders it as docs later.

### 13.13 Trust chains for AI suggestions
Every observation already has `(api_key_id, actor_id, model_id, request_id)`. A surfacing layer can show "this suggestion is based on N observations from Alice + M from Bob, model claude-3-5-sonnet, generated within the last 14 days." Fully auditable AI provenance.

### 13.14 Multi-modal memory
Today the capture layer is hook events with text payloads. Tomorrow: screenshots from the IDE (PNG bytes in payload), voice transcripts (audio + transcript), terminal recordings. The substrate's `payload jsonb` column accommodates anything; `source_type` extends.

The unifying property of all these: **the developer does nothing different.** The capture layer is invisible, the substrate handles scope and identity, the products read off the same `/v1` surface. That's "it just works", scaled to teams.

---

## 14. Why team dev work specifically needs persistent shared memory

This deserves its own section because it's the deeper "why" behind all of the above.

### 14.1 The tacit knowledge gap
Most engineering knowledge is transmitted orally — in PR comments, 1:1s, Slack threads that age out. AI agents amplify whoever uses them, but only locally. A senior engineer's mental model of the codebase doesn't persist when they go on vacation, leave, or simply work on a different project for two weeks. Server-beta makes that mental model addressable: their sessions write observations the team can search.

### 14.2 Onboarding asymmetry
New hires take weeks to ramp. Half of that is rediscovering decisions that were already made. With shared memory, "why did we choose Postgres over SQLite for this service" returns the actual reasoning from when the choice was made — not a doc someone wrote later.

### 14.3 Code review fatigue
Senior engineers explain the same patterns over and over. Every "we don't do that here because X" is a candidate observation. Once captured, the next AI suggestion to a different engineer can carry that constraint forward — with attribution, so it's explainable.

### 14.4 Tribal knowledge departure
People leave. Their git commits stay, but their reasoning leaves. Shared observations capture the "why" alongside the "what". When the engineer leaves, their `actor_id` keeps appearing in surfaced context for months — their reasoning lives on.

### 14.5 AI parity
Engineers who use AI tools heavily build personal context that compounds. Engineers who don't, lag. Shared memory partially equalizes this — everyone benefits from everyone's AI usage. (This is the team-dev parallel to "everyone benefits from one person's tests".)

### 14.6 Cross-service understanding
Microservice architectures fracture knowledge across repos. With per-project observations and team-scoped search, a backend engineer can pull "what does the front-end team know about this auth flow" without crossing a documentation boundary.

### 14.7 Incident response
Every postmortem ends with "we'll write this down" and almost none of the writing actually happens. Observations capture the diagnostic process automatically — including the dead ends, which docs almost never include but are the most valuable for future investigators.

### 14.8 Trust through attribution
The reason teams resist "AI writing things to a shared store" is fear of garbage data. Server-beta's audit chain (`api_key_id` + `actor_id` + `request_id` + `model_id` + scope-violation refusals) means every observation is traceable to a specific human's session, a specific model run, and a specific provider call. You can revoke a key, audit a session, prove to compliance "yes, the AI knew X because of Y at time Z". That auditability is the precondition for trust.

### 14.9 The compounding effect
A team of 10 engineers, each generating ~5 observations a day, produces 1000+ observations a month. After six months, the team's collective AI memory contains 6000+ structured, attributed, searchable insights — a corpus larger than most teams' written documentation. The compound interest of "everyone's AI usage feeds everyone else's AI usage" is, in the long run, the most important property.

---

## 15. Honest limits / open questions

The substrate is rich, but the surface is incomplete. Things deliberately not built yet:

- **Cross-team federation UX.** The substrate supports it; first-class CLI/UI for setting up read-only cross-team keys doesn't exist.
- **Default-private mode.** `<private>` tags require user discipline. A team-mode default-private (opt-in to share) inverts the trust model and probably should exist for regulated environments.
- **Cost attribution surface.** The data is there; a billing dashboard isn't.
- **Stale-observation detection.** Trivially possible from the data model; no service wired in.
- **Observation merge / supersede UX.** Two observations on the same source can both be valid. Tooling to merge, supersede, or contradict is future work.
- **Search ranking tuning.** FTS handles exact terms well. A team-scope ranker that weights recency × authorship × topic relevance is open.
- **Geo-replication.** Single-region today. Multi-region needs conflict resolution on the unique idempotency keys.
- **Worker autoscaling.** `docker compose --scale` for manual; Kubernetes HPA on queue depth needs a Prom exporter that doesn't exist yet (the metrics surface does — `/api/health`).
- **Provider failover.** `CLAUDE_MEM_SERVER_PROVIDER` is single-valued. Retry-on-different-provider would be a small wrapper above `ProviderObservationGenerator`.
- **Online schema migrations.** `bootstrapServerBetaPostgresSchema` runs on startup. Live deployments need a proper migration tool.
- **Pre-existing legacy test failures.** 7 tests in the legacy worker path remain skipped/failing; not introduced by server-beta but deferred for a follow-up.

These are scoped tickets, not architectural blockers. The substrate is shaped right; the products and polish are next.

---

## 16. References / file index

Code referenced throughout this doc, for navigation:

- Capture layer
  - `src/server/services/IngestEventsService.ts`
  - `src/server/services/EndSessionService.ts`
  - `src/server/jobs/outbox.ts` (`enqueueOutbox`, `reconcileOnStartup`)
  - `src/server/runtime/SessionGenerationPolicy.ts` (`buildEnqueueEventDecision`, `scheduleDebouncedEventJob`, `buildSummaryJobPayload`)
- Generation layer
  - `src/server/generation/ProviderObservationGenerator.ts` (`process`, `lockOutbox`)
  - `src/server/generation/processGeneratedResponse.ts`
  - `src/server/generation/providers/*` (claude / gemini / openrouter / shared)
- Storage
  - `src/storage/postgres/schema.ts`
  - `src/storage/postgres/agent-events.ts`
  - `src/storage/postgres/generation-jobs.ts`
  - `src/storage/postgres/observations.ts`
  - `src/storage/postgres/server-sessions.ts`
  - `src/storage/postgres/auth.ts`
  - `src/storage/postgres/audit-logs.ts`
- HTTP surface
  - `src/server/routes/v1/ServerV1PostgresRoutes.ts`
  - `src/server/middleware/postgres-auth.ts`
  - `src/server/middleware/request-id.ts`
  - `src/server/runtime/ServerService.ts`
- Compatibility
  - `src/server/compat/SessionsObservationsAdapter.ts`
  - `src/server/compat/SessionsSummarizeAdapter.ts`
- Hook routing
  - `src/services/hooks/runtime-selector.ts`
  - `src/services/hooks/server-client.ts`
  - `src/services/hooks/server-bootstrap.ts`
- MCP
  - `src/servers/mcp-server.ts`
- CLI
  - `src/cli/server-jobs.ts`
  - `src/server/runtime/ServerService.ts` (`runServerApiKeyCli`, `runServerCli`)
- Queue
  - `src/server/jobs/ServerJobQueue.ts`
  - `src/server/jobs/job-id.ts`
  - `src/server/jobs/payload-schema.ts`
  - `src/server/jobs/types.ts`
- Deployment
  - `docker-compose.yml`
  - `docker/claude-mem/Dockerfile`
  - `scripts/e2e-server-docker.sh`
- Tests
  - `tests/server/runtime/*`
  - `tests/server/generation/*`
  - `tests/server/jobs/*`
  - `tests/compat/*`
  - `tests/hooks/*`
  - `tests/cli/*`
  - `tests/servers/*`
- Existing release docs
  - `docs/server-parity-map.md`
  - `docs/server-release-readiness.md`
  - `docs/server.md`
  - `docs/api.md`

---

## Closing

The job of server-beta is to be invisible. A solo developer never knows it's there; their hooks just keep working. A team adopts it; their AI sessions start sharing context across humans, services, and machines without anyone having to learn a new tool. An org deploys it; the audit chain and tenant scope become compliance primitives. The substrate is the same in all three cases — only the wiring changes.

claude-mem's original ethos was *memory that writes itself*. Server-beta extends that to *memory that writes itself, for everyone*. The infrastructure to do this is now merged. The interesting work — feeds, trust labels, federation UX, marketplace packs, cost dashboards, voice capture, multi-modal payloads — is all sitting one layer above a substrate that's already shaped to receive it.
