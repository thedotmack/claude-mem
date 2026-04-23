# Flowchart: vector-search-sync

## Sources Consulted
- `src/services/sync/ChromaSync.ts:1-969`
- `src/services/sync/ChromaMcpManager.ts:1-509`
- `src/services/worker/agents/ResponseProcessor.ts:1-423`
- `src/services/worker/DatabaseManager.ts:1-100`
- `src/services/worker-service.ts:1-550`
- `src/services/infrastructure/WorktreeAdoption.ts:1-348`
- `src/services/infrastructure/GracefulShutdown.ts:1-110`
- `src/services/worker/SearchManager.ts:1-100`

## Happy Path Description

When a new observation is stored to SQLite, ResponseProcessor orchestrates two fire-and-forget async paths in parallel: (1) Database write commits the observation row transactionally, then (2) ChromaSync is notified via `syncObservation()` to send formatted documents to Chroma via MCP. If Chroma is disabled (`CLAUDE_MEM_CHROMA_ENABLED=false`), sync is skipped. ChromaMcpManager maintains a persistent singleton stdio connection to the chroma-mcp Python subprocess with lazy initialization, auto-reconnect with backoff, and graceful shutdown.

On worker startup, `ChromaSync.backfillAllProjects()` runs fire-and-forget to detect missing observations by comparing Chroma's metadata index with SQLite. It batches in 100-document chunks, formats each observation into multiple granular documents (one per field), and syncs to per-project collections named `cm__<sanitized_project>`.

## Mermaid Flowchart

```mermaid
flowchart TD
    Start([Agent Response Returned<br/>ResponseProcessor.ts:49]) --> Parse["Parse Observations + Summary<br/>ResponseProcessor.ts:70-81"]
    Parse --> StoreDB["Store to SQLite<br/>ResponseProcessor.ts:151"]
    StoreDB --> ConfirmMsg["pendingStore.confirmProcessed<br/>ResponseProcessor.ts:206"]

    ConfirmMsg --> SyncObsDef["syncAndBroadcastObservations<br/>ResponseProcessor.ts:270"]
    ConfirmMsg --> SyncSumDef["syncAndBroadcastSummary<br/>ResponseProcessor.ts:363"]

    SyncObsDef --> LoopObs["For each Observation<br/>ResponseProcessor.ts:280"]
    LoopObs --> CheckChromaObs{Chroma Enabled?<br/>DatabaseManager.ts:34-39}
    CheckChromaObs -->|Yes| CallSyncObs["getChromaSync().syncObservation<br/>ResponseProcessor.ts:286"]
    CheckChromaObs -->|No| SkipObs["No-op skip"]

    CallSyncObs --> SyncObsEntry["ChromaSync.syncObservation<br/>ChromaSync.ts:339"]
    SyncObsEntry --> FormatObs["formatObservationDocs per field<br/>ChromaSync.ts:125"]
    FormatObs --> EnsureCollObs["ensureCollectionExists<br/>ChromaSync.ts:96"]
    EnsureCollObs --> AddDocObs["addDocuments batch<br/>ChromaSync.ts:262"]
    AddDocObs --> SanitizeMeta["Filter null/empty metadata<br/>ChromaSync.ts:277-280"]
    SanitizeMeta --> CallAddDocs["chromaMcp.callTool chroma_add_documents<br/>ChromaSync.ts:284"]
    CallAddDocs --> CheckDupObs{ID Conflict?}
    CheckDupObs -->|Yes| DelThenAdd["Delete then Re-add<br/>ChromaSync.ts:297-306"]
    CheckDupObs -->|No| LogSuccess["Log success<br/>ChromaSync.ts:329"]
    DelThenAdd --> LogSuccess
    LogSuccess --> BroadcastObs["SSE broadcast<br/>ResponseProcessor.ts:312"]

    SyncSumDef --> SyncSumEntry["ChromaSync.syncSummary<br/>ChromaSync.ts:384"]
    SyncSumEntry --> FormatSum["formatSummaryDocs per field<br/>ChromaSync.ts:193"]
    FormatSum --> CallAddSum["chroma_add_documents<br/>ChromaSync.ts:284"]
    CallAddSum --> BroadcastSum["SSE broadcast<br/>ResponseProcessor.ts:403"]

    InitWorker([Worker Initializes<br/>worker-service.ts:406-420]) --> InitDBMgr["dbManager.initialize<br/>DatabaseManager.ts:27"]
    InitDBMgr --> CreateChromaSync["new ChromaSync<br/>DatabaseManager.ts:36"]
    CreateChromaSync --> LazyMCP["ChromaMcpManager.getInstance<br/>ChromaMcpManager.ts:47"]
    LazyMCP --> Backfill["backfillAllProjects FnF<br/>worker-service.ts:470"]

    Backfill --> FetchProjects["SELECT DISTINCT project<br/>ChromaSync.ts:868"]
    FetchProjects --> LoopProjects["For each project<br/>ChromaSync.ts:874"]
    LoopProjects --> EnsureBackfilled["ensureBackfilled<br/>ChromaSync.ts:554"]
    EnsureBackfilled --> GetChromaIds["getExistingChromaIds<br/>ChromaSync.ts:479"]
    GetChromaIds --> RunPipeline["runBackfillPipeline<br/>ChromaSync.ts:575"]
    RunPipeline --> BackfillObs["backfillObservations<br/>ChromaSync.ts:603"]
    BackfillObs --> BackfillSum["backfillSummaries<br/>ChromaSync.ts:652"]
    BackfillSum --> BackfillPrompts["backfillPrompts<br/>ChromaSync.ts:701"]

    SearchFlow([User Search Query<br/>SearchManager.ts:56]) --> QueryChroma["chromaSync.queryChroma<br/>SearchManager.ts:59"]
    QueryChroma --> CallQuery["chroma_query_documents<br/>ChromaSync.ts:768"]
    CallQuery --> Dedupe["deduplicateQueryResults<br/>ChromaSync.ts:808"]

    Shutdown([Worker Shutdown<br/>GracefulShutdown.ts:56]) --> StopChromaMcp["chromaMcpManager.stop<br/>GracefulShutdown.ts:73"]
    StopChromaMcp --> KillSubproc["transport.close<br/>ChromaMcpManager.ts:357"]
```

## Side Effects

- **MCP Connection**: Singleton stdio connection to chroma-mcp, lazy-init, reconnect with backoff, graceful shutdown.
- **Per-project collections**: `cm__<sanitized_project>` naming.
- **Granular vectorization**: Observations split into multiple docs per field (3-5× vector count).
- **Batch reconciliation**: Duplicate IDs handled via delete-then-add within batch.
- **Fire-and-forget**: All sync is non-blocking; failures log but don't block.
- **Worktree metadata patching**: `merged_into_project` stamp applied idempotently.

## External Feature Dependencies

**Calls into:**
- `chroma-mcp` Python subprocess (via stdio MCP protocol)
- ChromaMcpManager (singleton lifecycle)
- SQLite (source of truth for backfill)

**Called by:**
- ResponseProcessor (observation/summary sync after DB write)
- SearchManager (read-side Chroma queries)
- WorktreeAdoption (post-merge metadata updates)
- Worker lifecycle (startup backfill, shutdown)

## Confidence + Gaps

**High Confidence**: Single sync implementation; fire-and-forget pattern; per-project metadata-scoped collections; lazy MCP init.

**Medium Confidence**: Exact chroma-mcp tool names verified via grep.

**Gaps**: Embedding model config is inside chroma-mcp package (not this codebase); HNSW/ANN parameters not visible.
