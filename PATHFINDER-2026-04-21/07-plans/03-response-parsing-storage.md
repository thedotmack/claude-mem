# 03 — response-parsing-storage (implementation plan)

> **Design authority**: `05-clean-flowcharts.md` §3.7 (clean diagram + deletion list at lines 295–317), Part 1 bullshit items #20–#23 (lines 38–41), Part 2 decision **D5** (lines 77). This plan translates §3.7 into concrete edits. Where the audit disagrees with verified code, the live-file citations win and are called out.

## Dependencies

- **Upstream** — `02-sqlite-persistence`. The sibling plan introduces a `UNIQUE(session_id, tool_use_id)` constraint on `pending_messages` and replaces the 30 s in-memory dedup window with `INSERT … ON CONFLICT DO NOTHING`. *This plan does not touch `pending_messages` schema, but the sibling's `markFailed` contract (`UPDATE … SET status='failed'`) must remain intact — parser-level failure marking continues to go through `PendingMessageStore.markFailed(messageId)` at `src/services/sqlite/PendingMessageStore.ts:349`.* Cite: 02-sqlite-persistence Phase 2 (UNIQUE-constraint phase).
- **Downstream** — `07-session-lifecycle-management`. That plan owns `RestartGuard` evolution and the one-reaper timer. **Critical coupling**: today `RestartGuard` (`src/services/worker/RestartGuard.ts:12–70`) exposes only `recordRestart()`, `recordSuccess()`, and read-only counters — **there is no `recordFailure()` method**. The audit's D5 claim "RestartGuard already exists for repeated failures" is half-true: it covers process-restart loops, not per-message parse failures. Two legitimate options:
    1. (preferred) Let parse-failure propagate via `PendingMessageStore.markFailed` only. Session exits through the existing idle path; on the next summarize or observation attempt the session is re-initialised. If parsing fails repeatedly enough to crash the SDK subprocess, `RestartGuard.recordRestart()` is the thing that trips — already wired via existing restart paths. No new RestartGuard surface area required.
    2. (alt) Add `session.recordFailure(reason)` as a thin helper that logs + calls `markFailed` for each `processingMessageIds` entry. Still no RestartGuard API changes.
  **This plan adopts option (1)**: no new methods on RestartGuard. The flowchart box "session.recordFailure()" from §3.7 resolves to the block of code that marks all `processingMessageIds` as `'failed'` in `pending_messages` — identical shape to today's non-XML early-fail branch at `ResponseProcessor.ts:102–106`, but reached through the single `parseAgentXml` return path. See the `07-session-lifecycle-management` plan for any RestartGuard API additions; do not add them here.

## Verified facts (pinned to files)

| # | Fact | Source |
|---|---|---|
| V7a | `coerceObservationToSummary` is a private fn used twice inside `parseSummary`. | `src/sdk/parser.ts:222` (def), `:152` + `:197` (call sites) |
| V7b | Non-XML early-fail branch lives at lines 87–108. | `src/services/worker/agents/ResponseProcessor.ts:87–108` |
| V7c | Consecutive-summary-failures circuit breaker lives at lines 176–200. | `src/services/worker/agents/ResponseProcessor.ts:176–200` |
| V7d | `consecutiveSummaryFailures` field on `ActiveSession`. | `src/services/worker-types.ts:53` |
| V7e | `consecutiveSummaryFailures` is also **read** by `SessionManager.queueSummarize` at line 340 to short-circuit. That site must be deleted too — the original Phase 3 draft in `06-implementation-plan.md` did not list it. | `src/services/worker/SessionManager.ts:340–346` |
| V7f | `MAX_CONSECUTIVE_SUMMARY_FAILURES` constant in `src/sdk/prompts.ts:21` is imported by both `ResponseProcessor.ts:16` and `SessionManager.ts` (via prompts import). Delete the constant and both imports. | `src/sdk/prompts.ts:21` |
| V7g | Pending-message FAILED state literal is **`'failed'`** (lowercase). CHECK constraint: `status IN ('pending','processing','processed','failed')`. `markFailed(messageId)` is the official API. | `src/services/sqlite/PendingMessageStore.ts:22`, `:349`, `:369`; `src/services/sqlite/migrations/runner.ts:533`; `src/services/sqlite/SessionStore.ts:565` |
| V7h | RestartGuard has no `recordFailure()` method. Public surface: `recordRestart()`, `recordSuccess()`, `restartsInWindow`, `windowMs`, `maxRestarts`. | `src/services/worker/RestartGuard.ts:1–70` |
| V7i | Prompts already mandate `<summary>` root tag for summary turns ("you MUST wrap your ENTIRE response in `<summary>...</summary>` tags", "The ONLY accepted root tag is `<summary>`"). `<skip_summary reason="..."/>` is recognised by the parser (`parser.ts:124`) but is **not** documented in `buildSummaryPrompt` as a valid alternative. Prompt must be updated (Phase 1b) so the D5 contract is actually printed to the agent. | `src/sdk/prompts.ts:153–174`; `src/sdk/parser.ts:124` |
| V7j | Atomic TX boundary is `sessionStore.storeObservations(...)` (single call, internal BEGIN/COMMIT). Do not split it. Today it wraps observations + optional summary in one transaction. | `src/services/worker/agents/ResponseProcessor.ts:149–164`, `src/services/sqlite/observations/store.ts` (module) |
| V7k | `parseSummary` accepts `coerceFromObservation: boolean = false`. All coercion is gated on this flag — it is `true` only when `summaryExpected` (derived from `SUMMARY_MODE_MARKER` substring match) is true. | `src/sdk/parser.ts:122`, `ResponseProcessor.ts:75–81` |

