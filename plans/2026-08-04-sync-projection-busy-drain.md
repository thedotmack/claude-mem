# Fix sync drain stalls for all paying customers (`projection_busy` livelock)

**Status:** ready to execute
**Owner:** —
**Created:** 2026-08-04

Paying Pro customers with a sync backlog drain at roughly one 200-row batch per
backoff period, escalating to one batch per 10 minutes. `lastFlushAt` never
becomes non-null, so the `/cloud-sync` skill and the dashboard cannot tell
"draining slowly" from "wedged". Reproduced live on a real Pro account
(device `ee1b7637-93bd-4135-8566-fe104b20ff8e`, ~2,700 rows queued).

---

## Phase 0: Documentation Discovery (COMPLETE — read this before any phase)

Consolidated from three discovery passes over `workers/sync-hub/`,
`src/services/sync/`, and the deploy/contract docs. Every claim below is
cited. **Do not re-derive these; do not assume anything not listed here.**

### 0.1 The actual root-cause chain

1. `POST /v1/sync/ops` commits the batch durably **first**
   (`workers/sync-hub/src/index.ts:346`, `stub.pushOps(...)`), then drains
   projection **synchronously on the request path**
   (`index.ts:350`, `drainProjection`).
2. `drainProjection` pages to the Pro projector at
   `PROJECTION_PAGE_MAX_OPS = 100` (`src/projection-protocol.ts:3`), each page
   allowed `PROJECTION_FETCH_TIMEOUT_MS = 45_000` (`projection-protocol.ts:5`).
   A 200-op push therefore needs **2 sequential upstream POSTs**, up to 90 s.
3. **The client aborts at 30 s** — `requestTimeoutMs ?? 30_000`
   (`src/services/sync/CloudSync.ts:417`, applied at `:953`). This is
   **strictly shorter** than the hub's own 45 s projector deadline. The client
   always gives up first.
4. Every projection failure path **deliberately retains the 90 s lease**
   (`PROJECTION_LEASE_MS = 90_000`, `src/do/SyncHub.ts:31`; `releaseLeaseEarly`
   stays `false` at `index.ts:643/705`, released only at `index.ts:803-805`).
   Rationale is documented at `DEPLOY.md:79-84` — the upstream may have ignored
   cancellation.
5. While that lease is held, **every** push for that user returns
   `503 projection_busy` (`index.ts:624-640`). This is **lease contention, not a
   lag threshold** — there is no `N`.
6. The client throws on **any** `!res.ok` (`CloudSync.ts:967-970`) before
   reaching `stampAcked`, so the ops stay unstamped and the *same* 200-row batch
   re-pushes forever — even though the hub already holds them durably
   (`durable: true` is hardcoded at `index.ts:354`).
7. One throw aborts the **entire** drain — `drainContentOutbox` → `drainMutations`
   → every remaining kind — via the single `catch` at `CloudSync.ts:534`.
8. `resetBackoff()` has **exactly one caller**, `CloudSync.ts:533`, on the fully
   clean path. A flush that pushed 6 batches and failed on the 7th doubles the
   backoff identically to one that pushed nothing. Ladder: 30s → 60s → 120s →
   240s → 480s → 600s (`backoffInitialMs = 30_000` `:415`,
   `backoffMaxMs = 600_000` `:416`, `scheduleRetry` `:1394-1404`).
9. `lastFlushAt` is assigned at **exactly one site**, `CloudSync.ts:531`,
   reachable only after the whole `do/while` completes with zero throws.

### 0.2 Allowed APIs / verified constants

