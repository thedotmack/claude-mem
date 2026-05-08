# Finish BullMQ Observation Queue Branch — Ship Plan

Date: 2026-05-07
Branch: `bullmq-vs-bee-queue-for-claude-mem-observation-que`
Base: `origin/main` @ `0a43ab76`
Parent plan: `plans/2026-05-07-server-beta-independent-bullmq-observation-runtime.md`

## Reframe

The prior session believed Phase 1 was ungated because two reviewer agents failed (one returned not_found, "Carver" was user-aborted at 111.9s). That belief was based on a stale snapshot that predated commit `4e0fc77a Add Postgres observation storage foundation`. **Phase 1 is committed.** `git status` shows zero uncommitted changes under `src/storage/postgres/`.

What is actually dirty in the worktree is **Phase 2: Define Server Runtime Boundary**. The dirty files map 1:1 to that phase's "What To Implement" section. The remaining work to "finish this branch" is: confirm Phase 1 with concrete checks (not another reviewer agent), land Phase 2, push.

Phases 3–13 (BullMQ queue, event-to-job pipeline, provider extraction, hook routing, MCP, compat, Docker, team auth, observability, final verification) are explicitly **out of scope** for this branch. The PR is already 167 files / 23.5K insertions. Continuing past Phase 2 here would make review impossible.

## Phase 0: Documentation Discovery

### Sources Read

- `plans/2026-05-07-server-beta-independent-bullmq-observation-runtime.md` (parent plan, 987 lines, all 14 sections from Phase 0 through Phase 13)
- `PR_REORIENTATION_REPORT.md` (660 lines) — independent inventory of committed + dirty surfaces
- `git status`, `git log --oneline -15`, `git diff --stat HEAD`
- Worktree: `src/server/runtime/{ServerBetaService.ts,create-server-beta-service.ts,types.ts}`
- Worktree: `src/storage/postgres/` — already in commit `4e0fc77a`

### Concrete Findings

- Phase 1 (Postgres storage foundation) is committed in `4e0fc77a`. Includes scoped `addSource`, `transitionStatus`, generation-job event `append`, FTS via generated `content_search` tsvector + GIN index, tenant-scoped uniqueness constraints, and 20 integration tests including the negative-scope mutation test.
- Phase 2 (server runtime boundary) is implemented but uncommitted. Files match the parent plan's Phase 2 deliverables exactly: independent `ServerBetaService`, `create-server-beta-service`, disabled boundary types, `.server-beta.{pid,port,runtime.json}` paths, runtime labels in `/api/health` and `/v1/info`, server-beta CLI lifecycle, build-hooks split into a separate `server-beta-service.cjs` bundle, ephemeral-port test for `/api/health` and `/v1/info`.
- Two doc artifacts (`AGENTS.md`, `PR_REORIENTATION_REPORT.md`) are also untracked. Decide before push.

### Anti-Pattern Guards (carried from parent plan)

- Do not spawn a third reviewer agent to "gate" Phase 1. The integration test suite plus the plan's grep checklist is the gate. Reviewer agents are a second opinion, not the primary gate.
- Do not pull Phase 3+ work into this branch.
- Do not amend `4e0fc77a` to "tidy" Phase 1; create new commits.
- Do not couple Phase 2 to `WorkerService` (the entire point of Phase 2 is independence).

## Phase A: Re-Confirm Phase 1 Gate (Deterministic, No Reviewer Agent)

### What To Run

1. `tsc --noEmit` scoped to Postgres storage:
   ```bash
   bunx tsc --noEmit src/storage/postgres/*.ts
   ```
2. Postgres integration suite (requires `DATABASE_URL` or local Postgres on default port):
   ```bash
   bun test tests/storage/postgres
   ```
3. Anti-pattern greps (must all return zero matches in `src/storage/postgres/`):
   ```bash
   rg -n "UNIQUE\s*\(\s*source_type\s*,\s*source_id\s*,\s*job_type\s*\)" src/storage/postgres
   rg -n "UNIQUE\s*\(\s*observation_id\s*,\s*source_type\s*,\s*source_id\s*\)" src/storage/postgres
   ```
4. Scoped-mutation grep (must show `projectId`/`teamId` parameters):
   ```bash
   rg -n "addSource|transitionStatus|append" src/storage/postgres
   ```

