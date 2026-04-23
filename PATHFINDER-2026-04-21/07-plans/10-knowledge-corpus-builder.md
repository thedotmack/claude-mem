# Plan 10 — knowledge-corpus-builder (clean)

**Target section**: `PATHFINDER-2026-04-21/05-clean-flowcharts.md` § 3.11 (lines 450–476), Part 1 items #35 (line 53) and #36 (line 54).
**Before-state**: `PATHFINDER-2026-04-21/01-flowcharts/knowledge-corpus-builder.md` (lines 1–87).
**Implementation-plan correspondence**: `PATHFINDER-2026-04-21/06-implementation-plan.md` Phase 13 — "KnowledgeAgent simplification" (lines 567–597). **Direct V-number: NONE** — the verified-findings matrix (V1–V20, lines 22–47) does not include a corpus-specific entry. No upstream discrepancy was registered for this area; treat 05 § 3.11 + Phase 13 as the canonical pair.

## Dependencies

- **Upstream**:
  - Plan 05-context-injection-engine — defines `CorpusDetailStrategy` (one of the four strategy configs in 05 § 3.5 lines 232–259 and Part 2 decision D4 line 75). This plan calls `renderObservations(obs, CorpusDetailStrategy)` from CorpusBuilder.
  - Plan 06-hybrid-search-orchestration — defines the clean `SearchOrchestrator.search` signature (05 § 3.6 lines 262–292). CorpusBuilder is a *consumer* — the live call is `SearchOrchestrator.search(args)` at `src/services/worker/search/SearchOrchestrator.ts:71`.
- **Downstream**: none.

## Phase 0 — Documentation Discovery (already done)

### Sources consulted
1. `PATHFINDER-2026-04-21/05-clean-flowcharts.md` — full file (607 lines). Section 3.11 (lines 450–476) is canonical; Part 1 items #35–36 (lines 53–54) set the kill rationale; Part 5 ledger row (line 556) promises ~110 net lines deleted in this area.
2. `PATHFINDER-2026-04-21/06-implementation-plan.md` — full file (691 lines). Phase 13 (lines 567–597). **No V-number in 06's verified-findings table (V1–V20) covers the corpus.** Stated explicitly: Phase 13 cites 05 § 3.11 directly without a V-correction, because the audit's claims matched the live code.
3. `PATHFINDER-2026-04-21/01-flowcharts/knowledge-corpus-builder.md` — full file (87 lines). "Before" flowchart + the Confidence+Gaps section pinpoints the regex at `KnowledgeAgent.ts:179`.
4. Live codebase (confirmed paths, line counts, and specific anchors):
   - `src/services/worker/knowledge/KnowledgeAgent.ts` (284 lines)
   - `src/services/worker/knowledge/CorpusStore.ts` (127 lines)
   - `src/services/worker/knowledge/CorpusBuilder.ts` (174 lines)
   - `src/services/worker/knowledge/CorpusRenderer.ts` (133 lines)
   - `src/services/worker/knowledge/types.ts` (56 lines)
   - `src/services/worker/knowledge/index.ts` (14 lines)
   - `src/services/worker/http/routes/CorpusRoutes.ts` (283 lines)
   - `src/services/worker-service.ts:455-456` — constructor wiring
   - `src/servers/mcp-server.ts:499,517,551` — MCP tool surface that mirrors HTTP
5. Dependency plans (cross-refs only, not re-planned here):
   - 05 § 3.5 (CorpusDetailStrategy) — renderer contract at 05 lines 379–389
   - 05 § 3.6 (SearchOrchestrator.search) — live signature at `src/services/worker/search/SearchOrchestrator.ts:71`.

### Allowed APIs (copy from; do not invent)

