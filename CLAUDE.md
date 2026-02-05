# Claude-Memu: AI Development Instructions

Claude-memu is a Claude Code plugin providing persistent memory across sessions using [memU](https://github.com/NevaMind-AI/memU) for hierarchical memory storage.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Claude Code Plugin                        │
├─────────────────────────────────────────────────────────────┤
│  Hooks (5 Lifecycle Events)                                 │
│  SessionStart → UserPromptSubmit → PostToolUse → Summary    │
├─────────────────────────────────────────────────────────────┤
│  Worker Service (Express on :37777)                         │
├─────────────────────────────────────────────────────────────┤
│  MemuStore (src/services/memu/MemuStore.ts)                │
├─────────────────────────────────────────────────────────────┤
│  MemuClient (src/services/memu/memu-client.ts)             │
├─────────────────────────────────────────────────────────────┤
│                    memU API                                 │
│           (api.memu.so or self-hosted)                      │
└─────────────────────────────────────────────────────────────┘
```

## Core Components

**MemuStore** (`src/services/memu/MemuStore.ts`)
- Primary storage service for all memory operations
- Session management (transient, per worker lifecycle)
- Observation and summary CRUD
- Search with proactive context
- Project category management

**MemuClient** (`src/services/memu/memu-client.ts`)
- HTTP client for memU API
- Supports cloud (api.memu.so) or self-hosted
- Methods: memorize, retrieve, categories, items

**Types** (`src/services/memu/types.ts`)
- Session, Observation, Summary, UserPrompt types
- SearchQuery, SearchResults, ContextPayload
- memU API request/response types

## memU Concepts

**Categories** → Projects (one category per project)
**Items** → Observations, Summaries, User Prompts
**Tags** → `session:`, `project:`, `type:`, concepts
**Retrieve** → RAG or LLM method with proactive context

## Configuration

Settings in `~/.claude-memu/settings.json`:

```json
{
  "CLAUDE_MEMU_API_KEY": "your-api-key",
  "CLAUDE_MEMU_API_URL": "https://api.memu.so",
  "CLAUDE_MEMU_NAMESPACE": "default",
  "CLAUDE_MEMU_WORKER_PORT": "37777",
  "CLAUDE_MEMU_CONTEXT_LIMIT": "20",
  "CLAUDE_MEMU_PROACTIVE_CONTEXT": "true"
}
```

Environment variables override file settings.

## File Locations

- **Source**: `src/`
- **Built Plugin**: `plugin/`
- **Settings**: `~/.claude-memu/settings.json`
- **Logs**: `~/.claude-memu/logs/`

## Build Commands

```bash
npm run build-and-sync        # Build and sync to marketplace
npm run build                 # TypeScript compilation only
```

## Privacy Tags

`<private>content</private>` - Content stripped at hook layer before reaching memU.

## Exit Codes

- **0**: Success
- **1**: Non-blocking error (shown to user)
- **2**: Blocking error (fed to Claude)

## Requirements

- **Bun** (auto-installed)
- **Node.js** 18+
- **memU API Key** (from api.memu.so or self-hosted)

## Key APIs

### MemuStore

```typescript
// Initialize
const store = await initializeMemuStore();

// Sessions
const session = await store.createSession(contentSessionId, project, prompt);
store.incrementPromptCounter(sessionId);

// Observations
await store.storeObservation(memorySessionId, project, observation);
const recent = await store.getRecentObservations(project, 20);

// Summaries
await store.storeSummary(memorySessionId, project, summary);
const summary = await store.getSummary(memorySessionId);

// Search
const results = await store.search({ text: 'query', project, method: 'rag' });

// Context Injection
const context = await store.getContextForProject(project, 10);
```

### MemuClient

```typescript
// Create client
const client = createMemuClient({ apiKey, apiUrl, namespace });

// Memorize (continuous learning)
const task = await client.memorize({ content, modality: 'conversation' });

// Retrieve (query)
const response = await client.retrieve({
  queries: [{ role: 'user', content: 'query' }],
  method: 'rag',
  limit: 20
});

// Categories
const categories = await client.listCategories();
await client.createCategory({ name: project, description });

// Items
await client.createItem({ memoryType: 'decision', content, tags });
```

## Important

No need to edit the changelog - it's generated automatically.
