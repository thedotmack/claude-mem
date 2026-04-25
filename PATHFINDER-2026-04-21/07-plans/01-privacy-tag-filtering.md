# Plan 01 — privacy-tag-filtering (foundation)

**Target design**: `PATHFINDER-2026-04-21/05-clean-flowcharts.md` section 3.2 ("privacy-tag-filtering (clean)")
**Before-state diagram**: `PATHFINDER-2026-04-21/01-flowcharts/privacy-tag-filtering.md`
**Author date**: 2026-04-22
**Execution order slot**: Part 6 steps 1 and 2 (U6 `stripMemoryTags` + U1 summary privacy gap). First plan in the series.

## Dependencies

- **Upstream (must land before this)**: **none** — this is the foundation plan for the v6.5.0 brutal-audit refactor.
- **Downstream (depends on this)**:
  - `07-session-lifecycle-management.md` — introduces `ingestObservation` / `ingestPrompt` / `ingestSummary` helpers that wrap `stripMemoryTags`. Plan 01 must land first so those helpers have a single strip function to call.
  - `08-transcript-watcher-integration.md` — calls `ingestObservation` directly (dropping the HTTP loopback). Needs the ingest helpers introduced downstream, which in turn need `stripMemoryTags`.
  - `09-lifecycle-hooks.md` — the new `POST /api/session/observation`, `/api/session/prompt`, `/api/session/end` paths must all run stripping; they will route through the downstream ingest helpers.

---

## Sources Consulted

| Source | Lines | What it gave us |
|---|---|---|
| `PATHFINDER-2026-04-21/05-clean-flowcharts.md` | 19, 20, 21, 47, 127-156, 534-558, 564-584 | Part 1 items #1, #2, #3, #29; section 3.2 authoritative clean design; Part 5 deletion ledger row "stripMemoryTagsFromPrompt / FromJson wrappers" (-60/+15 = -45) + summary-path privacy-gap fix row (+3); Part 6 execution steps 1-3 |
| `PATHFINDER-2026-04-21/06-implementation-plan.md` | 22-47 (Phase 0 verified findings V1-V4), 69-111 (Phase 1 tasks), 114-151 (Phase 2 context on ingest helpers), 59-66 (anti-pattern guards A-E) | Verified findings that correct the audit (V1: summary strips ZERO tags not just `<system-reminder>`; V2: `handleObservations` is at line 464, not 378; V3+V4: wrapper + call-site inventory) |
| `PATHFINDER-2026-04-21/01-flowcharts/privacy-tag-filtering.md` | 1-86 | Before-state: three ingress paths (prompt, observation, summary) with partial/missing strip coverage on the summary path |
| `src/utils/tag-stripping.ts` | 1-91 (full file) | Current implementation: `stripTagsInternal` (line 51) + 6 sequential `.replace()` (lines 63-69) + two public wrappers (`stripMemoryTagsFromJson` line 79, `stripMemoryTagsFromPrompt` line 89), `SYSTEM_REMINDER_REGEX` export (line 24), `MAX_TAG_COUNT=100` ReDoS guard (line 31) |
| `src/services/worker/http/routes/SessionRoutes.ts` | 11 (import), 376-389 (route map), 464-485 (`handleObservations` legacy), 491-506 (`handleSummarize` legacy), 560-660 (`handleObservationsByClaudeId` with strip at 629/633), 669-710 (`handleSummarizeByClaudeId` — NO strip), 814-895 (`handleSessionInitByClaudeId` with strip at 862) | Every call site; confirmed every audit line number against live code |
| `src/cli/handlers/summarize.ts` | 19, 59-68, 84-97 | Hook extracts `last_assistant_message` via `extractLastMessage(transcriptPath, 'assistant', true)` (line 64; the `true` strips `<system-reminder>` at read-time only), then POSTs it raw to `/api/sessions/summarize` (line 89). The hook itself does NOT run `stripMemoryTags`; it relies on the worker. Today the worker doesn't strip either — that is the P1 bug. |
| `tests/utils/tag-stripping.test.ts` | 1-80 (413 total lines) | Existing tests import `stripMemoryTagsFromPrompt` + `stripMemoryTagsFromJson` by name; these imports must change. |

## Concrete Findings

