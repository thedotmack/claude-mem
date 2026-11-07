# Isolate malformed Gemini answer parts

## Context
Response JSON is untrusted at runtime despite its TypeScript annotation. Null parts throw before usable answer text can be recovered; a non-array value with length throws during filter.

## Decision
Require an array and object-shaped parts before reading thought and text.

## Alternatives
Rejecting all parts loses valid answers; reading arbitrary values directly turns one malformed part into failure of the complete response.

## Consequences
The scoped behavior is covered by regression tests; valid existing inputs retain their semantics. No data migration is performed.

## Validation
Bun 1.4.3: the new regression suite fails against upstream and passes against this change. Exact commands: `bun test tests/shared/gemini-answer-part-shape.test.ts`. Baseline and candidate logs are retained locally outside the reviewed checkout. `git diff --check` passes. No external model or database service was contacted.
