# Phase 1 Spike: libSQL SDK choice

**Date:** 2026-05-04
**Plan:** `.scratch/sync-container-plan.md` §5 task 1.
**TL;DR:** Use **`@libsql/client`**. `@tursodatabase/sync` does **not** work against self-hosted sqld — its engine calls `POST /pull-updates`, a Turso-Cloud-only route sqld 0.24.x returns 404 for.

---

## 1. SDK options

### `@libsql/client`

| Field | Value |
|---|---|
| npm version | `0.17.3` (publ. 2026-04-23) |
| Weekly downloads | **887,086** |
| Repo | [tursodatabase/libsql-client-ts](https://github.com/tursodatabase/libsql-client-ts) |
| Native dep | `libsql@^0.5.28` (napi-rs) |
| Bun + Node 20 | both verified (see §3) |
| Self-hosted sqld | **yes** — `syncUrl` accepts `http(s)://...`; uses `/proxy.Proxy/*` + `/wal_log.ReplicationLog/*` gRPC-web, both served by sqld. No `turso.io` hardcoded. |

Constructor ([docs.turso.tech embedded-replicas](https://docs.turso.tech/features/embedded-replicas/introduction)):
```ts
createClient({
  url: "file:replica.db",
  syncUrl: "http://localhost:8080",   // or libsql:// / https://
  authToken: "...",                   // signed JWT, optional
  syncInterval: 60,                   // seconds; 0 disables auto-sync
})
```

**API:** `await db.execute(sql | {sql,args})` returns `{rows, columns, rowsAffected, lastInsertRowid}` (BigInt). Also `db.batch([...stmts])` and `db.transaction("write")`. No `prepare().run/get/all` — one `execute()` covers all three. Sync: `await db.sync() → {frames_synced, frame_no}`. **Writes are routed remote synchronously** (gRPC round-trip per call); reads are local.

### `@tursodatabase/sync`

| Field | Value |
|---|---|
| npm version | `0.5.3` BETA (publ. 2026-04-02) |
| Weekly downloads | **7,971** (110× less) |
| Repo | [tursodatabase/turso](https://github.com/tursodatabase/turso) (`bindings/javascript/sync`) |
| Native prebuilds | `darwin-arm64`, `linux-x64-gnu`, `linux-arm64-gnu`, `win32-x64-msvc`. **No musl, no darwin-x64.** |
| Bun | unverified (connect fails first) |
| Self-hosted sqld | **NO** (verified §3). |

Connect (from `dist/promise.d.ts`):
```ts
await connect({
  path: "./local.db",
  url?: string | (() => string|null),
  authToken?: string | (() => Promise<string>),
  clientName?: string,
  // longPollTimeoutMs, transform, headers, remoteEncryption
});
```

**API:** better-sqlite3-shaped — `db.exec`, `db.prepare(sql).run/all/get`, `db.transaction(fn)` — all `async`. Sync: `db.pull() → boolean`, `db.push() → void`, `db.checkpoint()`. No `db.sync()` shortcut. Closer ergonomic match to current claude-mem code, but currently unusable against sqld.

---

## 2. Local sqld setup

GHCR tag list (anonymous bearer token): highest stable is **`v0.24.8`**. Do **not** use `latest` — it points at v0.22.0 (May 2024). The plan's `SQLD_DB_PATH=/var/lib/sqld/data.db` is wrong for v0.24.8 — default is `iku.db` next to the volume; set the full absolute path explicitly.

```bash
docker run -d --name spike-sqld \
  -p 8080:8080 \
  -v "$PWD/sqld-data:/var/lib/sqld" \
  -e SQLD_NODE=primary \
  -e SQLD_HTTP_LISTEN_ADDR=0.0.0.0:8080 \
  ghcr.io/tursodatabase/libsql-server:v0.24.8

curl -i http://localhost:8080/health   # → HTTP/1.1 200 OK
curl    http://localhost:8080/v2       # → "Hello, this is HTTP API v2 (Hrana over HTTP)"
```

JWT auth (`SQLD_AUTH_JWT_KEY` + Ed25519-signed bearer) skipped — not load-bearing for SDK selection.

---

## 3. Hello-world test

Script: `/Users/alexnewman/Scripts/claude-mem/.scratch/spike-test.mjs` (also colocated at `.scratch/spike-libsql/spike-test.mjs` for `node_modules` resolution).

Verbatim output against `ghcr.io/tursodatabase/libsql-server:v0.24.8` on `http://localhost:8080`:

```
========== A. @libsql/client embedded replica ==========
[libsql/client] insert rowsAffected: 1 lastInsertRowid: 4
[libsql/client] rows: [
  { id: 1, msg: 'hello-from-libsql-client', ts: 1777928033556 },
  { id: 2, msg: 'hello-from-libsql-client', ts: 1777928088231 },
  { id: 3, msg: 'hello-from-libsql-client', ts: 1777928155260 },
  { id: 4, msg: 'hello-from-libsql-client', ts: 1777928179612 }
]
[libsql/client] calling sync()...
[libsql/client] sync() returned: { frames_synced: 0, frame_no: 10 }

========== B. @tursodatabase/sync ==========
[tursodatabase/sync] connect() FAILED: sync engine operation failed: database sync engine error: remote server returned an error: status=404, body=
[tursodatabase/sync] (connect() does an implicit pull, which 404s on sqld)

========== DONE ==========
```

**Two-replica replication via the same primary** (`replication-test.mjs`):
```
A: inserted, calling sync()..
A sync: { frames_synced: 0, frame_no: 5 }
B sync (initial): { frames_synced: 6, frame_no: 5 }
B sees rows: [ { id: 1, v: 'from-A-1777928138403' } ]
```
Cross-device sync via self-hosted sqld is real, not theoretical.

**Bun smoke test** (`bun-test.mjs`, Bun 1.3.9): `@libsql/client` ran clean — insert + read + sync.

**Network trace from inside the failing connect()** (patched `globalThis.fetch`):
```
[fetch] POST http://localhost:8080/pull-updates
[fetch]   -> 404 Not Found
```
Not auth, not config — sqld doesn't ship that route.

---

## 4. Recommendation

**`@libsql/client@0.17.3` with embedded replicas.**

- Self-hosted sqld is the gating constraint per plan §2 ADR-1; only `@libsql/client` clears it.
- 887k vs 8k weekly downloads; `0.17.x` stable vs `0.5.x` BETA.
- Both SDKs are async — migration cost (every `.run/.get/.all` call site → `await db.execute(...)`) doesn't depend on choice.
- Embedded-replica semantics fit claude-mem: writes authoritative on primary immediately, reads local, frames flow back to all replicas.
- Two-replica round-trip verified live (§3). Bun verified.
- Revisit when `@tursodatabase/sync` gains sqld support; switch is mechanical.

**Cited docs:**
- https://docs.turso.tech/features/embedded-replicas/introduction
- https://docs.turso.tech/sdk/ts/quickstart
- https://github.com/tursodatabase/libsql-client-ts
- https://github.com/tursodatabase/turso (and `bindings/javascript/sync`)
- https://github.com/tursodatabase/go-libsql/issues/42 (analogous self-hosted-sqld report from Go binding)
- https://github.com/tursodatabase/libsql/blob/main/docs/DOCKER.md
- npm registry: https://registry.npmjs.org/@libsql/client , https://registry.npmjs.org/@tursodatabase/sync

---

## 5. Surprises / gotchas

1. **`:latest` GHCR tag is stale** (v0.22.0). Pin `v0.24.8`.
2. **Plan's `SQLD_DB_PATH=/var/lib/sqld/data.db` is wrong** — default db filename in v0.24.8 is `iku.db` (server boot log). Either set an absolute path inside the volume, or accept `iku.db`.
3. **`@libsql/client` writes are synchronous gRPC round-trips to the primary.** If primary is unreachable, writes throw immediately — no offline queueing. This invalidates the plan's "create observations even when network is bad" rationale for preferring `@tursodatabase/sync`. SessionEnd hooks need to budget for primary-RTT or tolerate failures.
4. **`lastInsertRowid` is `BigInt`.** Anywhere existing claude-mem code does `Number(row.id) === expected` will compare against a BigInt and silently mismatch. Run a typecheck pass after the SDK swap.
5. **No musl prebuild for `libsql`** (the napi-rs binary `@libsql/client` peer-depends on). Stick with glibc base images (`node:20-bullseye`/`-slim`) — matches `docker/claude-mem/Dockerfile` already.
6. **Sidecar files.** Embedded replicas write `.db-info`, `.db-wal`, `.db-shm`, `.db-client_wal_index` next to the main file. The Phase 1 bootstrap script must clean stale sidecars before opening, or it'll re-attach to a stale replication state. (See `cleanFiles` helper in `spike-test.mjs`.)
7. **sqld v0.24.8 also binds gRPC on port 5001** (not published in the spike `docker run`). For Railway private DNS this is fine; if anyone fronts with a non-Railway proxy, only forward 8080.
8. **Migration scope is unchanged by SDK choice.** Both are Promise-based; every DB call site needs `await`. The "1-2 days of focused refactoring" estimate stands.

---

**Spike artifacts** (all under `.scratch/`):
- `spike-test.mjs` — canonical runner (per task spec)
- `spike-libsql/spike-test.mjs` — colocated copy for `node_modules` resolution
- `spike-libsql/replication-test.mjs` — two-replica round-trip
- `spike-libsql/bun-test.mjs` — Bun smoke
- `spike-libsql/sync-only.mjs` — fetch-patched probe that revealed `/pull-updates`
- `spike-libsql/node_modules/`, `spike-libsql/sqld-data/` — installed deps + sqld volume; safe to delete

Docker container removed. No claude-mem source touched. No `package.json` outside `.scratch/`.
