# [plan-24] Server Runtime & Cloud Sync Contract — one generation pipeline shared by worker and server, session linkage on every write path, bounded sync

> **Tracker:** #3618 · **Design doc:** `plans/24-server-runtime-generation-and-sync-contract.md` · **Series:** plan-14 #3602 · plan-15 #3603 · plan-16 #3604 · plan-17 #3605 · plan-18 #3606 · plan-19 #3607 · plan-20 #3608 · plan-21 #3609 · plan-22 #3610 · plan-23 #3611 · plan-24 #3618

## Defect

The server runtime (`src/server/`, Postgres + BullMQ generation jobs, `/v1/*` routes, `workers/sync-hub`) and the client-side cloud sync (`CloudSync.ts`, `sync_outbox`) were built as a **second, hand-copied implementation** of the worker's generation and storage pipeline, with no shared contract and no contract tests. Every place the two paths were supposed to agree, they have drifted — and because the server marks jobs `completed` on the way out, the drift is silent:

- **Prompt/parse contract copied, not shared.** `buildServerGenerationPrompt` is used for both event and summary jobs and always requests `<observation>` blocks; `parseAgentXml` returns `summary: null` for that shape; `processSessionSummaryResponse` reads only `parsed.summary` → every summary response is discarded and the job marked completed (4,836 completed summary jobs, 0 rows). Same defect class as #1345 in the SDK path, re-introduced in the new runtime.
- **Summary input is the wrong set, sized by the wrong unit.** Summary jobs are fed from `listUnprocessedEvents` (recovery leftovers, count-capped at 500, excludes events with completed per-event jobs), so most sessions hand the model an empty or partial `<agent_events>` block; and the cap is by event *count*, not rendered *bytes*, so long sessions overflow the context window and are classified `unrecoverable`. The size estimate lived in a hand-copied helper that drifted from the real block builder.
- **Job identity is not stable across the idempotent upsert.** `ON CONFLICT (idempotency_key)` keeps the existing row `id` but JSONB-merges the freshly minted id into `payload.generation_job_id`; `lockOutbox` then finds nothing and reports `completed` to BullMQ. Only per-session idempotency keys (summaries) collide, so it looks like a summary bug rather than a queue bug.
- **Session linkage / project metadata added to one write path and not the other.** `/v1/events` resolves `contentSessionId → server_sessions.id`; `/v1/memories` never did (2,948/2,948 rows with `server_session_id NULL`); generated observations/summaries never copy `server_sessions.metadata.project` onto the row, so per-project injection/search cannot scope server-generated data; the inject panel prints full UUIDs that are not usable fetch handles.
- **Hooks and context assume the local worker.** `hooks.json` `start` and every `hook <platform> <event>` call `ensureWorkerStarted()` regardless of `CLAUDE_MEM_RUNTIME`; in server runtime the MCP search server holds the worker port so hooks wait ~180 s for a health check that never answers; the SessionStart context handler has no `/v1/context` branch.
- **Client-side sync has no bounds.** `sync_outbox` producers write unconditionally while the only consumer (`CloudSync.drainMutations`) is never constructed without credentials, and every `DELETE FROM sync_outbox` site is unreachable on default installs; the v2 projection rewrite dropped the `substr(prompt_text,1,200000)` clamp (multi-MB prompts → `SQLiteError: out of memory`, 682 crashes/10 users) and prepares statements per prompt inside a loop; sync-hub's projection repair drains an unbounded backlog inside one request while holding the per-user lease.

The unifying mechanism: **there is no shared contract between the worker path and the server/sync path**, so each fix to one path has to be re-discovered on the other, and the server path's "completed" is not evidence that anything was written.

## Children

Open PRs routed here by the 2026-08-16 PR consolidation pass (no open issues at time of writing — the symptoms were reported through PRs by server-runtime operators):

- #3587 — summary jobs get an observation-shaped prompt; every summary silently dropped (recurrence of #1345); input set is unprocessed leftovers, not the session
- #3584 — summary input bounded by event count, not rendered bytes → context overflow → `unrecoverable`, no summary
- #3583 — idempotent job upsert leaves `payload.generation_job_id` pointing at a phantom row; `lockOutbox` null → BullMQ `completed` without a write
- #3586 — `/v1/memories` never resolves `contentSessionId`/platform scope (all rows `server_session_id NULL`); `/v1/events` does
- #2671 — server-generated observations/summaries written with `metadata.project = null`; per-folder scoping impossible
- #2867 — inject panel prints full Postgres UUIDs (~17 tokens each) that are not fetch handles
- #3227 — hooks call `ensureWorkerStarted()` in server runtime (180 s stall); SessionStart context has no server branch
- #3537 — CloudSync projection dropped the 200 KB `substr` clamp (OOM crashes); statement handles leak in the requeue loop
- #3555 — sync-hub repair drains unbounded backlog under one lease/request; caller treats any 2xx as done
- #3228 — custom server provider module (extension point; decide separately)
- #3498 — `cloud connect` CLI for CMEM Pro (feature; depends on private app change)

