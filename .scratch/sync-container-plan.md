# claude-mem Multi-Device Sync — Phased Implementation Plan

**Date authored:** 2026-05-04 (v3); revised 2026-05-04 PM (v4)
**Revision:** v4 — locked-in architecture: self-hosted `sqld` (no Turso cloud), Chroma stays.
**Status:** **Ready to execute.** Phase 1 (libSQL DB-layer migration) is next. All architectural decisions resolved.

> **Companion docs in this directory:**
> - `post-mortem-2026-05-04.md` — why we kept Chroma (libSQL+Xenova vector migration experiment failed at 4-hour wall-clock; CREATE INDEX never finished).
> - `migration-audit.md` — perf and architectural findings from the libSQL vector experiment; some still-applicable findings about libSQL behavior under load.
>
> **Reading order for a cold-start session:** §1 North Star → §2 ADRs → §13 Re-Entry Notes → jump to the phase you're executing.

---

## 1. North Star

> Finish a task on the Macbook, close the lid, pick up on the phone — without thinking about sync. Same memory, same conversations, same project files, same Claude Code auth. Local dev on the Mac. Phone is a remote control onto a Railway-hosted container that runs claude-mem + Claude Code + AionUi.

**Concrete success criteria** (used in Phase 5 verification):

- (a) Edit a file on Mac, end the Claude Code session, close lid → on phone, see the same uncommitted change in the same project.
- (b) Run a Claude Code task on Mac that produces new claude-mem observations → end session → on phone, search those observations and see hits, **and** see the prior conversation transcript in AionUi.
- (c) Run a Claude Code task on phone via AionUi that produces new observations → end session → re-open Mac, start a new session in that project → search and see hits, and see the phone's transcript.
- (d) Total wall-clock from "end session on origin device" to "see synced state on target device" ≤ 60s.

Note: sync runs on `SessionEnd` / `SessionStart` hooks, not on file save. Documented expectation.

---

## 2. Architecture Decisions

### ADR-1: Memory sync via self-hosted `sqld` — replaces the contributor's `claude-mem-sync` script

The contributor's bash+SCP tool merges 2 of N tables with dedup. libSQL's embedded replicas + remote primary handle this *transparently and for all tables* with sub-minute lag. This requires migrating claude-mem's DB layer from `bun:sqlite` (Bun's native sync sqlite) to `@libsql/client` (async API) — a real refactor, not a config change. **This is the single biggest scope item; it's why Phase 1 exists.**

**Topology:** one self-hosted `sqld` primary running as a Railway service with its own volume; two embedded replicas (Mac + container `app` service). Auth via `TURSO_AUTH_TOKEN` (sqld accepts the same token format).

**Why self-host (decided 2026-05-04):**
- No third-party cloud dependency in the data path.
- Predictable behavior under bulk-load — the post-mortem (`.scratch/post-mortem-2026-05-04.md`) showed sqld WAL grows to ~9.4× main-DB size under sustained writes; we want full control over disk and `wal_checkpoint(TRUNCATE)` cadence.
- Already running our own infra on Railway; no marginal ops cost.
- Vendor independence; we can move primary to any host with a Docker runtime later.

**Source:** `sqld` from `github.com/tursodatabase/libsql/tree/main/libsql-server` (official Docker image). Embedded-replica client docs: https://docs.turso.tech/features/embedded-replicas/introduction, https://docs.turso.tech/sdk/ts/quickstart, https://github.com/tursodatabase/libsql-client-ts (the SDK works against either Turso cloud or self-hosted sqld — same API).

The contributor's `scripts/claude-mem-sync` becomes deprecated; keep the file for one release with a `WARNING: deprecated` banner.

**Pre-validated facts (from the libSQL vector experiment, 2026-05-04):**
- libSQL opens our existing `~/.claude-mem/claude-mem.db` (310 MB, 36 tables, 77k+ observations) cleanly. File-format superset of SQLite confirmed by `step1-open-asis.mjs`. Phase 1's "will libSQL accept the prod DB" question is already answered: **yes.**

**Update 2026-05-04 PM:** SDK choice resolved to `@libsql/client@0.17.3` after spike (`.scratch/spike-libsql-sdk.md`) showed `@tursodatabase/sync` doesn't work against self-hosted sqld. Phase 1 split into 1A (foundation, no consumer changes) and 1B (consumer cutover) after inventory (`.scratch/inventory-better-sqlite3.md`) revealed 1,255 sync call sites — the original "1-2 days" estimate was wrong by ~10×.

### ADR-2: Railway project = three services (`app`, `chroma`, `libsql`)

Railway volumes are 1-per-service. Forcing four runtimes (worker, AionUi, sshd, Chroma) into one container would mean one volume mount carrying all data — workable but couples upgrade cycles. Cleaner: one Railway project containing three services that talk over `*.railway.internal` private DNS:

| Service | Purpose | Public? | Volume |
|---|---|---|---|
| `app` | claude-mem worker + Claude Code + AionUi server + sshd + rsync target | AionUi via HTTP edge; sshd via TCP Proxy | yes — `/home/node` (5 GB) |
| `chroma` | Chroma vector server | private (Mac talks via SSH tunnel through `app` — see §6) | yes — `/data` (2 GB) |
| `libsql` | self-hosted `sqld` primary (`ghcr.io/tursodatabase/libsql-server:v0.24.8`) | private (Mac talks via SSH tunnel through `app`); `app` talks via `libsql.railway.internal` | yes — `/var/lib/sqld` (5 GB) |

All three services are required. None are optional in v1.

The user's "spin up containers for customers" plan maps onto Railway Templates: package the project as a template, replicate per customer. https://docs.railway.com/guides/templates

### ADR-3: OAuth uses the existing `docker/claude-mem/` pattern verbatim

Already implemented in this repo. `docker/claude-mem/run.sh:14-42` extracts creds from macOS Keychain (or `~/.claude/.credentials.json`, or `ANTHROPIC_API_KEY`), `chmod 600`s a tempfile, and the container's `entrypoint.sh:7-14` copies it to `$HOME/.claude/.credentials.json` at startup. Same auth flow inside Claude Code, no `claude setup-token` step on the user's part.

