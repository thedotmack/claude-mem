# Docker

The root `docker-compose.yml` starts Claude-Mem Server beta with a persistent Valkey sidecar.

```sh
docker compose up --build
curl http://127.0.0.1:37777/healthz
```

The server container uses:

- `CLAUDE_MEM_WORKER_HOST=0.0.0.0`
- `CLAUDE_MEM_DATA_DIR=/data/claude-mem`
- `CLAUDE_MEM_QUEUE_ENGINE=bullmq`
- `CLAUDE_MEM_REDIS_URL=redis://valkey:6379`
- `CLAUDE_MEM_AUTH_MODE=api-key`

Create an API key inside the container before using protected V1 write routes.

## External memory mirror stack

Use `docker-compose.external-memory.yml` when you want only the external memory substrate for the legacy worker runtime (`CLAUDE_MEM_EXTERNAL_MEMORY_ENABLED=true`) without starting the server-beta HTTP/worker containers.

```sh
cp external-memory.env.example external-memory.env
# edit external-memory.env and change POSTGRES_PASSWORD and VALKEY_PASSWORD
docker compose --env-file external-memory.env -f docker-compose.external-memory.yml up -d
```

Local worker environment:

```sh
export CLAUDE_MEM_EXTERNAL_MEMORY_ENABLED=true
export CLAUDE_MEM_PGVECTOR_URL='postgres://claude_mem:<password>@127.0.0.1:15432/claude_mem'
export CLAUDE_MEM_VALKEY_URL='redis://:<valkey-password>@127.0.0.1:16379'
```

The external compose file binds database/cache ports to `127.0.0.1` only:

- pgvector/Postgres: `127.0.0.1:15432` → container `pgvector:5432`
- Valkey: `127.0.0.1:16379` → container `valkey:6379` with `requirepass`

## Cloudflare Tunnel service addresses

Register these as Cloudflare Tunnel service values, depending on where `cloudflared` runs.

### Root server-beta compose

If `cloudflared` joins the same Docker network as the root compose stack:

| Purpose | Tunnel service value |
|---------|----------------------|
| Claude-Mem HTTP API | `http://claude-mem-server:37777` |

If `cloudflared` runs on the Docker host:

| Purpose | Tunnel service value |
|---------|----------------------|
| Claude-Mem HTTP API | `http://127.0.0.1:37777` |

The root compose database and queue services are internal implementation details. Do not publish them over Tunnel unless you add database-level credentials and Cloudflare Access/WARP policy appropriate for raw TCP services.

### External memory compose

If `cloudflared` joins the same Docker network as `docker-compose.external-memory.yml`:

| Purpose | Tunnel service value |
|---------|----------------------|
| pgvector/Postgres | `tcp://pgvector:5432` |
| Valkey | `tcp://valkey:6379` |

If `cloudflared` runs on the Docker host:

| Purpose | Tunnel service value |
|---------|----------------------|
| pgvector/Postgres | `tcp://127.0.0.1:15432` |
| Valkey | `tcp://127.0.0.1:16379` |

Example locally managed tunnel ingress:

```yaml
ingress:
  - hostname: cm-db.example.com
    service: tcp://127.0.0.1:15432
  - hostname: cm-valkey.example.com
    service: tcp://127.0.0.1:16379
  - hostname: cm-api.example.com
    service: http://127.0.0.1:37777
  - service: http_status:404
```

Cloudflare treats non-HTTP Tunnel services as TCP streams; clients need `cloudflared access tcp` or WARP/client-to-tunnel access. Protect pgvector and Valkey hostnames with Cloudflare Access and do not expose either service directly to the public internet.
