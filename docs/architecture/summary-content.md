# Minimum content for generated summaries

The local observer separates XML parsing from storage eligibility. A generated
summary must have non-empty text in at least one of `investigated`, `learned`,
`completed`, or `notes`. A separate character-data view of the original XML
ignores actual comments and unwraps CDATA for this check only. Empty/whitespace
CDATA is not progress; escaped comment examples and comment/entity examples
inside CDATA are text. Parsed values and stored content remain unchanged.
Notes-only replies and other sparse progress summaries remain
supported. A request title, future plans, or both on their own are not stored.

This is a minimum-content check, not a factual or semantic quality score. It
does not require every field, measure text length, or infer whether a statement
is useful or true. The shared summary prompt asks for known progress and offers
the existing `skip_summary` sentinel when there is nothing durable to record.

A parseable summary without progress has already answered a paid request. The
response processor logs `missing_progress_content` without the reply text,
sets `lastSummaryStored` to false, and terminally confirms only the answered
batch. It does not send a correction request, switch providers, wait for a
memory-session ID, or put the batch back in the buffer. Fresh work can continue.
Original evidence, completed-tool receipts, and capture-only media are retained
through the existing no-storage outcome handling. Such media may still update
an earlier saved observation's capture-only links under the existing media
contract; that is synchronization of saved evidence, not a new generated summary.

If a media-outcome or completed-tool receipt write fails, the no-storage
terminal path logs a sanitized storage error and still confirms the answered
batch. Both writes are attempted independently. The live buffer keeps its tool
ID deduplication, but a failed receipt is not durable; media can remain
unprocessed. No new retry store, inference replay or deletion of source evidence
is used to hide that durability gap. The same handling applies to a legal skip
before a memory-session ID is available.

This rule does not make all summary delivery idempotent. The authenticated
remote handoff has an existing durable receipt that prevents redelivery from
enqueuing again. The ordinary local summary endpoint has no equivalent event
receipt: explicitly posting the same payload again can enqueue another batch,
before and after this change. The standard local hook hands off once and does
not retry an ambiguous delivery. A broader local event identity/deduplication
contract is separate work.

The XML parser still recognizes a title-only summary. Changing that parse to
invalid would enter the existing invalid-output recovery path and could spend
again. Entirely empty or malformed responses keep their existing handling; this
change does not extend or redesign those retries. Init replies still store
nothing and do not settle queued work.

No stored summaries are deleted or regenerated. Import/server APIs and
request/reply type enforcement are outside this local-observer change. A
content-bearing summary returned on an observation turn is not rejected merely
for that mismatch by this rule. See the [observer lifecycle](observer-lifecycle.md)
for the bounds on inference and recovery, and
[#3606](https://github.com/thedotmack/claude-mem/issues/3606#issuecomment-6897482858)
for the proposal and its relationship to #5184.
