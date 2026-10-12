# Admit whole safe Postgres integer settings

## Context
Prefix parsing silently treats 5ms as five pool clients and 1.5 as one; unsafe integers can exceed precisely representable limits.

## Decision
Accept decimal digits after trimming, require a positive safe integer, and retain documented defaults on invalid input.

## Alternatives
Throwing would make an invalid environment setting prevent startup; retaining prefix parsing silently changes operator intent.

## Consequences
The scoped behavior is covered by regression tests; valid existing inputs retain their semantics. No data migration is performed.

## Validation
Bun 1.4.3: the new regression suite fails against upstream and passes against this change. Exact commands: `bun test tests/storage/postgres/integer-settings.test.ts`. Baseline and candidate logs are retained locally outside the reviewed checkout. `git diff --check` passes. No external model or database service was contacted.
