# 07 — Dead Code Sweep

**Purpose**: This is the sweep plan. It catches any dead code the other six plans don't explicitly delete. It runs last in the DAG (see `98-execution-order.md`, to be written in Phase 6 of `_rewrite-plan.md`). Its job is twofold: (1) verify that the deletions scheduled by the other plans have actually landed, and (2) delete anything that slipped through — unused exports, commented-out blocks, `@deprecated` fences, unused spawn helpers, and duplicated migration logic. If this sweep finds something unexpected, that is a signal: an earlier plan missed a coupling, and the finding should be fed back to the plan that owns the subsystem, not patched over here.

---

## Principles invoked

**Primary anchor — Principle 7** from `00-principles.md`:

> **7. Delete code in the same PR it becomes unused.** No `@deprecated` fence, no "remove next release."

This plan is the operational enforcement of Principle 7 across the corpus. Every other plan deletes the specific code it rewrites around; this plan guarantees that the overall tree is free of dead code after the rewrite lands.

**Secondary anchor — Principle 6**:

> **6. One helper, N callers.** Not N copies of a helper. Not a strategy class for each config.

Invoked for the `SessionStore.ts:52-70` duplication: `SessionStore` re-runs every `ensure*` / `add*` migration step that `MigrationRunner` already owns. Two copies of the migration sequence is exactly the "N copies of a helper" that principle 6 forbids. The sweep consolidates to `new MigrationRunner(db).runAllMigrations()`.

---

## Relationship to other plans

The other plans explicitly delete several named dead-code items. This plan does not re-claim them — it verifies each one has landed and only deletes if an earlier plan missed it.

**Rule**: *If earlier plans delete, this plan verifies; if earlier plans miss, this plan deletes.*

| Dead code item | Owning plan | This plan's role |
|---|---|---|
| `TranscriptParser` class at `src/utils/transcript-parser.ts:28-90` | `03-ingestion-path.md` Phase 9 | Verify the file is gone; grep `TranscriptParser` in `src/` returns 0. If still present, delete here and flag the Phase 9 regression. |
| Migration 19 no-op at `src/services/sqlite/migrations/runner.ts:621-628` | `01-data-integrity.md` Phase 8 | Verify the case block is gone and migration 19 is absorbed into the fresh `schema.sql`. If still present, delete here and flag the Phase 8 regression. |
| `@deprecated getExistingChromaIds` | `04-read-path.md` Phase 7 | Verify the function, its JSDoc fence, and every import are gone; grep `getExistingChromaIds` in `src/` returns 0. If still present, delete here and flag the Phase 7 regression. |

---

## Scope — the catch-all list

Items in scope for this sweep (anything below that is still present after plans 01–06 land is deleted here):

1. **Commented-out code** — any `// removed`, `// old`, `// legacy`, `// TODO remove`, or similar commented-out blocks in `src/`.
2. **Unused exports** — anything `ts-prune` (or `knip`) flags as exported but not imported anywhere in `src/` or `tests/`.
3. **Unused spawn / path helpers** — any `bun-resolver.ts`, `bun-path.ts`, `BranchManager.ts`, `runtime.ts` spawn-site or helper that no longer has a caller after plans 02 and 05 land (lazy-spawn consolidation may strip their only callers).
4. **Duplicated migration logic** at `src/services/sqlite/SessionStore.ts:52-70` — the block that re-calls every `ensure*` / `add*` migration method already owned by `MigrationRunner`. Collapse to `new MigrationRunner(db).runAllMigrations()`.
5. **Residual `@deprecated` fences** — any JSDoc `@deprecated` block left in `src/` after the named ones above are handled.

---

## Phase 1 — Tool install + inventory

Install `ts-prune` as the dead-code finder:

```bash
npm install -D ts-prune
```

**Tool choice**: `ts-prune` over `knip`. Rationale: `ts-prune`'s output is a flat `file:line - name` list that's trivial to grep and pipe into the Phase 3 test-import verification. `knip` produces a richer but noisier report (configs, binaries, dependencies) that requires a config file to tune down; for a one-shot sweep against a known TypeScript source tree, `ts-prune`'s single-purpose output is the lower-friction choice. If `ts-prune` misses something the test suite later flags, revisit with `knip`.

Run it and capture the working list:

```bash
npx ts-prune --project tsconfig.json src/ > .pathfinder-sweep/ts-prune.txt
```

The contents of `ts-prune.txt` are the starting inventory for Phases 2–4.

---

## Phase 2 — Grep for commented-out code patterns

Scan `src/` for the canonical commented-out-block markers:

