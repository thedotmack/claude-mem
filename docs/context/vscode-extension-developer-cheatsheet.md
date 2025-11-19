# VSCode Extension Developer Cheat Sheet

**For**: Community developers building the claude-mem VSCode extension
**Branch**: `feature/vscode-extension`
**Issue**: [#134](https://github.com/thedotmack/claude-mem/issues/134)

This cheat sheet provides all the context you need to build the VSCode extension without access to the claude-mem knowledge base.

---

## Table of Contents

1. [Quick Start Setup](#quick-start-setup)
2. [Worker Service API Reference](#worker-service-api-reference)
3. [Data Models & Type Definitions](#data-models--type-definitions)
4. [Lifecycle Flow Examples](#lifecycle-flow-examples)
5. [VSCode API Integration Guide](#vscode-api-integration-guide)
6. [Search API Reference](#search-api-reference)
7. [Error Handling Patterns](#error-handling-patterns)
8. [Development Workflow](#development-workflow)
9. [Testing Strategy](#testing-strategy)
10. [Code Examples](#code-examples)

---

## Quick Start Setup

### 1. Install & Run Worker Service Locally

```bash
# Clone and checkout the branch
git clone https://github.com/thedotmack/claude-mem.git
cd claude-mem
git checkout feature/vscode-extension

# Install dependencies
npm install

# Build the worker service
npm run build

# Start the worker service (uses PM2)
npm run worker:start

# Verify it's running
curl http://localhost:37777/health
# Should return: {"status":"ok","uptime":123456}

# View logs
npm run worker:logs
```

### 2. Verify Worker Is Accessible

```bash
# Health check
curl http://localhost:37777/health

# View the web UI
open http://localhost:37777

# Check processing status
curl http://localhost:37777/api/processing-status
```

### 3. Environment Variables

```bash
# Worker port (default: 37777)
export CLAUDE_MEM_WORKER_PORT=37777

# Context depth (default: 50 observations)
export CLAUDE_MEM_CONTEXT_OBSERVATIONS=50

# Model for AI compression (default: claude-haiku-4-5)
export CLAUDE_MEM_MODEL=claude-haiku-4-5
```

---

## Worker Service API Reference

### Base URL
```
http://localhost:37777
```

### Session Endpoints

#### Create/Init Session
```http
POST /sessions/:sessionDbId/init
Content-Type: application/json

# Body: (empty - session creation happens via SessionStore)
# Returns: 200 OK
```

**Notes**:
- Session must first be created via SQLite (SessionStore.createSDKSession)
- Then call this endpoint to initialize the SDK agent
- `sessionDbId` is the database ID, not the Claude session ID

#### Add Observation
```http
POST /sessions/:sessionDbId/observations
Content-Type: application/json

{
  "tool_name": "Read",
  "tool_input": "{\"file_path\":\"/path/to/file.ts\"}",
  "tool_response": "{\"content\":\"file contents...\"}",
  "prompt_number": 1,
  "cwd": "/Users/dev/project"
}
```

**Returns**:
```json
{
  "status": "queued",
  "sessionDbId": 123
}
```

#### Request Summary
```http
POST /sessions/:sessionDbId/summarize
Content-Type: application/json

{
  "last_user_message": "User's final message",
  "last_assistant_message": "Assistant's final response"
}
```

**Returns**:
```json
{
  "status": "queued"
}
```

#### Complete Session
```http
POST /sessions/:sessionDbId/complete
```

**Returns**: 200 OK

#### Delete Session
```http
DELETE /sessions/:sessionDbId
```

**Returns**: 200 OK

### Search Endpoints

#### Search Observations
```http
GET /api/search/observations?query=authentication&project=my-project&limit=10
```

**Query Parameters**:
- `query` (required): Search text
- `project` (optional): Filter by project name
- `limit` (optional): Max results (default: 10)
- `offset` (optional): Pagination offset (default: 0)

**Returns**:
```json
{
  "items": [
    {
      "id": 123,
      "sdk_session_id": "session_abc123",
      "project": "my-project",
      "type": "feature",
      "title": "User authentication implementation",
      "subtitle": "JWT token generation and validation",
      "narrative": "Implemented JWT-based authentication...",
      "facts": "[\"Added AuthService class\", \"Configured JWT expiry\"]",
      "concepts": "[\"authentication\", \"jwt\", \"security\"]",
      "files_read": "[\"/src/auth/types.ts\"]",
      "files_modified": "[\"/src/auth/AuthService.ts\"]",
      "created_at": "2025-01-15T10:30:00.000Z",
      "created_at_epoch": 1736937000000
    }
  ],
  "hasMore": false,
  "offset": 0,
  "limit": 10
}
```

#### Get Recent Context
```http
GET /api/context/recent?project=my-project&count=50
```

**Returns**: Array of recent observations (same format as search)

#### Search By File
```http
GET /api/search/by-file?file_path=/src/auth/AuthService.ts&project=my-project
```

#### Search By Type
```http
GET /api/search/by-type?type=bugfix&project=my-project&limit=20
```

**Valid types**: `decision`, `bugfix`, `feature`, `refactor`, `discovery`, `change`

#### Get Timeline
```http
GET /api/context/timeline?project=my-project&limit=50
```

**Returns**: Chronologically ordered observations with session summaries interspersed

### Health & Stats

#### Health Check
```http
GET /health
```

**Returns**:
```json
{
  "status": "ok",
  "uptime": 123456
}
```

#### Get Stats
```http
GET /api/stats
```

**Returns**:
```json
{
  "totalObservations": 1234,
  "totalSessions": 567,
  "totalPrompts": 890,
  "totalSummaries": 456,
  "projectCounts": {
    "my-project": {
      "observations": 234,
      "sessions": 45,
      "prompts": 67,
      "summaries": 34
    }
  }
}
```

---

## Data Models & Type Definitions

### TypeScript Interfaces

```typescript
/**
 * Observation - A single captured work item
 */
interface Observation {
  id: number;
  sdk_session_id: string;
  project: string;
  type: 'decision' | 'bugfix' | 'feature' | 'refactor' | 'discovery' | 'change';
  title: string;
  subtitle: string | null;
  text: string | null;           // Legacy field (use narrative instead)
  narrative: string | null;       // Human-readable description
  facts: string | null;           // JSON array: ["fact1", "fact2"]
  concepts: string | null;        // JSON array: ["concept1", "concept2"]
  files_read: string | null;      // JSON array: ["/path/to/file1.ts"]
  files_modified: string | null;  // JSON array: ["/path/to/file2.ts"]
  prompt_number: number;
  discovery_tokens: number | null; // Tokens spent discovering this
  created_at: string;             // ISO 8601 timestamp
  created_at_epoch: number;       // Unix timestamp in milliseconds
}

/**
 * Session Summary - Generated at end of session
 */
interface Summary {
  id: number;
  session_id: string;             // claude_session_id
  project: string;
  request: string | null;          // What the user requested
  investigated: string | null;     // What was explored
  learned: string | null;          // Key learnings
  completed: string | null;        // What was accomplished
  next_steps: string | null;       // Suggested next actions
  notes: string | null;            // Additional notes
  created_at: string;
  created_at_epoch: number;
}

/**
 * Database Session Record
 */
interface DBSession {
  id: number;                      // sessionDbId (use this for API calls)
  claude_session_id: string;       // Unique session ID from Claude Code
  project: string;                 // Project name (from cwd basename)
  user_prompt: string;             // Initial user request
  sdk_session_id: string | null;   // SDK session ID (set after init)
  status: 'active' | 'completed' | 'failed';
  started_at: string;
  started_at_epoch: number;
  completed_at: string | null;
  completed_at_epoch: number | null;
  worker_port: number | null;      // Port worker is running on
}

/**
 * User Prompt Record
 */
interface UserPrompt {
  id: number;
  claude_session_id: string;
  project: string;
  prompt_number: number;
  prompt_text: string;
  created_at: string;
  created_at_epoch: number;
}

/**
 * Paginated API Response
 */
interface PaginatedResult<T> {
  items: T[];
  hasMore: boolean;
  offset: number;
  limit: number;
}
```

### Example Data

**Observation Example**:
```json
{
  "id": 11746,
  "sdk_session_id": "session_abc123",
  "project": "claude-mem",
  "type": "feature",
  "title": "Discord button implementation in Header component",
  "subtitle": "Added Discord community link with icon",
  "narrative": "Implemented a Discord button in the viewer UI header component with proper styling and external link handling",
  "facts": "[\"Added Discord SVG icon\", \"Created button with hover effects\", \"Opens in new tab\"]",
  "concepts": "[\"ui\", \"react\", \"community\", \"discord\"]",
  "files_read": "[\"src/ui/viewer/components/Header.tsx\"]",
  "files_modified": "[\"src/ui/viewer/components/Header.tsx\"]",
  "prompt_number": 3,
  "discovery_tokens": 8593,
  "created_at": "2025-11-18T23:56:00.000Z",
  "created_at_epoch": 1732067760000
}
```

**Summary Example**:
```json
{
  "id": 2058,
  "session_id": "session_xyz789",
  "project": "claude-mem",
  "request": "Execute Phase 1 of VSCode Extension Architecture Implementation",
  "investigated": "The user requested execution of phase 1 from docs/context/vscode-extension-architecture.md. The primary session checked the status of the claude-mem-worker process using PM2 to verify the development environment was ready.",
  "learned": "The claude-mem-worker runs under PM2 process management with watching enabled for auto-restart on file changes. The worker has experienced 34 restarts and was recently restarted (6 seconds uptime) at the time of the status check.",
  "completed": "Environment verification completed by checking PM2 worker status. The claude-mem-worker is confirmed online and operational with PID 73595, using 128.5MB memory.",
  "next_steps": "Proceeding with phase 1 implementation tasks as defined in the VSCode extension architecture documentation.",
  "notes": null,
  "created_at": "2025-11-18T23:57:00.000Z",
  "created_at_epoch": 1732067820000
}
```

---

## Lifecycle Flow Examples

### End-to-End Conversation Flow

```
User starts Copilot conversation
         ↓
    [CONVERSATION START EVENT]
         ↓
┌─────────────────────────────────────────────┐
│ VSCode Extension: Chat Participant Handler │
└─────────────────────────────────────────────┘
         ↓
1. Create session in SQLite
   └─> SessionStore.createSDKSession(claudeSessionId, project, userPrompt)
       Returns: sessionDbId

2. Initialize SDK agent
   └─> POST http://localhost:37777/sessions/{sessionDbId}/init

3. Retrieve context
   └─> GET http://localhost:37777/api/context/recent?project={project}&count=50
       Returns: {items: Observation[], hasMore: boolean}

4. Format & inject context into chat
   └─> Add to chat as system/user context message

         ↓
    [USER SENDS MESSAGE]
         ↓
5. Log user prompt
   └─> SessionStore.saveUserPrompt(sessionDbId, promptText, promptNumber)

         ↓
    [COPILOT INVOKES TOOL]
         ↓
6. Capture tool invocation
   └─> POST http://localhost:37777/sessions/{sessionDbId}/observations
       Body: {tool_name, tool_input, tool_response, prompt_number, cwd}

   Worker processes asynchronously:
   - Sends to Claude Agent SDK for compression
   - Extracts: type, title, subtitle, narrative, facts, concepts, files
   - Saves to SQLite observations table
   - Broadcasts via SSE to viewer UI

         ↓
    [CONVERSATION ENDS]
         ↓
7. Generate summary
   └─> POST http://localhost:37777/sessions/{sessionDbId}/summarize
       Body: {last_user_message, last_assistant_message}

   Worker processes asynchronously:
   - Aggregates all observations from session
   - Sends to Claude Agent SDK for summary generation
   - Extracts: request, investigated, learned, completed, next_steps
   - Saves to SQLite session_summaries table

8. Complete session
   └─> POST http://localhost:37777/sessions/{sessionDbId}/complete
       Marks session as completed in database
```

### Error Scenarios

```
POST /sessions/{sessionDbId}/observations
         ↓
   [WORKER DOWN]
         ↓
ECONNREFUSED error
         ↓
Extension logs warning: "Worker unavailable"
Extension shows status bar warning
Conversation continues (graceful degradation)
         ↓
User sees: "⚠️ Memory features unavailable"
```

---

## VSCode API Integration Guide

### Chat Participant Registration

```typescript
import * as vscode from 'vscode';

// Register chat participant
const participant = vscode.chat.createChatParticipant(
  'claude-mem.memory',  // Unique ID
  async (
    request: vscode.ChatRequest,
    context: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
  ): Promise<vscode.ChatResult> => {
    // Handler implementation (see examples below)
  }
);

// Set icon
participant.iconPath = vscode.Uri.file(path.join(__dirname, 'icon.png'));

// Register for cleanup
context.subscriptions.push(participant);
```

### Detecting First Message vs Subsequent Messages

```typescript
// VSCode provides a conversation ID via context
const conversationId = context.history[0]?.id || 'new-conversation';

// Track which conversations we've seen
const conversationSessions = new Map<string, number>(); // conversationId -> sessionDbId

async function handleChatRequest(
  request: vscode.ChatRequest,
  context: vscode.ChatContext
) {
  const conversationId = context.history[0]?.id || `conv-${Date.now()}`;

  // Check if this is the first message
  const isFirstMessage = !conversationSessions.has(conversationId);

  if (isFirstMessage) {
    // Create session and inject context
    const sessionDbId = await createSession(request);
    conversationSessions.set(conversationId, sessionDbId);

    const context = await retrieveContext();
    await injectContext(stream, context);
  } else {
    // Get existing session
    const sessionDbId = conversationSessions.get(conversationId)!;
    await logPrompt(sessionDbId, request.prompt);
  }
}
```

### Capturing Tool Invocations

**Note**: VSCode's Chat API doesn't provide direct access to Copilot's tool invocations. We need to monitor the conversation flow differently.

**Approach 1**: Monitor response content for tool results
```typescript
// Watch for structured tool results in Copilot's responses
participant.onDidReceiveResponse((response) => {
  // Parse response for tool invocations (if Copilot includes them)
  // This is implementation-specific and may require experimentation
});
```

**Approach 2**: Use Language Model Tools (which we control)
```typescript
// When we register our own tools, we can capture their invocations
vscode.lm.registerTool('mem_search', {
  invoke: async (options) => {
    // Capture this invocation
    await logObservation(sessionDbId, {
      tool_name: 'mem_search',
      tool_input: JSON.stringify(options.input),
      tool_response: JSON.stringify(result)
    });

    return result;
  }
});
```

**Note for Phase 1**: We may need to experiment with VSCode's API to determine the best approach for capturing Copilot's tool invocations. This is an open question for early contributors.

### Detecting Conversation End

```typescript
// VSCode doesn't have explicit "conversation end" events
// Use these heuristics:

// 1. Extension deactivation
export function deactivate() {
  // Clean up all active sessions
  for (const [conversationId, sessionDbId] of conversationSessions.entries()) {
    await summarizeAndComplete(sessionDbId);
  }
}

// 2. Timeout-based (optional)
let lastActivityTimestamp = Date.now();

function onActivity() {
  lastActivityTimestamp = Date.now();
}

// Check every 5 minutes
setInterval(() => {
  const inactiveDuration = Date.now() - lastActivityTimestamp;

  if (inactiveDuration > 30 * 60 * 1000) { // 30 minutes
    // Consider conversation ended
    summarizeActiveSessions();
  }
}, 5 * 60 * 1000);
```

### Language Model Tool Registration

```typescript
import * as vscode from 'vscode';

// Define tool schema
const memSearchTool = vscode.lm.registerTool('mem_search', {
  description: 'Search claude-mem\'s persistent memory for relevant past work, decisions, and context.',

  // Input schema (JSON Schema format)
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query text'
      },
      project: {
        type: 'string',
        description: 'Filter by project name (optional)'
      },
      limit: {
        type: 'number',
        description: 'Maximum results to return',
        default: 10
      }
    },
    required: ['query']
  },

  // Prepare invocation (show confirmation to user)
  prepareInvocation: async (options) => ({
    invocationMessage: `Searching claude-mem for: "${options.input.query}"`,
    confirmationMessages: {
      title: 'Search Memory',
      message: new vscode.MarkdownString(`Search past observations for **${options.input.query}**?`)
    }
  }),

  // Execute the tool
  invoke: async (options, token) => {
    const { query, project, limit = 10 } = options.input;

    // Call worker service
    const response = await fetch(`http://localhost:37777/api/search/observations?query=${encodeURIComponent(query)}&project=${project}&limit=${limit}`);
    const data = await response.json();

    // Format results for Copilot
    const formattedResults = data.items.map(obs =>
      `**${obs.title}** (${obs.type})\n${obs.narrative}\nFiles: ${JSON.parse(obs.files_modified || '[]').join(', ')}`
    ).join('\n\n');

    // Log this tool invocation as an observation
    await logToolInvocation(sessionDbId, 'mem_search', options.input, data);

    // Return result
    return {
      content: formattedResults,
      metadata: {
        resultCount: data.items.length,
        hasMore: data.hasMore
      }
    };
  }
});

// Clean up on deactivation
context.subscriptions.push(memSearchTool);
```

### Extension Activation

```typescript
export async function activate(context: vscode.ExtensionContext) {
  // Initialize worker client
  const workerClient = new WorkerClient();

  // Check if worker is healthy
  const healthy = await workerClient.isHealthy();
  if (!healthy) {
    vscode.window.showWarningMessage(
      'claude-mem worker is not running. Memory features will be unavailable.',
      'Start Worker'
    ).then(selection => {
      if (selection === 'Start Worker') {
        // Optionally auto-start worker or show instructions
      }
    });
  }

  // Register chat participant
  const participant = vscode.chat.createChatParticipant(
    'claude-mem.memory',
    handleChatRequest
  );
  context.subscriptions.push(participant);

  // Register language model tools
  registerTools(context, workerClient);

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('claude-mem.openViewer', () => {
      vscode.env.openExternal(vscode.Uri.parse('http://localhost:37777'));
    })
  );

  // Status bar
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.text = healthy ? '$(check) claude-mem' : '$(warning) claude-mem';
  statusBarItem.tooltip = healthy ? 'Worker running' : 'Worker unavailable';
  statusBarItem.command = 'claude-mem.openViewer';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);
}
```

---

## Search API Reference

### How Search Works

Claude-mem uses **hybrid search** combining:
1. **FTS5 full-text search** (SQLite) - Keyword matching
2. **Vector embeddings** (ChromaDB) - Semantic similarity
3. **Recency filtering** - Last 90 days by default

### Search Query Format

All search endpoints accept these common parameters:
- `query` (string): Search text
- `project` (string, optional): Filter by project
- `limit` (number, optional): Max results (default: 10)
- `offset` (number, optional): Pagination offset (default: 0)

### Search Result Ranking

Results are ranked by:
1. **Semantic relevance** (vector similarity score)
2. **Keyword match** (FTS5 rank)
3. **Recency** (newer observations ranked higher)

### Example Search Requests

```bash
# Search for authentication-related work
curl "http://localhost:37777/api/search/observations?query=authentication&limit=5"

# Find all bugfixes
curl "http://localhost:37777/api/search/by-type?type=bugfix&limit=20"

# Find work on a specific file
curl "http://localhost:37777/api/search/by-file?file_path=/src/auth/AuthService.ts"

# Get recent context for a project
curl "http://localhost:37777/api/context/recent?project=my-project&count=50"

# Get timeline view
curl "http://localhost:37777/api/context/timeline?project=my-project&limit=50"
```

---

## Error Handling Patterns

### Worker Client Error Handling

```typescript
class WorkerClient {
  private baseUrl: string;
  private timeout: number = 5000;

  async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;

    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(this.timeout)
      });

      if (!response.ok) {
        throw new WorkerError(
          `HTTP ${response.status}: ${response.statusText}`,
          response.status
        );
      }

      return await response.json();

    } catch (error: any) {
      // Connection refused (worker not running)
      if (error.cause?.code === 'ECONNREFUSED') {
        throw new WorkerUnavailableError('Worker service is not running');
      }

      // Timeout
      if (error.name === 'TimeoutError') {
        throw new WorkerTimeoutError('Request timed out');
      }

      // Other errors
      throw error;
    }
  }
}

// Custom error classes
class WorkerError extends Error {
  constructor(message: string, public statusCode?: number) {
    super(message);
    this.name = 'WorkerError';
  }
}

class WorkerUnavailableError extends WorkerError {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerUnavailableError';
  }
}

class WorkerTimeoutError extends WorkerError {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerTimeoutError';
  }
}
```

### Graceful Degradation

```typescript
async function handleChatRequest(
  request: vscode.ChatRequest,
  context: vscode.ChatContext,
  stream: vscode.ChatResponseStream
) {
  try {
    // Try to create session and inject context
    const sessionDbId = await createSession(request);
    const context = await retrieveContext(sessionDbId);
    await injectContext(stream, context);

  } catch (error) {
    if (error instanceof WorkerUnavailableError) {
      // Worker down - log warning and continue without memory
      console.warn('[claude-mem] Worker unavailable, continuing without memory features');

      // Optionally notify user (don't spam)
      if (!hasShownWarning) {
        vscode.window.showWarningMessage(
          'claude-mem worker is unavailable. Memory features disabled for this conversation.'
        );
        hasShownWarning = true;
      }

      // Continue conversation normally (graceful degradation)
      return;

    } else {
      // Other errors - rethrow
      throw error;
    }
  }
}
```

### Retry Logic with Exponential Backoff

```typescript
async function fetchWithRetry<T>(
  url: string,
  options: RequestInit = {},
  maxRetries: number = 3
): Promise<T> {
  let lastError: Error;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      return await response.json();

    } catch (error: any) {
      lastError = error;

      // Don't retry on connection refused or timeout
      if (error.cause?.code === 'ECONNREFUSED' || error.name === 'TimeoutError') {
        throw error;
      }

      // Exponential backoff: 100ms, 200ms, 400ms, ...
      const delay = 100 * Math.pow(2, attempt);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError!;
}
```

---

## Development Workflow

### Project Structure

```
claude-mem/
├── src/
│   ├── shared/           ← NEW: Shared code (WorkerClient)
│   │   └── worker-client.ts
│   ├── vscode/           ← NEW: VSCode extension code
│   │   ├── extension.ts         (activation, registration)
│   │   ├── participant/         (chat participant)
│   │   ├── tools/               (language model tools)
│   │   └── types.ts
│   ├── hooks/            ← Existing: Claude Code hooks (reference)
│   ├── services/         ← Existing: Worker service (shared)
│   └── utils/
├── plugin/               ← Built output for Claude Code plugin
│   ├── scripts/          (hooks)
│   └── worker-service.cjs
├── vscode-extension/     ← NEW: Built output for VSCode extension
│   └── extension.js
└── package.json
```

### Build Configuration

Add to `package.json`:
```json
{
  "scripts": {
    "build:vscode": "esbuild src/vscode/extension.ts --bundle --outfile=vscode-extension/extension.js --platform=node --target=node18 --external:vscode --format=cjs",
    "build:shared": "tsc src/shared/*.ts --outDir dist/shared --module esnext --target es2020",
    "build": "npm run build:shared && npm run build:vscode && node scripts/build-hooks.js"
  }
}
```

### VSCode Extension package.json

Create `vscode-extension/package.json`:
```json
{
  "name": "claude-mem-vscode",
  "displayName": "claude-mem for Copilot",
  "description": "Persistent memory for GitHub Copilot",
  "version": "0.1.0",
  "engines": {
    "vscode": "^1.85.0"
  },
  "main": "./extension.js",
  "contributes": {
    "chatParticipants": [
      {
        "id": "claude-mem.memory",
        "name": "memory",
        "description": "Access persistent memory from past conversations",
        "commands": []
      }
    ],
    "languageModelTools": [
      {
        "name": "mem_search",
        "description": "Search persistent memory for past work and decisions",
        "canBeReferencedInPrompt": true
      },
      {
        "name": "mem_get_recent",
        "description": "Get recent session summaries",
        "canBeReferencedInPrompt": true
      },
      {
        "name": "mem_timeline",
        "description": "Get chronological timeline of past work",
        "canBeReferencedInPrompt": true
      },
      {
        "name": "mem_find_file",
        "description": "Find observations related to specific files",
        "canBeReferencedInPrompt": true
      }
    ],
    "commands": [
      {
        "command": "claude-mem.openViewer",
        "title": "Open Memory Viewer"
      },
      {
        "command": "claude-mem.restartWorker",
        "title": "Restart Worker Service"
      }
    ],
    "configuration": {
      "title": "claude-mem",
      "properties": {
        "claude-mem.workerPort": {
          "type": "number",
          "default": 37777,
          "description": "Port where worker service runs"
        },
        "claude-mem.contextObservationCount": {
          "type": "number",
          "default": 50,
          "description": "Number of observations to inject at conversation start"
        },
        "claude-mem.autoSync": {
          "type": "boolean",
          "default": true,
          "description": "Automatically capture observations"
        }
      }
    }
  }
}
```

### TypeScript Configuration

Create `vscode-extension/tsconfig.json`:
```json
{
  "compilerOptions": {
    "module": "commonjs",
    "target": "ES2020",
    "lib": ["ES2020"],
    "outDir": ".",
    "rootDir": "../src/vscode",
    "sourceMap": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  },
  "include": ["../src/vscode/**/*", "../src/shared/**/*"],
  "exclude": ["node_modules", "**/*.test.ts"]
}
```

### Debug Configuration

Create `.vscode/launch.json`:
```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Run Extension",
      "type": "extensionHost",
      "request": "launch",
      "args": [
        "--extensionDevelopmentPath=${workspaceFolder}/vscode-extension"
      ],
      "outFiles": [
        "${workspaceFolder}/vscode-extension/**/*.js"
      ],
      "preLaunchTask": "${defaultBuildTask}"
    },
    {
      "name": "Test Extension",
      "type": "extensionHost",
      "request": "launch",
      "args": [
        "--extensionDevelopmentPath=${workspaceFolder}/vscode-extension",
        "--extensionTestsPath=${workspaceFolder}/vscode-extension/test/suite/index"
      ]
    }
  ]
}
```

### Local Development Loop

```bash
# 1. Start worker service
npm run worker:start