For Railway: a one-time provisioning script extracts the local creds and uploads them as a **Sealed Variable** (`CLAUDE_CODE_CREDENTIALS_JSON`) on the Railway service. The container's `entrypoint.sh` writes it to `$HOME/.claude/.credentials.json` at boot. Same shape, different transport. Sealed Variables aren't visible after sealing — appropriate for credentials. https://docs.railway.com/guides/variables

Per-customer containers (later) get their own per-customer Sealed Variable, set when the customer onboards.

### ADR-4: File sync at hook boundaries — rsync covers project files AND `~/.claude/projects/` (transcripts/conversations)

claude-mem's transcript watcher reads `~/.claude/projects/{project}/{session}.jsonl`. To make AionUi on the container show the Mac's prior conversations and vice versa, `~/.claude/projects/` must rsync between devices alongside the project source.

Sync points:
- **Mac SessionEnd:** `rsync` the active project source → container, `rsync` `~/.claude/projects/<project-id>/` → container, `git push` if commits ahead. (libSQL primary already has memory because writes go remote.)
- **Mac SessionStart:** `rsync` `~/.claude/projects/<project-id>/` ← container (so phone-side transcripts arrive), `git pull --ff-only` if working tree clean. (libSQL replica syncs memory automatically via `db.sync()` on startup.)
- **Container side:** mirrored hooks. Container's SessionEnd pushes (transcripts back, but container files don't usually leave the container — Mac is the source of truth for project files). Container's SessionStart pulls latest project files from Mac.

No watcher daemons, no cron. Hooks only.

### ADR-5: Chroma stays — single server in `chroma` service

Chroma's embedding compute is client-side; it can't do server-side embedding in OSS. v1 accepts that the active device (Mac or container) does its own embedding work. Both workers point at `chroma.railway.internal:8000` (container) or via SSH tunnel from Mac.

`src/services/sync/ChromaSync.ts` reads `CLAUDE_MEM_CHROMA_HOST/PORT/MODE` — no code change. Set on Mac:
```
CLAUDE_MEM_CHROMA_MODE=http
CLAUDE_MEM_CHROMA_HOST=127.0.0.1     # SSH tunnel target
CLAUDE_MEM_CHROMA_PORT=8000
```

For Mac→Chroma access without exposing Chroma publicly, Mac opens an SSH tunnel to `app` service (already has sshd via Railway TCP Proxy) and tunnels to `chroma.railway.internal:8000`. Tunnel auto-reconnects via `autossh`.

### ADR-6: AionUi runs in the `app` service in headless server mode

`bun run build:server` (one-time) → `bun run server:start:prod:remote` (always-on) — first-class production path in `iOfficeAI/AionUi/package.json`. No Electron, no xvfb. Phone connects to AionUi's WebUI via Railway's HTTP edge (auto-SSL). WebUI password set via `bun run server:resetpass:prod` after first deploy.

### ADR-7: Per-project config in `~/.claude-mem/synced-projects.json`

Single JSON file lists synced projects. Hooks read it. Add/remove = edit JSON. No slash commands in v1.

---

## 3. Open Questions

**All architectural questions resolved.** See §2 ADRs.

Resolution log:
- ✓ Railway as host (v3)
- ✓ One Railway project covering all projects (v3)
- ✓ OAuth via existing `docker/claude-mem/` pattern (v3)
- ✓ AionUi placement = `app` service in headless server mode (v3)
- ✓ **Turso cloud vs self-host → self-hosted `sqld`** (v4, 2026-05-04 PM). Rationale: no cloud dependency, predictable behavior under load, vendor independence.
- ✓ **Vector store = Chroma (kept)** (v4, 2026-05-04 PM). Rationale: libSQL+Xenova vector migration experiment failed at 4-hour wall-clock (CREATE INDEX never finished, WAL ballooned to 14 GB). The chroma-mcp CPU-storm bugs that motivated the migration were independently fixed in PR #2282 (per-batch watermark, killProcessTree, pgid registration, max-3 backfill concurrency). See `.scratch/post-mortem-2026-05-04.md`.

The plan is fully decided. Begin Phase 1.

---

## 4. Phase 0 — Documentation Discovery (DONE)

### A. Existing claude-mem Docker harness — REUSED

- `docker/claude-mem/Dockerfile` — `node:20` base + Bun + uv + Claude Code CLI + plugin. Non-root `node` user. Pre-creates `/home/node/.claude` and `/home/node/.claude-mem` mount points.
- `docker/claude-mem/run.sh:14-42` — OAuth credential extraction from Keychain / `~/.claude/.credentials.json` / `ANTHROPIC_API_KEY`.
- `docker/claude-mem/entrypoint.sh:7-14` — copies mounted creds to `$HOME/.claude/.credentials.json` with `chmod 600`.
- `docker/claude-mem/build.sh` — `npm run build` then `docker build`.

The Phase 2 Dockerfile **extends this**, doesn't replace it.

### B. claude-mem container surface

- Runtime: Node ≥20, Bun ≥1.0 (`docker/claude-mem/Dockerfile:19-23`), uv (Python 3.13) for `chroma-mcp==0.2.6`.
- Env vars: `CLAUDE_MEM_DATA_DIR`, `CLAUDE_CONFIG_DIR`, `CLAUDE_MEM_WORKER_PORT`, `CLAUDE_MEM_WORKER_HOST=127.0.0.1`, `CLAUDE_MEM_CHROMA_MODE=http`, `CLAUDE_MEM_CHROMA_HOST`, `CLAUDE_MEM_CHROMA_PORT=8000`, `CLAUDE_MEM_CREDENTIALS_FILE=/auth/.credentials.json`.
- Volumes (must persist across container restart):
  - `$CLAUDE_MEM_DATA_DIR/claude-mem.db` — local libSQL replica (Phase 1)
  - `$CLAUDE_MEM_DATA_DIR/{settings.json, .env, logs/, archives/, corpora/}`
  - `$CLAUDE_CONFIG_DIR/projects/` — Claude Code transcripts (the "conversations")
  - `~/projects/` — synced project source files
- Linux OAuth path already implemented: `src/shared/oauth-token.ts:285-299` reads `process.env.CLAUDE_CODE_OAUTH_TOKEN`; `entrypoint.sh` writes credentials.json file form. Either works.

### C. libSQL / self-hosted sqld

