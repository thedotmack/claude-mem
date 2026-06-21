# Plan: Fix & Unify claude-mem PostHog Telemetry

**Date:** 2026-06-19
**Status:** Ready to execute
**Author:** orchestrated via /make-plan + sequential-thinking, grounded in live PostHog data (project CMEM, 463218)

---

## Why this plan exists

The first PostHog bill forecast ~$7,660/mo. A PostHog rep diagnosed two causes: (1) `session_compressed` events created a **person profile on nearly every event** (identified-event double-billing, ~$3,440), and (2) raw event **volume** (~7.8M `session_compressed`/day, ~$4,020). The user wants the telemetry rebuilt *properly*: per-session rollups emitted at session end, a verified historical backfill, telemetry unified into the logging system, and real error-message data — "no shortcuts, no fallbacks, do the right thing."

### Verified current state (do NOT re-investigate — confirmed against live data + code)

1. **Person-profile double-billing is already fixed (v13.6.2).** `telemetry.ts`, `cli-telemetry.ts`, `backfill.ts` set `$process_person_profile: false` on every non-lifecycle event. Only low-volume lifecycle events (`worker_started`, `install_*`, `uninstall_completed`) build the anonymous install-UUID person profile via `buildPersonSet()`.
2. **A 5-minute time-window rollup buffer already shipped (v13.6.2).** `src/services/telemetry/buffer.ts` aggregates `session_compressed`→`observer_turn_rollup` and `context_injected`→`context_injected_rollup`.
3. **The fix boundary is clean (PostHog version breakdown).** Raw `session_compressed`/`context_injected` come ONLY from versions **≤13.6.1**; the rollups come ONLY from **13.6.2 / 13.7.0**. Raw volume is *legacy fleet decaying as installs update* — **this is not a fire.** We have room to do it right.
4. **What's still wrong / missing (the actual work):**
   - Rollup grain is a **5-minute time window**, not **per-session at session end** (what the user asked for).
   - Telemetry and the logger (`src/utils/logger.ts`) are **two separate subsystems** with duplicated call sites. User wants them "all together."
   - The scrubber **drops all error messages** (keeps only enum buckets `error_category`/`error_mode`). No real error text reaches PostHog. User wants "actual error message data."
   - Historical backfill (`backfill.ts`, `BACKFILL_VERSION=2`) is well-built but needs **verification + field alignment** with the new per-session grain.
   - Naming drift: buffer emits `observer_turn_rollup` but `scrub.ts` comments/docs reference `session_compressed_rollup`.
   - `test_event` / `test_event_2` noise events exist in the project.

---

## HARD INVARIANTS (every phase must preserve)

- **Telemetry never throws or blocks the worker.** All capture paths are fire-and-forget and swallow every error.
- **Consent gate precedes everything:** `DO_NOT_TRACK` > `CLAUDE_MEM_TELEMETRY` env > `telemetry.json` > default ON. Consent off ⇒ *nothing* sent, no client constructed, no marker written.
- **Property whitelist stays deny-by-default** (`scrub.ts`). The error scrubber (Phase 3) is a SEPARATE allow-then-redact path used ONLY for `$exception`.
- **No unbounded per-occurrence streams, ever again.** Every new event type must be rolled up OR rate-limited before it can reach PostHog.
- **Historical backfill stays idempotent + dedup-safe** (deterministic UUIDv5, noon-UTC timestamps, version-gated marker). Never stamp current version/os onto `historical_activity`.
- **No `console.*` in background services** (enforced by `tests/logger-usage-standards.test.ts`). Use `logger.*`.

---

## Phase 0 — Documentation Discovery (CONSOLIDATED — already done)

These facts are verified with sources. Treat as the "Allowed APIs" list.

### A. PostHog `posthog-node` SDK (pinned `^5.36.15`; verified against 5.38.2 `.d.ts` — API stable across 5.x)

