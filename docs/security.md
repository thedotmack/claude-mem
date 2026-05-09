# Security

Server beta defaults to API-key auth. `CLAUDE_MEM_AUTH_MODE=local-dev` only enables the loopback development bypass when `CLAUDE_MEM_ALLOW_LOCAL_DEV_BYPASS=1` is also set; do not use it behind a reverse proxy or on a publicly reachable bind address.

API keys are generated with the `cmem_` prefix and displayed once. Claude-Mem stores only a SHA-256 hash, prefix metadata, scopes, status, and timestamps in SQLite.

BullMQ mode requires Redis or Valkey. Queue payloads are limited to work needed to resume observation processing; SQLite remains the canonical memory store. Use Redis persistence for deployable examples and avoid placing server ports on public networks without auth.
