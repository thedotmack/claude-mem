# [plan-21] SQLite Schema Evolution & Queue State Integrity — one DDL path guarded by introspection, immutable session keys, and queue/session states that can actually transition

> **Tracker:** #3609 · **Design doc:** `plans/21-sqlite-schema-evolution-and-queue-state.md` · **Series:** plan-14 #3602 · plan-15 #3603 · plan-16 #3604 · plan-17 #3605 · plan-18 #3606 · plan-19 #3607 · plan-20 #3608 · plan-21 #3609 · plan-22 #3610 · plan-23 #3611 · plan-24 #3618

## Defect

The store evolves through two competing DDL paths guarded by version flags instead of the real schema, and its runtime state machines have dead transitions:

- `initializeSchema()` runs before the migration chain and contains `CREATE INDEX … ON sdk_sessions(platform_source)`; on a v23 database `CREATE TABLE IF NOT EXISTS` is a no-op, the index throws `no such column: platform_source`, migrations 24–35 never run, and the worker stays "healthy but not ready" forever. `removeSessionSummariesUniqueConstraint()` (v7) is guarded by a live index probe re-run on every construction; older bundles' lax probe misclassifies the v41 `ux_session_summaries_origin` index and **rebuilds `session_summaries` from a frozen 14-column list**, dropping `discovery_tokens` and the v21 `ON UPDATE CASCADE` FK; `ensureDiscoveryTokensColumn()` is guarded on the v11 ledger stamp so it never self-heals; two rebuild paths emit different DDL at the same schema version. Nothing stamps which binary version last wrote the DB, so an older worker (plan-16 stale-dir spawn) can destroy a newer schema.
- Children (`observations`, `session_summaries`) FK on the **mutable** `sdk_sessions(memory_session_id)`; `startSession` rewrites it (`updateMemorySessionId(id, null)` then a new id) under a live child set → 10k–27k `foreign_key_check` violations, `FOREIGN KEY constraint failed` generator loops every 5–10 s where the cascade is missing.
- Queue/session states cannot heal: `PendingMessageStore.retryMessage()` is never called; generator failure marks whole sessions `failed` bypassing `maxRetries`; `completeByDbId()` never writes `status='completed'` (46 active / 1546 failed / 0 completed); `markAllSessionMessagesAbandoned` abandons `status='processing'` so in-flight summaries are killed on session complete (regression of #1519); `session_summaries.files_read/files_edited` are never populated; `relevance_count` is never incremented.
- Growth is unbounded and unreclaimable: `user_prompts.prompt_text` stores the full UserPromptSubmit payload verbatim (avg ~990 KB) and again in `sdk_sessions.user_prompt`, doubled by FTS5 triggers; 175k `pending_messages` rows `failed` forever; no retention; `auto_vacuum=0` and no VACUUM so bulk deletes leave a 131 GB file 90 % freelist; `busy_timeout=0` turns any contention into a 500 and a lost observation; the v12.4.3 cleanup gate mis-reads Bun's int32-truncated `statfs` and never runs. `settings.json` writes were non-atomic and reset-to-`{}` on parse failure (fixed 13.10.2 — verify and close). Docs/skills reference columns that do not exist.

The fix is one schema authority: migrations run *before* any query, each guarded by `PRAGMA table_info`/`index_list` introspection, a single canonical `CREATE TABLE` per table from which rebuilds are generated, a writer-version stamp with refusal to downgrade, immutable FK keys, and explicit state machines with retry/complete transitions plus retention and vacuum policies.

## Children

- #2793 — Database grows unbounded: prompt_text stored verbatim (×2), no retention, no VACUUM
- #2821 — Worker drops observations under lock contention (busy_timeout=0 → 500 "database is locked")
- #2969 — tracking: SQLite data integrity — unbounded prompt bloat and busy_timeout=0 drops writes
- #3080 — ~/.claude-mem/settings.json truncated to one key under concurrent hooks (verified fixed in 13.10.2 — close on verification)
- #3094 — Upgrade to v13.9.1 from an older DB leaves migrations v24-v35 unapplied → "no such column: platform_source", worker "healthy but not ready"
- #3118 — Direct schema v23 → v35 fails: worker background-init throws `no such column: platform_source`
- #3164 — sdk_sessions.status never reaches 'completed' — completeByDbId() only tears down in-memory state
- #3332 — timeline-report skill: example SQL references non-existent observations.source_tool column
- #3344 — Failed pending_messages structurally can never self-heal: retryMessage() is fully-implemented, fully-dead code
- #3419 — Session completion drops in-flight summarize: markAllSessionMessagesAbandoned abandons status=processing (regression of #1519)
- #3446 — Worker launched from an old plugin version dir silently drops session_summaries.discovery_tokens — all session summaries fail permanently
- #3502 — PRAGMA foreign_key_check reports 10k-27k orphaned observations — memory_session_id parent key is rewritten under a live child set
- #3503 — Generator failure loop: session_summaries missing ON UPDATE CASCADE makes every parent-key rewrite throw (schema 49)
- #3517 — session_summaries.files_read and files_edited are never written — 0 of 5,059 rows
- #3551 — v12.4.3 cleanup permanently fails with "Insufficient disk" on linux-x64 (Bun statfsSync int32 truncation)

Related PRs to evaluate/rebase: #2904 (maintenance/VACUUM), #2849 (busy_timeout), #2862/#2860 (prompt cap, landed), #3378 (`repairOrphanedSessionParents`), #1519/#1624 (prior fix), #2770.

## Fix sequence

1. **Migrations first, by introspection.** `SessionStore` constructor: open → `PRAGMA busy_timeout=5000; synchronous=NORMAL; foreign_keys=ON` → run migration chain → *then* `initializeSchema()` (indexes only after their columns provably exist). Every migration guard is `PRAGMA table_info/index_list/foreign_key_list` based; the ledger is advisory. A startup reconciler diffs live DDL against canonical `CREATE TABLE` strings (single source, rebuilds generated from it) and repairs drift (missing column, missing `ON UPDATE CASCADE`), logging what it did.
2. **Writer-version stamp.** `PRAGMA user_version`/`meta.writer_version` = plugin semver; a binary older than the stamp refuses to run migrations or rebuilds and exits with a typed `schema_newer_than_binary` reason (plan-16 keeps this from happening; this makes it non-destructive when it does).
3. **Immutable session keys.** Children FK on `sdk_sessions(id)`; `memory_session_id` becomes a plain mutable column; remove the null-out write on `startSession`; a one-time repair re-parents orphans by `session_db_id`.
4. **State machines with real transitions.** `pending_messages`: `pending → processing → (done | pending[retry_count+1] | failed[retry_count ≥ maxRetries])`, `retryMessage()` wired into every failure path, a scheduled backoff pass reprocesses `pending` rows for sessions not in the active map, `markPendingMessagesAbandoned` touches only `pending`, session finalize waits (bounded) for in-flight processing; `sdk_sessions`: `completeByDbId()` writes `completed`, stale sweep writes both `completed_at` fields; `session_summaries` writes `files_read/files_edited` from the session's observation file lists; `relevance_count` incremented on recall.
5. **Retention & reclaim.** `prompt_text` capped and stored once (already stripped of injected context); `pending_messages` failed rows purged after N days; `auto_vacuum=INCREMENTAL` set on new DBs, one-time backgrounded `VACUUM` gated by a correct free-space check (`statfsSync(path,{bigint:true})`, negative-guarded); observer transcripts retention (plan-19 owns location); per-project stats endpoint so growth is visible.
6. **Docs generated from schema.** Skills/docs that enumerate columns are generated (or CI-checked) against `PRAGMA table_info`.

## Test matrix

| Starting DB | Upgrade to | Required behavior |
|---|---|---|
| fresh | HEAD | all migrations, `foreign_key_check` empty, `integrity_check` ok |
| real fixtures at v7, v11, v21, v23, v32, v35, v41, v49 (captured from users) | HEAD | worker reaches `/api/readiness` ≤ 30 s; no `no such column`; `session_summaries` has `discovery_tokens` + `ON UPDATE CASCADE`; ledger contiguous or advisory |
| HEAD | older binary (13.11.0) | refuses to migrate/rebuild; exits with `schema_newer_than_binary`; DB unchanged |
| v49 with 10k FK orphans | HEAD | orphans re-parented; `foreign_key_check` empty |
| any | generator failure ×5 | rows `pending` with `retry_count` 1..3 then `failed`; retried on next pass |
| any | session complete with summarize in flight | summary written; no `Drained N orphaned pending messages` |
| any | 20 concurrent writers + `integrity_check` | zero `database is locked` 500s |
| 100 GB fixture (synthetic) | maintenance | reclaim runs, size drops, no lock storm |
| linux NFS-like `bavail > 2^31` | cleanup gate | free space computed positive; cleanup runs |

The matrix lives in CI (`tests/sqlite/migrations-upgrade-matrix.test.ts` over checked-in fixture DBs). A regression must fail CI before a user can file.

## Out of scope

Which binary gets to open the DB (plan-16). Observer output that fails to parse (plan-18). Project key derivation (plan-20; this plan only stores aliases). Chroma/vector store (plan-22).