### Verification Checklist

- TypeScript clean.
- All 20 Postgres integration tests pass, including the negative-scope mutation test.
- Both anti-pattern greps return empty.
- Scoped-mutation grep shows `projectId`/`teamId` in every signature.

### Anti-Pattern Guards

- Do not edit `src/storage/postgres/*.ts` in this phase. If Phase A fails, open a separate fix-up commit; do not amend `4e0fc77a`.

## Phase B: Land Phase 2 (Server Runtime Boundary)

### What To Run

1. Phase 2 independence grep — Server beta runtime must not import worker:
   ```bash
   rg -n "WorkerService|services/worker-service|worker/http" \
     src/server/runtime src/npx-cli/commands/server.ts
   ```
   Allowed: matches inside `src/services/worker-service.ts` itself (delegation back to server-beta is fine). Forbidden: any import inside `src/server/runtime/`.
2. Server-beta service test:
   ```bash
   bun test tests/server/server-beta-service.test.ts
   ```
3. CLI namespace test:
   ```bash
   bun test tests/npx-cli-server-namespace.test.ts
   ```
4. Build verifies `server-beta-service.cjs` bundle is produced:
   ```bash
   npm run build-and-sync
   ls -la plugin/scripts/server-beta-service.cjs
   ```
5. Smoke test independence:
   ```bash
   npx claude-mem server status      # before start
   npx claude-mem server start
   npx claude-mem server status      # running, runtime=server-beta
   curl -s http://127.0.0.1:$(cat ~/.claude-mem/.server-beta.port)/healthz
   curl -s http://127.0.0.1:$(cat ~/.claude-mem/.server-beta.port)/v1/info
   npx claude-mem server stop
   ```
   Worker `start|stop|status` must remain functional throughout.

### Commit Layout

Two commits, in order:

1. **`feat(server-beta): add independent runtime service`**
   - `src/server/runtime/ServerBetaService.ts`
   - `src/server/runtime/create-server-beta-service.ts`
   - `src/server/runtime/types.ts`
   - `src/server/routes/v1/ServerV1Routes.ts` (runtime label)
   - `src/services/server/Server.ts` (runtime option)
   - `src/shared/paths.ts` (`.server-beta.{pid,port,runtime.json}`)
   - `tests/server/server-beta-service.test.ts`

2. **`feat(server-beta): route CLI lifecycle and build a separate bundle`**
   - `scripts/build-hooks.js` (server-beta bundle output)
   - `src/npx-cli/commands/runtime.ts` (server-beta lifecycle commands)
   - `src/npx-cli/commands/server.ts` (CLI routing)
   - `src/services/worker-service.ts` (delegate `server-start|stop|restart|status` to sibling bundle)
   - `tests/npx-cli-server-namespace.test.ts`

### Documentation References

- Parent plan, lines 469–514: Phase 2 deliverables and verification checklist.
- `src/services/server/Server.ts`: existing route-composition style to copy.
- `src/services/infrastructure/ProcessManager.ts`: PID-file safety patterns.

### Verification Checklist

- All five Phase B steps pass.
- Worker lifecycle still works while server-beta is running, and vice versa.
- Two commits land cleanly with no `--amend` or force operations.

### Anti-Pattern Guards

- Do not import `WorkerService` from `src/server/runtime/`.
- Do not overload worker PID/port files.
- Do not boot worker as a background dependency of server-beta.
- Do not silently fall back from server-beta to worker.

## Phase C: Decide Doc Artifacts

### What To Decide

| File | Recommendation | Rationale |
|------|---------------|-----------|
| `PR_REORIENTATION_REPORT.md` | Use as PR body, then delete (or move to `docs/internal/`). | It's a snapshot, not durable docs. Useful for the PR reviewer; rots in-tree. |
| `AGENTS.md` | Read first, then either commit (if generally useful guidance) or move under `.scratch/`. | Decision depends on content. |

### Verification

- Final `git status` shows only intended doc artifacts (or none).
- `.scratch/` is gitignored if used.

### Anti-Pattern Guard

- Do not push `PR_REORIENTATION_REPORT.md` to main as a doc; it has a date and a HEAD SHA, it ages immediately.

