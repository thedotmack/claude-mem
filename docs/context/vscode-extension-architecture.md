# VSCode Extension Architecture for Claude-Mem

**Status**: Draft - Awaiting Approval
**Created**: 2025-11-18
**Purpose**: Define architecture for VSCode Copilot integration with claude-mem

## Executive Summary

This document defines the architecture for extending claude-mem to work with VSCode Copilot. The extension will provide persistent memory across Copilot sessions by capturing tool usage and injecting relevant context, mirroring the functionality currently available in Claude Code.

## Core Architecture Principles

### 1. Dual Integration Pattern

**Chat Participant (Automatic Lifecycle)**
- Handles automatic session management (invisible to Copilot)
- Creates sessions on conversation start
- Logs user prompts automatically
- Captures Copilot's tool invocations as observations
- Injects context at conversation start
- Finalizes summaries on conversation end

**Language Model Tools (Explicit Capabilities)**
- Provides semantic search capabilities to Copilot
- Copilot decides when to invoke these tools
- Extends Copilot's knowledge with past project context
- Tools are discoverable and user-referenceable via `#`

**Why Both?**
The participant handles plumbing (lifecycle) while tools provide capabilities (search/retrieve). This separation means Copilot doesn't need to understand our internal lifecycle - it just gets extended with memory capabilities.

### 2. Shared Worker Service Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         VSCode                               │
│                                                              │
│  ┌──────────────────┐              ┌────────────────────┐  │
│  │ Chat Participant │              │ Language Model     │  │
│  │                  │              │ Tools              │  │
│  │ - Session init   │              │ - mem_search       │  │
│  │ - Prompt logging │              │ - mem_get_recent   │  │
│  │ - Observation    │              │ - mem_timeline     │  │
│  │   capture        │              │ - mem_find_file    │  │
│  │ - Context inject │              │                    │  │
│  │ - Cleanup        │              │                    │  │
│  └────────┬─────────┘              └──────────┬─────────┘  │
│           │                                    │             │
│           │         ┌──────────────────────┐  │             │
│           └────────▶│  Worker Client Lib   │◀─┘             │
│                     │  (src/shared/)       │                │
│                     └──────────┬───────────┘                │
└────────────────────────────────┼────────────────────────────┘
                                 │
                                 │ HTTP (localhost:37777)
                                 │
                     ┌───────────▼────────────┐
                     │  Worker Service        │
                     │  (PM2 managed)         │
                     │                        │
                     │  - POST /sessions      │
                     │  - POST /observations  │
                     │  - POST /summaries     │
                     │  - POST /search        │
                     │  - GET /viewer         │
                     └────────────────────────┘
                                 │
                    ┌────────────┴────────────┐
                    │                         │
            ┌───────▼────────┐       ┌───────▼────────┐
            │ SQLite         │       │ ChromaDB       │
            │ (~/.claude-mem)│       │ (Vector Store) │
            └────────────────┘       └────────────────┘
```

**Key Points:**
- Worker service is shared between Claude Code plugin and VSCode extension
- Both clients use the same HTTP API (port 37777, configurable)
- Worker handles all AI processing (observation compression, summaries)
- Extension is lightweight - just HTTP client + VSCode API bindings

### 3. Event Mapping Strategy

**Claude Code Plugin Flow → VSCode Extension Flow**

| Claude Code Hook | VSCode Equivalent | Implementation |
|-----------------|-------------------|----------------|
| `SessionStart` (context-hook) | Chat participant request handler start | Retrieve context via GET /search, inject into chat |
| `UserPromptSubmit` (new-hook) | `vscode.chat` message event | POST /sessions with user message text |
| `PostToolUse` (save-hook) | Tool invocation observation | Monitor chat tool results, POST /observations |
| `Summary` (summary hook) | Conversation end/timeout | POST /summaries when chat session ends |
| `SessionEnd` (cleanup-hook) | Chat participant disposal | PUT /sessions/:id/complete |

**Critical Difference:**
Claude Code hooks are passive (event listeners). VSCode requires active orchestration by the chat participant. The participant must actively monitor conversation state and trigger lifecycle events.

## Detailed Component Design

### Component 1: Worker Service Client Library

**Location**: `src/shared/worker-client.ts`

**Purpose**: Shared TypeScript client for worker service HTTP API

**Interface**:
```typescript
class WorkerClient {
  constructor(port?: number)  // Defaults to 37777 or CLAUDE_MEM_WORKER_PORT

  // Session management
  async createSession(params: CreateSessionParams): Promise<Session>
  async updateSession(id: string, updates: SessionUpdates): Promise<void>
  async completeSession(id: string): Promise<void>

  // Observations
  async createObservation(params: ObservationParams): Promise<Observation>

  // Search
  async search(params: SearchParams): Promise<SearchResult[]>

  // Summaries
  async generateSummary(sessionId: string): Promise<Summary>

