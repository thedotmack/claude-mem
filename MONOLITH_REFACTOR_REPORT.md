# Monolith Refactor Report

> **Last Updated:** 2026-01-03 (post session-logging merge)

## Executive Summary

The claude-mem codebase contains **~21,000 lines** of TypeScript across 71+ files. Analysis reveals several monolithic files that violate single-responsibility principles and create tight coupling. This report identifies refactoring targets and proposes a modular architecture.

**Recent Changes:** The `session-logging` branch merge improved error handling across the codebase. SearchManager was reduced by ~180 lines, but SessionStore grew by ~110 lines due to new migrations and logging.

---

## Part 1: Monolith Files Identified

### Critical Priority (>1500 lines)

| File | Lines | Methods | Primary Issues | Trend |
|------|-------|---------|----------------|-------|
| `src/services/worker-service.ts` | 2,034 | - | Server init, process management, Cursor hooks, MCP setup all mixed | ↓ -28 |
| `src/services/sqlite/SessionStore.ts` | 2,011 | 49 | Migrations + CRUD + queries + transformations all in one class | ↑ +108 |
| `src/services/worker/SearchManager.ts` | 1,778 | 17 | Three search strategies crammed together, formatting mixed in | ↓ -178 |

### High Priority (500-1500 lines)

| File | Lines | Issues | Trend |
|------|-------|--------|-------|
| `src/services/sync/ChromaSync.ts` | 870 | Sync and query operations mixed | — |
| `src/services/context-generator.ts` | 659 | 23 standalone functions, no class structure | — |
| `src/services/worker/http/routes/SessionRoutes.ts` | 625 | Provider selection mixed with business logic | ↑ +7 |
| `src/services/worker/OpenRouterAgent.ts` | 599 | 80% code duplicated from other agents | ↓ -15 |
| `src/services/worker/GeminiAgent.ts` | 574 | 80% code duplicated from other agents | ↓ -15 |
| `src/services/worker/SDKAgent.ts` | 546 | Base patterns duplicated across all agents | ↓ -15 |
| `src/services/sqlite/SessionSearch.ts` | 526 | FTS5 tables maintained for backward compat | — |
| `src/services/sqlite/migrations.ts` | 509 | All 11 migrations in single file | — |
| `src/services/sqlite/PendingMessageStore.ts` | 447 | Message queue operations | ↑ +21 |
| `src/services/worker/http/routes/SettingsRoutes.ts` | 414 | File I/O, validation, git ops mixed | — |

### Code Duplication Issue

The three agent files (`SDKAgent`, `GeminiAgent`, `OpenRouterAgent`) share ~80% duplicate code:
- Message building logic
- Result parsing
- Context updating
- Database sync patterns

---

## Part 2: System Breakdown Proposal

### Domain-Based Module Architecture

```
src/
├── domains/                    # Business domain modules
│   ├── sessions/               # Session lifecycle
│   │   ├── SessionRepository.ts
│   │   ├── SessionService.ts
│   │   └── types.ts
│   │
│   ├── observations/           # Observation management
│   │   ├── ObservationRepository.ts
│   │   ├── ObservationService.ts
│   │   └── types.ts
│   │
│   ├── summaries/              # Summary generation
│   │   ├── SummaryRepository.ts
│   │   ├── SummaryService.ts
│   │   └── types.ts
│   │
│   ├── prompts/                # Prompt storage
│   │   ├── PromptRepository.ts
│   │   └── types.ts
│   │
│   └── search/                 # Search subsystem
│       ├── strategies/
│       │   ├── ChromaSearchStrategy.ts
│       │   ├── FilterSearchStrategy.ts
│       │   └── SearchStrategy.ts (interface)
│       ├── SearchOrchestrator.ts
│       ├── ResultFormatter.ts
│       └── TimelineBuilder.ts
│
├── infrastructure/             # Cross-cutting infrastructure
│   ├── database/
│   │   ├── DatabaseConnection.ts
│   │   ├── TransactionManager.ts
│   │   └── migrations/
│   │       ├── MigrationRunner.ts
│   │       ├── 001_initial.ts
│   │       ├── 002_add_prompts.ts
│   │       └── ...
│   │
│   ├── vector/
│   │   ├── ChromaClient.ts
│   │   ├── ChromaSyncManager.ts
│   │   └── ChromaQueryEngine.ts
│   │
│   └── agents/
│       ├── BaseAgent.ts        # Shared agent logic
│       ├── AgentFactory.ts
│       ├── MessageBuilder.ts
│       ├── ResponseParser.ts
│       ├── providers/
│       │   ├── ClaudeProvider.ts
│       │   ├── GeminiProvider.ts
│       │   └── OpenRouterProvider.ts
│       └── types.ts
│
├── api/                        # HTTP layer
│   ├── routes/
│   │   ├── sessions.ts
│   │   ├── data.ts
│   │   ├── search.ts
│   │   ├── settings.ts
│   │   └── viewer.ts
│   ├── middleware/
│   └── server.ts
│
├── context/                    # Context injection
│   ├── ContextBuilder.ts
│   ├── ContextConfigLoader.ts
│   ├── ObservationCompiler.ts
│   └── TokenCalculator.ts
│
└── shared/                     # Shared utilities (existing)
    ├── logger.ts
    ├── settings.ts
    └── ...
```

---

## Part 3: Refactoring Targets by Priority

### Phase 1: Database Layer Decomposition

**Target:** `src/services/sqlite/SessionStore.ts` (2,011 lines, 49 methods → ~5 files)