| Fact | Value | Source |
|---|---|---|
| Push route | `POST /v1/sync/ops` | `index.ts:935-938` |
| Wire version | `protocol_version: 2`, **exact equality both ends** | `index.ts:330`, `CloudSync.ts:609`, `SyncClient.ts:553` |
| Client batch | `BATCH = 200` | `CloudSync.ts:64` |
| Hub caps | `MAX_OPS_PER_PUSH = 500`, `MAX_PUSH_BODY_BYTES = 8_000_000` | `index.ts:81-82` |
| Projection page | 100 ops / 4 MB / 45 s | `projection-protocol.ts:3-5` |
| Lease | `PROJECTION_LEASE_MS = 90_000` | `do/SyncHub.ts:31` |
| Client HTTP timeout | 30 s | `CloudSync.ts:417` |
| Startup fence assertion | `PROJECTION_FETCH_TIMEOUT_MS < PROJECTION_LEASE_MS` | `index.ts` (throws at module load) |
| Documented fence | hub abort 45s < Pro maxDuration 60s < hub lease 90s | `DEPLOY.md:74` |
| Stable error body | `{"error":"device_limit_exceeded"}` — the **only** one documented stable | `METADATA-CONTRACT.md:66-72` |
| Idempotent replay | identical `(entity_id, entity_rev)` + matching sha re-acks with existing seq | `do/SyncHub.ts:412-428`; proven `test/sync-hub.test.ts:753-777` |
| Repair endpoint | `POST /internal/v1/projection/drain`, secret-gated | `index.ts:834`; curl at `DEPLOY.md:100-104` |

### 0.3 Anti-pattern guards (CI-enforced — a violation fails the build)

`.github/workflows/ci.yml:66-82` greps for Durable Object anti-patterns, backed
by `workers/sync-hub/eslint.config.mjs`. From `plans/2026-07-17-phase5-two-lane-sync.md` §0.4:

- **No outbound I/O from the DO — at all.** The DO's `async fetch(request` is
  the only allowlisted `fetch(`.
- No `setTimeout` / `setInterval` in the DO.
- No `setAlarm()` in the constructor without a `getAlarm()` check (the
  documented $34k runaway).
- No long-poll / held HTTP request on the DO (directive #4: defeats
  hibernation, ≈ $4/device/mo).
- No in-memory maps as socket state; no buffering a full replay in memory.

**Do not "fix" this by adding a queue consumer, a projection cron, or a DO
alarm that projects.** There is no queue binding in `wrangler.jsonc`, and the
daily alarm is an intentional no-op (`do/SyncHub.ts:813-818`, `DEPLOY.md:112-117`).

### 0.4 Things that do NOT exist (do not invent them)

- No `Retry-After` header anywhere in `workers/sync-hub/` (grep: zero hits).
- No retryable-vs-fatal classification in the client (grep for
  `retryable|projection_busy|429|503` over `src/services/sync/`: **zero hits**).
- No background projection worker — `drainProjection` has exactly two call
  sites: `index.ts:350` (push) and `index.ts:834` (repair).
- No partial-progress bookkeeping in `CloudSync` — no rows-pushed counter, no
  `lastProgressAt`.
- No staging environment, no `wrangler rollback`, no gradual deploy. One worker,
  one target.
- No client/hub compatibility policy document. `METADATA-CONTRACT.md` covers
  only the two **internal** Pro routes, not the public client surface.

### 0.5 Shipping paths are independent

| Half | Path | Reaches customers |
|---|---|---|
| Hub | manual `wrangler deploy` from `workers/sync-hub` (`DEPLOY.md:481-490`) | **immediately, no client upgrade** |
| Client | 8-file version bump → `npm run build-and-sync` → tag → npm + marketplace (`plugin/skills/version-bump/SKILL.md`) | only as users upgrade |

`workers/` is excluded from the marketplace rsync
(`scripts/sync-marketplace.cjs:78`) and absent from `files[]`.

**This is why the plan is hub-first.** "All paying customers now" is only
achievable server-side; the client work is the durable fix for the next release.

### 0.6 Open questions — NONE of these block execution

Every phase below can be executed without answering these. Phase 3's
recommended change is deliberately robust to all three: returning 200 once the
append is durable unblocks clients whether or not leases leak and whether or
not the projector is slow. These determine how much *residual* risk remains and
whether a deeper root cause also needs fixing in `claude-mem-pro` — they are
follow-on work, not prerequisites. Do not wait on them.

1. **Does Cloudflare tear down the Worker invocation on client disconnect?**
   Determines whether the `finally` at `index.ts:803-805` runs, i.e. whether
   leases actually leak in production. Not answerable from this repo.
2. **Is the Pro projector (`https://cmem.ai/api/internal/sync/project`) slow or
   failing?** Not in this repo. If it is, that is the true root cause and the
   fix belongs in `claude-mem-pro`.
3. **Is Pro's scheduled repair job actually running, and at what cadence?**
   Documented as existing (`DEPLOY.md:97-105`), implementation external.