Related, routed to plan-21 because the defect is in the local queue: #3616 (`sync_outbox` unbounded on default installs), #3597 (synthetic session id re-mint × prompt requeue amplification).

## Fix sequence

1. **One prompt/parse contract, keyed by job type.** `buildGenerationPrompt({sourceType})` and `parseAgentXml` are the *same modules* on both runtimes (`src/sdk/`), with the summary variant requesting `<summary>` and the parser's `skip`/`empty`/`prose_salvageable` classification (plan-18 step 1) applied identically; summary input is the **full session event set** (not `listUnprocessedEvents`), bounded by rendered bytes measured by the block builder itself (`eventBlockBytes`), head+tail selection, and the envelope counted. A summary job that produces zero rows is `failed:<reason>`, never `completed`.
2. **Job identity that survives the upsert.** The generation-jobs upsert re-pins `payload.generation_job_id` to the surviving row id (or the id is not stored in the payload at all); `lockOutbox` returning null is an ERROR with the idempotency key logged and the job marked `failed`, not `completed`. Postgres-gated regression test runs in CI (service container).
3. **Every write path resolves the same session/project identity.** `/v1/events`, `/v1/memories`, MCP `observation_add`, and generated rows all pass through one `resolveServerSession({contentSessionId, platformSource})` and stamp `metadata.project` from the session (or `resolveProjectIdentity()`, plan-20) at write time; the inject panel renders 8-char prefixes with a legend when `fetchByIdSupported=false`. Backfill for existing NULL rows is a one-shot repair.
4. **Runtime-aware hooks and context.** `CLAUDE_MEM_RUNTIME=server` short-circuits `ensureWorkerStarted()` in every hook entry and the CLI `start`; the SessionStart context handler gains a `/v1/context` recency branch; the Codex/OpenCode adapters (plan-23) inherit the same switch. A hook in server runtime must complete in < 5 s with the worker port occupied by an unrelated listener.
5. **Bounded sync on both ends.** Client: `substr(prompt_text,1,N)` restored with NUL-safe truncation (`length()` in bytes, not chars), prepared statements cached outside the loop, and `sync_outbox` producers gated on the consumer's existence with a `set_title` backfill when sync is enabled later (plan-21 owns the outbox table). Hub: repair endpoint processes one page per request, releases the lease at each checkpoint, returns 202 while incomplete, and the caller loops until 200.
6. **Contract tests, not parity by inspection.** A single fixture corpus (event batch, summary batch, memory write) is replayed through *both* runtimes in CI and the resulting rows compared field-by-field (`project`, `session_id`/`server_session_id`, `type`, `title`, `files_*`); any new column added to one path fails the other's contract test.

## Test matrix

| Runtime | Job / path | Input | Required behavior |
|---|---|---|---|
| server | `session_summary` job | 40-event session, all events already processed | one `session_summaries` row; job `completed` only after row exists |
| server | `session_summary` job | 2,000-event session (> context window) | head+tail bounded input; row written; no `unrecoverable` |
| server | `session_summary` job re-run | same idempotency key | upsert re-pins job id; `lockOutbox` finds the row; no phantom `completed` |
| server | `/v1/memories` | `contentSessionId` + `platformSource=codex` | `server_session_id` resolved with platform scope; Cursor session not matched |
| server | generated observation | session with `metadata.project` | row `metadata.project` populated; `/v1/context` scoped by project returns it |
| server | SessionStart hook | `CLAUDE_MEM_RUNTIME=server`, port held by mcp-search | context returned in < 5 s; no `ensureWorkerStarted` |
| local | CloudSync projection | 4 MB prompt with embedded NUL | clamped to N bytes, no OOM, not acked as fully synced |
| local | default install (no credentials) | 100 sessions × 20 prompts | `sync_outbox` row count bounded (0 growth without consumer) |
| hub | projection repair | 10,000-row backlog | 202 per page, lease released between pages, caller converges to 200 |
| both | contract replay | fixture corpus | field-by-field row equality between worker and server paths |

The matrix lives in CI (Postgres service container for the server rows). A future regression must fail CI before a user can file.

## Out of scope

Observer output classification and history budgets themselves (plan-18 — this plan only requires the server path to *use* the same modules). Local `sync_outbox` schema/state machine (plan-21). Project key derivation (plan-20). Host adapter schemas (plan-23). New Pro features (`cloud connect`, custom provider modules) are tracked here as children but are product decisions, not defect fixes.
