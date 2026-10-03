# Liveness over deadlines

**Date:** 2026-10-03 · **Branch:** `feat/liveness-over-deadlines` (from `origin/main` a1951f2ad)

## Why

claude-mem has ~238 guessed deadlines (`setTimeout` / `AbortSignal.timeout` / `*_TIMEOUT`). A single
deadline measures two different things at once — *is the other side alive?* and *how long should the
work take?* — so every value is a guess: too short kills real work (and re-bills it), too long blocks
on a dead peer. The fix, borrowed from the xAI SDK's "secret stream", is to separate the two:

- **Liveness** comes from a signal (headers, heartbeat bytes, progress events, a file on disk).
- **Deadlines** become *idle* timeouts ("no sign of life for N s"), or disappear because nobody waits.

Second driver (xAI report, "never pay twice"): only retry a paid request when it is known the work
did not happen. claude-mem currently resends paid LLM calls in ≥7 places (D1–D10 below).

Third driver (user decision 2026-10-03): **cloud sync is rebuilt on Supabase for everything** — op log,
content, pgvector, Realtime, auth. Turbopuffer, the Neon sync log, the Fly `sync-api` and the
cmem.ai projector hop are retired. "Projection" stops existing: a push writes ops and searchable rows
in one transaction.

## Execution order

| Track | Phases | Ships as |
|---|---|---|
| A — local liveness + never-pay-twice | 1–7 | claude-mem PR #1 |
| B — Supabase cloud sync | 8–12 | Supabase migrations + Edge Function, claude-mem PR #2, Pro PR |
| Final | 13 | verification, `/babysit`, `/version-bump` |

Track A and Track B are independent; run A first (smaller, fully in-repo).

---

## Phase 0 — Documentation discovery (DONE, consolidated)

### Allowed APIs / facts (cite before use)

**Runtimes.** Hooks + worker run under **Bun** (`plugin/scripts/bun-runner.js`); MCP server and npx-cli run
under **Node** (`plugin/.mcp.json`, `scripts/build-hooks.js:689-695`). Bundles are esbuild `platform:'node'`.
Use only WHATWG stream APIs (`response.body.getReader()`, `AbortController`, `AbortSignal.any`) — no Node streams.

**Worker HTTP.** Express 5 on `node:http` under Bun (`src/services/server/Server.ts:190-213`). No server
timeouts set anywhere. Existing SSE: `ViewerRoutes.ts:157` route `/stream`, handler `handleSSEStream`
(`ViewerRoutes.ts:220-262`), broadcaster `src/services/worker/SSEBroadcaster.ts` (no heartbeat today).
Init gate allowlist: `worker-service.ts:441-464` (`/health`, `/readiness`, `/version`, …).

**Worker init.** `WorkerService.start()` (`worker-service.ts:519`) → fire-and-forget `initializeBackground()`
(`:607-860`). Only signal: `initializationCompleteFlag` + `resolveInitialization()` (`:757-759`). Failure
path at `:857-859` only logs — flag stays false forever (this is the "wedged" state). Chroma prewarm runs
*after* ready (`:828`), so the comment at `worker-utils.ts:65-66` blaming prewarm is stale.

**Hook→worker.** `executeWithWorkerFallback` (`src/shared/worker-utils.ts:1611-1709`), `workerHttpRequest`
(`:341-366`), `fetchWithTimeout` (`:161-175`, rewrites TimeoutError to
`"Request timed out after ${ms}ms"` — matched by regex at `server-client.ts:419`, `worker-utils.ts:1441`,
`npx-cli/utils/prune-cache.ts:218`; **keep that wording**). Readiness: `waitForWorkerReadiness` (`:588`),
`ensureWorkerRunning` (`:753`, wedged branch `:821-846`), `ensureWorkerReadyWithin` (`:1152`).
`WEDGED_WORKER_UPTIME_S` from `hook-constants.ts:27-38`.

**Write hooks (spoolable):** observation (`POST /api/sessions/observations`), file-edit (same route),
summarize (`POST /api/sessions/summarize`), advisor-calls (`POST /api/advisor-calls`), session-end
(`POST /api/sessions/session-end`). None use the response body. **Not spoolable:** session-init (uses
`sessionDbId`, private skip), user-message (a read), context/file-context/semantic (reads).

**Worker ingest functions:** `ingestObservation(payload)` exported from `src/services/worker/http/shared.ts:118-275`
(already called directly by `transcripts/processor.ts:411`). Summarize/session-end logic is private in
`SessionRoutes.ts` (`handleSummarizeByClaudeId :700-767`, `handleSessionEnd :769-782`) — must be extracted.
Advisor: `AdvisorRoutes.handleIngestAdvisorCalls` (`AdvisorRoutes.ts:73`) → `store.recordAdvisorCall`.

**Spool precedent to COPY:** `src/shared/deferred-session-end.ts` (`DeferredSessionEndQueue`: one file per
entry via `writeJsonFileAtomic`, `drain(accept)` unlinks accepted) and its worker drain
`drainDeferredSessionEndQueue` / `startDeferredSessionEndReplay` (`worker-service.ts:377-410`, boot drain at
`:655-656`). Data dir: `resolveDataDir()` (`src/shared/paths.ts:21-42`) — call at use time, not import time.
Atomic write: `writeJsonFileAtomic` (`src/shared/atomic-json.ts`).

