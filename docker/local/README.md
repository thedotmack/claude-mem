# claude-mem-local: the stable Docker worker

The problem this solves: developing claude-mem on this machine breaks memory
capture for every session, because `npm run build-and-sync` replaces the
installed plugin and restarts the one shared worker. If the dev build is
broken, nothing is remembered until it's fixed.

This setup runs a **pinned, known-good claude-mem worker in Docker** with its
own copy of the database. Host hooks talk to it over HTTP and never manage its
lifecycle, so dev churn on the host can't take it down. You upgrade it
deliberately, only when a build is known to work.

## Components

| Piece | Purpose |
|---|---|
| `docker/local/Dockerfile` | Image running `worker-service.cjs --daemon` (legacy worker: SQLite + local Chroma) from this checkout's `plugin/` build |
| `docker-compose.local.yml` | Service `claude-mem-local`, volume `claude-mem-local-data`, port `127.0.0.1:37777`, `restart: unless-stopped` |
| `docker/local/seed-data.sh` | One-time copy of host `~/.claude-mem` (safe SQLite `.backup`, Chroma, settings) into the volume |
| `scripts/claude-mem-docker.sh` | `on` / `off` / `status` / `seed` / `build` / `upgrade` / `logs` |

## External worker mode

`CLAUDE_MEM_EXTERNAL_WORKER=true` in `~/.claude-mem/settings.json` (set/unset
by the `on`/`off` commands) changes hook behavior:

- `ensureWorkerRunning()` only health-checks the worker — no lazy-spawn, no
  PID-file validation, no version-mismatch recycling (`src/shared/worker-utils.ts`).
- `worker-service start` degrades to a health probe; `stop`/`restart` no-op
  with exit 0, so `build-and-sync`'s `worker:restart` step passes through
  without touching the container (`src/services/worker-service.ts`).
- `--daemon` is NOT guarded — it's how the container itself runs.

## Daily use

```bash
scripts/claude-mem-docker.sh on      # memory runs in Docker (persists across reboots)
scripts/claude-mem-docker.sh off     # back to the normal host worker
scripts/claude-mem-docker.sh status  # mode + container + worker health
scripts/claude-mem-docker.sh logs    # tail the worker
```

The container has `restart: unless-stopped`: it survives crashes and machine
reboots until you explicitly turn it `off`.

## Upgrading the container

When a build is known-good (e.g. after a release):

```bash
scripts/claude-mem-docker.sh upgrade   # npm run build + image rebuild + restart
```

The data volume is never touched by upgrades.

## Developing while the container serves memory

- `npm run build-and-sync` works normally; its worker-restart step no-ops in
  external mode.
- To run a **dev worker** without touching the container, give it its own port
  and data dir:

  ```bash
  CLAUDE_MEM_WORKER_PORT=37778 CLAUDE_MEM_DATA_DIR=~/.claude-mem-dev \
    bun plugin/scripts/worker-service.cjs --daemon
  ```

  A Claude session pointed at the dev worker exports the same two env vars
  (env overrides beat settings.json).

## Data notes

- The volume holds an independent COPY of the database made at seed time; the
  container is the source of truth from then on. `~/.claude-mem` on the host
  becomes the dev database.
- Transcripts are read from the host via a read-only mount of
  `~/.claude/projects` at the identical absolute path (hooks send absolute
  transcript paths).
- Re-seeding (`seed --force`) DISCARDS everything captured in the container
  since the last seed. To pull data out instead, use the worker HTTP API or
  `docker cp` from a helper container.
- Known gap: an old plugin version (without the external-mode guard) running
  `worker-service restart` will POST a shutdown to port 37777 and briefly kill
  the container's worker; Docker restarts it automatically within seconds.