1. **Wrappers are identical**. `stripMemoryTagsFromJson(content)` and `stripMemoryTagsFromPrompt(content)` both call `stripTagsInternal(content)` with no behavioural difference (`src/utils/tag-stripping.ts:80` and `:90`). Confirms audit item #1.

2. **Six sequential `.replace()` calls** at `src/utils/tag-stripping.ts:64-69`, one per tag type, each scanning the full string. Confirms audit item #3.

3. **Summary paths strip ZERO tags, not just "`<system-reminder>` only"** — this is the V1 correction to the before-state audit:
   - `handleSummarize` (`SessionRoutes.ts:491`): receives `last_assistant_message`, passes it untouched to `this.sessionManager.queueSummarize(sessionDbId, last_assistant_message)` at `:497`.
   - `handleSummarizeByClaudeId` (`SessionRoutes.ts:669`): same — raw body → `queueSummarize(sessionDbId, last_assistant_message)` at `:705`.
   - The hook-side `extractLastMessage(..., true)` at `summarize.ts:64` only strips `<system-reminder>` via `SYSTEM_REMINDER_REGEX` during transcript parsing; it does nothing for `<private>`, `<claude-mem-context>`, etc.
   - **Result**: a `<private>secret</private>` inside an assistant message persists to `pending_messages` and then to `session_summaries`. This is the P1 security gap audit item #2 claims to close.

4. **Legacy `handleObservations` is at line 464, not 378** (V2). It has NO strip — it calls `queueObservation(sessionDbId, {tool_input, tool_response, ...})` directly at `:470`.

5. **Call-site inventory (grep-verified, V4)**:
   | File | Line | Function called | Text stripped |
   |---|---|---|---|
   | `src/utils/tag-stripping.ts` | 79 | declaration `stripMemoryTagsFromJson` | — |
   | `src/utils/tag-stripping.ts` | 89 | declaration `stripMemoryTagsFromPrompt` | — |
   | `src/services/worker/http/routes/SessionRoutes.ts` | 11 | import both wrappers | — |
   | `src/services/worker/http/routes/SessionRoutes.ts` | 629 | `stripMemoryTagsFromJson(JSON.stringify(tool_input))` | observation |
   | `src/services/worker/http/routes/SessionRoutes.ts` | 633 | `stripMemoryTagsFromJson(JSON.stringify(tool_response))` | observation |
   | `src/services/worker/http/routes/SessionRoutes.ts` | 862 | `stripMemoryTagsFromPrompt(prompt)` | prompt |
   | `tests/utils/tag-stripping.test.ts` | 13 | import both wrappers | — (test) |

   **No other call sites exist**. The summary path (`:491`, `:669`), the legacy observation path (`:464`), and the hook side of summarize (`summarize.ts`) never touch a strip function.

6. **ReDoS guard & trim already correct**. `countTags` at `tag-stripping.ts:37` + `MAX_TAG_COUNT=100` check at `:54`; `.trim()` at `:70`. Keep both.

7. **`SYSTEM_REMINDER_REGEX` is exported** (`tag-stripping.ts:24`) and used by `src/shared/transcript-parser.ts:84` and `:128` to strip system-reminder at transcript-read-time (the `stripSystemReminders=true` path in `extractLastMessage`). That external use is **not** a memory-strip call site — it is a read-time sanitation of raw transcript JSON. Section 3.2 of 05 keeps that behaviour (it operates before text ever enters our pipeline). **Keep `SYSTEM_REMINDER_REGEX` as an export.**

## Copy-Ready Snippet Locations

`/do` runs can copy verbatim from these locations:

| Copy from | Into | Purpose |
|---|---|---|
| `src/utils/tag-stripping.ts:31` (`MAX_TAG_COUNT = 100`) | New `src/utils/tag-stripping.ts` (rewritten) | ReDoS constant — preserve exact value |
| `src/utils/tag-stripping.ts:37-45` (`countTags`) | New `src/utils/tag-stripping.ts` | Tag-count helper — preserve exact body (one-regex version still needs a count for the warn path) |
| `src/utils/tag-stripping.ts:54-61` (ReDoS guard with `logger.warn`) | New `stripMemoryTags` body | Preserve the warn-but-continue semantics |
| `src/utils/tag-stripping.ts:24` (`SYSTEM_REMINDER_REGEX` export) | New `src/utils/tag-stripping.ts` | External callers (`transcript-parser.ts:84`, `:128`) still import this — must keep export |
| Section 3.2 alternation regex at `05-clean-flowcharts.md:132` | New `stripMemoryTags` body | `/<(private\|claude-mem-context\|system_instruction\|system-instruction\|persisted-output\|system-reminder)>[\s\S]*?<\/\1>/g` |
| `SessionRoutes.ts:629-634` (existing call shape `JSON.stringify(tool_input)`) | Replacement lines at `:629` and `:633` | Same two arguments, new function name |
| `SessionRoutes.ts:862` (existing `stripMemoryTagsFromPrompt(prompt)`) | Replacement line | Same text, new function name |

## Confidence + Gaps

**High confidence**
- Every source line number verified against live code on 2026-04-22.
- The P1 security gap is reproducible: inserting `<private>secret</private>` into an assistant message today writes through to `session_summaries.last_assistant_message` untouched.
- `SYSTEM_REMINDER_REGEX` external usage is real — if Phase 1 deletes it, `transcript-parser.ts` breaks. Keep the export.

**Gaps / unverified**
- I did not measure the ReDoS cost of the alternation regex vs. six sequential `replace()` on pathological inputs. Section 3.2 and audit item #3 claim the single regex is net-faster; that is plausible but untested. Phase 1 includes a micro-benchmark test to confirm before/after.
- Phase 1 assumes `queueObservation` and `queueSummarize` accept arbitrary strings. Confirmed by reading `SessionRoutes.ts:470` and `:497, :705` but not by reading `SessionManager.queueSummarize` itself. If `queueSummarize` does any parsing of `last_assistant_message`, stripping before the call may or may not change that behaviour — Phase 3 verifies with a targeted integration test.
- The hook-side `summarize.ts:64` call to `extractLastMessage(..., true)` leaves `<system-reminder>` stripped *before* the raw message hits the wire. After this plan lands, the worker also runs `stripMemoryTags` on it. That is a double-strip on `<system-reminder>`, which is idempotent (first pass removes it, second pass is a no-op). **Noted; not a bug.**

---

## Phase 1 — Rewrite `src/utils/tag-stripping.ts` to a single `stripMemoryTags`

### (a) What to implement

Replace the entire contents of `src/utils/tag-stripping.ts` with a new version that exports:

1. `SYSTEM_REMINDER_REGEX` (unchanged — external callers depend on it).
2. `stripMemoryTags(text: string): string` — single public function using one alternation regex with back-reference.

Copy `MAX_TAG_COUNT = 100` from current `src/utils/tag-stripping.ts:31`.
Copy `countTags` body from current `src/utils/tag-stripping.ts:37-45` (keep call-site warn semantics).
Copy the `logger.warn('SYSTEM', 'tag count exceeds limit', ...)` block from current `:54-61`.
Copy the alternation regex pattern from `PATHFINDER-2026-04-21/05-clean-flowcharts.md:132`:

```ts
const MEMORY_TAG_NAMES = [
  'private',
  'claude-mem-context',
  'system_instruction',
  'system-instruction',
  'persisted-output',
  'system-reminder',
] as const;

const STRIP_REGEX = new RegExp(
  `<(${MEMORY_TAG_NAMES.join('|')})>[\\s\\S]*?<\\/\\1>`,
  'g'
);

export function stripMemoryTags(text: string): string {
  if (!text) return text;
  const tagCount = countTags(text);
  if (tagCount > MAX_TAG_COUNT) {
    logger.warn('SYSTEM', 'tag count exceeds limit', undefined, {
      tagCount,
      maxAllowed: MAX_TAG_COUNT,
      contentLength: text.length,
    });
    // Still process but log the anomaly (preserves current behaviour)
  }
  return text.replace(STRIP_REGEX, '').trim();
}
```

Delete `stripTagsInternal`, `stripMemoryTagsFromJson`, `stripMemoryTagsFromPrompt`.

### (b) Documentation references