# 2. Make changes to VSCode extension code
# Edit src/vscode/extension.ts, src/vscode/tools/*, etc.

# 3. Build extension
npm run build:vscode

# 4. Test in VSCode
# Press F5 to launch Extension Development Host
# Or: code --extensionDevelopmentPath=./vscode-extension

# 5. View worker logs
npm run worker:logs

# 6. Debug
# Add breakpoints in VSCode
# Launch Extension Development Host
# Interact with Copilot to trigger breakpoints
```

---

## Testing Strategy

### Unit Tests

#### Test WorkerClient

```typescript
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { WorkerClient } from '../shared/worker-client';

// Mock fetch
global.fetch = jest.fn();

describe('WorkerClient', () => {
  let client: WorkerClient;

  beforeAll(() => {
    client = new WorkerClient(37777);
  });

  it('should check health successfully', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'ok', uptime: 12345 })
    });

    const healthy = await client.isHealthy();
    expect(healthy).toBe(true);
  });

  it('should handle worker unavailable', async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce({
      cause: { code: 'ECONNREFUSED' }
    });

    await expect(client.isHealthy()).rejects.toThrow(WorkerUnavailableError);
  });

  it('should search observations', async () => {
    const mockResults = {
      items: [
        {
          id: 1,
          title: 'Test observation',
          type: 'feature'
        }
      ],
      hasMore: false
    };

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => mockResults
    });

    const results = await client.searchObservations({ query: 'test' });
    expect(results.items).toHaveLength(1);
    expect(results.items[0].title).toBe('Test observation');
  });
});
```

#### Test Language Model Tools

```typescript
import { describe, it, expect } from '@jest/globals';
import { createMemSearchTool } from '../vscode/tools/mem-search';

