# Viewer performance and synchronization recovery

This document records the implementation contract for the local/cloud viewer recovery work. The source baseline is `d8bf121ae` (4 November 2026). The detailed execution plan is `plans/01-local-cloud-viewer-recovery.md`; its local audit and reproduction artifacts are in `reports/`. Those two directories are ignored by Git, so this tracked document carries the durable developer contract.

The user-visible goal is fast initial loading, consistent shared requests/progress/decisions, and an accurate explanation of download lag or device-only data. A connected event stream is not proof that the cloud replica has caught up.

## Acceptance targets

These are recovery targets to verify, not performance claims about the baseline:

| Workload | Target |
| --- | --- |
| Representative approximately 3 GB fixture, warm first useful local view | p95 at most 500 ms |
| Same fixture, new reader/process | p95 at most 2 seconds locally |
| Hosted first useful view after replica catch-up | p95 at most 3 seconds |
| Approximately 140-request initial overview | At most 300 KiB uncompressed, independent of full evidence size |
| Healthy HTTP-only sync with a visible viewer | Small remote write appears within 30 seconds |
| Supported, connected realtime channel | Small remote write appears within 5 seconds |

Measure at least 20 new-reader and 50 warm trials, plus a four-tab concurrent-write workload. A new reader does not mean the operating-system disk cache was flushed. Report queue wait, SQL/projection work, payload size, browser parse/render, and p50/p95 separately. Do not silently weaken a target or count dropped data as a performance improvement.

After catch-up, two replicas with different SQLite IDs must agree on shared groups, progress, focus membership, rules, reviews, decisions, minimal attribution, and published URLs. Local paths, file availability, process state, setup diagnostics, and activity-age labels are device-specific.

## Verified interfaces and compatibility decisions

| Boundary | Existing contract and required treatment |
| --- | --- |
| Product discovery | [`readProductRecords`](../../src/services/work-view/work-product.mjs) takes `(read, sinceEpoch, limit = 2000)`. Preserve ID-descending results and independent publisher/Git limits. Test missing indexes and old schemas before using index hints. |
| Projection reader | [`WorkViewReadWorkerClient`](../../src/services/work-view/WorkViewReadWorkerClient.ts) exposes `read(maxActivityAgeMs, localDeviceId)` and `close()`. The protocol currently has only `id`, `maxActivityAgeMs`, and `localDeviceId`. Purpose, cancellation, coalescing, diagnostics and rules-only reads are new APIs, not existing options. |
| Write ordering | [`WorkViewRoutes`](../../src/services/worker/http/routes/WorkViewRoutes.ts) has an owner-edit promise chain for rules/focus. Review and suggestion routes do not use that wrapper. Add their serialization explicitly. The suggestion's current decision/write is synchronous before its response snapshot; do not describe it as an existing asynchronous read-check-write guard. |
| Rules | [`buildRules`](../../src/services/work-view/my-rules.mjs) combines saved work-state and ledger story suggestions. A cheaper rules read must retain both inputs and must not overwrite the rules file after an older read. |
| Work-state transport | [`SessionStore.appendWorkStateEntry`](../../src/services/sqlite/SessionStore.ts) persists primitive fields and emits context invalidation; the injected writer also calls `CloudSync.notify()`. Preserve that durable-write-before-notification order. |
| Sizes and types | Public [`WorkStateRoutes`](../../src/services/worker/http/routes/WorkStateRoutes.ts) accepts nonempty primitive fields, finite numbers (fractional values are allowed; integers must be safe integers), and at most 2,000 characters of fields JSON. Internal append has no equivalent size cap. The canonical body has a separate 256,000 UTF-8 byte cap. New internal schemas require explicit bounds; never use this difference to accept an unbounded ledger upload. |
| Canonical envelope | [`CanonicalContent`](../../src/services/sync/CanonicalContent.ts) supports observation, summary, prompt and work_state. Work-state permits only created_at, created_at_epoch, fields, list_name and project. Local, sync-api and legacy-hub validators must remain compatible. Prefer versioned reserved work-state subtypes over new top-level fields. |
| Shared identity | Use conversation/platform/content-session keys, deterministic group IDs and canonical origin identities. SQLite numeric IDs and local evidence URLs are not portable. Normalize original-request, human-copy and review fingerprints consistently. |
| Shared generations | Current local ledger files are not transactional across files or sync pages. Define bounded records and coherent activation before switching writers; retain the last complete generation when a newer one is incomplete. Deploy compatible readers before emitters. Broad `work_state` capability does not advertise support for new subtypes. |
| Generation disabled | [`HumanCopyWorker.observe`](../../src/services/work-view/human-copy-worker.mjs) hides cached copy when the provider is explicitly off. Hosted generation stays disabled; displaying validated shared copy requires a separate consumption path. |
| Pull health | [`SyncClient`](../../src/services/sync/SyncClient.ts) exposes pullOnce, onHeadSeq, isPollModeOnly, isSocketLive and isRealtimeCaughtUp, but no complete status snapshot. Add an observational public snapshot and inject it into the HTTP route; do not reach into private fields. |
| Status side effects | [`CloudSync.statusWithHubProbe`](../../src/services/sync/CloudSync.ts) can change auth/retry state and schedule a flush through its probe. Separate observational status from recovery-triggering lifecycle calls. A status GET must not advance a cursor, upload, repair or resume synchronization. |
| Realtime | The checked-in client requests `/v1/sync/realtime-token`; [`sync-api`](../../services/sync-api/src/index.ts) currently exposes ops/changes/status and legacy ws, not that token route. A 404 intentionally falls back to polling. Production routing remains unverified. Meet the HTTP target and report the actual mode; do not infer realtime from a setting. |
| Auth errors | Reuse [`classifySyncAuthFailure`](../../src/shared/sync-health.ts): an HTML proxy/WAF 401/403 is a retryable transport failure, not necessarily invalid credentials. Pull currently classifies by error text and needs the same structured distinction. |
| Apply and notifications | [`SyncApply`](../../src/services/sync/SyncApply.ts) commits applied rows and cursor together, then emits context invalidation. Feed notifications must follow that commit and remain cheap. Existing invalidation metadata has no affected lists/revisions. |
| Upload fairness | Preserve immutable outbox bytes, one flush owner, required mutation order and higher-revision rules. Fair turns must include both native-row drains and already-frozen `sync_content_outbox` entries. |
| History and conflicts | No public selective backfill or arbitrary conflict-repair API exists. Preserve exclusions/heads/cursors. Preview selected native history and use resumable jobs. A repair needs authorized origin ownership and a revision/precondition checked against current authoritative hub and replica state; local revision knowledge alone is insufficient. |
| Hosted writes and files | [`viewer gate`](../../services/viewer-host/src/gate.ts) broadly permits authenticated reads except blocked prefixes, but write routes are explicitly allowed and origin checked. Keep generic state/path uploads blocked. Replicate safe published URL metadata; label local files origin-only. The media attachment resolver is not generic file storage. |