Phase 2's logging answers Q1 as a side effect. Q2 and Q3 need eyes on the Pro
side and can run in parallel with the whole plan.

---

## Phase 1: Unblock existing paying customers (ops only, no code)

**Goal:** every currently-stuck account drains today.

1. Pull the affected-user list. A user is stuck when the hub reports
   `projected_seq < head_seq` persistently — `sync_health` is defined as
   `healthy` exactly when `projected_seq === head_seq`
   (`METADATA-CONTRACT.md:52-54`).
2. For each, run the repair drain. **Copy the curl verbatim from
   `workers/sync-hub/DEPLOY.md:100-104`** — do not hand-write the auth header.
   It calls `POST /internal/v1/projection/drain` with the
   `CMEM_INTERNAL_PROJECTOR_SECRET` bearer and an optional `through_seq` cap.
3. Confirm convergence per user via `GET /v1/sync/status`.

**Verification checklist**
- [ ] For each repaired user, `projected_seq === head_seq`.
- [ ] A subsequent client push returns **200**, not 503.
- [ ] On at least one real account, `/api/sync/status` shows `lastFlushAt`
      becoming non-null and `pending.*` reaching 0.

**Anti-pattern guards**
- Do **not** use `POST /internal/v1/sync/reset` (`DEPLOY.md:180-185`). It wipes
  the user's entire ordered log and mints a fresh epoch. It is pre-launch-only.
- Do not tell users to restart their worker repeatedly. Each restart buys
  exactly one batch and resets a backoff that exists to respect the lease.

---

## Phase 2: Hub — make the 503 self-describing (additive, zero-risk)

**Goal:** ship the observability needed to answer §0.6 and to let fixed clients
wait correctly. Additive response fields and headers are safe — clients read
named fields and there is no `exactKeys` on public responses
(`exactKeys` applies only to internal request bodies, `index.ts:437/463/483`).

**What to implement**

1. Emit `Retry-After` on `projection_busy`, valued at the **remaining lease
   TTL** (derivable from `projection_lease_expires_at` in the DO `meta` table,
   set at `do/SyncHub.ts:805-807`). Copy the header-setting idiom from the kill
   switch at `index.ts:899` (`X-Sync-Mode`).
2. Structured-log the drain failure **code** that precedes a `projection_busy`
   streak. Today `projection_busy` never names its predecessor, and the only
   `console.error` sites are `index.ts:515` and `do/SyncHub.ts:365`. Log the
   full taxonomy from `index.ts:604-806` (`projection_upstream_timeout`,
   `projection_upstream_unreachable`, `projection_response_mismatch`, …).
3. Add lease-age and lag to the log line so §0.6 Q1 becomes answerable from
   observability alone.

**Documentation references**
- Emit site + failure taxonomy: `workers/sync-hub/src/index.ts:604-806`
- Lease acquire/expiry/CAS: `workers/sync-hub/src/do/SyncHub.ts:636-807`
- Response-shaping idiom: `index.ts:344-363`

**Verification checklist**
- [ ] New test in `workers/sync-hub/test/` asserting `Retry-After` is present
      and ≤ 90 on a `projection_busy` response. **Copy the structure of
      `test/kill-switch.test.ts`** (smallest complete example of the idiom:
      `env` + `SELF` imports, real KV, `beforeEach`/`afterEach`).
- [ ] Reuse the existing reproduction at `test/sync-hub.test.ts:748-780`, which
      already produces a real `projection_busy`.
- [ ] `bun run test && bun run test:ws && bun run lint && bunx tsc --noEmit`
      from `workers/sync-hub`.
- [ ] After deploy, confirm the cron is visible in the dash (`DEPLOY.md` §2.5) —
      `wrangler deploy --dry-run` does not print it.

**Anti-pattern guards**
- Do not change the `projection_busy` **string** or its HTTP status yet — Phase
  3 decides that. Turning a 503 into a 409 flips `retryable` semantics, which
  `DEPLOY.md:90-94` treats as load-bearing.
- Do not add the header to the *degraded* auth-failure 503s
  (`index.ts:267/303`); scope it to the projection family only.
- Do not add outbound I/O to the DO to compute lease age — read it from `meta`.

---

## Phase 3: Hub — stop orphaning leases

**Goal:** the projection lease stops being held for 90 s after a client that is
no longer waiting has disconnected, so the next push finds it free.

