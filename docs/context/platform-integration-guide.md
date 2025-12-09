# Platform Integration Guide - Claude-Mem Worker Service

**Version:** 7.0.0 (December 2025)
**Target Audience:** Developers building claude-mem integrations (VSCode extensions, IDE plugins, CLI tools)
**Purpose:** Complete reference for integrating with the claude-mem worker service without requiring access to the knowledge base

---

## Table of Contents

1. [Quick Reference](#quick-reference)
2. [Worker Architecture](#worker-architecture)
3. [API Reference](#api-reference)
4. [Data Models](#data-models)
5. [Integration Patterns](#integration-patterns)
6. [Error Handling & Resilience](#error-handling--resilience)
7. [Development Workflow](#development-workflow)
8. [Testing Strategy](#testing-strategy)
9. [Code Examples](#code-examples)

---

## Quick Reference

### Worker Service Basics

```typescript
const WORKER_BASE_URL = 'http://localhost:37777';
const DEFAULT_PORT = 37777; // Override with CLAUDE_MEM_WORKER_PORT
```

### Most Common Operations

```typescript
// Health check
GET /api/health

// Create/get session and queue observation
POST /api/sessions/observations
Body: { claudeSessionId, tool_name, tool_input, tool_response, cwd }

// Queue summary
POST /api/sessions/summarize
Body: { claudeSessionId, last_user_message, last_assistant_message }

// Complete session
POST /api/sessions/complete
Body: { claudeSessionId }

// Search observations
GET /api/search?query=authentication&type=observations&format=index&limit=20

// Get recent context for project
GET /api/context/recent?project=my-project&limit=3
```

### Environment Variables

```bash
CLAUDE_MEM_MODEL=claude-haiku-4-5           # Model for observations/summaries
CLAUDE_MEM_CONTEXT_OBSERVATIONS=50          # Observations injected at SessionStart
CLAUDE_MEM_WORKER_PORT=37777                # Worker service port
CLAUDE_MEM_PYTHON_VERSION=3.13              # Python version for chroma-mcp
```

### Build Commands (Local Development)

```bash
npm run build                 # Compile TypeScript (hooks + worker)
npm run sync-marketplace      # Copy to ~/.claude/plugins
npm run worker:restart        # Restart PM2 worker
npm run worker:logs           # View worker logs
pm2 list                      # Check worker status
```

---

## Worker Architecture

### Request Flow

```
Platform Hook/Extension
  → HTTP Request to Worker (localhost:37777)
    → Route Handler (SessionRoutes/DataRoutes/SearchRoutes/etc.)
      → Domain Service (SessionManager/SearchManager/DatabaseManager)
        → Database (SQLite3 + Chroma vector DB)
          → SSE Broadcast (real-time UI updates)
```

### Domain Services

**DatabaseManager** - SQLite connection management, initialization
**SessionManager** - Event-driven session lifecycle, message queues
**SearchManager** - Search orchestration (FTS5 + Chroma)
**SSEBroadcaster** - Server-Sent Events for real-time updates
**SDKAgent** - Claude Agent SDK for generating observations/summaries
**PaginationHelper** - Query pagination utilities
**SettingsManager** - User settings CRUD
**FormattingService** - Result formatting (index vs full)
**TimelineService** - Unified timeline generation

### Route Organization

**ViewerRoutes** - Health check, viewer UI, SSE stream
**SessionRoutes** - Session lifecycle (init, observations, summarize, complete)
**DataRoutes** - Data retrieval (observations, summaries, prompts, stats)
**SearchRoutes** - All search operations (unified search, timeline, semantic shortcuts)
**SettingsRoutes** - User settings, MCP toggle, branch switching

---

## API Reference

### Session Lifecycle (SessionRoutes)

#### Create/Get Session + Queue Observation (New API)
```http
POST /api/sessions/observations
Content-Type: application/json

{
  "claudeSessionId": "abc123",      // Claude session identifier (string)
  "tool_name": "Bash",
  "tool_input": { "command": "ls" },
  "tool_response": { "stdout": "..." },
  "cwd": "/path/to/project"
}

Response: { "status": "queued" } | { "status": "skipped", "reason": "private" }
```

**Privacy Check:** Skips if user prompt was entirely wrapped in `<private>` tags.
**Tag Stripping:** Removes `<private>` and `<claude-mem-context>` tags before storage.
**Auto-Start:** Ensures SDK agent generator is running to process the queue.

#### Queue Summary (New API)
```http
POST /api/sessions/summarize
Content-Type: application/json

{
  "claudeSessionId": "abc123",
  "last_user_message": "User's message",
  "last_assistant_message": "Assistant's response"
}

Response: { "status": "queued" } | { "status": "skipped", "reason": "private" }
```

#### Complete Session (New API)
```http
POST /api/sessions/complete
Content-Type: application/json

{
  "claudeSessionId": "abc123"
}

Response: { "success": true } | { "success": true, "message": "No active session found" }
```

**Effect:** Stops SDK agent, marks session complete, broadcasts status change.

#### Legacy Endpoints (Still Supported)

```http
# Initialize session (legacy, uses sessionDbId)
POST /sessions/:sessionDbId/init
Body: { userPrompt, promptNumber }

# Queue observations (legacy)
POST /sessions/:sessionDbId/observations
Body: { tool_name, tool_input, tool_response, prompt_number, cwd }

# Queue summary (legacy)
POST /sessions/:sessionDbId/summarize
Body: { last_user_message, last_assistant_message }

# Complete session (legacy)
POST /sessions/:sessionDbId/complete
```

**Note:** New integrations should use `/api/sessions/*` endpoints with `claudeSessionId`.

---

### Data Retrieval (DataRoutes)

#### Get Paginated Observations
```http
GET /api/observations?offset=0&limit=20&project=my-project

Response: {
  "items": [...],
  "hasMore": boolean,
  "offset": number,
  "limit": number
}
```

#### Get Paginated Summaries
```http
GET /api/summaries?offset=0&limit=20&project=my-project
```

#### Get Paginated User Prompts
```http
GET /api/prompts?offset=0&limit=20&project=my-project
```

#### Get by ID
```http
GET /api/observation/:id
GET /api/session/:id
GET /api/prompt/:id

Response: {...entity...} | 404 Not Found
```

#### Get Database Stats
```http
GET /api/stats

Response: {
  "worker": {
    "version": "7.0.0",
    "uptime": 12345,
    "activeSessions": 2,
    "sseClients": 1,
    "port": 37777
  },
  "database": {
    "path": "~/.claude-mem/claude-mem.db",
    "size": 1048576,
    "observations": 500,
    "sessions": 50,
    "summaries": 25
  }
}
```

#### Get Projects List
```http
GET /api/projects

Response: { "projects": ["claude-mem", "other-project", ...] }
```

#### Get Processing Status
```http
GET /api/processing-status

Response: { "isProcessing": boolean, "queueDepth": number }
```

---

### Search Operations (SearchRoutes)

#### Unified Search
```http
GET /api/search?query=authentication&type=observations&format=index&limit=20

Parameters:
- query: Search query text (optional, omit for filter-only)
- type: "observations" | "sessions" | "prompts" (default: all)
- format: "index" | "full" (default: "index")
- limit: Number of results (default: 20)
- project: Filter by project name
- obs_type: Filter by observation type (discovery, decision, bugfix, feature, refactor)
- concepts: Filter by concepts (comma-separated)
- files: Filter by file paths (comma-separated)
- dateStart: ISO timestamp (filter start)
- dateEnd: ISO timestamp (filter end)

Response: {
  "observations": [...],
  "sessions": [...],
  "prompts": [...]
}
```

**Format Options:**
- `index`: Minimal fields for list display (id, title, preview)
- `full`: Complete entity with all fields

#### Unified Timeline
```http
GET /api/timeline?anchor=123&depth_before=10&depth_after=10&project=my-project

Parameters:
- anchor: Anchor point (observation ID, "S123" for session, or ISO timestamp)
- depth_before: Records before anchor (default: 10)
- depth_after: Records after anchor (default: 10)
- project: Filter by project

Response: [
  { "type": "observation", "id": 120, "created_at_epoch": ..., ... },
  { "type": "session", "id": 5, "created_at_epoch": ..., ... },
  { "type": "observation", "id": 123, "created_at_epoch": ..., ... },
  ...
]
```

#### Semantic Shortcuts
```http
# Find decision observations
GET /api/decisions?format=index&limit=20

# Find change-related observations
GET /api/changes?format=index&limit=20

# Find "how it works" explanations
GET /api/how-it-works?format=index&limit=20
```

#### Search by Concept
```http
GET /api/search/by-concept?concept=discovery&format=index&limit=10&project=my-project
```

#### Search by File Path
```http
GET /api/search/by-file?filePath=src/services/worker-service.ts&format=index&limit=10
```

#### Search by Type
```http
GET /api/search/by-type?type=bugfix&format=index&limit=10
```

#### Get Recent Context
```http
GET /api/context/recent?project=my-project&limit=3

Response: {
  "summaries": [...],
  "observations": [...]
}
```

#### Context Preview (for Settings UI)
```http
GET /api/context/preview?project=my-project

Response: Plain text with ANSI colors (for terminal display)
```

#### Context Injection (for Hooks)
```http
GET /api/context/inject?project=my-project&colors=true

Response: Pre-formatted context string ready for display
```

---

### Settings & Configuration (SettingsRoutes)

#### Get/Update User Settings
```http
GET /api/settings
Response: { "sidebarOpen": boolean, "selectedProject": string | null }

POST /api/settings
Body: { "sidebarOpen": true, "selectedProject": "my-project" }
Response: { "success": true }
```

#### MCP Server Status/Toggle
```http
GET /api/mcp/status
Response: { "enabled": boolean }

POST /api/mcp/toggle
Body: { "enabled": true }
Response: { "success": true, "enabled": boolean }
```

#### Git Branch Operations
```http
GET /api/branch/status
Response: { "current": "main", "remote": "origin/main", "ahead": 0, "behind": 0 }

POST /api/branch/switch
Body: { "branch": "feature/new-feature" }
Response: { "success": true }

POST /api/branch/update
Response: { "success": true, "updated": boolean }
```

---

### Viewer & Real-Time Updates (ViewerRoutes)

#### Health Check
```http
GET /api/health

Response: { "status": "ok" }
```

#### Viewer UI
```http
GET /

Response: HTML (React app)
```

#### SSE Stream
```http
GET /stream

Response: Server-Sent Events stream

Event Types:
- processing_status: { type, isProcessing, queueDepth }
- session_started: { type, sessionDbId, project }
- observation_queued: { type, sessionDbId }
- summarize_queued: { type }
- observation_created: { type, observation }
- summary_created: { type, summary }
- new_prompt: { type, id, claude_session_id, project, prompt_number, prompt_text, created_at_epoch }
```

---

## Data Models

### Active Session (In-Memory)

```typescript
interface ActiveSession {
  sessionDbId: number;                  // Database ID (numeric)
  claudeSessionId: string;              // Claude session identifier (string)
  sdkSessionId: string | null;          // SDK session ID
  project: string;                      // Project name
  userPrompt: string;                   // Current user prompt text
  pendingMessages: PendingMessage[];    // Queue of pending operations
  abortController: AbortController;     // For cancellation
  generatorPromise: Promise<void> | null; // SDK agent promise
  lastPromptNumber: number;             // Last processed prompt number
  startTime: number;                    // Session start timestamp
  cumulativeInputTokens: number;        // Total input tokens
  cumulativeOutputTokens: number;       // Total output tokens
}

interface PendingMessage {
  type: 'observation' | 'summarize';
  tool_name?: string;
  tool_input?: any;
  tool_response?: any;
  prompt_number?: number;
  cwd?: string;
  last_user_message?: string;
  last_assistant_message?: string;
}
```

### Database Entities

```typescript
// SDK Session (stored in sdk_sessions table)
interface SDKSessionRow {
  id: number;
  claude_session_id: string;
  sdk_session_id: string;
  project: string;
  user_prompt: string;
  created_at_epoch: number;
  completed_at_epoch?: number;
}

// Observation (stored in observations table)
interface ObservationRow {
  id: number;
  sdk_session_id: string;
  title: string;
  subtitle?: string;
  summary: string;
  facts: string;           // JSON array of fact strings
  concepts: string;        // JSON array of concept strings
  files_touched: string;   // JSON array of file paths
  obs_type: string;        // discovery, decision, bugfix, feature, refactor
  project: string;
  created_at_epoch: number;
  prompt_number: number;
}

// Session Summary (stored in session_summaries table)
interface SessionSummaryRow {
  id: number;
  sdk_session_id: string;
  summary_text: string;
  facts: string;           // JSON array
  concepts: string;        // JSON array
  files_touched: string;   // JSON array
  project: string;
  created_at_epoch: number;
}

// User Prompt (stored in user_prompts table)
interface UserPromptRow {
  id: number;
  claude_session_id: string;
  sdk_session_id: string;
  project: string;
  prompt_number: number;
  prompt_text: string;
  created_at_epoch: number;
}
```

### Search Results

```typescript
interface ObservationSearchResult {
  id: number;
  title: string;
  subtitle?: string;
  summary: string;
  facts: string[];         // Parsed from JSON
  concepts: string[];      // Parsed from JSON
  files_touched: string[]; // Parsed from JSON
  obs_type: string;
  project: string;
  created_at_epoch: number;
  prompt_number: number;
  rank?: number;           // FTS5 rank score
}

interface SessionSummarySearchResult {
  id: number;
  summary_text: string;
  facts: string[];
  concepts: string[];
  files_touched: string[];
  project: string;
  created_at_epoch: number;
  rank?: number;
}

interface UserPromptSearchResult {
  id: number;
  claude_session_id: string;
  project: string;
  prompt_number: number;
  prompt_text: string;
  created_at_epoch: number;
  rank?: number;
}
```

### Timeline Item

```typescript
interface TimelineItem {
  type: 'observation' | 'session' | 'prompt';
  id: number;
  created_at_epoch: number;
  // Entity-specific fields based on type
}
```

---

## Integration Patterns

### Mapping Claude Code Hooks to Worker API

#### SessionStart Hook
```typescript
// Not needed for new API - sessions are auto-created on first observation
```

#### UserPromptSubmit Hook
```typescript
// No API call needed - user_prompt is captured by first observation in the prompt
```

#### PostToolUse Hook
```typescript
async function onPostToolUse(context: HookContext) {
  const { session_id, tool_name, tool_input, tool_result, cwd } = context;

  const response = await fetch('http://localhost:37777/api/sessions/observations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      claudeSessionId: session_id,
      tool_name,
      tool_input,
      tool_response: tool_result,
      cwd
    })
  });

  const result = await response.json();
  // result.status === 'queued' | 'skipped'
}
```

#### Summary Hook
```typescript
async function onSummary(context: HookContext) {
  const { session_id, last_user_message, last_assistant_message } = context;

  await fetch('http://localhost:37777/api/sessions/summarize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      claudeSessionId: session_id,
      last_user_message,
      last_assistant_message
    })
  });
}
```

#### SessionEnd Hook
```typescript
async function onSessionEnd(context: HookContext) {
  const { session_id } = context;

  await fetch('http://localhost:37777/api/sessions/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      claudeSessionId: session_id
    })
  });
}
```

### VSCode Extension Integration

#### Language Model Tool Registration

```typescript
import * as vscode from 'vscode';

interface SearchTool extends vscode.LanguageModelChatTool {
  invoke(
    options: vscode.LanguageModelToolInvocationOptions<{ query: string }>,
    token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.LanguageModelToolResult>;
}

const searchTool: SearchTool = {
  invoke: async (options, token) => {
    const { query } = options.input;

    try {
      const response = await fetch(
        `http://localhost:37777/api/search?query=${encodeURIComponent(query)}&format=index&limit=10`
      );

      if (!response.ok) {
        throw new Error(`Search failed: ${response.statusText}`);
      }

      const results = await response.json();

      // Format results for language model
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(JSON.stringify(results, null, 2))
      ]);
    } catch (error) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Error: ${error.message}`)
      ]);
    }
  }
};

// Register tool
vscode.lm.registerTool('claude-mem-search', searchTool);
```

#### Chat Participant Implementation

```typescript
const participant = vscode.chat.createChatParticipant('claude-mem', async (request, context, stream, token) => {
  const claudeSessionId = context.session.id;

  // First message in conversation - no initialization needed
  // Session is auto-created on first observation

  // Process user message
  stream.markdown(`Searching memory for: ${request.prompt}\n\n`);

  const response = await fetch(
    `http://localhost:37777/api/search?query=${encodeURIComponent(request.prompt)}&format=index&limit=5`
  );

  const results = await response.json();

  if (results.observations?.length > 0) {
    stream.markdown('**Found observations:**\n');
    for (const obs of results.observations) {
      stream.markdown(`- ${obs.title} (${obs.project})\n`);
    }
  }

  return { metadata: { command: 'search' } };
});
```

---

## Error Handling & Resilience

### Connection Failures

```typescript
async function callWorkerWithFallback<T>(
  endpoint: string,
  options?: RequestInit
): Promise<T | null> {
  try {
    const response = await fetch(`http://localhost:37777${endpoint}`, {
      ...options,
      signal: AbortSignal.timeout(5000) // 5s timeout
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    console.error(`Worker unavailable (${endpoint}):`, error);
    return null; // Graceful degradation
  }
}
```

### Retry Logic with Exponential Backoff

```typescript
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelay = 100
): Promise<T> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxRetries - 1) throw error;

      const delay = baseDelay * Math.pow(2, attempt);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw new Error('Max retries exceeded');
}
```

### Worker Health Check

```typescript
async function isWorkerHealthy(): Promise<boolean> {
  try {
    const response = await fetch('http://localhost:37777/api/health', {
      signal: AbortSignal.timeout(2000)
    });
    return response.ok;
  } catch {
    return false;
  }
}
```

### Privacy Tag Handling

The worker automatically strips privacy tags before storage:
- `<private>content</private>` - User-level privacy control
- `<claude-mem-context>content</claude-mem-context>` - System-level tag (prevents recursive storage)

**Privacy Check:** Observations/summaries are skipped if the entire user prompt was wrapped in `<private>` tags.

### Custom Error Classes

```typescript
class WorkerUnavailableError extends Error {
  constructor() {
    super('Claude-mem worker is not running or unreachable');
    this.name = 'WorkerUnavailableError';
  }
}

class WorkerTimeoutError extends Error {
  constructor(endpoint: string) {
    super(`Worker request timed out: ${endpoint}`);
    this.name = 'WorkerTimeoutError';
  }
}
```

### SSE Stream Error Handling

```typescript
function connectToSSE(onEvent: (event: any) => void) {
  const eventSource = new EventSource('http://localhost:37777/stream');

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      onEvent(data);
    } catch (error) {
      console.error('SSE parse error:', error);
    }
  };

  eventSource.onerror = (error) => {
    console.error('SSE connection error:', error);
    eventSource.close();

    // Reconnect after 5 seconds
    setTimeout(() => connectToSSE(onEvent), 5000);
  };

  return eventSource;
}
```

---

## Development Workflow

### Project Structure (Recommended)

```
vscode-extension/
├── src/
│   ├── extension.ts              # Extension entry point
│   ├── services/
│   │   ├── WorkerClient.ts       # HTTP client for worker
│   │   └── MemoryManager.ts      # High-level memory operations
│   ├── chat/
│   │   └── participant.ts        # Chat participant implementation
│   └── tools/
│       ├── search.ts             # Search language model tool
│       └── context.ts            # Context injection tool
├── package.json
├── tsconfig.json
└── README.md
```

### Build Configuration (esbuild)

```javascript
// build.js
const esbuild = require('esbuild');