- `@libsql/client` is **async** (Promise-based). `bun:sqlite` is sync. Migration is invasive; touches every DB call site.
- Embedded replica config (works against self-hosted sqld): `{ url: "file:local.db", syncUrl: "https://libsql.railway.internal:<port>", authToken: "<token>", syncInterval: 30000 }`. https://docs.turso.tech/features/embedded-replicas/introduction
- Newer `@tursodatabase/sync` SDK with explicit `db.push()` / `db.pull()` is **rejected**: spike (`.scratch/spike-libsql-sdk.md`) verified its sync engine calls `POST /pull-updates`, a Turso-Cloud-only route sqld 0.24.x returns 404 for. Use `@libsql/client@0.17.3` instead.
- **Self-hosted `sqld`:** official image pinned at `ghcr.io/tursodatabase/libsql-server:v0.24.8` (do **not** use `:latest` — it points at v0.22.0 from May 2024). Source: `github.com/tursodatabase/libsql/tree/main/libsql-server`. Docker-compose recipe in-tree at `libsql-server/docker-compose.yml`.
- **Auth setup:** sqld supports JWT-based auth — generate a keypair, export `SQLD_AUTH_JWT_KEY` env var on the server, sign tokens with the private key for clients. https://github.com/tursodatabase/libsql/tree/main/libsql-server (auth section).
- libSQL opens existing `~/.claude-mem/claude-mem.db` cleanly — file-format compatibility verified 2026-05-04 (`step1-open-asis.mjs`).

### D. Railway

- TCP Proxy for sshd: `https://docs.railway.com/reference/tcp-proxy` — assigns external port; client connects to `proxy.rlwy.net:<assigned>`.
- Public HTTP edge w/ auto-SSL: `https://docs.railway.com/reference/public-networking`
- Private networking: `https://docs.railway.com/reference/private-networking` — `<service>.railway.internal:<port>`.
- Volumes: `https://docs.railway.com/reference/volumes` — one per service, runtime-only (not at build time). Hobby tier 5 GB.
- Sealed Variables: `https://docs.railway.com/guides/variables` — never visible after sealing; for `CLAUDE_CODE_CREDENTIALS_JSON`, `TURSO_AUTH_TOKEN`, etc.
- Dockerfile-from-git: `https://docs.railway.com/guides/dockerfiles`. `RAILWAY_DOCKERFILE_PATH` overrides location.
- Templates: `https://docs.railway.com/guides/templates` — for replicating per-customer.
- Pricing: Hobby $5/mo + usage; one always-on container with 2 GB volume ≈ $20–25/mo.

### E. AionUi headless server

- `iOfficeAI/AionUi/package.json` scripts:
  - `build:server` → `node scripts/build-server.mjs` (produces `dist-server/server.mjs`)
  - `server:start:prod:remote` → `NODE_ENV=production ALLOW_REMOTE=true bun dist-server/server.mjs`
  - `server:resetpass:prod` → `NODE_ENV=production bun dist-server/server.mjs --resetpass`
- No Electron, no display server.
- Auto-detects locally installed CLI agents (Claude Code first-class).

### F. Transcripts / conversations