describe('mem_search tool', () => {
  it('should format search results correctly', async () => {
    const mockClient = {
      searchObservations: async () => ({
        items: [
          {
            id: 1,
            title: 'Auth implementation',
            type: 'feature',
            narrative: 'Added JWT authentication',
            files_modified: '[\"/src/auth.ts\"]'
          }
        ],
        hasMore: false
      })
    };

    const tool = createMemSearchTool(mockClient);
    const result = await tool.invoke({
      input: { query: 'authentication', limit: 10 },
      token: null
    });

    expect(result.content).toContain('Auth implementation');
    expect(result.content).toContain('JWT authentication');
  });
});
```

### Integration Tests

```typescript
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { spawn, ChildProcess } from 'child_process';
import { WorkerClient } from '../shared/worker-client';

describe('Integration: VSCode Extension + Worker', () => {
  let workerProcess: ChildProcess;
  let client: WorkerClient;

  beforeAll(async () => {
    // Start worker service
    workerProcess = spawn('npm', ['run', 'worker:start']);

    // Wait for worker to be ready
    await new Promise(resolve => setTimeout(resolve, 2000));

    client = new WorkerClient();
  });

  afterAll(async () => {
    // Stop worker
    workerProcess.kill();
  });

  it('should create session and add observations', async () => {
    // Create session via SQLite
    const sessionDbId = await createTestSession();

    // Initialize session
    await client.initSession(sessionDbId);

    // Add observation
    await client.addObservation(sessionDbId, {
      tool_name: 'Read',
      tool_input: JSON.stringify({ file_path: '/test.ts' }),
      tool_response: JSON.stringify({ content: 'test content' }),
      prompt_number: 1,
      cwd: process.cwd()
    });

    // Wait for async processing
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Verify observation was created
    const results = await client.searchObservations({ query: 'test' });
    expect(results.items.length).toBeGreaterThan(0);
  });
});
```

### Manual Testing Checklist

```markdown
## Phase 1: Foundation
- [ ] Worker client can connect to running worker
- [ ] Worker client handles connection refused gracefully
- [ ] Worker client handles timeouts
- [ ] Health check works
- [ ] Search endpoints return results

