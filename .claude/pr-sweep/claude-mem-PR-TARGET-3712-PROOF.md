# Target 3712 proof report

All evidence below is bounded to the relevant command result. The exact compatibility fixture is the issue text: `Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.`

| Surface | Command run | Observed result | Base/head |
| --- | --- | --- | --- |
| Worker compatibility fallback | `bun test tests/worker/openrouter-provider.test.ts` | `1 pass`, `0 fail`, exact `Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.` fixture exercised | base: `one request returns the compatibility 400`; head: `one fallback request returns successful provider content` |
| Server compatibility fallback | `bun test tests/server/generation/providers.test.ts` | `32 pass`, `0 fail`, `rawText` and `tokensUsed` preserved after fallback | base: `server returns the first 400`; head: `server result succeeds after one fallback` |
| Exact predicate boundary | `bun test tests/shared/openrouter-token-compatibility.test.ts` | `3 pass`, `0 fail`, incomplete wording and punctuation boundaries covered | base: `incomplete text is not distinguished reliably`; head: `only exact replacement wording matches` |
| Request preservation | `bun test tests/shared/openrouter-token-compatibility.test.ts` | `changes only the token field on the one-shot fallback` | base: `request metadata is unchanged`; head: `fallback changes only the token field` |
| Inference false-positive | `bun test tests/shared/openrouter-token-compatibility.test.ts` | `does not retry an incomplete compatibility error`, one call asserted | base: `similar incomplete error may trigger compatibility`; head: `similar wording does not issue a second request` |

## Reality gate

| Surface | Status | Evidence and limitation |
| --- | --- | --- |
| Chat-completions fields | proved | Focused tests pass against real `Response` objects; the implementation uses the documented `max_completion_tokens` field. |
| Reporter gateway | not-reached | The issue gateway and model are redacted and unavailable without credentials; the implementation remains response-driven and does not claim universal GPT-5 support. |

## Additional gates

- `npm run typecheck`, clean.
- `npm run build`, `All build targets compiled successfully!`; worker service size warning: `worker-service.cjs is 2993.08 KB (advisory budget 2900 KB).`
- `npm run lint:hook-io`, `hook-io discipline: OK (handlers + adapters are pure)`.
- `npm run lint:spawn-env`, `spawn-env discipline: OK (all env-bearing spawns sanitize process.env)`.
- `npm run strip-comments:check`, `Changed:   413 (check mode, no writes)`, `Unchanged: 508`, `Skipped:   136`; this is a pre-existing repository baseline and remains the only failed requested gate.
- `git diff --check`, clean.