| Extract To | Responsibility | Est. Lines |
|------------|---------------|------------|
| `domains/sessions/SessionRepository.ts` | Session CRUD ops | ~300 |
| `domains/observations/ObservationRepository.ts` | Observation storage/retrieval | ~400 |
| `domains/summaries/SummaryRepository.ts` | Summary storage/retrieval | ~200 |
| `infrastructure/database/migrations/MigrationRunner.ts` | Schema migrations | ~250 |

**Benefits:**
- Single responsibility per file
- Testable in isolation
- Reduces coupling

---

### Phase 2: Agent Consolidation

**Target:** 3 agent files (1,719 lines → ~800 lines total)

| Extract To | Responsibility |
|------------|---------------|
| `infrastructure/agents/BaseAgent.ts` | Common agent logic, prompt building |
| `infrastructure/agents/MessageBuilder.ts` | Message construction |
| `infrastructure/agents/ResponseParser.ts` | Result parsing (observations, summaries) |
| `infrastructure/agents/providers/*.ts` | Provider-specific API calls only |

**Benefits:**
- Eliminates 80% code duplication
- Easy to add new providers
- Centralized message format changes

---

### Phase 3: Search Strategy Pattern

**Target:** `src/services/worker/SearchManager.ts` (1,778 lines → ~5 files)

| Extract To | Responsibility |
|------------|---------------|
| `domains/search/SearchOrchestrator.ts` | Coordinates search strategies |
| `domains/search/strategies/ChromaSearchStrategy.ts` | Vector search via Chroma |
| `domains/search/strategies/FilterSearchStrategy.ts` | SQLite filter-based search |
| `domains/search/ResultFormatter.ts` | Formats search results |
| `domains/search/TimelineBuilder.ts` | Constructs timeline views |

**Benefits:**
- Strategy pattern for extensibility
- Clear fallback logic
- Testable strategies

---

### Phase 4: Context Generator Restructure

**Target:** `src/services/context-generator.ts` (659 lines → ~4 files)

| Extract To | Responsibility |
|------------|---------------|
| `context/ContextBuilder.ts` | Main builder class |
| `context/ContextConfigLoader.ts` | Config loading/validation |
| `context/ObservationCompiler.ts` | Compiles observations for injection |
| `context/TokenCalculator.ts` | Token budget calculations |

**Benefits:**
- Class-based structure
- Clear dependencies
- Easier testing

---

### Phase 5: Server/Infrastructure Split

**Target:** `src/services/worker-service.ts` (2,034 lines → ~4 files)

| Extract To | Responsibility |
|------------|---------------|
| `api/server.ts` | Express app, route registration |
| `infrastructure/ProcessManager.ts` | PID files, signal handlers |
| `infrastructure/CursorHooksInstaller.ts` | Cursor integration |
| `infrastructure/MCPClientManager.ts` | MCP client lifecycle |

---

## Part 4: Dependency Reduction Strategy

### Current Pain Points

1. **SessionStore** imported by 7+ files directly
2. No abstraction between routes and data access
3. All routes depend on `DatabaseManager` which exposes raw `SessionStore`

### Proposed Dependency Injection

```typescript
// infrastructure/container.ts
export interface ServiceContainer {
  sessions: SessionService;
  observations: ObservationService;
  summaries: SummaryService;
  search: SearchOrchestrator;
  agents: AgentFactory;
}

// Usage in routes
app.post('/sessions', (req, res) => {
  const { sessions } = getContainer();
  sessions.create(req.body);
});
```

---

## Part 5: Migration Strategy

### Incremental Approach

Each phase can be done independently without breaking the system:

1. **Create new modules** alongside existing code
2. **Migrate routes one at a time** to use new modules
3. **Deprecate old code** once all routes migrated
4. **Remove deprecated code** after testing

### Testing Requirements

- Unit tests for each extracted module
- Integration tests for repository operations
- End-to-end tests for API routes

---

## Appendix: File Size Distribution

```
2,034  src/services/worker-service.ts          ████████████████████
2,011  src/services/sqlite/SessionStore.ts     ████████████████████
1,778  src/services/worker/SearchManager.ts    █████████████████
  870  src/services/sync/ChromaSync.ts         ████████
  659  src/services/context-generator.ts       ██████
  625  src/services/worker/http/routes/SessionRoutes.ts  ██████
  599  src/services/worker/OpenRouterAgent.ts  █████
  574  src/services/worker/GeminiAgent.ts      █████
  546  src/services/worker/SDKAgent.ts         █████
  526  src/services/sqlite/SessionSearch.ts    █████
  509  src/services/sqlite/migrations.ts       █████
  466  src/services/worker/http/routes/DataRoutes.ts     ████
  447  src/services/sqlite/PendingMessageStore.ts        ████
  414  src/services/worker/http/routes/SettingsRoutes.ts ████
```

---

## Summary

| Metric | Current | After Refactor |
|--------|---------|----------------|
| Files >500 lines | 14 | 0-2 |
| Max file size | 2,034 | ~400 |
| Code duplication | ~1,100 lines | ~100 lines |
| Testable modules | Low | High |

**Recommended Start:** Phase 1 (SessionStore decomposition) - highest impact, clearest boundaries, and **growing** (now 2,011 lines with 49 methods).

### Key Observations Post-Merge

1. **SessionStore is still the top priority** - it grew by 108 lines and is now the 2nd largest file
2. **SearchManager improved** - down 178 lines from error handling refactor
3. **Agent files slightly smaller** - ~45 lines combined reduction
4. **Core architecture unchanged** - the proposed modular structure remains valid