## Concrete target signatures

```ts
// src/sdk/parser.ts — replaces parseObservations + parseSummary + coerceObservationToSummary
export type ParseFailureReason = 'no_xml' | 'missing_summary' | 'malformed';

export interface ParsedAgentOutput {
  observations: ParsedObservation[];
  summary: ParsedSummary | null;
  skipSummary: boolean;
}

export type ParseResult =
  | { valid: true; data: ParsedAgentOutput }
  | { valid: false; reason: ParseFailureReason };

export function parseAgentXml(
  text: string,
  opts: { requireSummary: boolean; correlationId?: string; sessionId?: number }
): ParseResult;
```

Failure semantics (no coercion, per D5):

- `text.trim()` is non-empty, no `<observation>`/`<summary>`/`<skip_summary` token → `{valid:false, reason:'no_xml'}`.
- `opts.requireSummary === true` and parse yields no `<summary>` and no `<skip_summary/>` → `{valid:false, reason:'missing_summary'}`.
- Any regex match with empty sub-tag payload where `requireSummary` → `{valid:false, reason:'malformed'}`.
- Otherwise → `{valid:true, data:{observations, summary|null, skipSummary}}`.

## Phases

### Phase 1 — Write `parseAgentXml` in `src/sdk/parser.ts`

**(a) What to implement**
1. Copy `extractField` from `src/sdk/parser.ts:267–276` and `extractArrayElements` from `:282–305` verbatim into the new module layout. These remain private helpers.
2. Copy the observation-extraction loop body (field extraction, type validation, ghost-obs filter) from `src/sdk/parser.ts:40–108` into a private `extractObservations(text, correlationId)` that returns `ParsedObservation[]`. No behaviour change.
3. Copy the summary-extraction happy path (skip_summary check at `:124–133`, `<summary>` regex at `:136–137`, field extraction at `:164–169`, false-positive guard at `:191–214`) into a private `extractSummary(text, sessionId)` that returns `{ summary: ParsedSummary | null; skipSummary: boolean; malformed: boolean }`. **Delete the two `coerceFromObservation` branches at `:151–158` and `:196–203` — they do not survive.**
4. Delete `coerceObservationToSummary` (`src/sdk/parser.ts:222–259`, 38 lines) outright.
5. Write the public `parseAgentXml(text, opts)` that:
   - Computes `observations = extractObservations(text, opts.correlationId)`.
   - Computes `{ summary, skipSummary, malformed } = extractSummary(text, opts.sessionId)`.
   - Returns `{valid:false, reason:'no_xml'}` if `text.trim()` && `observations.length === 0` && `!summary` && `!skipSummary` && `!/<observation>|<summary>|<skip_summary\b/.test(text)`.
   - Returns `{valid:false, reason:'missing_summary'}` if `opts.requireSummary` && `!summary` && `!skipSummary`.
   - Returns `{valid:false, reason:'malformed'}` if `opts.requireSummary` && `malformed`.
   - Returns `{valid:true, data:{observations, summary, skipSummary}}` otherwise.
