# Phase 5: Two-Lane Multi-Device Sync (per-user Durable Object log)

**Date:** 2026-07-17
**Status:** Planned — Phase 0 discovery complete (three subagents, live docs + repo extraction)
**Decision record:** Four-architecture adversarial competition (HTTP-only / two-lane hybrid / socket-native / off-the-shelf engines) → verdict: **two-lane hybrid** — HTTP carries everything durable, WebSocket is a downstream-only advisory speed layer. All four advocates independently converged on the same storage core (per-user ordered log, monotonic seq, cursor resume, idempotent apply, rev for mutations, epoch guard), so the log is settled and only transport was ever in dispute. Off-the-shelf engines were rejected by their own advocate (ElectricSQL is read-path-only, Zero rejects offline writes, cr-sqlite dead 30 months). Hosting: Cloudflare Workers Paid + one SQLite-backed DO per user — validated $5/mo (100 users), ~$15 (1k), ~$230 (10k); dormant users cost ~$0.

**Prime directives inherited from the decision record:**
1. The mid-dev batch lane is NOT a floor. What survives is what four adversarial advocates independently kept: DB-as-queue outbox, fail-closed device identity, size clamps, debounced nudge. What dies: the Vercel per-kind endpoints, `toCloud` mappers' overwrite-upsert races, `stampGuardSql` machinery, the `live|backfill` lane heuristic.
2. Nothing durable ever rides the socket. HTTP cursor is the sole source of truth; the WS may be wrong, dropped, or disabled with zero data loss.
3. Session start always pulls immediately (the moment memory is injected is the latency budget's one hard spend).
4. Never long-poll a DO (a held request defeats hibernation ≈ $4/device/mo — same trap, different hat).
5. Cost guardrails are structural: watchdog → poll mode, never "stop working."

---

## Phase 0: Documentation Discovery — CONSOLIDATED FINDINGS

Three subagents completed 2026-07-17 (live Cloudflare docs via raw `<url>index.md`; repo extraction on branch `release/v13.11.0`; Bun/vitest tooling). Executors: do NOT re-research; copy from the anchors below. Full agent reports are in the session transcript; every claim below carries its source.

### 0.1 Allowed Cloudflare APIs (live-fetched; do not invent others)

| API | Exact form | Source |
|---|---|---|
| DO class | `import { DurableObject } from "cloudflare:workers"`; `class SyncHub extends DurableObject<Env>`; `constructor(ctx, env) { super(ctx, env) }` | durable-objects/api/base/ |
| Routing | `env.SYNC_HUB.getByName(userId)` (one-step; replaces idFromName+get). RPC for data endpoints; DO `fetch()` ONLY for the WS upgrade (`return stub.fetch(request)`) | best-practices/create-durable-object-stubs-and-send-requests/ |
| SQL | `this.ctx.storage.sql.exec(query, ...bindings)` → cursor with `.toArray()`, `.one()`, `.raw()`, `rowsRead/rowsWritten`. **Consume cursors synchronously — never across `await`.** No `BEGIN` via exec; use `ctx.storage.transactionSync(cb)` (sync callback). Schema init in constructor via `ctx.blockConcurrencyWhile()` | api/sqlite-storage-api/ |
| Hibernating WS | `this.ctx.acceptWebSocket(server, tags?)`; class methods `webSocketMessage(ws, msg)`, `webSocketClose(ws, code, reason, wasClean)`, `webSocketError(ws, err)`; `this.ctx.getWebSockets(tag?)`; `ws.serializeAttachment(obj)` (**16 KB max** — store keys, not state) / `deserializeAttachment()`; upgrade: `new WebSocketPair()` → `acceptWebSocket(server)` → `new Response(null, { status: 101, webSocket: client })` | best-practices/websockets/ + examples/websocket-hibernation-server/ |
| Keepalive | `this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"))` (≤2,048 chars each; answered without waking the DO). Protocol-level pings are auto-ponged by the runtime, also without waking | api/state/ + best-practices/websockets/ |
| Alarms | `await this.ctx.storage.setAlarm(msEpoch)` (one per DO; **each setAlarm = 1 billed row write**); handler `alarm(info?: {retryCount, isRetry})` — at-least-once, must be idempotent, must reschedule itself; **always `getAlarm()`-check before setting in the constructor** | api/alarms/ |
| Wrangler | Minimal keys `name`/`main`/`compatibility_date`. DO binding + either `migrations: [{tag:"v1", new_sqlite_classes:["SyncHub"]}]` (example-page flow) or the newer `exports: {"SyncHub": {type:"durable-object", storage:"sqlite"}}` — pick ONE flow. Scaffold: `npm create cloudflare@latest -- durable-object-starter` | reference/durable-objects-migrations/ + workers/wrangler/configuration/ |

**Hard limits that shape the design** (platform/limits pages): 10 GB SQLite per DO; **2 MB max row**; 100 KB max statement; **100 bound params per query** (chunk multi-row INSERTs at ≤ ~12 rows × 8 cols); 32 MiB max incoming WS message; 128 MB isolate memory (⇒ replay must paginate, never buffer 50 MB); ~1,000 req/s soft limit per DO; incoming WS messages billed 20:1, outgoing free.

### 0.2 Repo anchors (exact file:line, verified on this branch)

| Need | Anchor |
|---|---|
| Migration chain append point | `src/services/sqlite/SessionStore.ts:111` (last call in constructor chain; **claim v41** — v40 is highest) |
| Column-add migration template | `ensureSyncedAtColumns` SessionStore.ts:447-474 (PRAGMA check → ALTER → partial index → version row as bookkeeping) |
| Version-gated one-shot template | `requeuePromptCloudSyncAfterMapperFix` SessionStore.ts:488-500 |
| Mutation site (a): worktree remap | WorktreeAdoption.ts:210-215 (`merged_into_project` on observations + session_summaries, inside tx 224-225). **Opens its own DB connection (line 185) — cannot reach `notify()`; rev-bump must be pure SQL here** |
| Mutation site (b): cwd remap | ProcessManager.ts:312-314 (`project` on sdk_sessions/observations/session_summaries, tx 317-326). **Also its own connection (line 276)** |
| Mutation site (c): custom title | SessionStore.ts:1922-1927 (only writer of `custom_title`, inside `createSDKSession`) |
| Mutation site (d): prompt→session repair | `requeuePromptSync` SessionStore.ts:1492-1497; callers at 1481 (`updateMemorySessionId`) and 1526 (`ensureMemorySessionIdRegistered`) |
| Apply machinery | `storeObservations` SessionStore.ts:2060-2176 (tx, content-hash `ON CONFLICT ... DO NOTHING RETURNING id`, **`overrideTimestampEpoch` param exists** — use it to preserve remote `created_at_epoch`); `storeSummary` 2014-2058; `saveUserPrompt` 1940-1954 |
| FTS | Trigger-based — direct INSERTs auto-index. observations/summaries FTS + triggers: SessionSearch.ts:76-152; user_prompts FTS: SessionStore.ts:867-895. Gracefully absent without FTS5 |
| Chroma ingestion | `syncObservation` ChromaSync.ts:375-427, `syncSummary` 429-474, `syncUserPrompt` 492-530; fire-and-forget `.then().catch()` pattern at ResponseProcessor.ts:296-318 |
| Route class template | `CloudSyncRoutes` src/services/worker/http/routes/CloudSyncRoutes.ts:15-32; base is `src/services/worker/http/BaseRouteHandler.ts` (NOT under routes/); late registration at worker-service.ts:534 |
| Settings keys | Interface SettingsDefaultsManager.ts:67-73 + DEFAULTS 158-163; extend `CloudSyncSettingKeys` Pick at CloudSync.ts:184-190 |
| Timer idiom | `notify()` CloudSync.ts:297-313 (`.unref?.()` at 305); `scheduleRetry` 493-503; single-flight `flush` 320-349; `stopped` re-checks 399/413/418/434/442 |
| Service-class shape | `TranscriptWatcher` watcher.ts:86-111 (constructor/start/stop); startup kick site worker-service.ts:612 |
| Session-start pull hook | `SearchRoutes.handleContextInject` SearchRoutes.ts:278 — slot the pull between ~317 (dynamic import) and 332 (`generateContextWithStats`). Session-init: SessionRoutes.ts:385-562, existing nudge at 493 |
| Test harness | tests/worker/sync/cloud-sync.test.ts — `makeFetchMock` 24-40, `makeCloudSync` 59-73 (injected `fetchImpl`, fast debounce/backoff), stampGuard regression test 370-409. Runner: `bun test` (package.json:98) |
| Build caveat | build-hooks.js is entrypoint-based (new src/ code reached from `worker-service.ts` bundles automatically). **sync-marketplace.cjs:78 rsyncs the repo root — a new top-level `workers/` dir will be copied into the installed plugin unless added to the exclude list** |
| WS precedent | None in src/ (zero hits) — the client is greenfield; SSE + TranscriptWatcher are the nearest analogues |

### 0.3 Tooling facts (live-fetched)

- **Bun WS client supports auth headers natively** (Bun-specific extension): `new WebSocket(url, { headers: { Authorization, "X-Device-Id" } })`; also `ping()`, `pong()`, `terminate()`, `bufferedAmount`, `tls`, `proxy` options. Source: bun.com/docs/runtime/http/websockets + bun.com/reference/bun/WebSocketOptions. No `ws` npm dependency needed.
- **Verified keepalive pair:** Bun client sends protocol `ws.ping()` every 30–45 s → CF runtime auto-pongs **without waking the DO** (documented). Additionally set `setWebSocketAutoResponse("ping","pong")` for future browser clients (browsers can't send protocol pings). GAP flagged by discovery: Bun's *auto-pong to server pings* is unverified in docs — irrelevant here because the client initiates.
- **Testing (2026 shape — training-data snippets are stale):** `@cloudflare/vitest-pool-workers` ≥0.18 uses a Vite plugin: `plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })]` with **Vitest ≥4.1** (`defineWorkersConfig` was removed in v0.13). Test APIs from `"cloudflare:test"`: `runInDurableObject(stub, (instance, state) => ...)`, `runDurableObjectAlarm(stub)`, `evictDurableObject(stub, { webSockets: "hibernate" })`. **Known issue: WS + DO tests require `--max-workers=1 --no-isolate`** — keep WS tests in a separate vitest invocation. `wrangler dev` serves `ws://localhost:8787` locally (SQLite DOs do NOT work with `--remote`).
- **Lint guards:** ESLint flat config `no-restricted-globals` (setTimeout/setInterval) + `no-restricted-syntax` (selector `CallExpression[callee.property.name='accept']`, bare `fetch(`) scoped to the DO source glob — PLUS a dumb `grep -rn` CI step (catches `globalThis.setTimeout` evasion).

### 0.4 Anti-pattern list (verified against live docs — these are the $4.11/user/mo + $34k traps)

1. `server.accept()` + `addEventListener` (legacy WS API) — defeats hibernation. Only `ctx.acceptWebSocket()` + class handler methods.
2. `setTimeout`/`setInterval` anywhere in the DO — pins it awake. Alarms only, and only when there's work.
3. **No outbound I/O from the DO — at all.** June 19 2026 change: outbound `connect()`/WebSocket pins the DO up to 15 min per connection; awaited outbound `fetch()` blocks idling. Token verification, upstream calls, everything happens in the stateless Worker in front.
4. `setAlarm()` in the constructor without a `getAlarm()` check — the documented footgun behind the $34k runaway.
5. In-memory maps as socket state — lost on hibernation. Attachments (≤16 KB) hold keys; SQLite holds state; constructor rebuilds from `getWebSockets()`.
6. Buffering a full replay in memory (128 MB isolate) — paginate `/changes`, chunk WS pushes.
7. Long-poll / held HTTP requests on the DO — same as #2 economically.

---

## Phase 1: The Sync Hub (Worker + per-user DO, HTTP lanes only)

**Goal:** greenfield `workers/sync-hub/` wrangler project — per-user ordered log + two HTTP endpoints. No sockets in this phase.

**Tasks:**
1. Scaffold with `npm create cloudflare@latest -- durable-object-starter` into `workers/sync-hub/` (own package.json; NOT reached by build-hooks.js — that's correct, it deploys via wrangler, not the plugin bundle). **Add `workers/` to the sync-marketplace.cjs exclude list (sync-marketplace.cjs:78)** so the installed plugin doesn't ship it.
2. `wrangler.jsonc`: copy the hibernation-example config shape (Phase 0.1 wrangler row) — binding `SYNC_HUB` → class `SyncHub`, `migrations: [{tag:"v1", new_sqlite_classes:["SyncHub"]}]`, `compatibility_date` current.
3. `SyncHub extends DurableObject<Env>`: schema init in constructor via `blockConcurrencyWhile` (copy shape from sqlite-storage-api "SQL API" section):
   ```sql
   CREATE TABLE IF NOT EXISTS ops (
     seq           INTEGER PRIMARY KEY AUTOINCREMENT,
     kind          TEXT NOT NULL,            -- 'observation'|'summary'|'prompt'|'mutation'
     origin_device TEXT NOT NULL,
     origin_id     TEXT NOT NULL,            -- device-local rowid; op UUID for mutations
     rev           INTEGER NOT NULL DEFAULT 1,
     body          TEXT NOT NULL,            -- canonical row JSON (opaque-able later for E2E)
     server_ts     INTEGER NOT NULL
   );
   CREATE UNIQUE INDEX IF NOT EXISTS ops_entity ON ops(origin_device, kind, origin_id, rev);
   CREATE TABLE IF NOT EXISTS devices (device_id TEXT PRIMARY KEY, name TEXT, last_ack_seq INTEGER DEFAULT 0, last_seen INTEGER);
   CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);  -- epoch, counters
   ```
4. RPC methods (not fetch — Phase 0.1 routing row): `pushOps(deviceId, ops[]) → {acked:[{origin_id, rev, seq}], head_seq}` (idempotent via the unique index — duplicate push returns the existing seq; INSERTs chunked ≤100 bound params; per-row body ≤2 MB enforced with the client-side clamp as backstop) and `getChanges(sinceSeq, limit≤500) → {epoch, ops[], head_seq, more}` (cursor `.toArray()` consumed synchronously — Phase 0.1 SQL row).
5. Stateless Worker in front: parses `Authorization: Bearer` + `X-User-Id` + `X-Device-Id` (same headers as today — CloudSync.ts:448-466), verifies the token, routes `env.SYNC_HUB.getByName(userId)`. **Token verification lives here, never in the DO** (anti-pattern #3): call cmem.ai's verify endpoint and cache the verdict in Workers KV with a short TTL. Routes: `POST /v1/sync/ops`, `GET /v1/sync/changes`, `GET /v1/sync/status`.
6. Mutation ops (Phase 3 writes them; hub must accept them now): `kind='mutation'`, body `{op: 'set_title'|'set_prompt_session'|'remap_project', target|where, fields}`. Predicate sanity cap: refuse `remap_project` ops from a device if the hub can't parse them — validation only; application happens client-side.
7. Compaction alarm (daily): delete ops superseded by a higher rev of the same entity below `MIN(devices.last_ack_seq)`. Copy the alarm scheduler shape from api/alarms/ "Example"; **`getAlarm()`-check first** (anti-pattern #4); handler idempotent and self-rescheduling.

**Verification:**
- Vitest per Phase 0.3: `runInDurableObject` tests — push idempotency (same op twice → same seq), cursor pagination (600 ops → 2 pages), rev supersession, chunked-insert correctness at 100-param boundary, alarm via `runDurableObjectAlarm`.
- `wrangler dev` + `curl localhost:8787/v1/sync/ops` / `/changes` round-trip.
- Greps: `grep -rn "setTimeout\|setInterval\|\.accept()\|fetch(" workers/sync-hub/src/do/` → only allowed hits (none).

**Anti-pattern guards:** items 2/3/4/6/7 of Phase 0.4; ESLint flat-config block from Phase 0.3 committed with the scaffold.

---

## Phase 2: Client schema + apply path (migration v41)

**Goal:** local SQLite learns origins, revisions, and a cursor; incoming remote ops apply through the same hooks native writes use.

**Tasks:**
1. Migration v41 — copy `ensureSyncedAtColumns` (SessionStore.ts:447-474) shape; append call after line 111. Adds to observations/session_summaries/user_prompts: `origin_device_id TEXT`, `origin_local_id TEXT`, `sync_rev INTEGER DEFAULT 1`; unique index `(origin_device_id, kind-implicit-per-table, origin_local_id)` where origin is non-null; new table `sync_state (k TEXT PRIMARY KEY, v TEXT)` holding `cursor` and `epoch`. Native rows: origin columns NULL (self).
2. `SyncApply` module: `applyOps(ops[])` in one transaction — remote row ops upsert via INSERT keyed on origin identity, **pre-stamped `synced_at = now`** (echo guard: the push drain's `WHERE synced_at IS NULL` structurally cannot re-push them), `overrideTimestampEpoch` preserved from `body.createdAtEpoch`; mutation ops apply as UPDATEs matched on origin identity (or the remap predicate), guarded `incoming.rev >= local.sync_rev`; **cursor advanced in the same transaction** (crash-safe exactly-once). Skip ops where `origin_device == self`. FTS updates via existing triggers automatically (Phase 0.2 FTS row); Chroma via the fire-and-forget pattern (ResponseProcessor.ts:296-318 shape) after commit.
3. Epoch guard: `getChanges` epoch ≠ stored epoch → reset cursor to 0, re-pull (idempotent by design).

**Verification:** `bun test` — new tests copying the cloud-sync.test.ts harness (in-temp-dir SessionStore): apply idempotency (same batch twice → identical DB), cursor-with-rows atomicity (throw mid-batch → cursor unmoved), echo guard (applied rows never selected by the drain query), rev guard (stale mutation ignored), FTS row present after apply (when FTS5 available).

**Anti-pattern guards:** no `Date.now()` as row identity; never apply with `synced_at` NULL; no schema change without the PRAGMA-check pattern.

---

## Phase 3: Push retarget + pull loop + rev bumps (ships the complete highway at poll latency)

**Tasks:**
1. Retarget the existing drain: keep `notify()`/debounce/single-flight/backoff/clamps/device-identity (CloudSync.ts:276-313, 320-349, 493-511, 529-594 survive), replace the three per-kind `pushBatch` targets with one `POST /v1/sync/ops` carrying `{kind, origin_id: String(localId), rev: sync_rev, body}` per row. **Delete:** `KINDS[*].toCloud` per-kind endpoints, `stampGuardSql`/`stampGuard` (SessionStore's `requeuePromptSync` now emits a `set_prompt_session` mutation op instead — ordering makes the guard unnecessary), the `lane` heuristic (392-393). Stamp `synced_at` on ack.
2. Rev bumps at the four mutation sites (Phase 0.2 anchors): custom title (SessionStore.ts:1922-1927) and prompt repair (1492-1497) run inside the worker — bump `sync_rev`, null `synced_at`, enqueue the mutation op, `notify()`. The two remap sites (WorktreeAdoption.ts:210-215, ProcessManager.ts:312-314) **open their own DB connections** — pure SQL there: bump + null in the same statements; the worker's next startup drain (worker-service.ts:612) or next `notify()` picks them up.
3. Pull loop in a `SyncClient` service (TranscriptWatcher shape, watcher.ts:86-111): poll `GET /v1/sync/changes` — 30 s while a session is active, 5 min idle, suspend after 1 h of no sessions; every push response piggybacks `head_seq` (free poll for the active device). `.unref?.()` on every timer (CloudSync.ts:305 idiom). Start beside the cloud-sync kick at worker-service.ts:612.
4. Immediate session-start pull: in `SearchRoutes.handleContextInject` (SearchRoutes.ts:278), before `generateContextWithStats` (~line 332), `await syncClient.pullOnce({ timeoutMs: 1500 })` — bounded so a dead network can't stall context injection.
5. Cutover: version-gated migration (copy requeuePromptCloudSyncAfterMapperFix shape) — when settings point at the new hub, re-null `synced_at` on all rows once; every device re-pushes its own corpus and the hub's unique index dedupes. New settings key `CLAUDE_MEM_CLOUD_SYNC_HUB_URL` (pattern: SettingsDefaultsManager.ts:67-73 + 158-163 + the Pick at CloudSync.ts:184-190). **Open decision:** rows whose origin device is dead exist only in the old cmem.ai store — accept loss, or one-time server-side import into the hub (recommended: import, as a cmem.ai-side script; out of this repo's scope).

**Verification:** two SessionStores + one real `wrangler dev` hub (or the vitest SELF binding): write on A → flush → pull on B → row present with preserved epoch, FTS row exists, no echo (A's drain empty after B applies); title/remap/repair mutations converge on B; kill hub mid-flush → rows stay queued → recover on restart (backoff test shape from cloud-sync.test.ts:370-409). Full suite: `bun test` green; `npm run build-and-sync` boots the worker.

**Anti-pattern guards:** directive #4 (no long-poll — plain short polls only); pull failures must never block writes (same swallow-everything contract as `notify()`, CloudSync.ts:307-312).

---

## Phase 4: Advisory WebSocket (the speed layer)

**Tasks:**
1. Hub: `GET /v1/sync/ws` upgrade through the Worker → DO `fetch()` (the one non-RPC path). Copy the hibernation example verbatim (Phase 0.1 WS row): `WebSocketPair` → `ctx.acceptWebSocket(server)` → 101; `serializeAttachment({device_id})` only; `setWebSocketAutoResponse("ping","pong")`. On committed push: fan out `{type:'op', seq, ...}` frames to all sockets except the origin device (batch 50–100 ms per best-practices), or a bare `{type:'advance', head_seq}` when a push exceeds one page.
2. Client: Bun `new WebSocket(url, { headers })` (Phase 0.3) inside SyncClient. Socket is ADVISORY: on `op`/`advance` frames where `seq == cursor+1` apply directly, else — or on any parse anomaly — close and run one HTTP `pullOnce()` (the lane-2 self-heal). Protocol `ws.ping()` every 40 s; reconnect with full-jitter backoff (1 s base, 60 s cap); connected ⇒ poll interval stretches to the idle tier.
3. Debounce drops 1500 ms → 250 ms when the socket is live (fan-out is now push; debounce dominates latency).

**Verification:** vitest WS suite (separate invocation, `--max-workers=1 --no-isolate` — Phase 0.3 known issue): upgrade, fan-out excludes origin, `evictDurableObject({webSockets:"hibernate"})` then message → attachment-restored delivery; e2e on `wrangler dev`: two Bun clients, write on A → B applies < 2 s; kill B's socket mid-stream → B converges via HTTP on reconnect.

**Anti-pattern guards:** the full Phase 0.4 list is now live — ESLint block + CI grep land in the same PR as the first socket code. The socket handler contains no storage-independent state, no timers, no outbound I/O, and nothing whose failure loses data (delete the socket path entirely and Phase 3 still passes — that's the acceptance test of "advisory").

---

## Phase 5: Guardrails + monitoring (first-class, not afterthought)

**Tasks:**
1. Watchdog: scheduled Worker (cron, hourly) querying the GraphQL Analytics API for the DO namespace — duration GB-s (expected ≈ 0; the hibernation-defeat detector), rows read/written (the runaway detector), request count (~messages/20). Thresholds from the validated workload model; alert via the existing Discord webhook rails (`scripts/discord-release-notify.js` pattern, creds in `~/Scripts/claude-mem/.env`).
2. Kill switch: KV flag checked by the front Worker — tripped ⇒ refuse WS upgrades + `X-Sync-Mode: poll` on HTTP responses; clients fall back to Phase 3 polling (product stays complete, ~$0.03/user/mo indefinitely).
3. Canary: one synthetic user, two fake devices, trickle writes 24/7; its DO's duration metric is a known constant — a hibernation regression shows within hours, not on the invoice.
4. CI: the ESLint block + `grep -rn "setTimeout\|setInterval\|\.accept()\|fetch(\|connect(" workers/sync-hub/src/do/` as a required check; weekly invoice-glance scheduled agent (Discord ping only on delta).

**Verification:** trip each threshold artificially (canary flood; forced non-hibernating build on a test account) and confirm alert + kill-switch + client fallback end-to-end.

---

## Phase 6: Final verification + horizon

1. Full-matrix e2e: fresh device bootstrap (`since=0`), week-offline catch-up, concurrent two-device writes, all four mutation types, epoch reset, kill-switch degradation — all on `wrangler dev` + two real worker daemons.
2. Anti-pattern sweep: the Phase 0.4 greps across `workers/`; `bun test` full suite; `npm run build-and-sync`; confirm the marketplace rsync excludes `workers/` (inspect `~/.claude/plugins/marketplaces/thedotmack/` after sync).
3. Documentation: update `docs/public/` cloud-sync pages (Mintlify auto-deploys from main).
4. Horizon (explicitly out of scope, recorded so nobody re-litigates): dashboard as a `/changes` client; E2E encryption (bodies become opaque blobs — the hub never parses `body` except mutation envelopes); team corpora (corpus-keyed DO, per-member `last_ack_seq`); Electric read-path adoption ONLY if Postgres ever lands server-side.

---

## Open decisions for the maintainer

1. **Dead-device history import** (Phase 3.5): accept loss vs. one-time cmem.ai-side import script. Recommendation: import.
2. **Old lane during rollout**: hard cutover via `CLAUDE_MEM_CLOUD_SYNC_HUB_URL` (recommended — the re-push migration rebuilds the log) vs. temporary dual-push. Dual-push doubles write cost for no correctness gain.
3. **Wrangler config flow**: `migrations` (matches all current example pages) vs. `exports` (the declared successor). Recommendation: `exports` on the fresh scaffold; it's the forward path and this project has no legacy namespaces.
