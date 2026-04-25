# Chroma System Flowcharts

## AS BUILT

```mermaid
flowchart TD
    subgraph Boot["Worker Boot (worker-service.ts:428-509)"]
        B1["worker-service start"] --> B2{"CLAUDE_MEM_CHROMA_ENABLED?"}
        B2 -- no --> B3["skip Chroma init"]
        B2 -- yes --> B4["ChromaMcpManager.getInstance() (no connect)"]
        B4 --> B5["dbManager.initialize()"]
        B5 --> B6["new ChromaSync('claude-mem') -> cm__claude-mem"]
        B6 --> B7["SearchOrchestrator + CorpusBuilder receive shared instance"]
        B7 --> B8["mark init complete"]
        B8 --> B9["fire-and-forget backfillAllProjects()"]
    end

    subgraph Producers["Write Call Sites"]
        P1["ResponseProcessor.syncAndBroadcastObservations"]
        P2["ResponseProcessor.syncAndBroadcastSummary"]
        P3["SessionRoutes UserPromptSubmit"]
        P4["MemoryRoutes POST /api/memory/save"]
        P5["DataRoutes manual import (awaited)"]
        P6["WorktreeAdoption updateMergedIntoProject (awaited)"]
    end

    P1 & P2 & P3 & P4 & P5 & P6 --> GW["dbManager.getChromaSync()?"]

    subgraph SyncLayer["ChromaSync.ts (sync layer)"]
        GW --> FMT["format*Docs (explode obs->narrative/text/fact_i; summary->6 fields; prompt->1)"]
        FMT --> META["attach metadata (sqlite_id, doc_type, project, field_type, fact_index, ...)"]
        META --> SAN["sanitize null/empty metadata"]
        SAN --> ADD["addDocuments (batch 100)"]
        ADD --> DUP{"already exists?"}
        DUP -- yes --> REC["delete-then-add reconcile"]
        DUP -- no --> CALL["callTool('chroma_add_documents')"]
        REC --> CALL
        UMP["updateMergedIntoProject (rewrite metadata)"] --> CALL
        P6 --> UMP
    end

    subgraph Backfill["Backfill Loop (startup, per project)"]
        BF1["backfillAllProjects"] --> BF2["for each project"]
        BF2 --> BF3["getExistingChromaIds (paged 1000)"]
        BF3 --> BF4["diff vs SQLite sqlite_ids"]
        BF4 --> BF5["batch-add missing"]
        BF5 --> ADD
        B9 --> BF1
    end

    subgraph MCP["ChromaMcpManager (process layer)"]
        CALL --> LOCK{"connecting lock / connected?"}
        LOCK -- not connected --> SPAWN["lazy connect"]
        SPAWN --> OS{"platform"}
        OS -- Windows --> WIN["cmd.exe /c uvx chroma-mcp"]
        OS -- macOS --> MAC["build Zscaler-merged CA bundle + 4 SSL env vars"]
        OS -- Linux --> LIN["uvx chroma-mcp"]
        WIN & MAC & LIN --> MODE{"mode"}
        MODE -- local --> ML["--client-type persistent --data-dir ~/.claude-mem/chroma"]
        MODE -- remote --> MR["--client-type http --host --port [--ssl --tenant --database --api-key]"]
        ML & MR --> SPN["spawn subprocess (cwd=os.homedir())"]
        SPN --> SUP["register with supervisor"]
        SPN --> STDIO["MCP over stdio (30s timeout)"]
        STDIO --> ONCLOSE["transport.onclose -> stale-handler guard, flip state"]
        ONCLOSE --> BACKOFF["10s reconnect backoff"]
        LOCK -- connected --> SEND["send tool call"]
        STDIO --> SEND
        SEND --> RETRY{"transport error?"}
        RETRY -- yes --> ONCE["single retry"]
        RETRY -- no --> OK["return result"]
        ONCE --> SEND
    end

    subgraph Subproc["uvx chroma-mcp subprocess"]
        SEND --> CMP["chroma-mcp server"]
        CMP --> STORE[("~/.claude-mem/chroma/")]
    end

    subgraph Read["Read Path"]
        H1["HTTP GET /search"] --> H2["SearchManager"]
        H2 --> H3["SearchOrchestrator.executeWithFallback"]
        H3 --> DT{"decision tree"}
        DT -- "no query" --> S1["SQLiteSearchStrategy"]
        DT -- "query + chroma" --> S2["ChromaSearchStrategy"]
        DT -- "concept/file/type + query" --> S3["HybridSearchStrategy"]
        S2 --> WF["buildWhereFilter(searchType, project)"]
        WF --> QC["queryChroma -> chroma_query_documents"]
        S3 --> SQF["SQLite filter"] --> CR["Chroma rank"] --> INTX["intersection"] --> QC
        QC --> CALL
        OK --> ERRC{"connection error string match? ECONNREFUSED|ENOTFOUND|fetch failed|subprocess closed|timed out"}
        ERRC -- yes --> RST["reset collectionCreated + wrap ChromaUnavailableError -> HTTP 503"]
        ERRC -- no --> DEDUP["deduplicateQueryResults (parse doc IDs -> sqlite_ids)"]
        DEDUP --> RECF["filterByRecency (90 days)"]
        RECF --> CAT["categorizeByDocType"]
        CAT --> HYD["SessionStore hydrate by ID"]
        S1 --> HYD
        HYD --> RESP["HTTP response"]
    end

    subgraph Shutdown["GracefulShutdown.performGracefulShutdown"]
        SD1["HTTP server close"] --> SD2["SessionManager flush"]
        SD2 --> SD3["close loopback MCP client"]
        SD3 --> SD4["ChromaMcpManager.stop() SIGTERM/SIGKILL"]
        SD4 --> SD5["dbManager.close() (ChromaSync.close = no-op log)"]
        SD5 --> SD6["supervisor reaps remaining children"]
    end
```

