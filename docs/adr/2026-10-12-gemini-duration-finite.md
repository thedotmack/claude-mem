# Reject unrepresentable Gemini retry durations

## Context
A syntactically numeric RetryInfo duration can overflow to Infinity or exceed safe millisecond precision and contaminate retry deadlines.

## Decision
Ignore durations whose converted milliseconds are not safe integers.

## Alternatives
Clamping invents a retry time; accepting Infinity may keep a quota cooldown active indefinitely.

## Consequences
The scoped behavior is covered by regression tests; valid existing inputs retain their semantics. No data migration is performed.

## Validation
Bun 1.4.3: the new regression suite fails against upstream and passes against this change. Exact commands: `bun test tests/shared/gemini-duration-finite.test.ts`. Baseline and candidate logs are retained locally outside the reviewed checkout. `git diff --check` passes. No external model or database service was contacted.
