# 03 — Ingestion Path

## Purpose

Cure the ingestion layer's second-system accretion by making the parser fail-fast, collapsing the worker-internal HTTP loopback into direct function calls, replacing the 5-second rescan `setInterval` with a recursive `fs.watch`, and delegating tool-use / tool-result pairing to the database via `UNIQUE(session_id, tool_use_id)` instead of a per-process in-memory Map. The cure is ten moves: expose `ingestObservation` / `ingestPrompt` / `ingestSummary` as direct worker functions (prerequisite for plans `05-hook-surface.md` + `06-api-surface.md`); replace `parseObservations` + `parseSummary` + `coerceObservationToSummary` with a single `parseAgentXml` returning a discriminated union; migrate `ResponseProcessor` to the new parser and emit `summaryStoredEvent` for the blocking endpoint; delete the circuit breaker; delete `coerceObservationToSummary`; swap rescan for recursive `fs.watch`; delete the `pendingTools` Map and pair via DB JOIN; call the ingest helper directly (no HTTP loopback); consolidate tag stripping to one regex; delete the dead `TranscriptParser` class — in the same PR that they stop being referenced.

---

## Principles invoked

This plan is measured against `00-principles.md`:

1. **Principle 1 — No recovery code for fixable failures.** `coerceObservationToSummary` exists only to recover from LLM contract violations on the summary path. Fix the contract (fail-fast to `markFailed`), delete the coercion helper.
2. **Principle 2 — Fail-fast over grace-degrade.** `parseAgentXml` returns `{ valid: false, reason }` on malformed input; callers mark the message failed and surface the reason. No circuit breaker, no coercion, no silent passthrough.
3. **Principle 3 — UNIQUE constraint over dedup window.** Tool-use / tool-result pairing is enforced by `UNIQUE(session_id, tool_use_id)` on `pending_messages` (defined in `01-data-integrity.md` Phase 1), not by a per-process `pendingTools` Map that disappears on worker restart.
4. **Principle 4 — Event-driven over polling.** `fs.watch(dir, { recursive: true })` replaces the 5-second rescan `setInterval` at `src/services/transcripts/watcher.ts:124-132`.
6. **Principle 6 — One helper, N callers.** One `parseAgentXml` for observation + summary XML. One `ingestObservation` for every worker-internal caller (no HTTP loopback). One tag-stripping regex with alternation.
7. **Principle 7 — Delete code in the same PR it becomes unused.** Circuit-breaker fields, `coerceObservationToSummary`, the `pendingTools` Map, and the `TranscriptParser` class all delete in the same PR that their last caller is rewritten.

**Cross-references**:

- `01-data-integrity.md` Phase 1 defines the `UNIQUE(session_id, tool_use_id)` constraint on `pending_messages` that Phase 6 of this plan depends on. Phase 6 is blocked until `01-data-integrity.md` Phase 1 + Phase 2 (fresh schema + ALTER migration) land.
- `05-hook-surface.md` consumes the `summaryStoredEvent` emitted by Phase 2 of this plan as the signal that unblocks the blocking `/api/session/end` endpoint. Phase 2's event name and payload shape is the contract; `05-hook-surface.md` Phase 3 references it.
- `02-process-lifecycle.md` is orthogonal to ingestion — the helpers defined in Phase 0 run inside the worker process regardless of how it was spawned — but Phase 0's prohibition on HTTP loopback is a pre-condition for `02-process-lifecycle.md`'s process-group teardown to leave no in-flight loopback requests stranded.

---

## Phase 0 — Ingest helpers (prerequisite for plans 05, 06, 07)

**Purpose**: Expose `ingestObservation(payload)`, `ingestPrompt(payload)`, and `ingestSummary(payload)` as direct functions on the worker. Every worker-internal caller (the transcript processor, the ResponseProcessor, any future in-process producer) invokes the function directly. No `http://localhost:37777` loopback for worker→worker calls. Hooks (cross-process) still use HTTP; this phase exists to kill the loopback inside the single worker process.

**Files**:
- New: `src/services/worker/http/shared.ts` — exports `ingestObservation`, `ingestPrompt`, `ingestSummary` (plus the HTTP route handlers that delegate to the same three functions, so plans `05-hook-surface.md` and `06-api-surface.md` can share them).
- `_reference.md` Part 3 row "HTTP loopback replacement" documents this file as the canonical landing spot.

**Contract**:

```ts
// src/services/worker/http/shared.ts
export function ingestObservation(payload: ObservationPayload): IngestResult;
export function ingestPrompt(payload: PromptPayload): IngestResult;
export function ingestSummary(payload: SummaryPayload): IngestResult;

// IngestResult is either the inserted row's id, or a discriminated-union error the caller surfaces.
```

**Callers after this plan lands**:
- `src/services/transcripts/processor.ts:252` — calls `ingestObservation(payload)` directly (Phase 7).
- `src/services/worker/agents/ResponseProcessor.ts` — calls `ingestSummary(payload)` and emits `summaryStoredEvent` (Phase 2).
- Hook handlers (`src/cli/handlers/observation.ts`, `src/cli/handlers/session-init.ts`, …) call via HTTP; the HTTP route handler in `06-api-surface.md` delegates to the same three functions.

**By principle 6 (one helper, N callers)**: a single implementation backs both the in-process caller and the cross-process HTTP route. No duplicated insert logic.

**Citation**: `_reference.md` Part 1 §Ingestion `src/services/transcripts/processor.ts:252` (current HTTP loopback call site); `_reference.md` Part 3 row "HTTP loopback replacement" (target file location).

**Plans that depend on Phase 0**:
- `05-hook-surface.md` Phase 3 consumes `summaryStoredEvent` emitted by `ingestSummary` callers.
- `06-api-surface.md` Phase 2's `validateBody` Zod middleware delegates to these helpers after validation passes.

---

## Phase 1 — `parseAgentXml` discriminated union

**Purpose**: Replace `parseObservations`, `parseSummary`, and `coerceObservationToSummary` with a single entry point that inspects the root element and returns a discriminated union. By principle 2 (fail-fast), the function never coerces and never returns `undefined`; it either parses a valid payload or names the reason it failed. The caller is responsible for deciding whether a malformed payload is a retry or a `markFailed`.

**Files**:
- `src/sdk/parser.ts:33-111` — `parseObservations` (inlined into `parseAgentXml`)
- `src/sdk/parser.ts:122-259` — `parseSummary` + `coerceObservationToSummary` (former inlined, latter deleted entirely in Phase 4)

**Signature**:

```ts
type ParseResult =
  | { valid: true; kind: 'observation' | 'summary'; data: ParsedObservation | ParsedSummary }
  | { valid: false; reason: string };
function parseAgentXml(raw: string): ParseResult;
```

**Semantics**:
- Inspect the root element: `<observation>` → parse observation, return `{ valid: true, kind: 'observation', data }`. `<summary>` → parse summary, return `{ valid: true, kind: 'summary', data }`. Anything else, or well-formed XML with missing required children → `{ valid: false, reason: '<root element>: <missing field or malformed child>' }`.
- `reason` is a short human-readable string suitable for inclusion in `pending_messages.failed_reason` (column exists; surfaces in the viewer).
- The `<skip_summary reason="…"/>` bypass (documented in `_reference.md` Part 3) is parsed as a valid summary with a `skipped: true` flag on `ParsedSummary` — it is not a coercion, it is a first-class case in the schema.

**Citation**: `_reference.md` Part 1 §Ingestion `src/sdk/parser.ts:33-111` (current `parseObservations`) and `src/sdk/parser.ts:122-259` (current `parseSummary` + `coerceObservationToSummary` target). `_reference.md` Part 3 row "Summary XML" and "Observation XML" fix the element shapes.

---

## Phase 2 — ResponseProcessor migration + `summaryStoredEvent`

**Purpose**: Rewrite the SDK response handler so it calls `parseAgentXml` exactly once, branches on the discriminated union, and on valid summaries emits `summaryStoredEvent` for the blocking endpoint in `05-hook-surface.md` to await. On invalid, it calls `markFailed(messageId, reason)` — no coercion retry, no circuit breaker, no silent passthrough.

**Files**:
- `src/services/worker/agents/ResponseProcessor.ts:96-200` — replace body of the parse-and-dispatch section.
- `src/services/sqlite/PendingMessageStore.ts:349-374` — `markFailed` is unchanged; its retry ladder (`retry_count < maxRetries`) is the legitimate primary-path surface for transient failures.

**Before** (conceptual):
```ts
// src/services/worker/agents/ResponseProcessor.ts:96-200 (current)
const obs = parseObservations(raw);
if (obs) return storeObservations(obs);
const summary = parseSummary(raw) ?? coerceObservationToSummary(obs);  // silent coerce
if (this.consecutiveSummaryFailures > MAX_CONSECUTIVE_SUMMARY_FAILURES) { … } // circuit breaker
```