**The push contract does not change.** `200` continues to mean
`projected_seq` covers `head_seq` (`DEPLOY.md:90`). That guarantee is what
makes the sync bidirectional — a device may only be told its write landed once
the other direction can actually read it. Do not weaken it, do not add a
`projection_pending` escape hatch, and do not ack un-projected ops.

**Why convergence is already possible without a contract change:** the
checkpoint advances and is persisted **per page**, inside the fenced CAS at
`do/SyncHub.ts:747-762`. Every push therefore keeps whatever projection
progress it made before dying — this is exactly the observed +200 seq per
attempt in the live incident. The backlog does converge; it converges at one
batch per backoff period because of the lease/timeout/backoff interaction, not
because progress is being lost. Fix that interaction and it converges at full
speed with the guarantee intact.

**What to implement**

1. **Release the lease when the hub knows the attempt is over.** Today
   `releaseLeaseEarly` stays `false` on every failure path
   (`index.ts:643/705`, released only at `:803-805`), so all of
   `projection_upstream_unreachable` (`:727`), `projection_response_not_json`
   (`:757`), `projection_response_mismatch` (`:768`) and
   `projection_page_too_large` (`:691`) hold the full 90 s. Those are
   **terminal, locally-decided outcomes** — the upstream is not still working
   on anything. Release early for that class.
2. **Keep holding it for the genuinely ambiguous class.** `projection_upstream_timeout`
   (`:719`) and an aborted in-flight fetch must still retain the lease: per
   `DEPLOY.md:79-84` the Pro handler may have ignored cancellation and may still
   be applying. Do not "fix" this one.
3. **Detect client disconnect** via `request.signal` and, on abort, release the
   lease only if no upstream fetch is in flight. This is the case that produced
   the live incident: the client's 30 s abort (`CloudSync.ts:417`) always fires
   before the hub's 45 s projector deadline (`projection-protocol.ts:5`).

**Documentation references**
- Lease acquire / expiry / CAS-fenced advance: `workers/sync-hub/src/do/SyncHub.ts:636-807`
- Full failure taxonomy and the `releaseLeaseEarly` flag: `index.ts:604-806`
- Why the ambiguous class must keep the lease: `DEPLOY.md:79-84`
- Lease-retention-on-failure matrix (existing test): `test/sync-hub.test.ts:497-525`

**Verification checklist**
- [ ] Extend the retention matrix at `test/sync-hub.test.ts:497-525`: each
      terminal failure releases the lease; `projection_upstream_timeout` still
      retains it for the full `PROJECTION_LEASE_MS`.
- [ ] Hub test: a push that 503s and releases early is followed **immediately**
      by a push that acquires the lease rather than getting `projection_busy`.
- [ ] Hub test: `200` is still returned only when `projected_seq >= head_seq` —
      assert no response path acks un-projected ops.
- [ ] The fenced CAS at `do/SyncHub.ts:747-762` is unchanged.
- [ ] `npm run e2e:sync-matrix` — real client stacks against the in-repo hub —
      confirms a seeded backlog fully converges.
- [ ] Full hub gate: `bun run test && bun run test:ws && bun run lint && bunx tsc --noEmit`.
- [ ] Canary logs `"converged":true,"sync_mode":"live"` post-deploy (`DEPLOY.md` §4).

**Anti-pattern guards**
- Do **not** bump `protocol_version` to 3. Both ends do exact `!== 2` equality
  (`index.ts:330`, `CloudSync.ts:609`, `SyncClient.ts:553`); a bump instantly
  400s every installed client.
- Do not change `{"error":"device_limit_exceeded"}` — documented stable body.
- Do not make any decimal field a JSON number; clients run
  `assertCanonicalDecimal` and throw (`CloudSync.ts:619`, `SyncClient.ts:556`).
- Do not remove or rename `X-Sync-Mode`, and do not emit it on degraded paths —
  `SyncClient.ts:540-544` explicitly guards against exiting poll mode on a
  header-absent degraded response.
- There is **no rollback**. Ship behind the kill switch drill
  (`DEPLOY.md:296-302`) and be ready to `wrangler deploy` the previous commit.

---

## Phase 4: Client — retryable-aware drain and honest backoff

**Goal:** a client that degrades gracefully against *any* hub back-pressure,
not just this one. Ships in the next release.