**Ordering constraint.** `SessionMessageBuffer` is in-memory and durable replay was removed on purpose
(duplicate observations, `SessionMessageBuffer.ts:20-40`). Spool must dedupe by deterministic key, not replay blindly.
Summarize returns `unknown_session` if init hasn't landed → drain must keep an entry whose session is unknown (as
`drainDeferredSessionEndQueue` does: return false = keep).

**Context render.** Hook: `src/cli/handlers/context.ts:91-141`. Worker: `SearchRoutes.handleContextInject`
(`SearchRoutes.ts:302-418`) → `generateContextWithStats` (`ContextBuilder.ts:551-577`). Volatile bits:
header timestamp (`formatHeaderDateTime`, `timeline-formatting.ts:104`), work-state "updated N ago"
(`WorkStateRenderer.ts:58-60`), observer/sync health banner (`ContextBuilder.ts:240-268`, measured inside
the budget fit `:363-409`), `syncClient.pullOnce({timeoutMs:1500})` on every inject (`SearchRoutes.ts:375-380`).
Write points to invalidate: `SessionStore.storeObservations :3650`, `storeSummary :3600`,
`appendWorkStateEntry :2989`, `importObservation :4319`, `importSessionSummary :4256`, `DataRoutes` deletes/merge,
`SyncApply.apply*` (`SyncApply.ts:898-1274`). Project keys: `getProjectContext(cwd).allProjects`
(`src/utils/project-name.ts:358`), primary = last element.

**LLM retry.** `withRetry` (`src/services/worker/retry.ts`): `maxRetries:2` (`:156-160`), unclassified ⇒
transient (`:164-167`), per-attempt deadline `DEFAULT_LLM_TIMEOUT_MS=180_000`
(`SettingsDefaultsManager.ts:66`, `retry.ts:203-233`), no cap on `retryAfterMs` (`:245-246`), 100ms 429 base
(`:173-176`). Classifiers: `OpenRouterProvider.ts:267-304`, `OpenAICompatProvider.ts:298-319`,
`GeminiProvider.ts:121-132`, `CodexProvider.ts:95-200`, server `providers/shared/error-classification.ts:118-169`.
Deadline → `transport:deadline_exceeded` (`OpenAICompatibleProvider.ts:687-690`) → `scheduleTransportResume`
(`GeneratorExitHandler.ts:90-104`), resumes unbounded off-gateway (`SessionManager.ts:29-37`).
`x-claude-mem-prior-request-id` sent at `OpenRouterProvider.ts:756`, `GeminiProvider.ts:382`, read by nothing in repo.
All HTTP providers force `stream:false` (`OpenRouterProvider.ts:479`); SSE parsing already exists near
`OpenRouterProvider.ts:476`.

**Corpus.** `callWorker` (`src/servers/mcp-server.ts:82-130`, 30s default) → `CorpusRoutes.ts:97-231`
(single `res.json()` at end, no `res.on('close')`). `KnowledgeAgent.isSessionResumeError`
(`KnowledgeAgent.ts:124-127`) regex `/session|resume|expired|invalid.*session|not found/i` → re-prime on almost any error.

### Anti-patterns (apply to every phase)
- Do **not** invent Express/Bun APIs; SSE = `res.setHeader` + `res.write('event: …\ndata: …\n\n')` exactly like `handleSSEStream`.
- Do **not** reintroduce a durable replay of `SessionMessageBuffer`; spool entries are keyed + deduped.
- Do **not** add try/catch that swallows; every caught error is logged with context and rethrown or turned into an explicit state.
- Do **not** treat `x-client-request-id`/attempt ids as server-side idempotency — they are tracing only.
- Do **not** retry a paid POST after any response bytes arrived.
- Do **not** add new fixed deadlines to replace old ones; use idle timeouts + liveness signals, and keep one absolute safety cap only where a host imposes one (Claude Code hook caps).

---

## Phase 1 — Never pay twice: retry rules + one budget per batch

**What.** Rewrite retry decisions in `src/services/worker/retry.ts` to the xAI rule table (report Part 7):

| Outcome | Retry in-loop? |
|---|---|
| 429 / our own pre-send refusals (rejected before work) | yes, Retry-After capped at 60 s; no Retry-After ⇒ 1 s→30 s backoff; jitter ×(0.5–1) |
| network error before any response, 5xx on non-stream POST (ambiguous) | **no** — return a typed `ambiguous` error; session transport pause decides, counted against the batch budget |
| response received then body read/parse failed, 200-with-embedded-error (litellm) | **never** — output failure |
| unclassified | **no** (flip `retry.ts:164-167`) |

- Add `PaidSendBudget` per claimed batch (default 2 paid sends total), consumed by `withRetry`, `scheduleTransportResume`
  (`GeneratorExitHandler.ts:90-104`), stall resumes (`response-pacer.ts`), and Codex `maxRetries`. Exhausted ⇒ park the
  batch with an explicit logged state (no silent drop).
