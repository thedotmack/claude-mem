# Worker-Native Cloud Sync — the database is the queue

**Date:** 2026-07-09
**Supersedes:** `plans/inbox/2026-07-08-cloud-sync-skill.md` (skill-managed standalone daemon — rejected: it babysits a process that shouldn't exist).

**Design in one paragraph:** Every memory row gets a `synced_at` column (NULL = not in the cloud). The worker — which already performs every write and is already kept alive by hooks — nudges a debounced flusher after each write. The flusher drains `WHERE synced_at IS NULL` in batches, POSTs to cmem.ai, and stamps rows on success. That single mechanism IS live sync, backfill, offline catch-up, and retry. No second process, no polling, no pid files, no JSON cursor files. Config is a token in settings.json like every other API key. The skill shrinks to: paste token → restart worker → show status.

**Wire contract (fixed — the cmem.ai server is already deployed):** POST `{observations,summaries,prompts}/batch` with camelCase row mappers, headers `Authorization: Bearer`, `X-User-Id`, `X-Device-Id`, `X-Device-Name`; server upserts on `(user_id, device_id, local_id)`; ≤2MB body, ≤200KB field clamps; `GET /pull?kind=&afterId=&limit=`. The reference implementation for all mappers/clamps is the vetted standalone client at `~/.claude-mem/cloud-sync.mjs` (source-reviewed 2026-07-08; verified live against production — 129,777 rows). **Port its `toCloud` mappers, `selectCols` prompt-clamp, and body-size batching verbatim; do not redesign the wire format.**

---

## Phase 0: Documentation Discovery (COMPLETE — verified file:line facts)

**Allowed APIs / copy sources:**

| Concern | Copy from | Evidence |
|---|---|---|
| Column migration | `ensureDiscoveryTokensColumn()` — `schema_versions`-gated + `PRAGMA table_info` guard + `ALTER TABLE ADD COLUMN` | `src/services/sqlite/SessionStore.ts:931–953` |
| Write-site hook shape | `dbManager.getChromaSync()?.syncObservation(...)` — fire-and-forget, optional-chained | `src/services/worker/agents/ResponseProcessor.ts:343` (obs), `:430` (summaries), `src/services/worker/http/routes/SessionRoutes.ts:587` (prompts) |
| Service accessor | `getChromaSync(): ChromaSync \| null` | `src/services/worker/DatabaseManager.ts:62` |
| Sibling service class | `ChromaSync` (constructor, per-write methods, `static backfillAllProjects`) | `src/services/sync/ChromaSync.ts:83,89,361,914` |
| Background wiring point | `WorkerService.initializeBackground()` — settings loaded at `:460`, Chroma gate `:504`, backfill `:604` | `src/services/worker-service.ts:452–622` |
| Settings keys | `SettingsDefaults` interface + `DEFAULTS`; Chroma remote group (`CLAUDE_MEM_CHROMA_HOST/PORT/API_KEY/...`) is the endpoint+credential precedent; file mode 0600 | `src/shared/SettingsDefaultsManager.ts:27–130, 133–236, 101–106, 9–25` |
| HTTP route | `LogsRoutes` extends `BaseRouteHandler`; late registration like SearchRoutes | `src/services/worker/http/routes/LogsRoutes.ts:70–137`, `src/services/worker-service.ts:528` |
| Tests | `bun test` over `tests/` (subdirs: `tests/sqlite/`, `tests/worker/...`) | root `package.json:99–105` |
| Skill authoring | auto-discovered from `plugin/skills/<name>/SKILL.md`; frontmatter `name/description/allowed-tools`; shipped verbatim by `scripts/sync-marketplace.cjs:126–167` | `plugin/skills/standup/SKILL.md` |
| Wire mappers to port | `KINDS[].toCloud`, prompts `selectCols` (SQL-side `substr(prompt_text,1,200000)` — 7MB prompts OOM node if clamped post-read), `MAX_BODY_BYTES`/`clampRow` | `~/.claude-mem/cloud-sync.mjs:132–281` |

**Anti-patterns (do NOT):** invent a `skills` key in plugin.json (auto-discovery); use `${CLAUDE_PLUGIN_ROOT}` (the real var is `${CLAUDE_SKILL_DIR}`, and this skill no longer bundles a script anyway); use `node:sqlite`/`better-sqlite3` (repo is `bun:sqlite`); block the write path on network I/O (Chroma calls are local-fast; cloud is not — nudge, don't await); edit CHANGELOG; add pm2/launchd anything; **mint a new device id when a legacy one exists** (server keys on device_id — a new id forks every cloud row into a duplicate).

---

## Phase 1: Schema — `synced_at`

**What:** One migration, copied from the `ensureDiscoveryTokensColumn` template (`SessionStore.ts:931–953`), next free `schema_versions` number (executor: `SELECT MAX(version) FROM schema_versions` first):

1. `ALTER TABLE observations ADD COLUMN synced_at INTEGER` — same for `session_summaries`, `user_prompts`. (NULL = unsynced; value = epoch ms of successful upload.)
2. Partial indexes so the drain query stays O(pending): `CREATE INDEX IF NOT EXISTS idx_<table>_unsynced ON <table>(id) WHERE synced_at IS NULL`.

**Legacy adoption (same migration, runs once):** if `~/.claude-mem/cloud-sync-state.json` exists (standalone client's state — format: `{deviceId, lastId, lastSummaryId, lastPromptId, ...}`):
- Stamp already-pushed rows: `UPDATE observations SET synced_at = <now> WHERE id <= lastId AND synced_at IS NULL` (and the two analogs). Skipping this is *safe* (server upserts) but re-uploads ~130k rows — stamp them.
- Leave the state file in place; Phase 2 adopts `deviceId` from it, and the skill (Phase 4) retires it.

**Verification:**
- [ ] `bun test tests/sqlite/` passes; new test: migration on a fixture DB adds columns idempotently (run twice), stamps rows ≤ cursor when a fixture state file is present, leaves rows > cursor NULL.
- [ ] `PRAGMA table_info(observations)` shows `synced_at`; `EXPLAIN QUERY PLAN SELECT id FROM observations WHERE synced_at IS NULL` uses the partial index.

**Anti-pattern guards:** don't touch existing columns or rebuild tables; don't stamp when no legacy state file exists.

## Phase 2: `CloudSync` service — the flusher

**What:** New `src/services/sync/CloudSync.ts`, structurally a sibling of `ChromaSync.ts`. Core:

- **Config** (new keys in `SettingsDefaultsManager` interface + DEFAULTS, mirroring the Chroma group at `:101–106`): `CLAUDE_MEM_CLOUD_SYNC_TOKEN` (default `''`), `CLAUDE_MEM_CLOUD_SYNC_USER_ID` (`''`), `CLAUDE_MEM_CLOUD_SYNC_URL` (`https://cmem.ai/api/pro/sync`), `CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID` (`''` — resolved at first start: adopt from legacy `cloud-sync-state.json` if present, else `randomUUID()`, then persisted back to settings), `CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME` (default `hostname()`). **Active ⇔ token AND user id are non-empty.** No separate enabled flag — credentials present = on, blank token = off.
- **`notify()`** — called by write sites; debounce ~1500ms trailing; coalesces write bursts into one flush.
- **`flush()`** — single-flight (skip if already running). Per kind: `SELECT ... WHERE synced_at IS NULL ORDER BY id LIMIT 200` (prompts use the ported SQL clamp), map with the ported `toCloud` mappers, pack into ≤2MB bodies, POST with `AbortSignal.timeout(30_000)` (**fixes the standalone client's no-timeout hang**), on 2xx stamp that batch: `UPDATE <table> SET synced_at = ? WHERE id IN (...)`. Loop until drained. On failure: log via the repo logger, leave rows NULL, retry on next notify + a capped exponential backoff timer (30s → 10min, `.unref()`).
- **`start()`** — kick one `flush()` (non-blocking). This IS backfill: a never-synced install simply has everything NULL.
- **`status()`** — `{configured, deviceId, pending: {observations, summaries, prompts}, lastFlushAt, lastError}` (pending = `COUNT(*) WHERE synced_at IS NULL`).
- **Testability:** constructor takes `fetchImpl = globalThis.fetch`.

**Wiring (3 + 2 lines):**
- `DatabaseManager`: hold instance + `getCloudSync(): CloudSync | null` accessor (copy `:62`).
- `initializeBackground()` (`worker-service.ts:452–622`): after settings load (`:460`), if active → construct + `start()`, near the Chroma gate (`:504`)/backfill (`:604`).
- Write sites — one line each, directly beside the existing Chroma calls: `dbManager.getCloudSync()?.notify()` at `ResponseProcessor.ts:343` area, `:430` area, `SessionRoutes.ts:587` area.

**Verification:**
- [ ] New `tests/worker/sync/cloud-sync.test.ts` (mock fetch): burst of notifies → exactly one flush; drain stamps rows and empties pending; failed POST leaves NULL + retries; body packing respects 2MB; prompt >200KB arrives clamped with the truncation marker; blank token → `start()` no-ops.
- [ ] Payload shape golden-test: mapper output for a fixture row deep-equals the standalone client's mapper output for the same row (guards the wire contract).
- [ ] Full `bun test` green.

**Anti-pattern guards:** never `await` sync in the write path; no new deps; don't log the token (log its length or last 4 chars only); don't re-push pulled/foreign rows (moot until Phase 5, but the drain query gains `AND origin_device_id IS NULL` then).

## Phase 3: Status endpoint

**What:** `GET /api/sync/status` → `cloudSync.status()` (plus `{configured: false}` when inactive). New `CloudSyncRoutes extends BaseRouteHandler` copied from `LogsRoutes.ts:70–137`; register in `initializeBackground()` after the service exists (SearchRoutes pattern, `worker-service.ts:528`).

**Verification:** [ ] `curl 127.0.0.1:<port>/api/sync/status` returns pending counts; unconfigured worker returns `configured: false`, not 500.

## Phase 4: The skill — thin front-end only

**What:** `plugin/skills/cloud-sync/SKILL.md` (auto-discovered; no bundled script). Frontmatter: `name: cloud-sync`, `allowed-tools: [Bash, Read, AskUserQuestion]`, description triggering on "set up cloud sync / sync my memories / cmem pro / cloud backup / sync status".

Runbook the skill encodes:
1. `GET /api/sync/status` (worker port from `~/.claude-mem/settings.json` → `CLAUDE_MEM_WORKER_PORT`).
2. **Configured** → report pending counts + last error, done.
3. **Not configured** → obtain credentials, in priority order: (a) legacy `~/.claude-mem/.cloud-sync.env` exists → read token/user-id from it, tell the user they're being migrated; (b) else ask the user to paste token + user id from **cmem.ai → Connect**. Write both into `~/.claude-mem/settings.json` (preserve 0600; never echo the token, never put it on a command line).
4. **Legacy daemon retirement:** if `~/.claude-mem/cloud-sync.pid` holds a live pid → kill it; then archive the standalone artifacts (`cloud-sync.mjs`, `.cloud-sync.env`, `cloud-sync.pid` → rename with `.retired` suffix; keep `cloud-sync-state.json` untouched — the Phase 1 migration and Phase 2 device-id adoption read it).
5. `POST /api/admin/restart`, then poll `/api/sync/status` until pending counts drain; report.
6. First-time setup only: one-line privacy note (sync uploads observation narratives + full prompt text to the user's cmem.ai account).

**Verification:**
- [ ] Fresh machine path: no legacy files, no config → prompts for credentials → status drains to 0.
- [ ] **This machine (live migration smoke):** legacy daemon running from 2026-07-08 → skill reads `.cloud-sync.env`, kills the daemon, worker adopts device id `ee1b7637-…` (verify in settings + status), pending ≈ 0 immediately (rows stamped by Phase 1 from cursors), a new observation lands in the cloud within seconds of the write — **no duplicate rows appear in the cmem.ai dashboard** (device-id continuity proof).
- [ ] `grep -rn "CLAUDE_PLUGIN_ROOT\|nohup\|\.pid" plugin/skills/cloud-sync/` → only the retirement step touches `.pid`.

## Phase 5 (ship separately): Pull — multi-device inbound

**What:** columns `origin_device_id TEXT`, `origin_local_id TEXT` on the three tables (+ `UNIQUE` partial index on the pair `WHERE origin_device_id IS NOT NULL` — replaces the standalone client's JSON "imported ledger"); worker pulls `GET /pull` per kind at startup and after each flush, inserting only rows from other devices (`INSERT OR IGNORE` against the unique index; skip `device_id IN (mine, 'legacy')`); push drain gains `AND origin_device_id IS NULL` so foreign rows never echo back up. Pull cursors (`pullAfter`) live in a small `sync_meta` KV table, not a file.

**Verification:** [ ] two-fixture-device test: device B's rows appear locally once (re-pull = no dupes), never re-uploaded under A's id.

## Phase 6: Docs + cleanup + E2E

1. `docs/public/cloud-sync.mdx` (model on `hosted-server.mdx`): what syncs, privacy note, `/cloud-sync` quick start, settings keys table, status endpoint, "no daemon — the worker syncs on write" architecture note. Register in `docs/public/docs.json` nav (Hosted Server group, lines 102–108). README pointer near `README.md:428`; don't touch i18n READMEs.
2. `npm run build-and-sync`; confirm worker restart clean, skill visible in marketplace + cache dirs.
3. E2E greps: no real token anywhere (`grep -rn "cm_pro_" — repo must be clean`); no `node:sqlite` in src; write sites show paired chroma+cloud one-liners.
4. Full `bun test` + live smoke (Phase 4's migration checklist) — then delete `plans/inbox/2026-07-08-cloud-sync-skill.md`'s obsolete sibling artifacts if any remain.

---

## Explicitly rejected (from the superseded plan)

- Bundled `cloud-sync.mjs` in the skill + `${CLAUDE_SKILL_DIR}` invocation — no script to bundle anymore.
- Dedicated `.cloud-sync.env` — settings.json, like every other credential (Chroma precedent).
- pid files / single-instance guards / nohup / reboot caveats — no process to guard.
- 10s local-DB polling — replaced by write-site nudges + startup drain.
- The standalone client remains what it always was: an out-of-repo utility served from cmem.ai for non-plugin users. This repo stops depending on it.
