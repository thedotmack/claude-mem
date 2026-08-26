# Plan: cmem Backups — paid backup add-on for cmem.ai Pro

Automatic, consistent backups of the local claude-mem database (SQLite + vector store) with
encrypted cloud upload, sold as a cmem.ai Pro **add-on**. Restore via `npx claude-mem restore`.
Built by reusing the cloud-sync hub auth, settings.json, and the worker's background-loop
patterns — no new infrastructure categories.

Each phase is self-contained and executable in a fresh context. Copy from the cited
file:line patterns; do not invent APIs.

---

## Phase 0: Documentation Discovery (COMPLETE — consolidated findings)

### Allowed APIs (verified against source)

**Snapshot mechanics** (the only consistent-backup code in the repo):
- `src/services/infrastructure/CleanupV12_4_3.ts:120-199` — disk pre-flight
  (`statfsSync`, `required = ceil(dbSize*1.2)+100MiB`, Bun darwin-x64 `bsize=0` workaround),
  then `new Database(dbPath, { readonly: true })` +
  `` backupDb.run(`VACUUM INTO '${path.replace(/'/g, "''")}'`) ``,
  fallback `copyFileSync` + `-wal`/`-shm` sidecars. **This is the snapshot engine to extract.**
- `src/services/sqlite/connection.ts:58-66` — `openConfiguredSqliteDatabase(dbPath, options?, pragmas?)`.
- DB path: `DB_PATH = join(DATA_DIR, 'claude-mem.db')` (`src/shared/paths.ts:49`); `paths.database()` at `:89`.
- There is **no** `db.backup()`/`db.serialize()` anywhere; `better-sqlite3` is not a dep. `VACUUM INTO` is the pattern.

**Recurring background work** (the worker has NO setInterval of its own):
- Best template: `SyncClient` self-rescheduling `setTimeout` chain —
  `schedule()` `src/services/sync/SyncClient.ts:426`, `tick()` `:437`, `currentDelay()` `:478`,
  all timers `.unref()`'d, single-flight guard (`:512`), activity signal injected from
  `worker-service.ts:543`.
- Fire-and-forget startup job pattern: `worker-service.ts:649-668` (`.catch()`-guarded, "non-blocking").

**Worker HTTP surface**:
- Route class template: `src/services/worker/http/routes/CloudSyncRoutes.ts` (whole 35-line file) —
  extends `BaseRouteHandler`, ctor takes `DatabaseManager`, returns `{configured:false}` instead of 404.
- Late registration site (DB-dependent routes): `worker-service.ts:589-590`.
- POST + zod validation: `SettingsRoutes.ts:17-19,34`, `DataRoutes.ts:89,102` (`validateBody(schema)`).
- Init-gate: `worker-service.ts:329-351` 503s all `/api` routes until init completes (allowlist of 5).
- Route test harness: `tests/worker/http/routes/cloud-sync-routes.test.ts:20-45`.

**Cloud upload / hub auth** (reuse, do not reinvent):
- Auth header set (every request): `Authorization: Bearer <CLAUDE_MEM_CLOUD_SYNC_TOKEN>`,
  `X-User-Id`, `X-Device-Id`, `X-Device-Name` — `CloudSync.ts:581-590`, `:943-954`;
  `AbortSignal.timeout(30_000)`.
- Gating predicate: `CloudSync.isConfigured()` `:426` (token+userId+hubUrl all non-empty);
  construction gate `DatabaseManager.ts:49-58` (null when unconfigured).
- Backoff scheduler: `CloudSync.scheduleRetry()` `:1394` (30s → 600s doubling).
- Token redaction convention: log only `tokenLength` (`CloudSync.ts:471,479`), `[REDACTED]` in errors (`:635`).
- Server-side (in-repo Cloudflare Worker): `workers/sync-hub/src/index.ts:210-305`
  `authenticateRequest` — verifies bearer against `TOKEN_VERIFY_URL = https://cmem.ai/api/pro/sync/verify`,
  binds `X-User-Id`, caches verdicts in KV `AUTH_CACHE` 60s. **No R2 binding exists yet** (`wrangler.jsonc`).
  Internal-secret route pattern: `index.ts:415` (`Bearer ${CMEM_INTERNAL_PROJECTOR_SECRET}`).

