## Summary

OpenRouter generation currently sends `max_tokens` on both worker and server chat-completions requests. Some OpenAI-compatible GPT-5 endpoints reject that field and require `max_completion_tokens`. The shared transport now retries once with the requested field when the endpoint returns that exact compatibility error.

## Why

`OpenRouterProvider.fetchChatCompletion()` and `OpenRouterObservationProvider.postChatCompletion()` duplicate the token-field decision. The fallback stays at the OpenRouter transport boundary, preserving each provider's response parsing and error handling.

## Scope

This covers response-driven compatibility for OpenRouter's two chat-completions paths. Claude and Gemini request formats, model-name inference, generic parameter passthrough, and persistent capability caching remain unchanged.

## Risk

Only a precise 400 response can trigger one fallback request. Other errors, headers, model and message payloads, usage accounting, abort behavior, and provider classification remain unchanged.

## Verification

- [x] `bun test tests/worker/openrouter-provider.test.ts`, 1 pass
- [x] `bun test tests/server/generation/providers.test.ts`, 33 pass
- [x] `bun test tests/shared/openrouter-token-compatibility.test.ts`, 3 pass
- [ ] `npm run typecheck`, blocked by pre-existing `bullmq` and `@modelcontextprotocol/sdk` declaration/export errors; no target-file error remains
- [x] `npm run build`, compiled successfully; worker bundle advisory is 2993.08 KB against the 2900 KB budget
- [x] `npm run lint:hook-io && npm run lint:spawn-env`, both clean
- [ ] `npm run strip-comments:check`, repository baseline reports `Changed: 413`, `Unchanged: 508`, `Skipped: 136`
- [x] `git diff --check`, clean

The compatibility case follows the exact error reported in https://github.com/thedotmack/claude-mem/issues/3712.

Closes #3712