The source checks above were repeated for Phase 0. In particular, the status-probe side effect, realtime mismatch, disabled-copy display behavior, and missing review owner wrapper are baseline facts, not regressions introduced by this work.

## Dependency and verification recipe

The repository deliberately does not commit a root npm lockfile. Follow [CI](../../.github/workflows/ci.yml):

```sh
rtk npm install --no-audit --no-fund
rtk npm run typecheck
```

Run this in `src/ui/my-work`, which has a committed npm lockfile:

```sh
rtk npm ci --no-audit --no-fund
rtk npm run build
```

The service Bun lockfiles use version 2. Use Bun 1.4 or a compatible newer runtime; the images currently use `oven/bun:1.4-debian`. If the system Bun is older, a task-local npm execution avoids replacing it:

```sh
rtk npm exec --yes --package=bun@1.4.0 -- bun --version
```

Run the following from each of `services/sync-api` and `services/viewer-host`:

```sh
rtk npm exec --yes --package=bun@1.4.0 -- bun install --frozen-lockfile
```

Do not regenerate committed lockfiles or upgrade manifest ranges to work around a local installation problem. An `--ignore-scripts` root install may supply JavaScript test dependencies when native compilation is unavailable, but it is a partial setup: report unbuilt native dependencies and do not call the full integration environment ready.

Useful root checks for the next phases (Bun 1.4 can be invoked through the task-local prefix above):

```sh
rtk bun test tests/worker/work-view/data-source-polling.test.mjs tests/worker/work-view/work-product.test.mjs tests/worker/work-view/work-product-git.test.mjs
rtk bun test tests/worker/http/routes/work-view-routes.test.ts tests/worker/http/routes/work-view-rules-routes.test.ts tests/infrastructure/work-view-reader-packaging.test.ts
rtk bun test tests/worker/sync/cloud-sync.test.ts tests/worker/sync/cloud-sync-health.test.ts tests/worker/sync/sync-client.test.ts tests/worker/sync/sync-client-realtime.test.ts tests/worker/http/routes/cloud-sync-routes.test.ts
rtk bun test services/viewer-host/test src/ui/my-work/src/live src/ui/my-work/src/setup src/ui/my-work/src/store
```

The final integration pass additionally runs the root build, test-lane coverage/fast/integration checks, My Work build, sync-api Postgres suite, and `scripts/sync-matrix-e2e.ts`. Copy its loopback-only transport and synthetic account guards. It requires an isolated test Postgres database; do not substitute production credentials. The legacy Cloudflare hub has a separate test runner.

For a baseline UI build without replacing committed assets, use this from `src/ui/my-work`:

```sh
rtk npm run build -- --outDir ../../../reports/phase0-my-work-build
```

## Rollout constraints

1. Land and verify compatible readers/status/gate behavior before new shared-state writers.
2. Keep prior complete shared generations and additive DTO compatibility for rollback.
3. Keep cloud automatic classification and copy generation disabled; consume the origin's shared result.
4. Compare built artifact versions and the deployed replica's epoch/cursor/head before claiming the production problem is fixed.
5. Live deployment, selected historical upload and conflict authority decisions require the concrete scope and rollback evidence specified in the plan. Phase 0 performs none of them.
6. Never reset the account, erase launch exclusions, clear revision heads, impersonate another device, or replay redacted quarantine text as canonical bytes.

