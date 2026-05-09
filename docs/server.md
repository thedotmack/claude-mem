# Claude-Mem Server

Claude-Mem Server is the beta server runtime for Claude-Mem 13. The existing worker remains available for compatibility; server beta adds API-key auth, team/project-aware storage contracts, REST V1 routes, and an optional BullMQ queue backend.

Local development can use SQLite queues and the explicit `CLAUDE_MEM_AUTH_MODE=local-dev` plus `CLAUDE_MEM_ALLOW_LOCAL_DEV_BYPASS=1` loopback bypass. Deployable mode should use:

```sh
CLAUDE_MEM_QUEUE_ENGINE=bullmq
CLAUDE_MEM_REDIS_URL=redis://127.0.0.1:6379
CLAUDE_MEM_AUTH_MODE=api-key
```

Use `claude-mem server api-key create --scope memories:read,memories:write` to create a bearer key. The raw key is shown once; only a SHA-256 hash is stored.
