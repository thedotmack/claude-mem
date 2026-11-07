# Native prompt identity at worker init

`POST /api/sessions/init` accepts optional `nativePromptId`: a nonempty string
of at most 256 characters, without whitespace/control characters. A native
host user-turn ID must be used unchanged. This is separate from the worker's
numeric prompt row ID.

The worker stores it on `user_prompts.native_prompt_id`, with a unique index on
`(session_db_id, native_prompt_id)`. The DB session already scopes
`platform_source + content_session_id`. The additive migration runs after older
table rebuilds and leaves existing rows null. `native_prompt_hash` stores a SHA-256
receipt for the complete trimmed, privacy-cleaned ask, before the HTTP/storage
preview limits. Native identity and this digest are local ingest
receipt, not a new cloud canonical-content field.

An immediate SQLite transaction checks identity, inserts the real prompt, and
reopens a completed session only on a new accepted prompt. Equal text with
different native IDs creates two prompt anchors, even within ten seconds. A
retry with the same ID and cleaned text returns the original prompt number,
including after a lost response or worker restart. The response includes the
acknowledged `nativePromptId`; reusing that ID with different cleaned text returns
409, including differences beyond the saved preview. Privacy and project-exclusion
gates run before identity is claimed.

If a durable claim succeeds but live-session initialization fails, a matching
native retry repairs an existing session whose prompt number trails the receipt,
using the original cleaned ask. An older receipt never replaces a newer live
prompt. After a worker exit, a missing live session remains lazy: subsequent
observation or summary ingest loads the saved prompt and number.
Accepted init and retry repair share leading-slash SDK normalization. If a
native ask is only `/`, its nonempty cleaned original remains the live prompt;
normalization for callers without a native ID stays unchanged.

Callers without this optional field retain the existing ten-second same-text
deduplication. Other integrations are unchanged until their native turn contract
is verified. The Hermes provider requires the echoed identity before admitting
tool results, and carries the exact Hermes `turn_id` as the key.