  // Health check
  async isHealthy(): Promise<boolean>
}
```

**Error Handling**:
- `WorkerUnavailableError` - Worker not running or port unreachable
- `WorkerTimeoutError` - Request exceeded timeout
- `WorkerValidationError` - Invalid request parameters
- All methods support retry logic with exponential backoff

**Why Shared?**
Future work can refactor Claude Code hooks to use this client, ensuring identical behavior between both integrations.

### Component 2: Language Model Tools

**Location**: `src/vscode/tools/`

**Tools Exposed**:

#### 1. `mem_search`
- **Purpose**: Semantic search across past observations and sessions
- **Input Schema**: `{ query: string, dateRange?: DateRange, project?: string }`
- **Model Description**: "Search claude-mem's persistent memory for relevant past work, decisions, and context. Use when you need to recall previous implementations, debugging sessions, or project decisions."
- **Implementation**: Calls `WorkerClient.search()`, formats results as LanguageModelToolResult

#### 2. `mem_get_recent`
- **Purpose**: Get recent work summaries
- **Input Schema**: `{ count?: number, project?: string }`
- **Model Description**: "Retrieve recent session summaries to understand what work has been done recently in this project."
- **Implementation**: Calls `WorkerClient.search()` with recency filter

#### 3. `mem_timeline`
- **Purpose**: Chronological timeline of past work
- **Input Schema**: `{ dateRange?: DateRange, filePath?: string }`
- **Model Description**: "Get a chronological timeline of observations and decisions, optionally filtered by date or file path."
- **Implementation**: Calls `WorkerClient.search()` with timeline formatting

#### 4. `mem_find_file`
- **Purpose**: Find observations related to specific files
- **Input Schema**: `{ filePath: string }`
- **Model Description**: "Find all observations, decisions, and changes related to a specific file or file pattern."
- **Implementation**: Calls `WorkerClient.search()` with file filter

**Confirmation Strategy**:
All tools use `prepareInvocation` to show user-friendly confirmation messages. Example:
```typescript
prepareInvocation: async (options) => ({
  invocationMessage: `Searching claude-mem for: "${options.input.query}"`,
  confirmationMessages: {
    title: 'Search Memory',
    message: new MarkdownString(`Search past observations for **${options.input.query}**?`)
  }
})
```

**Tool Registration**:
- Declared in `package.json` under `contributes.languageModelTools`
- Registered in extension activation with `vscode.lm.registerTool()`
- `canBeReferencedInPrompt: true` for all tools (users can invoke with `#`)

### Component 3: Chat Participant

**Location**: `src/vscode/participant/`

**Registration**:
```typescript
const participant = vscode.chat.createChatParticipant(
  'claude-mem.memory',
  requestHandler
);
participant.iconPath = vscode.Uri.file('icon.png');
```

**Conversation State Management**:
```typescript
// Map VSCode conversation IDs to claude-mem session IDs
const conversationSessions = new Map<string, string>();

// Track last context injection timestamp per conversation
const contextInjectionTimestamps = new Map<string, number>();
```

**Request Handler Responsibilities**:

1. **First Message in Conversation**:
   - Create session: `WorkerClient.createSession({ cwd, project, timestamp })`
   - Store mapping: `conversationSessions.set(conversationId, sessionId)`
   - Retrieve context: `WorkerClient.search({ recency: true, limit: 50 })`
   - Inject context into response with metadata indicating it's from memory

2. **Subsequent Messages**:
   - Log prompt: `WorkerClient.updateSession(sessionId, { lastPrompt: message })`
   - Check if context refresh needed (e.g., >30 minutes since last injection)
   - Respond normally (Copilot handles the actual response)

3. **Tool Invocation Observation**:
   - Subscribe to `vscode.chat` events for tool invocations
   - Extract: `{ toolName, parameters, result, timestamp }`
   - Send: `WorkerClient.createObservation({ sessionId, toolName, ... })`

4. **Conversation End**:
   - Triggered by: VSCode conversation disposal or extension deactivation
   - Generate summary: `WorkerClient.generateSummary(sessionId)`
   - Complete session: `WorkerClient.completeSession(sessionId)`
   - Clean up maps: `conversationSessions.delete(conversationId)`

