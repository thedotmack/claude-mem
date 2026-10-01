# SyncHub internal metadata contract

SyncHub owns device identity, last-seen state, sync cursors, and the
authoritative Turbopuffer projection checkpoint. Pro reads this payload-free
control-plane state instead of querying content tables or `pro_sync_state`.

Both routes require:

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
