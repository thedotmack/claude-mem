# OpenCode Message Lifecycle Compatibility Design

## Context

Claude-mem officially supports OpenCode, but version 13.10.2 still has known compatibility gaps with OpenCode 1.17.18. The installed plugin treats `chat.message` as an assistant-message hook even though OpenCode supplies a `UserMessage`, initializes sessions with an empty prompt, sends empty summaries, reads tool arguments from the wrong hook parameter, and does not await lifecycle POSTs. These gaps correspond to upstream issues #2832, #2854, and #2986 and open PR #3014.

## Goals

- Store every OpenCode text user turn as its real claude-mem user prompt.
- Keep `[media prompt]` only for genuinely textless user messages.
- Capture each completed assistant reply once and summarize with its real text.
- Never request a summary without assistant text.
- Make lifecycle writes deterministic for interactive and short-lived OpenCode runs.
- Align tool argument capture with the installed OpenCode 1.17.18 hook contract.
- Treat a valid empty observer initialization response as a non-error.

## Non-Goals

- Do not change claude-mem's database schema, worker protocol, viewer, installer, MCP registration, or provider configuration.
- Do not adopt either open upstream PR wholesale; both contain unrelated changes and leave parts of this lifecycle incomplete.
- Do not add backward-compatibility branches for unverified OpenCode versions.

## Design

### User Prompts

Use `chat.message` according to the installed OpenCode 1.17.18 type contract. Read the session ID from the hook input and concatenate usable text parts from the `UserMessage` output. POST `/api/sessions/init` for every user turn with the same content-session ID so claude-mem assigns sequential prompt numbers. Send `[media prompt]` only when no text part exists.

Tool and summary hooks no longer create an empty prompt row as a side effect. Observation ingestion can resolve or create its SDK session from the content-session ID and working directory.

### Assistant Capture And Summaries

At `session.idle` and `experimental.session.compacting`, query OpenCode's official `client.session.messages` API for the session. Select the latest completed assistant message with non-empty, non-ignored text parts. This canonical snapshot avoids reconstructing streamed `message.part.updated` deltas and their ordering.

For each new assistant message ID:

1. POST one `assistant_message` observation containing the assembled reply.
2. POST one summary request with the same reply as `last_assistant_message`.
3. Record the processed message ID for that OpenCode session.

Repeated idle or compaction events for the same assistant message do nothing. Missing messages, missing text, or a failed OpenCode API query produce no lifecycle POST. Session deletion clears the content-session, context, and assistant-message deduplication state.

### Worker Requests

Replace fire-and-forget lifecycle POSTs with an awaited helper that checks HTTP status and preserves the existing non-fatal behavior when the worker is unavailable. Explicit memory search behavior and the five-second startup-context timeout remain unchanged.

### OpenCode 1.17 Contract Alignment

Read `tool.execute.after` arguments from `input.args`, where OpenCode 1.17.18 defines them, instead of `output.args`. Keep the plugin's default-only production entrypoint unchanged.

### Empty Initialization Results

The observer prompt explicitly allows an empty response when a user request contains nothing durable to record. Change the OpenAI-compatible provider's empty initialization message from error severity to debug severity. Empty observation and summary responses retain their existing warnings because those can leave queued work unprocessed.

## Error Handling

- Worker POST failures remain non-fatal and are logged once by the request helper.
- OpenCode message-list failures skip assistant capture and summary without sending placeholder content.
- A textless assistant response is not marked processed, allowing a later lifecycle event to retry after message completion.
- State maps retain the existing 1,000-session bound and are cleaned on session deletion.

## Testing

Follow red-green TDD with focused contract tests that first demonstrate:

- real user text is sent on every `chat.message` turn;
- a truly textless user message sends `[media prompt]`;
- tool arguments come from `input.args`;
- idle and compaction select the latest completed assistant text;
- duplicate lifecycle events do not duplicate assistant observations or summaries;
- sessions without assistant text send no summary;
- lifecycle POSTs are awaited;
- an empty OpenAI-compatible initialization result is not logged as an error.

After focused tests pass, run the full OpenCode contract and installer suites, root typechecking, build the default-only plugin, install it, verify its hash, restart a disposable OpenCode 1.17.18 process, and confirm real prompt text, assistant observation, summary text, platform classification, queue drain, and vector-backed search.
