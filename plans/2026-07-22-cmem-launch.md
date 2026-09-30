# cmem.ai Launch Plan — Finish Line

*Created 2026-07-22. This is a consolidation plan: it sequences already-validated work (open PRs, the frozen Turbopuffer cutover plan, the audited funnel spec) into phases executable via `/do` in fresh sessions. Each phase is self-contained. State was verified live on 2026-07-22 (PR states, deploys, DB health, test counts).*

## Repos and locations

- **claude-mem** (plugin + sync hub): worktree `/Users/alexnewman/.superset/worktrees/df8069a7-eb08-4626-9d3d-918d1e12eb9f/freckle-nail`, branch `feat/phase5-two-lane-sync`, remote `thedotmack/claude-mem`. Hub worker in `workers/sync-hub/`.
- **claude-mem-pro** (cmem.ai): `~/Scripts/claude-mem-pro` (currently checked out on `codex/turbopuffer-only-launch`; `main` auto-deploys to Vercel prod). Remote `thedotmack/claude-mem-pro`.
- **Cutover plan**: `PLAN-postgres-to-turbopuffer-cutover.md` (in claude-mem-pro worktree `.claude/worktrees/tpuf-content-plan`, branch `docs/tpuf-content-migration-plan`).

## Human-only items (Alex, anytime — not blocking Phase 1)

- [ ] Put a card / auto-pay on the Supabase org (`CMEM.ai` project `ziczmqtpmaxbornfghye`) so billing can never pause the control plane again (root cause of the Jul 20–22 outage).
- [ ] `npm publish` when Phase 2 hands over the built v13.12.0 release (npm publishing is human-only per the version-bump workflow).
- [ ] Optional: export `WOWERPOINT_API_BASE` / `WOWERPOINT_UPLOAD_TOKEN` / `WOWERPOINT_VIEWER_BASE` if deck share links are wanted.

## Known state (verified 2026-07-22, trust unless contradicted)

- PR #3333 (claude-mem, two-lane sync, 6 phases) — OPEN, code-complete, 2,465 tests green, 39/39 e2e. Hub suite re-run 68/68 today.
- PR #51 (claude-mem-pro, `GET /api/pro/sync/verify`) — OPEN, green, branch `feat/sync-hub-token-verify`.
- sync-hub worker deployed to Cloudflare prod Jul 19; `AUTH_CACHE` KV exists; `DISCORD_WEBHOOK_URL` secret set; `TOKEN_VERIFY_URL` NOT yet set → hub fails closed (by design).
- v13.11.0 is npm latest (legacy sync protocol). SyncHub activation requires v13.12.0 (`connect-info` gates worker protocol v1 on `13.12.0` + rollout flags).
- Prod DB restored and healthy after the Jul 20–22 pause; signups working; 251 outage leads recovered into `email_waitlist`.
- Postgres `pro_*` content tables still serve ALL reads (dashboard, MCP, timeline, devices, SSE). Turbopuffer v1 is a lossy search mirror only.
- Sibling branches from Jul 20 exist: `origin/codex/phase0-sync-verify`, `origin/codex/phase2-tpuf-product-paths` — review for reuse; their last 3 preview deploys FAILED on Vercel (build errors), so treat as WIP input, not truth.

---

## Phase 1 — Merge and activate the sync hub

**Goal:** hub live in production, verified end-to-end with real tokens.

Tasks:
1. In claude-mem-pro: merge PR #51 into `main` (`gh pr merge 51 -R thedotmack/claude-mem-pro`). Vercel auto-deploys. Verify `GET https://cmem.ai/api/pro/sync/verify` responds (401/contract response, not 404) after deploy.
2. In claude-mem: merge PR #3333 (`gh pr merge 3333 -R thedotmack/claude-mem`).
3. Configure the hub worker (`workers/sync-hub/`): set `TOKEN_VERIFY_URL=https://cmem.ai/api/pro/sync/verify` (wrangler secret or var per `wrangler.jsonc` — note the worktree has an uncommitted `wrangler.jsonc` modification; reconcile it first). Confirm watchdog cron trigger + secrets per `workers/sync-hub/DEPLOY.md`. Ensure `DEV_ALLOW_ANY_TOKEN` is empty in prod. Redeploy.
4. Run the two-device canary (`workers/sync-hub/canary/`) against prod with a real account's `setup_token` from `/api/pro/connect-info`.
5. Drill the kill switch once (trip → verify `X-Sync-Mode: poll` fleet-wide + WS refused with 503 → untrip).

Verification checklist:
- [ ] `/api/pro/sync/verify` live on cmem.ai
- [ ] Hub auth round-trip succeeds with a real token; fails closed with a bad one
- [ ] Canary: two devices converge push/pull, WS advisory fires
- [ ] Kill-switch trip/untrip observed
- [ ] Watchdog posts its hourly heartbeat to Discord

Anti-pattern guards: don't set `DEV_ALLOW_ANY_TOKEN` in prod; don't bypass the fail-closed default by stubbing verify.

## Phase 2 — Ship v13.12.0

**Goal:** a release whose plugin bundle speaks hub protocol, ready for Alex to `npm publish`.

Tasks:
1. On merged `main` of claude-mem, run the `version-bump` skill flow to `13.12.0` (manifests: root `package.json`, `plugin/plugin.json`, marketplace.json; build via `npm run build-and-sync`; verify worker starts; tag + GitHub release).
2. Confirm the built `plugin/scripts/worker-service.cjs` contains the SyncHub client paths (`/v1/sync/ops`, `/v1/sync/changes`) and that `CLAUDE_MEM_CLOUD_SYNC_HUB_URL` defaults empty (sync off unless configured).
3. Hand off to Alex for `npm publish`. After publish, flip `CMEM_WORKER_PROTOCOL_V1_ONBOARDING_ENABLED` + canary user IDs on Vercel per the staged-rollout flags in `connect-info`.