6. Remove the old named exports `parseObservations` and `parseSummary` and their `coerceFromObservation` parameter. Keep `ParsedObservation`/`ParsedSummary` interfaces (`src/sdk/parser.ts:9–27`) — they're part of the public shape.

**(b) Docs** — `05-clean-flowcharts.md` §3.7 (clean diagram, lines 295–317), Part 1 #20/#21/#23 (lines 38–41), Part 2 D5 (line 77). V7a (parser.ts:222). V7i (prompt contract already mandates `<summary>`; skip-summary token recognised at parser.ts:124). V7k (coerceFromObservation gating on `summaryExpected`).

**(c) Verification**
- `grep -n "coerceObservationToSummary" src/` → 0 hits.
- `grep -n "parseObservations\|parseSummary\b" src/` → 0 hits outside `parser.ts` itself; inside `parser.ts` only the private helpers.
- Unit test: `parseAgentXml('', {requireSummary:false})` → `{valid:true, data:{observations:[], summary:null, skipSummary:false}}` (empty string is not `no_xml`; trim is empty).
- Unit test: `parseAgentXml('Error: auth token expired', {requireSummary:true})` → `{valid:false, reason:'no_xml'}`.
- Unit test: agent returns `<observation><type>x</type><title>t</title></observation>` with `requireSummary:true` → `{valid:false, reason:'missing_summary'}` (no coercion to summary).
- Unit test: `<skip_summary reason="no work"/>` with `requireSummary:true` → `{valid:true, data:{observations:[], summary:null, skipSummary:true}}`.
- Unit test: `<summary><request>r</request>…</summary>` → `{valid:true, data:{…, summary:{…}, skipSummary:false}}`.

**(d) Anti-pattern guards**
- **Guard C (silent fallback)**: Coercion is *deleted*, not relocated. `grep -n "coerce" src/sdk/parser.ts` → 0 hits.
- **Guard D (facades)**: `parseObservations` + `parseSummary` collapse to a single `parseAgentXml`. Two public fns → one.
- **Guard A (invent APIs)**: No new classes. Pure function returning a discriminated union. No `ParserValidator`, no `SummaryCoercer`, no base class.

---

### Phase 1b — Update agent contract in `src/sdk/prompts.ts`

**(a) What to implement** — Extend `buildSummaryPrompt()` at `src/sdk/prompts.ts:140–175` (the return-value template) so it explicitly permits `<skip_summary reason="..."/>` as an alternative when there is literally nothing to summarise. Current text says "The ONLY accepted root tag is `<summary>`" (`:155`), which is incompatible with the parser's `<skip_summary/>` recognition (`parser.ts:124`) and incompatible with the D5 contract ("`<summary>` or `<skip_summary/>`"). Proposed insertion, directly after the existing line `:173`:

```
• If (and ONLY if) there is no work to summarise, you may return
  <skip_summary reason="..."/> as the sole root tag instead of <summary>.
  Any other response is a protocol violation and the session will fail.
```

Also delete the export `MAX_CONSECUTIVE_SUMMARY_FAILURES` at `src/sdk/prompts.ts:21` and its JSDoc at `:17–20`. The constant is unused after Phase 2 + Phase 3.

**(b) Docs** — §3.7 deletion list ("agent must return `<summary>` or `<skip_summary/>`", line 311). Part 2 D5 (line 77). V7i.

**(c) Verification**
- `grep -n "MAX_CONSECUTIVE_SUMMARY_FAILURES" src/` → 0 hits.
- Manual diff of generated summary prompt shows the skip-summary clause.
- Existing prompt-mandate text (`:153`, `:155`, `:173`) preserved so the normal-case contract stays strict.

**(d) Anti-pattern guards**
- **Guard C**: The contract is now self-describing — no silent downstream coercion needed because the agent is told the protocol explicitly.

---

### Phase 2 — Replace parse path in `ResponseProcessor.ts`