- Codex: "completed without a final agent message" and malformed structured output after a completed turn ⇒ non-retryable
  (`CodexProvider.ts:118-122`).
- Delete `x-claude-mem-prior-request-id` headers and the `retry.ts:8-9` dedup claim; add a per-batch `clientAttemptId`
  (UUID) sent as `x-client-request-id`, logged with usage/errors, carried on `ClassifiedProviderError`
  (`provider-errors.ts:43,59`) and shown by `describeProviderError` (`:118-120`).
- Cap error-body reads at 64 KiB (`OpenRouterProvider.ts:814` and peers).

**Docs.** xAI report Part 7 table; `retry.ts` whole file; `provider-errors.ts`.
**Verify.** New `tests/worker/retry-never-pay-twice.test.ts`: one case per table row asserting exact fetch-call counts;
budget shared across withRetry + transport resume; `grep -rn "prior-request-id" src` ⇒ 0. Existing provider tests green.
**Guards.** No retry after `response.ok` observed. No new settings keys beyond the budget size.

## Phase 2 — Shared SSE reader + idle-timeout fetch + test harness

**What.**
- `src/shared/sse-reader.ts`: ~100 lines, xAI Part 5 Step 4 rules — CR/LF/CRLF, `:` comment lines count as liveness and are
  otherwise ignored, 1 MiB per-event cap, yields `{event, data}`; stream end without terminal event ⇒ throws `StreamEndedEarlyError`.
- `fetchWithIdleTimeout(url, init, { idleTimeoutMs, absoluteCapMs })` next to `fetchWithTimeout` (`worker-utils.ts:161`):
  timer arms before headers, resets on headers and on every body chunk; owns the body read and returns text or an
  async-iterable of chunks (never a bare `Response`, because the idle timer must cover the body). On expiry throws
  `Error("Request timed out after ${idleTimeoutMs}ms idle")` — keep the "timed out" wording for existing regexes.
- `workerHttpRequest` gains `idleTimeoutMs` option.
- Test harness `tests/helpers/stream-fetch-mock.ts`: mock fetch honouring abort, scripted streams (hang before headers,
  hang mid-body, fail before/after first byte, `:` pings); fake-timer assertion helper "N polls then zero live timers" (xAI Part 18).

**Verify.** `tests/shared/sse-reader.test.ts`, `tests/shared/fetch-idle-timeout.test.ts` (ping keeps alive past idle window;
silence trips; absolute cap trips). Typecheck clean.
**Guards.** No Node `stream` imports. Do not change `fetchWithTimeout` semantics.

## Phase 3 — Provider "secret stream" (remove the 180 s abandon-and-resend)

**What.** OpenRouter + OpenAI-compatible providers send `stream: true` internally (`OpenRouterProvider.ts:479` and the
OpenAICompat request builder), read via Phase 2 `sse-reader` + `fetchWithIdleTimeout` (idle 90 s default, absolute cap
= existing `MAX_LLM_TIMEOUT_MS` 300 s, `retry.ts:65`), assemble the final text, take `usage` from the final chunk
(request `stream_options: {include_usage: true}`). Keep the public provider return shape unchanged.
`retryBeforeOutput`: one retry allowed only if the stream fails before the first content delta, charged to the Phase 1 budget.
Gemini: leave non-streaming in this phase (different endpoint), but it gets Phase 1 rules.
Remove `transport:deadline_exceeded` resend for streaming providers: idle expiry is now an `ambiguous` outcome under Phase 1.

**Docs.** Existing SSE handling near `OpenRouterProvider.ts:476`; xAI Part 6.
**Verify.** Provider tests with harness: slow-but-alive stream (pings for 400 s) succeeds; silent 91 s trips once and is not
resent in-loop; usage captured. Grep `stream: false` in those providers ⇒ 0.
**Guards.** No change to prompt content or parsing of the assembled text.

## Phase 4 — `GET /api/ready` progress stream; delete the wedged heuristic

**What.**
- `WorkerService` gets an `initPhase` state: `starting → db_ready → routes_ready → ready | failed{message}`. Set at the existing
  steps in `initializeBackground()` (`worker-service.ts:649` db, `:727-755` routes, `:757-759` ready). The catch at `:857-859`
  sets `failed` (explicit state) in addition to logging.
- `Server.ts` `setupCoreRoutes`: `GET /api/ready` SSE (copy `handleSSEStream` headers). Emits current phase immediately, every
  transition, a `: ping` comment every 5 s, and **ends** after `ready` or `failed`. Add `/ready` to the init-gate allowlist
  (`worker-service.ts:441-464`). `/api/health` and `/api/readiness` stay unchanged for old clients.
