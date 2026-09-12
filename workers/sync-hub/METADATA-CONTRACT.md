# SyncHub internal metadata contract

SyncHub owns device identity, last-seen state, sync cursors, and the
authoritative Turbopuffer projection checkpoint. Pro reads this payload-free
control-plane state instead of querying content tables or `pro_sync_state`.

All internal SyncHub routes require:

```http
Authorization: Bearer <CMEM_INTERNAL_PROJECTOR_SECRET>
Content-Type: application/json
```

Missing or incorrect credentials return `401`. Bodies are exact versioned
objects: unknown fields return `400`, and non-`POST` methods return `405`.

## Read metadata

`POST /internal/v1/sync/metadata`

```json
{ "protocol_version": 1, "user_id": "canonical-user-id" }
```

```json
{
  "protocol_version": 1,
  "user_id": "canonical-user-id",
  "epoch": "1784531270123",
  "head_seq": "42",
  "projected_seq": "40",
  "projection_lag_ops": "2",
  "sync_health": "projector_lagging",
  "devices": [
    {
      "device_id": "a-stable-device-id",
      "name": "Alex's Laptop",
      "last_seen_at": "2026-07-20T12:00:00.000Z",
      "last_seen_epoch_ms": "1784548800000",
      "last_ack_seq": "39",
      "cursor_lag_ops": "3",
      "connection_state": "disconnected"
    }
  ]
}
```

`epoch`, every sequence/cursor, and every lag are canonical unsigned decimal
strings. They must never pass through a JavaScript `number`.

`sync_health` is `healthy` exactly when `projected_seq === head_seq`, and is
`projector_lagging` otherwise. An offline device's cursor lag is informational
and does not make projection unhealthy. Devices sort by most-recent last seen,
then by device id. This response intentionally contains no content, content
counts, local outbox depth, or migration/backfill telemetry.

Clients send `X-Device-Name` (trimmed, at most 80 characters) with their Hub
requests. The first nonempty client name is retained; a dashboard rename is
not overwritten by a later hostname header. `connection_state` reflects an
accepted advisory WebSocket at read time. Correctness never depends on it.

## Device admission bound

Each user's Hub stores at most 64 distinct device ids. Device-admitting paths
enforce the same bound: push, pull, and WebSocket upgrade (including their
optional `X-Device-Name` header). At the limit, an existing device still
updates last-seen/cursor state and continues to sync; a previously unseen id
on one of those paths receives HTTP `409` with the stable body:

```json
{ "error": "device_limit_exceeded" }
```

Admission is one atomic SQLite statement inside the per-user Durable Object,
so concurrent first-seen requests cannot overshoot 64. Metadata returns at
most 64 devices. Metadata reads and every public status request are
non-admitting: a known status device may refresh last-seen/name, while an
unknown `X-Device-Id` is ignored for persistence. This keeps repeated
authenticated connectivity probes from exhausting the cap. Renaming an
unknown device also creates nothing and remains `404`.

## Rename a device

`POST /internal/v1/sync/device-name`

```json
{
  "protocol_version": 1,
  "user_id": "canonical-user-id",
  "device_id": "a-stable-device-id",
  "name": "Desk Mac"
}
```

The name is trimmed and must contain 1–80 characters. The device id is trimmed
and must contain 1–128 characters. A registered device returns:

```json
{
  "protocol_version": 1,
  "user_id": "canonical-user-id",
  "device_id": "a-stable-device-id",
  "name": "Desk Mac"
}
```

An unknown device returns `404`; rename never creates a phantom device.

## Read a bounded restore/replay page

`POST /internal/v1/sync/operation-page`

This is the only internal read that returns content. It exists for authenticated
backup and restore/replay tooling; the metadata and operational-health routes
remain payload-free.

```json
{
  "protocol_version": 1,
  "user_id": "canonical-user-id",
  "epoch": "1784531270123",
  "after_seq": "0",
  "limit": 100
}
```

`limit` must be an integer from 1 through 100. `epoch` and `after_seq` must be
canonical uint64 decimal strings. `user_id` must be a canonical 1–256 character
value with no surrounding whitespace. The exact response is capped at 4,000,000
UTF-8 bytes and carries `Cache-Control: private, no-store` and
`Referrer-Policy: no-referrer`:

```json
{
  "protocol_version": 1,
  "user_id": "canonical-user-id",
  "epoch": "1784531270123",
  "after_seq": "0",
  "through_seq": "2",
  "head_seq": "5",
  "has_more": true,
  "ops": [
    {
      "seq": "1",
      "body": "{\"body_schema_version\":1,...}",
      "operation_sha256": "base64url-sha256"
    }
  ]
}
```

Operations are contiguous and strictly sequence-ordered. Each item reuses the
projector wire item exactly: `{seq,body,operation_sha256}`. Advance the next
request with `after_seq = through_seq`. An empty page is valid only at head and
has `through_seq === after_seq`. `has_more` is true exactly when
`through_seq < head_seq`. An epoch mismatch or a missing/compacted log segment
returns `409`; malformed/overflowing decimals return `400`. A page read never
updates a client cursor, device, projection lease/checkpoint, compaction state,
alarm, or operational counter.

## Read payload-free operational health

`POST /internal/v1/sync/operational-health`

```json
{
  "protocol_version": 1,
  "user_id": "canonical-user-id",
  "window_seconds": 3600
}
```

`window_seconds` must be an integer from 60 through 86,400. `user_id` follows
the same canonical identity rule as operation pages. The response is separate
from the stable metadata response above and carries the same no-store headers:

```json
{
  "protocol_version": 1,
  "user_id": "canonical-user-id",
  "generated_at": "2026-07-20T17:00:00.000Z",
  "window_seconds": 3600,
  "epoch": "1784531270123",
  "head_seq": "42",
  "projected_seq": "40",
  "projection_lag_ops": "2",
  "rejected_operations": {
    "total": "2",
    "last_at": "2026-07-20T16:59:00.000Z",
    "by_code": [{ "code": "stale_revision", "count": "2" }]
  },
  "projection_failures": {
    "total": "1",
    "last_at": "2026-07-20T16:58:00.000Z",
    "by_code": [{ "code": "upstream_timeout", "count": "1" }]
  }
}
```

Totals and per-code counts are canonical decimal strings. `by_code` is sorted
and bounded by fixed allowlists. Rejected-operation codes are:

`device_limit_exceeded`, `invalid_device_id`, `invalid_json`,
`invalid_operation`, `invalid_ops_shape`, `origin_device_mismatch`,
`request_too_large`, `revision_hash_conflict`, `stale_revision`,
`too_many_ops`, and `unsupported_protocol`.

Projection-failure codes are:

`busy`, `internal_error`, `not_configured`, `page_empty`, `page_too_large`,
`response_mismatch`, `response_not_json`, `upstream_conflict`,
`upstream_http_error`, `upstream_timeout`, and `upstream_unreachable`.

No raw error, HTTP response body, operation payload, token, secret, device id,
or dynamic status code is stored in these counters. Event buckets are pruned
outside the maximum window and hard-bounded. Counter failure is best-effort
instrumentation only: it cannot change append durability or projection
checkpoint behavior.