**What to implement**

1. **Raise `requestTimeoutMs` above the hub's projector deadline.** Default is
   30 s (`CloudSync.ts:417`) against a hub that may legitimately work for 45 s
   (`projection-protocol.ts:5`). This mismatch is what orphans leases. The new
   default must exceed the hub's per-page deadline.
2. **Parse the error envelope.** On `!res.ok` the client currently does
   `res.text()` and truncates to 200 chars (`CloudSync.ts:967-970`). Parse the
   JSON and read `retryable` / `durable` / `head_seq` / `projected_seq`, which
   the hub has always sent (`index.ts:350-358`). Honor `Retry-After` from
   Phase 2 instead of the blind doubling ladder.
3. **Reset backoff on partial progress.** `resetBackoff()` currently has one
   caller on the all-clean path (`:533`). **Copy the per-page reset pattern from
   the pull lane, `src/services/sync/SyncClient.ts:576-579`**
   (`failStreak = 0; failCursor = null; backoffMs = 0;` after each applied page)
   — the push lane needs the same shape after each acked batch.
4. **Add partial-progress bookkeeping:** `lastProgressAt` and an ops-acked
   counter, so a slow drain is distinguishable from a wedge.
5. **Fix the mutation-lane quarantine bug (data loss, independent of this
   incident).** `await send()` at `CloudSync.ts:823` sits inside the per-row
   `try` whose `catch` at `:828-831` calls `quarantineMutation`, which
   **DELETEs the row and dead-letters it** (`:1376-1392`). An HTTP 503 on a
   mid-page flush therefore dead-letters an innocent, unrelated mutation with
   the HTTP error as its "reason". Move the send outside the per-row try, or
   classify transport failures as non-quarantinable. The end-of-page send at
   `:833` is already correct — copy its placement.

**Documentation references**
- Per-page backoff reset precedent: `src/services/sync/SyncClient.ts:576-579`
- Wedge-visibility logging precedent: `src/services/sync/SyncClient.ts:872-899`
  (`failCursor`/`failStreak` → "Pull wedged: the same page keeps failing")
- Partial-progress/watermark precedent: `src/services/sync/ChromaSync.ts:768-806`
- Throw site to change: `src/services/sync/CloudSync.ts:967-970`

**Verification checklist**
- [ ] New tests in `tests/worker/sync/cloud-sync.test.ts` (bun:test; root
      `npm test` → `bun test tests`). **Use `makeFetchMock` at `:86-123` — the
      per-call failure-injection seam** — with the idiom at `:1288-1290`
      (`makeFetchMock(call => call === 1 ? new Response(...) : undefined)`).
- [ ] Adapt `makeErrorFetch(mode, status = 503)` at `:1475-1482`, replacing the
      plain `'hub down'` body with a real
      `{"error":"projection_busy","durable":true,"retryable":true}` envelope.
      Today no test ever sends that JSON shape.
- [ ] **The missing coverage that would have caught this:** a multi-batch
      backlog where batch *k>1* fails. Extend the 450-row/3-POST case at
      `:513-528` (`calls.map(c => c.parsed.ops.length)` → `[200,200,50]`).
- [ ] Assert backoff is **not** doubled when a flush made partial progress.
- [ ] Assert `ackDurabilityState()` (`:279-301`) is unchanged for any batch that
      was not acked — the livelock guard at `CloudSync.ts:23-31`/`:39-41` must
      survive.
- [ ] Mutation-lane test: a transport failure mid-page must **not** create a
      `sync_dead_letter` row.
- [ ] `npm test` and `npm run typecheck` green.

**Anti-pattern guards**
- Do **not** stamp rows as synced on a `durable: true` 503. The 503 carries no
  per-op acks, so there is nothing to stamp against; the livelock guard depends
  on forward progress coming **only** from acks. Re-push is safe and cheap —
  idempotent replay reuses the sequence (`do/SyncHub.ts:412-428`).
- Do not add a second retry ladder alongside `scheduleRetry()`; there are
  already two independent triggers (`notify()` debounce at `:488-497` and the
  backoff timer), and `notify()` is **not** gated by `retryTimer`.
- Do not touch `protocol_version`.

---

## Phase 5: Client — make the status route tell the truth

