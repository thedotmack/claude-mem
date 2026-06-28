# PostHog Historical Backfill — Anonymized Observation Metadata Import

**Goal**: One-time, per-install backfill of anonymized daily activity rollups from the local
SQLite DB into PostHog, using PostHog's historical-migration ingestion mode, so growth
(installs over time, reconstructed WAU/MAU, cohort retention) is visible for activity that
predates telemetry shipping.

**What gets sent** (anonymous counts/sums only — never titles, text, prompts, project names,
or any raw string column):
- One `historical_activity` event per active day per install, profile-less
  (`$process_person_profile: false`), carrying ONLY rollup counters + `backfilled: true`
  (no `buildBaseProperties()` — stamping the *current* version/os onto 2025-dated events
  would permanently poison version-over-time charts):
  `{ observation_count, session_count, summary_count, prompt_count, project_count,
  discovery_tokens, obs_type_bugfix, obs_type_discovery, obs_type_decision,
  obs_type_refactor, obs_type_other, session_completed_count, session_failed_count,
  sessions_claude_count, sessions_codex_count, sessions_gemini_count,
  sessions_other_platform_count, subagent_obs_count, backfilled: true }`.
- One `install_inferred` event at noon UTC of the install day, `person: true`, with
  `first_active_date` in properties and `$set` — this single event draws the adoption curve.

**Known caveats (accept, do not solve)**:
- Survivorship bias — only currently-installed, telemetry-consenting users backfill. The
  curve shows the history of the *retained* base.