| Need | Verified API | Notes |
|---|---|---|
| Capture event (already used) | `capture(props: EventMessage): void` | `EventMessage = { distinctId?, event, properties?, timestamp?, uuid?, ... }`. `$set`/`$process_person_profile` go inside `properties`. |
| **Capture exception** | `captureException(error: unknown, distinctId?: string, additionalProperties?: Record<string\|number, any>, uuid?, flags?): void` | `distinctId` is the **2nd positional** arg. **Put `$process_person_profile: false` in `additionalProperties` (3rd arg)** to keep exceptions profile-less. |
| Capture exception (await) | `captureExceptionImmediate(error, distinctId?, additionalProperties?, flags?): Promise<void>` | Use in short-lived/CLI or shutdown flush contexts. |
| Flush / shutdown | `flush(): Promise<void>`, `shutdown(shutdownTimeoutMs?): Promise<void>` | Current `telemetry.ts:149` usage is correct. |
| Constructor opts | `PostHogOptions` (`host`, `flushAt`, `flushInterval`, `maxBatchSize`, `maxQueueSize`, `disableGeoip`, `historicalMigration`, `before_send`, `enableExceptionAutocapture`) | `before_send?: BeforeSendFn \| BeforeSendFn[]` — returning `null` **drops before ingest = not billed**. `enableExceptionAutocapture: true` auto-captures uncaught exceptions/unhandled rejections (relevant: our worker is long-lived). |

**`$exception` event:** SDK builds `event: '$exception'` with `properties.$exception_list` (`[{type, value, stacktrace, mechanism}]`); PostHog derives `$exception_fingerprint` + `$exception_level` at ingest for issue grouping. **Billing: `$exception` bills as a standard event** (100k/mo free, then ~$0.00037/event). There is **NO built-in per-event rate limit** — we MUST rate-limit/dedupe client-side or drop via `before_send`. (Sources: posthog.com/docs/error-tracking/{installation/node,capture,pricing}.)

### B. Session lifecycle hook points (`src/services/worker/`)

- **Session identity:** `sessionDbId` (number). Sessions tracked in `SessionManager` as `private sessions: Map<number, ActiveSession>` (`SessionManager.ts:10`).
- **`ActiveSession`** (`src/services/worker-types.ts:9-63`) has: `sessionDbId`, `startTime`, `platformSource`, `pendingCompressionEvent?`, `cumulativeInputTokens/OutputTokens`, etc.
- **Terminal-state methods (where per-session flush hooks go):**
  - `deleteSession(sessionDbId)` — `SessionManager.ts:281` (full cleanup; aborts generator, disposes buffer, `sessions.delete`).
  - `removeSessionImmediate(sessionDbId)` — `SessionManager.ts:346` (fast removal; called from `GeneratorExitHandler` after generator done — **this is the normal session-end path**).
  - `shutdownAll()` — `SessionManager.ts:367` (`Promise.all` over `deleteSession` for every active session — the worker-shutdown path).
  - `respawnPoisonedSession(sessionDbId)` — `SessionManager.ts:251` (does NOT remove from map; **do not flush here** — session continues).
- **Worker shutdown sequence:** `worker-service.ts:680 shutdown()` → `beforeGracefulShutdown` (emits `worker_stopped`, calls `shutdownTelemetry()` at ~:705) → `performGracefulShutdown` (`GracefulShutdown.ts:38` calls `sessionManager.shutdownAll()`). **Note ordering risk:** `shutdownTelemetry()` currently runs BEFORE `shutdownAll()`. Per-session flush on shutdown must emit *before* the PostHog client is shut down — see Phase 2 ordering task.
- **`telemetryBuffer.start()`** called at `worker-service.ts:542`.
- **The 7 `telemetryBuffer.record()` call sites (fields to preserve):**
  | File:line | Event | Session-scoped? |
  |---|---|---|
  | `ClaudeProvider.ts:425` | session_compressed | yes (`session.sessionDbId`) |
  | `ClaudeProvider.ts:443` | session_compressed (`session.pendingCompressionEvent`) | yes |
  | `ResponseProcessor.ts:87` | session_compressed (`outcome: invalid_output`) | yes |
  | `ResponseProcessor.ts:246` | session_compressed (deferred `pendingCompressionEvent`) | yes |
  | `ResponseProcessor.ts:250` | session_compressed (`outcome: ok`, full `compressionProps`) | yes |
  | `SessionRoutes.ts:177` | session_compressed (`outcome: error`) | yes |
  | `SessionRoutes.ts:196` | session_compressed (`outcome: aborted`) | yes |
  | `SearchRoutes.ts:434` | context_injected (`outcome: error`) | **NO — hook-level** |
  | `SearchRoutes.ts:446` | context_injected (`outcome: ok`, `...stats`) | **NO — hook-level** |
  - **Critical:** `context_injected` fires from the context-injection HTTP route (UserPromptSubmit hook), **not** within a session generator. It has no `sessionDbId`. It must keep a bounded path (time-window rollup OR per-hook-process rollup), NOT the per-session accumulator.