## Phase D: Push and Open/Update PR

### What To Run

1. `git push -u origin bullmq-vs-bee-queue-for-claude-mem-observation-que`
2. `gh pr view --web` (if PR exists) or `gh pr create` with body sourced from `PR_REORIENTATION_REPORT.md`.
3. PR body must explicitly carve scope: "Includes Phase 1 + Phase 2 from `plans/2026-05-07-server-beta-independent-bullmq-observation-runtime.md`. Phases 3–13 are follow-ups on separate branches."

### Verification Checklist

- PR title is short (under 70 chars) and reflects scope: e.g., "Add Postgres storage + independent server-beta runtime (Phases 1–2)".
- PR body lists out-of-scope phases.
- CI is green.

### Anti-Pattern Guards

- Do not force-push to main.
- Do not merge without CI green.

## Phase E: Branch Closeout

Once the PR merges, this branch is done. Phase 3 (BullMQ-First Server Queue) starts on a fresh branch off main. Do not reuse this branch for Phase 3 work — keep the queue/runtime split visible in history.

## Final Verification (cross-phase)

Run after Phases A–D:

```bash
git status                                   # clean or only intended doc artifacts
git log --oneline origin/main..HEAD          # 4e0fc77a + Phase 2 commits, no force-push markers
bun test tests/storage/postgres tests/server tests/npx-cli-server-namespace.test.ts
rg -n "WorkerService|services/worker-service|worker/http" src/server/runtime
rg -n "PendingMessageStore|SessionQueueProcessor" src/server/runtime
```

Expected:

- All three test paths green.
- Both greps return zero matches.
- Branch ready to merge.

## Decisions Locked

1. Phase 1 gate: orchestrator-managed deterministic checks (no reviewer agent).
2. `AGENTS.md` + `PR_REORIENTATION_REPORT.md`: **discard** before commit.
3. Scope: this branch ships Phases 1 + 2 + **3** (BullMQ-First Server Queue). Phase E becomes Phase 3 work, push moves to Phase F.

## Phase D (revised): Discard Untracked Doc Artifacts

```bash
rm AGENTS.md PR_REORIENTATION_REPORT.md
```

Verification: `git status` shows neither file.

## Phase E: Implement Phase 3 — BullMQ-First Server Queue

Source: parent plan lines 515–570.

### What To Implement

- `src/server/jobs/types.ts` — job-shape types:
  - `ServerGenerationJob` (base)
  - `GenerateObservationsForEventJob`
  - `GenerateObservationsForEventBatchJob`
  - `GenerateSessionSummaryJob`
  - `ReindexObservationJob`
  - Every job carries `team_id`, `project_id`, `source_type`, `source_id`, `generation_job_id`. Event jobs add `agent_event_id`. Summary jobs add `server_session_id`. Reindex jobs add target observation ID or deterministic reindex scope ID.
- `src/server/jobs/job-id.ts` — deterministic, colon-free job IDs (port the SHA-256-safe pattern from `src/server/queue/BullMqObservationQueueEngine.ts`).
- `src/server/jobs/ServerJobQueue.ts` — thin wrapper around BullMQ `Queue`, `Worker`, `QueueEvents`. Use `autorun: false`, explicit `concurrency: 1` default per lane, and an `error` listener on every `Worker`.
- `src/server/jobs/outbox.ts` — durable outbox over `ObservationGenerationJobRepository`. Statuses: `queued`, `processing`, `completed`, `failed`, `cancelled`. Tracks attempts, last error, timestamps, and tenant/project/session IDs.
- Startup reconciliation:
  - Re-enqueue rows in `queued` or stale `processing`.
  - Skip rows already `completed`.
  - Replace terminal BullMQ jobs before reusing deterministic IDs.
- Wire queue health into `/v1/info`, `/api/health`, and `claude-mem server status` via the existing runtime label hook.
- Activate the queue boundary in `ServerBetaService` (Phase 2 left it disabled). Provide a real adapter when `CLAUDE_MEM_QUEUE_ENGINE=bullmq` and `REDIS_URL` are present; keep the disabled adapter as the fallback.

### Documentation References