## Phase 0 environment result

On the initial recovery checkout, root typecheck and an isolated My Work production build pass after installing dependencies. Service frozen installs pass with task-local Bun 1.4.0; system Bun 1.3.9 rejects lockfile version 2. The normal root install fails on native tree-sitter compilation with the local SDK/toolchain, while an explicit scripts-disabled install supplies the viewer/sync JavaScript dependencies. Native integration readiness remains a separately recorded limitation.

Authenticated hosted inspection is still unavailable without a Fly access token. This does not block local implementation or synthetic verification, but actual deployed routing, cursor/head, keep-pulling configuration and canary parity remain mandatory Phase 9 checks. Per-command baseline results and subsequent phase completion are recorded in the ignored `reports/viewer-sync-execution.md` handoff, not inferred from this contract.

## Phase 1 implementation

The following APIs supersede their Phase 0 baseline descriptions above. Scheduling, freshness and returned projection content are unchanged.

- `readProductRecords(read, sinceEpoch, limit = 2000, { database } = {})` accepts an optional reader database. It caches only verified non-partial timestamp-index definitions per connection. A positive cutoff is not enough to force an index: each read samples at most 128 latest IDs for product density, then probes a bounded timestamp range for sparse candidates. Dense matches or broad ranges retain SQLite's planner choice, as do zero cutoffs and missing/incompatible indexes. Result order remains ID descending, with independent publisher/Git limits.
- `WorkViewReadWorkerClient.read(maxActivityAgeMs, localDeviceId, purpose = 'snapshot')` adds an optional fixed-purpose label. Runtime values outside the fixed set become `snapshot`. `getDiagnostics()` returns current/high-water pending counts, completed/failed counts and one copied last-read sample; it retains no unbounded history, source content, paths, row IDs or errors.
- `GET /api/work-view/diagnostics` uses the existing loopback guard and `Cache-Control: no-store`. It reports the reader sample, latest snapshot postprocessing duration and latest HTTP/SSE write duration/bytes. The endpoint itself does not read SQLite or change read counts. HTTP write duration includes the existing JSON serialization/send; SSE byte size includes framing and can describe a heartbeat rather than a full snapshot.
- Queue wait is the client-side interval from enqueue to receipt of the worker's started notification, including startup/dispatch. Worker-local read duration and client round-trip duration use their own monotonic clocks; the measurements can overlap slightly and are not an exact sum. This avoids comparing Bun's realm-local `hrtime` origins. Duration values are clamped to finite values between zero and one day. No second JSON serialization is performed just to collect payload size.

The maintained benchmark defaults to a temporary synthetic database and reports aggregate timing, counts, plans, and row/order equality only:

```sh
rtk npm exec --yes --package=bun@1.4.0 -- bun scripts/benchmark-work-view.ts --output reports/work-view-benchmark.json
```

Its defaults are 100,000 historical rows per table, 256-byte payloads, 140 recent requests, three new-reader trials and ten warm trials. The recorded Phase 1 fixture was approximately 77 MB, not the approximately 3 GB acceptance workload. Increase `--rows`, `--payload-bytes`, `--cold-runs` and `--warm-runs` for representative verification. Explicit `--db PATH` selects a real database read-only; `--ledger PATH` is optional. The report output cannot overwrite the database, its sidecars or their existing filesystem aliases.

The synthetic result confirms query behavior, not the production latency targets: positive-cutoff publisher/Git/file-query median times fell from about 12.76/20.03/12.75 ms to 0.19/0.20/0.24 ms with identical rows/order. The new-reader sample had p95 82.93 ms and warm p95 6.22 ms on that small fixture; full large-data/browser acceptance remains Phase 9 work. The all-history comparison retained the original plans.

Phase 1 combined verification passed 93 tests across eight files, plus root/viewer typechecking. Adjacent CJS reader packaging passed. The previously recorded standalone executable baseline failure was not rerun or declared fixed; live data, the installed worker, manifests and lockfiles were untouched.

### Query selectivity correction after independent review

Review found that forcing the time index for every positive cutoff made dense broad reads slower. The corrected selection uses the actual range and a bounded recent-ID sample on each read, not a cached workload decision. If at least one quarter of sampled recent rows match the product predicates, it retains the normal plan. Otherwise it considers at most four requested pages (capped at 8,192 candidate rows), additionally bounded by half the sample-estimated ID scan. The limited index count stops at the budget plus one; it never counts the whole history. Missing product columns use the existing legacy fallback, while unrelated database errors still propagate.

The benchmark now derives its work window exactly as `readAgentRecords` does: the oldest of the latest 240 list/task update times minus five seconds. It reports bounded candidate counts, total discovery time including the policy probes, and optional dense positive-cutoff workloads (`--dense-rows N`). Output-path protection is independently verified before opt-in read-only database runs.

