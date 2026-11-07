# Recognize nested message-only refused connections

## Context
The shared detector traverses nested causes and aggregate children for codes but recognizes message-only ECONNREFUSED only on the outer error. Wrappers that retain just an inner message therefore hide a refused worker connection.

## Decision
Apply the existing message fallback at every visited Error while retaining the cycle guard.

## Alternatives
Flattening every cause into a string loses structure and can throw; checking only the root misses a legitimate wrapped refusal.

## Consequences
The scoped behavior is covered by regression tests; valid existing inputs retain their semantics. No data migration is performed.

## Validation
Bun 1.4.3: the new regression suite fails against upstream and passes against this change. Exact commands: `bun test tests/shared/connection-refused-nested-text.test.ts`. Baseline and candidate logs are retained locally outside the reviewed checkout. `git diff --check` passes. No external model or database service was contacted.