**(a) What to implement**
1. Replace the import at `src/services/worker/agents/ResponseProcessor.ts:15` with `import { parseAgentXml, type ParsedObservation, type ParsedSummary } from '../../../sdk/parser.js';`. Delete `MAX_CONSECUTIVE_SUMMARY_FAILURES` from the `:16` import (keep `SUMMARY_MODE_MARKER`).
2. Replace `processAgentResponse` body at `:69–108`:
   - Keep `:62–67` (lastGeneratorActivity + conversationHistory append).
   - Compute `summaryExpected` exactly as today (`:75–79`).
   - Replace `:70` and `:81` (two separate parse calls) with a single call:
     ```ts
     const parsed = parseAgentXml(text, {
       requireSummary: summaryExpected,
       correlationId: session.contentSessionId,
       sessionId: session.sessionDbId,
     });
     ```
   - Replace the non-XML early-fail block `:83–108` (26 lines) with:
     ```ts
     if (!parsed.valid) {
       const preview = text.length > 200 ? `${text.slice(0, 200)}...` : text;
       logger.warn('PARSER', `${agentName} returned invalid response (${parsed.reason}); marking messages as failed`, {
         sessionId: session.sessionDbId,
         reason: parsed.reason,
         preview,
       });
       const pendingStore = sessionManager.getPendingMessageStore();
       for (const messageId of session.processingMessageIds) {
         pendingStore.markFailed(messageId);
       }
       session.processingMessageIds = [];
       return;
     }
     const { observations, summary } = parsed.data;
     ```
   - Everything at `:110–174` stays unchanged (normalize, ensureMemorySessionIdRegistered, STORING log, labeledObservations, atomic TX, STORED log, lastSummaryStored) — the single-TX invariant is preserved.
3. **Delete the circuit-breaker block `:176–200`** (25 lines) entirely. After deleting, `:202` (claim-confirm) runs immediately after `:174` (lastSummaryStored).
4. No changes to `:202–241` (claim-confirm, restartGuard.recordSuccess, Chroma sync, SSE broadcast, cleanup).
5. **(Preflight edit 2026-04-22 — reconciliation C6)** Emit `summaryStoredEvent` when a summary row is committed. After setting `session.lastSummaryStored` (unchanged from today), if `session.summaryStoredEvent` exists (initialized by `SessionManager` when the session is created, see plan 07 Phase 7), call `session.summaryStoredEvent.emit('stored', summaryId)`. This unblocks the blocking `/api/session/end` handler in plan 07 Phase 7 without polling. Contract: emit exactly once per summary commit; `summaryId` is the newly inserted row id from the atomic TX.
   ```ts
   // inside the block that sets session.lastSummaryStored (around :170–174)
   session.lastSummaryStored = true;
   session.summaryStoredEvent?.emit('stored', summaryRowId);
   ```

**(b) Docs** — §3.7 clean diagram (B→C→D→{Fail | Store}→Confirm→…, lines 299–308). Part 1 #21 (line 39), #22 (line 40). Part 2 D5 (line 77). V7b (`:87–108`), V7c (`:176–200`), V7g (`'failed'` + `markFailed`).

**(c) Verification**
- `grep -n "parseObservations\|parseSummary\|coerceObservationToSummary\|consecutiveSummaryFailures" src/services/worker/agents/ResponseProcessor.ts` → 0 hits.
- `grep -n "MAX_CONSECUTIVE_SUMMARY_FAILURES" src/services/worker/agents/ResponseProcessor.ts` → 0 hits.
- Integration test A — malformed input: send `"Service temporarily unavailable"` as `text`, assert (i) no row inserted in `observations` table, (ii) no row in `session_summaries`, (iii) every id in `session.processingMessageIds` has `status='failed'` in `pending_messages` after the call returns, (iv) `session.processingMessageIds === []`.
- Integration test B — observation-without-summary when summary expected: `summaryExpected=true`, text is `<observation><type>code</type><title>x</title></observation>`, assert (i) no row in `session_summaries`, (ii) no row in `observations` (contract failure fails the whole batch — no partial write), (iii) pending messages marked `failed`. This is **the critical regression test** — today the coerce path would have written a coerced summary row.
- Integration test C — valid obs + summary: single atomic TX still commits both rows together (pre-existing behaviour, no regression).