On the original approximately 3 GB database, a read-only sample with 6,653 candidate tool rows and 2,531 candidate observations preserved full results/order and reduced median total product discovery from 927.09 ms to 26.74 ms including selection. Individual query medians were publisher 537.04 → 9.38 ms, Git 270.87 → 13.65 ms, and modified files 167.16 → 3.65 ms. One new-reader sample took 694.19 ms; this single sample does not establish the p95 target.

Dense positive-cutoff synthetic cases retained the original query plans: 50,000 rows measured 1.40 → 1.45 ms median total discovery, and 200,000 rows measured 2.04 → 1.46 ms, including bounded probes. These paired samples have runtime noise; the important regression guarantee is unchanged SQL plan/result ordering rather than a wall-clock assertion. Tests also cover a dense 3,000-row bounded range and a sparse 6,000-row range above the result limit.

## Phase 2 implementation

### Compact reads and detail

The full `GET /api/work-view` and its legacy `work-view` SSE event remain available. New clients use:

- `GET /api/work-view/overview`: `{version:1, revision, generatedAt, source, model}`. The mapped model preserves card status, progress, authoritative content fingerprints, focus/rule information and card deliverable counts. Detail-only arrays are omitted on the wire; the shared `expandWorkViewOverview` helper supplies empty arrays to the existing UI model. Titled cards omit unused terminal text; agent-only cards retain their last four lines. Three card deliverables are included with an exact total count.
- `GET /api/work-view/events?view=overview`: `work-view-overview` events with the same envelope, plus the existing heartbeat/setup events. These clients never receive the large legacy `work-view` payload. Time-based display labels can refresh once per minute without implying a new source-data check.
- `GET /api/work-view/requests/:id?fingerprint=<expected content hash>`: `{version:1, revision, request}` with the complete mapped request. Missing/deleted requests return 404; mismatched fingerprints return 409 plus the current overview. An optional `revision` query is available for strict whole-snapshot callers, but the UI uses the per-request fingerprint so unrelated changes do not invalidate a detail read. No arbitrary file path is accepted.

My Work joins its first overview SSE response for initial loading, with a bounded ten-second HTTP fallback. Reads and JSON parsing have a twenty-second deadline, obsolete requests are aborted, and older-worker overview 404s retain the legacy full API fallback. Healthy compact streams use the server's minute-based display updates without periodic HTTP reads; stale, reconnecting or unavailable streams use an HTTP fallback at most once per 120 seconds. The selected drawer loads full detail lazily, retains at most eight fingerprint-keyed entries, bounds retries after a 409, and cancels work on close. Every accepted model advances the response fence, so delayed overview, detail-conflict, save and review responses cannot replace newer data. A closed or changed selection cannot publish a stale conflict or deletion refresh. Review fingerprints always originate from the full server projection, never the compact response.

### Reader and ordering

`WorkViewReadWorkerClient.readRules(localDeviceId)` uses a typed rules request. `WorkStateSource.readRules()` selects only `my-rules` rows and reads the story file that supplies suggestions; it performs no tool/product, prompt, activity-signature or evidence-hash query. An unreadable source/story returns unavailable health, so it cannot overwrite the rules file with an empty successful view.

Concurrent compact HTTP/SSE bootstrap calls share only a pending read under the same committed-context generation, owner-edit fence, ledger file signature and generated-copy revision. The latter two cover local writers outside the HTTP handler without a database scan. Completed results are not retained by this coalescer. Legacy full reads and after-write reads remain independently fresh and ordered; arbitrary external SQL writes without a process notification still use the normal full-read path. Snapshot enrichment clones the reader result before modifying fingerprints/reviews. The owner-edit chain includes reviews, suggestion decisions and owner-marked agent completion, and fences new bootstrap readers at both entry and settlement so reads started during a save cannot be reused afterward.

Committed content invalidations may now carry optional `{kinds, workStateLists}` metadata. Native work-state writes and applied sync pages provide it; unknown/older notifications retain conservative behavior. Known unrelated sync pages do not rebuild rules. Relevant rebuilds collapse while running into at most one follow-up, and use the cheap rules reader. Known content changes and removal/remap invalidations send an ordered activity-cache invalidation and request one coalesced publication; removal/work-state changes also invalidate reduced state. Unrelated database commits still use the existing 120-second activity window. Owner edits publish their completed result rather than mid-write states.

Hook prompts, native prompts, transcript imports and direct prompt imports emit typed prompt invalidation after a successful owned commit. The inner prompt insert of a native receipt transaction does not emit; the native method emits once after commit. Duplicates, private transcript prompts and failed writes do not emit. Methods called inside a larger transaction defer notification to that transaction's owner rather than publishing rows that may still roll back. Existing production prompt entry points own their commit boundaries; the bulk import route retains its final import/remap notification.

The reader diagnostics remain bounded and retain their Phase 1 clock semantics. No SQL projection moved onto the HTTP thread, and no queue cap rejects an already-saved edit.

### Phase 2 evidence