### C. Tests & docs to extend (copy these patterns)

- Test framework: `bun:test`. Global PostHog mock in `tests/preload.ts` exposes `postHogConstructorCalls` / `postHogCaptureCalls`.
- Reset helpers: `__resetTelemetryForTests()` (`telemetry.ts:126`), `telemetryBuffer.__resetForTests()` (`buffer.ts:259`).
- **Copy-source test blocks:**
  - Rollup aggregation: `tests/telemetry/buffer.test.ts:61-118`.
  - "Consent off ⇒ nothing sent": `tests/telemetry/backfill.test.ts:434-440`.
  - Whitelist pass/reject: `tests/telemetry/scrub.test.ts:207-237`.
  - Test setup template (env + resets): `tests/telemetry/buffer.test.ts:20-54`.
- Consent module (`src/services/telemetry/consent.ts`): `resolveTelemetryConsent`, `explainTelemetryConsent`, `loadTelemetryConfig`, `saveTelemetryConfig`, `getOrCreateInstallId`. Precedence fixed — do not change.
- Docs: `docs/public/telemetry.mdx` (191 lines: header, "What is collected" whitelist table, events table, historical backfill, "What is NEVER collected", opt-out, debug, config). Nav entry in `docs/public/docs.json`.

---

## P0 — Billing safety (NON-CODE, do immediately)

**Goal:** make a future misconfig hit a cap, not the invoice. This is the only true urgency.

1. In PostHog → Organization → Billing: **set a billing limit** for Product Analytics (and Error Tracking once Phase 3 ships).
2. Configure **billing alerts** at e.g. 50% / 80% / 100% of the limit.
3. (Optional) Add a project-level **billing-limit drop** so overage events are dropped, not billed.

**Verification:** billing limit + alert visible on the billing page. No code change. Reference: posthog.com/docs/billing/limits-alerts.

**Note on session replay:** the rep mentioned session replay as a cheaper home for "session data captured by hand." **N/A** — claude-mem is a Node backend with no web app; there is no browser session to replay. Document this in `telemetry.mdx` so it doesn't resurface.

---

## P1 — Unified event / logging / telemetry layer (FOUNDATION)

**Goal:** one instrumentation path; every significant event fans out to (a) the local logger (full fidelity, file) and (b) the telemetry pipeline (scrubbed/rolled-up, PostHog). Everything in later phases plugs into this.

### What to implement
1. **New module `src/services/telemetry/instrument.ts`** exporting a single entry point, e.g.
   `instrument(component: Component, level: LogLevel, message: string, ctx?: LogContext, telemetry?: { event: string; props?: Record<string, unknown>; rollup?: 'session'|'hook'|'none'; person?: boolean })`.
   - It calls `logger[level](component, message, ctx, ctx?.data)` for the local line (full detail), THEN, **only if `telemetry` is provided and consent passes**, routes to the telemetry sink (`captureEvent` / per-session accumulator / error capture).
   - Dependency direction: `instrument` → `logger` (always) and `instrument` → telemetry (optional, consent-gated, swallow-all). The **logger must never import telemetry** (keeps logging working with telemetry disabled and avoids a cycle).
2. **Keep `logger.ts` telemetry-free.** Do the fan-out in `instrument.ts`, not inside `Logger`. (Phase 3 wires `logger.error`/`logger.failure` → exception capture via a thin optional hook set on the logger by `instrument`/worker init, still consent-gated and swallow-all — see Phase 3.)
3. **Migrate duplicated call sites** where code logs AND separately captures the same event (e.g. `SessionRoutes.ts:153` logs an error and `:177` records telemetry) to a single `instrument(...)` call. Do this incrementally — Phase 1 establishes the API and migrates 2-3 exemplar sites; later phases migrate the rest as they touch those files.

### Documentation references
- Logger API + levels: `src/utils/logger.ts:284-343` (`debug/info/warn/error/failure`, `Component` enum at `:15-52`).
- Existing capture path to wrap: `telemetry.ts:73 captureEvent`.
- Consent gate to reuse: `telemetry.ts:22 hasConsent()` (30s TTL cache) — `instrument` must respect it.

### Verification checklist
- [ ] `instrument()` with consent OFF produces a local log line but ZERO `postHogCaptureCalls` (copy assertion from `backfill.test.ts:434-440`).
- [ ] `instrument()` with consent ON produces both a log line and exactly one capture (or one accumulator record).
- [ ] `tests/logger-usage-standards.test.ts` still passes (no `console.*`, logger imported where required).
- [ ] `bun run build-and-sync` succeeds; worker starts.

