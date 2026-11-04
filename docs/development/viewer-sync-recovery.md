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