**After**:
```ts
// src/services/worker/agents/ResponseProcessor.ts:96-200 (after this phase)
const result = parseAgentXml(raw);
if (!result.valid) {
  await pendingStore.markFailed(messageId, result.reason);
  return;
}
if (result.kind === 'observation') {
  ingestObservation(result.data);                                  // Phase 0 helper
  return;
}
// kind === 'summary'
ingestSummary(result.data);                                        // Phase 0 helper
eventBus.emit('summaryStoredEvent', { sessionId, messageId });     // consumed by 05-hook-surface.md Phase 3
```

**Event contract** (stable surface for `05-hook-surface.md`):

```ts
type SummaryStoredEvent = { sessionId: string; messageId: number };
// emitted once per successful ingestSummary call; blocking /api/session/end awaits this
```

**By principle 1 (no recovery code for fixable failures)**: the coercion-then-circuit-breaker pattern existed to recover from a broken primary path (the LLM occasionally returned `<observation>` when asked for `<summary>`). The cure is to mark the message failed, surface the reason, and let the retry ladder in `markFailed` do its job. No coerce.

**Citation**: `_reference.md` Part 1 §Ingestion `src/services/worker/agents/ResponseProcessor.ts:96-200` (current parse-and-dispatch block); `01-data-integrity.md` for `markFailed` retry ladder context.

---

## Phase 3 — Delete circuit breaker

**Purpose**: `consecutiveSummaryFailures` + `MAX_CONSECUTIVE_SUMMARY_FAILURES` is a second-system effect — a counter that trips after N bad parses and stops attempting to parse. By principle 2 (fail-fast), each malformed payload is independently marked failed; a storm of bad parses is a signal to surface (via the retry ladder hitting `maxRetries`), not a signal to silently stop trying.

**Files**:
- `src/services/worker/agents/ResponseProcessor.ts:96-200` — delete `consecutiveSummaryFailures` field, `MAX_CONSECUTIVE_SUMMARY_FAILURES` constant, and every `if (this.consecutiveSummaryFailures > …)` guard.
- `src/services/worker/SessionManager.ts` — delete any SessionManager-side guards that read the same counter.

**Delete in the same PR**:
- Field: `consecutiveSummaryFailures`
- Constant: `MAX_CONSECUTIVE_SUMMARY_FAILURES`
- Every guard that reads them
- Any log line of the form "circuit breaker tripped"

**Citation**: `_reference.md` Part 1 §Ingestion `src/services/worker/agents/ResponseProcessor.ts:96-200` (circuit-breaker lives in this block).

---

## Phase 4 — Delete `coerceObservationToSummary`

**Purpose**: Remove the coercion helper that maps `<observation>` fields into a `<summary>` shape when the LLM violates the summary contract. By principle 1 (no recovery code for fixable failures), the contract violation is surfaced to the caller via `parseAgentXml`'s `{ valid: false, reason }` branch; there is no coercion path.

**Files**:
- `src/sdk/parser.ts:222-259` — delete `coerceObservationToSummary` function entirely.
- Every caller — after Phase 2 migration, the only caller was `ResponseProcessor.ts`; its rewrite removes the call.

**Delete in the same PR**:
- The function body at `src/sdk/parser.ts:222-259`
- Any import of `coerceObservationToSummary` across the codebase
- Any unit test that asserted coercion behavior (these now assert the `{ valid: false, reason }` branch instead)

**By principle 7 (delete code in the same PR)**: no `@deprecated` fence, no "remove next release." The function deletes in the PR that rewrites `ResponseProcessor`.

**Citation**: `_reference.md` Part 1 §Ingestion `src/sdk/parser.ts:222-259` (the target function).

---

## Phase 5 — Recursive `fs.watch`

**Purpose**: Replace the 5-second `setInterval` rescan in `src/services/transcripts/watcher.ts:124-132` with a single `fs.watch(transcriptsRoot, { recursive: true })`. By principle 4 (event-driven over polling), the OS notifies us when a transcript file is created or modified; we do not walk the directory every 5 seconds.

**Files**:
- `src/services/transcripts/watcher.ts:124-132` — replace rescan `setInterval` with `fs.watch`.
- `package.json` — bump `engines.node` to `>=20.0.0`. This is the preflight gate; the phase does not land until the engines bump ships.

**Preflight**: `engines.node >= 20.0.0`. Recursive mode on Linux was experimental before Node 20; it became stable in Node 20 across all major platforms (Linux, macOS, Windows). See `_reference.md` Part 2 row "`fs.watch(dir, { recursive: true })` on Linux" citing the Node 20 release notes.

