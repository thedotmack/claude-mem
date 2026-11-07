# Live observer lifecycle and queue history

Owner direction, 3 November 2026: do not persist failed observation work and
later drain it as a backlog. Follow Claude-Mem's observer architecture.

## Contract

The local observer reduces a sequence of tool events into zero or more
observations using conversation context. Saving isolated inputs without that
context does not save a resumable observer. It can change meaning, ordering,
duplicate memories, and spend quota after the user has moved on.

Live capture therefore makes one bounded handoff. If the worker is unavailable,
capture skips that event. If quota or credentials stop the observer, pending
inputs are discarded. Later activity can start fresh work through the existing
provider gates. Timer-driven and operator paths cannot revive discarded work.

The RAM buffer holds at most 128 messages per session and 1,024 per worker.
Unsent inputs expire after five minutes. An in-flight paid request may finish;
the expiry does not abort it. Releasing a failed claim does not reset its age.
Source timestamps stay separate from time spent in the buffer.

The common hook handoff sends observations, file edits, and summaries directly
to the existing worker endpoints, with a 250 ms transport deadline and no disk
outbox or transport retry. Remote delivery uses the authenticated endpoint and
stores only an at-most-once receipt before dispatch. That receipt is not an
observation-completion checkpoint. Old observer entries in the disk spool are
retired without inference. The non-inference metadata spool remains separate.

An outage can leave a gap in generated memory. Preserve the original source
transcript and saved observations. Do not hide that gap by quietly replaying
fragments. A future recovery operation needs explicit authorization, a source
position that includes valid skips, matching observer state or a specified
reconstruction boundary, deduplication, and a known spend scope.

## Verified trajectory

Dates below use America/Los_Angeles. These are implementation changes, not
claims that a user's historical installation was independently reproduced.

| Date | Change | Architectural effect |
| --- | --- | --- |
| 28 Dec 2025 | [06739cf](https://github.com/thedotmack/claude-mem/commit/06739cfdfa21f7dba4f72d9051d0888b048f3cfb), queue simplification | Made SQLite the queue; did not pair pending input with observer state. |
| 28 May 2026 | [61fe70a](https://github.com/thedotmack/claude-mem/commit/61fe70a203aabd0ba5695669fcb0436162ddbe06) | Removed durable pending rows, observation BullMQ, and respawn-on-pending. Added the in-memory buffer and explicit reducer-state rationale. |
| 29 Jun 2026 | [ad4bd6f](https://github.com/thedotmack/claude-mem/commit/ad4bd6f7a67d5e2c9464f12f015124ba4c253474) | Reintroduced keeping the RAM buffer on quota failure. This is the first traced reversal of drop-on-failure. |
| 13 Jul 2026 | [6da83e1](https://github.com/thedotmack/claude-mem/commit/6da83e1d3a2a59c421acc347a74362e0afa6ebc1) | Extended preservation to authentication-failure prose. |
| 30 Aug–30 Sep 2026 | Bounded generations and [PR 3479](https://github.com/thedotmack/claude-mem/pull/3479) | Fresh generations stopped accumulating failed history, but preserved queued inputs did not regain their original observer conversation. |
| 30 Sep 2026 | [cb6e463 / PR 4110](https://github.com/thedotmack/claude-mem/commit/cb6e463503c8f51fe2abc0e6ac836ec4fe0a60dc) | Added a one-minute sweep. Paused queues could resume after the 30-minute quota window and spend on old events. |
| 30 Sep 2026 | [PR 3460](https://github.com/thedotmack/claude-mem/pull/3460) and later response fixes | Preserved transport-rejected batches. Short transport recovery became another way old inputs could remain eligible. |
| 3 Oct 2026 | [fe1709c / PR 4368](https://github.com/thedotmack/claude-mem/commit/fe1709c30689a64b6dd0387e24103779efed321a) | Added paid-send budgets and a durable hook spool for observation, edit, and summary fragments. Its seven-day failure window was not a pre-dispatch age limit. |
| 5 Oct 2026 | [448872a / PR 4531](https://github.com/thedotmack/claude-mem/commit/448872ae799621a880f30c2709db084a766c234c) | Routed standalone transcript-watcher observations through that spool. |
| 11–15 Oct 2026 | Timestamp preservation and remote hook spool | Improved delivery bookkeeping while retaining the durable inference handoff. |
| 26 Oct 2026 | [1fd7c22 / PR 5072](https://github.com/thedotmack/claude-mem/commit/1fd7c220e7be6799f2b4ee796379c883730e4958) | Held transcript cursors while the RAM buffer had unfinished work; did not provide a full observer checkpoint. |
| 5 Nov 2026 | [1fe4d8e / PR 5383](https://github.com/thedotmack/claude-mem/commit/1fe4d8e78c8d0ea6661236f934a190f50bb84712) | Merged while this contract was still unlanded: auth-paused work auto-resumed once a later store succeeded. Removed with PR 5347, since auth now discards and nothing is left to resume. |
| 6 Nov 2026 | [f090685 / PR 5414](https://github.com/thedotmack/claude-mem/commit/f09068514365a7b6fa01bf7e3af2a20118f55df7) | Stall exhaustion discards buffered work and keeps deduplication. PR 5347 uses the same `discardBufferedWork` for quota and auth. |

[Community bundle PR 3614](https://github.com/thedotmack/claude-mem/pull/3614)
was closed without merging. It included a proposed transport-preservation fix,
but blame must follow the individual merged commits above, not that bundle.

The May commit proves the intended skip/no-durable-replay implementation. It
does not prove a fleet-wide period of successful operation, nor that complete
ordered transcript recovery was shipped. The screenshot's 1,260 queued events
and roughly 1,200 calls are the reporter's claims, not independently measured
counts. The current code establishes a plausible matching path: RAM queue with
no prior age/count cap, quota preservation, and a periodic cooldown sweep.

## Other queues are different contracts

- `sync_outbox` and the Cloud Sync user queue deliver already-saved records.
  They are not local observer inference backlog and remain intact.
- `tool_uses`, original transcripts, media evidence, and saved observations
  preserve source/result data. They must not trigger automatic paid backfill.
- `src/server/jobs/ServerJobQueue.ts` is the separately selected server runtime
  (`CLAUDE_MEM_QUEUE_ENGINE=bullmq`), with durable generation jobs and bounded
  attempts. It is not used by the local observer. Its durable job contract is
  not permission to add persistence to the local capture path. Converting that
  explicitly selected server API to live-only capture is a separate migration.
- Metadata events (session end, subagent stop, advisor-call records,
  deliverable records, usage records) may be delivered durably. They may not
  regenerate the original observation backlog as a side effect.

## Required regression evidence

Exercise a quota failure across many sessions, advance beyond cooldown/reset,
and assert zero old provider calls. Verify fresh capture still starts. Verify
bounded buffer capacity and age, in-flight completion, quota/auth admission,
lost handoff, remote receipt redelivery, and restart with legacy spool files.
Preserve privacy gates and the latency limit on the hook path.
