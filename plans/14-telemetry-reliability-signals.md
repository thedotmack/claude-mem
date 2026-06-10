# Plan 14 — Telemetry Reliability Signals

Adds the five highest-value missing telemetry signals identified by the 2026-06-10
capture-surface audit. Theme: **we instrument success well; failure is invisible.**
Every signal below feeds the **Reliability** sentence of
`plans/2026-06-09-telemetry-metrics-spec.md` ("Core pipeline succeeds X% of the
time at scale") — plus retrieval quality, which today has no KPI at all.

Phases are self-contained: each can be executed in a fresh chat context. Execute
in order; Phase 1–4 are independent of each other but all depend on Phase 0's
facts and share the Phase-ritual below.

---

## Phase 0 — Verified facts, allowed APIs, and the every-property ritual

Consolidated from 5 documentation-discovery agents (all high confidence, all
findings cite read code). **Do not invent APIs beyond this list.**

### The pipeline ritual — EVERY new property or event must touch all five surfaces

| # | Surface | Location | What to do |
|---|---|---|---|
| 1 | Scrub whitelist | `src/services/telemetry/scrub.ts:8-82` (`ALLOWED_PROPERTY_KEYS: Set<string>`) | Add the key, grouped with a category comment like the existing ones |
| 2 | Scrub tests | `tests/telemetry/scrub.test.ts` | Copy the pattern at `:5-31` (single-group) or `:81-106` (multi-key group); also confirm `:139-169` drop-tests still pass |
| 3 | Public docs | `docs/public/telemetry.mdx` fields table `:26-75`, events table `:78-89` | Add a row per field; new events get an events-table row |
| 4 | CLI disclosure | `src/npx-cli/commands/telemetry.ts` `COLLECTED_FIELDS:23-66`, `EVENT_NAMES:68-77` | Add a line per field; new event names go in `EVENT_NAMES` |
| 5 | Capture site | per phase below | Emit via `captureEvent` / `captureCliEvent` only |

### Allowed APIs (verified signatures)

- `captureEvent(event: string, props?: Record<string, unknown>, opts?: { person?: boolean }): void` — `src/services/telemetry/telemetry.ts:72` (worker transport; consent-gated, scrubbed, fire-and-forget)
- `captureCliEvent(event, props?, opts?): Promise<void>` — `src/services/telemetry/cli-telemetry.ts:22` (short-lived-process transport; direct POST, hard 2s timeout `CAPTURE_TIMEOUT_MS` at `:15`, never throws)
- `scrubProperties(props): Record<string, string | number | boolean>` — `src/services/telemetry/scrub.ts:91-114` (drops non-whitelisted keys and non-primitives **silently**; strings clamped to 200 chars; numbers must be finite)
- `collectInstallStats(db): Record<string, number>` — `src/services/telemetry/install-stats.ts:29`
- `getUptimeSeconds(startedAtMs: number, now?): number` — `src/shared/uptime.ts:5-7`
- `writePidFile(info: PidInfo) / readPidFile(): PidInfo | null / removePidFile()` — `src/services/infrastructure/ProcessManager.ts:134/141/156`; `PidInfo = { pid, port, startedAt: string /* ISO8601 */, startToken? }` (`src/supervisor/process-registry.ts:49-54`)
- `recordWorkerUnreachable(): number` — `src/shared/worker-utils.ts:451-470` (returns the consecutive-failure count; persists atomically in `~/.claude-mem/state/hook-failures.json`; threshold default 3, env `CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD`)
- `classifyObserverOutput(raw): 'xml'|'idle'|'prose'|'poisoned'` — `src/sdk/output-classifier.ts:60-80`
- `verifyCommitHashesInText(...): CommitVerificationResult` with `fabricated: string[]` — `src/sdk/commit-verification.ts:69-108`
- `DATA_DIR` / `paths.workerPid()` etc. — `src/shared/paths.ts:40,129-151`

### Global anti-patterns (from discovery; apply to every phase)

- Properties not added to `ALLOWED_PROPERTY_KEYS` are **silently dropped** — no error. Always whitelist first, then emit.
- Only `number | boolean | closed-enum string`. Never free text, paths, queries, error messages, IDs derived from the user. (An earlier audit draft proposed `error_summary: string` — explicitly rejected.)
- `person: true` only on lifecycle events (spec constraint, `plans/2026-06-09-telemetry-metrics-spec.md:65-71`). Nothing in this plan adds person properties; do not touch `PERSON_PROPERTY_KEYS`.
- Never bypass `captureEvent`/`captureCliEvent` with direct PostHog calls.
- Debug-mode verification harness: `CLAUDE_MEM_TELEMETRY_DEBUG=1` prints would-be payloads to stderr and sends nothing (`telemetry.ts:97-103`).

### Discovery discrepancy to resolve during Phase 2

One agent reported `INVALID_OUTPUT_RESPAWN_THRESHOLD` = 25, another = 3. Read
`src/services/worker/agents/ResponseProcessor.ts:25` before relying on the value.

---

## Phase 1 — Retrieval quality: `result_count` + strategy/fallback on `search_performed`

**Narrative served:** Reliability + retrieval quality. Zero-result rate becomes
computable; Chroma's silent degradation to FTS becomes visible (the recurring
`SQLiteSearchStrategy Database error` incident class).