- Hooks/CLI: replace `waitForWorkerReadiness` polling (`worker-utils.ts:588`) and the `ensureWorkerReadyWithin` probe loop
  (`:1152`) with one `/api/ready` read using `fetchWithIdleTimeout` (idle 5 s, absolute cap = the hook's existing budget).
  `failed` ⇒ recycle immediately; idle expiry ⇒ wedged ⇒ recycle. Delete the uptime-based wedged branch (`:821-846`) and
  `WEDGED_WORKER_UPTIME_S` usage there (keep `port-reclaim.ts` pid-age guard — separate concern).
- Fix stale comment `worker-utils.ts:65-66`.

**Verify.** `tests/server/ready-stream.test.ts` (phases in order, ping cadence, terminal close, failed path).
`tests/shared/worker-utils-ready-stream.test.ts` (failed ⇒ recycle; silence ⇒ recycle; ready ⇒ proceed). Existing
`worker-utils-*` tests updated, `server.test.ts` health/readiness unchanged.
**Guards.** Stream must always terminate; never treat close-without-terminal as ready.

## Phase 5 — Spool-file write hooks

**What.**
- `src/shared/hook-spool.ts`, copied from `DeferredSessionEndQueue` shape: `enqueue(kind, payload)` writes one file per event
  into `<resolveDataDir()>/state/hook-spool/` via `writeJsonFileAtomic`. Filename = `<monotonicMs>-<deterministicKey>.json`
  where key = `tool_use_id` when present, else sha256 of `(kind, contentSessionId, canonical payload)`. Re-enqueue of the same
  event overwrites → harmless. `drain(accept)` reads sorted by filename, unlinks on accept, keeps on `false`.
- Kinds: `observation`, `file_edit`, `summarize`, `session_end`, `advisor_calls`.
- Handlers `observation.ts`, `file-edit.ts`, `summarize.ts` (both calls), `session-end.ts`: enqueue, then fire a
  non-awaited nudge `POST /api/spool/nudge` with a 250 ms timeout (best effort, result ignored), exit. No readiness wait, no
  worker spawn on these paths if the nudge fails — worker autostart stays on session-init/context, which already spawn.
  `session-end` drops `enqueueDeferredSessionEnd` (the spool replaces it); delete `deferred-session-end.ts` and its replay once
  the spool drain is live, migrating any leftover files on boot.
- Worker: extract `ingestSummarize(payload)` and `ingestSessionEnd(payload)` from `SessionRoutes` into
  `src/services/worker/http/shared.ts` next to `ingestObservation`; routes call them (behaviour unchanged).
  `drainHookSpool()` maps kind → `ingestObservation` / `ingestSummarize` / `ingestSessionEnd` / `store.recordAdvisorCall`;
  `unknown_session` ⇒ keep. Run at boot right after `dbManager.initialize()` (where the deferred drain runs today), on
  `/api/spool/nudge`, and on an `fs.watch` of the spool dir (copy the watch pattern from `FileTailer`,
  `transcripts/watcher.ts:145-304`) with a 30 s safety sweep.
- HTTP routes stay (old hooks, transcripts, other integrations).

**Verify.** `tests/shared/hook-spool.test.ts` (ordering, dedupe overwrite, keep-on-false, temp data dir via env).
`tests/worker/hook-spool-drain.test.ts` (each kind reaches the same ingest function as the HTTP route; unknown session kept).
Handler tests updated: observation/summarize/session-end make **zero** awaited worker calls. Hook wall time test: with worker
down, observation hook exits < 200 ms.
**Guards.** No shared append-only file (Windows interleave). No replay of `SessionMessageBuffer`.

## Phase 6 — Precomputed SessionStart context

**What.**
- Worker writes `<dataDir>/state/context-cache/<sha256(allProjects.join(','), platformSource|'all', colors)>.json`
  `{ body, renderedAtEpoch, keys }` using `writeJsonFileAtomic`. `body` contains `{{HEADER_TIME}}` and
  `{{WORK_STATE_AGO:<epoch>}}`-style placeholders only where the renderer currently formats wall-clock/relative time.
- Render triggers: debounced (2 s) after any invalidation point listed in Phase 0 for any project in the key set (after
  `projectReadKeys` expansion), after settings/mode change, and once per variant on the first live request (cache miss).
  Index of active variants persisted in the cache dir so a cold worker can re-render them at boot.
- Hook `context.ts`: compute the key from `getProjectContext(cwd).allProjects`; if the file exists, substitute placeholders
  locally and return immediately — no worker call. The observer/sync health banner stays inside the cached body (rendered with
  budget) and is refreshed by invalidation from `observer-health.ts` / `sync-health.ts` writers. Cache miss ⇒ current HTTP path
  (unchanged) which also populates the cache.
- Remove the per-request `pullOnce({timeoutMs:1500})` from `handleContextInject`; the SyncClient's own pull loop already
  invalidates via `SyncApply`.

**Verify.** `tests/context/context-cache.test.ts`: byte-identical to live render modulo placeholders; invalidation on each write
point; hook returns from cache without fetch (assert mock fetch not called). Existing `context-session-start.test.ts` green.
**Guards.** Semantic + file-context remain per-request (inherently query-dependent).

## Phase 7 — Corpus: accept-then-watch + heartbeats

**What.** `CorpusRoutes` prime/query/reprime/build/rebuild: respond with SSE immediately (`: ping` every 10 s, `event: result`
terminal, `event: error` terminal). `callWorker` in `mcp-server.ts` uses `fetchWithIdleTimeout` (idle 30 s, no absolute cap
beyond 15 min) + `sse-reader` for those endpoints. Add `res.on('close')` → abort the underlying Agent SDK call (stop paying for
work nobody waits on). Narrow `KnowledgeAgent.isSessionResumeError` to the SDK's explicit resume-failure error codes/messages only.

**Verify.** Route tests with harness: 5-minute prime with pings succeeds; client disconnect aborts SDK call; regex unit test
(generic "not found" no longer reprimes).
**Guards.** Non-corpus `callWorker` endpoints unchanged.

---

## Track B — Supabase cloud sync (Phases 8–12)

### Target architecture (plain words)

Each device pushes a batch of changes to **one Supabase Edge Function** (`cmem-sync`). The function checks
the `cm_pro_` token and calls **one Postgres function** that, in a single transaction, appends the
changes to the user's ordered log *and* writes the searchable rows. Nothing is copied anywhere later
(`projected_seq == head_seq`, always). When the log moves forward a trigger sends a tiny
**Realtime broadcast** (`advance`, new `head_seq`) on the private channel `user:<id>`; other devices hear
it and pull. Pro's dashboard/MCP/search read the same table. Embeddings are filled in the background
inside Supabase (`gte-small`, no external key). Retired: Fly `sync-api`, Neon, Turbopuffer, the cmem.ai
projector route, the repair cron, the Cloudflare `sync-hub` worker.

**Code homes.** Backend (migrations + Edge Function) lives in **claude-mem-pro**
(`~/Scripts/claude-mem-pro`, Supabase project ref `ziczmqtpmaxbornfghye`, already linked via `supabase/.temp`;
migrations are hand-numbered `drizzle/NNNN_*.sql` applied by `scripts/db-migrate.ts`, latest 0063).
Client changes live in claude-mem.

### Phase 0-B — facts (discovery, cite before use)

**Wire contract the Edge Function must honour exactly** (client: `src/services/sync/CloudSync.ts`, `SyncClient.ts`,
`CanonicalContent.ts`, `SyncApply.ts`; reference server: `services/sync-api/src/store.ts`, `index.ts`, `auth.ts`):
- Headers: `Authorization: Bearer <cm_pro>`, `X-User-Id`, `X-Device-Id` (≤128), optional `X-Device-Name` (≤80, first non-empty kept).
- `POST /v1/sync/ops` `{protocol_version:2, ops:[{body, operation_sha256}]}` ≤500 ops, ≤8 MB →
  `200 {acked:[{id,kind,origin_local_id|null,entity_rev,operation_sha256,seq}], head_seq, projected_seq}`; must pass
  `validatePushResponse` (`CloudSync.ts:1640-1701`). Empty `ops` ⇒ 200 `acked:[]`.
- `GET /v1/sync/changes?since=&limit=` → `{protocol_version:2, epoch, ops:[{seq,body,operation_sha256,server_ts}], head_seq, more}`;
  **seqs dense from since+1** (`SyncApply.ts:511`, `SyncClient.ts:616-618`). Raises `sync_devices.last_ack_seq` monotonically.
- `GET /v1/sync/status` → `{protocol_version:2, epoch, head_seq, projected_seq, op_count, device_count}`, never registers a device.
- Errors: 400 `{error:"invalid_ops: ops[N] …"}` / `revision_hash_conflict:<id>:<rev>` / `stale_revision:<id>:<rev>` (regex-parsed,
  `CloudSync.ts:263-283`); origin-device mismatch text (`:250-254`); 401 `{code:"invalid_token"}`; 403 `{code:"subscription_inactive"}`;
  409 `device_limit_exceeded` (64 devices); 413 size; 503 `{error:"sync_hub_unavailable",retryable:true}` + `Retry-After: 5`.
- Send `X-Sync-Mode: poll` on every response ⇒ existing clients stop opening the old WebSocket (`SyncClient.ts:597-600,823-836`).
- Push semantics (`store.ts:357-472`): validate all ops first (origin_device == X-Device-Id); one transaction with
  `pg_advisory_xact_lock(hashtextextended(user_id,0))`; register device (cap 64); idempotency key `(user_id, entity_id, entity_rev)`:
  same rev+hash ⇒ re-ack original seq; same rev, different hash ⇒ `revision_hash_conflict`; rev < head ⇒ `stale_revision`;
  later ops in a batch see heads written by earlier ones; any error rolls back all. **Seq = per-user counter** (no SEQUENCE — gaps forbidden).
- Epoch: random non-zero uint64 decimal on first contact (`canonical-content.ts:430-436`). A new epoch makes clients reset cursor to 0
  and re-push their own native content (`SyncApply.handleEpoch`, `SyncApply.ts:406-451`) — **this is the migration path**.
- Canonical content validator: `services/sync-api/src/canonical-content.ts` uses only `crypto.subtle`, `btoa`, `TextEncoder` ⇒ copy into Deno.
- Content apply semantics to port: `content-projector.ts` on the uncommitted `fix/sync-api-off-vercel` worktree
  (`~/Scripts/claude-mem/.claude/worktrees/sync-api-off-vercel/services/sync-api/src/content-projector.ts`) and Pro's
  `src/lib/cmem/content-v2-projector.ts` (`projectContentV2Page`): higher-revision wins; equal-revision mutation wins;
  `set_title` no-op; `set_prompt_session` rewrites prompt session fields; `remap_project` pages and rewrites project; identity mismatch
  ⇒ `revision_conflict`.

**Pro read side** (Pro `origin/main` @ 87a94a7): all content reads go through `TpufContentV2Store` (`src/lib/cmem/content-v2-dal.ts:431`,
singleton `productionContentV2Store()` `:798`): `get/getMany/list/enumerate/search/projectCounts/stats/write/writeMany/mutationPage`.
Document shape `ContentV2Document` (`:116-141`), text fields from `projectedText()` (`:811`). Search today is BM25 only
(`queries.ts:161-211`, `vectorLegRan:false`). Hub coupling: `sync-hub-control.ts` (`readSyncHubMetadata :80`, `renameSyncHubDevice :93`,
`eraseSyncHubUser :162`), `content-v2-repair.ts`, `/api/internal/sync/project`, `/api/pro/sync/verify`, connect-info + trial poll return
`SYNC_HUB_INTERNAL_URL` as `hub_url`. Token check today: `validateSyncRequest()` (`src/lib/pro/auth.ts:65`) — `pro_users.setup_token`
plaintext equality + `user_id` match + `isProActive`. Old Supabase-era SQL to copy: `drizzle/0011_instant_sync.sql` (content columns,
generated tsvector, `realtime.broadcast_changes` trigger lines 102-169). `vector` extension still installed (0020 note).

**Supabase docs (fetched 2026-10-03):**
- Edge Functions: wall clock 400 s paid, request idle 150 s, CPU 2 s/request (async I/O excluded), 256 MB
  (https://supabase.com/docs/guides/functions/limits). `verify_jwt = false` per function in `supabase/config.toml`
  (https://supabase.com/docs/guides/functions/function-configuration). Deploy `supabase functions deploy cmem-sync`. Secrets
  `supabase secrets set NAME=value`; `SUPABASE_DB_URL` injected.
- **One push = one RPC** (`supabase.rpc`) — multi-statement work belongs in a database function
  (https://supabase.com/docs/reference/javascript/rpc); postgres.js through the transaction pooler can hang pipelined queries
  (https://supabase.com/docs/guides/database/postgres-js). Use `security definer set search_path = ''`, fully qualified names,
  `revoke execute … from public`, per-function `set statement_timeout = '60s'`.
- Realtime: `realtime.send(payload, event, topic, private)` from a trigger (https://supabase.com/docs/guides/realtime/broadcast); RLS on
  `realtime.messages` with `realtime.topic()` (https://supabase.com/docs/guides/realtime/authorization). Non-browser auth: import our own
  ES256 key (`supabase gen signing-key --algorithm ES256`), mint `{sub, role:"authenticated", exp}` with matching `kid`
  (https://supabase.com/docs/guides/auth/signing-keys). Pro plan default: 500 concurrent Realtime connections.
- Embeddings: automatic-embeddings pattern (`pgmq` + `pg_cron` + `pg_net` + Edge Function, `util.queue_embeddings`,
  `util.process_embeddings`) https://supabase.com/docs/guides/ai/automatic-embeddings ; model `new Supabase.ai.Session('gte-small')`,
  384-dim, `mean_pool+normalize` https://supabase.com/docs/guides/functions/ai-models ; hybrid RRF function
  https://supabase.com/docs/guides/ai/hybrid-search .
- Local dev: `supabase start` (Docker), `supabase functions serve cmem-sync --no-verify-jwt`, tests `supabase test db` (pgTAP).

**Anti-patterns (Track B).** No identity/SEQUENCE for seq. No multi-statement transactions from the Edge Function — one RPC. No
`verify_jwt=true` (cm_pro is not a JWT). No public Realtime channels. Do not hash-change the canonical content code — copy it byte-for-byte.
Do not delete Turbopuffer/Fly before Phase 12 verification. Do not touch the uncommitted `sync-api-off-vercel` worktree (read only).

## Phase 8 — Supabase schema + push/pull SQL (Pro repo)

**What.** `drizzle/0064_cmem_sync.sql` (+ matching `supabase/migrations/` copy only if Pro's tooling needs it — follow `scripts/db-migrate.ts`):
- `sync_users(user_id uuid pk → pro_users, epoch numeric(20) not null, head_seq bigint not null default 0, created_at)`.
- `sync_ops(user_id, seq bigint, entity_id text, kind text, origin_device_id text, origin_local_id text null, entity_rev numeric(20),
  operation_sha256 text, body text, deleted bool, server_ts bigint, pk (user_id, seq), unique (user_id, entity_id, entity_rev))`.
- `sync_entity_heads(user_id, entity_id, entity_rev, operation_sha256, pk (user_id, entity_id))`.
- `sync_devices(user_id, device_id, name, last_ack_seq bigint, last_seen timestamptz, pk (user_id, device_id))`.
- `cmem_content` — one row per entity, columns = `ContentV2Document` fields (copy names from `content-v2-dal.ts:116-141`) plus
  `user_id`, `payload jsonb`, `fts tsvector generated always as (to_tsvector('english', coalesce(search_text,''))) stored`,
  `embedding extensions.vector(384) null`; indexes: `(user_id, chronological_key desc) where not deleted`, `(user_id, project)`,
  `gin(fts)`, `hnsw (embedding vector_ip_ops)`.
- `cmem_sync_push(p_user_id uuid, p_device_id text, p_device_name text, p_ops jsonb) returns jsonb` — plpgsql port of `store.pushOps`
  semantics (Phase 0-B) **plus** applying each accepted content/mutation op to `cmem_content` with the projector rules, in the same
  transaction. `p_ops` items carry the already-validated decoded envelope fields + raw `body`. Raises `invalid_ops`/`revision_hash_conflict`/
  `stale_revision`/`device_limit_exceeded` with the exact message formats the client regex-parses.
- `cmem_sync_changes(p_user_id, p_device_id, p_since bigint, p_limit int) returns jsonb` and `cmem_sync_status(p_user_id, p_device_id)`.
- RLS enabled on all tables, no policies for anon/authenticated (only service role via functions); `revoke execute … from public`.

**Verify.** pgTAP `supabase/tests/cmem_sync.test.sql` porting `services/sync-api/test/protocol.test.ts` cases (dense seq + re-ack, batch ==
one-at-a-time, refused op commits nothing, stale/conflict, empty push, uint64, 64-device cap) + projector cases (higher-rev wins,
tombstone, set_prompt_session, remap_project). Run `supabase start && supabase db reset && supabase test db`.

## Phase 9 — `cmem-sync` Edge Function (Pro repo)

**What.** `supabase/functions/cmem-sync/index.ts` (Deno), `verify_jwt = false` in `supabase/config.toml`. Routes on the path suffix after
`/cmem-sync`: `POST /v1/sync/ops`, `GET /v1/sync/changes`, `GET /v1/sync/status`, `POST /v1/sync/realtime-token` (Phase 11).
- Auth: port `validateSyncRequest` (`src/lib/pro/auth.ts:65`) using service-role supabase-js against `pro_users` (setup_token equality,
  user_id match, `isProActive` copied); 60 s in-isolate cache; 401/403 bodies exactly as Phase 0-B.
- Validate ops with the copied `canonical-content.ts` (byte-identical to `services/sync-api/src/canonical-content.ts`), then one
  `supabase.rpc('cmem_sync_push', …)`; map raised errors to the 400/409 bodies; transient DB errors ⇒ 503 + `Retry-After: 5`.
- Every response carries `X-Sync-Mode: poll`.

**Verify.** Port `scripts/sync-matrix-e2e.ts` to a Supabase-local variant (`scripts/sync-matrix-e2e-supabase.ts` in claude-mem, target
`http://127.0.0.1:54321/functions/v1/cmem-sync`) — two real claude-mem clients, all kinds + mutations, delete + revive, cursors == head,
`projected_seq === head_seq`. Update `tests/infrastructure/sync-matrix-e2e-safety.test.ts` to allow the new loopback target.

## Phase 10 — Pro reads from Supabase (Pro repo)

**What.** `SupabaseContentStore` implementing the exact `TpufContentV2Store` public interface over `cmem_content` (raw `pg` pool from
`src/lib/cloud/db.ts`); `search` = `websearch_to_tsquery` + `ts_rank_cd` (and hybrid RRF once embeddings exist — Phase 11);
`productionContentV2Store()` returns it. Hub-bypassing writers (`src/lib/hooks/documents.ts:147`, `src/lib/eat/import.ts:143`,
`src/lib/alerts/session-summary.ts:543`) keep calling `write/writeMany` — now Postgres. Replace `sync-hub-control.ts` calls with direct
SQL over `sync_users`/`sync_devices` (metadata, device rename, erase = delete rows + new epoch). connect-info + trial poll return
`hub_url = <SUPABASE_URL>/functions/v1/cmem-sync`. Delete `/api/internal/sync/project`, `content-v2-repair.ts` + its cron, tpuf crons
from `vercel.json`, tpuf usage/backup/explorer code, and the tpuf erase steps in `account-erase.ts` (replace with row deletes).

**Verify.** Pro `scripts/test-*` suites touching content (`test-content-serving-budget`, `test-hooks-routes`, `test-mcp-auth`,
`test-connect-state-route`) green against local Supabase; new `scripts/test-supabase-content-store.ts` exercising every store method with
`fixtures/tpuf-content-v2.json`. `git grep -n turbopuffer src` ⇒ only migration notes. `npm run build` passes.

## Phase 11 — Realtime + embeddings

**What.**
- Realtime: trigger `after update of head_seq on sync_users` → `realtime.send(jsonb_build_object('type','advance','epoch',epoch,'head_seq',head_seq),
  'advance', 'user:'||user_id, true)`. RLS on `realtime.messages`: select allowed when `realtime.topic() = 'user:' || auth.uid()` and
  `extension = 'broadcast'`. Import an ES256 signing key (secret `CMEM_REALTIME_SIGNING_JWK` in the function); `POST /v1/sync/realtime-token`
  returns `{access_token, expires_at}` (15 min, `sub = user_id`, `role = authenticated`).
- claude-mem client: replace the custom WebSocket in `SyncClient.ts` (`:659-866`) with `@supabase/supabase-js` Realtime: private channel
  `user:<id>`, `accessToken` refreshed from `/v1/sync/realtime-token`; on `advance` ⇒ existing pull path. Keep the 30 s poll fallback.
  Delete the old WS frame handling and its tests; add `tests/worker/sync/sync-client-realtime.test.ts`.
- Embeddings: automatic-embeddings SQL copied from the docs page (`pgmq` queue `embedding_jobs`, `util.queue_embeddings` trigger on
  `cmem_content` insert/update of `search_text`, cron every 10 s) and an `embed` Edge Function using `Supabase.ai.Session('gte-small')`.
  `hybrid_search` RPC copied from the hybrid-search doc, adapted to `cmem_content` + user/project filters; Pro `search()` uses it.

**Verify.** e2e: device B pulls within 2 s of device A's push with polling disabled. Embeddings column filled for new rows within 60 s
locally. Hybrid search test returns a semantic-only match.

## Phase 12 — Cutover + retire (revised 2026-10-03 after Phase 10/11)

**Why revised.** Two couplings make the original order unsafe: (1) Pro on `feat/supabase-cloud-sync` reads content
only from `cmem_content`, which is empty until devices re-push — merging it first would blank every dashboard;
(2) every shipped client (≤13.29) pushes to `https://sync.cmem.ai` (Fly `sync-api`), which projects through
`/api/internal/sync/project` — a route that branch deletes. So the old path must keep working until traffic has moved.

**Order (each step verifiable and reversible until step 7):**
1. **Additive DB** — apply `0064`–`0068` to production with Pro's `scripts/db-migrate.ts` (new tables/functions/triggers
   only; nothing existing changes). Verify with `supabase test db --linked` equivalents (read-only checks) and
   `select count(*) from cmem_content` = 0.
2. **Functions + secrets** — `supabase functions deploy cmem-sync embed --project-ref ziczmqtpmaxbornfghye`; set
   `CMEM_REALTIME_SIGNING_JWK`, `CMEM_EMBED_SECRET`, `CMEM_PUBLIC_SUPABASE_URL`; import the ES256 public key as a
   **standby** signing key (Management API / dashboard); Vault secrets `project_url`, `cmem_embed_secret`,
   `cmem_pro_url`, `cmem_summary_landed_secret`. Nobody calls the function yet.
3. **Smoke** — production smoke with a dedicated test Pro account: push/pull/status, realtime-token + join + advance,
   embedding fills, hybrid search. Then delete the test account's sync rows.
4. **Backfill reads** — Pro script `scripts/backfill-cmem-content-from-tpuf.ts`: copy every user's tpuf v2 docs into
   `cmem_content` (hub_epoch/seq "0", keep entity_rev; conditional write so later pushes win). Verify per-user counts
   match tpuf `stats`.
5. **Move old clients without a release** (forward mode answers Pro's /internal routes with 410, so steps 5 and 6 run back to back with the Pro build verified and Vercel env set beforehand) — `services/sync-api` gains `FORWARD_ORIGIN` proxy mode (same idea as
   `workers/sync-hub` FORWARD_ORIGIN): every `/v1/sync/*` request is forwarded verbatim to the `cmem-sync` function.
   `fly deploy` with `FORWARD_ORIGIN` set. Clients see the new epoch and re-push their native content (idempotent with
   the backfill via conditional writes). Rollback = unset `FORWARD_ORIGIN` and redeploy.
6. **Pro merge (immediately after step 5, prepared in advance)** — merge `feat/supabase-cloud-sync` (Vercel deploys): reads from `cmem_content`, connect-info hands
   new installs the function URL, summary-landed route live; set `CMEM_SUMMARY_LANDED_SECRET`, `CMEM_EMBED_SECRET`
   in Vercel first.
7. **Client default** — claude-mem release maps `https://sync.cmem.ai` → the function URL in
   `migratedCloudSyncHubUrl` (removes the proxy hop). Ships with the next version bump after step 6 is verified.
8. **Retire (after 7 days clean)** — scale Fly `cmem-sync-api` to 0, delete Neon, delete Turbopuffer namespaces +
   remove the legacy erase steps, delete `services/sync-api/` and `workers/sync-hub/`.

**Verify.** Each step's check above; `/api/sync/status` on a real worker shows `projected_seq == head_seq` and no
`projection_busy` for 24 h; Pro dashboard counts for 3 real accounts match pre-cutover tpuf counts.

## Phase 13 — Final verification

1. `npm run typecheck`, `bun test tests` (full suite) on the merged branch; Pro `npm run build` + touched `scripts/test-*`.
2. Anti-pattern greps: `grep -rn "prior-request-id" src` = 0; `grep -rn "stream: false" src/services/worker/*Provider*.ts` = 0 for
   OpenRouter/OpenAICompat; `grep -rn "WEDGED_WORKER_UPTIME_S" src/shared/worker-utils.ts` = 0; no `SessionMessageBuffer` replay;
   no try/catch without rethrow/log in new files.
3. `npm run build-and-sync`; live checks: `curl -N localhost:37777/api/ready` streams phases and ends; observation hook with worker
   stopped exits < 200 ms and its spool file drains when the worker starts; SessionStart context served from cache file.
4. Open PR(s), `/babysit` until green and review comments resolved, merge, `/version-bump`.