- **Claude Agent SDK** — `query({ prompt, options })` already used at `KnowledgeAgent.ts:75` and `:190`. Per 05 § 3.11 (line 461 node "S"): call as `SDK.query(systemPrompt=corpus, userPrompt=question)` — a fresh query every call. The existing SDK usage patterns (cwd, disallowedTools, pathToClaudeCodeExecutable, env) at `KnowledgeAgent.ts:77-84` stay.
- **Prompt caching** — the SDK supplies it automatically when the same system prompt is sent within the 5-min TTL. 05 § 3.11 "Cost note" (lines 476): "cached system prompt TTL is 5 min. Cost approximately equal to session-resume path without the session-expiration brittleness." The refactor does not add any caching code — it relies on the SDK's own behavior.
- **CorpusDetailStrategy** — comes from Plan 05 (renderer contract at 05 lines 379–389). This plan consumes it; it does not define it.
- **`bun:sqlite` / file I/O** — `CorpusStore` already uses `fs.writeFileSync/readFileSync`. No new storage primitives.

### Anti-patterns to prohibit (cited in every phase)

- **A — Invent SDK methods for session resume.** The SDK has no documented session-expiry ping or refresh endpoint. Don't add one.
- **B — Polling.** The regex test `/session|resume|expired|invalid.*session|not found/i` at `KnowledgeAgent.ts:179` is a polling heuristic in disguise — try, match on error text, retry. Delete.
- **C — Silent fallback.** The current "session expired → silently reprime → retry" path at `KnowledgeAgent.ts:146–160` hides a contract violation. Replacement contract: every `/query` runs a **fresh** SDK query; there is no expiration state to recover from.
- **D — Facades that pass through.** `KnowledgeAgent.reprime` at `KnowledgeAgent.ts:168–171` is a two-line call to `prime`. Both die together.
- **E — Two code paths for the same data.** After the refactor, there is exactly one path that sends a corpus to the SDK: inside the `/query` handler.

### Corpus.json schema change (from `types.ts:40–51`)

Before:
```ts
interface CorpusFile {
  version: 1;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
  filter: CorpusFilter;
  stats: CorpusStats;
  system_prompt: string;
  session_id: string | null;     // <-- DROP
  observations: CorpusObservation[];
}
```

