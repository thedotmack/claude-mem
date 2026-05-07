# Security

Server beta defaults to localhost development mode. Do not bind it to a public interface without `CLAUDE_MEM_AUTH_MODE=api-key` and a bearer API key.

API keys are generated with the `cmem_` prefix and displayed once. Claude-Mem stores only a SHA-256 hash, prefix metadata, scopes, status, and timestamps in SQLite.

BullMQ mode requires Redis or Valkey. Queue payloads are limited to work needed to resume observation processing; SQLite remains the canonical memory store. Use Redis persistence for deployable examples and avoid placing server ports on public networks without auth.