**(d) Anti-pattern guards**
- **Guard C**: No coercion, no "close-enough" branch. Every `parsed.valid === false` path leads to `markFailed` and `return`.
- **Guard D**: One parse call (`parseAgentXml`) replaces two (`parseObservations` + `parseSummary`). No wrapper facade.
- **Guard A**: No new method on `RestartGuard`, no new class, no new helper file. Direct calls to the existing `PendingMessageStore.markFailed`.

---

### Phase 3 — Remove `consecutiveSummaryFailures` from `ActiveSession` + its consumer

**(a) What to implement**
1. Delete `src/services/worker-types.ts:51–53` (the three lines: JSDoc + `consecutiveSummaryFailures: number;` field). Field name must vanish from the type.
2. Delete `src/services/worker/SessionManager.ts:336–346` (the 11-line circuit-breaker check in `queueSummarize`). The method body goes straight from the auto-initialize check (`:331–334`) to the `// CRITICAL: Persist to database FIRST` comment (`:348`). **This deletion was omitted from the original Phase 3 draft at `06-implementation-plan.md:155–204` — V7e is the new citation.**
3. Delete the initialiser `consecutiveSummaryFailures: 0,` at `SessionManager.ts:232` (inside `initializeSession`).
4. Delete the `MAX_CONSECUTIVE_SUMMARY_FAILURES` import in `SessionManager.ts` (if present). Use `grep -n "MAX_CONSECUTIVE_SUMMARY_FAILURES" src/services/worker/SessionManager.ts` first; remove the line.
5. No schema changes. No new `RestartGuard` API (see Dependencies above — option (1)).

**(b) Docs** — §3.7 deletion bullet "consecutiveSummaryFailures counter + circuit-breaker logic (RestartGuard covers this already)" (line 314). Part 1 #22 (line 40). Part 2 D5 (line 77). V7d, V7e, V7f.

**(c) Verification**
- `grep -rn "consecutiveSummaryFailures" src/` → 0 hits.
- `grep -rn "MAX_CONSECUTIVE_SUMMARY_FAILURES" src/` → 0 hits (constant, its JSDoc, all imports gone).
- TypeScript compile succeeds (removing a field and all references is mechanical; no union fallout expected).
- Behavioural test: call `sessionManager.queueSummarize(sessionDbId)` five times in rapid succession with intentionally failing agent output; assert every call enqueues to `pending_messages` (no silent drop) and each failed attempt marks that message `'failed'`. The old circuit breaker would have swallowed calls 4–5; the new contract doesn't.
- Behavioural test: existing `RestartGuard` still trips after the configured restart count (`MAX_WINDOWED_RESTARTS = 10`, `RESTART_WINDOW_MS = 60_000`) — prove that repeated parse failures + subsequent subprocess restarts still converge to guard-tripped within the window. Covered by `07-session-lifecycle-management` tests; no duplication here.

**(d) Anti-pattern guards**
- **Guard A**: No new `RestartGuard.recordFailure()` invented. The class stays at 70 lines, public API unchanged. Dependency coupling to `07-session-lifecycle-management` is documentation-only.
- **Guard C**: Removing the circuit breaker means failures flow to queue-level `'failed'` state — a single, visible, DB-backed failure signal. No silent swallow.

---

### Phase 4 — Verification sweep

**(a) What to implement** — Grep audit + targeted regression tests. No new code.

**(b) Docs** — §3.7 full deletion list (lines 310–315), Phase 3 verification block in `06-implementation-plan.md:189–195`.

**(c) Verification — must all return 0 matches**
- `grep -rn "coerceObservationToSummary" src/` → 0.
- `grep -rn "consecutiveSummaryFailures" src/` → 0.
- `grep -rn "MAX_CONSECUTIVE_SUMMARY_FAILURES" src/` → 0.
- `grep -rn "parseObservations\|parseSummary" src/ | grep -v "src/sdk/parser.ts"` → 0 (the only survivors are private helpers inside `parser.ts` itself; if you named them without the `parse` prefix this grep is also 0).
- `grep -rn "coerceFromObservation" src/` → 0.