## Phase 2-3: Language Model Tools
- [ ] mem_search tool registers successfully
- [ ] mem_search can be invoked from Copilot via #mem_search
- [ ] mem_search returns formatted results
- [ ] mem_search shows confirmation dialog
- [ ] mem_get_recent works
- [ ] mem_timeline works
- [ ] mem_find_file works

## Phase 4-6: Chat Participant
- [ ] Chat participant registers successfully
- [ ] First message creates session in database
- [ ] First message injects context
- [ ] Context is visible/useful to Copilot
- [ ] Subsequent messages don't re-inject context
- [ ] Tool invocations are captured as observations
- [ ] Conversation end triggers summary generation
- [ ] Session is marked complete

## Edge Cases
- [ ] Worker down: Extension shows warning but doesn't crash
- [ ] Worker restarts mid-conversation: Extension reconnects
- [ ] Multiple conversations: Each gets separate session
- [ ] Empty project: No context injected (graceful)
- [ ] Large context: Doesn't exceed token limits
```

---

## Code Examples

### Complete WorkerClient Implementation

```typescript
/**
 * src/shared/worker-client.ts
 *
 * Shared HTTP client for claude-mem worker service
 * Used by both VSCode extension and (potentially) refactored hooks
 */

export class WorkerClient {
  private baseUrl: string;
  private timeout: number;

