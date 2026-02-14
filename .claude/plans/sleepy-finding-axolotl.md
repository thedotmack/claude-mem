# Fix: Observation type and concept quality

## Context

Database analysis of 5,283 observations reveals two data quality problems:

**Types**: `discovery` accounts for 54% of all observations — it's used as a catch-all. Action types (`decision` 2.5%, `feature` 1.1%, `refactor` 0.9%) are severely underrepresented for a codebase with 1,800 commits and major architectural migrations.

**Concepts**: 2,865 distinct concept values exist (should be 7). The 7 core concepts (`how-it-works`, `why-it-exists`, `what-changed`, `problem-solution`, `gotcha`, `pattern`, `trade-off`) account for 61% of assignments. The remaining 39% are noise: 2,174 singletons (76% of unique values), with 546 being full sentences and 622 using `concept: description` format.

**Root cause**: The parser (`parser.ts`) validates types against the mode config but does NO validation of concepts. The prompt says "MUST use ONLY these exact keywords" but the LLM ignores this ~40% of the time. Concepts are accepted as-is.

## Changes

### 1. Parser concept validation — `src/sdk/parser.ts`

After extracting concepts (line 75), add validation against the active mode's `observation_concepts`:

- **Direct match** against valid concept IDs
- **Colon-prefix normalization**: `how-it-works: full sentence` → `how-it-works`
- **Drop** concepts that don't match any valid value
- **Deduplicate** after normalization (prevents `["how-it-works", "how-it-works"]`)
- **Infer default** if all concepts were invalid (map from observation type)
- **Log** dropped concepts at debug level (expected cleanup, not error)

New helper function `inferConceptFromType(type, mode)`:
```
bugfix      → problem-solution
feature     → what-changed
refactor    → what-changed
change      → what-changed
discovery   → how-it-works
decision    → trade-off
fallback    → mode.observation_concepts[0].id
```

Mode-aware: checks the inferred concept exists in the current mode's concept list, falls back to first concept in mode if not.

### 2. Prompt improvement — `plugin/modes/code.json`

**`type_guidance`** (line 92): Replace flat list with decision tree:

```
ACTION TYPES (prefer when code/config/docs were written or modified):
  - bugfix: something was broken, now fixed
  - feature: new capability or functionality added
  - refactor: code restructured, behavior unchanged
  - change: other modifications (docs, config, deps, CI/CD)

ANALYSIS TYPES (only when NO code changes resulted):
  - discovery: read-only exploration with no resulting code changes
  - decision: architectural/design choice with explicit rationale

DECISION GUIDE: Did the work involve writing or modifying code/config/docs?
  YES → bugfix, feature, refactor, or change
  NO  → discovery or decision
```

**`concept_guidance`** (line 93): Tighten constraints and add examples:

- Reduce from "2-5" to "1-3" concepts per observation
- Remove description text from keyword list (prevents `keyword: description` pattern)
- Add explicit correct/wrong examples:
  - `<concept>how-it-works</concept>` (correct)
  - `<concept>how-it-works: understanding the auth flow</concept>` (wrong)
  - `<concept>authentication flow</concept>` (wrong)

**i18n impact**: None. Language variants (`code--es.json`, etc.) do NOT override `type_guidance` or `concept_guidance`. Changes cascade automatically via `ModeManager.deepMerge()`.

### 3. Data cleanup script — `scripts/normalize-concepts.ts`

One-time script to normalize existing concept values. Pattern follows `scripts/cleanup-duplicates.ts` but uses `better-sqlite3` (current runtime).

- Dry run by default, `--execute` flag to apply
- For each observation: normalize concepts → drop invalid → deduplicate → infer default if empty
- Runs in a single transaction
- Reports before/after statistics

### 4. Tests — `tests/sdk/parser-concept-validation.test.ts`

Cover:
- Direct match concepts pass through
- Colon-prefixed concepts normalize to base form
- Invalid/freeform concepts are dropped
- At least 1 concept remains (inferred from type)
- Deduplication after normalization
- Mode-aware inference fallback

## Files to modify

| File | Change |
|------|--------|
| `src/sdk/parser.ts` | Add concept validation + `inferConceptFromType()` helper |
| `plugin/modes/code.json` | Rewrite `type_guidance` and `concept_guidance` |
| `scripts/normalize-concepts.ts` | New: one-time database cleanup script |
| `tests/sdk/parser-concept-validation.test.ts` | New: test coverage for concept validation |

## Implementation order

1. **Prompt** (`code.json`) — zero risk, immediate effect, pure text change
2. **Parser** (`parser.ts`) — safety net for what the prompt still misses
3. **Tests** — validate parser changes
4. **Cleanup script** — run after parts 1-2 are deployed

## Verification

1. `npm run build-and-sync` — build succeeds
2. Run tests: `npm test -- tests/sdk/parser-concept-validation.test.ts`
3. Dry-run cleanup: `npx tsx scripts/normalize-concepts.ts`
4. Start a Claude Code session, trigger observations, verify in logs that:
   - Invalid concepts are dropped at debug level
   - Types follow the new decision guide
5. After cleanup with `--execute`, verify DB: `SELECT COUNT(DISTINCT value) FROM observations, json_each(concepts);` should be ~7
6. Optional: delete Chroma collection to trigger full re-sync with clean concepts

## Notes

- Existing context filtering (`ObservationCompiler.ts`) already uses `WHERE value IN (...)` against the 7 core concepts, so invalid concepts were already invisible to future sessions. This fix is about data hygiene and preventing ongoing waste, not fixing broken functionality.
- The "always save observations" principle (parser.ts line 53) is preserved — no observations are dropped, only concepts are normalized.
- **ChromaDB**: The cleanup script only updates SQLite. Chroma stores concepts as a comma-joined metadata string, used for display/logging — not as a search filter (concept filtering happens during SQLite hydration after vector search). To fully sync: delete the Chroma collection directory and let `ensureBackfilled()` rebuild from clean SQLite data on next worker startup. This is optional and can be done anytime.
- **No downtime required**: SQLite WAL mode handles concurrent reads/writes. The cleanup script opens its own connection and wraps all updates in a single transaction. The worker can keep running. Running during a quiet moment (no active observation processing) reduces contention but is not required.