- claude-mem watches `~/.claude/projects/{project}/{session}.jsonl` (Claude Code's transcript format).
- claude-mem's own state: `transcript-watch.json` (config) and `transcript-watch-state.json` (offsets) at `$CLAUDE_MEM_DATA_DIR` root. `src/shared/paths.ts:136-137`.
- For "phone sees Mac's conversations" we rsync `~/.claude/projects/<project-id>/` between devices. The watch-state JSON can stay device-local (each device tracks its own offsets).

### Allowed APIs (citations for downstream phases)

| Need | API / mechanism | Source |
|---|---|---|
| OAuth credential mount pattern | `CLAUDE_MEM_CREDENTIALS_FILE=/auth/.credentials.json` env + ro volume | `docker/claude-mem/run.sh:36-39`, `docker/claude-mem/entrypoint.sh:7-14` |
| libSQL embedded replica | `createClient({ url, syncUrl, authToken, syncInterval })` | https://docs.turso.tech/features/embedded-replicas/introduction |
| libSQL self-hosted sqld | `ghcr.io/tursodatabase/libsql-server:v0.24.8`, `docker-compose` recipe in-tree | https://github.com/tursodatabase/libsql/tree/main/libsql-server |
| sqld JWT auth | `SQLD_AUTH_JWT_KEY` server env + signed bearer tokens for clients | same |
| Railway TCP Proxy | per-service config in Railway UI | https://docs.railway.com/reference/tcp-proxy |
| Railway private DNS | `<service>.railway.internal:<port>` | https://docs.railway.com/reference/private-networking |
| Railway sealed vars | UI → 3-dot menu → Seal | https://docs.railway.com/guides/variables |
| Railway Dockerfile path | `RAILWAY_DOCKERFILE_PATH=docker/sync-container/Dockerfile` | https://docs.railway.com/guides/dockerfiles |
| AionUi headless | `bun run server:start:prod:remote` | `iOfficeAI/AionUi/package.json` |
| Chroma server | image `chromadb/chroma`, `chromadb.HttpClient(host, port)` | https://docs.trychroma.com/guides/deploy/docker |
| claude-mem chroma host | `CLAUDE_MEM_CHROMA_HOST/PORT/MODE` | `src/shared/SettingsDefaultsManager.ts:118-121` |

### Anti-patterns (do NOT do these)

1. Don't try to make libSQL multi-writer. Single primary is the documented topology.
2. Don't keep `bun:sqlite` *and* `@libsql/client` in parallel. One DB layer; pick libSQL.
3. Don't use `claude setup-token` in v1 — the existing credential-file pattern in `docker/claude-mem/` is better and already implemented.
4. Don't expose Chroma or libSQL ports publicly without auth.
5. Don't skip Sealed Variables. Plaintext env vars are visible in Railway UI.
6. Don't run rsync with `--delete` in v1.
7. Don't use Electron AionUi. Use the headless server build.
8. Don't try to fit four services in one Railway service. Split per ADR-2.
9. Don't keep the contributor's `claude-mem-sync` in active use after Phase 1 — deprecate it.

---

## 5. Phase 1 — claude-mem libSQL Migration

**Goal:** claude-mem's DB layer uses `@libsql/client` (or `@tursodatabase/sync`) with embedded-replica + remote-primary topology. Memory observations sync transparently across devices via libSQL.

**This is the biggest phase.**

**Realistic estimate (revised 2026-05-04 PM after inventory):** 3–4 weeks of full-time work. The original "1–2 days" reflected a misread of scope — the codebase has 1,255 sync call sites, 8 sync transactions (which become async transactions, the highest-risk conversions), and 47 test files needing async wrappers. See `.scratch/inventory-better-sqlite3.md` for the full surface area.

Phase 1 is therefore **split into two PRs**:
- **Phase 1A (foundation, this PR):** Add `@libsql/client@0.17.3` dep; ship the bootstrap migration script (`scripts/migrate-bun-sqlite-to-libsql.ts`); ship local-dev sqld harness (`containers/sync-host/dev-sqld/`); deprecate `scripts/claude-mem-sync` (banner). NO consumer code changes — `bun:sqlite` remains the runtime DB layer until 1B lands.
- **Phase 1B (consumer cutover, follow-up):** The actual `bun:sqlite` → `@libsql/client` swap across all 83 files. Tracked in `.scratch/PHASE_1_HANDOFF.md`. Done in chunks per the inventory's risk tiers (CRITICAL → HIGH → MEDIUM → LOW).

**Prereqs:**
- A `sqld` primary reachable from your dev machine. For Phase 1 dev work this can be a local `docker run ghcr.io/tursodatabase/libsql-server:v0.24.8` on `localhost:8080`, or use the local-dev harness shipped in 1A at `containers/sync-host/dev-sqld/` (see its README). Phase 2 replaces this with the Railway-hosted `libsql` service.
- `TURSO_DATABASE_URL` (e.g. `http://localhost:8080` for dev, `https://libsql.<your>.railway.app` for prod) and `TURSO_AUTH_TOKEN` (signed JWT) configured in env.

**Tasks:**

1. **SDK choice (resolved by spike):** `@libsql/client@0.17.3`. `@tursodatabase/sync` does NOT work against self-hosted sqld — its sync engine calls `POST /pull-updates`, a Turso-Cloud-only endpoint sqld 0.24.x returns 404 for. Verified live in `.scratch/spike-libsql-sdk.md` §3. Both SDKs are async, so migration cost is unchanged by the choice. Note: `@libsql/client` writes are synchronous gRPC round-trips to the primary — there's no offline-tolerance benefit; SessionEnd hooks must budget for primary RTT or tolerate failures.

2. **Inventory the migration surface.** Already done — see `.scratch/inventory-better-sqlite3.md`. 1,255 call sites across 83 files, 8 transaction hotspots, 47 affected test files. To re-verify:
   ```bash
   grep -rn "bun:sqlite\|new Database\|prepare\|\.run\|\.get\|\.all" /Users/alexnewman/Scripts/claude-mem/src | wc -l
   ```
   Read `src/services/sqlite/Database.ts` in full. List every file that imports it.

3. **Refactor.** Move all DB calls behind an async interface. Concretely:
   - Wrap `Database` in an async facade. Every method that was sync becomes `async`.
   - Propagate `await` through callers — likely affects `SessionManager`, `ClaudeProvider`, hooks, MCP routes.
   - Update tests.

4. **Wire libSQL.** In `Database.ts`, replace the `bun:sqlite` constructor with libSQL client pointed at self-hosted sqld:
   ```ts
   import { createClient } from '@libsql/client';
   const db = createClient({
     url: `file:${DATA_DIR}/claude-mem.db`,                 // local embedded replica
     syncUrl: process.env.TURSO_DATABASE_URL,                // self-hosted sqld URL
     authToken: process.env.TURSO_AUTH_TOKEN,                // signed JWT
     syncInterval: 30000,
   });
   ```
   For dev: `TURSO_DATABASE_URL=http://localhost:8080` (local sqld in docker). For prod: `TURSO_DATABASE_URL=http://libsql.railway.internal:8080` (private DNS to the Railway `libsql` service). Cite: https://docs.turso.tech/features/embedded-replicas/introduction

5. **Run migrations against the libSQL DB.** Existing migrations in `src/services/sqlite/migrations/` should run unchanged (libSQL preserves SQLite SQL). Verify each one applies cleanly.

6. **Bootstrap from existing local DB.** Write `scripts/migrate-bun-sqlite-to-libsql.ts` — opens the existing `~/.claude-mem/claude-mem.db` with `bun:sqlite` (last time), reads all rows, writes them via libSQL client to the remote primary. One-time, idempotent (use INSERT OR IGNORE on a content hash).

7. **Add explicit sync hooks.** In SessionStart, call `await db.sync()` (embedded replica) or `await db.pull()` (`@tursodatabase/sync`). In SessionEnd, call `await db.sync()` / `await db.push()`.

8. **Remove `bun:sqlite` imports from `src/`.** `bun:sqlite` is built into the Bun runtime, not a `package.json` dep, so there's no entry to delete — but every `import { Database } from 'bun:sqlite'` must be gone. `grep -r "bun:sqlite" src/` should return empty after 1B.

9. **Deprecate the contributor's `scripts/claude-mem-sync`.** Add a `WARNING: deprecated, replaced by libSQL embedded replicas` banner; keep the file for one release.

**Documentation references:**
- `src/services/sqlite/Database.ts` — current driver
- `docker/claude-mem/Dockerfile:19-23` — Bun version pin
- https://docs.turso.tech/sdk/ts/quickstart
- https://github.com/tursodatabase/libsql-client-ts (issues page for known gotchas)

**Verification:**
- [ ] All claude-mem tests pass after migration.
- [ ] On Mac, create a new observation; within 60s, `turso db shell <name> "select count(*) from observations"` shows the row on the primary.
- [ ] On a freshly-deployed container with empty local DB: `db.sync()` pulls all observations from primary. Worker boots; `mem-search` finds them.
- [ ] Concurrent writes from two devices: both end up on the primary; neither device "loses" rows on next sync.
- [ ] Bootstrap script imports existing `~/.claude-mem/claude-mem.db` with row counts matching.
- [ ] `grep "bun:sqlite" src/` returns empty.

**Anti-pattern guards:**
- Don't ignore the async-API change. Synchronous `db.prepare(...).run(...)` calls are the long pole; convert systematically, file by file.
- Don't deploy without the bootstrap. Migrating production memory must be reversible.
- Don't skip tests. The DB layer is load-bearing.
- Don't compare `lastInsertRowid` to a `number` directly — libSQL returns BigInt. Run `Number(result.lastInsertRowid)` or use `===` against another BigInt. Existing code paths that do `Number(result.lastInsertRowid)` already work; new ones must follow the same pattern. Run `tsc --noEmit` after the swap to catch BigInt mismatches.
- Don't reuse a directory that already contains another libSQL replica's sidecar files. Embedded replicas write `.db-info`, `.db-wal`, `.db-shm`, `.db-client_wal_index` next to the main file. Stale sidecars cause replication-state confusion. The bootstrap script must clean stale sidecars before opening; the local-dev README documents the same recipe.

---

## 6. Phase 2 — Railway Multi-Service Deployment

**Goal:** A `railway.toml` (or service definitions in the Railway UI) that brings up `app` + `chroma` + `libsql` services in one Railway project, all three with persistent volumes, with private networking between them, with public exposure for AionUi WebUI and sshd.

**Prereqs:** Phase 1 merged. Local dev sqld validated (Phase 1 dev). Railway account + CLI installed.

**Tasks:**

1. Create `containers/sync-host/` directory:
   - `Dockerfile` (extends `docker/claude-mem/Dockerfile`)
   - `entrypoint.sh` (extends `docker/claude-mem/entrypoint.sh`)
   - `railway.toml` (Railway config) **or** documentation for the UI flow
   - `.dockerignore`

2. **Dockerfile** — extend the existing one:
   ```dockerfile
   # Base: identical structure to docker/claude-mem/Dockerfile
   # Plus:
   USER root
   RUN apt-get update && apt-get install -y --no-install-recommends \
         openssh-server rsync autossh \
       && rm -rf /var/lib/apt/lists/*
   
   # Clone & build AionUi server
   RUN git clone --depth 1 https://github.com/iOfficeAI/AionUi /opt/aionui \
       && cd /opt/aionui && bun install && bun run build:server
   
   # Configure sshd: pubkey-only, port 22
   COPY containers/sync-host/sshd_config /etc/ssh/sshd_config
   RUN mkdir -p /run/sshd
   
   USER node
   ```
   Cite: `docker/claude-mem/Dockerfile:1-54` (base), `iOfficeAI/AionUi/package.json:build:server`.

3. **`entrypoint.sh`** — extends `docker/claude-mem/entrypoint.sh`:
   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   
   # 1. Auth: same as docker/claude-mem/entrypoint.sh
   #    Plus: if CLAUDE_CODE_CREDENTIALS_JSON env var is set (Sealed Var), 
   #    write it to a tempfile and use it as CLAUDE_MEM_CREDENTIALS_FILE
   if [[ -n "${CLAUDE_CODE_CREDENTIALS_JSON:-}" && -z "${CLAUDE_MEM_CREDENTIALS_FILE:-}" ]]; then
     CRED_TMP="$(mktemp)"
     printf '%s' "$CLAUDE_CODE_CREDENTIALS_JSON" > "$CRED_TMP"
     export CLAUDE_MEM_CREDENTIALS_FILE="$CRED_TMP"
   fi
   
   mkdir -p "$HOME/.claude" "$HOME/.claude-mem"
   if [[ -n "${CLAUDE_MEM_CREDENTIALS_FILE:-}" && -f "${CLAUDE_MEM_CREDENTIALS_FILE}" ]]; then
     cp "$CLAUDE_MEM_CREDENTIALS_FILE" "$HOME/.claude/.credentials.json"
     chmod 600 "$HOME/.claude/.credentials.json"
   fi
   
   # 2. Authorized SSH keys from Sealed Var
   mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
   printf '%s\n' "${SSH_AUTHORIZED_KEYS:-}" > "$HOME/.ssh/authorized_keys"
   chmod 600 "$HOME/.ssh/authorized_keys"
   
   # 3. Start sshd, claude-mem worker, AionUi server (supervisord or shell wrapper)
   exec /usr/local/bin/supervisord -c /etc/supervisord.conf
   ```
   Cite: `docker/claude-mem/entrypoint.sh:1-18`.

4. **Railway services config:**
   - **Service `app`:**
     - Build: Dockerfile at `containers/sync-host/Dockerfile`. Set `RAILWAY_DOCKERFILE_PATH=containers/sync-host/Dockerfile`.
     - Volume: 5 GB at `/home/node`.
     - Sealed Variables: `CLAUDE_CODE_CREDENTIALS_JSON`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `SSH_AUTHORIZED_KEYS`, `AIONUI_PASSWORD_HASH`.
     - Plain Variables: `CLAUDE_MEM_CHROMA_HOST=chroma.railway.internal`, `CLAUDE_MEM_CHROMA_PORT=8000`, `CLAUDE_MEM_CHROMA_MODE=http`, `CLAUDE_MEM_DATA_DIR=/home/node/.claude-mem`, `CLAUDE_CONFIG_DIR=/home/node/.claude`, `CLAUDE_MEM_WORKER_PORT=37800`.
     - Public HTTP target: AionUi port (verify in `dist-server/server.mjs`).
     - TCP Proxy: port 22 (sshd).
   - **Service `chroma`:**
     - Image: `chromadb/chroma:0.6.x` (pin a real tag).
     - Volume: 2 GB at `/data`.
     - Plain variable: `IS_PERSISTENT=TRUE`.
     - No public domain.
   - **Service `libsql`:**
     - Image: `ghcr.io/tursodatabase/libsql-server:v0.24.8` (do **not** use `:latest` — it points at v0.22.0 from May 2024).
     - Volume: 5 GB at `/var/lib/sqld`.
     - Sealed Variable: `SQLD_AUTH_JWT_KEY` (the public key half of the JWT keypair; the private key never leaves your local keystore).
     - Plain Variables: `SQLD_NODE=primary`, `SQLD_DB_PATH=/var/lib/sqld/iku.db` (matches sqld v0.24.8's default db filename — set explicitly so it's stable across version bumps), `SQLD_HTTP_LISTEN_ADDR=0.0.0.0:8080`.
     - No public domain. Reachable inside the project at `libsql.railway.internal:8080`.
     - **Disk safety:** WAL can grow to ~9× main-DB size during heavy writes (verified in libSQL vector experiment). Add a daily cron inside the container running `PRAGMA wal_checkpoint(TRUNCATE)` to keep WAL bounded. See `.scratch/post-mortem-2026-05-04.md` §7.

5. **First-time setup steps (one-time, manual):**
   - Generate a JWT keypair locally: `openssl genpkey -algorithm Ed25519 -out sqld-private.pem; openssl pkey -in sqld-private.pem -pubout -out sqld-public.pem`. Sign a long-lived bearer token with the private key — that's `TURSO_AUTH_TOKEN`. Store `sqld-public.pem` contents as the `SQLD_AUTH_JWT_KEY` Sealed Variable on the `libsql` service.
   - Set all Sealed Variables in Railway UI.
   - Deploy `libsql` first. Verify private DNS resolves: from any other service shell, `curl http://libsql.railway.internal:8080/health` returns 200.
   - Deploy `chroma`. Verify private DNS works.
   - Deploy `app`. Verify boot in logs. The worker should connect to both `libsql.railway.internal:8080` and `chroma.railway.internal:8000` at startup.
   - SSH into `app`: `ssh -p <railway-tcp-port> node@proxy.rlwy.net`.
   - Inside container: `cd /opt/aionui && bun run server:resetpass:prod` — set WebUI password.
   - Phone: open public AionUi URL, log in.

6. **Mac-side SSH tunnel for Chroma + sqld access** — launchd plist or shell startup script. Single autossh process, multiple `-L` forwards:
   ```bash
   autossh -M 0 -N \
     -L 8000:chroma.railway.internal:8000 \
     -L 8080:libsql.railway.internal:8080 \
     -p <railway-tcp-port> node@proxy.rlwy.net
   ```
   Mac's `~/.claude-mem/settings.json` then sets:
   - `CLAUDE_MEM_CHROMA_HOST=127.0.0.1`, `CLAUDE_MEM_CHROMA_PORT=8000`
   - `TURSO_DATABASE_URL=http://127.0.0.1:8080`, `TURSO_AUTH_TOKEN=<signed-jwt>`

   Tunnel reconnects on drop.

7. **Backfill local Chroma** (optional): copy Mac's `~/.claude-mem/chroma/` into container's volume on first deploy. Skip if you're OK with phone-side searches missing pre-cutover embeddings.

8. **Bootstrap libSQL primary from existing Mac DB.** Run the Phase 1 bootstrap script (`scripts/migrate-bun-sqlite-to-libsql.ts`) pointed at the production sqld URL. This is a one-time push of the existing 77k+ observations to the primary so both replicas (Mac + container) start synced.

**Documentation references:**
- `docker/claude-mem/{Dockerfile,run.sh,entrypoint.sh}` — base pattern
- https://docs.railway.com/guides/dockerfiles, https://docs.railway.com/reference/tcp-proxy, https://docs.railway.com/reference/volumes, https://docs.railway.com/guides/variables
- https://docs.trychroma.com/guides/deploy/docker

**Verification:**
- [ ] `chroma.railway.internal:8000` reachable from `app` (`curl` from inside the container).
- [ ] AionUi public URL serves the WebUI (HTTPS).
- [ ] `ssh node@proxy.rlwy.net -p <port>` works with the public key, password rejected.
- [ ] Inside container: `claude -p "say hi"` returns a response (proves OAuth credential mount worked).
- [ ] Mac SSH tunnel established; `curl http://127.0.0.1:8000/api/v2/heartbeat` works on Mac.
- [ ] `claude-mem` worker on container boots and reaches READY (`/api/health`).
- [ ] Restart `app` service; volumes persist (db file, projects/, .claude/).
- [ ] On Mac: `mem-search "anything"` returns hits via the routed Chroma.

**Anti-pattern guards:**
- Don't use Plain Variables for credentials. Sealed only.
- Don't pin `chromadb/chroma:latest` — use a tagged version.
- Don't expose port 22 without `PasswordAuthentication no` in sshd_config.
- Don't run as root after the build steps. The base image's `node` user is correct.

---

## 7. Phase 3 — Hook Wiring (rsync transcripts + projects + git)

**Goal:** SessionStart and SessionEnd hooks handle file sync. Memory sync is automatic via libSQL (Phase 1).

**Prereqs:** Phases 1-2 deployed. SSH access from Mac → `app` working.

**Tasks:**

1. **`~/.claude-mem/synced-projects.json` schema** (lives on Mac; mirrored on container):
   ```json
   {
     "remote_host": "node@proxy.rlwy.net",
     "remote_port": 12345,
     "projects": [
       {
         "name": "claude-mem",
         "local_path": "/Users/alexnewman/Scripts/claude-mem",
         "remote_path": "/home/node/projects/claude-mem",
         "default_branch": "main",
         "claude_project_id": "-Users-alexnewman-Scripts-claude-mem"
       }
     ]
   }
   ```
   `claude_project_id` is the encoded path Claude Code uses under `~/.claude/projects/`.

2. **`src/hooks/sync-on-session-end.ts`:**
   - Read config; locate active project (match `cwd` to `local_path`).
   - In background:
     - `await db.push()` (libSQL — already covered by Phase 1, but explicit `await` here ensures completion before exit log).
     - `rsync -avz --filter=':- .gitignore' --exclude .git --exclude node_modules <local_path>/ <remote_host>:<remote_path>/` (project source).
     - `rsync -avz $HOME/.claude/projects/<claude_project_id>/ <remote_host>:/home/node/.claude/projects/<claude_project_id>/` (transcripts).
     - `git push origin <branch>` if commits ahead. (No auto-commit.)
   - Always exit 0; failures logged to `~/.claude-mem/logs/sync.log`.

3. **`src/hooks/sync-on-session-start.ts`:**
   - Read config; locate active project.
   - Foreground (must complete before SessionStart context injection):
     - `await db.pull()` / `db.sync()` (libSQL).
     - `rsync -avz <remote_host>:/home/node/.claude/projects/<claude_project_id>/ $HOME/.claude/projects/<claude_project_id>/` (transcripts).
     - `git fetch && git pull --ff-only` if working tree is clean; else log warning, skip.
   - rsync of project source from container → Mac is **omitted in v1** — Mac is the source of truth for project files; phone-side changes go via git commit.

4. Wire both into `plugin/hooks/hooks.json`.

5. **Mirror hooks on container.** Container's `sync-on-session-end` rsyncs `~/.claude/projects/<id>/` back to Mac. Container's `sync-on-session-start` pulls from Mac.

6. **OAuth concurrent-use smoke test (one-time):**
   - End a Claude Code session on Mac.
   - Within the same minute, end one on container (via AionUi).
   - Verify both responses succeeded.
   - If either failed: switch container to `ANTHROPIC_API_KEY` Sealed Variable, redeploy.

**Documentation references:**
- `plugin/hooks/hooks.json` — hook registration
- `src/hooks/*.ts` — existing hooks as templates
- `src/shared/paths.ts:136-137` — transcript paths

**Verification:**
- [ ] Mac SessionEnd: new observation appears on Turso primary within 60s.
- [ ] Mac SessionEnd: edited file reflects on container at `<remote_path>` within 60s.
- [ ] Mac SessionEnd: Mac's transcript JSONL appears at container's `~/.claude/projects/<id>/`.
- [ ] Container SessionEnd: container's transcript JSONL appears on Mac.
- [ ] Mac SessionStart: pulls latest transcripts from container.
- [ ] Container offline: Mac's SessionEnd logs the failure but does not block exit.
- [ ] OAuth concurrent-use smoke test passes (or ANTHROPIC_API_KEY fallback documented).

**Anti-pattern guards:**
- SessionEnd hooks must be background; SessionStart hooks must be foreground. Different latency budgets.
- Don't rsync `--delete` in v1.
- Don't auto-commit on the user's behalf.
- Don't pull git if working tree has uncommitted changes.

---

## 8. Phase 4 — AionUi WebUI + Phone Bookmark

**Goal:** Phone bookmarked to AionUi WebUI; tapping a synced project opens a Claude Code session with full context.

**Prereqs:** Phases 1-3.

**Tasks:**

1. AionUi password set in Phase 2 step 5.
2. Phone opens public AionUi URL (Railway HTTP edge auto-SSL). Log in. Add to home screen as PWA.
3. In AionUi, open `/home/node/projects/<name>/`. Verify:
   - File tree matches Mac's project source (including unstaged edits from last SessionEnd).
   - Conversations panel shows transcripts from Mac (rsynced via Phase 3).
   - Starting a Claude Code session inside AionUi succeeds without auth prompt.
   - claude-mem SessionStart context appears (proves libSQL replica synced + memory injection works).
   - `mem-search` returns observations created on Mac before the phone session.

4. Confirm AionUi's launch env includes the credential file path. In an AionUi-spawned session: `ls -la $HOME/.claude/.credentials.json` should show `-rw------- 1 node node ...`.

**Verification:**
- [ ] WebUI loads on phone.
- [ ] Synced project's files visible.
- [ ] Synced project's transcripts visible.
- [ ] Claude Code launches without auth prompt.
- [ ] mem-search hits cross-device observations.

**Anti-pattern guards:**
- Don't expose AionUi without auth even on Railway. Set the password.
- Don't run AionUi as root.

---

## 9. Phase 5 — End-to-End Verification

**Goal:** Demonstrate §1 success criteria.

For each criterion, run, time, log.

### Test (a): Uncommitted file roundtrip
1. Mac: edit `scratch-test-{ts}.md` in a synced project, end session, close lid.
2. Phone (AionUi): open project, find file, verify content. ≤60s.

### Test (b): Memory + conversation roundtrip Mac → phone
1. Mac: run a Claude Code task that creates observations on a unique topic.
2. End session, close lid.
3. Phone: open same project in AionUi.
   - Conversations panel shows Mac's session.
   - Start a new session, `mem-search "<unique topic>"` → hits.

### Test (c): Memory + conversation roundtrip phone → Mac
1. Phone: AionUi → project → new session → create observations on a different unique topic, also commit + push code changes.
2. End session.
3. Mac: open project; SessionStart hook pulls. Verify transcripts present, `mem-search` hits, `git log` shows the new commit.

### Test (d): Wall-clock budget
- All of (a)–(c) ≤60s on a healthy network.

### Failure-mode tests
- Disconnect Mac mid-rsync. Verify graceful failure, log entry.
- Restart `app` service mid-sync. Verify next sync recovers.
- Two devices write conflicting observations within 5 min. Verify Turso primary holds both (no row loss); replicas converge.
- Rotate `CLAUDE_CODE_CREDENTIALS_JSON` Sealed Variable. Redeploy. Verify container picks up new creds.

**Verification rollup:**
- [ ] (a), (b), (c) pass within 60s.
- [ ] All failure-mode tests pass.
- [ ] User says "yes, that feels seamless."

---

## 10. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| libSQL async migration is bigger than estimated | Confirmed | High | Verified by inventory (`.scratch/inventory-better-sqlite3.md`): 1,255 sync call sites, 8 transactions, 47 test files. Mitigation: split into 1A (foundation) + 1B (cutover); 1A unblocks Phase 2 deploy work. 1B done as bounded weekly chunks per the inventory's risk tiers. |
| Concurrent OAuth use causes session revocation | Med | High | Phase 3 step 6 smoke test → ANTHROPIC_API_KEY fallback |
| sqld WAL grows unboundedly under sustained writes | Med | High | Daily `wal_checkpoint(TRUNCATE)` cron inside the `libsql` container; alert if WAL > 5× main-DB size. Verified in libSQL vector experiment that WAL hit 9.4× under bulk-load. |
| sqld disk fills the Railway volume | Low | High | Volume sized at 5 GB; main-DB + WAL stays under 2 GB at current obs growth rate. Monitor; resize if approaching 70%. |
| `@tursodatabase/sync` SDK doesn't support self-hosted sqld | Confirmed | n/a | Verified true by spike (`.scratch/spike-libsql-sdk.md`); SDK choice locked to `@libsql/client@0.17.3`. Risk closed. |
| sqld JWT auth misconfigured → silent replica drift | Med | High | Phase 1 verification asserts a write on Mac appears in `turso db shell`-equivalent on the primary within 60s. Fail loud, not silent. |
| Railway TCP proxy port changes after redeploy | Low | Med | Update `synced-projects.json:remote_port`; fix via `autossh` config or DNS-style indirection |
| Chroma client-side embedding burns Mac CPU | Low | Low | Already mitigated by PR #2282 (per-batch watermark, killProcessTree, max-3 backfill concurrency). The CPU storm bugs that prompted concern are closed. |
| `git pull` would clobber Mac in-progress work | Med | High | Phase 3 hook checks "working tree clean" |
| AionUi server build breaks on a future commit | Low | Med | Pin to a tagged release; rebuild deliberately |
| rsync wipes phone-edited file via `--delete` | n/a | n/a | Not used |

---

## 11. Out of Scope for v1

- Bidirectional rsync of project source (Mac is source of truth).
- Real-time (sub-1s) sync.
- Multi-Mac syncs.
- Auto-resolution of git merge conflicts.
- Server-side Chroma embedding offload.
- Chroma replication / multi-region.
- Encryption at rest beyond what each tool provides.
- Native mobile app.
- Slash commands, viewer UI badges, drift detection.
- Customer onboarding automation (the Railway Template work is post-v1).

---

## 12. Phase Dependency Graph

```
Phase 0 (DONE)
   │
   ▼
Phase 1 — claude-mem libSQL migration  ←── independent code work
   │
   ▼
Phase 2 — Railway multi-service deployment
   │
   ▼
Phase 3 — Hook wiring (rsync transcripts + projects + git)
   │
   ▼
Phase 4 — AionUi WebUI + phone bookmark
   │
   ▼
Phase 5 — End-to-end verification
```

Linear. Phase 1 is the long pole.

---

## 13. Re-Entry Notes

Each phase is self-contained: cites file paths, line numbers, doc URLs. To execute Phase N in a fresh chat:

1. Read this file from §1 through §4 (Phase 0 findings) for context.
2. Skim §2 ADRs — these are locked decisions, do not re-litigate.
3. Read `.scratch/post-mortem-2026-05-04.md` if touching libSQL — it has hard-won knowledge about WAL growth, `wal_checkpoint(TRUNCATE)` timing, and what `sqld` does badly under bulk-load.
4. Skip to §N+4 for the phase being executed.
5. Use the phase's verification checklist as definition of done.

**Currently next:** Phase 1 — claude-mem libSQL migration. Start by spinning up local sqld in docker (see Phase 1 Prereqs), then run the inventory grep in Phase 1 task 2 to scope the refactor.

---

## 14. What Changed

### v5 (2026-05-04 PM, Phase 1A merge) — current
- SDK locked to `@libsql/client@0.17.3` (`@tursodatabase/sync` rejected: doesn't work against sqld; verified via spike).
- Image pinned to `ghcr.io/tursodatabase/libsql-server:v0.24.8`.
- Phase 1 split into 1A (foundation) and 1B (consumer cutover) after inventory revealed 1,255 sync call sites.
- Driver name corrected throughout: `bun:sqlite`, not `better-sqlite3`.
- SQLD default DB filename in v0.24.8 is `iku.db` (not `data.db`); set explicitly.
- BigInt + sidecar-files anti-patterns added to §5.
- Risk register updated: scope risk now Confirmed.

### v4 (2026-05-04 PM)
- **Self-hosted `sqld` chosen** (closes the v3 open question on Turso cloud vs self-host). All references to "Turso cloud free tier" replaced with self-hosted `sqld` running as the `libsql` Railway service. Auth via signed JWT bearer token; `SQLD_AUTH_JWT_KEY` Sealed Variable.
- **Chroma confirmed kept.** A v4 *draft* (`sync-container-plan-v4-draft.md`, deleted) had proposed dropping Chroma in favor of libSQL native vectors + `@xenova/transformers`. That experiment failed at 4-hour wall-clock — `CREATE INDEX libsql_vector_idx` ran 3+ hours without completing, WAL grew to 14 GB on a 1.5 GB main DB. See `.scratch/post-mortem-2026-05-04.md`. Separately, the chroma-mcp CPU-storm bugs that motivated the migration were independently fixed in PR #2282 (per-batch watermark, killProcessTree, pgid registration, max-3 backfill concurrency, kernel-enforced child cleanup #2216). The architectural cost of keeping Chroma (Python/uv in container, separate service, Mac→container SSH tunnel) is accepted.
- **`libsql` service is required, not optional.** ADR-2 services table now lists three required services.
- **Risk Register updated:** added sqld-specific risks (WAL growth, JWT misconfig, SDK compatibility); removed Turso free-tier rate-limit risk; downgraded Chroma CPU risk to "already mitigated" with reference to PR #2282.
- **Phase 1 prereqs:** local sqld in docker for dev, replacing "create Turso database."
- **Phase 2 first-time setup:** added JWT keypair generation step, sqld deploy as the first service (rather than chroma-first).
- **Mac-side SSH tunnel:** now forwards both Chroma (8000) and sqld (8080) over a single autossh process.
- **Pre-validated facts folded in:** libSQL opens prod `claude-mem.db` cleanly (file-format compatibility verified 2026-05-04 by `step1-open-asis.mjs`).

### v3 (2026-05-04 AM)
- **Memory sync = libSQL/Turso embedded replicas**, replacing the contributor's `claude-mem-sync` script entirely. Adds Phase 1 (DB layer migration). Removes the script's table-coverage limitation as a concern.
- **Host = Railway.** Multi-service architecture (one project, two services: `app` + `chroma`; optional third for `libsql`). Replaces the prior "VPS + Tailscale" framing.
- **Conversations sync** added explicitly: rsync of `~/.claude/projects/<id>/` alongside project source (Phase 3). Was missing entirely before.
- **OAuth pattern = reuse existing `docker/claude-mem/` flow.** No `claude setup-token` required. The user pointed out this prior art exists; we use it.
- **Sealed Variables** for all secrets (replaces `.env` file thinking).
- **SSH tunnel from Mac to Chroma** via Railway TCP Proxy (replaces "Tailscale-routable Chroma").
- **Open questions reduced from 3 to 1** (Turso cloud vs self-host).

Net: same UX target. v4 locks in every architectural decision; the only remaining work is execution.
