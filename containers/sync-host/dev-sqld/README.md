# Local `sqld` dev harness

## What this is

A docker-compose stack that runs a self-hosted `sqld` primary on `localhost:8080`
so you can develop and test the libSQL embedded-replica migration locally
without provisioning anything on Railway. **This is dev-only.** Phase 2 of
[`.scratch/sync-container-plan.md`](../../../.scratch/sync-container-plan.md)
deploys the production `libsql` Railway service separately; the topology there
is the same image, the same env-var shape, but with private DNS, a sealed JWT
key, and a 5 GB persistent volume — none of which belongs on a contributor's
laptop. Running this harness gives you the same `TURSO_DATABASE_URL` /
`TURSO_AUTH_TOKEN` interface the production primary will expose, against a
container you can blow away whenever you want.

Spike findings — what works against this image, what doesn't, why we pinned
v0.24.8, and the embedded-replica sidecar-file footgun — live in
[`.scratch/spike-libsql-sdk.md`](../../../.scratch/spike-libsql-sdk.md).

## Prerequisites

- Docker (Desktop on macOS, or Engine on Linux). Docker Compose v2 is bundled.
- That's it. No Bun, no Node, no `uv` — the image is self-contained.

## Quickstart

```bash
cd containers/sync-host/dev-sqld
docker compose up -d
curl -i http://localhost:8080/health     # → HTTP/1.1 200 OK
```

Then point claude-mem (or the Phase 1 bootstrap script) at it:

```bash
export TURSO_DATABASE_URL=http://localhost:8080
# TURSO_AUTH_TOKEN intentionally unset — see "Optional: JWT auth" below.
```

The first start downloads the image (~80 MB) and creates `./sqld-data/` with
the primary's database file (`iku.db`) and its WAL/SHM sidecars.

## Verifying it works

```bash
curl -i http://localhost:8080/health
# HTTP/1.1 200 OK

curl http://localhost:8080/v2
# Hello, this is HTTP API v2 (Hrana over HTTP)

curl http://localhost:8080/v3
# Hello, this is HTTP API v3 (Hrana over HTTP)
```

Logs (boot, queries, replication frames):

```bash
docker compose logs -f sqld
```