- `05-clean-flowcharts.md:127-156` (section 3.2 authoritative design)
- `05-clean-flowcharts.md:19` (audit item #1 — wrapper collapse)
- `05-clean-flowcharts.md:21` (audit item #3 — one-regex alternation)
- `05-clean-flowcharts.md:47` (audit item #29 — strip-on-raw-string, no stringify/parse dance — already how callers pass arguments, so no change needed here)
- `06-implementation-plan.md:30` (V3 verified inventory)
- `06-implementation-plan.md:81-87` (Phase 1 task 1 exact prescription)
- Live file: `src/utils/tag-stripping.ts:1-91`

### (c) Verification checklist

Run from repo root:

```bash
# No stray wrappers survive
grep -rn "stripMemoryTagsFromPrompt\|stripMemoryTagsFromJson\|stripTagsInternal" src/
# Expected: 0 matches

# The new function exists exactly once as a declaration
grep -n "export function stripMemoryTags\b" src/utils/tag-stripping.ts
# Expected: 1 match, on a single line

# SYSTEM_REMINDER_REGEX export preserved
grep -n "export const SYSTEM_REMINDER_REGEX" src/utils/tag-stripping.ts
# Expected: 1 match

# TypeScript compiles
npx tsc --noEmit
# Expected: exit 0 (no errors in tag-stripping.ts; SessionRoutes.ts will still error until Phase 2 — that is expected)
```

Tests: not yet — the test file still imports the old wrappers. Phase 4 updates the test file; Phase 1 leaves it broken.

### (d) Anti-pattern guards

- **A (invent APIs)**: do not add `stripMemoryTagsV2`, `stripMemoryTagsAsync`, `stripTagsSafe`, or any other variant. One public function.
- **C (silent fallbacks)**: the ReDoS guard continues to *warn and process*, not *warn and return empty*. Copy the `logger.warn` call verbatim.
- **D (facades that pass through)**: do not leave `stripMemoryTagsFromPrompt` / `stripMemoryTagsFromJson` as deprecated re-exports calling `stripMemoryTags`. Delete the names.
- **E (two code paths for same data)**: the new file has exactly one strip implementation. No branch on "is JSON" vs "is prompt".

---

## Phase 2 — Replace existing `stripMemoryTagsFromJson` / `FromPrompt` call sites

### (a) What to implement

Edit `src/services/worker/http/routes/SessionRoutes.ts` in exactly three places:

1. **Line 11** — change import:
   - From: `import { stripMemoryTagsFromJson, stripMemoryTagsFromPrompt } from '../../../../utils/tag-stripping.js';`
   - To:   `import { stripMemoryTags } from '../../../../utils/tag-stripping.js';`

2. **Line 629** — rename only:
   - From: `? stripMemoryTagsFromJson(JSON.stringify(tool_input))`
   - To:   `? stripMemoryTags(JSON.stringify(tool_input))`

3. **Line 633** — rename only:
   - From: `? stripMemoryTagsFromJson(JSON.stringify(tool_response))`
   - To:   `? stripMemoryTags(JSON.stringify(tool_response))`

4. **Line 862** — rename only:
   - From: `const cleanedPrompt = stripMemoryTagsFromPrompt(prompt);`
   - To:   `const cleanedPrompt = stripMemoryTags(prompt);`

No logic changes. No reordering. Same arguments.

### (b) Documentation references

- `05-clean-flowcharts.md:127-156` (section 3.2)
- `06-implementation-plan.md:31` (V4 verified call-site inventory — "No call sites in summary, legacy observation, or summarize hook")
- `06-implementation-plan.md:88-90` (Phase 1 task 2 prescription)
- Live file: `src/services/worker/http/routes/SessionRoutes.ts:11, :629, :633, :862`

### (c) Verification checklist

```bash
# Old names gone from the only consumer
grep -n "stripMemoryTagsFromJson\|stripMemoryTagsFromPrompt" src/services/worker/http/routes/SessionRoutes.ts
# Expected: 0 matches

# New name present exactly three times in SessionRoutes (629, 633, 862) plus one import
grep -c "stripMemoryTags(" src/services/worker/http/routes/SessionRoutes.ts
# Expected: 3 (call sites; the import statement uses `stripMemoryTags` without trailing `(`)

grep -n "import .*stripMemoryTags" src/services/worker/http/routes/SessionRoutes.ts
# Expected: 1 match on line 11

# Compiles
npx tsc --noEmit
# Expected: exit 0 (SessionRoutes now uses the new API; summary + legacy obs paths still untouched — will pass)
```

No runtime tests yet — Phase 3 adds the new strip calls that unlock the regression test.

### (d) Anti-pattern guards

- **A (invent APIs)**: do not introduce `stripMemoryTagsAt(callerType, text)`; the single function is enough.
- **E (two code paths)**: after this phase all live strip call sites funnel through one function. Do not leave a "fast path" for prompts and a "JSON path" for observations.

---

## Phase 3 — ADD `stripMemoryTags` calls at summary-path and legacy-observation entry points (closes P1 per V1)

### (a) What to implement

Edit `src/services/worker/http/routes/SessionRoutes.ts` in three additional places. Each change **adds** a strip call before the existing queue call.

1. **`handleObservations` — line 464 handler** (V2 correction of audit's "line 378"):
   - Before line 470 (`this.sessionManager.queueObservation(sessionDbId, {...})`), copy the pattern from `:628-634`:
     ```ts
     const cleanedToolInput = tool_input !== undefined
       ? stripMemoryTags(JSON.stringify(tool_input))
       : '{}';
     const cleanedToolResponse = tool_response !== undefined
       ? stripMemoryTags(JSON.stringify(tool_response))
       : '{}';
     ```
   - Pass `cleanedToolInput` / `cleanedToolResponse` into `queueObservation` instead of `tool_input` / `tool_response`.

2. **`handleSummarize` — line 491 handler** (V1 security gap; audit had only described missing `<system-reminder>` but V1 confirms ZERO tags are stripped):
   - Before line 497 (`this.sessionManager.queueSummarize(sessionDbId, last_assistant_message);`), insert:
     ```ts
     const cleanedAssistantMessage = typeof last_assistant_message === 'string'
       ? stripMemoryTags(last_assistant_message)
       : '';
     ```
   - Pass `cleanedAssistantMessage` into `queueSummarize`.

3. **`handleSummarizeByClaudeId` — line 669 handler** (same V1 gap, `/api/sessions/summarize` endpoint):
   - Before line 705 (`this.sessionManager.queueSummarize(sessionDbId, last_assistant_message);`), insert the same cleaning block as #2.
   - Pass `cleanedAssistantMessage` into `queueSummarize`.

No new wrappers, no new helper module. Inline call site.

### (b) Documentation references

- `05-clean-flowcharts.md:20` (audit item #2 — SECURITY BUG label)
- `05-clean-flowcharts.md:127-156` (section 3.2 — the `C3: ingestSummary` call site is the design that lands properly once the downstream ingest helper plan uses it; this plan inlines the strip at the route boundary in the interim)
- `05-clean-flowcharts.md:542` (Part 5 ledger row "Summary-path privacy gap fix: +3")
- `06-implementation-plan.md:28` (V1 — "Summary paths strip ZERO tags")
- `06-implementation-plan.md:29` (V2 — `handleObservations` is at line 464)
- `06-implementation-plan.md:91-93` (Phase 1 task 2 sub-bullets)
- Live file: `src/services/worker/http/routes/SessionRoutes.ts:464-485, :491-506, :669-710`

### (c) Verification checklist

```bash
# Every strip call site accounted for
grep -cn "stripMemoryTags(" src/services/worker/http/routes/SessionRoutes.ts
# Expected: 6 (two new observation lines, two new summary lines, two preserved from Phase 2)
# Breakdown:
#   :464-handler — 2 (input + response)     NEW
#   :491-handler — 1 (assistant message)    NEW
#   :565-handler — 2 (input + response)     PHASE-2 RENAME
#   :669-handler — 1 (assistant message)    NEW
#   :862-handler — 1 (prompt)               PHASE-2 RENAME
# Total: 7 call sites -> NOTE: grep counts lines; if a call wraps onto its own line count is 7. Use -c with care.

grep -n "queueSummarize(sessionDbId, last_assistant_message)" src/services/worker/http/routes/SessionRoutes.ts
# Expected: 0 — both sites should now pass cleanedAssistantMessage

grep -n "queueObservation(sessionDbId, {" src/services/worker/http/routes/SessionRoutes.ts
# Expected: 2 call sites, both using cleanedToolInput / cleanedToolResponse

# Regression test: insert <private>secret</private> into a summary
#  - Start worker locally: npm run build-and-sync
#  - POST /sessions/:id/summarize with body {"last_assistant_message":"ok <private>secret</private> done"}
#  - SELECT last_assistant_message FROM session_summaries WHERE session_id = :id
#  - Expected: "ok  done" (trimmed, no "secret", no "<private>")
#  - Repeat with POST /api/sessions/summarize and contentSessionId
#  - Expected: same result

# Regression test: <persisted-output> in tool_response routed through /sessions/:id/observations
#  - POST /sessions/:id/observations with body containing tool_response: "a <persisted-output>blob</persisted-output> b"
#  - SELECT tool_response FROM observations WHERE session_id = :id
#  - Expected: serialized JSON with "a  b", no <persisted-output>, no "blob"

npx tsc --noEmit
# Expected: exit 0
```

### (d) Anti-pattern guards

- **A (invent APIs)**: do not add a `cleanMessageForSummary` or `sanitizeObservation` helper — a two-line inline strip is simpler than any new abstraction. A unified `ingestSummary` / `ingestObservation` helper IS planned, but in the downstream plan `07-session-lifecycle-management.md`, not here. This plan deliberately inlines to land the security fix fast (Part 6 step 2 — "3 lines to close P1, <1 hr").
- **C (silent fallbacks)**: if `last_assistant_message` is not a string, the strip returns `''`. `queueSummarize` then stores an empty summary. That is the explicit behaviour — do not silently coerce a non-string to `JSON.stringify(...)`.
- **E (two code paths for same data)**: `handleObservations` (line 464) and `handleObservationsByClaudeId` (line 565) still have mostly-duplicate bodies after this phase. The downstream `07-session-lifecycle-management.md` plan merges them via `ingestObservation`. Do NOT attempt that merge here — it is out of scope. This phase only adds the missing strip call into the legacy handler; the merge is the next plan's job.

---

## Phase 4 — Delete obsolete wrappers, tests, and dead exports

### (a) What to implement

1. **`src/utils/tag-stripping.ts`** already rewritten in Phase 1 — confirm the file no longer contains `stripMemoryTagsFromPrompt`, `stripMemoryTagsFromJson`, or `stripTagsInternal`.

2. **`tests/utils/tag-stripping.test.ts`** — rewrite to import the new API. Delete any `describe('stripMemoryTagsFromPrompt')` and `describe('stripMemoryTagsFromJson')` blocks; merge their cases into a single `describe('stripMemoryTags')` block. Keep every input assertion — the behaviour must be identical to today for all supported tags.
   - Specifically: the test file at `tests/utils/tag-stripping.test.ts:13` imports `{ stripMemoryTagsFromPrompt, stripMemoryTagsFromJson }`. Change to `{ stripMemoryTags }`. Substitute every `stripMemoryTagsFromPrompt(` and `stripMemoryTagsFromJson(` with `stripMemoryTags(`.

3. **grep for any other importer** in `src/`:
   - Expected (by V4): only `SessionRoutes.ts` and the test file import the old names. After Phase 2 + Phase 4 edits, no importer remains.

### (b) Documentation references

- `05-clean-flowcharts.md:149-150` (3.2 deletion list: the two wrapper files)
- `05-clean-flowcharts.md:541` (Part 5 ledger: -60/+15 = -45 net line delta)
- `06-implementation-plan.md:94` (Phase 1 task 3 — update tests)
- Live file: `tests/utils/tag-stripping.test.ts:13`, `:33-413`

### (c) Verification checklist

```bash
# No consumer of old names anywhere in tree
grep -rn "stripMemoryTagsFromPrompt\|stripMemoryTagsFromJson\|stripTagsInternal" src/ tests/
# Expected: 0 matches

# Test file compiles and uses the new API
grep -c "stripMemoryTags(" tests/utils/tag-stripping.test.ts
# Expected: >= number of old-wrapper call sites (current file has ~40 calls across the two wrappers; new file should have >= that count)

# Run the test suite
bun test tests/utils/tag-stripping.test.ts
# Expected: all tests green

# Full project typecheck
npx tsc --noEmit
# Expected: exit 0
```

### (d) Anti-pattern guards

- **D (facades that pass through)**: do not add `export const stripMemoryTagsFromPrompt = stripMemoryTags` for "backward compatibility". Callers are entirely internal; change them.
- **E (two code paths)**: the test file should have ONE describe block, not two. Do not leave parallel test suites.

---

## Phase 5 — Final verification (counts + regression + benchmark)

### (a) What to implement

This is a verification-only phase. No new code. Run the following checks and record results in the PR description.

1. **Grep census** (expected counts anchor the acceptance criteria):

   | Command | Expected |
   |---|---|
   | `grep -rn "stripMemoryTagsFromPrompt\|stripMemoryTagsFromJson\|stripTagsInternal" src/ tests/` | `0` matches |
   | `grep -rn "stripMemoryTags\b" src/ tests/` | exactly 1 declaration (`src/utils/tag-stripping.ts`) + 1 test import + 6 SessionRoutes.ts call lines + however many test-body call sites exist |
   | `grep -c "stripMemoryTags(" src/services/worker/http/routes/SessionRoutes.ts` | `6` (3 rename sites + 3 added sites, counting each tool_input/tool_response separately per handler + the 2 summary handlers + 1 prompt handler = 6) |
   | `grep -rn "queueSummarize(sessionDbId, last_assistant_message\b" src/` | `0` (both sites now pass `cleanedAssistantMessage`) |
   | `grep -rn "SYSTEM_REMINDER_REGEX" src/` | `>= 3` (export in `tag-stripping.ts`, imports in `transcript-parser.ts:84` and `:128`) |

2. **End-to-end regression: `<private>` in summary path**
   - Insert `<private>SHOULD_NOT_APPEAR</private>` into an assistant message via the transcript used by the summarize hook.
   - Trigger `Stop` hook. Wait for `/api/sessions/summarize` blocking response.
   - `SELECT last_assistant_message FROM session_summaries ORDER BY id DESC LIMIT 1;`
   - Expected: no occurrence of `SHOULD_NOT_APPEAR` and no `<private>`.

3. **End-to-end regression: `<persisted-output>` in tool_response**
   - POST a sample observation via hook path with a `tool_response` containing `<persisted-output>LARGE</persisted-output>`.
   - `SELECT tool_response FROM observations ORDER BY id DESC LIMIT 1;`
   - Expected: `LARGE` absent, `<persisted-output>` absent.

4. **Micro-benchmark** (informational, not blocking):
   - New single-regex alternation should be no worse than the old six-sequential `.replace()` on a 1 MB input with 50 tags. Record ms/op.
   - If the new version is >2× slower, escalate — but the audit claim is that one regex is faster.

5. **Build sanity**: `npm run build-and-sync` succeeds; worker restarts cleanly.

### (b) Documentation references

- `05-clean-flowcharts.md:155` (3.2 closes: "P1 security gap (private content reaching `session_summaries`)")
- `05-clean-flowcharts.md:538-558` (Part 5 — deletion totals for this row: -45 lines wrappers + -3 lines partial strip + +3 lines new summary-path strip)
- `06-implementation-plan.md:96-101` (Phase 1 verification checklist template)

### (c) Verification checklist

Already enumerated in (a).

### (d) Anti-pattern guards

- **A**: do not add a wrapper "for the benchmark" — measure by timing `stripMemoryTags` directly.
- **C**: if the regression test finds stripped content leaking to the DB, the fix is to call `stripMemoryTags` — not to add a post-strip "second pass" to the consumer. The ingress is the only place to strip.

---

## Line-count summary (this plan only)

Referencing Part 5 of `05-clean-flowcharts.md`:

| Change | Lines deleted | Lines added | Source row |
|---|---|---|---|
| Wrappers + six regex passes collapse to one | -60 | +15 | 05 Part 5 row "stripMemoryTagsFromPrompt / FromJson wrappers" |
| Summary-path privacy gap fix (V1) | 0 | +3 | 05 Part 5 row "Summary-path privacy gap fix" |
| Legacy-observation privacy gap fix (V2, not in 05 ledger) | 0 | +6 | V2 correction (two strip calls in `handleObservations`) |
| Test file rewrites | ~-5 | ~+5 | Phase 4 |
| **Net** | **≈ -60** | **≈ +29** | **≈ -31 net** |

Net code delta is small; the load-bearing outcome is **closing P1** (private content no longer reaches `session_summaries` or the legacy observation path).