esbuild.build({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true
}).catch(() => process.exit(1));
```

### package.json (VSCode Extension)

```json
{
  "name": "claude-mem-vscode",
  "displayName": "Claude-Mem",
  "version": "1.0.0",
  "engines": {
    "vscode": "^1.95.0"
  },
  "activationEvents": [
    "onStartupFinished"
  ],
  "main": "./dist/extension.js",
  "contributes": {
    "chatParticipants": [
      {
        "id": "claude-mem",
        "name": "memory",
        "description": "Search your persistent memory"
      }
    ],
    "languageModelTools": [
      {
        "name": "claude-mem-search",
        "displayName": "Search Memory",
        "description": "Search persistent memory for observations, sessions, and prompts"
      }
    ]
  },
  "scripts": {
    "build": "node build.js",
    "watch": "node build.js --watch",
    "package": "vsce package"
  },
  "devDependencies": {
    "@types/vscode": "^1.95.0",
    "esbuild": "^0.19.0",
    "typescript": "^5.3.0"
  }
}
```

### Local Testing Loop

```bash
# Terminal 1: Watch build
npm run watch

# Terminal 2: Check worker status
pm2 list
pm2 logs claude-mem-worker

# Terminal 3: Test API manually
curl http://localhost:37777/api/health
curl "http://localhost:37777/api/search?query=test&limit=5"

