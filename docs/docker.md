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

## Redis-compatible servers

The queue is BullMQ, so the `valkey` service can be any server that runs BullMQ's Lua scripts. Tested with v15.9.0: [KiviDB](https://github.com/kividbio/kividb) 1.2.0 (its `kividb/kividb:v1.2.0-lua` image; the default KiviDB image has no Lua) passes `scripts/e2e-server-docker.sh` and the same queue checks (enqueue, retry with backoff, failure after the last attempt, cancel, server and worker restarts, two workers) as Valkey 8 and Redis 8. The compose override and the results are in [KiviDB's claude-mem guide](https://github.com/kividbio/kividb/blob/master/docs/integrations/claude-mem.md).
