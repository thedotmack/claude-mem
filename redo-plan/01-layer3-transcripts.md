# Layer 3 Transcript Storage — Re-Apply Analysis

> Branch source: `thedotmack/merged-layer3-metadata`, primarily commit `17984f37`.
> Target base: `origin/main` at v12.5.0.

---

## 1. What the feature is

A **third storage tier** for the memory pipeline. The first two tiers (search index → observation row) already exist and answer "what mattered." Layer 3 stores the **raw conversation text** that produced each observation, in a **separate Chroma collection** (`cm__claude-mem-transcripts`), reachable only by traversal from a known observation ID.

Concretely:

- A second `ChromaSync` instance lives next to the main one (`DatabaseManager.transcriptChromaSync`, `src/services/worker/DatabaseManager.ts:23`).
- The transcript watcher accumulates `user_message` / `assistant_message` exchanges per session and flushes them to that collection on every prompt boundary (`session_init`) and on `session_end`. See `flushTranscriptSegment()` at `src/services/transcripts/processor.ts:369–412`.
- `ChromaSync.addTranscriptChunks()` writes 2000-char chunks keyed by `transcript_<sessionId>_p<promptNumber>_c<chunkIndex>` (`src/services/sync/ChromaSync.ts:909–930`).
- An MCP tool `get_transcript_segment(observation_id, query?)` (`src/servers/mcp-server.ts:357–376`) calls `POST /api/transcript/segment`, which resolves the observation → `content_session_id` → fetches the chunks (`SessionRoutes.ts:995–1040`).
- Without `query`: full segment dump (`getTranscriptSegment`, sorted by chunk_index).
- With `query`: scoped vector search **inside that one segment only** (`queryTranscriptSegment`, n_results=3).

Privacy: `stripTranscriptPrivacyTags()` runs before chunking (`src/utils/tag-stripping.ts:97`), reusing the same `<private>` / `<claude-mem-context>` regexes used elsewhere.

## 2. What we want it to do

- On every prompt boundary, capture the user/assistant exchanges that just happened, sanitize them, chunk them, embed them into a dedicated Chroma collection.
- Expose **one** MCP read tool that returns either the full segment or a scoped vector search inside it, given an observation ID.
- Stay **out of** the main `search()` path — Layer 3 is traversal-only, never appears in normal results.
- Survive worker restarts without losing in-flight segments.

## 3. What we want it to accomplish

The 3-layer progressive search lets an agent zoom: cheap index hit (~50–100 tok) → observation row (~500–1000 tok) → original conversation (~2000–5000 tok or scoped RAG ~500–1000 tok). Use cases:

- "Why did we choose JWT?" — observation says we did; transcript says **why**.
- Resolving overconfidence flags from the TITANS observer (the conversation itself is the evidence).
- Re-deriving lost reasoning when an observation is too compressed.

The product win: agents stop fabricating context when an observation is ambiguous; they have a concrete "go look at the actual conversation" escape hatch.

## 4. Why we think it will work

- **Reuses load-bearing infrastructure.** `TranscriptWatcher` + `FileTailer` already do incremental JSONL tailing with offset persistence. `ChromaSync` already handles batched embeddings, idempotent IDs, and collection lifecycle. Second instance ≠ second system; it's the same class with a different collection name.
- **Traversal-only is a strong constraint.** Because Layer 3 never enters `search()`, embedding quality, token bloat, and noise risk are bounded. Worst case: the segment is empty or stale — caller gets `[]`, no cascading failure.
- **Idempotent IDs.** `transcript_<sid>_p<n>_c<i>` means a re-flush silently overwrites; no dedup logic needed.
- **Independent collection.** Schema or embedding changes don't touch the main collection; experiments are reversible by dropping `cm__claude-mem-transcripts`.

## 5. Simplest possible implementation (ignore edge cases & existing state)

```
On every prompt boundary, take all user/assistant text since the last boundary,
split into 2KB chunks, embed into a Chroma collection.

Add an MCP tool that, given an observation ID, looks up the session +
prompt_number and returns the chunks for that key. Optional query parameter
runs vector search inside that subset.
```

That's it. Maybe 200 lines total: one method on `ChromaSync` (write), one method (read), one method (scoped read), one HTTP route, one MCP tool registration, hook the flush into the existing `session_init` / `session_end` path.

## 6. Is the simple way better or worse than what we designed?

**It's almost identical to what we designed.** The current implementation is roughly the simple version. Where they differ:

| Concern                                  | Simple                       | Current                                               | Verdict                          |
| ---------------------------------------- | ---------------------------- | ----------------------------------------------------- | -------------------------------- |
| Write trigger                            | prompt boundary + session_end | same                                                  | tie                              |
| Chunking                                 | naive 2KB substring          | naive 2KB substring (`chunkText`)                     | tie                              |
| Privacy stripping                        | none                         | `stripTranscriptPrivacyTags()` reusing existing regex | **current better** (load-bearing) |
| Final-flush retry-with-backoff           | none                         | 3 retries, exponential backoff (`processor.ts:340–353`) | **simple better** — drop the retry |
| Crash-safe offset (advance after handle) | n/a                          | branch's `watcher.ts` advances offset after handling   | **current better** (real bug fix) |
| Scoped query                             | not in scope                 | `queryTranscriptSegment(.., query, n=3)`              | **current better** (cheap addition) |

