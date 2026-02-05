# Claude-Memu: AI Development Instructions

Claude-memu is a Claude Code plugin providing persistent memory across sessions. Supports two storage modes:
- **Local mode**: File-based JSON storage (no API key required)
- **API mode**: memU cloud/self-hosted API with semantic search

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
│  UnifiedStore (auto-selects based on API key)               │
├────────────────────────┬────────────────────────────────────┤
│  LocalStore            │  MemuStore                         │
│  (File-based JSON)     │  (memU API client)                 │
├────────────────────────┴────────────────────────────────────┤
│  ~/.claude-memu/data/  │  memU API (api.memu.so/self-hosted)│
└─────────────────────────────────────────────────────────────┘
```

## Core Components

**UnifiedStore** (`src/services/memu/UnifiedStore.ts`)
- Auto-selects storage backend based on configuration
- Common interface for both local and API modes
- Singleton pattern via `getStore()` / `initializeStore()`

**LocalStore** (`src/services/memu/LocalStore.ts`)
- File-based JSON storage in `~/.claude-memu/data/`
- Per-project JSON files (one file per project)
- Full-text search via substring matching
- No external dependencies

**MemuStore** (`src/services/memu/MemuStore.ts`)
- Primary storage service for memU API mode
- Session management (transient, per worker lifecycle)
- RAG-based semantic search
- Proactive context feature
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

## Storage Modes

| Mode | Description |
|------|-------------|
| `auto` | Use API if key provided, otherwise local (default) |
| `api` | Force memU API mode (requires API key) |
| `local` | Force local file-based storage |

## Configuration

Settings in `~/.claude-memu/settings.json`:

```json
{
  "CLAUDE_MEMU_MODE": "auto",
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
- **Local Data**: `~/.claude-memu/data/` (per-project JSON files)
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
- **memU API Key** (optional - only for API mode)

## Key APIs

### UnifiedStore (recommended)

```typescript
import { initializeStore, getStore } from './services/memu';

// Initialize (auto-selects local or API mode)
const store = await initializeStore();

// Check mode
console.log(store.getMode()); // 'local' or 'api'
console.log(store.isLocalMode()); // true/false

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
const results = await store.search({ text: 'query', project });

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