### Verified obstacles (do not skip)

- The existing capture is a middleware: `SearchRoutes.ts:117-123` inside
  `res.once('finish')` — it fires **after** the response, outside handler scope.
  It can see only `endpoint`, `res.statusCode`, and elapsed time. Result arrays,
  `totalResults` (computed at `SearchManager.ts:307`), `chromaFailed`
  (`SearchManager.ts:158, 206, 274`) and `chromaFailureReason`
  (`SearchManager.ts:267-275`) are method-local and unreachable from there.
- `SearchManager.search()` has three paths: filter-only SQLite (`:165-176`),
  Chroma (`:179-286`, sets `chromaFailed` on error), Chroma-not-initialized FTS
  (`:288-305`). Text-format responses (`:420-425`) do not carry counts; only
  `format='json'` (`:309-316`) includes `totalResults`.
- `search_strategy` is **already whitelisted** (`scrub.ts:55`); only the new keys
  need whitelist entries.

### What to implement

1. In `SearchManager.search()`, build a small telemetry envelope alongside the
   existing return value — do not change response shapes. Collect:
   `result_count` (the `totalResults` already computed at `:307`),
   `search_strategy: 'chroma' | 'fts' | 'filter_only'` (one per path above),
   `chroma_available: boolean` (false when `chromaFailed` or not initialized),
   `fallback_reason: 'none' | 'chroma_connection' | 'chroma_error' | 'chroma_not_initialized'`
   (map from `chromaFailureReason.isConnectionError` at `:271`; never the message).
   Expose it to callers — recommended: return `{ ...existing, telemetry }` for an
   internal caller, or set it on a mutable param. Simplest verified-safe plumbing:
   handlers stash it on `res.locals.searchTelemetry`, and the middleware at
   `SearchRoutes.ts:117-123` spreads `res.locals.searchTelemetry ?? {}` into the
   existing `captureEvent('search_performed', …)` props.