Backend verification covers full legacy reads, request detail success/404/409, four concurrent compact HTTP/SSE clients sharing one read, post-commit fences, relevant-only rules scheduling, real held locks, stale writes, strict loopback reads and cache invalidation. The 140-request fixture has over 5 MB of raw detail and stays below 300 KiB as an overview. A separate read-only sample of the active approximately 3 GB database had 138 requests and measured 3,427,545 raw bytes versus 294,017 overview bytes, with 895 ms for source read/mapping. That sample excludes the optional generated-copy cache and is not a browser or p95 claim.

The initial backend/sync group passed 139 tests across eight files. After review fixes, the expanded backend/native/import group passed 216 tests across twenty files, including held enriched reads before/during review, suggestion and agent-finish writes, external ledger/copy changes, and prompt commit/rollback invalidation. Root typechecking and diff checks passed. Frontend and final integrated checks are recorded in the execution checkpoint. The installed worker, live database and deployments were not changed.


## Phase 3 sync evidence and viewer activity

- `SyncClient.status()` is a public observational snapshot of started/in-flight/suspended/auth state, attempt/success/error timestamps, next scheduled retry, epoch/cursor and actual transport/catch-up state. Sequence values remain decimal strings. `setViewerActive(boolean)` wakes an idle loop through its scheduler, respecting authentication pause, transient backoff and minimum pull gaps; renewals do not force a request.
- `CloudSync.statusWithHubProbe()` now observes only. The shared fetch updates sanitized probe evidence, while existing lifecycle callers separately own auth pause/recovery and flush scheduling. A public status read does not upload, repair, advance a cursor or resume a paused queue.
- `ViewerSyncService` composes the existing upload fields and the new pull evidence as nested `sync` in `/api/sync/status`. Unconfigured status remains `{configured:false}`. Overview, full snapshots and heartbeats carry optional `sync`; both streams can receive `sync_status` without rebuilding content. The service shares one network probe at most every 30 seconds in passive use, refreshes local upload counts on committed-change invalidation or after five seconds, and caches historical eligibility counts for five minutes. A completed network probe merges only its remote evidence into fresh local state, so a queued local write cannot disappear from the status while that probe is in flight.
- Historical inventory runs in a dedicated read-only worker instance using the existing packaged reader entrypoint. It never enters the work-view projection queue or blocks HTTP; status reports unknown scope until its result arrives. Worker shutdown settles and terminates any owned inventory read.
- `ViewerSyncStatus` includes `checkedAt` (last hub evidence) and `observedAt` (server composition clock). Fresh matching hub head plus a completed prior pull may confirm a quiet realtime replica even while its safety poll sleeps; an open socket alone never does. Unknown epochs, stale evidence, pending operations, paused or failed downloads and quarantines remain distinguishable. Historical exclusions are scope information rather than an assertion of independently measured missing cloud rows.
- `/api/work-view/activity` is an origin-guarded local-only POST with `{viewerId, visible, sequence}`. A 45-second monotonic lease is renewed by visible local tabs; higher per-tab sequence wins, including short-lived invisible tombstones. The map is bounded to 256 leases. Hosted pages do not send this route: their worker independently keeps pulling, and the gate write allowlist is not expanded.
- `source.activityCheckedAt` records actual activity inspection and does not renew on a cached read; `source.lastCheckedAt` still describes the database-read check. Consumers must not confuse those clocks.
- Pull and realtime-grant errors use the shared HTML-versus-credential classifier before clipping display text. HTML proxy 401/403 remain retryable transport failures. A token endpoint 404 remains supported polling-only operation; this change does not add or assume a new server endpoint.

- `keepPullingOptions(true)` is the tested worker wiring for replica-only operation: idle HTTP polling every 30 seconds plus no inactivity suspension. With the option off, normal five-minute idle cadence and one-hour suspension remain. This is necessary because a hosted worker has no local sessions and does not receive local visibility leases.

## Phase 4 memory-feed recovery and retained history

`MemoryFeedInvalidation` bridges committed context notifications to the classic JSON SSE stream with `{type:"data_changed", kinds?, projects?}`. Missing kinds means every memory feed; missing projects means all scopes. Known observation, summary and prompt writes are selected, while health/settings and explicit work-state-only events are ignored. Mutations and unknown SyncApply recovery conservatively invalidate all memory kinds. The fixed 100 ms coalescing window does not keep resetting during continuous writes; project accumulation widens to all scopes after 128 keys. The owned bridge starts before asynchronous initial sync and clears its timer/subscription during shutdown. These are invalidation hints, not durable replay cursors.

The real viewer consumes invalidation and stream reconnects by rereading authoritative HTTP pages. Scope hints are advisory because aliases, merges and linked-session repairs can affect differently named filters. Its refresh state tracks the current visit and content generation, aborts obsolete reads, and preserves successful sibling streams when another stream fails. Each stream retains its previous oldest `(created_at_epoch,id)` boundary when refreshing, so new rows or deletions near the front do not silently discard already loaded history or shift the next offset past unseen rows. A ten-second deadline covers fetching and body parsing; failures keep the old cursor and release loading. Refresh loops and page counts are bounded, and repeated invalidation during reads becomes a visible retry state rather than an unbounded request storm.

