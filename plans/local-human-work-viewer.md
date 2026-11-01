# Local human work viewer

## Primary goal
Opening the local claude-mem viewer shows understandable human requests, recorded progress, and a clear place to review finished work or pick up a handoff. It works without an account, and optional cloud connection links lead into the existing setup.

## Phase 0: Documentation discovery
**How this serves the primary goal:** Establish actual worker, data, build and connection APIs before changing the default viewer.

Read: src/services/worker/http/routes/ViewerRoutes.ts (existing /, /stream, static serving); DatabaseManager.ts (getConnection); request-auth-helpers.ts (isLocalhost, hasLoopbackHostHeader, hasForwardedClientHeaders); src/shared/paths.ts (DB_PATH and DATA_DIR); scripts/build-viewer.js (shipping UI artifacts); docs/public/cloud-sync.mdx (setup via cmem.ai Connect and installer). Proven projection source: cloud app apps/work-state-monitor/{data-source,agent-view,request-projection,view-model}; interaction study under design/live-interactions-v1. Backend discovery and implementation delegated to audit_live_states, UI integration to ship_claude_mem.

Allowed APIs: Express route registration and wrapHandler; Bun SQLite readonly Database and prepare/get/all; locally served EventSource stream; existing sync status endpoint; existing cmem.ai setup link. Never add local raw work writes or cloud calls to construct this view.

## Phase 1: Local data and durable review
**How this serves the primary goal:** Live work is grounded in saved evidence; checked means a human reviewed a specific revision.

Copy the tested projection with Bun readonly adapter. Add /api/work-view snapshot, SSE, evidence and review routes. Store private local review metadata by request identity and a stable substantive-content hash. Validate expected hash on writes; a newer hash requires a fresh review. Preserve source records. Reject nonloopback requests and cross-origin mutations using existing middleware. Include clear stale source health.

Verification: fixture SQLite projection, real writes over SSE, durable checked/undo and hash invalidation, malformed/stale payload and origin rejection. Guards: no heartbeat interpreted as agent activity; no session completion rollup; no secret settings exposed; no generated-copy inference dependency.

## Phase 2: Default human-facing panel
**How this serves the primary goal:** A readable default page makes progress and human next actions visible without hiding the familiar tools.

Copy the approved visual study shell, removing fictional modes/actions. Adapt requests through view-model; ready means explicitly reported done, checked means matching persisted review revision. Retain original request/source disclosure and recorded updates. Defer incoming reordering while reading/scrolled/focused. Keep checked Undo available and handle stale409 by refreshing. Show local connection health separately from optional sync state. Serve legacy viewer at /viewer with navigation. Link Claude.ai and ChatGPT to existing Connect setup without claiming success.

Verification: installed worker API/UI smoke, responsive browser checks, keyboard dialog/focus and updates/checked/reload/undo flows. Guards: no invented assignment/reply action; no synthetic pulse; no remote fonts or required remote dependencies.

## Phase 2b: Optional TeamBrain shared workspace
**How this serves the primary goal:** People can move from personal work to a team's real shared work without losing the local free experience or confusing private and shared records.

Read existing `src/shared/teambrain.ts` membership, credential and timeout helpers; cloud `src/lib/teambrain/{api,cli,work-state}.ts` for exact board schema and consent gates. Use the new authenticated read-only `GET /api/teambrain/cli/board?team_id=` behind the existing cloud sync identity, active-team and membership checks. Reuse cloud `teamBoard` rather than copying its query. Local routes expose only sanitized status and board data; credentials stay in the worker. No cookie forwarding and no automatic sharing. The personal tab makes no new team requests. TeamBoard's open lists/tasks stay labeled shared work and are never converted into invented human requests or local Checked state.

Verify disconnected no-network status, actual bearer/user identity forwarding, board payload validation, permission failure clearing, selected-team response races, hidden-tab polling, reading-safe pending snapshots, exact membership/project scope, narrow layouts and a working link to self-serve setup. Release waits for the cloud endpoint, TeamBrain UI and Stripe purchase path to be verified by the coordinating agent.

## Phase 2c: Bound project-remap sync work
**How this serves the primary goal:** Existing project remaps must drain reliably before people depend on current shared work.

An independent live sync investigation found several large project remaps being sent in one transaction. Send each `remap_project` in its own ordered push, flushing ordinary mutations before and after it. Keep normal mutation batching and immutable canonical bytes. Transport failures must leave every unacknowledged operation queued; only serialization failures belong in quarantine. The cloud SQL optimization is a separate reviewed change.

Verification:263 worker-sync tests passed, including mixed ordinary/remap order, an already frozen remap, content after mutations, failures before/during a remap, exact-byte retries and ACK-only deletion. Root TypeScript/full build passed; independent review reran80 CloudSync tests with no blocking finding.

## Phase 3: Review and full release
**How this serves the primary goal:** Users receive the tested local feature through the normal install/update surface.

Independent code review, relevant tests and all CI; immediately open PR after push, babysit threads, merge updated main. Apply owner-requested major14.0.0 across documented manifests/badge; build-and-sync, tag, GitHub notes, generated changelog, clean-tag npm publication. Existing broken Discord webhook is a separate known followup and is not retried. Verify registry exact/latest, package artifacts, isolated installed CLI and fresh worker UI; observe30min and inspect late CI/reports.

Verification: clean source/tag/package identity, default and legacy paths, local-only mode, no review mutation of source DB, complete CI/review, clean working tree. Guards: no modified published tags, no unverified shipping claims, no token output.

PR review corrections: SQLite `data_version` observes same-row updates made by other connections; hashes cover full linked source evidence without adding raw text to the live payload; lifecycle selection carries canonical time/device/origin-row order, including IDs above2^53; a newly applied TeamBrain snapshot clears any older pending snapshot. Independent route and DOM regressions plus the combined163-test product suite pass. Synced-at-only changes retain a matching human check.

Final real-data correction: explicit needs-input/waiting-on-user/approval aliases share the existing Needs you mapping used by recorded child statuses. Unknown lifecycle values retain the prior fallback. Original goal and next step stay unchanged. Expanded170-test product suite and a read-only live-data projection check pass.

Full Linux CI ran9,506 tests with9,446 passing and58 skipped; its only2 failures were new route integration guards. The route now logs successful review changes without source content and validates loopback authorities before using the shared IPv6 formatter. Same-port IPv6 and malformed-authority regressions pass. Expanded product/route/quality suite:175 passing. Fresh full CI remains required.