2. Whitelist `result_count`, `chroma_available`, `fallback_reason` (ritual #1–4).
3. Note: `src/services/worker/search/types.ts:53-64` has a `StrategySearchResult`
   with a `strategy` field but `SearchManager.search()` does not use it — derive
   strategy from the three paths; do not refactor onto SearchOrchestrator here.

### Verification

- [ ] `bun test tests/telemetry/` green (new scrub cases included)
- [ ] `npm run typecheck:root` clean
- [ ] `CLAUDE_MEM_TELEMETRY_DEBUG=1` + a worker search request prints `search_performed` with `result_count`, `search_strategy`, `chroma_available`, `fallback_reason`
- [ ] Grep guard: `grep -n "fallback_reason" src/services/telemetry/scrub.ts docs/public/telemetry.mdx src/npx-cli/commands/telemetry.ts` hits all three
- [ ] Zero-result search shows `result_count: 0` (not missing)

### Anti-pattern guards

- Do NOT try to introspect the response body from the middleware (no `res._getBuffer()`-style Express internals — unverified, fragile).
- Do NOT put `chromaFailureReason.message` in any property — enum only.
- Do NOT change the text-format response shape consumed by clients.

---

## Phase 2 — Compression quality: fabrication, invalid-output, and abort reasons on `session_compressed`

**Narrative served:** Reliability + model quality (extends yesterday's
tokens/cost/ratio work with per-model trust signals).

### Verified mechanics (this is the key to doing it right)

- `compressionProps` is built at `ResponseProcessor.ts:194-214`. Non-SDK
  providers emit immediately (`:228`); the SDK/Claude path stashes the object
  into `session.pendingCompressionEvent` (`worker-types.ts:60`) at `:216-226`,
  and `ClaudeProvider.ts:416-435` later merges real token fields and emits;
  `:442-445` is the no-result fallback emit. **Therefore: any property added to
  `compressionProps` automatically flows through all three emit paths.**
- Fabrication scope: `ResponseProcessor.ts:115-135` already computes
  `fabricated: string[]` via `verifyCommitHashesInText`.
- Invalid output: `ResponseProcessor.ts:48-88` returns early — **no event fires
  at all** on that path today. `session.consecutiveInvalidOutputs`
  (`worker-types.ts:34`) increments at `:54`, resets at `:92`; respawn decision
  at `:67-79` (`outputClass === 'poisoned'` OR threshold reached — read the
  threshold at `:25`, see Phase 0 discrepancy).
- `abortReason` enum: `worker-types.ts:42` — `'idle'|'shutdown'|'overflow'|'restart-guard'|'quota'|string|null`;
  set at `ClaudeProvider.ts:270` (note: `'quota:…'` prefix format), `:315`,
  `SessionManager.ts:272,294,407`; consumed at `SessionRoutes.ts:166-167`. The
  error-path emit is `SessionRoutes.ts:154-163`.

### What to implement

1. **Fabrication:** in `ResponseProcessor.ts` where `fabricated.length` is known
   (`:128-135`), add to `compressionProps`: `fabrication_detected: boolean`,
   `fabricated_count: number`. (Flows through deferred path for free.)
2. **Invalid output:** at the respawn decision (`:67-79`) — and ONLY when a
   respawn triggers, to bound volume — emit one
   `captureEvent('session_compressed', { outcome: 'invalid_output', invalid_output_class, consecutive_invalid_outputs, respawn_triggered: true, provider, model, ide, hook })`
   where `invalid_output_class` is the classifier value (`'idle'|'prose'|'poisoned'`).
3. **Abort reason:** in the error-path emit (`SessionRoutes.ts:154-163`), add
   `abort_reason` normalized to a closed enum:
   `'idle'|'shutdown'|'overflow'|'restart_guard'|'quota'|'none'` — split the
   `'quota:…'` format on `':'` and map `'restart-guard'` → `'restart_guard'`.
4. Whitelist `fabrication_detected`, `fabricated_count`, `invalid_output_class`,
   `consecutive_invalid_outputs`, `respawn_triggered`, `abort_reason` (ritual #1–4).

### Verification

- [ ] `bun test tests/telemetry/` green; `npm run typecheck:root` clean
- [ ] Debug-mode `session_compressed` payload shows `fabrication_detected: false, fabricated_count: 0` on a normal compression
- [ ] Grep guard: `grep -rn "abort_reason" src/services/telemetry/scrub.ts src/services/worker/http/routes/SessionRoutes.ts` both hit
- [ ] Confirm the deferred path carries new props: grep the built `plugin/scripts/worker-service.cjs` for `fabrication_detected` after `npm run build`

### Anti-pattern guards

- Do NOT emit an event per invalid output (volume) — respawn-gated only.
- Do NOT send raw `abortReason` strings (`'quota:daily'`, `'restart-guard'`) — normalize to the closed enum first; the scrubber will happily pass any ≤200-char string, so enum discipline is on the emitter.
- Do NOT add the new props anywhere except `compressionProps` for the fabrication fields — adding them only at the `ClaudeProvider` merge would miss non-SDK providers.

---

## Phase 3 — Worker lifecycle: crash detection, `worker_stopped`, heartbeat health

**Narrative served:** Reliability ("crash-free installs") + makes the DAU/uptime
data trustworthy.

### Verified mechanics

- PID file already stores `startedAt` ISO8601 (`worker-service.ts:289`,
  `PidInfo` at `process-registry.ts:49-54`) → previous uptime is computable on
  next start via `Date.parse(startedAt)`.
- There is NO shutdown sentinel today; marker-file pattern to copy:
  `ProcessManager.ts:232-254` (`.chroma-cleaned-v10.3`) — write to `DATA_DIR`.
- Graceful shutdown: `worker-service.ts:565-585`; `shutdownTelemetry()` is called
  at `:576` and races a 3s flush (`telemetry.ts:124-144`) — an event captured
  **before** `:576` will flush. Stop-case `removePidFile()` is at `:836`.
- `worker_started` captures: `:427` (trigger `start`, `person: true`), `:436`
  (heartbeat, 24h `setInterval` with `.unref()` at `:435-438`); props builder
  `buildLifecycleProps()` at `:401-426`.
- `uncaughtException` handler at `:1075-1078` logs and does NOT exit (known smell — out of scope here, do not change process semantics in this plan).

### What to implement

1. **Clean-shutdown sentinel:** in the shutdown path (before `:576`), write
   `DATA_DIR/.worker-clean-shutdown` containing the ISO timestamp (copy the
   marker pattern from `ProcessManager.ts:232-254`). Delete the sentinel at
   startup after reading it.
2. **Crash detection on start:** in the startup daemon path, before
   `writePidFile`, derive:
   - stale PID file present + no sentinel → `previous_shutdown: 'crash'`
   - sentinel present → `'clean'`
   - neither (first run) → `'unknown'`
   - `previous_uptime_seconds` from the stale PID file's `startedAt` to sentinel
     time (clean) or to `now` minus unknown gap (crash → omit rather than guess;
     omitted properties are fine).
   Add both to the existing `captureEvent('worker_started', …)` at `:427`.
3. **`worker_stopped` event:** immediately before `shutdownTelemetry()` at
   `:576`, `captureEvent('worker_stopped', { uptime_seconds, shutdown_reason })`
   with `uptime_seconds` from `getUptimeSeconds(this.startTime)`
   (`worker-service.ts:122`, `uptime.ts:5-7`) and
   `shutdown_reason: 'stop' | 'restart' | 'signal'` from the caller. No
   `person: true`.
4. **Heartbeat health:** in the heartbeat payload (`:436` / `buildLifecycleProps`),
   add `process_rss_mb` and `heap_used_mb` as integers from
   `process.memoryUsage()` (`Math.round(rss / 1024 / 1024)`).
5. Whitelist `previous_shutdown`, `previous_uptime_seconds`, `uptime_seconds`,
   `shutdown_reason`, `process_rss_mb`, `heap_used_mb`; add `worker_stopped` to
   `EVENT_NAMES` and the docs events table (ritual #1–4).

### Verification

- [ ] `bun test tests/telemetry/` green; `npm run typecheck:root` clean
- [ ] Debug mode: `worker-service restart` prints `worker_stopped` (reason `restart`) then `worker_started` with `previous_shutdown: 'clean'`
- [ ] Kill -9 the worker, start it: `worker_started` shows `previous_shutdown: 'crash'`
- [ ] Heartbeat payload contains integer `process_rss_mb`
- [ ] Sentinel file is removed after startup reads it (no stale `'clean'` after a later crash)

### Anti-pattern guards

- Do NOT compute uptime from in-memory `startTime` for the *previous* run — it's never persisted; use the PID file's `startedAt`.
- Do NOT emit `worker_stopped` after `shutdownTelemetry()` — `isShutdown` (`telemetry.ts:81`) drops late events by design.
- Do NOT add the new keys to `PERSON_PROPERTY_KEYS` (spec ingestion-cost constraint).
- `process.memoryUsage().rss` is bytes — convert; the scrubber drops non-finite numbers silently.

---

## Phase 4 — `hook_failed` event (threshold-gated, CLI transport)

**Narrative served:** Reliability — a failing hook is silent memory loss; today
the fail-loud counter only writes to the user's stderr.

### Verified constraints (these dictate the design — read before coding)

- Hooks are short-lived processes (<1s typical). The worker transport
  (posthog-node batching) can never flush there; and emitting via the worker API
  is self-defeating (the defining failure IS "worker unreachable"). **Transport
  must be `captureCliEvent`** (`cli-telemetry.ts:22`, direct POST, 2s cap, never throws).
- **The trap:** `exitGraceful` (`hook-io.ts:166-173`) and `emitBlockingError`
  (`hook-io.ts:150-159`) call `process.exit()` immediately and do not await
  pending promises — a fire-and-forget POST is killed mid-flight. The emit must
  be **awaited before** the exit call, inside the failure branch.
- Catch taxonomy lives at `hook-command.ts:99-128`: AdapterRejectedInput
  (`:100-105`), non-blocking input error (`:106-111`), worker-unavailable
  (`:112-119`, the only branch calling `recordWorkerUnreachable()`), generic
  blocking error (`:121-128`, exit 2).
- `recordWorkerUnreachable(): number` returns the consecutive count and knows the
  threshold — gate on it.
- Hooks currently import zero telemetry code; `captureCliEvent` has only
  fs/fetch deps and bundles fine via `scripts/build-hooks.js` esbuild (telemetry
  modules are not externalized — verified at `build-hooks.js:284-330`).

### What to implement

1. In `hook-command.ts`, in exactly two branches:
   - **worker-unavailable branch (`:112-119`):** after
     `recordWorkerUnreachable()` returns `count`, if `count` has just reached the
     fail-loud threshold (the same condition that triggers the blocking stderr
     message), `await captureCliEvent('hook_failed', { hook_type, error_mode: 'worker_unavailable', consecutive_failures: count, threshold_tripped: true })`.
   - **generic blocking-error branch (`:121-128`):**
     `await captureCliEvent('hook_failed', { hook_type, error_mode: 'blocking_error', threshold_tripped: false })` before `emitBlockingError`.
   Both branches are rare and already failed — the ≤2s bounded wait is
   acceptable there. Never emit on the success path or the two skip branches.
2. `hook_type`: closed enum from the hook event already passed to
   `hookCommand(platform, event, …)` (`:79`) — use the event/handler name set
   (`context | session-init | observation | summarize | file-context`), not free text.
3. Whitelist `hook_type`, `error_mode`, `consecutive_failures`,
   `threshold_tripped`; add `hook_failed` to `EVENT_NAMES` + docs events table
   (ritual #1–4).

### Verification

- [ ] `bun test tests/telemetry/` green; `npm run typecheck:root` clean
- [ ] `npm run build` then grep the built hook artifact for `hook_failed` (confirms bundling)
- [ ] With the worker stopped and `CLAUDE_MEM_TELEMETRY_DEBUG=1`, run a hook 3× (threshold): third run prints `hook_failed` with `consecutive_failures: 3`
- [ ] Success-path hook run emits nothing and latency is unchanged
- [ ] Confirm exit codes unchanged (`HOOK_EXIT_CODES`, `hook-constants.ts:15-20`)

### Anti-pattern guards

- Do NOT fire-and-forget then `process.exit()` — the event dies with the process.
- Do NOT emit per-invocation hook latency events (volume + inline-latency cost). Worker-side `duration_ms` on `context_injected`/`search_performed` already covers worker latency; defer hook-side latency to a future aggregate.
- Do NOT route the emit through `executeWithWorkerFallback` or any worker API.
- Do NOT emit in the AdapterRejectedInput / non-blocking-input branches (expected, noisy, not failures of ours).

---

## Phase 5 — Final verification

1. **Full ritual audit** — for each new key
   (`result_count, chroma_available, fallback_reason, fabrication_detected, fabricated_count, invalid_output_class, consecutive_invalid_outputs, respawn_triggered, abort_reason, previous_shutdown, previous_uptime_seconds, uptime_seconds, shutdown_reason, process_rss_mb, heap_used_mb, hook_type, error_mode, consecutive_failures, threshold_tripped`):
   `grep -n "<key>" src/services/telemetry/scrub.ts tests/telemetry/scrub.test.ts docs/public/telemetry.mdx src/npx-cli/commands/telemetry.ts` — all four must hit.
2. **New events disclosed:** `worker_stopped`, `hook_failed` present in
   `EVENT_NAMES` (`src/npx-cli/commands/telemetry.ts:68-77`) and the
   `telemetry.mdx` events table.
3. **Anti-pattern greps:**
   - `grep -rn "captureEvent\|captureCliEvent" src/ | grep -v services/telemetry` — every site passes enums/counts only (manual scan of new sites)
   - `grep -rn "posthog" src/ --include="*.ts" | grep -v services/telemetry` — no direct SDK use outside the pipeline
   - no `PERSON_PROPERTY_KEYS` additions in the diff
4. **Tests & build:** `bun test tests/telemetry/` (note: bun only — the suite
   fails under vitest), `npm run typecheck:root`, `npm run build-and-sync`,
   worker `/health` returns ok.
5. **Live smoke:** `CLAUDE_MEM_TELEMETRY_DEBUG=1` walk: search (Phase 1 fields),
   compression (Phase 2 fields), restart (Phase 3 events), worker-down hook ×3
   (Phase 4 event).
6. **Docs deploy:** telemetry.mdx changes auto-deploy on push to main — confirm
   the public page renders the new rows after release.

## Out of scope (deliberately)

- The `uncaughtException` no-exit smell (`worker-service.ts:1075-1078`) — process-semantics change, separate plan.
- Per-hook latency events, event-loop-lag sampling, `telemetry_disabled` final ping (product/privacy decision pending), installer funnel (`install_started`), doctor/repair distress signals — candidates for Plan 15 after this data lands.
