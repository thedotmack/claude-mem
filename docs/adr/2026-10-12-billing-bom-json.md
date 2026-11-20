# Read BOM-prefixed observed billing JSON

## Context
Windows editors can prepend a UTF-8 BOM to .claude.json. The billing reader treats otherwise valid accounts as missing.

## Decision
Reuse the existing shared BOM-aware parser for the account file.

## Alternatives
Stripping independently duplicates the established JSON reader contract; treating valid JSON as missing misattributes billing.

## Consequences
The scoped behavior is covered by regression tests; valid existing inputs retain their semantics. No data migration is performed.

## Validation
Bun 1.4.3: the new regression suite fails against upstream and passes against this change. Exact commands: `bun test tests/shared/billing-bom-json.test.ts`. Baseline and candidate logs are retained locally outside the reviewed checkout. `git diff --check` passes. No external model or database service was contacted.