  constructor(port?: number) {
    const workerPort = port || parseInt(process.env.CLAUDE_MEM_WORKER_PORT || '37777');
    this.baseUrl = `http://127.0.0.1:${workerPort}`;
    this.timeout = 5000;
  }

  /**
   * Check if worker service is healthy
   */
  async isHealthy(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(this.timeout)
      });

      if (!response.ok) return false;

      const data = await response.json();
      return data.status === 'ok';

    } catch {
      return false;
    }
  }

  /**
   * Initialize SDK session
   */
  async initSession(sessionDbId: number): Promise<void> {
    await this.request(`/sessions/${sessionDbId}/init`, {
      method: 'POST'
    });
  }

  /**
   * Add observation to session
   */
  async addObservation(
    sessionDbId: number,
    data: {
      tool_name: string;
      tool_input: string;
      tool_response: string;
      prompt_number: number;
      cwd: string;
    }
  ): Promise<void> {
    await this.request(`/sessions/${sessionDbId}/observations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
  }

  /**
   * Request summary generation
   */
  async generateSummary(
    sessionDbId: number,
    messages: {
      last_user_message: string;
      last_assistant_message: string;
    }
  ): Promise<void> {
    await this.request(`/sessions/${sessionDbId}/summarize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(messages)
    });
  }

  /**
   * Mark session as complete
   */
  async completeSession(sessionDbId: number): Promise<void> {
    await this.request(`/sessions/${sessionDbId}/complete`, {
      method: 'POST'
    });
  }

  /**
   * Search observations
   */
  async searchObservations(params: {
    query: string;
    project?: string;
    limit?: number;
    offset?: number;
  }): Promise<PaginatedResult<Observation>> {
    const queryString = new URLSearchParams({
      query: params.query,
      ...(params.project && { project: params.project }),
      ...(params.limit && { limit: params.limit.toString() }),
      ...(params.offset && { offset: params.offset.toString() })
    }).toString();

    return this.request(`/api/search/observations?${queryString}`);
  }

  /**
   * Get recent context
   */
  async getRecentContext(params: {
    project?: string;
    count?: number;
  }): Promise<PaginatedResult<Observation>> {
    const queryString = new URLSearchParams({
      ...(params.project && { project: params.project }),
      ...(params.count && { count: params.count.toString() })
    }).toString();

    return this.request(`/api/context/recent?${queryString}`);
  }

  /**
   * Search by file
   */
  async searchByFile(params: {
    file_path: string;
    project?: string;
  }): Promise<PaginatedResult<Observation>> {
    const queryString = new URLSearchParams({
      file_path: params.file_path,
      ...(params.project && { project: params.project })
    }).toString();

    return this.request(`/api/search/by-file?${queryString}`);
  }

  /**
   * Get timeline
   */
  async getTimeline(params: {
    project?: string;
    limit?: number;
  }): Promise<PaginatedResult<Observation | Summary>> {
    const queryString = new URLSearchParams({
      ...(params.project && { project: params.project }),
      ...(params.limit && { limit: params.limit.toString() })
    }).toString();

    return this.request(`/api/context/timeline?${queryString}`);
  }

  /**
   * Generic request helper
   */
  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;

    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(this.timeout)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new WorkerError(
          `HTTP ${response.status}: ${errorText}`,
          response.status
        );
      }

      return await response.json();

    } catch (error: any) {
      // Connection refused
      if (error.cause?.code === 'ECONNREFUSED') {
        throw new WorkerUnavailableError('Worker service is not running');
      }

      // Timeout
      if (error.name === 'TimeoutError') {
        throw new WorkerTimeoutError('Request timed out');
      }

      // Already a WorkerError
      if (error instanceof WorkerError) {
        throw error;
      }

      // Other errors
      throw new WorkerError(error.message);
    }
  }
}

