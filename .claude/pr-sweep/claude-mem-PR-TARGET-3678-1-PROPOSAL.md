## Summary

OpenCode worker POSTs now stamp the canonical `opencode` platform identity at the single `workerPostFireAndForget` egress. This keeps session init, observations, and summaries on one platform-specific session row while preserving existing payload fields, timing, and server defaults.

Closes #3678

## Verification

- [x] `bun test tests/integrations/opencode-plugin-contract.test.ts` — 8 passed
- [x] `bun test tests/sqlite/session-store-sessions.test.ts` — 15 passed
- [x] `npm run typecheck` — clean
- [x] `npm run build` — all build targets compiled successfully
- [x] `npm run lint:hook-io` — clean
- [x] `npm run lint:spawn-env` — clean
- [ ] `npm run strip-comments:check` — blocked by repository-wide baseline output (`Changed: 413`)
- [x] `git diff --check` — clean

## Scope

The change covers platform provenance on OpenCode session POSTs. It doesn't alter storage identity logic, request ordering, tool arguments, tool-name mapping, export shape, deletion behavior, search parsing, or non-OpenCode missing-source defaults.