**Error Handling**:
- If worker unavailable: Log warning, continue without memory features
- If session creation fails: Try to continue without session tracking
- If observation logging fails: Silent failure (don't interrupt conversation)
- Show status bar warning when worker is unavailable

### Component 4: Settings & Configuration

**VSCode Settings** (`package.json` contributions):
```json
{
  "claude-mem.workerPort": {
    "type": "number",
    "default": 37777,
    "description": "Port where claude-mem worker service runs"
  },
  "claude-mem.contextObservationCount": {
    "type": "number",
    "default": 50,
    "description": "Number of past observations to inject at conversation start"
  },
  "claude-mem.autoSync": {
    "type": "boolean",
    "default": true,
    "description": "Automatically capture observations during Copilot conversations"
  }
}
```

**Status Bar Integration**:
- Show worker health status
- Click to open viewer UI (http://localhost:37777)
- Warning indicator when worker unavailable

**Commands**:
- `claude-mem.restartWorker` - Restart PM2 worker
- `claude-mem.openViewer` - Open viewer UI in browser
- `claude-mem.viewStats` - Show extension statistics

## Key Design Decisions & Rationale

### Decision 1: Chat Participant vs Language Model Tools

**Decision**: Implement both a chat participant AND language model tools

**Rationale**:
- **Chat Participant** handles automatic lifecycle (session management, observation capture)
- **Language Model Tools** provide explicit capabilities to Copilot (search, retrieve)
- Copilot doesn't need to know about our internal lifecycle - it just gets memory capabilities
- Separation of concerns: plumbing vs features

**Alternative Considered**: Only language model tools (with lifecycle tools like `mem_session_init`)
**Why Rejected**: Forces Copilot to understand our internal architecture. Copilot would need to know when to call `mem_session_init`, which breaks abstraction.

### Decision 2: Shared Worker Service

**Decision**: Reuse existing worker service on port 37777

**Rationale**:
- Worker service already has all logic for AI processing, database access, vector search
- Avoids code duplication
- Ensures identical behavior between Claude Code and VSCode integrations
- Enables unified viewer UI for both clients

**Alternative Considered**: Embed worker logic directly in extension
**Why Rejected**: Would require bundling Chroma, SQLite, Claude SDK in VSCode extension. Increases complexity, bundle size, and maintenance burden.

### Decision 3: Observation Capture Strategy

**Decision**: Monitor VSCode chat tool invocation events, not filesystem watchers

**Rationale**:
- VSCode provides `vscode.chat` API with tool invocation events
- More reliable than filesystem watchers (captures intent, not just changes)
- Can capture non-file actions (terminal commands, API calls)
- Matches Claude Code's PostToolUse hook semantics

**Alternative Considered**: Watch workspace file changes
**Why Rejected**: Doesn't capture context (why the change was made), misses non-file actions, noisy with unrelated changes.

### Decision 4: Context Injection Timing

**Decision**: Inject context on first message, refresh if conversation is long (>30 min)

**Rationale**:
- Balances freshness vs token cost
- Most conversations are short (<30 min)
- Prevents stale context in long-running conversations
- Matches Claude Code SessionStart behavior

**Alternative Considered**: Inject context on every message
**Why Rejected**: Excessive token usage, redundant context, slower responses.

### Decision 5: File Structure

**Decision**: Add `src/shared/` and `src/vscode/` to existing monorepo

**Rationale**:
- Keeps related code together
- Easy to share TypeScript types
- Single build process
- Separate output directories maintain distribution separation

**Alternative Considered**: Separate `vscode-extension/` top-level directory
**Why Rejected**: Harder to share code, duplicate dependencies, complex build coordination.

## Implementation Phases Summary

See main plan for detailed phase breakdown. Key milestones:

- **Milestone 1**: Foundation (Phases 1-3) - Scaffold and client library
- **Milestone 2**: Tools Working (Phases 4-6) - All tools invokable from Copilot
- **Milestone 3**: Participant Working (Phases 7-10) - Full lifecycle automation
- **Milestone 4**: Production Ready (Phases 11-15) - Polish, test, release

## Testing Strategy

**Unit Tests**:
- Worker client library (mock HTTP responses)
- Tool implementations (mock worker client)

**Integration Tests**:
- Chat participant lifecycle (mock VSCode chat API)
- End-to-end with test worker service

**Manual Testing**:
- Real Copilot conversations
- Worker down scenarios
- Multi-project workspaces
- Long-running conversations

## Security Considerations

1. **Worker Service Access**: Only localhost, same security as Claude Code plugin
2. **User Confirmation**: All tools require user confirmation before execution
3. **Data Privacy**: All data stays local in ~/.claude-mem/
4. **No External Services**: Extension only communicates with local worker

## Success Criteria

**Phase 1 Success** (This Document):
- [ ] Architecture clearly explains tool vs participant responsibilities
- [ ] Event mappings are well-defined
- [ ] Design decisions are justified with rationale
- [ ] User reviews and approves architecture
- [ ] No major architectural questions remain

**Overall Project Success**:
- VSCode Copilot users can search past project context via tools
- Sessions are automatically captured without user intervention
- Extension gracefully handles worker unavailability
- Published to VSCode Marketplace
- Documentation enables new users to install and use successfully

## Open Questions for User Review

1. **Tool Naming**: Should tools use `mem_` prefix or different convention (e.g., `claudemem_`)?
2. **Context Injection**: Is 50 observations a good default, or should it be configurable per-conversation?
3. **Refresh Strategy**: Is 30-minute threshold for context refresh appropriate?
4. **Observation Filtering**: Should we filter out trivial observations (e.g., file reads) or capture everything?
5. **Status Indicator**: Should status bar always show, or only when worker is unavailable?

## Next Steps After Approval

1. User reviews this document
2. User approves architecture or requests changes
3. Proceed to Phase 2: Project Scaffold
4. Begin implementation following this design

---

**Review Checklist**:
- [ ] Architecture is clear and well-justified
- [ ] Component responsibilities are well-defined
- [ ] Event mappings are complete
- [ ] Design decisions have strong rationale
- [ ] Open questions are addressed
- [ ] Ready to proceed to implementation
