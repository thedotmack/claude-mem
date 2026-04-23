# Pathfinder Phase 0: Feature Inventory

**Date**: 2026-04-21
**Repo**: claude-mem (vivacious-teeth branch)
**Total Features**: 12

---

## 1. lifecycle-hooks
- **Purpose**: Intercepts Claude Code session lifecycle (SessionStart → UserPromptSubmit → PostToolUse → Summary → SessionEnd) to capture tool usage and trigger downstream processing.
- **Entry Points**: `src/hooks/hook-response.ts:1`, `src/services/worker-service.ts:23`, `src/supervisor/index.ts:1`
- **Core Files**: `src/hooks/hook-response.ts`, `src/services/infrastructure/GracefulShutdown.ts`, `src/supervisor/index.ts`, `src/supervisor/process-registry.ts`, `src/shared/hook-constants.ts`

## 2. privacy-tag-filtering
- **Purpose**: Strips privacy-control tags (`<private>`, `<system-reminder>`, `<system-instruction>`, `<claude-mem-context>`) from content at edge before storage.
- **Entry Points**: `src/utils/tag-stripping.ts:24`, `src/utils/tag-stripping.ts:51`, `src/utils/tag-stripping.ts:75`
- **Core Files**: `src/utils/tag-stripping.ts`, `src/services/worker/agents/ResponseProcessor.ts`, `src/cli/handlers/observation.ts`

## 3. sqlite-persistence
- **Purpose**: SQLite3-backed storage for observations, summaries, sessions, prompts, pending messages; schema migrations and transactions.
- **Entry Points**: `src/services/sqlite/Database.ts:1`, `src/services/sqlite/migrations/runner.ts:1`, `src/services/sqlite/observations/store.ts:1`
- **Core Files**: `src/services/sqlite/Database.ts`, `src/services/sqlite/Observations.ts`, `src/services/sqlite/Summaries.ts`, `src/services/sqlite/SessionStore.ts`, `src/services/sqlite/PendingMessageStore.ts`, `src/services/sqlite/migrations.ts`

## 4. vector-search-sync
- **Purpose**: Syncs observations and session summaries to ChromaDB via MCP for semantic search.
- **Entry Points**: `src/services/sync/ChromaSync.ts:75`
- **Core Files**: `src/services/sync/ChromaSync.ts`, `src/services/sync/ChromaMcpManager.ts`

## 5. context-injection-engine
- **Purpose**: Generates contextual observations injected into session prompts using token budgets, mode-based filtering, semantic relevance.
- **Entry Points**: `src/services/context/ContextBuilder.ts:46`, `src/services/context/ObservationCompiler.ts:1`, `src/services/context/ContextConfigLoader.ts:17`
- **Core Files**: `src/services/context/ContextBuilder.ts`, `src/services/context/ObservationCompiler.ts`, `src/services/context/TokenCalculator.ts`, `src/services/context/sections/TimelineRenderer.ts`, `src/services/context/sections/SummaryRenderer.ts`, `src/services/context/formatters/AgentFormatter.ts`

## 6. hybrid-search-orchestration
- **Purpose**: Multi-strategy search (Chroma semantic + SQLite keyword + hybrid) with timeline context, formatting, pagination.
- **Entry Points**: `src/services/worker/search/SearchOrchestrator.ts:44`
- **Core Files**: `src/services/worker/search/SearchOrchestrator.ts`, `src/services/worker/search/strategies/ChromaSearchStrategy.ts`, `src/services/worker/search/strategies/SQLiteSearchStrategy.ts`, `src/services/worker/search/strategies/HybridSearchStrategy.ts`, `src/services/worker/search/ResultFormatter.ts`, `src/services/worker/search/TimelineBuilder.ts`

## 7. response-parsing-storage
- **Purpose**: Parses XML observations/summaries from agent responses, atomic DB transactions, SSE broadcasting, message cleanup.
- **Entry Points**: `src/services/worker/agents/ResponseProcessor.ts:49`, `src/sdk/parser.ts:1`
- **Core Files**: `src/services/worker/agents/ResponseProcessor.ts`, `src/sdk/parser.ts`, `src/services/worker/agents/ObservationBroadcaster.ts`, `src/services/worker/agents/SessionCleanupHelper.ts`

## 8. session-lifecycle-management
- **Purpose**: Active session state, pending message queue, subprocess tracking, stale session detection and reaping.
- **Entry Points**: `src/services/worker/SessionManager.ts:1`, `src/services/worker/SessionManager.ts:59`
- **Core Files**: `src/services/worker/SessionManager.ts`, `src/services/worker/ProcessRegistry.ts`, `src/services/queue/SessionQueueProcessor.ts`, `src/services/sqlite/PendingMessageStore.ts`

## 9. http-server-routes
- **Purpose**: Express server on port 37777; middleware, routing for search/viewer/session/data/settings/memory; health checks.
- **Entry Points**: `src/services/server/Server.ts:72`, `src/services/worker/http/routes/SearchRoutes.ts:1`
- **Core Files**: `src/services/server/Server.ts`, `src/services/server/Middleware.ts`, `src/services/server/ErrorHandler.ts`, `src/services/worker/http/routes/SearchRoutes.ts`, `src/services/worker/http/routes/ViewerRoutes.ts`, `src/services/worker/http/routes/SessionRoutes.ts`, `src/services/worker/http/routes/SettingsRoutes.ts`, `src/services/worker/http/routes/MemoryRoutes.ts`

## 10. viewer-ui-layer
- **Purpose**: React frontend at localhost:37777 for browsing memory stream, settings, observations; SSE-driven real-time updates.
- **Entry Points**: `src/ui/viewer/App.tsx:1`, `src/ui/viewer/index.tsx:1`, `src/ui/viewer/hooks/useSSE.ts:1`
- **Core Files**: `src/ui/viewer/App.tsx`, `src/ui/viewer/components/`, `src/ui/viewer/hooks/useSettings.ts`, `src/ui/viewer/hooks/useSSE.ts`, `src/services/worker/SSEBroadcaster.ts`

## 11. knowledge-corpus-builder
- **Purpose**: Compiles filtered observation sets into named corpus files with search, rendering, storage for knowledge agent.
- **Entry Points**: `src/services/worker/knowledge/CorpusBuilder.ts:50`, `src/services/worker/knowledge/KnowledgeAgent.ts:1`
- **Core Files**: `src/services/worker/knowledge/CorpusBuilder.ts`, `src/services/worker/knowledge/CorpusRenderer.ts`, `src/services/worker/knowledge/CorpusStore.ts`, `src/services/worker/knowledge/KnowledgeAgent.ts`, `src/services/worker/http/routes/CorpusRoutes.ts`

## 12. transcript-watcher-integration
- **Purpose**: Watches external transcript files (Cursor, OpenCode) for tool events, parses, injects observations.
- **Entry Points**: `src/services/transcripts/watcher.ts:1`, `src/services/transcripts/processor.ts:33`
- **Core Files**: `src/services/transcripts/watcher.ts`, `src/services/transcripts/processor.ts`, `src/services/transcripts/config.ts`, `src/services/transcripts/types.ts`, `src/services/integrations/CursorHooksInstaller.ts`

---

## Excluded from Feature Inventory (Shared Utilities)
- `src/utils/` (logger, project-name, claude-md-utils)
- `src/shared/` (paths, worker-utils, hook-constants)
- `src/types/` (type definitions)