# VSCode: Press F5 to launch extension host
```

### Debug Configuration (.vscode/launch.json)

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Run Extension",
      "type": "extensionHost",
      "request": "launch",
      "args": [
        "--extensionDevelopmentPath=${workspaceFolder}"
      ],
      "outFiles": [
        "${workspaceFolder}/dist/**/*.js"
      ],
      "preLaunchTask": "npm: build"
    }
  ]
}
```

---

## Testing Strategy

### Unit Tests (Worker Client)

```typescript
import { describe, it, expect } from 'vitest';
import { WorkerClient } from '../src/services/WorkerClient';

describe('WorkerClient', () => {
  it('should check worker health', async () => {
    const client = new WorkerClient();
    const healthy = await client.isHealthy();
    expect(healthy).toBe(true);
  });

  it('should queue observation', async () => {
    const client = new WorkerClient();
    const result = await client.queueObservation({
      claudeSessionId: 'test-123',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_response: { stdout: 'file1.txt' },
      cwd: '/tmp'
    });
    expect(result.status).toBe('queued');
  });

  it('should search observations', async () => {
    const client = new WorkerClient();
    const results = await client.search({ query: 'test', limit: 5 });
    expect(results).toHaveProperty('observations');
  });
});
```

### Integration Tests (With Worker Spawning)