“Refresh latest memories” deliberately resets to the newest page and tells the user that older history can be loaded again. Ordinary reconnect/data refresh keeps the loaded boundary. Live arrays are separately deduplicated and capped at 200 rows per kind; successful authoritative reads retire only live rows captured before that read, preserving events that arrived during it. Deletion generations prevent old requests from restoring removed rows.

Session/project catalogs refresh alongside content. `useSessionCatalog.refreshLoaded(project)` now retains the loaded session identity/time boundary instead of replacing it with the first 100 sessions. It follows equal-timestamp rows conservatively if the old boundary session was deleted, and keeps later pagination aligned with the retained prefix. Refresh has a ten-second deadline and bounded pages; failure retains the prior catalog and remembers that Retry must repeat a retained-depth refresh. `invalidate()` aborts and retires an older request before a committed remote change refreshes the catalog. Existing `refresh(project)` remains the explicit newest-page replacement path. If retained-depth refresh fails, `refreshFailed` enables the SessionList's “Refresh latest sessions” action; App calls `refresh(project)` only for that deliberate reset, while automatic data recovery uses `refreshLoaded(project)`. Focused catalog verification passed 23 tests, including retained depth, ties, deletions, changed titles, retry and reset. The final full classic-viewer sweep passed 116 tests across 40 files (including the window/card browser regression), and root/classic typechecking plus an isolated production viewer build passed. Focused counts overlap that sweep; independent phase approval remains required.

### Long loaded feeds

Above 500 loaded records, `WindowedFeed` mounts the visible/overscan window and any focused card's nearby keyboard neighbours while retaining the complete underlying item list. Measured row heights and stable keys preserve scroll anchors across prepends, removals, width changes and variable-height content. At the 500/501 threshold, it captures the actual visible row and restores its mounted geometry in both directions, with one consistent manual scroll-anchor owner. The saved anchor remains mounted while a new window's height estimates settle. A newer user, focus or programmatic scroll takes precedence over a previously captured anchor even before its scroll event arrives; automatic clamping after a shorter list renders still preserves the visible row. Observation facts/narrative state and long-prompt expansion are controlled by `Feed`, so they survive virtual unmounts. The header, load-more sentinel and smooth ScrollToTop retain their existing behavior. List positions expose the full loaded count to assistive technology, and a focused card stays mounted when manually scrolled off screen.

A diagnostic three-sample owned-Chrome fixture used production React/Feed and viewer CSS with synthetic observation records. At 5,000 loaded records, the old feed mounted 150,013 DOM elements, reached paint-ready in a median 1,038.9 ms, and had a worst sampled scroll frame of 140.7 ms. After the threshold and pending-scroll repairs, the same fixture mounted 294 elements at deep scroll, reached paint-ready in 49.5 ms, and had an 18.4 ms worst frame; the Chromium JS heap proxy changed from 44.9 MB to 11.5 MB. The 500-record path remains fully mounted and showed bookkeeping overhead (155.5 → 202.2 ms in this sample). These measurements justify windowing large histories but are not final p95, API-latency or total-process-memory claims. Reproduction and before/after results are in the ignored Phase 4 execution artifacts.

Backend tests cover canonical insert/edit/title/remap/delete, rollback, coalescing, bounded scope, shutdown and failed-client isolation. The real Chrome window tests cover retained disclosures, prepend/deletion anchors, deleted-anchor fallback, focused-row retention, next-record Tab order, ScrollToTop and small-feed sentinel behavior. They also cross both window thresholds while scrolled through variable-height cards, with focus inside and outside the list, then wait for later resize/animation-frame corrections. A synchronous refresh after scrolling to the sentinel and a threshold transition that forces browser clamping have separate assertions. App/browser recovery tests cover project/session scopes, missed updates while disconnected, burst coalescing, old-scope cancellation, independent sibling success, bounded repeated invalidation and explicit latest reset. The combined post-repair suite passed 26 tests across nine files, with root/classic typechecking; independent phase gate rechecks remain pending. This section is not a claim that Phase 4 is approved or deployed.
## Phase 5 shared My Work contract

Shared My Work uses the existing canonical `work_state` operation and unchanged primitive-field envelope. The reserved lists are `__my_work_v1:entry`, `__my_work_v1:manifest`, and `__my_work_v1:commit`. The public work-state write route still has its existing 2,000-character limit and refuses all `__my_work_vN:` lists. Generic task/list readers, counts, reduction and SessionStart context omit that reserved namespace, including malformed rows and `includeClosed=true` reads.

### Record identity, ownership and activation

Each entry names a logical kind/key, canonical JSON payload, payload hash, decimal logical revision, previous accepted hash, writer and random batch ID. Its primitive fields are `version`, `record`, `batch`, `writer`, `kind`, `key`, `revision`, `base`, `deleted`, `payload`, and `hash`. The writer must match the canonical operation's origin device (or the durable local device ID for unsent native rows). Local numeric IDs are never portable identities: evidence references use kind/origin-device/origin-row, and sessions use the existing platform/content-session conversation key. Receiving row IDs are resolved only when building local evidence links.