**Goal:** `/cloud-sync` and the dashboard can distinguish draining from wedged.
This is the gap that made the live incident take an hour to characterize.

**What to implement**

Extend `CloudSyncStatus` (`CloudSync.ts:335-350`, built at `:547-563`) with:
`lastProgressAt`, `flushing`, `nextRetryAt`, and the live (non-tombstone)
`sync_content_outbox` count — today only `deleted = 1` rows are exposed
(`countPendingTombstones`, `:1300-1308`), so a backlog sitting in the content
outbox is invisible while `pending.observations` reads 0.

Then update `plugin/skills/cloud-sync/SKILL.md` §5 so the reported outcome
distinguishes the three states, and stop implying `lastFlushAt: null` means
failure — with a backlog it is expected for a long time.

**Documentation references**
- Status builder: `src/services/sync/CloudSync.ts:547-563`
- Route: `src/services/worker/http/routes/CloudSyncRoutes.ts:20-34`

**Verification checklist**
- [ ] Update `tests/worker/http/routes/cloud-sync-routes.test.ts` — the full
      `CloudSyncStatus` literal at `:64-80` **will fail** if fields are added.
      Copy the scaffolding at `:10-46`.
- [ ] Manual: on a seeded backlog, the route reports non-null `lastProgressAt`
      while `lastFlushAt` is still null.

**Anti-pattern guards**
- Keep the token redaction in `probeHubStatus` (`CloudSync.ts:634-635`).
- Do not make the status route mutate or advance sync state — it is
  read-only by contract (`CloudSyncRoutes.ts:31-32`).

---

## Phase 6: Verification and release

1. **Hub**, from `workers/sync-hub` — the §8 block verbatim (`DEPLOY.md:481-490`):
   ```sh
   bun install --frozen-lockfile
   bun run test && bun run test:ws && bun run lint && bunx tsc --noEmit
   wrangler deploy --dry-run
   wrangler deploy
   ```
   Then: cron visible in dash (§2.5), threshold rehearsal once (§5), canary
   logging `"converged":true,"sync_mode":"live"` (§4).
2. **Client:** `npm test`, `npm run typecheck`, `npm run e2e:sync-matrix`, then
   `/claude-mem:version-bump`. Note **eight** files carry the version string,
   and `npm run build-and-sync` (not plain `npm run build`) is required for
   release validation.
3. **Anti-pattern grep** — CI runs the DO anti-pattern grep at
   `.github/workflows/ci.yml:66-82`; confirm green.
4. **Real-account proof:** on an account that was stuck, confirm
   `pending.*` → 0, `lastFlushAt` non-null, `lastError` null,
   `projected_seq === head_seq`.
5. **Regression watch:** the projector-lag alert is a *planned but
   unimplemented* item (`plans/2026-07-22-cmem-launch.md:104`;
   `src/watchdog.ts` monitors only requests/duration/rowsRead/rowsWritten).
   Consider adding it here so the next occurrence pages someone instead of
   waiting for a customer report.

**Release-order constraint:** Phases 2-3 (hub) ship first and independently.
Phases 4-5 (client) ship in the next npm/marketplace release. Do not gate the
hub deploy on the client release — the hub deploy is the only thing that
reaches all paying customers now.

---

## Known gaps carried into execution

- Whether Cloudflare tears down the invocation on client disconnect (§0.6 Q1) —
  decides whether leases genuinely leak. Phase 2's logging answers it.
- The Pro projector's throughput and error modes are **not in this repo**. If it
  is the true bottleneck, the fix belongs in `claude-mem-pro` and Phase 3 only
  masks it.
- Whether Pro's scheduled repair job runs, and how often (`DEPLOY.md:97-105`).
- `PLAN-postgres-to-turbopuffer-cutover.md` is in `claude-mem-pro`; its
  projection-payload contracts are binding and unread here.
- npm publish is contradictory in-repo: `version-bump/SKILL.md` says human-only,
  while `.github/workflows/npm-publish.yml` auto-publishes on `v*` tag push.
  Resolve before tagging.
- The v47/v48 launch baseline permanently excludes pre-launch local rows from
  push and from epoch-rebuild replay unless edited
  (`src/services/sqlite/SessionStore.ts:736-830`). A large `pending` count on a
  fresh connection is therefore *post-baseline* work and worth explaining to
  affected users.
