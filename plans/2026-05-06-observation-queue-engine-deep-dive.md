# Observation Queue Engine Deep Dive: BullMQ vs Bee-Queue

Date: 2026-05-06

## Executive decision

If claude-mem replaces its observation queue with one of the two Redis-backed libraries, choose **BullMQ**, not Bee-Queue.

That said, the current observation queue is not a generic background job queue. It is a durable, per-session input stream feeding long-lived provider generators. Replacing it with Redis should not be the default local install path unless claude-mem is willing to require, bundle, or supervise Redis. If Redis is not acceptable as a new operational dependency, the better path is to keep the SQLite queue and fix the contract/test drift.

Recommended path:

1. Stabilize the current queue contract and tests.
2. Add a queue-engine adapter boundary.
3. Keep SQLite as the default backend.
4. Add BullMQ as an optional backend for users who explicitly configure Redis.
5. Do not adopt Bee-Queue.

## Current claude-mem queue shape

The active queue path is:

- `src/services/worker/http/shared.ts` and `SessionRoutes.ts` ingest observations/summarize requests.
- `SessionManager.queueObservation()` and `queueSummarize()` persist rows through `PendingMessageStore.enqueue()`.
- `SessionQueueProcessor.createIterator()` claims one row at a time and wakes via a per-session `EventEmitter`.
- Provider loops in `ClaudeProvider`, `GeminiProvider`, and `OpenRouterProvider` consume `sessionManager.getMessageIterator(sessionDbId)`.
- Parsed agent output is stored through `processAgentResponse()`, then `SessionManager.clearPendingForSession()` clears that session's pending rows.

Key semantics that must survive any replacement:

- Per-session FIFO ordering.
- At-most-one active consumer per session.
- Durable queue across worker restarts.
- Startup recovery from `processing` back to `pending`.
- Low-latency wakeup when new tool observations arrive.
- Deduplication by `content_session_id + tool_use_id`.
- Original observation timestamp preservation for storage/broadcast.
- Queue depth for `/api/processing-status` and SSE.
- Local-first behavior and simple install are product requirements, not just implementation details.

Important mismatch found during the dive:

- Current `PendingMessageStore` only models `pending` and `processing`.
- Older migrations, tests, and scripts still reference `processed`, `failed`, `retry_count`, `completed_at_epoch`, `failed_at_epoch`, and `worker_pid`.
- `storeObservationsAndMarkComplete()` still updates a row to `processed`, while the currently visible queue path clears all pending messages for the session after parsing.
- `src/services/sqlite/schema.sql` still creates `idx_pending_messages_worker_pid` even though the visible table definition has no `worker_pid`.

Focused test run:

```sh
bun test tests/services/sqlite/PendingMessageStore.test.ts tests/services/queue/SessionQueueProcessor.test.ts
```

Result: 10 pass, 6 fail. Failures show stale tests/contract drift:

- `PendingMessageStore.test.ts` passes `3` as constructor arg, but constructor now expects `onMutate?: () => void`.
- `SessionQueueProcessor.test.ts` expects retry-after-store-error behavior, but current implementation logs and exits the iterator on claim failure.

This needs to be reconciled before swapping engines; otherwise the migration will encode inconsistent behavior.

## BullMQ deep dive

Sources checked:

- GitHub: https://github.com/taskforcesh/bullmq
- NPM: https://www.npmjs.com/package/bullmq
- Docs: https://docs.bullmq.io/
- Queues: https://docs.bullmq.io/guide/queues
- Connections/Redis constraints: https://docs.bullmq.io/guide/connections
- Production notes: https://docs.bullmq.io/guide/going-to-production
- Manual processing: https://docs.bullmq.io/patterns/manually-fetching-jobs
- Job IDs/dedupe: https://docs.bullmq.io/guide/jobs/job-ids
- Stalled jobs: https://docs.bullmq.io/guide/workers/stalled-jobs

Current package/repo facts captured on 2026-05-06:

- NPM latest: `bullmq@5.76.5`.
- NPM modified: 2026-05-02.
- GitHub pushed: 2026-05-05.
- GitHub stars/forks/open issues at capture time: 8808 / 606 / 414.
- License: MIT.
- Unpacked size: about 2.5 MB.
- Dependencies: `ioredis`, `cron-parser`, `msgpackr`, `node-abort-controller`, `semver`, `tslib`.
- TypeScript types are bundled.
- A Bun import smoke test succeeded for `import { Queue } from 'bullmq'`.

Strengths for claude-mem:

