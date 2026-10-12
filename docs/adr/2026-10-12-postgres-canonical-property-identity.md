# Preserve every JSON property in Postgres deterministic keys

## Context
Postgres event and session keys hash sorted JSON. Assigning an own JSON `__proto__` property to an ordinary accumulator invokes its legacy setter, omitting that property from serialization. Distinct payloads can receive identical keys.

## Decision
Use a null-prototype accumulator when recursively sorting JSON objects. Retain ordering and JSON encoding for ordinary payloads.

## Alternatives
Defining each property explicitly also preserves it, with more code. Dropping special property names changes valid JSON content and key identity.

## Consequences
Literal prototype-named fields survive at every nesting depth. Existing hashes of ordinary payloads are unchanged; formerly collapsed payloads acquire distinct hashes. No persisted records are rewritten.

## Validation
Bun 1.4.3 regression suite: baseline 1 pass, 2 fail; candidate 3 pass, 0 fail. Checks cover nested keys, hash distinction and insertion-order independence. No live Postgres service was required or contacted.
