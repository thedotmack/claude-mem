# Observer response batch safety contract

Status: implemented test-first. This document narrows issue #3606 to the P0
batch-disposition path. The executable contract was added first and observed
failing against the old production behavior before the implementation changed.

## Goal

A claimed observer batch is removed only after either:

1. a valid structured response has been stored successfully; or
2. the model returned an explicit, parseable skip sentinel.

Every other output preserves the batch. Recovery is bounded so preservation
cannot become an infinite retry or memory-growth loop.

## Non-goals

This change does not:

- salvage arbitrary prose into memories;
- add fuzzy or title-level deduplication;
- introduce a durable queue or spill customer payloads to disk;
- change provider settings, model selection, or billing behavior;
- solve general history compaction or queue-capacity policy;
- replay work after a worker-process crash. The source transcript remains the
  recovery source for that separate problem.

## Terms

- **Batch**: the current ordered set of claimed in-memory message IDs.
- **Confirm**: remove every message in the claimed batch from the in-memory
  buffer by calling `confirmClaimedMessages()`.
- **Preserve**: return claimed messages to pending state by calling
  `resetProcessingToPending()` and keep the active session and buffer alive.
- **History checkpoint**: the conversation-history length immediately before
  the batch's user prompt is appended.
- **Automatic retry**: one new provider turn for the same batch, using a fresh
  provider session and history restored to the batch checkpoint.
- **Pause**: keep the batch pending, stop automatic generation, expose a typed
  unhealthy state, and wait for a later user prompt to explicitly resume it.

## Output classes and disposition

| Output class | Examples | First result | Second result |
|---|---|---|---|
| `valid` | parseable observation or summary XML | store, then confirm | not applicable |
| `skip` | `<skip_summary/>`, `<skip_observation/>` | confirm without storage | not applicable |
| `auth` | 401, 403, login required | preserve and pause | no automatic retry |
| `quota` | usage limit or allowance exhausted | preserve and pause | no automatic retry |
| `transport` | connection closed, socket reset | preserve; retry once | preserve and pause |
| `overflow` | prompt/context too long | preserve; retry once in a fresh provider session | preserve and pause |
| `model_error` | selected model unavailable or provider error text | preserve; retry once | preserve and pause |
| `xml_drift` | observation root with wrong or missing schema fields | preserve; retry once with the canonical schema | preserve and pause |
| `idle` | empty output or "No observations to record" | preserve; retry once | preserve and pause |
| `prose` | any other non-structured output | preserve; retry once | preserve and pause |

The classifier is closed. An unrecognized output maps to `prose`; no default
branch may confirm a batch.

## Binding invariants

### B1. Confirmation is allow-listed

`confirmClaimedMessages()` may be called only after a successful store of a
valid response or after parsing an explicit skip sentinel. A log level or error
message cannot substitute for this condition.

### B2. Storage precedes confirmation

For valid output the order is parse -> store -> confirm. If parsing or storage
throws, confirmation is not attempted and the batch is preserved.

### B3. Failure is history-transactional

The response and its batch prompt are committed to reusable conversation
history only after the response is accepted. Rejected output restores the
history checkpoint before retry or pause. A rejected assistant turn must never
teach the next turn the malformed schema or provider-error prose.

### B4. Retry is bounded per batch

Recoverable output gets at most one automatic retry for the same batch. The
retry key is derived from the ordered claimed message IDs, not from response
text. Repeated identical or different failures cannot reset the attempt count.

### B5. Retry does not grow the queue

Resetting and re-claiming a batch changes message state, not membership. Queue
depth and message IDs are identical before the failed turn and after it is
preserved. A retry must not enqueue a copy of any message.

### B6. The retry uses a clean provider turn

All providers retry through a fresh generator/provider session. This avoids
assuming that the Claude SDK's internal history can be rolled back merely by
editing `session.conversationHistory`.

### B7. Exhaustion pauses; it does not drop or loop

After the one automatic retry fails, the generator exits through a preserve
category. `GeneratorExitHandler` must not finalize the session, remove the
session, or dispose its buffer. No timer or pending-count hook may start another
automatic retry for that batch.

### B8. A later user prompt is the recovery boundary

Observation and summarize hooks cannot clear a pause. A later accepted user
prompt may clear the batch-attempt state and start one new bounded recovery
cycle. This makes recovery reachable without allowing tool-hook traffic to
become an automatic retry loop. If the failed generator is still unwinding, the
prompt waits for that exit to finish before it clears the pause and starts the
replacement, so the recovery signal cannot be lost in a generator-exit race.
Generator starts are single-flight per session: simultaneous user prompts join
the same start instead of launching duplicate providers for one preserved batch.

