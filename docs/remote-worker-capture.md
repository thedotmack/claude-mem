# Remote worker capture

A worker shared by several machines owns the database, vector index, observer
and processing spool. Each client runs its existing hooks and MCP connection.
Set `CLAUDE_MEM_WORKER_HOST` and `CLAUDE_MEM_WORKER_PORT` to that worker and set
`CLAUDE_MEM_WORKER_AUTOSTART=false` on the clients so their hooks never manage
the remote process.

Configure `CLAUDE_MEM_WORKER_INGEST_TOKEN` with the same shared secret on the
worker and every client. Set it in the environment or in each machine's
`~/.claude-mem/settings.json`; keep credentials out of repositories. The new
`POST /api/spool/ingest` endpoint requires this token in `Authorization: Bearer`.
An unset worker token disables this endpoint. Settings replies mask the token.

`CLAUDE_MEM_HOOK_SPOOL_TRANSPORT=auto` selects HTTP for non-loopback worker hosts.
Local hosts keep filesystem capture. A loopback SSH port forward needs
`CLAUDE_MEM_HOOK_SPOOL_TRANSPORT=http`, because its URL alone cannot tell the
client that the worker has a different disk. Use `filesystem` only where both
processes actually share the spool directory.

Keep the worker reachable only through a trusted private network or a protected
proxy. The ingest token protects this endpoint, not every existing worker API.
The optional TV read-only guard continues rejecting remote mutations, including
spool ingestion; an observation-TV endpoint is not a capture endpoint.

## Delivery and failures

A write hook first persists an event in its client-local `state/hook-spool/`.
HTTP delivery copies the normalized event and original enqueue timestamp into
the worker's spool with an atomic, fsynced write. Only then does the worker return
a versioned acknowledgement identifying that exact event. The client removes
only the acknowledged copy; a concurrent replacement remains queued.

The client outbox is temporary delivery state, not a local memory database or
processing worker. Each hook's exit can retry a pending outbox after connectivity
returns. A short-lived detached uploader discovers the oldest pending entries
and sends up to 16 with a shared one-second network budget. It runs no listener,
observer, local memory database or vector index. Concurrent uploaders are safe:
the receiver deduplicates receipts and the client claims files atomically before
removing them. A refused
connection, authentication failure, missing endpoint on an older worker, or
unrecognized acknowledgement retains the file and logs a delivery warning.
An event explicitly rejected as malformed, or larger than the worker's HTTP
body limit, is preserved in `corrupt/` with an error log so it does not block
younger valid events. An unsupported protocol stops delivery and retains the
outbox for a compatible worker upgrade. If
there are no further hooks, retained files wait for the next hook rather than a
persistent client background daemon.

Remote transport and consumed receipts remain in the existing worker SQLite marker table for
the seven-day spool retry window. If an acknowledgement was lost after the
worker accepted the event, retrying the same canonical event returns its receipt
without ingesting it again. Local spool markers keep their existing cleanup
behavior. Unknown-session summaries remain in the central spool until their
session becomes available, and failing entries past the existing retry window
move to `expired/` with an error log.

An acknowledgement proves durable capture handoff, not observer success. Memory
generation still requires a working provider. The observer's in-memory reducer
and transcript-based recovery after a worker death are unchanged. Allow the
processing queue to drain before an intentional upgrade or restart.

## Compatibility and acceptance

Upgrade the worker to a version with spool ingestion before enabling remote
capture clients, or retain their outboxes until it is available. An old empty
`POST /api/spool/nudge` response is never treated as acceptance of an uploaded
event. The existing bodyless nudge and local filesystem capture remain available.
The autostart opt-out controls process lifecycle; it does not negotiate protocol
compatibility.

Validate the full path using identifiable tool events on each client: inspect
central `tool_uses`, wait for generated observations, retrieve those observations
through MCP, and confirm startup context includes them. Also test outage/retry,
an interrupted acknowledgement, and a worker restart. A healthy HTTP response or
working memory search alone does not establish that capture is operating.
