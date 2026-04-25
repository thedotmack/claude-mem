# Plan — Fix MCP Semantic Search

**Branch:** `fix/stop-hook-observer-leakage`
**Repo:** `<repo-root>` (e.g. `$HOME/.superset/worktrees/claude-mem/vivacious-teeth`)

## Up-front: about "use a damn MCP library"

The codebase **already does** — and correctly. `package.json` declares `@modelcontextprotocol/sdk@1.25.1`, used by `src/services/sync/ChromaMcpManager.ts:15-16`. It speaks stdio MCP to the official Anthropic `chroma-mcp` Python server (spawned as `uvx chroma-mcp`). `ChromaSync.ts` is a ~970-line formatting/batching layer on top of that — not a bespoke HTTP client. The `chromadb` npm package is *intentionally* not installed (see `ChromaSync.ts:10` and `ChromaMcpManager.ts:6-7`) to avoid ONNX/WASM bloat. Replacing this stack would be a regression, not a fix.

**The real bugs:**

1. **The error message is a lie.** `SearchManager.ts:356` returns "Vector search failed - semantic search unavailable. Install uv… restart the worker." for two completely different conditions (Chroma threw, OR FTS5 fallback returned zero rows). It tells the user to fix something that isn't broken (uv is fine; Chroma is reachable) and gives no clue about what *is* broken.
2. **`/api/chroma/status` lies too.** `ChromaMcpManager.isHealthy()` (`ChromaMcpManager.ts:332-342`) only calls `chroma_list_collections` — it never tries an embedding round-trip. So it reports "healthy" while semantic queries fail.
3. **The actual downstream failure is unknown until we read the logs.** The error gets *logged* (`CHROMA_SYNC` "Query failed" at `ChromaSync.ts:800`) but never returned to the caller — the lying string replaces it.

## Phase 0 — Discovery (DONE)

### Allowed APIs (do not invent others)

From `ChromaSync.ts` and `ChromaMcpManager.ts`:

- `chromaMcp.callTool('chroma_query_documents', { collection_name, query_texts: [query], n_results, where, include })` — semantic vector query (`ChromaSync.ts:772`)
- `chromaMcp.callTool('chroma_list_collections', { limit })` — used by health check (`ChromaMcpManager.ts:334`)
- `chromaMcp.callTool('chroma_create_collection', { collection_name })` — idempotent (`ChromaSync.ts:103`)
- `chromaMcp.callTool('chroma_get_documents', …)` — metadata fetch (`ChromaSync.ts:499`)
- `chromaMcp.callTool('chroma_count', { collection_name })` — count documents in a collection (standard chroma-mcp tool; verify with a probe before using)
- `logger.error(category, msg, meta?, err?)` / `logger.warn(...)` — `src/utils/logger.js`
- `ChromaUnavailableError` is thrown by `ChromaSync.queryChroma` on connection-class errors (`ChromaSync.ts:792-798`)

### Anti-patterns to NOT introduce

- Do not import `chromadb` or any embedding library — the architecture deliberately avoids them.
- Do not catch errors and substitute a static "install uv" string. Surface the real `error.message` (with the category that produced it).
- Do not make `isHealthy()` block the request path — keep it cheap; do the deep probe in a *separate* `/api/chroma/diagnose` endpoint or as an opt-in flag.
- Do not "fix" `new ChromaSync('claude-mem')` at `ChromaSync.ts:870`. That is correct: the codebase intentionally uses one shared collection `cm__claude-mem` with `project` in document metadata. Sub-agent #1's claim that this is a worktree-scoping bug was wrong; sub-agent #2 confirmed the design.

### Files in scope

| File | Role | Change |
|---|---|---|
| `src/services/worker/SearchManager.ts` | Search orchestrator that emits the misleading string | Surface real error |
| `src/services/worker/search/ResultFormatter.ts` | Helper holding the static "install uv" message | Replace with structured error formatter |
| `src/services/sync/ChromaMcpManager.ts` | MCP client; `isHealthy()` is too shallow | Add `probeSemanticSearch()` (deep check) |
| `src/services/worker/http/routes/ChromaRoutes.ts` | `/api/chroma/status` handler | Add a `?deep=1` mode that calls the probe |
| `src/services/sync/ChromaSync.ts` | (Read-only this phase) | Source of truth for tool names |
| `plugin/scripts/worker-service.cjs` | Bundled artifact | Rebuild via `bun run build-and-sync` |