- The last ~2.5 days before each install's first post-upgrade worker start are never
  backfilled (PostHog's 48h rule + whole-day windowing). Do NOT "fix" this by re-running
  without the marker — duplicates are worse than the gap.
- Geo properties on backfilled events reflect location at *upload* time, not the historical
  date (`disableGeoip: false` kept for consistency with live telemetry).
- Dashboards slicing by `version` must filter `backfilled != true`; combined install metrics
  must dedupe `install_inferred` ∪ `install_completed(is_update=false)` per distinct_id
  (telemetry-era installs emit both).
- Event-style live metrics (searches, injections, compression spend) are intentionally absent
  from backfill — they are not stored locally and cannot be reconstructed.

---

## Phase 0: Documentation Discovery — COMPLETE (findings consolidated below)

All implementation phases MUST use only the APIs listed here. Citations were verified against
the working tree, the published posthog-node v5.36.15 source, and the real
`~/.claude-mem/claude-mem.db` (read-only) on 2026-06-11, then adversarially re-verified on
2026-06-12 (see Review log at the bottom).

**Precondition**: this worktree has no `node_modules` — run `bun install` (or `npm install`)
before Phase 1 so imports and `bun test` resolve.

### Allowed APIs

**posthog-node ^5.36.15** (root `package.json:143`, imported in
`src/services/telemetry/telemetry.ts:1`; caret range — if the installed major ever drifts,
re-verify `historicalMigration` forwarding in `dist/`, search for `historical_migration`):
- `new PostHog(apiKey, options)` — `PostHogOptions = Omit<PostHogCoreOptions, 'before_send'> & {...}`.
  `PostHogCoreOptions` **includes** `historicalMigration?: boolean` ("Special flag to indicate
  ingested data is for a historical migration", default false). It is forwarded as
  `historical_migration: true` on every `/batch` request body (verified in
  `@posthog/core@1.32.1` shipped source). Also valid: `host`, `flushAt`, `maxBatchSize`,
  `maxQueueSize`, `disableGeoip`.
- `client.capture(msg: EventMessage)` — `EventMessage` includes `distinctId`, `event`,
  `properties`, **`timestamp?: Date`** (a `Date` object, NOT an ISO string), **`uuid?: string`**.
  Both are forwarded end-to-end to the payload.
- **capture() enqueues asynchronously** (a multi-microtask promise chain runs before the event
  reaches the queue). A bare `await client.flush()` does NOT join those pending captures and
  can resolve while events are still un-enqueued. Only `client.shutdown()` joins pending
  capture promises and then loops flush until the queue is empty — **shutdown() is the only
  delivery barrier**.
- `shutdown()` SWALLOWS fetch errors internally (`logFlushError`); its resolution proves
  nothing about delivery. Delivery failure is observable only via the public error emitter:
  `client.on('error', handler)` (`@posthog/core` `posthog-core-stateless.ts:301`).
- The in-memory queue silently drops the OLDEST event past `maxQueueSize` (default 1,000).
  Multi-year installs can exceed 1,000 active days — `maxQueueSize` must be raised.
- Background flushes fire automatically when the queue reaches `flushAt`; their errors are
  swallowed AND a non-network (4xx) failure removes the batch from the queue before throwing.
  Therefore: set `flushAt`/`maxBatchSize`/`maxQueueSize` all to 5000 so NO background flush
  ever fires and the entire backfill goes as one request at shutdown (the SDK auto-halves the
  batch on HTTP 413). One request also makes a cross-restart retry byte-identical — the best
  possible dedupe-key match.

**PostHog historical-migration rules** (https://posthog.com/docs/migrate):
- Set `historicalMigration: true` so events bypass standard ingestion/billing handling.
- Event timestamps must be **at least 48 hours in the past**. Server behavior for violating
  events is undocumented (rejection, billing, silent acceptance all possible) — the
  client-side day window is the only guard, and it applies to **every** event including
  `install_inferred`.
- "There is no way to selectively delete event data in PostHog" — idempotency is mandatory
  before anything ships (deterministic `uuid` + completion marker).
- uuid dedupe (https://posthog.com/docs/data/events) is **eventual and best-effort**
  (ClickHouse merge-time, not query-time) and keyed on
  `(toDate(timestamp), event, distinct_id, uuid)` — retried events must carry byte-identical
  timestamp+uuid+event+distinctId. The marker (not the uuid) is the PRIMARY idempotency gate;
  the uuid minimizes damage in the crash-retry window. Residual accepted risk: a crash between
  server-side ingest and marker write can leave transient duplicates until ClickHouse merges.

**Existing telemetry modules to copy from** (do not reinvent):
- Consent: `resolveTelemetryConsent(process.env, loadTelemetryConfig())` —
  `src/services/telemetry/consent.ts:68-73`. Install UUID: `getOrCreateInstallId()` —
  `consent.ts:114-124` (random v4 UUID persisted to `telemetry.json` via `getTelemetryConfigPath()`).
- Scrub: `scrubProperties(props)` whitelist scrubber — `src/services/telemetry/scrub.ts:126-149`;
  whitelist set `ALLOWED_PROPERTY_KEYS` at `scrub.ts:8-117`. **Properties not in the whitelist
  are silently dropped** — new keys MUST be added there. Already present (verified): the
  `obs_type_*` family (live `context_injected` ships them), `session_count`,
  `observation_count`. Confirmed ABSENT (must add): `discovery_tokens`.
- Key/host: `getTelemetryApiKey()`, `getTelemetryHost()` — `src/services/telemetry/common.ts:22-28`.
  Note: `getTelemetryApiKey()` falls back to the **embedded production key** and is never
  falsy — every worker boot anywhere can send real data (see Phase 2/3 sequencing).
  Base props: `buildBaseProperties()` — `common.ts:100-113` (returns CURRENT version,
  os_version, runtime_version, locale, is_ci — historical events must NOT carry it).
  Person-prop subset: `PERSON_PROPERTY_KEYS` + `buildPersonSet()` — `common.ts:36-76`.
  `buildPersonSet` only copies keys PRESENT on the event's properties — a person trait that is
  never assigned to the event silently never ships.
- Capture-path conventions (consent gate → scrub → debug-mode stderr print → no-key no-op →
  capture; swallow all errors): `captureEvent()` — `src/services/telemetry/telemetry.ts:72-117`.
- DB-reading telemetry pattern: `collectInstallStats(db: Database)` —
  `src/services/telemetry/install-stats.ts:29-99`. Per-block try/catch; typed `.get()` casts.
  Keep the per-block try/catch in the rollup too: older installs may lack a table or column —
  skip that block's keys, never throw.
- Epoch normalization (legacy rows store **seconds**, newer rows milliseconds — verified
  against a real DB where 273 rows render as 1970 without it):
  `asMs(col)` → `` `CASE WHEN ${col} < 1000000000000 THEN ${col} * 1000 ELSE ${col} END` `` —
  `install-stats.ts:23-25`. `DAY_MS = 86_400_000` — `install-stats.ts:27`. Note `MIN(asMs(x))`
  applies normalization INSIDE the MIN (correct); `asMs(MIN(x))` would not be.
- Deterministic UUID: **`Bun.randomUUIDv5(name, namespace)`** — exists and is deterministic on
  the worker's embedded Bun 1.3.9 (verified by execution). Use it with one fixed namespace
  UUID constant in the module. The npm `uuid` package is not installed and must not be added.
- Discovery-token storage semantics (load-bearing for aggregation):
  `src/services/sqlite/SessionStore.ts:1901-2015` — ONE `discoveryTokens` value per
  compression turn is written identically to EVERY observation row of that turn (line 1962)
  AND to the turn's `session_summaries` row (line 2004). Summing across observations
  multi-counts by the obs-per-turn factor. **Sum `session_summaries.discovery_tokens` only.**

**Database access** (`bun:sqlite`, synchronous):
- `import { Database } from 'bun:sqlite'` — pattern at `src/services/sqlite/SessionStore.ts:1-2`.
- Query: `db.query(sql).get(...)` / `.all(...)` with `as` type casts —
  e.g. `src/services/worker-service.ts:508-513`, `install-stats.ts:36-50`.
- Relevant columns: base schema in `src/services/sqlite/migrations/runner.ts:43-112` —
  `observations(project, created_at_epoch, memory_session_id, type, agent_type)`,
  `sdk_sessions(project, started_at_epoch, memory_session_id, status, platform_source)`,
  `session_summaries(project, created_at_epoch)`, `user_prompts(created_at_epoch)`
  (counts only — NEVER select `prompt_text`). **`discovery_tokens` is NOT in 43-112**: it is
  added by `ensureDiscoveryTokensColumn` at `runner.ts:381-402`
  (`ALTER TABLE ... ADD COLUMN discovery_tokens INTEGER DEFAULT 0` on both observations and
  session_summaries). Query only columns created in runner.ts — the dev DB has extra columns
  other installs lack.
- Observation `type` buckets: use the closed `STAT_TYPE_BUCKETS` set from
  `src/services/context/ContextBuilder.ts` (bugfix/discovery/decision/refactor/other) so the
  backfill vocabulary is identical to live `context_injected`.
- `platform_source` is a user-influenceable string — bucket in JS to the closed enum
  {claude, codex, gemini, other}; never ship the raw value.

**Worker integration points** (`src/services/worker-service.ts`):
- `worker_started` capture: lines 532-540 (inside `initializeBackground()`).
- Fire-and-forget background-task precedent to copy:
  `ChromaSync.backfillAllProjects(...)` `.then/.catch` block at lines 551-556.
- Daily heartbeat precedent: `setInterval(..., 24*60*60*1000)` + `.unref?.()` at lines 544-547.
- Shutdown order: `worker_stopped` capture BEFORE `shutdownTelemetry()` (lines 699-703).

**State files in `~/.claude-mem`**:
- Path root: `DATA_DIR` / `paths.dataDir()` — `src/shared/paths.ts:40, 129-151`.
- Read with `readJsonSafe<T>(path, fallback)` from `src/utils/json-utils.js` (as
  `consent.ts:5` imports it). **There is no JSON-write helper** — write with
  `mkdirSync` + `writeFileSync` exactly as `saveTelemetryConfig` does at `consent.ts:103-107`.
- The marker is its own file `backfill.json` — do NOT merge it into `telemetry.json`
  (the consent save path would clobber it).

**Logger** (console.* is forbidden in services — enforced by
`scripts/check-hook-io-discipline.cjs` / `tests/logger-usage-standards.test.ts`):
- `import { logger } from '../utils/logger.js'`; `logger.info('SYSTEM', msg, ctx, err?)`.
  `'TELEMETRY'` is NOT in the `Component` union (`src/utils/logger.ts:15-52`) — use `'SYSTEM'`.

**Tests** (`bun test`; global posthog-node mock):
- Global mock of `posthog-node` in `tests/preload.ts:45-55` records
  `postHogConstructorCalls` / `postHogCaptureCalls` — extend, don't replace. The mock class
  has NO `flush()`, `shutdown()` race-compatible signature, or `on()` — add no-op
  `flush()`/`shutdown()`/`on()` to it.
- State reset: `__resetTelemetryForTests()` — `src/services/telemetry/telemetry.ts:125-129`.
- Env/temp-dir isolation pattern: `tests/telemetry/telemetry-client.test.ts:30-53`
  (`CLAUDE_MEM_DATA_DIR = mkdtempSync(...)`).
- In-memory DB schema pattern: `tests/telemetry/install-stats.test.ts:8-28` — but its `makeDb`
  schema LACKS `discovery_tokens`, `memory_session_id`, `type`, `agent_type`, `status`,
  `platform_source`, and the `user_prompts` table. Extend the test schema with every column
  the rollup queries touch before writing tests, or the queries throw `no such column` (and
  the per-block try/catch would mask it as silently-empty rollups).

### Anti-patterns (DO NOT)

- ❌ `historical_migration` (snake_case) as a posthog-node constructor option — the SDK option
  is **`historicalMigration`** (camelCase). Snake_case is only for the raw `/batch` HTTP API.
- ❌ Passing `timestamp` as an ISO string to `client.capture()` — `EventMessage.timestamp` is
  typed `Date`. Construct `new Date(...)`.
- ❌ Reusing the live singleton client in `telemetry.ts` for backfill — it lacks
  `historicalMigration` and its `isShutdown` latch must stay untouched. Build a dedicated,
  short-lived client.
- ❌ Sending properties without adding them to `ALLOWED_PROPERTY_KEYS` — the scrubber drops
  them silently and the backfill would ship empty events.
- ❌ Raw `created_at_epoch` / `started_at_epoch` math without `asMs()` — legacy second-unit
  rows land in 1970 and poison the earliest cohort. Additionally apply the project-epoch
  floor (below): corrupt epochs can also land on plausible-looking wrong days, not just 1970.
- ❌ Filtering rollup rows by raw epoch against a cutoff instant — that ships a permanently
  truncated PARTIAL day. Always include whole UTC day buckets only (window rule in Phase 1).
- ❌ Summing `discovery_tokens` across observations AND session_summaries — the same per-turn
  value is stored on every row of the turn (see Phase 0); sum summaries only.
- ❌ `buildBaseProperties()` on `historical_activity` events — current version/os on
  2025-dated events is permanently wrong version-over-time data.
- ❌ The npm `uuid` package — use `Bun.randomUUIDv5` (verified present and deterministic).
- ❌ `console.*` anywhere in `src/services/` — use `logger` (debug-mode payload printing is the
  one exception and must use `process.stderr.write`, copying `telemetry.ts:97-103`).
- ❌ Writing the completion marker before delivery is confirmed — and "delivery confirmed"
  means `await client.shutdown()` resolved AND zero `client.on('error')` events, NOT a bare
  `flush()` (see Phase 0 SDK facts). A crash mid-send must retry on next startup.
- ❌ Booting the worker on the dev machine during Phases 1–3 without
  `CLAUDE_MEM_TELEMETRY=0` (or `CLAUDE_MEM_TELEMETRY_DEBUG=1`) exported — the embedded
  production key + default-on consent means a casual `npm run build-and-sync` ships the dev
  machine's entire history to production PostHog before the dry-run gate.

---

## Phase 1: Backfill module + tests (rollups, events, transport, marker)

**Create `src/services/telemetry/backfill.ts`** (one module, one test file).

### 1.1 Day window (one rule, used everywhere)

- `lastFullDay = utcDayString(nowMs - 60 * 3_600_000)` — 60h = 48h (PostHog contract) + 12h
  (noon-UTC event timestamps). Noon of any included day is then guaranteed ≥48h old.
- `PROJECT_EPOCH_FLOOR = Date.parse('2024-01-01T00:00:00Z')` — predates claude-mem's first
  release; rows with normalized epoch below it are corrupt and ignored everywhere (rollups
  AND first-activity MIN).
- `installDay = utcDayString(firstActivityEpochMs)` (1.3). Include only whole UTC days where
  `installDay <= day <= lastFullDay`, comparing **day strings** (YYYY-MM-DD compares
  lexicographically) — never raw epochs, so no partial days can ship. The lower bound discards
  backdated artifact rows (verified on the reference DB: obs ids 66888/66889 carry a
  2025-08-12 epoch but belong to a session started 2026-04-10).

### 1.2 `collectDailyRollups(db: Database, lastFullDay: string, installDay: string): DailyRollup[]`

Copy the query style of `collectInstallStats` (per-block try/catch — a missing table/column
skips that block's keys), bucketing every table by
`date(<asMs(col)>/1000,'unixepoch') AS day`, merged in a `Map<day, rollup>`. Pinned
semantics — these exact aggregations, so any two implementers ship identical numbers:

| key | source (per day) |
|---|---|
| `observation_count` | `COUNT(*)` FROM observations |
| `obs_type_bugfix/discovery/decision/refactor/other` | observations `GROUP BY day, type`, bucketed via `STAT_TYPE_BUCKETS` |
| `subagent_obs_count` | `COUNT(*)` FROM observations WHERE `agent_type IS NOT NULL` |
| `session_count` | `COUNT(*)` FROM sdk_sessions **only** (do NOT add observations' distinct memory_session_id — same sessions, double count) |
| `session_completed_count` / `session_failed_count` | sdk_sessions `GROUP BY day, status` (closed enum) |
| `sessions_claude_count` / `sessions_codex_count` / `sessions_gemini_count` / `sessions_other_platform_count` | sdk_sessions `platform_source`, bucketed in JS to the closed enum |
| `summary_count` | `COUNT(*)` FROM session_summaries |
| `discovery_tokens` | `SUM(discovery_tokens)` FROM **session_summaries only** (per-turn cost — see Phase 0 storage semantics) |
| `prompt_count` | `COUNT(*)` FROM user_prompts (count only — never `prompt_text`) |
| `project_count` | `COUNT(DISTINCT project)` over `(SELECT day, project FROM observations UNION SELECT day, project FROM sdk_sessions)` — cross-table distinct in ONE query; never sum per-table distincts (triple-counts the same project) |

Omitted on purpose: session durations (verified dirty — 22% of completed sessions show >24h
stale spans), dev-only columns not in runner.ts, anything string-valued.

### 1.3 `findFirstActivityEpochMs(db: Database): number | null`

`SELECT MIN(asMs(started_at_epoch)) FROM sdk_sessions WHERE asMs(started_at_epoch) >= FLOOR`
(copy `install-stats.ts:56-61` — note asMs INSIDE the MIN), falling back to the observations
MIN **only if sdk_sessions is empty**. Keep sessions-first: session timestamps are write-time
and trustworthy, while observation epochs can be backdated artifacts (verified — see 1.1);
a cross-table MIN would bake an artifact date into undeletable data.

### 1.4 `deterministicEventUuid(installId, event, day): string`

`Bun.randomUUIDv5(`${installId}|${event}|${day}`, BACKFILL_NAMESPACE)` where
`BACKFILL_NAMESPACE` is one fixed UUID constant in the module. One line; deterministic;
no hand-rolled hashing.

### 1.5 `buildBackfillEvents(db, installId, nowMs): EventMessage-like[]`

Pure assembly:
- Each rollup → `historical_activity` with `timestamp: new Date(day + 'T12:00:00Z')` and the
  deterministic uuid. Noon UTC is load-bearing TWICE: it keeps the event inside its day for
  dashboard timezones in UTC-12..+11 (keep the PostHog project timezone on UTC), and it makes
  the timestamp retry-stable, which the dedupe key requires — do not "simplify" to a
  non-deterministic timestamp. Properties: the rollup counters + `backfilled: true`, passed
  through `scrubProperties(...)`, then `$process_person_profile: false`.
  **No `buildBaseProperties()`** (see anti-patterns).
- One `install_inferred` with `timestamp: new Date(installDay + 'T12:00:00Z')` (noon UTC —
  retry-stable even if the sessions/observations MIN source flips between runs) and uuid keyed
  on day `'install'`. Properties: `{ ...buildBaseProperties(), first_active_date: installDay,
  backfilled: true }` through `scrubProperties`, then `$set = buildPersonSet(props)`
  (copy `telemetry.ts:91-95`). `first_active_date` MUST be assigned here — `buildPersonSet`
  only copies keys present on the event, and a whitelisted-but-never-assigned trait silently
  never ships. Base props are fine on this one person-event ($set = current person state).
- If `installDay > lastFullDay` (install younger than ~60h): return `[]`. Such installs have
  live telemetry coverage for their entire life — there is no pre-telemetry history to
  reconstruct, and shipping a <48h timestamp violates the migration contract.

### 1.6 Whitelist additions

Add to `ALLOWED_PROPERTY_KEYS` (`scrub.ts:8-117`) — verify each against the file first:
`discovery_tokens` (confirmed absent), `summary_count`, `prompt_count`, `project_count`,
`backfilled`, `first_active_date`, `session_completed_count`, `session_failed_count`,
`sessions_claude_count`, `sessions_codex_count`, `sessions_gemini_count`,
`sessions_other_platform_count`, `subagent_obs_count`.
Already whitelisted — reuse, do not re-add: `observation_count`, `session_count`,
the `obs_type_*` family. (`session_count`/`observation_count` carry different semantics on
live `context_injected` — acceptable: PostHog properties are filtered per-event in practice;
note the collision in the PR description.)
Add `first_active_date` to `PERSON_PROPERTY_KEYS` (`common.ts:36-60`).

### 1.7 Marker + transport: `runHistoricalBackfill(db: Database): Promise<void>`

Marker file `~/.claude-mem/backfill.json` at `join(dataDir, 'backfill.json')` (mirror
`getTelemetryConfigPath()`, `consent.ts:76-78`). Shape:
`{ completedAt: string, throughDay: string, eventCount: number, installId: string }`.
Read with `readJsonSafe`; write with `mkdirSync` + `writeFileSync` (as
`saveTelemetryConfig`, `consent.ts:103-107`).

Gate sequence (ORDER MATTERS — debug must precede every marker write):
1. Marker exists → return (idempotency gate #1).
2. `resolveTelemetryConsent(process.env, loadTelemetryConfig())` false → return
   **without writing the marker** (a later opt-in still backfills).
3. Build events via 1.5.
4. `CLAUDE_MEM_TELEMETRY_DEBUG === '1'` → `process.stderr.write` one summary line
   (event count + day range) then one line per event (copy `telemetry.ts:97-103`), do NOT
   send, do NOT write marker — even when the event list is empty. This dry-run intentionally
   re-runs on every debug-mode worker start; the marker must never latch from debug mode.
   (Only the exact value `'1'` activates it, matching `captureEvent`.)
5. Zero events → write marker, return. (Fresh installs land here: nothing pre-telemetry
   exists and live `install_completed`/daily events cover them from day 0 — `install_inferred`
   is intentionally NOT emitted for them.)
6. `!getTelemetryApiKey()` → return without marker. (Vestigial — the embedded key makes this
   unreachable; keep the one-liner for symmetry with `captureEvent`, write no test for it.)
7. Dedicated client:
   `new PostHog(getTelemetryApiKey(), { host: getTelemetryHost(), historicalMigration: true,
   flushAt: 5000, maxBatchSize: 5000, maxQueueSize: 5000, disableGeoip: false })` — the 5000s
   guarantee a single batch, no swallowed background flushes, and no silent queue-cap drops
   (see Phase 0 SDK facts).
8. `const errors: unknown[] = []; client.on('error', e => errors.push(e))`, then
   `client.capture({ distinctId: getOrCreateInstallId(), event, properties, timestamp, uuid })`
   per event, then `await client.shutdown()` — NO separate `flush()` call (it is not a
   delivery barrier) and NO 3s race (this runs fire-and-forget in the background; the SDK's
   default shutdown timeout is fine).
9. Write the marker ONLY if shutdown resolved AND `errors.length === 0`. Wrap the whole body
   in try/catch that logs via `logger` (`'SYSTEM'`) and never throws (telemetry must never
   break the worker — `telemetry.ts:114-116`).

**Verification checklist**:
- [ ] New test `tests/telemetry/backfill.test.ts` using the `:memory:` pattern from
      `tests/telemetry/install-stats.test.ts:8-28` with the schema EXTENDED per Phase 0
      (discovery_tokens, memory_session_id, type, agent_type, status, platform_source,
      user_prompts table). Cases:
      (a) mixed second/ms epochs land on the correct day (insert `created_at_epoch =
      1755000000` seconds; assert no 1970 day);
      (b) day window: a row 47h old is excluded AND no partial day ever ships (whole-day
      buckets only); a row before `PROJECT_EPOCH_FLOOR` or before `installDay` produces no day;
      (c) `deterministicEventUuid` stable across calls, general UUID shape (it is a v5 — do
      not assert a v4 version nibble);
      (d) every property in built events survives `scrubProperties` (no silent drops);
      (e) empty DB → zero events, no throw;
      (f) discovery_tokens dedupe: one turn = 3 observations + 1 summary all carrying 100 →
      day total **100**, not 400;
      (g) one session + one observation in it, same day → `session_count` 1 and
      `project_count` 1 (no double counting);
      (h) `install_inferred` uses the sessions MIN, is stamped noon UTC of `installDay`, and
      its `$set` contains `first_active_date`;
      (i) first activity 1h ago → zero events;
      (j) consent-off → zero `postHogCaptureCalls`, no marker; marker present → zero calls;
      debug mode → zero calls, no marker **including on an empty DB**; second invocation after
      success → zero calls;
      (k) happy path → constructor received `historicalMigration: true`, every capture has
      `uuid` + `Date` timestamp, marker written with correct `throughDay`; an `error` emitted
      via the mock's `on` handler → NO marker.
- [ ] `bun test tests/telemetry/` passes.

**Anti-pattern guards**: no marker write reachable before the debug gate; sum
summaries-only for discovery_tokens; day-string windowing only; no `buildBaseProperties` on
`historical_activity`; no `console.*`; no raw epoch math without `asMs`.

---

## Phase 2: Live dry-run against the real DB — THE SHIP/NO-SHIP GATE

This phase MUST complete before Phase 3 wires anything into the worker, because PostHog data
cannot be selectively deleted and `getTelemetryApiKey()` always returns the embedded
production key.

1. Run `runHistoricalBackfill` against the real `~/.claude-mem/claude-mem.db` with
   `CLAUDE_MEM_TELEMETRY_DEBUG=1` (small runner script or one-off test), and eyeball the
   stderr payload dump:
   - First day = **2025-10-19** for this machine (NOT Aug 2025 — the two 2025-08-12 rows are
     verified backdated artifacts and must be absent thanks to the installDay clamp).
   - No day newer than `lastFullDay` (≈ T-2.5 days), **no 1970 days**, no day before
     `install_inferred`'s `first_active_date`.
   - Plausible counts (~215 active days, ~93k total observations on this machine).
   - Exactly one `install_inferred`, `first_active_date: 2025-10-19`, noon-UTC timestamp.
   - No string property that looks like user content; every property is a number, boolean, or
     the single `first_active_date` date string.
2. Repeat runs are expected and safe (debug mode never writes the marker). If a non-debug test
   run ever latches the marker locally, the reset is `rm ~/.claude-mem/backfill.json`.

---

## Phase 3: Worker wiring + telemetry docs disclosure

**Export `CLAUDE_MEM_TELEMETRY=0` (or `CLAUDE_MEM_TELEMETRY_DEBUG=1`) in the dev shell for
every worker boot in this phase** — `npm run build-and-sync` restarts the worker, and an
unguarded boot performs the real production send from the dev machine.

1. **Wire into startup**: in `src/services/worker-service.ts`, immediately after the
   `worker_started` capture (lines 532-540) and alongside the ChromaSync fire-and-forget
   precedent (lines 551-556), add:

   ```typescript
   runHistoricalBackfill(this.dbManager.getConnection()).catch(error => {
     logger.error('SYSTEM', 'Telemetry historical backfill failed (non-blocking)', {}, error as Error);
   });
   ```

   Non-blocking, after core init. Do not add it to the heartbeat — it is one-shot by marker
   (a failed run retries on the NEXT worker start because no marker was written).

2. **Docs**: update `docs/public/telemetry.mdx` — add a short "Historical backfill" section:
   what is sent (daily anonymous counts + inferred install date), that it runs once, that it
   honors the same consent gates (`DO_NOT_TRACK`, `CLAUDE_MEM_TELEMETRY=0`, `telemetry.json`),
   that opting out before first worker start after upgrade prevents it entirely, and that geo
   properties on backfilled events reflect upload-time location. Follow the existing page's
   tone/structure (read it first).

**Verification checklist**:
- [ ] `bun test` (full suite) passes — especially `tests/logger-usage-standards.test.ts`.
- [ ] `grep -rn "runHistoricalBackfill" src/` shows exactly two hits: definition + the one
      worker-service call site.
- [ ] Worker boots clean **with telemetry disabled in the shell**: `CLAUDE_MEM_TELEMETRY=0
      npm run build-and-sync`, then confirm via worker log (`~/.claude-mem/logs/`) that
      startup completes and no backfill error is logged.

**Anti-pattern guards**: do not block `initializeBackground()` on the backfill promise; do not
capture `worker_stopped`-style events from inside backfill; no unguarded dev-machine boots.

---

## Phase 4: Final Verification

1. **Anti-pattern greps** (all must return nothing):
   - `grep -rn "historical_migration" src/` (wrong spelling for SDK path)
   - `grep -rn "console\." src/services/telemetry/backfill.ts`
   - `grep -rn "from 'uuid'" src/`
   - `grep -n "buildBaseProperties" src/services/telemetry/backfill.ts` → must appear ONLY in
     the install_inferred builder, never for historical_activity.
2. **Whitelist proof**: test asserting `scrubProperties(buildBackfillEvents(...)[i].properties)`
   retains every expected key on both event types.
3. **Full suite**: `bun test` green; `npm run build-and-sync` (telemetry-guarded shell)
   succeeds; worker starts.
4. **Re-run the Phase 2 dry-run** one final time on the release build (the marker is still
   absent on the dev machine if Phase 3 boots were guarded — if not, `rm
   ~/.claude-mem/backfill.json` first).
5. **Post-ship validation (manual, in PostHog UI after release)**:
   - BEFORE trusting reconstructed WAU: build a unique-users trend mixing one person event
     (`worker_started`) and one profile-less event (`session_compressed`) for a known
     installId and confirm it counts 1 user — this validates that profile-less
     `historical_activity` and person `install_inferred` merge as one unique user.
   - Adoption curve = `install_inferred` ∪ `install_completed(is_update=false)`, deduped per
     distinct_id (telemetry-era installs emit both — document on the dashboard).
   - Trend on unique `historical_activity` users by week = reconstructed WAU.
   - Annotate dashboards: survivorship bias; `version` slicing must filter
     `backfilled != true`; geo on backfilled events is upload-time.

---

## Phase ordering & session boundaries

Phase 1 (module + tests) → Phase 2 (live dry-run gate, BEFORE any wiring) → Phase 3
(wiring + docs, telemetry-guarded) → Phase 4 (verification + post-ship). An executor starting
any phase cold should read this file's Phase 0 plus the cited source files for that phase
before writing code. Run `bun install` first — the worktree has no `node_modules`.

---

## Review log (2026-06-12)

Adversarially reviewed by a 55-agent workflow (5 dimensions × independent skeptic
verification; 26 findings confirmed, 6 downgraded, 1 disputed, 0 refuted). Material changes
vs. the first draft:
- **Pinned rollup semantics** (session_count from sdk_sessions only; project_count via UNION
  distinct; discovery_tokens from summaries only — was multi-counted ~Nx per obs-per-turn).
- **Day window redefined** (whole-day buckets ≤ `utcDay(now-60h)`; was an ambiguous row-level
  48h filter that could ship truncated days and <48h timestamps).
- **install_inferred**: kept sessions-first MIN (a proposed cross-table MIN would have baked
  two verified backdated artifact rows — 2025-08-12 epochs written by a 2026-04-10 session —
  into undeletable data); added installDay clamp on rollups, 60h skip rule, noon-UTC
  retry-stable timestamp, and explicit `first_active_date` assignment (was whitelisted but
  never attached to any event).
- **Marker gating rebuilt on real SDK semantics**: bare `flush()` is not a delivery barrier
  and `shutdown()` swallows errors — single-batch config + `on('error')` latch + marker only
  on clean shutdown. Dropped the 3s race and the dead "flush every 5,000" advice.
- **Phase order fixed**: the live dry-run now precedes worker wiring (the embedded prod key +
  default-on consent meant the old Phase 3 "boot the worker" step performed the real
  irreversible send before the old Phase 4 dry-run, whose marker then made that dry-run a
  silent no-op).
- **More usage data, same privacy posture**: added prompt_count, obs_type_* breakdown
  (whitelist keys already exist from live telemetry), session outcome counts, platform
  buckets, subagent count; project_count now includes session-only days.
- **Simplifications**: Bun.randomUUIDv5 one-liner replaces hand-rolled sha256 nibble-forcing
  (the "invented API" anti-pattern claim was false — verified on Bun 1.3.9); deleted dead
  whitelist keys (backfill_days, backfill_events); old Phases 1+2 merged; debug gate moved
  ahead of all marker writes; corrected citations (discovery_tokens lives in a migration at
  runner.ts:381-402, not the base schema; there is no JSON-write helper).