// Error classes
export class WorkerError extends Error {
  constructor(message: string, public statusCode?: number) {
    super(message);
    this.name = 'WorkerError';
  }
}

export class WorkerUnavailableError extends WorkerError {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerUnavailableError';
  }
}

export class WorkerTimeoutError extends WorkerError {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerTimeoutError';
  }
}

// Type definitions
interface PaginatedResult<T> {
  items: T[];
  hasMore: boolean;
  offset: number;
  limit: number;
}

interface Observation {
  id: number;
  sdk_session_id: string;
  project: string;
  type: string;
  title: string;
  subtitle: string | null;
  narrative: string | null;
  facts: string | null;
  concepts: string | null;
  files_read: string | null;
  files_modified: string | null;
  created_at: string;
  created_at_epoch: number;
}

interface Summary {
  id: number;
  session_id: string;
  project: string;
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  created_at: string;
  created_at_epoch: number;
}
```

### Minimal Chat Participant

```typescript
/**
 * src/vscode/participant/index.ts
 *
 * Chat participant for automatic session management
 */

import * as vscode from 'vscode';
import { WorkerClient } from '../../shared/worker-client';
import { SessionStore } from '../../services/sqlite/SessionStore';
import path from 'path';

// Track active conversations
const conversationSessions = new Map<string, number>(); // conversationId -> sessionDbId

