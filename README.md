<h1 align="center">
  <br>
  Claude-Memu
  <br>
</h1>

<h4 align="center">Persistent memory for <a href="https://claude.com/claude-code" target="_blank">Claude Code</a> powered by <a href="https://github.com/NevaMind-AI/memU" target="_blank">memU</a>.</h4>

<p align="center">
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/License-AGPL%203.0-blue.svg" alt="License">
  </a>
  <a href="package.json">
    <img src="https://img.shields.io/badge/version-10.0.0-green.svg" alt="Version">
  </a>
  <a href="package.json">
    <img src="https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg" alt="Node">
  </a>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> •
  <a href="#how-it-works">How It Works</a> •
  <a href="#configuration">Configuration</a> •
  <a href="#api">API</a> •
  <a href="#license">License</a>
</p>

---

Claude-Memu seamlessly preserves context across Claude Code sessions using [memU](https://github.com/NevaMind-AI/memU) for hierarchical memory storage. It automatically captures observations, generates summaries, and injects relevant context into future sessions.

## Quick Start

### 1. Get a memU API Key

Sign up at [api.memu.so](https://api.memu.so) or deploy a self-hosted instance.

### 2. Install the Plugin

```bash
# In Claude Code
/plugin marketplace add thedotmack/claude-memu
/plugin install claude-memu
```

### 3. Configure

Set your API key in `~/.claude-memu/settings.json`:

```json
{
  "CLAUDE_MEMU_API_KEY": "your-api-key-here"
}
```

Or via environment variable:

```bash
export CLAUDE_MEMU_API_KEY="your-api-key-here"
```

### 4. Restart Claude Code

Context from previous sessions will automatically appear in new sessions.

---

## Features

- **Persistent Memory** - Context survives across sessions via memU cloud
- **Proactive Context** - memU's LLM-powered context retrieval
- **Semantic Search** - RAG-based memory queries
- **Project Isolation** - Memories organized by project categories
- **Privacy Control** - Use `<private>` tags to exclude sensitive content
- **Zero Local Storage** - All data stored in memU (cloud or self-hosted)

---

## How It Works

```
┌─────────────────────────────────────────────────────────────┐
│                    Claude Code Plugin                        │
├─────────────────────────────────────────────────────────────┤
│  Hooks (5 Lifecycle Events)                                 │
│  SessionStart → UserPromptSubmit → PostToolUse → Summary    │
├─────────────────────────────────────────────────────────────┤
│  Worker Service (Express on :37777)                         │
├─────────────────────────────────────────────────────────────┤
│  MemuStore (Session, Observation, Summary management)       │
├─────────────────────────────────────────────────────────────┤
│  MemuClient (HTTP client for memU API)                      │
├─────────────────────────────────────────────────────────────┤
│                    memU API                                 │
│           (api.memu.so or self-hosted)                      │
└─────────────────────────────────────────────────────────────┘
```

### Core Components

1. **Lifecycle Hooks** - Capture tool usage at key moments
2. **Worker Service** - HTTP API on port 37777
3. **MemuStore** - Primary storage service for all memory operations
4. **MemuClient** - HTTP client for memU API
5. **memU** - Hierarchical memory storage with RAG retrieval

### Data Flow

1. **SessionStart** - Retrieve relevant context from memU
2. **UserPromptSubmit** - Create session record
3. **PostToolUse** - Store observations as memU items
4. **Stop** - Generate and store session summary

---

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

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `CLAUDE_MEMU_API_KEY` | memU API key (required) | - |
| `CLAUDE_MEMU_API_URL` | memU API URL | `https://api.memu.so` |
| `CLAUDE_MEMU_NAMESPACE` | Namespace for isolation | `default` |
| `CLAUDE_MEMU_WORKER_PORT` | Worker service port | `37777` |
| `CLAUDE_MEMU_CONTEXT_LIMIT` | Max items in context | `20` |
| `CLAUDE_MEMU_PROACTIVE_CONTEXT` | Enable proactive context | `true` |

---

## API

### MemuStore

```typescript
import { initializeMemuStore } from './services/memu';

const store = await initializeMemuStore();

// Sessions
const session = await store.createSession(contentSessionId, project, prompt);

// Observations
await store.storeObservation(memorySessionId, project, {
  type: 'decision',
  title: 'Chose React over Vue',
  facts: ['Better TypeScript support', 'Larger ecosystem'],
  concepts: ['architecture', 'framework'],
  filesModified: ['package.json'],
});

// Summaries
await store.storeSummary(memorySessionId, project, {
  request: 'Set up frontend framework',
  completed: 'Installed React with TypeScript',
  learned: 'React has better TS integration',
});

// Search
const results = await store.search({
  text: 'authentication',
  project: 'my-project',
  method: 'rag',
  limit: 20,
});

// Context Injection
const context = await store.getContextForProject(project, 10);
```

### MemuClient

```typescript
import { createMemuClient } from './services/memu';

const client = createMemuClient({
  apiKey: 'your-key',
  apiUrl: 'https://api.memu.so',
  namespace: 'default',
});

// Retrieve memories
const response = await client.retrieve({
  queries: [{ role: 'user', content: 'authentication bugs' }],
  method: 'rag',
  limit: 20,
});

// Create memory item
await client.createItem({
  memoryType: 'decision',
  content: 'Chose JWT for auth',
  tags: ['security', 'architecture'],
});

// List categories (projects)
const categories = await client.listCategories();
```

---

## memU Concepts

| Claude-Memu | memU |
|-------------|------|
| Project | Category |
| Observation | Item |
| Summary | Item (tagged as summary) |
| User Prompt | Item (conversation type) |

### Tags Convention

- `session:{id}` - Links item to session
- `project:{name}` - Links item to project
- `type:{type}` - Observation type (decision, bugfix, etc.)
- `summary` - Marks item as session summary

---

## System Requirements

- **Node.js** 18.0.0+
- **Bun** (auto-installed)
- **memU API Key** from [api.memu.so](https://api.memu.so) or self-hosted

---

## Privacy

Use `<private>` tags to exclude content from storage:

```
<private>
API_KEY=secret123
</private>
```

Content within these tags is stripped at the hook layer before reaching memU.

---

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Build and sync to marketplace
npm run build-and-sync
```

---

## License

**GNU Affero General Public License v3.0** (AGPL-3.0)

See [LICENSE](LICENSE) for details.

---

## Links

- **memU**: [github.com/NevaMind-AI/memU](https://github.com/NevaMind-AI/memU)
- **Issues**: [GitHub Issues](https://github.com/thedotmack/claude-memu/issues)

---

**Powered by [memU](https://github.com/NevaMind-AI/memU)** | **Built for Claude Code**
