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

_Written after Supabase discovery completes — see below._