Net: the current design is ~95% the simplest version. The only excess is the 3-retry exponential backoff in `handleSessionEnd` — if the worker isn't reachable, we won't get a 4th try anyway. Drop it during reapply (~10 lines saved).

## 7. Suggestions for how to continue (re-apply on top of v12.5.0)

Tackle as five small commits on a fresh branch off `origin/main`:

**Commit 1 — utilities**
Add `stripTranscriptPrivacyTags` and `chunkText` to `src/utils/tag-stripping.ts` (lines 97–112 on branch). Pure functions, no other dependencies. Ship with their own unit tests.

**Commit 2 — ChromaSync transcript methods**
Append `addTranscriptChunks`, `getTranscriptSegment`, `queryTranscriptSegment` to the end of `src/services/sync/ChromaSync.ts` (lines 906–993 on branch). No changes to existing methods. Should apply cleanly — main's ChromaSync is unchanged from our base in this region.

**Commit 3 — DatabaseManager second instance**
Add `transcriptChromaSync` field, init it under the same `chromaEnabled` guard, add `getTranscriptChromaSync()` getter, close it in `close()`. ~6 line additions. Trivial.

**Commit 4 — HTTP routes + MCP tool**
Add `handleTranscriptStore` and `handleTranscriptSegment` in `SessionRoutes.ts` (`/api/transcript/store`, `/api/transcript/segment`). Register `get_transcript_segment` in `mcp-server.ts` tool array. Note: the branch is missing main's new corpus tools (`build_corpus`, `list_corpora`, `prime_corpus`, etc.) — keep main's tools, only **append** ours.

**Commit 5 — TranscriptEventProcessor wiring**
Most surgical change. On main's `processor.ts:104` (`handleEvent`):
- Add `exchanges: ConversationExchange[]` to `SessionState`.
- In `case 'session_init'`: call `flushTranscriptSegment(session)` first; bump `promptNumber` if it returned true.
- In `case 'user_message'` and `case 'assistant_message'`: push/patch `session.exchanges`.
- In `case 'session_end'`: single flush attempt (drop the retry-with-backoff), clear exchanges.
- Add `flushTranscriptSegment` method calling `POST /api/transcript/store`.

**Skip:**
- Watcher rewrite (main has its own variant — leave it alone). Branch's offset-after-handle is a real fix but lives independently of Layer 3; address as a separate PR if needed.
- The retry-with-backoff in `handleSessionEnd` (~12 lines).
- The `UNIQUE INDEX user_prompts(content_session_id, prompt_number)` constraint — verify whether this shipped on main during v12.5.0; if not, add it as a standalone migration first because the observation→transcript join depends on prompt_number stability.

**Verify after each commit:** `npm run build`, then in a docker dev container, drive a session and confirm `cm__claude-mem-transcripts` collection appears + `get_transcript_segment` returns content for a real observation ID.

## 8. Overlap/conflict notes vs origin/main (file-level)

| File                                                | Main has Layer 3? | Conflict risk on reapply | Notes                                                                  |
| --------------------------------------------------- | ----------------- | ------------------------ | ---------------------------------------------------------------------- |
| `src/services/sync/ChromaSync.ts`                   | No                | **Low**                  | Append-only; main's structure unchanged in this region.                 |
| `src/services/worker/DatabaseManager.ts`            | No                | **Low**                  | Main is 85 lines (simpler post-PR #2122 consolidation). Additive change. |
| `src/services/transcripts/processor.ts`             | No                | **Medium**               | `handleEvent` switch is identical shape; injecting cases is mechanical but easy to miss prompt-boundary semantics. |
| `src/services/worker/http/routes/SessionRoutes.ts`  | No                | **Medium**               | Main has many other route changes from band-aid strip (#2219); just `app.post()` two new lines + two handler methods. |
| `src/servers/mcp-server.ts`                         | No                | **Low**                  | Main added 7 corpus tools post-divergence; **append**, don't replace.   |
| `src/utils/tag-stripping.ts`                        | No                | **Low**                  | Append two functions; `stripTagsInternal` should still exist on main.  |
| `src/services/transcripts/watcher.ts`               | n/a               | **Skip**                 | Diverged rewrites on both sides; not required for Layer 3.            |
| Schema: `UNIQUE(user_prompts.content_session_id, prompt_number)` | Unknown | **Verify** | Branch's migration 24 is `observation_feedback` (different concern). Confirm whether main has it before reapply. |

---

**Summary (100w):** Layer 3 is a small, well-scoped feature: ~250 lines net, 7 files, one new MCP tool, one new Chroma collection. Main has none of it, so reapplication is mostly additive. Five-commit plan: utilities → ChromaSync methods → DatabaseManager wiring → HTTP routes + MCP tool → processor flush hook. Simplest implementation matches current design within ~10 lines (drop the retry-with-backoff in `handleSessionEnd`). Highest-risk file is `processor.ts` because the prompt-boundary flush has subtle ordering. Verify the user_prompts UNIQUE constraint is on main before reapply, since the observation→transcript join depends on stable prompt_number.
