# magpie fixtures

Copied unchanged from [magpie](https://github.com/yetone/magpie) at commit
`e297a8ab2` (`internal/gateway/testdata/`). magpie is MIT licensed,
"Copyright (c) 2026 yetone"; the notice is in the repository's `NOTICE`.

| File | What it is |
| --- | --- |
| `workdir/claude-code-2.1.296.json` | Claude Code 2.1.296 request (Anthropic Messages), captured against a fake upstream, paths sandboxed |
| `workdir/codex-0.162.0.json` | Codex 0.162.0 request (OpenAI Responses) |
| `workdir/codex-0.162.1-tool-search.json` | Codex 0.162.1 request with tool_search, prompt "SPAWNTEST please spawn a subagent" |
| `workdir/pi-1.1.0.json` | Pi 1.1.0 request (OpenAI Chat) |
| `opencode2_chat_tools.json` | OpenCode 2.0.25 request (OpenAI Chat) with tools |
| `opencode2_responses_tools.json` | OpenCode 2.0.25 request (OpenAI Responses) with tools |
| `context/claude-code.json` | Claude Code request, text replaced by placeholder words |
| `context/codex.json` | Codex request, text replaced by placeholder words |
| `vertex_openai_thoughts.sse` | Gemini thoughts streamed through Vertex AI's OpenAI-compatible Chat API |