### Anti-pattern guards
- ❌ Do NOT make `Logger` import the telemetry client (cycle + breaks telemetry-disabled logging).
- ❌ Do NOT let `instrument` throw — wrap the telemetry branch in try/catch that swallows.
- ❌ Do NOT bypass `scrubProperties` for structured props.

---

## P2 — Per-session rollups (replace the 5-minute window)

**Goal:** emit ONE `session_compressed` rollup per **session**, at session end — not per 5-minute wall-clock window.

### What to implement
1. **New per-session accumulator** in `buffer.ts` (or a sibling `session-rollup.ts`): `Map<number /*sessionDbId*/, SessionCompressedBucket>`. Replace the single module-level `sessionCompressedBucket` for the session-scoped path. Reuse `computeSessionCompressedRollup()` unchanged (it already produces the right aggregate shape).
2. **`record('session_compressed', sessionDbId, props)`** — add the `sessionDbId` key. Append to that session's bucket. Preserve ALL existing fields from the 7 call sites (see Phase 0.B table; especially the full `compressionProps` from `ResponseProcessor.ts:212-236` and the deferred `pendingCompressionEvent` merge).
3. **Flush triggers (no-shortcuts safety):**
   - **session_end:** call `flushSession(sessionDbId, 'session_end')` from `removeSessionImmediate()` (`SessionManager.ts:346`) AND `deleteSession()` (`SessionManager.ts:281`), at function entry while the session still exists. (Guard against double-flush: flushing removes the bucket, so the second call is a no-op.)
   - **worker_shutdown:** flush ALL active session buckets with reason `worker_shutdown`. **Fix ordering:** ensure these flush BEFORE the PostHog client is shut down. Either (a) move the per-session flush into `beforeGracefulShutdown` before `shutdownTelemetry()`, or (b) have `shutdownTelemetry()` drain session buckets before `current.shutdown()`. Prefer (b) for a single drain point.
   - **safety_flush:** a periodic sweep (e.g. every 5 min, `unref`'d interval) emits a partial rollup for any session whose bucket exceeds a max age OR max record count, tagging `rollup_reason: 'safety_flush'` and incrementing a `window_seq` so long-lived sessions still report and memory stays bounded.
4. **Add `rollup_reason` enum** (`session_end | worker_shutdown | safety_flush`) and `window_seq` (int) to the rollup props + `ALLOWED_PROPERTY_KEYS` in `scrub.ts`.
5. **`context_injected` stays bounded but separate.** It is hook-level (no `sessionDbId`). Keep its time-window rollup (`context_injected_rollup`) OR convert to a per-hook-process single flush at process exit. **Decision: keep the existing time-window rollup for `context_injected`** (it is already low-volume relative to session_compressed and has no session boundary). Document this asymmetry.

### Documentation references
- Rollup computation to reuse: `buffer.ts:63-143 computeSessionCompressedRollup`.
- Hook points: `SessionManager.ts:281, 346, 367` (Phase 0.B).
- Shutdown drain: `telemetry.ts:137-159 shutdownTelemetry`.
- Field source of truth: `ResponseProcessor.ts:212-236`.

### Verification checklist
- [ ] N `record('session_compressed', id, ...)` calls for one session + `flushSession(id,'session_end')` ⇒ exactly ONE `session_compressed`-rollup capture with correct sums/counts and `rollup_reason:'session_end'` (copy `buffer.test.ts:61-118`).
- [ ] Two sessions accumulate independently; flushing one does not drain the other.
- [ ] Worker shutdown with 2 active sessions ⇒ 2 rollups with `rollup_reason:'worker_shutdown'`, emitted before client shutdown.
- [ ] Safety flush fires for an over-cap session with `rollup_reason:'safety_flush'` + incremented `window_seq`; memory map shrinks after flush.
- [ ] Consent off ⇒ nothing.
- [ ] Re-flush of an already-flushed/absent session is a safe no-op.

### Anti-pattern guards
- ❌ Do NOT emit a rollup per record (that recreates the original bill).
- ❌ Do NOT key the accumulator by anything but `sessionDbId`.
- ❌ Do NOT flush on `respawnPoisonedSession` (session continues; would split one session into many rollups).
- ❌ Do NOT include `sessionDbId` itself in the emitted props (it is not whitelisted and is install-correlatable).

---

## P3 — Real error-message data via PostHog Error Tracking

**Goal:** capture actual error text/stack to PostHog Error Tracking (`$exception`), safely and at low volume.

> **One-way-door note (surface to user before shipping):** sending free-form error messages is a shift from claude-mem's strictly-anonymous, whitelist-only telemetry. PostHog data cannot be selectively deleted after ingest. The user has effectively opted in ("actual error message data would be great"), but the redaction below is mandatory and the behavior must honor the same consent gate + a dedicated env kill-switch.

### What to implement
1. **New `src/services/telemetry/error-scrub.ts`** — an **allow-then-redact** scrubber (opposite of the property whitelist, because messages are free-form):
   - Keep: `error.name`/type, `error.message`, a trimmed stack (top N frames).
   - Redact: home dir → `~` (use `os.homedir()`), absolute paths → basename or `~`-relative, URL query strings stripped, mask anything matching email / `sk-`/`phc_`/token / long-hex / JWT patterns, collapse whitespace, cap message ≤ 500 chars and stack ≤ ~2KB.
   - Pure, never throws.
2. **New capture fn `captureException(err, ctx?)`** in `telemetry.ts` (and a CLI variant if needed): consent-gated, builds redacted payload, calls SDK `captureException(error, getOrCreateInstallId(), { $process_person_profile: false, ...whitelistedContext })`. Profile-less. Swallow-all.
3. **Rate-limit / dedupe** (mandatory — no built-in SDK limit): keep an in-memory `Map<fingerprint, {count, firstTs, lastSentTs}>`. Fingerprint = hash(name + redacted message template + top frame). Send at most once per fingerprint per window (e.g. 1/min), attach an occurrence `count`. This is the "never an unbounded stream" invariant applied to errors.
4. **Wire into the logger** via the optional hook set in Phase 1: `logger.error()` and `logger.failure()` route their `Error` data through `captureException` (consent-gated, rate-limited). Replace the enum-only `error_occurred` capture at `BaseRouteHandler.ts:61` with a real exception capture (keep an aggregate count too if useful).
5. **Consider `enableExceptionAutocapture: true`** on the worker client to catch uncaught exceptions/unhandled rejections — but ONLY with the rate-limiter in front (autocapture can storm). Gate behind the same consent + kill-switch. If risk is unclear, ship manual `captureException` first and add autocapture in a follow-up.
6. **Env kill-switch:** `CLAUDE_MEM_TELEMETRY_ERRORS=0` disables exception capture independently of analytics (defaults ON when telemetry is on). Document it.

### Documentation references
- SDK: `captureException(error, distinctId?, additionalProperties?, ...)` (Phase 0.A). `$process_person_profile:false` goes in `additionalProperties`.
- Existing redaction precedent: `scrub.ts` (structured path) — error-scrub is the free-form sibling.
- `before_send` drop option (Phase 0.A) as an extra ingest-side guard.

### Verification checklist
- [ ] `error-scrub` redacts: home dir, abs paths, emails, `phc_`/`sk-`/token-like strings, URL query params; caps length; never throws on hostile/circular input (copy hostile-input pattern from `scrub.test.ts:314-326`).
- [ ] `captureException` with consent OFF ⇒ zero captures.
- [ ] Same fingerprint 100× within the window ⇒ ≤1 (or capped) `$exception` sends, with `count` reflecting occurrences.
- [ ] `$exception` payload carries `$process_person_profile:false` (no person profile created).
- [ ] `logger.error(component, msg, ctx, new Error(...))` triggers one redacted exception capture.
- [ ] Kill-switch `CLAUDE_MEM_TELEMETRY_ERRORS=0` ⇒ zero exception captures, analytics unaffected.

### Anti-pattern guards
- ❌ Do NOT route error messages through the structured property whitelist (it would drop them) — use `error-scrub`.
- ❌ Do NOT enable autocapture without the rate-limiter.
- ❌ Do NOT include raw paths, prompts, project names, or model output in the message/stack.
- ❌ Do NOT let exception capture throw into the logger (swallow-all).

---

## P4 — Historical backfill: verify + align

**Goal:** confirm the historical rollup is correct/complete and comparable to the new live per-session grain.

### What to implement
1. **Verify completeness** against live PostHog: `historical_activity` + `install_inferred` are landing (confirmed present). Spot-check that day coverage and `first_active_date` look sane for known installs.
2. **Field alignment:** the live per-session rollup (Phase 2) aggregates `session_compressed` economics (tokens_input/output, cost_usd, compression_ms, outcomes, fabrication). The backfill ships per-day activity counts + `read_tokens`/`tokens_saved_vs_naive` and intentionally OMITS generation-side cost (never persisted to SQLite — `backfill.ts:336-340`). **Keep that omission** (don't fabricate cost), but ensure shared keys (`observation_count`, `session_count`, `obs_type_*`) use identical names/semantics so historical and live series stack in one chart. Document which fields are live-only vs historical-only.
3. **If any backfill field changes**, bump `BACKFILL_VERSION` (`backfill.ts:77`) so already-backfilled installs re-run idempotently (deterministic UUIDs make this dedup-safe).
4. **Do NOT** add `buildBaseProperties()` to `historical_activity` (would poison version-over-time charts — `backfill.ts:446-448`).

### Documentation references
- `backfill.ts:463-510 buildBackfillEvents`, `:528-644 runHistoricalBackfill`, `:140-149 isBackfillComplete`.
- Tests: `tests/telemetry/backfill.test.ts` (epoch normalization, day windows, deterministic UUID, consent-off).

### Verification checklist
- [ ] Re-run with `CLAUDE_MEM_TELEMETRY_DEBUG=1` ⇒ dry-run prints expected day range + event count, sends nothing, writes no marker.
- [ ] Version bump (if any) ⇒ a v2-marker install re-runs; a current-version-marker install is skipped.
- [ ] Shared keys match live rollup names exactly.
- [ ] Consent off ⇒ no client, no captures, no marker (`backfill.test.ts:434-440`).

### Anti-pattern guards
- ❌ Do NOT ship a second event per (install, day) with a different UUID (breaks dedupe).
- ❌ Do NOT invent generation-cost for historical days.

---

## P5 — Cleanup, docs, and re-measure

### What to implement
1. **Canonicalize the rollup event name.** Buffer emits `observer_turn_rollup`; `scrub.ts` comments and `telemetry.mdx` reference `session_compressed_rollup`. Pick ONE (recommend keeping `observer_turn_rollup` since it's what's live — just fix the stale comments/docs). Update consistently.
2. **Remove dead raw-event paths.** Confirm no code path calls `captureEvent('session_compressed'|'context_injected', ...)` directly (only the rollup path should exist). grep-guard it.
3. **Purge `test_event` / `test_event_2`** sources (search repo + any test harness that emits them to the real project).
4. **Docs:** update `docs/public/telemetry.mdx` — new events (per-session rollup `rollup_reason`/`window_seq`, `$exception`), the unified logging model, the error-tracking opt-in + `CLAUDE_MEM_TELEMETRY_ERRORS` switch + one-way-door note, and a line explaining session replay is N/A (backend). Update `docs.json` if a new page is added.
5. **Re-measure in PostHog** (via PostHog MCP `query-trends`) after rollout: confirm raw `session_compressed`/`context_injected` continue decaying, `observer_turn_rollup` volume is sane per active install, `$exception` volume is bounded, and no person profiles are created for non-lifecycle events.

### Verification checklist
- [ ] `grep -rn "captureEvent('session_compressed'\|captureEvent('context_injected'" src` ⇒ no matches.
- [ ] `grep -rn "session_compressed_rollup" src docs` ⇒ no stale references (or all intentional).
- [ ] `grep -rn "test_event" src tests` ⇒ no production emitters.
- [ ] `docs/public/telemetry.mdx` covers rollups, errors, unified logging, opt-out.
- [ ] PostHog trends query shows bounded volumes post-rollout.

---

## Final verification (run after all phases)

1. `bun test tests/telemetry/` + the new test files all pass.
2. `tests/logger-usage-standards.test.ts` passes.
3. `bun run build-and-sync` succeeds; worker starts and `/api/health` is green.
4. Manual smoke with `CLAUDE_MEM_TELEMETRY_DEBUG=1`: drive one session end-to-end → observe ONE `session_compressed` rollup with `rollup_reason:'session_end'`; trigger an error → observe ONE redacted `$exception`; consent off → observe nothing.
5. PostHog re-measure confirms decay + bounded new volumes + no unexpected person profiles.

---

## Execution notes
- Phases are ordered by dependency: **P0 (now) → P1 (foundation) → P2 → P3 → P4 → P5**. P1 must land before P2/P3 build on the unified path.
- Each phase is self-contained for a fresh context: it cites exact files/lines and copy-source tests.
- Run `/do` against this file to execute phase-by-phase.