```typescript
import { spawn } from 'child_process';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

describe('Worker Integration', () => {
  let workerProcess: ReturnType<typeof spawn>;

  beforeAll(async () => {
    // Start worker process
    workerProcess = spawn('node', ['dist/worker-service.js'], {
      env: { ...process.env, CLAUDE_MEM_WORKER_PORT: '37778' }
    });

    // Wait for worker to be ready
    await new Promise(resolve => setTimeout(resolve, 2000));
  });

  afterAll(() => {
    workerProcess.kill();
  });

  it('should respond to health check', async () => {
    const response = await fetch('http://localhost:37778/api/health');
    expect(response.ok).toBe(true);
  });
});
```

### Manual Testing Checklist

**Phase 1: Connection & Health**
- [ ] Worker starts successfully (`pm2 list`)
- [ ] Health endpoint responds (`curl http://localhost:37777/api/health`)
- [ ] SSE stream connects (`curl http://localhost:37777/stream`)

**Phase 2: Session Lifecycle**
- [ ] Queue observation creates session
- [ ] Observation appears in database
- [ ] Privacy tags are stripped
- [ ] Private prompts are skipped
- [ ] Queue summary creates summary
- [ ] Complete session stops processing

**Phase 3: Search & Retrieval**
- [ ] Search observations by query
- [ ] Search sessions by query
- [ ] Search prompts by query
- [ ] Get recent context for project
- [ ] Get timeline around observation
- [ ] Semantic shortcuts (decisions, changes, how-it-works)

