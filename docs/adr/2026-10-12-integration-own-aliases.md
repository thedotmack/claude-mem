# Resolve only declared integration aliases

## Context
The alias dictionary inherits Object.prototype. Unsupported integration ids such as constructor resolve to functions instead of remaining strings, breaking downstream validation.

## Decision
Require an own dictionary property before applying an alias.

## Alternatives
A null-prototype map also works; a separate switch duplicates the alias catalog.

## Consequences
The scoped behavior is covered by regression tests; valid existing inputs retain their semantics. No data migration is performed.

## Validation
Bun 1.4.3: the new regression suite fails against upstream and passes against this change. Exact commands: `bun test tests/shared/integration-own-aliases.test.ts`. Baseline and candidate logs are retained locally outside the reviewed checkout. `git diff --check` passes. No external model or database service was contacted.