**Prior art — PR #1186 (closed unmerged), reachable in-repo:**
- `git show 0cfa7f800` — `src/services/backup/LitestreamManager.ts` (363 lines),
  `src/services/worker/http/routes/BackupRoutes.ts` (GET /api/backup/status, POST /api/backup/restore),
  `plugin/skills/backup-setup/SKILL.md`, `tests/backup/litestream-manager.test.ts`,
  nine `CLAUDE_MEM_BACKUP_*` settings keys, `logger.ts` `BACKUP` component.
- `git show f1cba2661` — BackupRoutes HTTP tests.
- Litestream itself was rejected (binary download + user-supplied S3/GCS credentials). We keep its
  *shape* (settings keys, route names, skill doc, worker lifecycle hooks) but replace the engine with
  snapshot+upload through cmem infrastructure.

**CLI**:
- Dispatch: `src/npx-cli/index.ts:103` switch; lazy `await import('./commands/X.js')`; help text `:16-62`.
- Subcommand dispatcher module to copy: `src/npx-cli/commands/telemetry.ts:201-219`.
- Worker-HTTP-calling command (ECONNREFUSED handling): `src/npx-cli/commands/runtime.ts:158-210`.
- Direct-DB command (Bun-only): `src/npx-cli/commands/migrate-to-helix.ts:14-15`.
- Doctor check: `CheckResult` `doctor.ts:18-26`; async probe template `doctor.ts:51-60,139-155`;
  conditional file-existence check `doctor.ts:171-188`.

**Settings plumbing** (four places for every new key):
1. `src/shared/SettingsDefaultsManager.ts` — interface (~`:86`) + DEFAULTS (~`:183`).
2. `src/services/worker/http/routes/SettingsRoutes.ts:77-107` — **hardcoded `settingKeys` allowlist;
   keys not listed are silently dropped on POST /api/settings.**
3. `src/ui/viewer/constants/settings.ts` `DEFAULT_SETTINGS` + `src/ui/viewer/types.ts` `Settings`.
4. Optional per-key validation `SettingsRoutes.validateSettings()` `:143-246`.

