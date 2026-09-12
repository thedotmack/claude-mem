# 03 — Observation Source Metadata + URL Capture

Branch commits: `c2a39635` (initial), `077051e5`, `ea5c0e56` (SSE/pagination wiring fixes).
Scope: data model, capture, query, propagation. Viewer rendering is doc 04.

## 1. What the feature is

A JSON-blob `metadata` column on the `observations` table that records the **source tool call** that produced each observation — most importantly the **URL** when an observation was learned from `WebFetch`. The blob is keyed by tool name and carries tool-specific provenance fields. It is queryable via SQL (computed JSON indexes), filterable via the worker API, and broadcast on the SSE `new_observation` event.

Shape (from `src/services/worker/metadata-extractor.ts:1-13`):

```ts
interface ObservationSourceMetadata {
  tool_name: string;          // always set
  source_url?: string;        // WebFetch.url, or generic .url fallback
  search_query?: string;      // WebSearch.query
  command?: string;           // Bash.command
  file_path?: string;         // Read/Write/Edit/NotebookEdit
  glob_pattern?: string;      // Glob.pattern
  search_pattern?: string;    // Grep.pattern
  search_path?: string;       // Grep.path
  subagent_type?: string;     // Task.subagent_type
  lsp_operation?: string;     // LSP.operation
}
```

## 2. What we want it to do

- **Capture (write).** When `ResponseProcessor` stores observations from an LLM turn, it calls `extractSourceMetadata(tool_name, tool_input)` against the **last claimed pending message** for that turn (`src/services/worker/agents/ResponseProcessor.ts:122-135`). The result is JSON-stringified into `observations.metadata`.
- **Persist.** Migration 27 on the branch adds the `metadata TEXT` column plus two computed JSON indexes (`runner.ts:979-998`):
  - `idx_observations_source_url` on `json_extract(metadata,'$.source_url')` (partial — non-NULL only)
  - `idx_observations_tool_name` on `json_extract(metadata,'$.tool_name')` (partial)
- **Query.** `getObservationsByIds` accepts `source_url` and `tool_name` options and adds `json_extract(metadata,'$.…') = ?` predicates (`src/services/sqlite/observations/get.ts:83-93`). `GetObservationsByIdsOptions` exposes both fields (`types.ts:43-44`).
- **Page.** `PaginationHelper.getObservations` selects `o.metadata` so paginated viewer responses include the blob (`PaginationHelper.ts:102`).
- **Broadcast.** `ObservationSSEPayload.metadata?: string` carries the JSON-stringified blob on the `new_observation` SSE event (`src/services/worker/agents/types.ts:49`, set in `ResponseProcessor.ts:340`).

## 3. What we want it to accomplish

- **Provenance.** Every observation can answer "where did this come from?" — especially "which URL did I read this from?". URL provenance turns the memory store into a citation-aware notebook.
- **Filterable retrieval.** Searches like "everything I learned from `anthropic.com`" or "everything that came from a Bash run" become indexed lookups, not full scans.
- **Cheap to extend.** New tools (`LSP`, future `Browser`, etc.) get a new key without a schema migration. The blob absorbs schema drift; only the indexes need to bump.
- **Foundation for tool-aware UX.** The viewer can render a small icon per observation (link, search, file, command) without inferring source from prose.

## 4. Why we think it will work

- **Capture is parasitic on existing flow.** `tool_name`/`tool_input` already ride on every `pending_messages` row (`PendingMessageStore.ts:16-17` on branch, identical on main `:10-11`) — no new hook code, no new ingest path.
- **JSON1 is built into bun:sqlite.** `json_extract` is fast (computed-column equivalent), and partial indexes keep storage cost ~zero for non-tool-bearing rows.
- **No dedup contamination.** `computeObservationContentHash` excludes metadata (`store.ts:21-30`), so the same fact captured twice (different sources) still dedupes correctly.
- **SSE backward-compat.** `metadata?: string` is optional; existing viewer clients ignore it.