**Signature + gotcha callout**:

```ts
import { watch } from 'node:fs';
const w = watch(transcriptsRoot, { recursive: true, persistent: true }, (event, name) => { … });
```

**Gotcha**: Recursive mode on Linux was experimental before Node 20 and unsupported before Node 18; shipping this phase on a Node 18 install would silently fall back to non-recursive mode on Linux and miss every subdirectory. The `engines.node >= 20.0.0` bump in `package.json` is the load-bearing gate — the plan does not ship without it. Cite: `_reference.md` Part 2 row `fs.watch` (Node 20 release-notes anchor) and Part 4 row 3 ("Node 20+ requirement").

**Before**:
```ts
// src/services/transcripts/watcher.ts:124-132 (current)
this.rescanInterval = setInterval(() => this.rescanTranscripts(), 5_000);
```

**After**:
```ts
// src/services/transcripts/watcher.ts:124-132 (after this phase)
import { watch } from 'node:fs';
this.watcher = watch(transcriptsRoot, { recursive: true, persistent: true }, (event, name) => {
  if (!name) return;                                    // some events omit filename
  void this.onTranscriptEvent(event, resolve(transcriptsRoot, name));
});
```

**Delete in the same PR**:
- `rescanInterval` field
- Every `setInterval` in `src/services/transcripts/watcher.ts`
- The 5-second `rescanTranscripts` method body if no other caller remains

**Citation**: `_reference.md` Part 1 §Ingestion `src/services/transcripts/watcher.ts:124-132` (rescan target); Part 2 row `fs.watch` recursive (Node 20+); Part 4 row 3 (engines.node bump preflight).

---

## Phase 6 — DB-backed tool pairing

**Purpose**: Delete the per-process `pendingTools` Map at `src/services/transcripts/processor.ts:23`. Insert both `tool_use` and `tool_result` rows into `pending_messages` with the `UNIQUE(session_id, tool_use_id)` constraint (defined in `01-data-integrity.md` Phase 1 on the `pending_messages` table and enforced by the UNIQUE INDEX added in `01-data-integrity.md` Phase 2). Pair `tool_use` with its `tool_result` by JOIN at read time — the database is the authority on what is paired, not an in-memory Map that empties on worker restart.

**Files**:
- `src/services/transcripts/processor.ts:23` — delete `pendingTools: Map<string, ToolInput>`.
- `src/services/transcripts/processor.ts:202, :232-236` — delete the dispatcher's Map-based pairing; both `tool_use` and `tool_result` go through `pending_messages` insert.
- `src/services/sqlite/PendingMessageStore.ts` — the insert path uses `INSERT … ON CONFLICT(session_id, tool_use_id) DO NOTHING` to make ingestion idempotent against replayed transcript lines.

**Pairing query** (read-time JOIN):

```sql
-- pair tool_use with its tool_result by session_id + tool_use_id
SELECT u.payload AS tool_use_payload,
       r.payload AS tool_result_payload
  FROM pending_messages u
  JOIN pending_messages r USING (session_id, tool_use_id)
 WHERE u.kind = 'tool_use'
   AND r.kind = 'tool_result'
   AND u.session_id = ?;
```

**By principle 3 (UNIQUE constraint over dedup window)**: the database prevents duplicate pairings. There is no timer gate, no Map survival question, no "what if the worker restarted mid-pair" failure mode.

**Cross-reference**: `01-data-integrity.md` Phase 1 defines the `UNIQUE(session_id, tool_use_id)` constraint inline in the fresh `schema.sql`. `01-data-integrity.md` Phase 2 adds the equivalent UNIQUE INDEX via ALTER migration for already-installed databases, with a pre-index dedup pass. Phase 6 of this plan is blocked until both land.

**Delete in the same PR**:
- `pendingTools` Map field at `processor.ts:23`
- Every `pendingTools.set` / `pendingTools.get` / `pendingTools.delete` call
- The dispatcher pairing block at `processor.ts:202` and `:232-236`

**Citation**: `_reference.md` Part 1 §Ingestion `src/services/transcripts/processor.ts:23, 202, 232-236`; `01-data-integrity.md` Phase 1 (schema) + Phase 2 (migration) for the UNIQUE constraint.

---

## Phase 7 — Direct `ingestObservation` call (no HTTP loopback)