**Entitlement model** (from PR #3687 branch `claude/trial-oauth-setup-ec6sqi`, unmerged):
- There is NO client-side entitlement check today. Pro = credentials present.
- Reactive-degradation template: `src/shared/pro-fallback.ts` (branch) — file-backed TTL'd marker
  (`pro-fallback.json`, 0600, 24h TTL, 5-min probe interval), written by worker, read by short-lived hooks.
- Gateway error taxonomy: `OpenRouterProvider.ts:27-40` (`allowance_exhausted`, `subscription_inactive`, …).
- Upsell copy conventions: `src/shared/pro-promo.ts` + mirror `src/ui/viewer/constants/promo.ts`;
  attributed URLs `https://cmem.ai/dashboard?from=<source>`; **never mention allowance dollar values**.
- Trial pairing funnel (device-auth style): `install.ts:1434-1523` start/poll contract,
  `install.ts:1767-1776` single atomic `mergeSettings()` credential write.
- Key format: `CMEM_PRO_KEY_PATTERN = /^cm_pro_[0-9a-f]{24,32}$/` (`cmem-pro-costs.ts:207`).

### Anti-patterns (DO NOT)
- Do not use `setInterval` for the schedule loop — copy the `SyncClient` unref'd `setTimeout` chain.
- Do not call `db.backup()` / `db.serialize()` — not available; use `VACUUM INTO` + fallback copy.
- Do not add a new key without updating the `SettingsRoutes.ts:77-107` allowlist (silent drop).
- Do not log or argv-pass the sync token (skill rule, `plugin/skills/cloud-sync/SKILL.md:16-18`).
- Do not put allowance dollar values in any user-facing copy ($30/mo subscription price is the only allowed number).
- Do not ship user-supplied S3 credentials (that is why PR #1186 died); upload goes through cmem hub auth.
- Do not query Stripe or add a Stripe SDK client-side; entitlement is server-verified per request.

### External contract (cmem-pro-mvp repo, NOT in this repo — Phase 6 defines the contract only)
- `/api/pro/sync/verify` (TOKEN_VERIFY_URL) — today returns canonical user id; the backup add-on
  needs it (or a sibling endpoint) to expose an entitlement field, e.g. `{ user_id, addons: ["backup"] }`.
- Stripe add-on SKU, checkout, and dashboard toggle live in cmem-pro-mvp.
- `paymentStatus` enum there: `'none'|'pending'|'active'|'trialing'|'past_due'|'cancelled'`.

---

## Phase 1: Snapshot engine + retention (local, no cloud, no billing)

**What to implement**
1. New `src/services/backup/BackupManager.ts`:
   - `createSnapshot(): Promise<BackupSnapshotResult>` — extract the CleanupV12_4_3 pattern
     (`CleanupV12_4_3.ts:120-199`) into a reusable method: disk pre-flight → `VACUUM INTO`
     → `copyFileSync + wal/shm` fallback. Target dir: `paths.backups()` (add to `src/shared/paths.ts`
     `paths` object, `join(DATA_DIR, 'backups', 'auto')` — keep clear of the legacy `backups/` clutter).
     Filename: `claude-mem-<ISO-ts-sanitized>.db` (ts sanitization from `CleanupV12_4_3.ts:171-172`).
   - `applyRetention(): Promise<void>` — keep N most-recent (default 7) + optionally one per week for
     4 weeks; delete older files. Pure fs, sorted by filename timestamp.
   - `status(): BackupStatus` — `{ configured, lastSnapshotAt, lastSnapshotBytes, snapshotCount, lastError, nextRunAt }`,
     modeled on `CloudSyncStatus` (`CloudSync.ts:335-350`).
   - Schedule loop: copy the `SyncClient.schedule()/tick()` unref'd setTimeout chain
     (`SyncClient.ts:426-502`), single-flight guard, default cadence 24h
     (`CLAUDE_MEM_BACKUP_INTERVAL_HOURS`), first run ~5 min after worker start.
2. Settings keys (all four plumbing sites — see Phase 0):
   `CLAUDE_MEM_BACKUP_ENABLED` ('false'), `CLAUDE_MEM_BACKUP_INTERVAL_HOURS` ('24'),
   `CLAUDE_MEM_BACKUP_RETAIN_COUNT` ('7'), `CLAUDE_MEM_BACKUP_INCLUDE_VECTORS` ('false').
   (Vector-store archive is optional and OFF by default: Chroma dir can be 2GB+; the SQLite DB is the
   source of truth and vectors are rebuildable via backfill — `worker-service.ts:649-668`.)
3. `logger.ts`: add `BACKUP` component (PR #1186 did the same, `git show 0cfa7f800 -- src/utils/logger.ts`).
4. Worker lifecycle: construct in `DatabaseManager.initialize()` **only when**
   `CLAUDE_MEM_BACKUP_ENABLED === 'true'` (gate pattern `DatabaseManager.ts:49-58`);
   `getBackupManager()` accessor; `stop()` in `close()` (pattern `:68-69`); `start()` next to
   `getCloudSync()?.start()` (`worker-service.ts:677`).

**Verification**
- `bun test tests/backup/backup-manager.test.ts` — new suite: snapshot produces an openable DB
  (`PRAGMA integrity_check` = ok), retention deletes correctly, disabled setting = no construction.
- `npm run typecheck` clean.
- Grep guards: no `setInterval(` in new files; no `.backup(` calls.

---

## Phase 2: Worker HTTP surface + restore

**What to implement**
1. `src/services/worker/http/routes/BackupRoutes.ts` — copy the class shape from
   `CloudSyncRoutes.ts` (whole file) and the route names from PR #1186
   (`git show 0cfa7f800 -- src/services/worker/http/routes/BackupRoutes.ts`):
   - `GET /api/backup/status` → `BackupManager.status()` or `{configured:false}`.
   - `POST /api/backup/run` → manual snapshot now (zod body optional `{ uploadNow?: boolean }` —
     `validateBody` pattern `SettingsRoutes.ts:17-19`).
   - `GET /api/backup/list` → snapshots on disk + (Phase 3) cloud copies.
   - `POST /api/backup/restore` → body `{ file: string, confirm: true }`; worker closes DB,
     copies current DB to `claude-mem.db.pre-restore-<ts>`, replaces from snapshot, exits 0
     (supervisor restarts it — same self-recycle idiom as `POST /api/admin/restart`).
2. Register late, after `CloudSyncRoutes` (`worker-service.ts:589-590`).
3. `npx claude-mem backup [run|status|list]` and `npx claude-mem restore <file>` CLI:
   - Dispatcher module copied from `telemetry.ts:201-219`; worker-HTTP calls copied from
     `runtime.ts:158-210` (ECONNREFUSED → "Worker is not running").
   - `restore` with no worker running falls back to direct-fs restore (copy + sidecar handling),
     Bun-only path like `migrate-to-helix.ts:14-15`.
   - Register both in `index.ts:103` switch + help text `:16-62`.
4. Doctor check "Backups" — conditional check pattern (`doctor.ts:171-188`): ok = enabled & last
   snapshot < 2× interval; warn = enabled but stale/failed; ok-dim = disabled. `required: false`.

**Verification**
- New route tests copied from `tests/worker/http/routes/cloud-sync-routes.test.ts:20-45`.
- End-to-end: run worker on a temp data dir, POST /api/backup/run, verify snapshot file integrity,
  POST /api/backup/restore, verify worker comes back with restored DB.
- `npx claude-mem doctor` renders the new check.

---

## Phase 3: Encrypted cloud upload via sync-hub (the paid part, client + hub)

**What to implement**
1. **Encryption before upload** (client-side): age-style symmetric encryption is overkill to hand-roll —
   use Node's `crypto` (AES-256-GCM). Key: `CLAUDE_MEM_BACKUP_ENCRYPTION_KEY` minted locally
   (32 random bytes, base64) on first enable, persisted to settings.json (0600) via the
   device-id persistence pattern (`CloudSync.ts:1422-1456`). The key NEVER leaves the machine;
   docs must say "lose the key, lose the backups". Format: `<12B nonce><ciphertext><16B tag>`,
   filename suffix `.enc`.
2. **Hub side** (`workers/sync-hub/`):
   - Add R2 bucket binding `BACKUP_BUCKET` to `wrangler.jsonc` (first R2 binding in this worker).
   - New routes in `src/index.ts` following the existing `/v1/sync/*` dispatch (`:877-947`),
     auth via the existing `authenticateRequest` (`:210-305`) — entitlement comes free once
     TOKEN_VERIFY_URL knows about the add-on (Phase 6 contract):
     - `POST /v1/backup/upload-url` → `{ key, url }` presigned R2 PUT (or direct streamed PUT
       through the worker if presigning is unavailable), key = `backups/<userId>/<deviceId>/<ts>.db.enc`.
     - `GET /v1/backup/list`, `GET /v1/backup/download-url`, `DELETE /v1/backup/<key>`.
   - Server-side retention: keep last `BACKUP_RETAIN_CLOUD` (var, default 10) per device; enforce
     on upload completion.
   - Size guard: reject > `BACKUP_MAX_BYTES` (var, default 2 GiB).
3. **Client upload step** in `BackupManager`: after snapshot+encrypt, request upload-url with the
   CloudSync auth headers (`CloudSync.ts:943-954` — reuse a small shared helper, do not duplicate),
   stream the file, verify 200, record `lastUploadAt`. Retry via the `scheduleRetry` backoff pattern
   (`CloudSync.ts:1394`). Upload requires `CloudSync.isConfigured()` AND
   `CLAUDE_MEM_BACKUP_CLOUD === 'true'`.
4. `npx claude-mem restore --cloud [<key>]` — list + download + decrypt + restore.

**Verification**
- `workers/sync-hub/test/` — miniflare test for the new routes copied from
  `workers/sync-hub/test/miniflare-pro-e2e.test.ts` patterns (auth 401/403/503 matrix, size cap,
  retention trim).
- Client: round-trip unit test — snapshot → encrypt → decrypt → `PRAGMA integrity_check`.
- Token never appears in logs (grep the new files for `token` in template strings).

---

## Phase 4: Entitlement + billing wiring (add-on SKU)

**What to implement (this repo)**
1. Entitlement detection is **reactive, server-enforced** (same philosophy as PR #3687):
   hub returns 403 with a JSON body `{ error: { code: 'addon_required', action, url } }` when the
   verified user lacks the backup add-on. Client maps it exactly like the gateway taxonomy
   (`OpenRouterProvider.ts:27-40`): on `addon_required`, `BackupManager` disables cloud upload,
   writes a file-backed marker `backup-addon-required.json` (copy the `pro-fallback.ts` marker
   shape/TTL/0600 from the #3687 branch), keeps LOCAL snapshots running, and surfaces the upsell.
2. Upsell copy in `src/shared/pro-promo.ts` + viewer mirror, following the existing conventions:
   attributed URL `https://cmem.ai/dashboard?from=backup-<source>`; no allowance numbers.
   Example copy: "Cloud backups are a cmem Pro add-on. Your local snapshots are safe; add cloud
   copies for $N/mo:" (price constant supplied at implementation time from the SKU).
3. Doctor + `backup status` + viewer all render the `addon_required` state distinctly from
   "not configured".

**External contract to hand to cmem-pro-mvp (document in the PR body, not built here)**
- Stripe: add-on price object; dashboard toggle; webhook → `pro_users.addons` array (or table).
- `/api/pro/sync/verify` response gains `addons: string[]` (backward compatible — sync-hub ignores
  unknown fields today); sync-hub backup routes check `addons.includes('backup')` and emit
  `addon_required` otherwise.
- KV verdict cache (60s) already bounds entitlement staleness — no new caching needed.

**Verification**
- Miniflare test: verified user without add-on → 403 `addon_required`; with add-on → 200.
- Client test: 403 addon_required → marker written, local snapshots continue, no retry storm
  (respect the 24h TTL / 5-min probe interval from the marker pattern).

---

## Phase 5: Viewer + skill + docs

**What to implement**
1. Viewer "Backups" section in the settings modal — copy `CollapsibleSection`/`ToggleSwitch`/`FormField`
   from `ContextSettingsModal.tsx:16-119`; status fetch hook copied from `useContextPreview.ts`;
   new endpoint constant in `constants/api.ts`. Shows: enabled toggle, cadence, last snapshot,
   last upload, restore hint (CLI command), upsell line when `addon_required`.
2. `plugin/skills/backup-setup/SKILL.md` — resurrect the PR #1186 skill
   (`git show 0cfa7f800 -- plugin/skills/backup-setup/SKILL.md`) rewritten for the cmem add-on:
   status check via `GET /api/backup/status`, enable flow, restore drill, privacy footer modeled on
   `plugin/skills/cloud-sync/SKILL.md:104-107` ("encrypted with a key that never leaves your machine").
3. Docs: `docs/public/` page for Backups (Mintlify), linked from cloud-sync page; update
   `docs.json` nav (per CLAUDE.md).

**Verification**
- `npm run build` (viewer bundle builds); manual viewer smoke via `npm run build-and-sync` is
  left to the maintainer.
- Skill lints: has the status/enable/restore sections and the privacy footer.

---

## Phase 6: Final verification

1. `npm run typecheck` + full `bun test tests` green.
2. Grep guards: `setInterval(` absent from `src/services/backup/`; no token in logs
   (`grep -rn "TOKEN" src/services/backup | grep -v tokenLength` → empty); every new
   `CLAUDE_MEM_BACKUP_*` key present in all four settings plumbing sites.
3. End-to-end drill on a throwaway data dir: enable → snapshot → encrypt → (hub emulator) upload →
   list → download → decrypt → restore → integrity_check ok.
4. Confirm `/api/backup/*` behaves under the init gate (`worker-service.ts:329-351`) —
   status may 503 during init; that is acceptable, do NOT allowlist it.
5. PR body includes the Phase 4 external contract for cmem-pro-mvp.