The healthcheck inside the compose file is intentionally `disable: true`. The
upstream image is distroless — no shell, no `curl`, no `wget` — so an
in-container healthcheck would fail spuriously. Run the host-side `curl` above
instead. (The container is still configured with `restart: unless-stopped`, so
it'll come back if it crashes or the daemon restarts.)

## Optional: JWT auth

For most local dev, no-auth mode (`SQLD_AUTH_JWT_KEY=`) is fine. If you want to
exercise the same auth path the production primary will use, generate an
Ed25519 keypair, hand sqld the public key, and sign a bearer token with the
private key.

### Generate the keypair

```bash
cd containers/sync-host/dev-sqld
openssl genpkey -algorithm Ed25519 -out sqld-private.pem
openssl pkey -in sqld-private.pem -pubout -out sqld-public.pem
```

Both `*.pem` files are `.gitignore`d. Don't commit them.

### Tell sqld about the public key

Copy `.env.example` to `.env`, then paste the **contents** of `sqld-public.pem`
as a single-line value of `SQLD_AUTH_JWT_KEY`:

```bash
cp .env.example .env
# Then edit .env. The value should look like a one-line PEM, e.g.:
#   SQLD_AUTH_JWT_KEY=-----BEGIN PUBLIC KEY-----\nMC...AE=\n-----END PUBLIC KEY-----
# (literal \n, OR the actual file contents on a single line — sqld accepts both
#  PEM and the unwrapped base64.)
```

Restart so sqld picks up the new env:

```bash
docker compose down
docker compose up -d
```

### Sign a long-lived bearer token

Two options. The first uses the helper script in this directory; the second is
a one-liner if you don't want a script.

**Option A — `sign-jwt.mjs` (uses `jose` via `bunx`, no package.json changes):**

```bash
# Bun: pulls `jose` into a per-invocation cache, no global install.
bun x --bun jose >/dev/null 2>&1   # warm jose into the bun cache (one-time, optional)
bun ./sign-jwt.mjs --key ./sqld-private.pem --exp 365d --sub claude-mem-dev
# → eyJhbGciOiJFZERTQSIs...   (single-line JWT)

# Node 20+ alternative (no Bun required):
npx -y -p jose@5 node ./sign-jwt.mjs --key ./sqld-private.pem
```

**Option B — inline one-liner with `jose` via `npx`:**

```bash
TURSO_AUTH_TOKEN=$(npx -y -p jose@5 node -e '
  const {readFileSync} = require("node:fs");
  const {SignJWT, importPKCS8} = require("jose");
  (async () => {
    const pk = await importPKCS8(readFileSync("./sqld-private.pem","utf8"),"EdDSA");
    const t = await new SignJWT({}).setProtectedHeader({alg:"EdDSA"})
      .setSubject("claude-mem-dev").setIssuedAt().setExpirationTime("365d").sign(pk);
    process.stdout.write(t);
  })();
')
```

### Use the token

```bash
export TURSO_DATABASE_URL=http://localhost:8080
export TURSO_AUTH_TOKEN="$(bun ./sign-jwt.mjs --key ./sqld-private.pem)"

# Smoke test (curl with bearer auth):
curl -H "Authorization: Bearer $TURSO_AUTH_TOKEN" http://localhost:8080/v2

# Phase 1 bootstrap script:
bun scripts/migrate-bun-sqlite-to-libsql.ts \
  --target-url "$TURSO_DATABASE_URL" \
  --target-token "$TURSO_AUTH_TOKEN"
```

## Cleanup

```bash
# Stop + remove container, KEEP the volume (DB + sidecars stay in ./sqld-data):
docker compose down

# Stop + remove container AND wipe the volume (clean slate):
docker compose down -v
rm -rf ./sqld-data        # (compose's `down -v` only handles named volumes;
                          #  ours is a host bind mount, so do it manually.)
```

## Reset (clearing a stale local replica)

This is **separate from** wiping the sqld primary's volume above. The sqld
primary lives in `./sqld-data/`. Embedded-replica clients (claude-mem, the
spike scripts) write **their own** sidecar files next to the local replica
file, wherever you opened it — typically `~/.claude-mem/claude-mem.db` or a
test file in your repo.

The replica's sidecars are:

```
<your-replica>.db
<your-replica>.db-info
<your-replica>.db-wal
<your-replica>.db-shm
<your-replica>.db-client_wal_index
```

If a replica gets into a bad state — wrong primary URL, mid-sync crash, schema
mismatch after a reset of the primary — you must delete **all** of these
sidecars or libSQL will re-attach to the stale replication state. From the
directory containing the replica:

```bash
# Adjust the basename to match your replica file:
rm -f claude-mem.db claude-mem.db-info claude-mem.db-wal \
      claude-mem.db-shm claude-mem.db-client_wal_index

# Generic glob version (careful — this matches *all* .db-* files in CWD):
# `claude-mem.db*` already covers the .db-info/.db-wal/.db-shm/.db-client_wal_index sidecars.
rm -f *.db claude-mem.db*
```

Source: spike findings §5 gotcha 6.

## Troubleshooting

### 1. `:latest` is stale (v0.22.0). Always pin v0.24.8.

The GHCR `:latest` tag has not been moved since May 2024 and points at
v0.22.0, which has a different default DB filename, different env-var defaults,
and missing endpoints. The compose file in this directory pins
`v0.24.8`; verify with `docker compose config | grep image`. If you ever see
`v0.22.x` in `docker images`, you've drifted off-pin.

### 2. macOS Keychain prompts on `docker compose up`

If you're on Docker Desktop for macOS, the first `docker` invocation in a new
shell session may pop a Keychain prompt asking permission for the Docker CLI
to use the Docker socket. This is a Docker Desktop behavior, not a sqld one.
Allow it once and it's cached.

### 3. Port 8080 is already in use

Something else is on `:8080` (Adminer, Spring Boot dev server, another sqld,
etc.). Two ways out:

```bash
# Find the offender:
lsof -nP -iTCP:8080 -sTCP:LISTEN

# Or relocate this stack to an alt port via an override + project name:
cat > docker-compose.override.yml <<'EOF'
services:
  sqld:
    ports:
      - "18080:8080"
EOF
docker compose -p claude-mem-dev-sqld-alt up -d
# Then point clients at http://localhost:18080
```

The `-p` (project name) flag namespaces compose's resources so this alt-port
stack doesn't collide with another `claude-mem-dev-sqld` stack you may have
running.

## References

- Spike findings: [`.scratch/spike-libsql-sdk.md`](../../../.scratch/spike-libsql-sdk.md)
- Implementation plan: [`.scratch/sync-container-plan.md`](../../../.scratch/sync-container-plan.md)
- libsql-server Docker docs: <https://github.com/tursodatabase/libsql/blob/main/docs/DOCKER.md>
- Embedded replicas: <https://docs.turso.tech/features/embedded-replicas/introduction>
- libsql-server source: <https://github.com/tursodatabase/libsql/tree/main/libsql-server>
- libsql-client-ts (the SDK we'll use against this primary): <https://github.com/tursodatabase/libsql-client-ts>