### B9. Auth and quota never auto-retry

These conditions require external state to change. They preserve the batch and
pause immediately, retaining the current behavior's user-facing remediation.

### B10. Accepted responses are recorded once

A valid or explicit-skip assistant response is appended to reusable history at
most once. Provider adapters and `ResponseProcessor` must not both append it.
Storage and broadcasting must not occur more than once for a single accepted
batch.

### B11. Failure telemetry is content-safe

Failure telemetry may contain the closed class, provider, attempt number, and
bounded length/count fields. It must not include raw tool input/output, response
content, access tokens, query text, or memory text.

## State machine

```text
pending -> claimed -> accepted -> stored -> confirmed
                   -> explicit_skip -> confirmed
                   -> rejected(first) -> retry_pending -> claimed
                   -> rejected(second) -> paused
                   -> auth_or_quota -> paused
                   -> storage_failed -> paused
```

There is no `rejected -> confirmed` transition.

## Executable contract

The test-first patch must cover these cases before production code changes:

1. Valid observation XML stores and confirms exactly once.
2. Explicit summary and observation skip sentinels confirm exactly once without
   storing an observation.
3. Transport, overflow, model-error, XML-drift, idle, and generic-prose outputs
   do not confirm, do not store, preserve queue depth/IDs, and do not enter
   reusable history.
4. Auth and quota preserve the batch, abort/pause the generator, and survive
   `handleGeneratorExit()` without session or buffer disposal.
5. The first recoverable failure requests exactly one retry; a second failure
   pauses and cannot request a third.
6. A storage exception does not confirm and leaves the batch recoverable.
7. Accepted assistant output appears exactly once in history across each
   provider adapter.
8. Reset/retry does not duplicate a buffered message.
9. Later observation and summarize starts remain blocked while paused, but a
   later user-prompt start clears the pause and resumes the preserved batch.
10. Concurrent user prompts arriving while the paused generator is still
    unwinding wait for that exit and start exactly one replacement generator.

Tests 1, 4, and part of 8 already exist and must remain green. Tests 2-3 and
5-7 are the safety gap. Where a required production seam does not exist yet,
the test should name the missing contract rather than weaken the assertion.

## Risk register covered by the tests

| Risk introduced by the fix | Required protection |
|---|---|
| Retry storm and runaway provider spend | One automatic retry per stable batch key; second failure pauses |
| Duplicate memories | Store and confirm once; stable message IDs across reset; accepted assistant output appears once |
| Poisoned conversation state | Rejected prompt/response rolled back; retry uses a fresh provider session |
| Batch still deleted during generator cleanup | Retry and pause abort categories preserve the session and buffer |
| Storage succeeds or fails ambiguously | Store precedes confirm; thrown storage never confirms |
| False-positive error matching inside a real memory | Parseable XML takes precedence over error-looking text inside fields |
| Benign no-op prose loops forever | Prompt/parser use explicit skip sentinels; prose gets one retry and then pauses |
| Auth/quota burns retries | Both classes pause immediately with zero automatic retries |
| Retry inflates RAM by copying messages | Queue depth and persistent message IDs are unchanged by reset/retry |

### Remaining RAM-cap follow-up

The current queue is in RAM and accepts new tool events while a session is
alive. The contract tests prove that retry itself does not duplicate buffered
messages, but they do not bound unrelated new intake during a long pause.
The separate resource-budget work should add a per-session message and byte cap
with an observable backpressure result. Rejecting over-cap in-memory intake is
acceptable because the source transcript remains the durable replay source.
That follow-up is intentionally not bundled into this P0 disposition fix: the
retry itself neither copies nor enqueues messages, while the old behavior loses
an already-claimed batch immediately.

## Implementation boundary after the tests

The smallest acceptable production patch is limited to:

- a closed output classifier and disposition table;
- batch-attempt bookkeeping tied to claimed message IDs;
- history checkpoint/commit/rollback helpers;
- one controlled fresh-generator retry and a preserve-on-exit category;
- `<skip_observation/>` parser and prompt support;
- the health/telemetry state needed to expose a pause.

Resource budgeting, durable recovery, prose salvage, and deduplication remain
separate work even if issue #3606 discusses them together.

## Release gate

Do not merge the production fix unless:

- all contract tests pass on every provider path;
- the full worker test suite and build pass;
- a provider-boundary fixture proves one thrown failure -> one retry -> pause;
- the retry creates no duplicate stored observation;
- the retry preserves the original message IDs and does not increase queue
  depth;
- rollback can restore the old code without requiring a database migration.