- Actively maintained and widely used.
- Built-in TypeScript API.
- Redis-backed durability and distributed workers.
- Built-in stalled-job recovery, retry attempts, fixed/exponential backoff, delays, priorities, FIFO/LIFO, auto-removal, QueueEvents, manual processing APIs, and job ID based dedupe.
- BullMQ docs explicitly support manual job fetching with `Worker#getNextJob()`, `moveToCompleted()`, `moveToFailed()`, and lock extension. This matters because claude-mem's provider loop is closer to a stream consumer than a normal job processor.

Costs and risks:

- Redis becomes required for the queue backend. BullMQ docs require a Redis connection to use queues and recommend Redis compatibility 6.2+.
- Redis must be configured like durable infrastructure, not cache: AOF persistence and `maxmemory-policy=noeviction` are recommended/required for correctness.
- Connection count increases. BullMQ docs note each class consumes at least one Redis connection; `Worker` and `QueueEvents` need blocking/duplicated connections in some cases.
- Jobs store data in Redis in clear text unless claude-mem encrypts or avoids sensitive payload fields. Tool input/output can be sensitive.
- BullMQ job completion/failure semantics do not map directly to claude-mem's current "provider consumes many messages, parses one response, then clears the session" behavior.
- Per-session FIFO with parallel sessions is not free in OSS BullMQ. A single global queue with worker concurrency > 1 can violate same-session ordering unless we add a scheduler. BullMQ Pro groups would address this, but claude-mem should not depend on Pro.
- Custom `jobId` is useful for `tool_use_id` dedupe, but BullMQ custom job IDs must not contain `:`. Use a hash or safe delimiter.
- Manual processing requires lock management. BullMQ docs call out that manually fetched jobs do not get automatic lock renewal like standard processors; claude-mem would need `extendLock()` for long provider calls or a large lock duration.

Best BullMQ shape if adopted:

- Prefer **one queue per active session** over one global queue initially:
  - Queue name: `claude-mem:session:<safe-session-db-id>` or a hashed content-session suffix.
  - Worker/manual consumer concurrency: `1`.
  - Preserves per-session FIFO without BullMQ Pro groups.
  - Active session counts are naturally low for local claude-mem usage.
  - Cleanup queue keys when a session is deleted or after idle timeout.
- Use `jobId` for observation dedupe:
  - `obs_<sha256(contentSessionId + "\0" + toolUseId)>`.
  - Summaries should use a distinct id scheme and usually should not dedupe unless the current summarize semantics require it.
- Use `removeOnComplete` aggressively if SQLite remains the source of truth for stored observations.
- Keep only bounded failed jobs for debugging.
- Treat Redis as queue state only; SQLite remains the canonical observation/session store.
- Add config:
  - `CLAUDE_MEM_QUEUE_ENGINE=sqlite|bullmq`
  - `CLAUDE_MEM_REDIS_URL`
  - `CLAUDE_MEM_QUEUE_REDIS_PREFIX`
  - `CLAUDE_MEM_QUEUE_ENCRYPT_PAYLOADS=true|false` if sensitive fields are stored.

## Bee-Queue deep dive

Sources checked:

- GitHub: https://github.com/bee-queue/bee-queue
- NPM: https://www.npmjs.com/package/bee-queue
- README/API docs in repository.

Current package/repo facts captured on 2026-05-06:

- NPM latest: `bee-queue@2.0.0`.
- NPM modified: 2025-12-08.
- GitHub pushed: 2026-04-10.
- GitHub stars/forks/open issues at capture time: 4027 / 221 / 47.
- License field from NPM: MIT. GitHub API license metadata returned `NOASSERTION`.
- Unpacked size: about 107 KB.
- Dependencies: `redis@^3.1.2`, `p-finally`, `promise-callbacks`.
- NPM package exposes `./index.d.ts`.
- A Bun import smoke test succeeded for `import BeeQueue from 'bee-queue'`.

Strengths for claude-mem:

- Very small and simple.
- Designed for short, real-time jobs.
- Redis-backed with Lua/pipelining and low overhead.
- Supports concurrency, retries, retry strategies, timeouts, scheduled jobs, pub/sub events, results to producers, and stalled job retry.
- Redis requirement is lighter in docs: Redis 2.8+, with Redis 3.2+ recommended for delayed jobs.

Costs and risks:

- Narrower feature set by design. The README says priorities and repeatable jobs are not currently supported.
- CommonJS-first API; workable, but less idiomatic for this ESM TypeScript codebase.
- Uses the older `redis` v3 client line, not modern `redis` v4/v5 or `ioredis`.
- Observability and operational tooling are thinner than BullMQ.
- Same per-session ordering mismatch exists as BullMQ, but with fewer escape hatches.
- Delayed retry behavior requires `activateDelayedJobs` on at least one queue instance.
- The package is newly revived, but not as active/mature as BullMQ for a queue-engine foundation.