**Purpose**: Replace the HTTP loopback at `src/services/transcripts/processor.ts:252` with a direct call to `ingestObservation(payload)` (the helper from Phase 0). The transcript processor runs inside the worker; calling the worker's own HTTP endpoint from inside the worker is second-system round-tripping. One function call, no network stack, no JSON round-trip.

**Files**:
- `src/services/transcripts/processor.ts:252` — replace `observationHandler.execute()` + `workerHttpRequest` round-trip with `ingestObservation(payload)`.
- `src/services/transcripts/processor.ts:275-285` — `maybeParseJson` silent passthrough is rewritten to fail-fast (by principle 2): if the JSON is malformed, throw; do not ingest the raw string.

**Before** (conceptual):
```ts
// src/services/transcripts/processor.ts:252 (current)
await observationHandler.execute(payload);
// … which internally does workerHttpRequest(POST, 'http://localhost:37777/api/observations', payload)
```

**After**:
```ts
// src/services/transcripts/processor.ts:252 (after this phase)
const result = ingestObservation(payload);                     // Phase 0 helper, same process
if (!result.ok) throw new Error(`ingest failed: ${result.reason}`);
```

**Delete in the same PR**:
- Every `observationHandler.execute()` call site inside `src/services/transcripts/`
- Any import of `workerHttpRequest` in `src/services/transcripts/`
- The `maybeParseJson` silent-passthrough branch at `processor.ts:275-285` (replace with fail-fast parse)

**By principle 6 (one helper, N callers)**: the single `ingestObservation` helper from Phase 0 is called by the processor (in-process) AND by the HTTP route handler in `06-api-surface.md` (cross-process). The route handler is a thin adapter; the business logic is in the helper.

**Citation**: `_reference.md` Part 1 §Ingestion `src/services/transcripts/processor.ts:252` (current HTTP loopback call); `:275-285` (silent `maybeParseJson` passthrough). `_reference.md` Part 3 row "HTTP loopback replacement" (target pattern).

---

## Phase 8 — Single-regex tag strip

**Purpose**: Consolidate `src/utils/tag-stripping.ts` `countTags` + `stripTagsInternal` into one regex with alternation. Current implementation makes six `.replace()` / `.match()` calls for six tag types; by principle 6 (one helper, N callers), this is six copies of the same concern.

**Files**:
- `src/utils/tag-stripping.ts:37-44` — `countTags` (six separate `.match()` calls)
- `src/utils/tag-stripping.ts:63-69` — `stripTagsInternal` (six separate `.replace()` calls)

**After**: A single regex with alternation across all six tag names, single-pass over the input.

```ts
// src/utils/tag-stripping.ts (after this phase)
const STRIP_REGEX = /<(private|claude-mem-context|system-reminder|…)\b[^>]*>[\s\S]*?<\/\1>/g;

export function stripTags(input: string): { stripped: string; counts: Record<TagName, number> } {
  const counts: Record<TagName, number> = Object.fromEntries(TAG_NAMES.map(n => [n, 0]));
  const stripped = input.replace(STRIP_REGEX, (_, name) => { counts[name]++; return ''; });
  return { stripped, counts };
}
```

**Delete in the same PR**:
- `countTags` as a separate exported function
- `stripTagsInternal` as a separate exported function
- All six per-tag `.replace()` / `.match()` call sites

**Citation**: `_reference.md` Part 1 §Ingestion `src/utils/tag-stripping.ts:37-44, 63-69` (the two functions being consolidated). Part 3 row "Privacy tags" (the six tag names this regex must cover).

---

## Phase 9 — Delete dead `TranscriptParser` class

**Purpose**: The `TranscriptParser` class at `src/utils/transcript-parser.ts:28-90` has no active importers. The active parser is `extractLastMessage` at `src/shared/transcript-parser.ts:41-144`. By principle 7 (delete code in the same PR it becomes unused), the dead class deletes now — not fenced with `@deprecated`, not "removed next release."

