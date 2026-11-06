# Claude-Mem architecture rules

Read [the observer lifecycle contract](docs/architecture/observer-lifecycle.md)
before changing capture, queueing, retries, provider dispatch, or recovery.

- The local observer is a stateful reducer, not a durable job consumer.
- Live observation, file-edit, and summary inputs must not be persisted for
  automatic replay. Use the common live handoff and `SessionMessageBuffer`.
- Quota exhaustion and authentication failures discard pending inference
  inputs. A quota reset, login, restart, timer, or a later successful store
  never authorizes backfill, and paused work is never resumed on such proof.
- Keep active buffering bounded. Do not add another batching queue, retry
  store, startup sweep, or platform-specific recovery loop.
- Preserve the paid-send budget and completed-observation deduplication.
  An ambiguous request must not acquire a fresh budget by changing its path.
- Original transcripts, raw source evidence, saved memories, receipt IDs,
  and synchronization of already-saved records are distinct from inference
  work. Do not delete them to clear a queue or make them trigger paid replay.
- Recovery must be a separately specified, explicit workflow with a matching
  source position and observer state. A last observation ID, delivery receipt,
  byte offset, or collection of pending fragments alone is not a checkpoint.
- Integration and community fixes must obey the same rules. Tests proving
  that a queue drains are insufficient; test that an outage cannot create
  later, unrequested inference spend.

Run relevant behavioral tests, the root TypeScript check, and the bundle build.
Never call a source-only change shipped: installed clients execute the bundles.