Conclusion: Bee-Queue is attractive if the only goal is "small Redis queue for short jobs." claude-mem needs a durable session stream with strict per-session semantics, good TypeScript ergonomics, explicit recovery behavior, and long-term maintenance. Bee-Queue is the wrong tradeoff.

## Scorecard

| Area | Current SQLite | BullMQ | Bee-Queue |
| --- | --- | --- | --- |
| Local-first install | Strong | Weak unless Redis is bundled/optional | Weak unless Redis is bundled/optional |
| Per-session FIFO | Strong | Medium with per-session queues; weak with one global queue | Medium with per-session queues; weak with one global queue |
| Restart durability | Strong, SQLite-backed | Strong if Redis persistence configured | Strong if Redis persistence configured |
| Stalled recovery | Custom/simple | Strong built-in | Built-in |
| TypeScript fit | Strong | Strong | Medium |
| Maintenance/activity | Internal | Strong | Medium |
| Operational complexity | Low | High | Medium-high |
| Queue observability | Custom/basic | Strong | Medium |
| Dependency footprint | Low | Larger | Small |
| Privacy/data locality | SQLite local file | Redis clear-text unless handled | Redis clear-text unless handled |
| Best use in claude-mem | Default | Optional advanced backend | Do not use |

## Migration plan

Phase 0: Fix the existing contract

- Decide whether `pending_messages.status` is only `pending|processing`, or whether `processed|failed` is coming back.
- Fix `schema.sql` and migrations so `worker_pid` indexes are not created after `worker_pid` is dropped.
- Fix `storeObservationsAndMarkComplete()` or remove it if no longer used.
- Update queue tests to match real behavior:
  - constructor signature;
  - claim error behavior;
  - reset-on-start behavior;
  - dedupe by `tool_use_id`;
  - clear-session behavior.

Phase 1: Add an adapter boundary

Define a small interface around current behavior, not around BullMQ:

```ts
interface ObservationQueueEngine {
  enqueue(sessionDbId: number, contentSessionId: string, message: PendingMessage): Promise<EnqueueResult>;
  createIterator(sessionDbId: number, signal: AbortSignal, onIdleTimeout?: () => void): AsyncIterableIterator<PendingMessageWithId>;
  clearPendingForSession(sessionDbId: number): Promise<number>;
  resetProcessingToPending(sessionDbId: number): Promise<number>;
  getPendingCount(sessionDbId: number): Promise<number>;
  getTotalQueueDepth(): Promise<number>;
  close(): Promise<void>;
}
```

Keep `SqliteObservationQueueEngine` as the first implementation by moving the current `PendingMessageStore + SessionQueueProcessor` behavior behind this interface.

Phase 2: Add BullMQ backend behind feature flag

- Add `BullMqObservationQueueEngine`.
- Use per-session queues with concurrency/manual fetch of 1.
- Use safe hashed `jobId` for observation dedupe.
- Preserve `_originalTimestamp` in job data.
- Keep provider loops unchanged by preserving the async iterator interface.
- Implement lock extension if manual processing can exceed the configured lock duration.
- Keep SQLite as the observation/session truth; Redis is transport.
- Add Redis connectivity health to `/api/health` only when BullMQ backend is enabled.

Phase 3: Migration and fallback

- On startup with BullMQ enabled, migrate existing SQLite `pending_messages` rows into BullMQ once, then mark/delete migrated rows.
- If Redis is unavailable at startup, fail loudly for `CLAUDE_MEM_QUEUE_ENGINE=bullmq`; do not silently drop observations.
- For default `sqlite`, do not require Redis.

Phase 4: Tests

- Unit-test the adapter contract with a shared test suite.
- Run the suite against SQLite always.
- Run BullMQ tests only when Redis is available, or spin Redis in CI.
- Add crash/restart tests:
  - enqueue, kill worker, restart, process;
  - claimed job stalls and returns;
  - duplicate `tool_use_id` is suppressed;
  - per-session FIFO across concurrent sessions;
  - idle timeout still aborts provider subprocesses.

## Final recommendation

Do not do a direct swap from SQLite to either library.

If the product goal is to keep claude-mem easy to install and local-first, invest in the current SQLite queue: clean up the schema/status drift, restore tests, add explicit retries/failure rows if needed, and keep the in-process wakeup path.

If the product goal is to support distributed workers or stronger queue observability, add **BullMQ as an optional backend** through an adapter. It has the right maintenance profile, TypeScript support, recovery primitives, and docs. Bee-Queue is too narrow and too legacy-client-oriented for this role.