## 5. Simplest possible implementation (greenfield)

If we ignore main's existing schema and the branch's batch-claim plumbing:

1. Add `metadata TEXT` to `observations`. (One ALTER, no indexes — let `json_extract` scan until the table is large.)
2. In whatever function consumes a claimed `pending_messages` row, attach `extractSourceMetadata(msg.tool_name, msg.tool_input)` to the row payload and pass it straight into `storeObservation`.
3. `storeObservation` JSON-stringifies and writes to the column.
4. SELECT it back wherever observations are read (pagination, SSE, MCP).
5. Add a single optional filter param to `getObservationsByIds` for `source_url` only — extend later if needed.

Total: one migration, one extractor file, ~6 line touch in store/get, one line in the SSE payload. **No parallel arrays. No "last message wins" logic.** Just thread metadata as a property on the message that the iterator yields.

## 6. Simple vs. designed

| Aspect | Designed (branch) | Simplest |
|---|---|---|
| Indexes | 2 computed JSON indexes upfront | none (add when needed) |
| Capture point | Reads `session.processingMessageMeta[last]` parallel array | Per-message property carried by the iterator |
| Filters | `source_url` + `tool_name` | `source_url` only |
| Lines added | ~120 across 6 files | ~40 across 4 files |
| Migration count | 1 (#27 on branch — collides with subagent migration, "self-healing" via PRAGMA guard) | 1 |
| Coupling | Requires `processingMessageMeta` parallel array on `Session` | Zero new state |

**Honest verdict:** The simpler approach is genuinely better on top of v12.5.0. Reasons:

- Main's `SessionQueueProcessor` (`src/services/queue/SessionQueueProcessor.ts:21-51`) yields **one message at a time** via async iterator. The branch's parallel-array trick was a workaround for a batched-claim model that **no longer exists on main**. Carrying parallel arrays into the new world is dead complexity.
- The "shares schema_version 27" footgun (`runner.ts:974-977`) goes away if we just pick the next free version.
- Indexes are cheap to add later — the hard part is the column + the populate path. Ship the data, add the indexes when the viewer's "filter by URL" panel actually exists.

The one piece worth keeping verbatim from the designed approach: `metadata-extractor.ts` itself. It's a 64-line pure function with no main-side equivalent and zero conflict surface. Port it as-is.

## 7. How to continue

Re-apply on top of `origin/main` (v12.5.0) as a single coherent change:

**Migration (32, next free).** Don't add a column — main already has `metadata TEXT` (migration 30, `runner.ts:969-980` on main, added by #2116). Only add the two computed indexes if/when filters ship. For the initial cut, **add no migration at all**.

**Files to add:**
- `src/services/worker/metadata-extractor.ts` — copy verbatim from branch.

**Files to extend (single-line or near-it changes):**

1. `src/services/sqlite/observations/types.ts`
   - Add `metadata?: Record<string, unknown>` to `ObservationInput`.
   - Add `source_url?: string` to `GetObservationsByIdsOptions` (skip `tool_name` until needed).

2. `src/services/sqlite/observations/store.ts` (main version)
   - Add `metadata TEXT` to the INSERT column list and one more `?` placeholder.
   - Bind `observation.metadata ? JSON.stringify(observation.metadata) : null`.
   - **Keep main's `ON CONFLICT(memory_session_id, content_hash) DO NOTHING`** — do not regress to the branch's 30 s window logic.
   - The function signature stays additive: `storeObservation(db, memorySessionId, project, observation, promptNumber?, discoveryTokens?, overrideTimestampEpoch?)` — `metadata` lives **on `observation`**, not as a positional param. This is cleaner than the branch's 9-positional-arg sprawl.

3. `src/services/sqlite/observations/get.ts` (main version)
   - Append the `source_url` predicate block (5 lines) after the existing filters.

4. `src/services/worker/agents/ResponseProcessor.ts` (main version)
   - The iterator yields one message at a time; whatever variable holds "the message that triggered this turn", call `extractSourceMetadata(msg.tool_name, msg.tool_input)` and stamp it onto each observation in `labeledObservations` as `obs.metadata = sourceMetadata`.
   - **No parallel array, no `processingMessageMeta` field on `Session`.** This deletes ~10 lines vs. the branch's design.

5. `src/services/worker/agents/types.ts`
   - Add `metadata?: string` to `ObservationSSEPayload`.

6. `src/services/worker/agents/ObservationBroadcaster.ts` — no change (passes payload through).

7. `src/services/worker/PaginationHelper.ts`
   - Add `o.metadata` to the SELECT list in `getObservations`.

**Order of operations:**
1. Drop `metadata-extractor.ts` in.
2. Plumb the per-message metadata into `ResponseProcessor` (one variable).
3. Extend `storeObservation` + `ObservationInput`.
4. Extend `PaginationHelper` SELECT.
5. Extend SSE payload type + populate it where `broadcastObservation` is called (`ResponseProcessor.ts:205` on main).
6. Extend `getObservationsByIds` filter (deferred — only when viewer needs it).

**Skip from the branch:**
- Migration 27 (column already exists on main).
- Computed JSON indexes (defer until filters ship).
- `tool_name` filter param (YAGNI; `source_url` is the headline).
- Branch's `generatedByModel` storeObservation parameter — separate concern, possibly intentionally removed on main.
- `processingMessageMeta` parallel array.

## 8. Overlap / conflict notes vs `origin/main`

| File | Main state | Conflict severity |
|---|---|---|
| `src/services/sqlite/migrations/runner.ts` | Has migration 30 (`addObservationsMetadataColumn`) — bare column, no indexes, no populate path. | **None** — keep main's, skip branch's. |
| `src/services/sqlite/observations/store.ts` | 7-arg `storeObservation`, `ON CONFLICT` dedup, no `metadata`/`generated_by_model` writes. | **High in raw merge, low in redo.** Add `metadata` field on `ObservationInput`, append one column to INSERT. |
| `src/services/sqlite/observations/get.ts` | No `source_url`/`tool_name` filter. | **None** — additive append. |
| `src/services/sqlite/observations/types.ts` | No `source_url`/`tool_name`/`metadata` fields. | **None** — additive. |
| `src/services/worker/PaginationHelper.ts` | No `o.metadata` in SELECT. | **None** — additive. |
| `src/services/worker/agents/ResponseProcessor.ts` | Uses single-message iterator model (post-#2122 worker streamline). No `processingMessageMeta`. | **Medium.** Don't port branch's parallel array; thread per-message metadata through the iterator. |
| `src/services/worker/agents/types.ts` | No `metadata` on `ObservationSSEPayload`. | **None** — additive optional field. |
| `src/services/worker/SessionManager.ts` | Lacks `processingMessageIds`/`processingMessageMeta`. Main is 422 lines vs. branch's heavier file. | **N/A** — don't port that state at all. |
| `src/services/worker/metadata-extractor.ts` | Does not exist on main. | **None** — pure new file. |
| `src/hooks/*` | Already forwards `tool_name`/`tool_input` (unchanged either side). | **None.** |

Net: 1 new file, 6 small additive edits, zero migrations. The "ship it" cut should land in under 100 LOC of diff.

---

## 100-word summary

Observation source metadata stores `{tool_name, source_url?, …}` as JSON on each observation, captured from the tool call that triggered the LLM turn. Branch implementation uses a parallel-array `processingMessageMeta` on `Session`, a 9-arg `storeObservation`, and migration 27 with two JSON indexes. Main already has the bare `metadata TEXT` column (migration 30, #2116) but never populates it. Re-apply by porting `metadata-extractor.ts` verbatim, threading per-message metadata through main's single-message iterator (drop the parallel array), and adding `metadata` as an `ObservationInput` field. Skip the indexes until filters ship. ~100 LOC, no new migration.