| Logical kind | Key and value | Ownership and deletion |
| --- | --- | --- |
| `group` | Stable `g_…` ID; group metadata, conversation membership and its judge suggestions | One atomic object; named updates replace only this group. Explicit tombstone removes it. |
| `ignored` | Stable conversation key; ignored reason | Independent object, explicit tombstone restores eligibility. |
| `progress` | Stable group ID; complete recorded review/progress fields | Independent of grouping and other groups; explicit tombstone removes it. |
| `story` | `current`; narrative when present, preferences, source and recorded times | Complete story/rule-suggestion value; explicit tombstone removes it. Owner-goals can first create preferences before a narrative exists. |
| `copy` | Stable request ID; normalized-input fingerprint, validated display copy and generated time | Display result only; a tombstone suppresses old shared copy. |
| `exclusion` | Stable origin-prompt reference | Origin-authored eligibility fact; stable prompt ID resolves even after receiving rows are renumbered. |
| `provenance` | Stable conversation key; minimal session, attribution, launch/activity and published-product facts | Captured on the origin. A receiver does not re-author imported facts. Explicit lifecycle work-state rows remain authoritative. |
| `refresh` | Origin device ID; state/reason/agent/result and recorded times | Origin-qualified display only. Never materialized into another device's refresh file or process ownership. |

A changed object increments its highest accepted logical revision, independent of wall-clock time. Equal-revision incompatible values converge by writer and batch ordering and also produce an explicit conflict diagnostic. Distinct groups claiming the same conversation produce a membership conflict: the displayed group is chosen by exact logical revision, binary writer order and group key, while all competing groups remain recorded. Known-file writers use durable expected hashes and refuse stale/conflicted changes; they do not silently settle an owner conflict. The common store supports an explicit expected-hash resolution for a later reviewed action. Editing group A cannot erase progress B: a manifest applies only its named objects, and omitted objects are unchanged. Legacy import creates deletions only for keys previously tracked for that local file.

Publication inserts all entry rows, manifest parts and the final commit marker in one local SQLite transaction. Each manifest reference covers kind/key/revision/payload hash and the complete entry hash; the commit names every part hash and expected entry count. A receiver can see these rows across pages in any order. It activates nothing from that batch until all entries/parts/commit agree and every domain value validates. Invalid or interrupted batches retain the previous complete values, and return invalid/pending diagnostics. Activation is atomic for all objects named in the batch, not for an entire device snapshot. Different objects from different origins remain independent.

Configured redaction runs on origin values **before** their hashes/manifests are built. A receiver may have stricter or different rules. `SyncApply` first verifies the original internal record in memory, then stores the locally redacted value and a local-only hash receipt in `local_shared_work_redactions`. The receipt contains the verified original entry reference and a digest of the complete sanitized fields, bound to the receiving row ID, origin device/row and sync revision. It contains no original text or wire body. Readers verify that receipt before using the original reference for manifest checks; a peer cannot submit a receipt or opt into accepting a hash mismatch. Logical/base hashes remain the verified transport identity, while a separate `valueHash` tracks the locally sanitized value for display refresh and no-op detection. Tampering, bad original hashes, receipt-write failure or redaction of protocol identities fails closed. Generic work-state redaction remains active. The same configured redaction covers local pending materialization and newly generated copy before their file/cache writes.

Rejected operations use the same configured privacy policy across the entire diagnostic boundary. A bounded sanitizer walks object keys, string values and JSON encoded inside strings, including undecodable canonical wrappers, raw bodies and nested `body_json`/`fields`. Credential-key context follows decoded scalars, object wrappers and arrays, so encoding a `SecretAccessKey` value cannot remove its meaning. Quarantine metadata, reasons, returned diagnostics and decoder/apply log messages are sanitized before storage or logging. Traversal is capped at32 levels,50,000 nodes and1MiB strings; exhausted subtrees become a redaction marker. Unchanged safe retry bytes and hashes remain exact. A redacted body or identity is retained for diagnosis with retries disabled, so it cannot be replayed as a fabricated canonical operation. Legacy replay/retry candidates pass this boundary again before use; replay stops when the body, identity, sequence or hash changed and never decodes the unsanitized original. Reason-only sanitization still permits exact safe replay. Cursor advancement remains atomic with the sanitized quarantine insert.

The payload limit is **48,000 UTF-8 bytes per logical object**, at most **512 objects per batch**, **48,000 bytes per manifest part**, **32 parts**, and **128,000 bytes for a serialized internal row**. These are separate from the unchanged canonical envelope bound. Only manifests split; a logical object never silently loses fields or list members to fit. Oversized or semantically invalid files/objects are refused with a file/reader diagnostic while the prior shared state remains. Future splitting of an oversized logical object requires a new reviewed subtype/reference contract; it is not an implicit partial upload.

