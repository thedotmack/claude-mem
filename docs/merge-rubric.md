# The Merge Rubric

Rules for deciding whether a bug-fix PR gets merged into claude-mem. A PR must pass
**every** section. One failure anywhere is a rejection — no partial credit, no
"but the rest of it is good." If half the diff qualifies, the fix should be
resubmitted as only that half.

## 1. It must fix a bug

A bug is **incorrect behavior that exists today**: wrong output, lost data, a crash,
a wrong status code, a path that never matched, a flag that was never passed.

Not bugs:

- **Features** — new capabilities, new settings, new modes.
- **Hardening** — "making it more robust" when nothing behaves incorrectly.
  Argv-quoting refactors for fixed literal arguments, defense-in-depth backstops,
  sanitizing inputs that no attacker controls. If you can't state the incorrect
  behavior a user hits today, it's armor for a wound nobody has. How "hard" is
  your code? Wrong question. Is it *correct*?
- **Perf/cost tuning** — bounding, batching, caching for economy. Nothing was wrong.
- **Observability** — logging a failure is not fixing it.
- **Prompt tuning** — nudging a model's behavior with stronger instructions is
  mitigation, not a fix; the PR usually admits it "won't eliminate the problem."
- **Superseded fixes** — the bug must still exist on current main. A correct
  re-fix of an already-fixed bug is a no-op wearing a `fix:` prefix.

## 2. The fix must not be built out of failure-tolerance machinery

The test for any conditional in the diff: **does it correct the logic at the root
cause, or does it notice a failure and arrange to survive it?** The first is a fix.
The second is a rejection, in all of its costumes:

- **Guards** — `try/catch` that logs-and-continues, never-throws wrappers,
  "best-effort by design," tolerate-N-failures-then-drop counters. A guard's
  defining property: after it fires, the failure still exists and is now quieter.
- **Circuit breakers** — failure budgets, cooldown state, quarantine ledgers,
  persisted restart allowances. State whose only job is remembering how broken
  things are.
- **Fallbacks** — try X, fall back to Y. Second data sources when the first is
  empty, synthesized placeholder content when real content is missing, degraded
  modes that keep the pipeline moving on worse inputs. The fallback's existence
  is an admission that X is broken and nobody fixed X.
- **Retries** — loops added as resilience. Re-attempting a deterministic failure
  is a slow way to fail; re-attempting a transient one hides the defect that made
  it matter.
- **Fail-open / fail-soft modes** — "degrade gracefully," "never block the
  editor," swallow-and-warn. Errors must surface loudly or the next debugging
  session pays the interest.
- **Self-healing / recovery / watchdogs / reapers** — orphan sweepers, memory
  pollers that recycle processes, boot-time process-table scans, self-restart on
  wedge. These systems *manage* the bug in production instead of deleting it from
  the code.
- **Truncation** — capping, slicing, or silently dropping data to make a symptom
  fit. If output is too big, wrong, or duplicated, fix the producer; don't take
  scissors to the result. (Honoring an explicitly requested `limit` parameter at
  the correct point in the pipeline is semantics, not truncation.)

What *is* allowed — and encouraged:

- **Removing** any of the above. Deleting a retry, a fallback path, or a silent
  catch is the best kind of diff.
- **Fail-fast conversions** — turning silent tolerance into a loud, immediate,
  typed error at the boundary where it belongs.
- **Plain correctness** — right sort order, right path expansion, right quoting,
  right flag, right spawn mechanism, right ordering of operations, right column
  in the WHERE clause. An `if` statement is fine when it *is* the correct logic,
  rather than a bouncer standing in front of incorrect logic.

## 3. No second system

The fix must live inside the system that has the bug. Rejected on sight:

- New background processes, pollers, or scheduled sweeps.
- New lock / marker / state files on disk.
- New lifecycle managers, recovery modules, or FFI subsystems layered beside the
  existing path "as a backstop."
- New env-var-driven alternate modes — an escape hatch that preserves the old
  broken behavior means the author didn't believe their own fix.
- Any module whose line count dwarfs the logic error it addresses. A wrong
  comparison does not need 350 lines of ledger to become a right comparison.

Tests are exempt: regression tests are part of the fix, not a second system.

## 4. Scale check

The size of the fix should be proportional to the size of the logic error.
One wrong line → roughly one changed line plus tests. When a one-line defect
arrives inside a 400-line diff, the extra 399 lines are one of the costumes from
section 2 — find which one, then reject it.

---

*Origin: distilled from a full audit of 100 open PRs (2026-07-22), where the
passing minority were uniformly small root-cause corrections — and every
rejection was some flavor of machinery for surviving the bug instead of fixing it.*
