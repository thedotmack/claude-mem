# Handoff — liveness over deadlines + Supabase cloud sync

Written 2026-10-04 ~00:45 UTC before a context clear. Plan: `plans/2026-10-03-liveness-over-deadlines.md`
(Phase 12 there is the revised cutover order — follow it).

## Where things are

**claude-mem** — worktree `~/.superset/worktrees/claude-mem 🧠/numerous-meadowlark`, branch
`feat/liveness-over-deadlines`, **PR #4368** (head `b3ced5fe6` at handoff).
- Phases 1–7 (never-pay-twice, SSE/idle fetch, provider streaming, /api/ready, hook spool, context cache,
  corpus SSE), Phase 11 client (Supabase Realtime in SyncClient), sync-api FORWARD_ORIGIN proxy mode,
  CI full-suite fixes and two rounds of Greptile fixes are all committed and pushed.
- CI was green (8 pass, 3 skipped) on `b3ced5fe6`.
- **Open:** 2 Greptile threads, both `src/services/sync/SyncClient.ts:721`:
  - `PRRT_kwDOPng1J86otZRM` — catch-up marks caught-up even if an `advance` arrived mid-pull. Fix: track max
    announced head_seq since join; caught-up needs a post-join pull with `more=false` AND cursor ≥ that head;
    an advance skipped by single-flight schedules a follow-up pull.
  - `PRRT_kwDOPng1J86otZRO` — follow-up pulls after capped cycles bypass the min request gap. Fix: route
    follow-ups through the min-gap scheduler (add `MIN_PULL_GAP_MS` if none).
  - A subagent was implementing both at handoff. Check `git status` in the worktree: if those changes are
    there uncommitted, verify (`bun test tests/worker/sync`, `npm run typecheck`, full `bun test tests`),
    commit, push, reply + resolve both threads. If not, redo.
- Known non-regression: `field-deadline-wire` first test fails only on local Bun 1.3.9 (passes in CI 1.4.2).
- Then keep babysitting until CI green and 0 unresolved threads; merge.

**claude-mem-pro** — worktree `~/Scripts/claude-mem-pro/.claude/worktrees/supabase-sync`, branch
`feat/supabase-cloud-sync` (pushed; latest `ae998e7`; **no PR opened yet**). Migrations 0064–0070, Edge
Functions `cmem-sync` + `embed`, SupabaseContentStore, summary-landed route, backfill script.

**Production Supabase** (project `ziczmqtpmaxbornfghye`, "CMEM.ai"):
- 0064–0070 applied; `cmem-sync` + `embed` deployed; ES256 key imported as **standby** (kid `1236177f…`);
  function secrets + Vault secrets set.
- Smoke account `cmem-sync-smoke+20261003@cmem.ai` (user `f8361ee9-da08-4b47-a61e-76b65c0f3588`, creds in Pro
  `.scratch/prod-smoke-account.env`) passes the full e2e against production incl. Realtime.
- Owner account `453c8562-f3fa-48a8-a47a-f7035bde44e3` backfilled (165k rows).
- Disk 12 GB (8 used). Full backfill needs ~65 GB.
- Helpers in Pro `.scratch/`: `mgmt.sh` (Management API, token from keychain), `prodsql.sh` (needs
  `vercel env pull` into `.scratch/prod.env`; delete after). Secrets for Vercel in `.scratch/prod-secrets.env`.
- Nothing user-facing is switched yet: old clients still sync via Fly `sync.cmem.ai` → Neon → tpuf; Pro still
  reads tpuf (main branch).

## Waiting on
1. The SyncClient fix subagent (above).
2. **Supabase disk cooldown ends 2026-10-04 03:22 UTC** (disk changes allowed once per 4h).

## Next, in order
1. Finish PR #4368 → merge.
2. ≥03:22 UTC: `POST /v1/projects/ziczmqtpmaxbornfghye/config/disk`
   `{"attributes":{"type":"gp3","size_gb":200,"iops":3000,"throughput_mibps":125}}` (≈$24/mo; can't shrink).
   Confirm via GET `/config/disk`. Then `nohup` the full backfill
   (`scripts/backfill-cmem-content-from-tpuf.ts --apply --all`, ~9.3M rows, ~10 h, idempotent, skips embedding
   queue) → `.scratch/backfill-all.log`; watch disk (pause if free < 25 GB). Small per-user MISMATCH from live
   writes is expected; flag users > 1%.
3. After backfill: set Vercel env `CMEM_SUMMARY_LANDED_SECRET`, `CMEM_EMBED_SECRET`; open + verify Pro PR build;
   then **back to back**: `fly secrets set FORWARD_ORIGIN=https://ziczmqtpmaxbornfghye.supabase.co/functions/v1/cmem-sync`
   + `fly deploy` in `services/sync-api` (rollback: unset), and merge the Pro PR (Vercel deploys).
   Verify `curl https://sync.cmem.ai/health` → `mode:"forward"`, Pro dashboard counts for owner account.
4. claude-mem: map `https://sync.cmem.ai` → function URL in `migratedCloudSyncHubUrl`
   (`SettingsDefaultsManager.ts`), then `/version-bump` (npm publish is the human step).
5. After 7 clean days: scale Fly to 0, delete Neon, delete tpuf namespaces + legacy erase steps, delete
   `services/sync-api/` and `workers/sync-hub/`.