## MINIMAL PATH

**Removed:**
- **Granular per-field doc explosion** — one concatenated doc per observation/summary preserves recall with ~6× fewer vectors and no fact_index/field_type bookkeeping.
- **`field_type` metadata** — never used as a semantic filter; `sqlite_id` already covers hydration.
- **Shared collection + project filter** — per-project collections give cheaper queries and remove the `merged_into_project` rewrite path entirely.
- **`WorktreeAdoption.updateMergedIntoProject`** — dies with the shared-collection model.
- **Backfill on startup** — if writes are awaited and idempotent (upsert), the diff-and-fill loop is dead weight.
- **Dup-reconcile delete+add** — replaced by `upsert` which is one round trip and naturally idempotent.
- **HybridSearchStrategy** — SQLite filter + Chroma rank intersection is a small win for a lot of code; plain Chroma with `where` covers it.
- **90-day recency filter** — not core to "query semantically"; push to caller if needed.
- **MCP-stdio indirection** — chromadb persistent client in-process removes subprocess, supervisor registration, Windows `cmd` shim, Zscaler cert bundle, reconnect backoff, connecting lock, transport retry, and `onclose` stale-handler logic.
- **Singleton + connection-lock + backoff machinery** — gone with the subprocess.
- **Zscaler bundle, Windows `cmd.exe` shim, supervisor registration** — only exist to feed/reap the subprocess.
- **Six write call sites** — collapse to a single ingress; removes the `dbManager.getChromaSync()?` null-dance everywhere.
- **Fire-and-forget vs awaited split** — one awaited path with a bounded queue; failures log and drop, no silent divergence between SQLite and vector store.

```mermaid
flowchart TD
    subgraph Boot["Boot"]
        B1["worker start"] --> B2{"CHROMA_ENABLED?"}
        B2 -- no --> B3["skip"]
        B2 -- yes --> B4["new ChromaStore() -> in-process chromadb persistent client"]
        B4 --> B5["open ~/.claude-mem/chroma/"]
    end

    subgraph Ingress["Single Write Ingress"]
        P["producers (observations, summaries, prompts)"] --> ING["ChromaStore.ingest(doc, metadata)"]
        ING --> ONE["one concatenated doc per item"]
        ONE --> META["metadata: sqlite_id, doc_type, created_at_epoch"]
        META --> UP["collection.upsert (idempotent)"]
        UP --> COL[("per-project collection")]
    end

    subgraph Read["Read"]
        Q1["HTTP GET /search"] --> Q2["ChromaStore.query(text, where)"]
        Q2 --> COL
        COL --> Q3["results -> sqlite_ids"]
        Q3 --> Q4["SessionStore hydrate"]
        Q4 --> Q5["HTTP response"]
    end

    subgraph Shutdown["Shutdown"]
        SD1["HTTP server close"] --> SD2["ChromaStore.close() (flush persistent client)"]
    end

    B5 -.-> COL
```