---

## Phase 1 — Diagnose the actual failure (REQUIRED before fixes 4+)

The fix's content depends on which failure mode is live. Do this first.

### 1a. Read recent logs

```bash
ls -lt ~/.claude-mem/logs/ | head -5
# pick the most recent file, then:
grep -E 'CHROMA_SYNC|CHROMA_MCP|SEARCH' ~/.claude-mem/logs/<latest>.log | tail -200
```

Look for, in order of likelihood:

- `CHROMA_SYNC` `Query failed` — captures the actual exception from `chroma_query_documents`. Note the error message text — this tells us whether it's:
  - *embedding-side* (e.g. "No module named 'onnxruntime'", OpenAI API key missing, model download failure)
  - *collection-side* (e.g. "Collection cm__claude-mem does not exist" — would mean backfill never ran for this worktree)
  - *connection-side* (already reported as `ChromaUnavailableError`)
- `CHROMA_MCP` `Health check failed` or `Transport error during "chroma_query_documents"`
- `SEARCH` `ChromaDB semantic search failed, falling back to FTS5 keyword search` (`SearchManager.ts:303`) — confirms the path; the attached error is the smoking gun.

### 1b. Probe the worker directly with curl

```bash
# Confirm health is "healthy"
curl -s http://localhost:37777/api/chroma/status | jq .

# Hit the search endpoint with a concrete query and capture full response
curl -s 'http://localhost:37777/api/search?query=observer&limit=3' | jq .

# If the response contains the lying string, immediately:
tail -100 ~/.claude-mem/logs/<latest>.log
```

### 1c. Probe chroma-mcp directly via the MCP tool

The MCP tool the user can call is `mcp__plugin_claude-mem_mcp-search__list_corpora`, but that hits corpora JSON files (separate from Chroma). To probe the Chroma side specifically, run the curl above; if you want a cleaner signal, add this temporary script:

```bash
# Quick Chroma probe — count docs in cm__claude-mem
node -e "
  fetch('http://localhost:37777/api/chroma/status').then(r=>r.json()).then(console.log)
"
```

### Verification for Phase 1

- [ ] Identified the *exact* exception text being thrown when `chroma_query_documents` is called.
- [ ] Classified the failure as one of: embedding model failure / collection empty for this project / collection missing / connection error / other.
- [ ] Wrote the classification at the top of Phase 4 below before starting Phase 4.

---

## Phase 2 — Replace the lying error string with the real cause

Independent of Phase 1's diagnosis. This phase is safe to ship even if the underlying failure isn't yet fixed — it just stops the message from misleading users.

### 2a. Pass the real error through `SearchManager.search()`

**File:** `src/services/worker/SearchManager.ts`

Currently (around line 184–356):

- A local `let chromaFailed = false` is set in the catch at line 304, but the error itself is discarded except for the `logger.warn` log line.
- When `totalResults === 0 && chromaFailed`, line 356 returns the static lying string.

Change shape (do not copy verbatim — match existing types):

1. At line 184, also declare `let chromaFailureReason: { message: string; isConnectionError: boolean } | null = null;`.
2. In the catch at line 301-304, populate it from the caught error:

   ```ts
   } catch (chromaError) {
     const message = chromaError instanceof Error ? chromaError.message : String(chromaError);
     chromaFailureReason = {
       message,
       isConnectionError: chromaError instanceof ChromaUnavailableError, // or check class name string-safe
     };
     chromaFailed = true;
     logger.warn('SEARCH', 'ChromaDB semantic search failed, falling back to FTS5 keyword search', {}, chromaError as Error);
   ```

3. At line 351-359, replace the call to `ResultFormatter.formatChromaFailureMessage()` with a call that takes `chromaFailureReason`. If `chromaFailureReason !== null` AND `totalResults === 0`, surface the actual error. Otherwise, return the normal "no results" string (do NOT show the failure message at all if FTS5 simply matched nothing).

### 2b. Rewrite the formatter

**File:** `src/services/worker/search/ResultFormatter.ts:275-283`

Delete the hardcoded "Install uv" string. Replace `formatChromaFailureMessage(): string` with `formatChromaFailureMessage(reason: { message: string; isConnectionError: boolean }): string` that returns one of two messages:

- **Connection error** → "Semantic search is offline (Chroma MCP unreachable: `${reason.message}`). Falling back to keyword search; results may be incomplete. Run `/api/chroma/status?deep=1` to diagnose."
- **Other** → "Semantic search failed: `${reason.message}`. Falling back to keyword search; results may be incomplete. Check `~/.claude-mem/logs/` for the CHROMA_SYNC entry. Run `/api/chroma/status?deep=1` for a deeper probe."

No mention of `uv` unless the underlying error mentions it.

### Verification for Phase 2

- [ ] `grep -RIn "Install uv" src/` returns zero hits.
- [ ] `grep -RIn "semantic search unavailable" src/` returns zero hits.
- [ ] When ChromaSync throws a connection error, the `/api/search` response includes the actual error text in its body.
- [ ] When FTS5 simply has zero results AND Chroma succeeded, the response says "No results found" — *not* a Chroma failure message.

---

## Phase 3 — Make `/api/chroma/status` actually verify semantic search

Currently `ChromaMcpManager.isHealthy()` only proves "the subprocess is alive and responding to one tool." This is why the status endpoint reported `connected: true` while real queries fail.

### 3a. Add a deep probe to `ChromaMcpManager`

**File:** `src/services/sync/ChromaMcpManager.ts` (after `isHealthy` at line 332-342)

Add:

```ts
async probeSemanticSearch(): Promise<{
  ok: boolean;
  stage: 'connect' | 'list' | 'query' | 'done';
  error?: string;
  collections?: number;
  queryLatencyMs?: number;
}> {
  // 1. connect (callTool already lazy-connects; failure here surfaces as "list" failure)
  // 2. chroma_list_collections — same as isHealthy
  // 3. chroma_query_documents against the canonical cm__claude-mem collection
  //    with a trivial query (e.g., "ping") and n_results: 1
  // Catch each stage separately so the result carries the failing stage.
}
```

Use the *same* tool names used elsewhere (`chroma_list_collections`, `chroma_query_documents`) — those are the documented chroma-mcp tools per `ChromaSync.ts:103,499,772`. Do not invent new tool names.

If the canonical collection doesn't exist, that itself is a useful diagnostic — return `{ ok: false, stage: 'query', error: 'collection cm__claude-mem missing or empty' }`.

### 3b. Wire it into `/api/chroma/status?deep=1`

**File:** `src/services/worker/http/routes/ChromaRoutes.ts:23-46`

Update `handleGetStatus` to read `req.query.deep`. When `deep` is truthy, call `probeSemanticSearch()` and merge the result into the response. Default behavior (no `deep`) stays cheap.

Add a tiny note in the response body: `"deep": false` so callers know whether to add `?deep=1`.

### Verification for Phase 3

- [ ] `curl http://localhost:37777/api/chroma/status` still returns quickly (<100ms).
- [ ] `curl http://localhost:37777/api/chroma/status?deep=1` performs a real query and returns latency + stage.
- [ ] When `chroma-mcp` is killed (`kill <pid>`), `?deep=1` returns `ok:false, stage:'list'` (or `'query'` depending on timing) with the underlying error text.
- [ ] When semantic search works, `?deep=1` returns `ok:true, stage:'done'`.

---

## Phase 4 — Fix the underlying failure

**Pre-condition:** Phase 1 done. Write the diagnosis here:

> **Diagnosis (2026-04-25):** `connection-error` — chroma-mcp subprocess tool-call timeout. Every `chroma_query_documents` / `chroma_add_documents` / `chroma_get_documents` call hits `MCP error -32001: Request timed out`, after which the subprocess "closes unexpectedly" and enters reconnect backoff. No Python-side ImportError/onnxruntime/key-missing in logs (chroma-mcp stderr isn't piped into the worker log — separate gap). Proximate cause: `~/.claude-mem/chroma/chroma.sqlite3` is **7.3 GB** with hundreds of orphan `cm__test-project-*` collections; the persistent-client startup/index hydration exceeds the MCP SDK's default per-request timeout (~2s observed). Canonical `cm__claude-mem` collection exists. **Branch: 4c.** Concrete fix levers: (1) raise per-tool-call timeout for chroma in `ChromaMcpManager`, (2) GC orphan test-project collections to shrink the persistent dir, (3) capture chroma-mcp subprocess stderr into the worker log so future failures are diagnosable without guesswork.

Branch the fix on the diagnosis:

### 4a. If "collection empty for this project" (likely if list_corpora returned 4 corpora that don't include this worktree's project)

The collection `cm__claude-mem` exists but has no documents for the current `project` metadata. Backfill is fire-and-forget at startup (`worker-service.ts:496-501`) and may have failed silently or never run for this worktree.

Add a manual backfill trigger and run it:

- Look for an existing endpoint that wraps `ChromaSync.backfillAllProjects()` (grep `backfillAllProjects`). If one exists, call it. If not, add `/api/chroma/backfill` (POST) that calls it and streams progress to the response.
- Tail logs while it runs to confirm document inserts succeed.
- Re-run the search query.

### 4b. If "embedding model failure inside chroma-mcp"

This is a `chroma-mcp` (Python) configuration issue, not JS. Common causes:

- `chroma-mcp` defaults to a local ONNX embedder; if the ONNX model didn't download (offline first run), every query fails. Fix: `uvx chroma-mcp --client-type persistent --data-dir ~/.claude-mem/chroma/` once interactively to trigger the download, then restart the worker.
- If an OpenAI embedding function was selected via env var, `OPENAI_API_KEY` may be missing.

Inspect `chroma-mcp` startup logs and stderr (the worker's logger should be capturing the subprocess stderr; if not, that's a separate bug — capture it).

### 4c. If "connection error / subprocess closed"

The `uvx chroma-mcp` subprocess is dying. `ChromaMcpManager` should already auto-reconnect (line 30 backoff). If it's not, look at supervisor exit-handler logic. This is a process-lifecycle bug, not a search bug.

### 4d. If "collection cm__claude-mem missing"

`ensureCollectionExists()` at `ChromaSync.ts:96-119` should idempotently create it. If it's missing in production, `ensureCollectionExists` may be guarded by a stale `this.collectionCreated` flag without DB confirmation. Force-call `chroma_create_collection` once on worker boot (not per-query) and persist the canonical name in the collection list returned by health check.

### Verification for Phase 4

- [ ] After fix, `/api/chroma/status?deep=1` returns `ok:true, stage:'done'` with non-zero latency.
- [ ] `curl 'http://localhost:37777/api/search?query=observer&limit=3'` returns at least one result hydrated from SQLite.
- [ ] `mcp__plugin_claude-mem_mcp-search__search` (the MCP tool) returns results — not the lying message.

---

## Phase 5 — Verification & ship

```bash
# Build and reinstall the bundle
cd <repo-root>
bun run build-and-sync

# Confirm bundled artifact no longer contains the lying string
grep -c "Install uv" plugin/scripts/worker-service.cjs   # expect 0
grep -c "semantic search unavailable" plugin/scripts/worker-service.cjs  # expect 0

# Restart worker (build-and-sync should already do this; double-check)
curl -s http://localhost:37777/api/health | jq .

# Functional smoke
curl -s 'http://localhost:37777/api/search?query=observer+prompt+leakage&limit=3' | jq .
curl -s 'http://localhost:37777/api/chroma/status?deep=1' | jq .
```

Then call the MCP tool the same way the user originally did:

```text
mcp__plugin_claude-mem_mcp-search__search({ query: "observer prompt leakage", limit: 3 })
```

Expect: a populated `index` with IDs, not an error string.

### Anti-pattern grep gauntlet

```bash
grep -RIn "Install uv" src/ plugin/  # 0 hits
grep -RIn "Vector search failed" src/  # 0 hits (or a single test fixture)
grep -RIn "semantic search unavailable" src/ plugin/  # 0 hits
```

### PR

Commit message stem (matches repo style — see PR #2124):

> fix: surface real chroma errors and add deep status probe

PR description should include: before/after of the misleading error, the diagnosis from Phase 1, and the deep-probe response showing semantic search round-trip working.

---

## Why this plan, not a rewrite

The user said "use a damn MCP library." We checked: `@modelcontextprotocol/sdk` is already the foundation, and `chroma-mcp` is the official Anthropic MCP server for Chroma. There is no library to swap in. The pain comes from a static error string that lies and a health endpoint that doesn't measure what it claims. Both are 1-2 file fixes. The deeper failure (Phase 4) needs runtime evidence that the logs already contain — which is why Phase 1 must run first.