export function registerChatParticipant(
  context: vscode.ExtensionContext,
  workerClient: WorkerClient
): vscode.Disposable {

  const participant = vscode.chat.createChatParticipant(
    'claude-mem.memory',
    async (
      request: vscode.ChatRequest,
      context: vscode.ChatContext,
      stream: vscode.ChatResponseStream,
      token: vscode.CancellationToken
    ): Promise<vscode.ChatResult> => {

      try {
        // Get or create conversation ID
        const conversationId = getConversationId(context);

        // Check if first message in conversation
        const isFirstMessage = !conversationSessions.has(conversationId);

        if (isFirstMessage) {
          // Create session
          const sessionDbId = await createSession(request);
          conversationSessions.set(conversationId, sessionDbId);

          // Initialize SDK agent
          await workerClient.initSession(sessionDbId);

          // Retrieve and inject context
          const contextObs = await retrieveContext(workerClient, request);
          if (contextObs.items.length > 0) {
            injectContext(stream, contextObs.items);
          }
        }

        // Let Copilot handle the actual response
        // (We're just managing lifecycle, not generating responses)

        return { metadata: { sessionId: conversationSessions.get(conversationId) } };

      } catch (error) {
        console.error('[claude-mem] Error in chat participant:', error);

        // Graceful degradation
        if (error instanceof WorkerUnavailableError) {
          console.warn('[claude-mem] Worker unavailable, continuing without memory');
          return {};
        }

        throw error;
      }
    }
  );

  return participant;
}

function getConversationId(context: vscode.ChatContext): string {
  // VSCode provides conversation context via history
  // Use first message ID as conversation identifier
  return context.history[0]?.id || `conv-${Date.now()}`;
}

async function createSession(request: vscode.ChatRequest): Promise<number> {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
  const project = path.basename(cwd);

  const db = new SessionStore();
  const claudeSessionId = `vscode-${Date.now()}`;
  const sessionDbId = db.createSDKSession(claudeSessionId, project, request.prompt);
  db.close();

  return sessionDbId;
}

async function retrieveContext(
  client: WorkerClient,
  request: vscode.ChatRequest
): Promise<PaginatedResult<Observation>> {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
  const project = path.basename(cwd);

  const config = vscode.workspace.getConfiguration('claude-mem');
  const count = config.get<number>('contextObservationCount', 50);

  return await client.getRecentContext({ project, count });
}

function injectContext(stream: vscode.ChatResponseStream, observations: Observation[]) {
  // Format context for injection
  stream.markdown('## Recent Context from claude-mem\n\n');

  for (const obs of observations.slice(0, 5)) { // Show top 5
    stream.markdown(`**${obs.title}** (${obs.type})\n`);
    if (obs.narrative) {
      stream.markdown(`${obs.narrative}\n\n`);
    }
  }

  stream.markdown(`\n---\n\n`);
}
```

### Minimal Language Model Tool

```typescript
/**
 * src/vscode/tools/mem-search.ts
 *
 * Search tool for language model
 */

