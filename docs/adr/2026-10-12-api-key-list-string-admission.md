# Admit only strings in API key arrays

## Context
Array entries are stringified without type checks, manufacturing keys named null, undefined or object Object and sending doomed requests; custom conversion can throw during settings reads.

## Decision
Apply the existing string-only input contract to each array entry while retaining separators and deduplication.

## Alternatives
Stringifying arbitrary values invents credentials; rejecting the entire array discards valid keys alongside malformed entries.

## Consequences
The scoped behavior is covered by regression tests; valid existing inputs retain their semantics. No data migration is performed.

## Validation
Bun 1.4.3: the new regression suite fails against upstream and passes against this change. Exact commands: `bun test tests/shared/api-key-list-shape.test.ts`. Baseline and candidate logs are retained locally outside the reviewed checkout. `git diff --check` passes. No external model or database service was contacted.