Verification checklist:
- [ ] `grep -c "/v1/sync/" plugin/scripts/worker-service.cjs` > 0 in the shipped bundle
- [ ] Fresh install smoke test: plugin boots, sync stays OFF without hub URL
- [ ] `npm view claude-mem dist-tags` shows 13.12.0 after Alex publishes

## Phase 3 — Execute the Turbopuffer cutover

**Goal:** Turbopuffer v2 is the only content store; Postgres is control plane only. This phase executes the existing frozen plan — read `PLAN-postgres-to-turbopuffer-cutover.md` in full before starting; its contracts (canonical doc schema, stable ID formula, `chronological_key` pagination, `(epoch, seq)` projection checkpoint, entity-rev/tombstone semantics) are binding.

Sub-steps (the plan's own Phases 0–3):
1. **Confirm premise**: count rows in `pro_observations` / `pro_summaries` / `pro_prompts`; classify anything present as disposable dev data and clear deliberately. Add the missing `verify:tpuf-content` script.
2. **Build v2 storage + projection**: `cmem-{userId}-v2` namespace, canonical docs, projection endpoint called by the stateless hub worker after `pushOps`, checkpoint + per-user lease, scheduled repair job. Resolve the compaction watermark gap: the projector must hold the hub compaction watermark (register as a device or add a dedicated projector watermark) so compaction can't outrun it.
3. **Switch every product path**: dashboard obs/summaries/prompts routes, MCP tools (full-row reads, not just search), timeline, stats, devices counts, and replace the Supabase Realtime SSE stream with bounded polling or hub advisory. Review `origin/codex/phase2-tpuf-product-paths` for reusable diffs (its Vercel builds failed — fix or rewrite, don't trust blindly).
4. **Delete the old world + wire the gate**: drop `pro_observations`, `pro_summaries`, `pro_prompts`, `pro_sync_state` via reviewed migration; remove legacy batch sync routes ONLY after v13.12.0 supersedes v13.11.0 in the wild; strip stale `*_migrated` columns from `pro_users`.

Verification checklist:
- [ ] E2E: local write → hub → projection → Turbopuffer → MCP tool answer returns the row
- [ ] Pagination correct past 10,000 rows (`chronological_key`, opaque cursor)
- [ ] `grep -r "pro_observations\|pro_summaries\|pro_prompts" src/` returns nothing in claude-mem-pro serving code
- [ ] Legacy routes removed only after npm latest ≥ 13.12.0

Anti-pattern guards: do NOT adopt `codex/turbopuffer-only-launch` wholesale (auth-fused tpuf design is the documented failure mode); never use `created_at_epoch` as a sync cursor (hub `seq` only); no outbound I/O from the Durable Object; auth/session/billing code stays untouched (Supabase remains the identity provider).

## Phase 4 — MCP connect page + guided test prompt (the MVP surface)

**Goal:** the funnel front door to the audited spec. Data source is `/api/pro/connect-info` (single source of truth for both tokens, MCP URL `{base}/api/mcp/mcp`, add-command, mcp.json snippet).

Spec (from the Jul 12 product-flow audit):
- Masked MCP link display with copy-with-success-state, rotate and revoke actions.
- Big client cards for Claude / ChatGPT / Gemini that stay "pressed" and reveal per-client instructions.
- Real connection verification: track last-successful-MCP-request per client (see `src/app/api/pro/mcp-activity` on main), not self-attestation.
- Guided test prompt after connection — a suggested prompt that demonstrably recalls the user's synced memories (the aha moment) — then reveal feed/search.
- Multiple local installs register as devices under one account, not separate identities.

Verification checklist:
- [ ] Fresh-account walkthrough: signup → checkout (free mode ok) → connect page → paste link into at least one real client → verification flips to connected → test prompt returns real memories
- [ ] Rotate invalidates old `mcp_token` within the 60s cache window; `setup_token` untouched
- [ ] Dashboard no longer bypasses activation for unconnected users (viewer-first P0)

## Phase 5 — Launch gate + rehearsal

**Goal:** the boring safety rails that make the launch survivable.

Tasks:
1. Daily cross-region Turbopuffer backups via `copy_from_namespace` + backup-age alert.
2. One full restore/replay drill from backup — documented.
3. Alerts: projector lag, rejected ops, Turbopuffer write failures — to Discord (reuse watchdog pattern).
4. Control-plane uptime + billing alarm (lesson of Jul 20–22): an external check hitting a DB-backed endpoint (not the static landing page) that pages on failure; Supabase billing alert on Alex's side.
5. Full demo rehearsal: checkout → connect → paste link → agent remembers → feed shows it. Re-run the sync e2e matrix (39 scenarios) and full test suites one last time.

Verification checklist:
- [ ] Backup exists, is fresh, and restored successfully once
- [ ] Each alert fired at least once in a forced test
- [ ] Demo path recorded/rehearsed without a hitch
- [ ] All suites green (root, hub, WS, openclaw, e2e matrix)

---

## Execution notes for /do

- Phases are strictly ordered; 1 and 2 are small, 3 is the big block (its sub-steps can be separate sessions), 4 can overlap with 3 (it reads via `connect-info` and MCP endpoints regardless of backing store), 5 is last.
- Production deploys happen in Phases 1–3 (Vercel auto-deploy on merge, wrangler deploy for the hub). Announce nothing until Phase 5 passes.
- The recovered outage leads (251 rows, `source` intact) are already in `email_waitlist` for the announce email.