After (per 06 Phase 13 task 2, line 579 — with this plan's note that observations stay because `/query` still needs them to build the system prompt):
```ts
interface CorpusFile {
  version: 2;                    // bump so older files with session_id are recognized
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
  filter: CorpusFilter;
  stats: CorpusStats;
  system_prompt: string;
  observations: CorpusObservation[];
}
```

> 06 Phase 13 line 579 suggests trimming further to `{name, filters, renderedCorpus, generatedAt}`. This plan keeps the richer shape so `/query` can recompute `renderObservations(obs, CorpusDetailStrategy)` on demand without re-hitting SQLite. If the stored `system_prompt` + observations combined are too large, switch to storing `renderedCorpus` directly; decision flagged in "Gaps" below.

### HTTP surface (constraint from prompt)

Keep:
- `POST /api/corpus` (build)
- `POST /api/corpus/:name/query`
- `POST /api/corpus/:name/rebuild`
- `DELETE /api/corpus/:name`
- `GET /api/corpus` (list) and `GET /api/corpus/:name` (get) — present today at `CorpusRoutes.ts:29-30`; 05 § 3.11 doesn't mention them but they are user-facing read endpoints. Keep.

Delete (per 05 § 3.11 lines 468–474):
- `POST /api/corpus/:name/prime` (handler at `CorpusRoutes.ts:33` / `:213-228`)
- `POST /api/corpus/:name/reprime` (handler at `CorpusRoutes.ts:35` / `:267-282`)

---

## Phase 1 — Remove `session_id` from the corpus schema and `CorpusStore`

### (a) What to implement — Copy from …

- Copy from **05 § 3.11 line 470**: "`session_id` persisted in corpus.json" is in the deleted list. Also **06 Phase 13 task 2** (line 579): "Simplify `CorpusStore`… No `session_id`."

### (b) Docs

- 05 § 3.11 (lines 450–474) — sets the "no session_id" rule.
- 06 Phase 13 task 2 (line 579) — task text.
- Live file:line targets:
  - `src/services/worker/knowledge/types.ts:49` — `session_id: string | null;` inside `CorpusFile`. Remove.
  - `src/services/worker/knowledge/types.ts:40` — bump `version: 1` → `version: 2`.
  - `src/services/worker/knowledge/types.ts:53-56` — `QueryResult { answer, session_id }`. Remove `session_id` from `QueryResult` (new shape: `{ answer }`).
  - `src/services/worker/knowledge/CorpusStore.ts:61, :67, :77` — `list()` return type drops `session_id`; payload builder at `:74-78` drops the field.
  - `src/services/worker/knowledge/CorpusBuilder.ts:104` — literal `session_id: null` inside the built corpus. Delete the line.

### (c) Verification

- `grep -n "session_id" src/services/worker/knowledge/` → zero lines. (Today: 18 matches across KnowledgeAgent.ts, CorpusStore.ts, CorpusBuilder.ts, types.ts.)
- Compile clean: `npx tsc --noEmit`.
- Unit test: `CorpusStore.read` on a legacy corpus file that still has `session_id` returns a valid `CorpusFile` (extra field ignored by the structural cast, or migrated — see "Blast radius" note below).
- `corpus.json` schema assertion (new integration test): build a corpus; read the file back with `JSON.parse`; assert `!("session_id" in parsed)`.

### (d) Anti-pattern guards

- **A**: Don't add a "migration helper" that re-writes old `session_id: "..."` fields into some new shape. Ignore the field on read; the worker never re-emits it.
- **C**: Don't default `session_id` to `null` "for backward compat" — drop the field outright.

---

## Phase 2 — Delete `KnowledgeAgent.prime` as a distinct operation

### (a) What to implement — Copy from …

- Copy from **05 § 3.11 deleted list, line 469**: "`KnowledgeAgent.prime` as a distinct operation — build IS prime (corpus.json is the prime artifact)."
- 06 Phase 13 task 1 (line 578).

### (b) Docs

- 05 § 3.11 (lines 450–474) — deleted-nodes rationale.
- Live file:line targets:
  - `src/services/worker/knowledge/KnowledgeAgent.ts:52-117` — entire `prime()` method (66 lines). Delete.
  - `src/services/worker/knowledge/KnowledgeAgent.ts:163-171` — entire `reprime()` method (9 lines). Delete (see Phase 4 for endpoint). `reprime` just calls `prime`, so it dies with it (anti-pattern **D**).
  - `src/services/worker/knowledge/KnowledgeAgent.ts:12-41` — imports `OBSERVER_SESSIONS_DIR`, `ensureDir`, `buildIsolatedEnv`, `sanitizeEnv`, `KNOWLEDGE_AGENT_DISALLOWED_TOOLS`. Some still used by the rewritten `query()` in Phase 5; reassess after Phase 5 lands. The disallowedTools list at `:28-41` stays (still applied per call per 05 § 3.11 — Q&A only).

### (c) Verification

- `grep -n "^\s*async prime\|\.prime(" src/services/worker/knowledge/` → zero.
- `grep -n "async reprime\|\.reprime(" src/services/worker/knowledge/` → zero.
- Corpus still builds end-to-end: `curl -X POST /api/corpus -d '{"name":"t","limit":5}'` returns metadata; the resulting `~/.claude-mem/corpora/t.corpus.json` has observations + system_prompt but no SDK session was spawned during build.
- `wc -l src/services/worker/knowledge/KnowledgeAgent.ts` drops by roughly 75 lines (prime 66 + reprime 9). Tracked against the 110-line net-delete target in 05 Part 5.

### (d) Anti-pattern guards

- **A**: Don't add `buildAndPrime(corpus)` as a "unified" helper. Build *is* prime; the SDK is not touched at build time anymore.
- **D**: `reprime` is a pass-through; delete the method, don't keep a stub.

---

## Phase 3 — Delete the auto-reprime regex and the session-expiration retry path

### (a) What to implement — Copy from …

- Copy from **05 Part 1 line 53** (item #35): "KnowledgeAgent auto-reprime on session-expiration regex match … just always prime on query — or store corpus content in a file the SDK loads fresh. No session_id persistence."
- Copy from **05 § 3.11 deleted list, line 471**: "Auto-reprime on regex-matched expiration (~40 lines)."

### (b) Docs

- 05 Part 1 #35 (line 53) — kill rationale.
- 05 § 3.11 (lines 450–474) — replacement flow ("SDK.query(systemPrompt=corpus, userPrompt=question) — fresh query — no session resume").
- Live file:line targets:
  - `src/services/worker/knowledge/KnowledgeAgent.ts:119-161` — `query()` method with its try/catch auto-reprime branch. Delete the entire body; Phase 5 rewrites it.
  - `src/services/worker/knowledge/KnowledgeAgent.ts:173-180` — `isSessionResumeError()`. **Exact regex to delete** (captured at `:179`):
    ```
    /session|resume|expired|invalid.*session|not found/i
    ```
    Delete the whole method.
  - `src/services/worker/knowledge/KnowledgeAgent.ts:183-230` — `executeQuery()` (the resume path). Delete; Phase 5 replaces it.

### (c) Verification

- `grep -n "isSessionResumeError\|auto.?reprime\|session.*expired" src/services/worker/knowledge/` → zero.
- `grep -nE "session\|resume\|expired\|invalid.*session\|not found" src/services/worker/knowledge/` → zero (the raw regex string is gone).
- No retry-on-error logic anywhere in `KnowledgeAgent`. A failed `/query` call propagates to the route handler as a thrown error, returned to the client as `{error: '…'}`.

### (d) Anti-pattern guards

- **B**: Do not replace the regex with a different error-string match. The whole "detect expiry → retry" pattern goes.
- **C**: If `SDK.query` throws, do **not** silently reprime and retry. Propagate. The caller decides.
- **A**: The SDK does not expose a `refreshSession` or `isSessionValid` method — confirmed by the existing usage in `SDKAgent.ts` (not imported for our code path). Don't invent one.

---

## Phase 4 — Delete `/prime` and `/reprime` endpoints

### (a) What to implement — Copy from …

- Copy from **05 § 3.11 deleted list, lines 472–474**: "`reprime` endpoint (rebuild covers it)" and (by implication) `prime` endpoint (since `prime` as an operation is gone).
- 06 Phase 13 task 1 (line 578): "Delete `KnowledgeAgent.prime` and the `reprime` endpoint."

### (b) Docs

- Constraint from the request: keep `POST /api/corpus`, `POST /api/corpus/:name/query`, `POST /api/corpus/:name/rebuild`, `DELETE /api/corpus/:name`. Drop `/prime` and `/reprime`.
- Live file:line targets:
  - `src/services/worker/http/routes/CorpusRoutes.ts:33` — `app.post('/api/corpus/:name/prime', …)` registration. Delete.
  - `src/services/worker/http/routes/CorpusRoutes.ts:35` — `app.post('/api/corpus/:name/reprime', …)` registration. Delete.
  - `src/services/worker/http/routes/CorpusRoutes.ts:209-228` — `handlePrimeCorpus` handler (20 lines). Delete.
  - `src/services/worker/http/routes/CorpusRoutes.ts:263-282` — `handleReprimeCorpus` handler (20 lines). Delete.
  - `src/servers/mcp-server.ts:499` — MCP tool `prime_corpus`. Delete (tool registration + handler). The deferred-tool namespace exposes it today as `mcp__plugin_claude-mem_mcp-search__prime_corpus`.
  - `src/servers/mcp-server.ts:551` — MCP tool `reprime_corpus`. Delete.
  - `src/servers/mcp-server.ts:517` — `query_corpus` description mentions "The corpus must be primed first"; update to "Ask a question about the corpus; the corpus content is loaded fresh per query."

### (c) Verification

- `curl -X POST http://localhost:37777/api/corpus/foo/prime` → HTTP 404 (route no longer registered; Express default 404).
- `curl -X POST http://localhost:37777/api/corpus/foo/reprime` → HTTP 404.
- `grep -n "prime_corpus\|reprime_corpus" src/` → zero.
- `grep -n "handlePrimeCorpus\|handleReprimeCorpus" src/` → zero.
- MCP client listing no longer shows `prime_corpus` or `reprime_corpus` tools.

### (d) Anti-pattern guards

- **D**: Don't leave thin `/prime` and `/reprime` handlers that just return 410 Gone. Delete the routes; 404 is the correct response.
- **A**: Don't add a compatibility-shim tool `prime_corpus_deprecated`.

---

## Phase 5 — Rewrite `/query` to issue a fresh SDK query with corpus content as system prompt

### (a) What to implement — Copy from …

- Copy from **05 § 3.11 lines 460–463** (the clean flowchart):
  ```
  Q["POST /api/corpus/:name/query {question}"] --> R["CorpusStore.read(name)"]
  R --> S["SDK.query(systemPrompt=corpus, userPrompt=question) (fresh query — no session resume)"]
  S --> T["Return answer"]
  ```
- Copy from **06 Phase 13 task 3** (line 580): "Rewrite `KnowledgeAgent.query` to always pass `systemPrompt = renderedCorpus` to the SDK. Claude prompt-caching reduces cost when the same corpus is queried repeatedly within the 5-min TTL."

### (b) Docs

- 05 § 3.11 (lines 450–476), especially the Cost note (line 476).
- Live file:line targets:
  - `src/services/worker/knowledge/KnowledgeAgent.ts` — new `query(corpus, question)` body. Copy the SDK-invocation pattern from the current `executeQuery` at `:185-230`, but with:
    - `prompt: question` (user prompt)
    - `options.systemPrompt: renderedCorpus` (new — load the corpus as system prompt)
    - **Remove** `options.resume: corpus.session_id` (line 194)
    - Keep `options.model`, `options.cwd`, `options.disallowedTools`, `options.pathToClaudeCodeExecutable`, `options.env` (lines 193, 195–198).
  - `src/services/worker/knowledge/KnowledgeAgent.ts:14` — `import { CorpusRenderer }` already exists. Use it. The corpus-rendering call is the combination of `corpus.system_prompt` + `renderer.renderCorpus(corpus)`. Exact shape (copy from the current `prime` prompt at `KnowledgeAgent.ts:61-69`, minus the "Acknowledge" ending):
    ```
    const systemPrompt = [
      corpus.system_prompt,
      '',
      'Here is your complete knowledge base:',
      '',
      renderer.renderCorpus(corpus),
    ].join('\n');
    ```
  - **Note for Phase 6**: `renderer.renderCorpus(corpus)` is the migration target for `renderObservations(obs, CorpusDetailStrategy)`. In this phase, call the existing renderer; Phase 6 swaps the internals.
  - `src/services/worker/http/routes/CorpusRoutes.ts:235-261` — `handleQueryCorpus`. Keep the handler; change the response shape from `{answer, session_id}` (line 260) to `{answer}` only.
  - `src/services/worker/knowledge/types.ts:53-56` — `QueryResult` narrowed to `{ answer: string }`.

### (c) Verification

- Send three queries against the same corpus within 5 min. Inspect SDK response usage (cache fields). Expected: call 1 writes full system prompt to the cache; calls 2 and 3 report `cache_read_input_tokens > 0`.
- `grep -n "resume:" src/services/worker/knowledge/KnowledgeAgent.ts` → zero.
- `grep -n "systemPrompt" src/services/worker/knowledge/KnowledgeAgent.ts` → exactly one occurrence (inside new `query`).
- Every `/query` call produces a subprocess with no `--resume` flag. Verify with `lsof` or SDK logs.
- End-to-end: `curl -X POST /api/corpus/foo/query -d '{"question":"What did we learn about Chroma?"}'` returns `{answer: "..."}` with no `session_id` field.

### (d) Anti-pattern guards

- **A**: The SDK option is `systemPrompt`; do not invent `systemMessage`, `initialContext`, or `primePrompt`. Verify the exact SDK option name in `@anthropic-ai/claude-agent-sdk` types before shipping.
- **C**: If `SDK.query` throws, propagate the error. No silent retry. No fallback to "cached answer".
- **E**: There is exactly one SDK-call site in the knowledge module after this phase — inside `KnowledgeAgent.query`. Anyone adding a second SDK call elsewhere in the module is introducing duplication.

---

## Phase 6 — Switch `CorpusBuilder` rendering to `renderObservations(obs, CorpusDetailStrategy)`

### (a) What to implement — Copy from …

- Copy from **05 § 3.11 line 457** (the clean flowchart node E): `E["renderObservations(obs, CorpusDetailStrategy)<br/>(U2 unified renderer)"]`.
- Copy from **05 Part 2 Decision D4** (line 75): "One renderer. `renderObservations(obs[], strategy)` where `strategy` selects columns, density, and grouping. The four existing formatters become four small strategy configs."
- Copy the `RenderStrategy` contract from **05 § 3.5 / 06 Phase 8** (06 lines 379–389).

### (b) Docs

- 05 § 3.11 (lines 450–476), 05 § 3.5, 05 Part 2 D4.
- **This plan depends on Plan 05-context-injection-engine** to have defined `CorpusDetailStrategy` at `src/services/rendering/renderObservations.ts` (path per 06 Phase 8 task 1, line 379). If Plan 05 has not shipped, this phase BLOCKS on it.
- Live file:line targets:
  - `src/services/worker/knowledge/CorpusBuilder.ts:44` — `this.renderer = new CorpusRenderer();` constructor line. Replace with import of `renderObservations` and `CorpusDetailStrategy`.
  - `src/services/worker/knowledge/CorpusBuilder.ts:109` — `corpus.system_prompt = this.renderer.generateSystemPrompt(corpus)`. Keep (the system-prompt *preamble* is distinct from the observation rendering). Or migrate to a separate strategy if 05 specifies one; 05 does not, so keep.
  - `src/services/worker/knowledge/CorpusBuilder.ts:112` — `const renderedText = this.renderer.renderCorpus(corpus)`. Replace with `const renderedText = renderObservations(corpus.observations, CorpusDetailStrategy);`.
  - `src/services/worker/knowledge/CorpusBuilder.ts:113` — `corpus.stats.token_estimate = this.renderer.estimateTokens(renderedText)`. Keep (token estimator is independent); if Plan 05 moves `estimateTokens` into the unified renderer's output, update.
  - `src/services/worker/knowledge/KnowledgeAgent.ts` (Phase 5 rewrite) — swap `renderer.renderCorpus(corpus)` inside the query-time systemPrompt builder for `renderObservations(corpus.observations, CorpusDetailStrategy)`.
  - `src/services/worker/knowledge/CorpusRenderer.ts` — after both call-sites migrate, delete `renderCorpus()` (lines 14–34) and `renderObservation()` (lines 39–85). Keep `generateSystemPrompt()` (lines 97–132) and `estimateTokens()` (lines 90–92) unless Plan 05 absorbs them. If nothing remains, delete the file; otherwise trim.

### (c) Verification

- `grep -n "renderCorpus\|renderObservation(" src/services/worker/knowledge/CorpusBuilder.ts` → zero.
- `grep -n "renderObservations" src/services/worker/knowledge/` → exactly two call-sites (CorpusBuilder and KnowledgeAgent).
- Snapshot test: feed the same fixture `CorpusObservation[]` to the old `CorpusRenderer.renderCorpus` and the new `renderObservations(obs, CorpusDetailStrategy)` call; assert byte-equal output (or diff in a controlled way documented in Plan 05's snapshot contract).
- `wc -l src/services/worker/knowledge/CorpusRenderer.ts` drops from 133 to roughly 40 (only `generateSystemPrompt` + `estimateTokens` remain, if they remain at all).

### (d) Anti-pattern guards

- **A**: The function name is `renderObservations` (plural), per 05 D4 and 06 Phase 8. Don't invent `renderCorpusObservations` or `renderForAgent`.
- **E**: After this phase, there is one traversal of `observations` in the knowledge module — inside `renderObservations`. Don't leave `renderObservation` (singular) as a helper in CorpusRenderer; Plan 05 owns it.

---

## Phase 7 — Verification (final)

### (a) What to implement — Copy from …

- Copy the verification pattern from **06 Phase 13 task 4 / verification block** (lines 581–588).
- Copy the cost-check from **05 § 3.11 Cost note** (line 476).

### (b) Docs

- 05 § 3.11 (lines 450–476).
- 06 Phase 13 (lines 567–597).

### (c) Verification

1. **Grep gauntlet** (exact commands):
   - `grep -rn "session_id" src/services/worker/knowledge/` → **zero**.
   - `grep -rn "session_id" src/services/worker/http/routes/CorpusRoutes.ts src/servers/mcp-server.ts` → zero for corpus/knowledge paths.
   - `grep -rn "isSessionResumeError\|auto.?reprime\|session.*expired" src/services/worker/knowledge/` → zero.
   - `grep -rn "/session|resume|expired|invalid.*session|not found/" src/services/worker/knowledge/` → zero (the exact regex string must be gone).
   - `grep -rn "\.prime(\|\.reprime(" src/services/worker/knowledge/ src/servers/mcp-server.ts` → zero.
   - `grep -rn "prime_corpus\|reprime_corpus" src/` → zero.
   - `grep -rn "handlePrimeCorpus\|handleReprimeCorpus" src/` → zero.
2. **HTTP endpoints**:
   - `POST /api/corpus` → 200, returns metadata.
   - `POST /api/corpus/:name/rebuild` → 200.
   - `POST /api/corpus/:name/query` → 200, `{answer: "..."}` only (no `session_id`).
   - `DELETE /api/corpus/:name` → 200.
   - `POST /api/corpus/:name/prime` → **404**.
   - `POST /api/corpus/:name/reprime` → **404**.
3. **Cost smoke test** (per 05 line 476, "cached system prompt TTL is 5 min"):
   - Build a 20-observation corpus.
   - Run `POST /api/corpus/test/query` three times within 90 seconds, each with a different question.
   - Record SDK response usage counters for each call. Expect: call 1 `cache_read_input_tokens == 0`; calls 2 and 3 `cache_read_input_tokens > 0` (approximately equal to the rendered corpus length in tokens).
   - If no cache hits on calls 2–3, escalate to "Gaps" below — cost model is broken and the refactor must be revisited.
4. **corpus.json on disk**:
   - `cat ~/.claude-mem/corpora/test.corpus.json | jq 'has("session_id")'` → `false`.
   - `jq '.version'` → `2`.
5. **Line-count delta** (target from 05 Part 5 line 556: net -110 LOC for this area):
   - Before: KnowledgeAgent 284 + CorpusStore 127 + CorpusBuilder 174 + CorpusRenderer 133 + CorpusRoutes 283 = **1001 lines** in the five files.
   - After: roughly -75 (prime+reprime) -10 (CorpusStore `session_id` fields) -40 (auto-reprime + regex + executeQuery body) -40 (prime+reprime HTTP handlers) -93 (CorpusRenderer renderCorpus+renderObservation shift to shared renderer) +30 (new slim query() using systemPrompt). Net ≈ **-228**.
   - 05 Part 5 promised -110; actual deletion is larger because the audit underweighted the CorpusRenderer migration credit (it's also double-counted in Plan 08/unified-renderer).
6. **Full `npm run build-and-sync`** passes.
7. **MCP tool listing** no longer exposes `prime_corpus` or `reprime_corpus`.

### (d) Anti-pattern guards

- **A**: Every grep that returns a non-zero match is a failed phase. No "we'll clean it up later" waivers.
- **B**: If the cost smoke test fails (no cache hits on call 2/3), do not "fix" by reintroducing session-resume. Investigate the SDK's prompt-caching behavior and file the bug.
- **C**: Any handler that silently returns a cached answer without calling the SDK is a regression. Every `/query` must invoke the SDK.

---

## Blast radius + migration

- **corpus.json schema**: `version: 1` → `version: 2`. Old files with `session_id` still parse because TypeScript structural casting is permissive on reads; extra field is ignored, never re-emitted. No explicit migration script — corpus files are rebuilt on `/rebuild` anyway.
- **MCP surface shrinks**: downstream users of the MCP search plugin lose `prime_corpus` and `reprime_corpus` tool names. Coordinate with plugin release notes.
- **Cost profile**: depends on SDK prompt-caching TTL (5 min). See Gap 1 below.

## Confidence + Gaps

**Confidence — High**:
- All deletion targets have exact file:line references verified against live code.
- The 06 Phase 13 verification steps align 1:1 with 05 § 3.11 deletion list.
- Every HTTP and MCP endpoint has been mapped to a specific line in `CorpusRoutes.ts` or `mcp-server.ts`.

**Gap 1 (flagged per prompt — prompt-caching TTL)**: 05 line 476 asserts "cached system prompt TTL is 5 min" → cost roughly equal to session-resume. **This is an assumption**, not a measured fact. If the Claude Agent SDK's caching hits on `systemPrompt` behave differently than expected (e.g., cache key sensitive to small whitespace changes in the rendered corpus; cache disabled when `options.cwd` varies; TTL shorter than 5 min), every `/query` becomes a full prompt-ingest — per-call cost jumps ~20×. **Required**: Phase 7 step 3 (the cost smoke test) must run and the cache-hit ratio must be logged before declaring the phase shipped. If cache miss rate > 10% on repeat queries within 5 min, escalate.

**Gap 2 — corpus.json storage shape**: 06 Phase 13 task 2 (line 579) suggests `{name, filters, renderedCorpus, generatedAt}` — storing the fully-rendered string instead of observations. This plan keeps observations because `renderObservations(obs, CorpusDetailStrategy)` is recomputed per query (Phase 5). Tradeoff: storing `renderedCorpus` saves one render per query (small) but loses the ability to change strategies without a rebuild. **Decision deferred**: ship Phase 1–7 with observations preserved; reopen if Plan 05 lands and stores `renderedCorpus` directly.

---

## Phase Count

**7 phases**: schema cleanup → `prime` deletion → auto-reprime deletion → endpoint deletion → `/query` rewrite → renderer unification → verification.

## Anticipated LOC Impact

- 05 Part 5 row 19 (line 556): `-140 / +30 / net -110`.
- This plan's line-by-line trace (see Phase 7 step 5): actual net deletion closer to **-228** once the `CorpusRenderer` shrink lands.
- Five files touched: `KnowledgeAgent.ts`, `CorpusStore.ts`, `CorpusBuilder.ts`, `CorpusRenderer.ts`, `CorpusRoutes.ts`, plus `mcp-server.ts` and `types.ts` edits.