```bash
grep -rn "^[[:space:]]*// \(removed\|old\|legacy\|TODO remove\)" src/ | head -200
```

Review each hit. Categories:

- **Code the author thought they'd restore**: delete. If it's needed, git history preserves it.
- **A comment that happens to match the pattern but isn't dead code** (e.g., a docstring referring to "the old format"): leave it; these are false positives.
- **A `@deprecated` fence**: carries into Phase 4 for deletion.

Append findings to `.pathfinder-sweep/commented-blocks.txt`.

---

## Phase 3 — Verify against test imports

For every candidate flagged in Phase 1 (unused exports) and Phase 2 (commented-out blocks whose removal might expose something), confirm the symbol is not imported by a test.

```bash
grep -rn "<symbol-name>" tests/ "src/**/*.test.ts"
```

**Rule**: if any test imports the symbol, do NOT delete. A test exercising a symbol means either (a) the symbol has a real caller via the test harness, or (b) the test itself is dead and belongs in a different cleanup pass — not this one.

Trim the Phase 1 / Phase 2 lists accordingly. The remaining entries are the deletion queue for Phase 4.

---

## Phase 4 — Delete dead code with rationale

Walk the deletion queue. Batch related deletions (e.g., all four unused exports from `src/utils/bun-path.ts` land together). Each commit uses a one-line message in this form:

```
dead code: <symbol or file> (no importers in src/ or tests/)
```

Examples:

```
dead code: bun-resolver.resolveBunBinary (no importers in src/ or tests/)
dead code: SessionStore.ts:52-70 migration duplication (delegates to MigrationRunner)
dead code: src/utils/transcript-parser.ts file (03-ingestion-path Phase 9 missed it)
```

The commit message is load-bearing: it names the symbol and states the evidence (no importers). If the evidence is something else (e.g., "absorbed into fresh schema.sql"), state that instead.

---

## Phase 5 — Re-run build + tests

After each batched deletion commit:

```bash
npm run build-and-sync
npm test
```

Both must pass. On failure:

1. Revert that commit.
2. Re-investigate. A failure means either (a) a test transitively imports the deleted symbol, which Phase 3's grep missed (unlikely but possible with re-exports), or (b) a runtime path not covered by static analysis.
3. If the symbol really is reachable, leave it and remove it from the deletion queue.
4. If the symbol is reachable only through a `@deprecated` public-API contract with no internal caller, escalate via the Failure escape hatch below — do not force-delete.

---

## Verification

- [ ] `npx ts-prune` shows zero unused exports in `src/`
- [ ] `npm run build-and-sync` passes
- [ ] Test suite passes (`npm test`)
- [ ] `grep -rn "// @deprecated\|// TODO remove\|// old$\|// legacy$" src/` → 0
- [ ] `grep -rn "TranscriptParser" src/` → 0 (verifies `03-ingestion-path` Phase 9)
- [ ] `grep -rn "getExistingChromaIds" src/` → 0 (verifies `04-read-path` Phase 7)
- [ ] `src/services/sqlite/migrations/runner.ts` contains no case block for migration 19 (verifies `01-data-integrity` Phase 8)
- [ ] `src/services/sqlite/SessionStore.ts:52-70` duplication is gone; `SessionStore` delegates to `MigrationRunner`

---

## Anti-pattern guards (verbatim)

- Do NOT delete anything still imported by a test.
- Do NOT delete types still referenced by exported interfaces.

Additional guards specific to this sweep:

- Do NOT add a `@deprecated` fence on anything — by principle 7, it is either dead (delete now) or it is not (leave it).
- Do NOT re-delete what an earlier plan owns; file a regression note against that plan instead.
- Do NOT gate deletions behind a feature flag or environment variable.

---

## Failure escape hatch

If `ts-prune` flags a file that cannot be confidently deleted — e.g., a public API the docs describe, or a symbol referenced by an external plugin consumer — leave it in place and open a follow-up issue recording:

- The symbol and file:line
- Why it appears unused (no internal importers)
- The external contract that keeps it alive (docs link, plugin consumer, marketplace entry)

The acceptance criterion for this plan is "no dead code," not "`ts-prune` exit 0." Force-deleting a public-API symbol to satisfy the grep is a worse outcome than leaving a documented follow-up issue.

---

## DAG position

This plan is **last** in the execution DAG. It depends on every other plan (`00` through `06`) having landed, because its job is to sweep what those plans leave behind. The DAG, preflight gates, and critical path are defined in `98-execution-order.md` (to be written in Phase 6 of `_rewrite-plan.md`); this plan's last-in-DAG position is recorded there as the sink node.
