# Official example streams and bodies

Copied from the vendors' own documentation (fetched 2026-10-15), byte for byte
from the example blocks unless noted. Used by tests/wire-gateway/ir-*.test.ts.

| File | Source |
| --- | --- |
| `anthropic-basic.sse` | https://platform.claude.com/docs/en/build-with-claude/streaming#basic-streaming-request |
| `anthropic-tool-use.sse` | same page, "Streaming request with tool use" |
| `anthropic-thinking.sse` | same page, "Streaming request with thinking" |
| `anthropic-error.sse` | same page, "Error events" |
| `openai-chat-basic.sse` | https://developers.openai.com/api/reference/resources/chat.md, "Create chat completion" streaming example (its `:` comment line marks omitted chunks) |
| `openai-chat-tool-calls.json` | same page, "Functions" response |
| `openai-responses-basic.sse` | https://developers.openai.com/api/reference/resources/responses/methods/create.md, "Streaming" response (its `:` comment line marks omitted events) |
| `openai-responses-function-call.json` | same page, "Functions" response |
| `gemini-stream.TODO-live-capture.sse` | **Hand-built**, not a capture: Google publishes no raw `streamGenerateContent?alt=sse` transcript (report 07 §4). Field names follow https://ai.google.dev/api/generate-content. Phase 17 replaces it with a live capture. |
