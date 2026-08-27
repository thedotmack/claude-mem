## Summary

Claude Code session and 5-hour usage-limit notices currently miss the quota classifier. The worker then confirms and consumes the claimed observation batch as generic prose. The classifier now recognizes bounded exhausted session and usage-limit wording and routes it through the existing preservation path.

## Why

The existing detector requires vendor, billing, or quota anchors, but Claude Code's notices name the cap and use hit/reached wording. The change extends the existing classifier while leaving queue ownership in ResponseProcessor.

## Scope

This covers exhausted session and 5-hour usage-limit notices. The approaching warning, monthly spend-limit wording, generic prose fallback, structured quota errors, and auth path remain separate.

## Risk

Only bounded exhaustion wording gains quota preservation. Ordinary no-op prose and approaching warnings retain confirmation behavior, and existing quota, auth, XML, queue, and telemetry paths remain unchanged.

## Verification

- [x] `bun test tests/sdk/output-classifier.test.ts` — 21 passing
- [x] `bun test tests/worker/agents/response-processor.test.ts` — 24 passing
- [x] `npm run typecheck` — passed
- [x] `npm run build` — passed; generated bundles restored
- [x] `npm run lint:hook-io && npm run lint:spawn-env` — clean
- [ ] `npm run strip-comments:check` — repository-wide check reports `Changed: 413`
- [x] `git diff --check` — clean

The exact limit notices follow the captured report at https://github.com/thedotmack/claude-mem/issues/3702.

Refs #3702
