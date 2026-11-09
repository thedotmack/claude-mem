# Live captures

Real streams captured on 2026-10-24 (plan Phase 17 item 5) through the wire gateway at build
`02198a288`, from real agents on real accounts, then sanitized. Each file is one response body.

| File | Protocol | Agent and model | Taken from |
| --- | --- | --- | --- |
| `anthropic-pi.sse` | Anthropic Messages | Pi 0.79.6, `claude-haiku-4-5` | the gateway's `/wire/call` response body (what it relayed to Pi) |
| `anthropic-claude-code.sse` | Anthropic Messages | Claude Code 2.1.310, `claude-haiku-5-5` | the raw upstream bytes, recorded by a pass-through proxy between the gateway and api.anthropic.com |
| `openai-chat-opencode.sse` | OpenAI Chat Completions | OpenCode 1.19.4, OpenCode Zen `big-pickle` | `/wire/call` response body |
| `openai-responses-codex.sse` | OpenAI Responses | Codex 0.163.0, `gpt-6.1-sol` (ChatGPT backend) | `/wire/call` response body |

What the live bytes show that the official examples do not:

- Anthropic pads `data:` JSON with trailing spaces before the closing brace, and sends `ping` as `{"type": "ping"}` with a space.
- Claude Code's thinking block is omitted: `thinking_delta` events carry `"thinking":""` and `estimated_tokens`; the thinking token count comes only from `usage.output_tokens_details`.
- OpenCode Zen sends each tool call whole in one chunk, with `"reasoning":null` and `"tool_calls":null` on text chunks.
- The ChatGPT Codex backend echoes the whole request (`instructions`, `tools`) in `response.created`, `response.in_progress` and `response.completed` (about 43 KB each), and sends a `response.metadata` event. That is why this file is 143 KB; a test that splits it at every byte is slow, so sample the splits.

## Sanitizing

`.scratch/phase17b/tools/sanitize-sse.py` (not committed) did it, and fails if anything is left:

- Paths under the user's home, e-mail addresses and the user's name are replaced by placeholders of the
  same length (`/home/user/project____…`). All streamed fragments (`partial_json`, `text`, `delta`,
  `arguments`, …) are joined before the replacement and split again at the same places, so a path a
  model streamed across ten deltas is replaced too and every event keeps its place and its padding.
- Opaque account-bound values are replaced whole: `signature` (thinking), `safety_identifier`
  (Responses), `encrypted_content`.
- Nothing else was changed. Bodies from `/wire/call` were already passed through the gateway's
  secret scrub.

## Not captured

Gemini (`streamGenerateContent?alt=sse`): no Gemini API key exists on the capture machine, and Gemini
CLI with a Google sign-in fails before any request ("This client is no longer supported for Gemini
Code Assist for individuals"). `official/gemini-stream.TODO-live-capture.sse` stays hand-built.
