# TODO (next): make the observer IGNORE output it can't parse — kill the "poisoned" respawn heuristic

**Status:** Not started. Spec for a follow-up cleanup pass.
**Owner principle (from @thedotmack):** *The observer parser should IGNORE any output it can't parse. That is the whole job.* It must NOT inspect the content of unparseable output and act on it.

---

## The problem

When the observer SDK returns something that isn't parseable `<observation>`/`<summary>` XML, the code is supposed to drop it. Instead, a substring classifier labels some of it **`poisoned`** and **kills + respawns the SDK session**. "Poisoned" is decided by a case-insensitive `includes()` against 11 hardcoded English phrases (`session exhausted`, `context window`, `prompt is too long`, `this session has ended`, …) — see `src/sdk/output-classifier.ts:20-32`.

This is a brittle keyword match standing in for "ignore what you can't parse," and it over-fires badly.

### Evidence it's broken (live PostHog, 30d, project CMEM)

`poisoned` aborts as a share of all compression turns, by model:

| Model | poisoned % of turns | context |
|---|---|---|
| haiku (4.5) | **41.1%** | 200K |
| claude-haiku-4-5-20251001 | **33.9%** (9.0M turns) | 200K |
| claude-sonnet-4-5 | 17.7% | 200K–1M |
| claude-sonnet-4-6 | 9.6% | 200K–1M |
| claude-opus-4-7 | 5.9% | 200K |
| gemini-2.5-flash-lite | **0.1%** | 1M |
| openai/gpt-oss-120b:free | **0.1%** | — |
| gemini-3-flash-preview / xiaomi mimo-flash:free | **~0%** | small |

Total ≈ **13.2M poisoned aborts / 30d ≈ 22% of all turns.**

**This is the inverse of real context exhaustion.** If "poisoned" meant running out of room, the *small-context* models would top the list. Instead they're ~0% and the *large-context Claude* models are 6–41%. The classifier is matching Claude's closure-phrase *wording* (e.g. "I cannot continue this session"), not session health. Net effect: claude-mem kills+respawns ~1/3 of Haiku sessions on a keyword false positive, throwing away work and re-spending tokens.

(Note: the word "poisoned" is also just wrong — it implies tainted/corrupted input, not a wedged session. The whole concept should go.)

---

## The fix — "parse XML or drop it," nothing content-based

### Where it lives
- `src/services/worker/agents/ResponseProcessor.ts`
  - `:56-120` — the `!parsed.valid` branch. The **correct behavior already exists** at `:115-120` ("Plain-text skip responses are intentionally ignored" → `confirmClaimedMessages` drops the batch, returns).
  - `:75-77` — the offending trigger:
    ```js
    const mustRespawn =
      outputClass === 'poisoned' ||                                  // ← remove
      session.consecutiveInvalidOutputs >= INVALID_OUTPUT_RESPAWN_THRESHOLD; // ← see decision
    ```
  - `:79-113` — the respawn + telemetry block. `:26` — `INVALID_OUTPUT_RESPAWN_THRESHOLD = 3`.
- `src/sdk/output-classifier.ts` — `POISONED_MARKERS` (`:20-32`), `poisoned` in the `ObserverOutputClass` union (`:13`), the precedence check (`:67-73`).
- `src/services/worker/SessionManager.ts` — `respawnPoisonedSession` (`:252`), `session.abortReason = 'poisoned'` (`:273`).
- `src/services/worker/http/routes/SessionRoutes.ts:37,44` — `abort_reason` enum mapping incl. `poisoned`.
- `src/services/telemetry/scrub.ts:90-99` — enum doc comments + whitelisted keys `invalid_output_class`, `abort_reason`, `respawn_triggered`, `consecutive_invalid_outputs`.
- `src/npx-cli/commands/telemetry.ts:71,74` — field docs listing `poisoned`.
- Tests: `output-classifier` tests + any `ResponseProcessor` respawn tests.

### Recommended change: PURE IGNORE (remove ALL content-driven respawn)
1. **`output-classifier.ts`** — delete `POISONED_MARKERS` and the `poisoned` class. Classifier collapses to `xml` (parseable) vs not. Keep `previewOutput()` for log visibility only — it must never drive behavior.
2. **`ResponseProcessor.ts`** — remove the whole `mustRespawn`/respawn block (`:71-113`). Unparseable output always falls through to the existing drop path (`:115-120`). Keep the warn-log + `previewOutput` so drops stay visible.
3. **`SessionManager.respawnPoisonedSession`** — remove if it becomes dead code (confirm no other callers; `respawnPoisonedSession` is referenced from the Phase-2 buffer-flush guards — do NOT flush a rollup for it; just delete the call path cleanly).
4. **`scrub.ts` / `SessionRoutes.ts` / CLI docs** — drop the `poisoned` enum value and, if respawn goes entirely, the now-unused `respawn_triggered` / `invalid_output_class` / `abort_reason` keys (or keep them whitelisted but unused — safer to keep keys, remove only the `poisoned` value from docs).
5. **Tests** — delete poison-classification + immediate-respawn tests; add a test asserting unparseable output is dropped (batch confirmed, no respawn) regardless of content.

**Why pure-ignore is loop-safe:** the drop path calls `confirmClaimedMessages` — the batch is NOT re-queued, so a genuinely-stuck session can't loop "until quota exhausted." The 3-strikes respawn was guarding a loop that the drop path already prevents.

### If a safety net is still wanted (fallback option)
Keep **only** the content-agnostic `consecutiveInvalidOutputs >= 3` structural respawn; remove just the `outputClass === 'poisoned' ||` clause and the `POISONED_MARKERS` list. This kills the 33–41% false positives but retains a structural circuit-breaker. (Owner leans toward pure-ignore above.)

---

## Verification
- `bun test` (output-classifier + ResponseProcessor + telemetry suites) green; `tsc --noEmit` clean.
- Grep guard: `grep -rin "poison" src` returns nothing behavioral (only history/comments if intentionally kept).
- Manual: feed the observer non-XML output containing the string "context window" → asserted **ignored/dropped, session NOT respawned**.
- Post-ship PostHog: `invalid_output_class='poisoned'` / `abort_reason='poisoned'` volume goes to zero on updated installs; Haiku turn throughput should rise (fewer needless respawns).

## Dashboard follow-up (separate, non-blocking)
The "Session abort reasons" and "Compression invalid-output classes" tiles on dashboard 1739781 will lose the `poisoned` slice as installs update — expected. No tile change needed; the decay itself is the confirmation signal.
