# Backdated observations for learn-code-history (design note)

Status: design only, not built. The `learn-code-history` skill ships without it.

## Goal

When a session runs `/learn-code-history`, the observer should store each
observation with the date of the PR or commit it read (its `mergedAt` or commit
date), not the time of the reading, so the timeline shows the history where it
happened.

## What exists today

- The observer's timestamp is the time the worker got the tool use:
  `SessionMessageBuffer.enqueue` stamps `enqueuedAt: Date.now()`
  (`src/services/worker/SessionMessageBuffer.ts:67`), it becomes
  `_originalTimestamp` (`:148`, `:187`), then `session.earliestPendingTimestamp`
  (`src/services/worker/SessionManager.ts:388-391`), which
  `ResponseProcessor` passes as `overrideTimestampEpoch`
  (`src/services/worker/agents/ResponseProcessor.ts:452`) to
  `SessionStore.storeObservations`, where it becomes `created_at` and
  `created_at_epoch` (`src/services/sqlite/SessionStore.ts:2656`).
- The ingest route `/api/sessions/observations` has no timestamp field
  (`src/services/worker/http/routes/SessionRoutes.ts:448-459`).
- `/api/import` (`src/services/worker/http/routes/DataRoutes.ts:63`, `:102`;
  `SessionStore.importObservation` at `src/services/sqlite/SessionStore.ts:3148`)
  does keep a caller's `created_at_epoch`, but it takes finished observation
  rows. Using it would mean the session writes the observations itself, which
  the skill must not do.

So there is no supported way today to backdate what the observer writes.

## Smallest change

1. **Marker.** The skill already prints one header line per unit:
   `=== learn-code-history unit=PR#<n> date=<ISO-8601> ===`. Make that the contract.
2. **Ingest.** In `handleObservationsByClaudeId`, if `tool_name` is `Bash` and
   `tool_input.command` or `tool_response` contains that exact marker, parse
   `date=` (strict ISO-8601, must be in the past) and put it on the
   `PendingMessage` as `sourceTimestampEpoch`.
3. **Buffer.** In `SessionMessageBuffer.enqueue`, use
   `message.sourceTimestampEpoch ?? Date.now()` for `enqueuedAt`. The existing
   path through `earliestPendingTimestamp` then stores it unchanged. One unit per
   observer batch keeps the date exact; if a batch spans units, the `Math.min`
   at `SessionManager.ts:391` picks the older one, which is acceptable.
4. **Tag.** When the marker was used, write `metadata` (the column already
   exists, `SessionStore.ts:1469`) as
   `{"source":"learn-code-history","unit":"PR#<n>","observed_at_epoch":<now>}`.

## Removing imported history

```sql
DELETE FROM observations WHERE json_extract(metadata, '$.source') = 'learn-code-history';
```

Chroma documents need the same filter on their metadata, so step 4 must also
pass the tag through `ChromaSync.syncObservation`.

## Tests

- Marker present: stored `created_at_epoch` equals the marker date, `metadata.source`
  is `learn-code-history`.
- Marker absent, malformed, or in the future: behavior unchanged (`Date.now()`).
- Marker in a non-Bash tool: ignored.