### Persistence and actual reader paths

`SharedLedgerAdapter` is the compatibility boundary. It commits shared facts plus pending materialization metadata before a known writer renames its JSON file. SQLite table `my_work_file_state` durably stores canonical observed hashes, expected shared hashes, owned keys, pending JSON/deletion and recovery state. Accepted tombstone hashes remain durable after removal, so recreating the same stable key uses the deletion as its base across restarts and peer updates. A restart after the database commit recovers the pending file without importing the old file as a newer decision, including a write that arrived before the first background import. An unexpected concurrent file edit is retained and diagnosed rather than overwritten. Pulled materialization updates those hashes, so subsequent importer passes and restarts do not echo it as native work.

`SharedWorkSync` registers the in-process file hook and starts a separate background worker for legacy import and origin fact capture. It checks file inode/size/mtime and SQLite `data_version` before reading content; unchanged passes perform no canonical, metadata, generation or notification writes. Changed file content uses canonical semantic hashes, so formatting/key order cannot manufacture a new generation. Legacy human-copy changes have their own semantic import trigger and do not wait for new activity. Activity extraction retains the existing bounded reader queries. Heavy import/extraction does not run on the HTTP event loop. Shutdown removes the hook and settles/terminates any pending worker.

| Existing writer | Integrated path |
| --- | --- |
| CLI grouping, progress, story, judge `--apply` | The mutating CLI opens the existing local database, resolves its durable identity and registers the adapter around `writeJsonAtomic`; it does not require worker HTTP. |
| Automatic judge and Join/Not-this grouping writes | The existing `writeJsonAtomic` path invokes the registered DB-first adapter. Shared owner action semantics beyond the underlying grouped fact remain Phase 6 work. |
| Hosted setup group/story output | The same file hook persists the extracted group/story facts before their compatibility files. Existing focus/goal rows already use canonical work-state. |
| Setup agent-written prompt exclusions | The same file hook converts local IDs to stable origin-prompt facts. |
| Automatic refresh | The same file hook publishes only whitelisted origin display fields. PID, locks, owner checks and stale-process repair stay local. |
| Python owner-goals preferences | A v1-capable worker advertises `sharedPersistenceVersion: 1`; the script sends only `story.json` to the loopback/origin-guarded, owner-serialized `/api/work-view/shared-ledger` endpoint. A timeout after acceptance never falls back to overwriting a raw file. Old workers and explicit alternate ledgers use the legacy atomic file path and later import. |
| Generated human copy | The persistence callback commits a validated result before the copy worker accepts it in its local cache. A failed durable write does not publish the copy. |

The actual `WorkStateSource` reader merges complete shared facts before building My Work and My Rules. The rules-only reader selects rules and reserved records in one scoped query without scanning activity. Both full snapshots and compact overview/SSE carry the shared status. Stable evidence/source and stream identities feed copy fingerprints; valid replicated copy renders even when `CLAUDE_MEM_WORK_VIEW_COPY_PROVIDER=off`, with no generation call or queue. Origin qualification is preserved for minimal attribution/launch/finish data without raw `tool_uses`.

Shared product metadata contains only type/title/time and syntactically safe published HTTP(S) URLs. Shared-only validation rejects local/private endpoints, file/media API locators, signed credential URLs and explicit filesystem project paths; ordinary project keys such as `org/repo` survive. Local deliverable paths, raw tool input/output, PIDs, locks, media object keys and credentials are omitted. This is offline validation: it cannot prove a public-looking hostname's access controls or recognize an unmarked secret embedded in a URL path. It creates no hosted download facility.

### Consumer-first rollout and remaining boundaries

`CLAUDE_MEM_WORK_VIEW_SHARED_STATE` defaults to **`false`**. Tolerant readers are always active, but disabled installations create no shared importer/capture worker or file hooks and do not upload reserved native/outbox records. Previously frozen operations remain durable and byte-identical for a later enable; ordinary work-state continues syncing. My Work explicitly says sharing is off rather than claiming complete parity. Enablement is read at worker/CLI startup and requires a restart for the worker.

Rollout order: upgrade the cloud viewer worker and every participating local reader first, verify reserved-record exclusion and generation-off rendering, then enable this reviewed setting on participating origin installations. Existing servers need only their existing canonical work-state capability; `content_kinds` does not prove viewer subtype awareness and never enables emission automatically. An old writer keeps making legacy files, which an enabled new local adapter can import. An old viewer may expose unknown internal rows, so do not enable emitters while such a viewer participates. Future unknown versions stay excluded from generic readers and produce an unsupported diagnostic; they never replace a valid v1 object. Roll back emission by disabling the flag while retaining tolerant readers and durable records.

No historical backfill, live enablement, deployment, conflict authority choice or local-file upload is included here. Immutable internal history is currently read as a namespace scan when its source changes; unchanged polls are cached, but history compaction is not implemented. Publication/transport atomicity is proven with synthetic replicas; actual deployed version/cursor/canary acceptance remains Phase 9. Shared review acknowledgments and cloud action availability remain Phase 6.