**Phase 4: Real-Time Updates**
- [ ] SSE broadcasts processing status
- [ ] SSE broadcasts new observations
- [ ] SSE broadcasts new summaries
- [ ] SSE broadcasts new prompts

**Phase 5: Error Handling**
- [ ] Graceful degradation when worker unavailable
- [ ] Timeout handling for slow requests
- [ ] Retry logic for transient failures

---

## Code Examples

### Complete WorkerClient Implementation

```typescript
export class WorkerClient {
  private baseUrl: string;

  constructor(port: number = 37777) {
    this.baseUrl = `http://localhost:${port}`;
  }

  async isHealthy(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/health`, {
        signal: AbortSignal.timeout(2000)
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async queueObservation(data: {
    claudeSessionId: string;
    tool_name: string;
    tool_input: any;
    tool_response: any;
    cwd?: string;
  }): Promise<{ status: string; reason?: string }> {
    const response = await fetch(`${this.baseUrl}/api/sessions/observations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(5000)
    });

    if (!response.ok) {
      throw new Error(`Failed to queue observation: ${response.statusText}`);
    }

    return await response.json();
  }

  async queueSummarize(data: {
    claudeSessionId: string;
    last_user_message?: string;
    last_assistant_message?: string;
  }): Promise<{ status: string; reason?: string }> {
    const response = await fetch(`${this.baseUrl}/api/sessions/summarize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(5000)
    });

    if (!response.ok) {
      throw new Error(`Failed to queue summary: ${response.statusText}`);
    }

    return await response.json();
  }

  async completeSession(claudeSessionId: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/sessions/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claudeSessionId }),
      signal: AbortSignal.timeout(5000)
    });

    if (!response.ok) {
      throw new Error(`Failed to complete session: ${response.statusText}`);
    }
  }

  async search(params: {
    query?: string;
    type?: 'observations' | 'sessions' | 'prompts';
    format?: 'index' | 'full';
    limit?: number;
    project?: string;
    obs_type?: string | string[];
    concepts?: string | string[];
    files?: string | string[];
    dateStart?: string;
    dateEnd?: string;
  }): Promise<any> {
    const queryString = new URLSearchParams(
      Object.entries(params)
        .filter(([_, v]) => v !== undefined)
        .map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : String(v)])
    ).toString();

    const response = await fetch(
      `${this.baseUrl}/api/search?${queryString}`,
      { signal: AbortSignal.timeout(10000) }
    );

    if (!response.ok) {
      throw new Error(`Search failed: ${response.statusText}`);
    }

    return await response.json();
  }

  async getRecentContext(project: string, limit: number = 3): Promise<any> {
    const response = await fetch(
      `${this.baseUrl}/api/context/recent?project=${encodeURIComponent(project)}&limit=${limit}`,
      { signal: AbortSignal.timeout(10000) }
    );

    if (!response.ok) {
      throw new Error(`Get recent context failed: ${response.statusText}`);
    }

    return await response.json();
  }

  async getTimeline(params: {
    anchor: number | string;
    depth_before?: number;
    depth_after?: number;
    project?: string;
  }): Promise<any> {
    const queryString = new URLSearchParams(
      Object.entries(params)
        .filter(([_, v]) => v !== undefined)
        .map(([k, v]) => [k, String(v)])
    ).toString();

    const response = await fetch(
      `${this.baseUrl}/api/timeline?${queryString}`,
      { signal: AbortSignal.timeout(10000) }
    );

    if (!response.ok) {
      throw new Error(`Get timeline failed: ${response.statusText}`);
    }

    return await response.json();
  }

  connectSSE(onEvent: (event: any) => void): EventSource {
    const eventSource = new EventSource(`${this.baseUrl}/stream`);

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        onEvent(data);
      } catch (error) {
        console.error('SSE parse error:', error);
      }
    };

    eventSource.onerror = (error) => {
      console.error('SSE connection error:', error);
    };

    return eventSource;
  }
}
```

### Search Language Model Tool

```typescript
import * as vscode from 'vscode';
import { WorkerClient } from './WorkerClient';

export function registerSearchTool(context: vscode.ExtensionContext) {
  const client = new WorkerClient();

  const searchTool = vscode.lm.registerTool('claude-mem-search', {
    description: 'Search persistent memory for observations, sessions, and prompts',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query text'
        },
        type: {
          type: 'string',
          enum: ['observations', 'sessions', 'prompts'],
          description: 'Type of results to return'
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results',
          default: 10
        }
      },
      required: ['query']
    },
    invoke: async (options, token) => {
      const { query, type, limit = 10 } = options.input;

      try {
        const results = await client.search({
          query,
          type,
          format: 'index',
          limit
        });

        // Format results for language model
        let formatted = '';

        if (results.observations?.length > 0) {
          formatted += '## Observations\n\n';
          for (const obs of results.observations) {
            formatted += `- **${obs.title}** (${obs.project})\n`;
            formatted += `  ${obs.summary}\n`;
            if (obs.concepts?.length > 0) {
              formatted += `  Concepts: ${obs.concepts.join(', ')}\n`;
            }
            formatted += '\n';
          }
        }

        if (results.sessions?.length > 0) {
          formatted += '## Sessions\n\n';
          for (const session of results.sessions) {
            formatted += `- ${session.summary_text.substring(0, 100)}...\n\n`;
          }
        }

        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(formatted)
        ]);
      } catch (error) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(`Error: ${error.message}`)
        ]);
      }
    }
  });

  context.subscriptions.push(searchTool);
}
```

---

## Critical Implementation Notes

### sessionDbId vs claudeSessionId

**IMPORTANT:** Use `claudeSessionId` (string) for new API endpoints, not `sessionDbId` (number).

- `sessionDbId` - Numeric database ID (legacy endpoints only)
- `claudeSessionId` - String identifier from Claude platform (new endpoints)

### JSON String Fields

Fields like `facts`, `concepts`, and `files_touched` are stored as JSON strings and require parsing:

```typescript
const observation = await client.getObservationById(123);
const facts = JSON.parse(observation.facts); // string[] array
const concepts = JSON.parse(observation.concepts); // string[] array
```

### Timestamps

All `created_at_epoch` fields are in **milliseconds**, not seconds:

```typescript
const date = new Date(observation.created_at_epoch); // ✅ Correct
const date = new Date(observation.created_at_epoch * 1000); // ❌ Wrong (already in ms)
```

### Asynchronous Processing

Workers process observations/summaries asynchronously. Results appear in the database 1-2 seconds after queuing. Use SSE events for real-time notifications.

### Privacy Tags

Always wrap sensitive content in `<private>` tags to prevent storage:

```typescript
const userMessage = '<private>API key: sk-1234567890</private>';
// This observation will be skipped (entire prompt is private)
```

---

## Additional Resources

- **Claude-Mem Documentation:** https://claude-mem.ai
- **GitHub Repository:** https://github.com/thedotmack/claude-mem
- **Worker Service README:** `src/services/worker/README.md`
- **API Endpoints:** `src/services/worker/http/routes/*.ts`
- **Domain Services:** `src/services/worker/*.ts`

---

**End of Platform Integration Guide**