**(c-cont) Regression tests — must all pass**
- Parser fuzz: feed 1 000 synthetic agent outputs mixing valid/invalid XML + present/absent `<summary>`; assert `valid:false` paths never write to `observations` or `session_summaries`. Must be 0 coerced summary rows.
- Atomic-TX sanity: inject a DB error on `INSERT INTO session_summaries`; assert `storeObservations` rolls back so `observations` for that batch also revert. (Pre-existing invariant; we didn't touch it, but prove it.)
- Idempotency of failure: double-delivery of the same malformed response (e.g., via worker crash + retry) results in the same `pending_messages` row in `'failed'` status; second attempt does not create a duplicate observation. Relies on upstream `02-sqlite-persistence` `UNIQUE(session_id, tool_use_id)` — cross-check with that plan.
- End-to-end: Stop-hook summarize path exercises `parseAgentXml({requireSummary:true})`. With a mocked agent returning garbage, assert the hook receives the 110 s timeout path (no silent summary write), the pending message is `'failed'`, and SessionManager does NOT short-circuit subsequent summarize enqueues (circuit breaker is gone).

**(d) Anti-pattern guards** — All four grep checks enforce Guards A/C/D structurally.

---

## Blast radius

**Files modified**:
- `src/sdk/parser.ts` — full rewrite of public surface; private helpers preserved.
- `src/sdk/prompts.ts` — two-edit surgical change (skip-summary clause, constant delete).
- `src/services/worker/agents/ResponseProcessor.ts` — replace lines 15–16 imports, 69–108 parse block, delete 176–200 circuit breaker.
- `src/services/worker-types.ts` — delete 3 lines.
- `src/services/worker/SessionManager.ts` — delete 11 lines (queueSummarize guard) + 1 line initialiser + maybe 1 import.

**Files not touched**: `src/services/sqlite/observations/store.ts` (atomic TX lives here and is preserved). `src/services/worker/RestartGuard.ts` (API unchanged — see Dependencies option 1). `src/services/worker/agents/SessionCleanupHelper.ts`. `ObservationBroadcaster.ts`. Any Chroma sync module.

**Schema changes**: none.

**Estimated lines deleted**:
- `coerceObservationToSummary` body + JSDoc: ~43 lines
- `coerceFromObservation` branches in `parseSummary`: ~16 lines
- `parseSummary` / `parseObservations` wrapper deduplication: ~15 lines (after collapse into `parseAgentXml`)
- Non-XML early-fail block in `ResponseProcessor.ts:83–108`: ~26 lines (replaced by ~12 lines → net –14)
- Circuit breaker in `ResponseProcessor.ts:176–200`: ~25 lines
- `consecutiveSummaryFailures` field + initialiser + SessionManager guard: ~15 lines
- `MAX_CONSECUTIVE_SUMMARY_FAILURES` constant + JSDoc + imports: ~8 lines

**Net**: ~135 lines deleted, ~35 lines added → **~100 LoC net reduction**.

## Confidence + gaps

**High confidence**:
- Parser rewrite is mechanical (extract three private fns, compose them, add the discriminated-union return).
- `'failed'` status string + `markFailed` API are verified.
- Circuit-breaker + field removals are pure deletion once call sites are enumerated (V7e catches the missed site).

**Gaps**:
1. **RestartGuard contract claim in D5 is overstated.** D5 says "RestartGuard already exists for repeated failures — delete the separate counter". RestartGuard today only handles **process-restart** loops, not per-message parse failures. This plan adopts the narrower interpretation (parse failure → `markFailed`; existing RestartGuard handles the subprocess-restart side effects unchanged). If the `07-session-lifecycle-management` plan decides to add `RestartGuard.recordFailure()`, callers here can start using it in a follow-up — no churn to this plan. **Flag for `07-session-lifecycle-management` author**: confirm the RestartGuard surface they want.
2. **Prompt updates assumed in-scope.** The audit implies the agent contract "already states `<summary>` or `<skip_summary/>`". Verified: prompts enforce `<summary>` strictly but never mention `<skip_summary/>`. Phase 1b adds the missing clause. If the team prefers to keep `<skip_summary/>` as a *recognised-but-undocumented* escape hatch, Phase 1b can be dropped — but then the parser should be stricter too (reason `missing_summary` when only skip-summary is emitted without prompt permission). Flag for product owner.