**Files**:
- `src/utils/transcript-parser.ts` — delete the file in its entirety (the `TranscriptParser` class at `:28-90` is the file's only export).

**Pre-deletion check**: `grep -rn "from.*utils/transcript-parser" src/` must return 0 before deletion. If any import exists, it was missed during prior cleanup and must be rewritten to `src/shared/transcript-parser.ts` in the same PR.

**Delete in the same PR**:
- `src/utils/transcript-parser.ts` (entire file)
- Any test file whose sole purpose was exercising `TranscriptParser` (its assertions are covered by tests against `extractLastMessage`)

**Citation**: `_reference.md` Part 1 §Ingestion `src/utils/transcript-parser.ts:28-90` (dead class) and `src/shared/transcript-parser.ts:41-144` (active replacement function).

---

## Parser signature (verbatim contract)

Phase 1 establishes the single entry point for agent-XML parsing. Every caller branches on the discriminated union; nothing else parses agent XML after this plan lands.

```ts
type ParseResult =
  | { valid: true; kind: 'observation' | 'summary'; data: ParsedObservation | ParsedSummary }
  | { valid: false; reason: string };
function parseAgentXml(raw: string): ParseResult;
```

---

## `fs.watch` signature + gotcha callout (verbatim contract)

Phase 5 establishes the single directory-watch surface. The rescan `setInterval` is deleted in the same PR.

```ts
import { watch } from 'node:fs';
const w = watch(transcriptsRoot, { recursive: true, persistent: true }, (event, name) => { … });
```

**Gotcha**: recursive mode on Linux was experimental before Node 20. The plan's preflight is `engines.node >= 20.0.0` in `package.json`; shipping Phase 5 on Node 18 would silently fall back to non-recursive mode on Linux and miss every subdirectory. Cite: `_reference.md` Part 2 row `fs.watch(dir, { recursive: true })` (Node 20 release-notes anchor); Part 4 row 3 (engines.node bump preflight).

---

## Verification grep targets

Each command below must return the indicated count (or the indicated condition) after this plan lands.

```
grep -n coerceObservationToSummary src/                              → 0
grep -n consecutiveSummaryFailures src/                              → 0
grep -n "pendingTools" src/services/transcripts/                     → 0
grep -n "setInterval" src/services/transcripts/watcher.ts            → 0
grep -n "observationHandler.execute" src/services/transcripts/       → 0
test ! -e src/utils/transcript-parser.ts                             → exit 0 (file deleted)
jq '.engines.node' package.json                                      → ">=20.0.0" (or stricter)
```

**Fuzz test 1** (orphan `tool_use`): Drop a JSONL file containing a `tool_use` line with no matching `tool_result`. The `tool_use` row is inserted into `pending_messages`, the pairing JOIN (Phase 6 query) returns zero pairs, no observation is emitted, and no error is logged beyond a debug-level "unpaired tool_use" note. The worker does not crash.

**Fuzz test 2** (phantom `tool_result`): Drop a JSONL file containing a `tool_result` line referencing a `tool_use_id` that does not exist in the same session. The `tool_result` row is inserted into `pending_messages` (the `UNIQUE(session_id, tool_use_id)` constraint allows it; the constraint pairs kinds, not forbids them), the pairing JOIN returns zero pairs, a debug-level "phantom tool_result" log line is emitted, no observation is produced, and the worker does not crash.

**Nine verification targets total**: seven greps (above) + two fuzz tests.

---

## Anti-pattern guards

Reproduced verbatim from the rewrite plan:

- Do NOT keep coercion as a "lenient mode" flag.
- Do NOT ship a polling fallback for `fs.watch` — Node 20+ handles recursive Linux natively.
- Do NOT preserve the in-memory Map behind a feature flag.

Additional hard rules enforced by this plan:

- No new `coerce*`, `heal*`, `recover*`, `repair*` function name appears in `src/` after this plan lands, except inside a DELETE directive.
- No new `setInterval` is introduced in `src/services/transcripts/`.
- No new HTTP round-trip from the worker to its own `localhost:37777` endpoint is introduced; worker-internal producers use Phase 0 helpers directly.

---

## Known gaps / deferrals

1. **Preflight sequencing.** Phase 5 (`fs.watch` recursive) cannot land before the `engines.node >= 20.0.0` bump ships in `package.json`. Plan `98-execution-order.md` will sequence this as a preflight gate. Until then, Phase 5 is blocked.
2. **Schema dependency.** Phase 6 (DB-backed pairing) cannot land before `01-data-integrity.md` Phase 1 (fresh `schema.sql` with `UNIQUE(session_id, tool_use_id)`) and Phase 2 (ALTER migration + pre-index dedup) ship. Plan `98-execution-order.md` will sequence this as a DAG edge from `01` Phase 2 → this plan Phase 6.
3. **Event-bus choice.** Phase 2 emits `summaryStoredEvent`; the event-bus implementation (Node `EventEmitter` vs a dedicated `src/services/infrastructure/eventBus.ts`) is left to the implementer. `05-hook-surface.md` Phase 3 specifies the consumer contract but not the emitter mechanism.