import * as vscode from 'vscode';
import { WorkerClient } from '../../shared/worker-client';

export function registerMemSearchTool(
  context: vscode.ExtensionContext,
  workerClient: WorkerClient
): vscode.Disposable {

  const tool = vscode.lm.registerTool('mem_search', {
    description: 'Search claude-mem persistent memory for past work, decisions, and context.',

    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query text'
        },
        limit: {
          type: 'number',
          description: 'Maximum results',
          default: 10
        }
      },
      required: ['query']
    },

    prepareInvocation: async (options) => ({
      invocationMessage: `Searching memory: "${options.input.query}"`,
      confirmationMessages: {
        title: 'Search Memory',
        message: new vscode.MarkdownString(
          `Search for **${options.input.query}**?`
        )
      }
    }),

    invoke: async (options, token) => {
      const { query, limit = 10 } = options.input;

      try {
        // Get current project
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const project = cwd ? path.basename(cwd) : undefined;

        // Search
        const results = await workerClient.searchObservations({
          query,
          project,
          limit
        });

        // Format results
        const formatted = results.items.map(obs => {
          const files = JSON.parse(obs.files_modified || '[]');
          return [
            `**${obs.title}** (${obs.type})`,
            obs.narrative || obs.subtitle || '',
            files.length > 0 ? `Files: ${files.join(', ')}` : ''
          ].filter(Boolean).join('\n');
        }).join('\n\n---\n\n');

        return {
          content: formatted || 'No results found.',
          metadata: {
            resultCount: results.items.length,
            hasMore: results.hasMore
          }
        };

      } catch (error) {
        console.error('[claude-mem] Search error:', error);
        return {
          content: 'Error searching memory. Worker may be unavailable.',
          metadata: { error: true }
        };
      }
    }
  });

  return tool;
}
```

---

## Quick Reference

### Session Lifecycle Mapping

| Phase | Claude Code Hook | VSCode Extension Action | Worker API Call |
|-------|-----------------|------------------------|----------------|
| **Start** | `SessionStart` (context-hook) | Chat participant: first message handler | GET /api/context/recent |
| **Prompt** | `UserPromptSubmit` (new-hook) | Chat participant: message handler | SessionStore.saveUserPrompt() |
| **Tool** | `PostToolUse` (save-hook) | Tool invocation capture | POST /sessions/:id/observations |
| **Summary** | `Summary` (summary hook) | Conversation end handler | POST /sessions/:id/summarize |
| **End** | `SessionEnd` (cleanup-hook) | Extension deactivation / timeout | POST /sessions/:id/complete |

### Key Differences: Claude Code vs VSCode

| Aspect | Claude Code Plugin | VSCode Extension |
|--------|-------------------|------------------|
| **Lifecycle** | Passive hooks (events) | Active orchestration (participant) |
| **Session Creation** | Automatic via hooks | Manual via participant handler |
| **Tool Capture** | PostToolUse hook | Need to monitor chat / register tools |
| **Context Injection** | SessionStart hook output | Chat participant stream |
| **Conversation End** | SessionEnd hook | Timeout / deactivation heuristic |

### Environment Setup Commands

```bash
# Install project
git clone https://github.com/thedotmack/claude-mem.git
cd claude-mem
npm install

# Build everything
npm run build

# Start worker
npm run worker:start

# Check worker status
pm2 list
npm run worker:logs

# Restart worker (after code changes)
npm run worker:restart

# Stop worker
npm run worker:stop

# Health check
curl http://localhost:37777/health

# View UI
open http://localhost:37777
```

### Common Gotchas

1. **sessionDbId vs claudeSessionId**
   - Use `sessionDbId` (number) for API calls
   - `claudeSessionId` is just a string identifier

2. **JSON Fields**
   - `facts`, `concepts`, `files_read`, `files_modified` are JSON strings
   - Must parse with `JSON.parse()` before using

3. **Timestamps**
   - `created_at` is ISO 8601 string
   - `created_at_epoch` is Unix timestamp in **milliseconds** (not seconds)

4. **Worker Must Be Running**
   - All API calls fail if worker is down
   - Always check `workerClient.isHealthy()` first
   - Implement graceful degradation

5. **Async Processing**
   - Observations are processed asynchronously
   - Don't expect immediate results after POST
   - May take 1-2 seconds to appear in search

6. **Tool Input/Response**
   - Must be JSON strings, not objects
   - Use `JSON.stringify()` when sending to worker

---

## Getting Help

### Resources

- **Architecture Doc**: [`docs/context/vscode-extension-architecture.md`](https://github.com/thedotmack/claude-mem/blob/feature/vscode-extension/docs/context/vscode-extension-architecture.md)
- **Issue**: [#134](https://github.com/thedotmack/claude-mem/issues/134)
- **VSCode Chat API**: https://code.visualstudio.com/api/extension-guides/chat
- **VSCode Language Model API**: https://code.visualstudio.com/api/references/vscode-api#lm

### Where to Ask Questions

1. Comment on [Issue #134](https://github.com/thedotmack/claude-mem/issues/134)
2. Check existing worker service code in `src/services/worker-service.ts`
3. Reference Claude Code hooks in `src/hooks/` for patterns

### What to Include in Questions

- What you're trying to do (which phase, which component)
- What you've tried
- Error messages (full stack traces)
- Worker logs (from `npm run worker:logs`)
- VSCode version and extension host logs

---

**Good luck building! 🚀**

This cheat sheet should give you everything you need to get started without access to the claude-mem knowledge base. When in doubt, check the worker service code directly - it's the source of truth for API behavior.