- BullMQ Workers: https://docs.bullmq.io/guide/workers
- BullMQ Concurrency: https://docs.bullmq.io/guide/workers/concurrency
- BullMQ Stalled Jobs: https://docs.bullmq.io/guide/jobs/stalled
- `src/server/queue/BullMqObservationQueueEngine.ts` — copy deterministic job-ID + Redis health patterns; do **not** copy the worker-iterator compatibility shape.
- `src/server/queue/redis-config.ts` — Valkey/Redis health checks.
- `src/storage/postgres/generation-jobs.ts` — outbox repository (already committed in 4e0fc77a).

### Verification Checklist

Unit tests under `tests/server/jobs/`:

- `job-id.test.ts` — deterministic IDs, no colons, stable across runs, content-derived.
- `server-job-queue.test.ts` — Queue/Worker lifecycle, `error` listener attached, concurrency honored, autorun false.
- `outbox.test.ts` — duplicate enqueue suppression, terminal job replacement, status transitions, attempt counting.

Integration tests under `tests/server/queue-bootstrap/`:

- Start `ServerBetaService` with Postgres + Valkey + queue boundary enabled.
- Insert outbox rows directly through `ObservationGenerationJobRepository`.
- Enqueue fake jobs; restart before fake processing completes.
- Assert reconciliation re-enqueues exactly once and outbox status reaches `completed` exactly once.
- Assert Redis-down fails Server beta startup when `CLAUDE_MEM_QUEUE_ENGINE=bullmq`; no silent fallback to SQLite.

Greps:

```bash
rg -n "Bull(MQ|Mq).*\.add\(" src/server/jobs        # uses BullMQ Queue.add
rg -n "autorun" src/server/jobs                     # workers explicitly set autorun
rg -n "on\(['\"]error" src/server/jobs              # error listener attached
rg -n ":job:|:obs:" src/server/jobs                 # NO colons in deterministic IDs
```

The colon-grep must return zero matches.

### Anti-Pattern Guards

- Do not treat BullMQ completed/failed state as canonical history — Postgres outbox is canonical.
- Do not require event-route wiring or provider generation here (Phase 4 territory).
- Do not allow duplicate processor side effects on retry — keep observation writes idempotent by deterministic key.
- Do not use BullMQ Pro-only features (groups).
- Do not leave pending work only in Redis.
- Do not silently fall back from BullMQ to SQLite when `CLAUDE_MEM_QUEUE_ENGINE=bullmq` is set.

### Commit Layout

Two commits:

1. **`feat(server-beta): add BullMQ job queue primitives`**
   - `src/server/jobs/types.ts`
   - `src/server/jobs/job-id.ts`
   - `src/server/jobs/ServerJobQueue.ts`
   - `src/server/jobs/outbox.ts`
   - `tests/server/jobs/*.test.ts`

2. **`feat(server-beta): activate queue boundary in runtime service`**
   - `src/server/runtime/ServerBetaService.ts` (queue boundary wiring)
   - `src/server/runtime/create-server-beta-service.ts` (boundary selection from env)
   - `src/server/runtime/types.ts` (active queue manager interface)
   - Health surface updates in `/v1/info` and `/api/health` if not already covered by Phase 2 runtime label.
   - `tests/server/queue-bootstrap/*.test.ts`

## Phase F: Push and Open/Update PR

```bash
git push -u origin bullmq-vs-bee-queue-for-claude-mem-observation-que
gh pr view --web   # if PR exists
# else:
gh pr create --title "Server-beta: Postgres storage + independent runtime + BullMQ queue (Phases 1–3)"
```

PR body must list:

- Scope: Phases 1, 2, 3 of `plans/2026-05-07-server-beta-independent-bullmq-observation-runtime.md`.
- Out of scope: Phases 4–13 (event-to-job pipeline, provider extraction, hook routing, MCP, compat, Docker, team auth, observability, final verification).

### Verification Checklist

- `git status` clean.
- `git log --oneline origin/main..HEAD` shows all expected commits, no force-push markers.
- CI green.

## Final Cross-Phase Verification

```bash
git status                                                            # clean
bun test tests/storage/postgres tests/server tests/npx-cli-server-namespace.test.ts
rg -n "WorkerService|services/worker-service|worker/http" src/server/runtime    # zero
rg -n "PendingMessageStore|SessionQueueProcessor" src/server/runtime src/server/jobs  # zero
```
