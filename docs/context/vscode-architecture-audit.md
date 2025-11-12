# VSCode Extension Architecture Audit

## Executive Summary
This document outlines the findings from auditing the existing claude-mem plugin architecture to guide VSCode extension development.

## Existing Hook Architecture (Claude Code)

### 1. context-hook (SessionStart)
- **Purpose**: Inject previous session context at session start
- **Database Operations**: Queries recent observations and summaries
- **Worker Interaction**: None (reads directly from DB)
- **Output**: Formatted context injected into session

### 2. new-hook (UserPromptSubmit)
- **Purpose**: Initialize session and log user prompt
- **Database Operations**:
  - `createSDKSession(session_id, project, prompt)` - Idempotent session creation
  - `incrementPromptCounter(sessionDbId)` - Track prompt numbers
  - `saveUserPrompt(session_id, promptNumber, prompt)` - Save for FTS search
- **Worker Interaction**: `POST /sessions/:sessionDbId/init`
  - Body: `{ project, userPrompt, promptNumber }`
  - Timeout: 5000ms
- **Key Insights**: Session ID is the single source of truth, shared across all hooks

### 3. save-hook (PostToolUse)
- **Purpose**: Capture tool usage for AI compression
- **Database Operations**:
  - `createSDKSession(session_id, '', '')` - Get or create session
  - `getPromptCounter(sessionDbId)` - Get current prompt number
- **Worker Interaction**: `POST /sessions/:sessionDbId/observations`
  - Body: `{ tool_name, tool_input, tool_response, prompt_number, cwd }`
  - Timeout: 2000ms
- **Skipped Tools**: `ListMcpResourcesTool` (low value)

### 4. summary-hook (Stop)
- **Purpose**: Generate session summary when user stops
- **Database Operations**:
  - `createSDKSession(session_id, '', '')` - Get or create session
  - `getPromptCounter(sessionDbId)` - Get current prompt number
- **Worker Interaction**: `POST /sessions/:sessionDbId/summarize`
  - Body: `{ prompt_number, last_user_message }`
  - Timeout: 2000ms
- **Additional**: Reads transcript JSONL to extract last user message

### 5. cleanup-hook (SessionEnd)
- **Purpose**: Mark session complete on exit
- **Database Operations**:
  - `findActiveSDKSession(session_id)` - Find active session
  - `markSessionCompleted(sessionDbId)` - Mark as completed
- **Worker Interaction**: `POST /sessions/:sessionDbId/complete`
  - No body
  - Timeout: 1000ms
- **Behavior**: Skips on `/clear` to preserve ongoing sessions

## Worker Service REST API

### Session Management Endpoints
| Endpoint | Method | Purpose | Request Body | Response |
|----------|--------|---------|--------------|----------|
| `/health` | GET | Health check | None | `{ status: 'ok' }` |
| `/sessions/:id/init` | POST | Initialize session | `{ project, userPrompt, promptNumber }` | Success/Error |
| `/sessions/:id/observations` | POST | Add observation | `{ tool_name, tool_input, tool_response, prompt_number, cwd }` | Success/Error |
| `/sessions/:id/summarize` | POST | Generate summary | `{ prompt_number, last_user_message }` | Success/Error |
| `/sessions/:id/status` | GET | Get session status | None | `{ status, pendingCount }` |
| `/sessions/:id/complete` | POST | Mark complete | None | Success/Error |
| `/sessions/:id` | DELETE | Delete session | None | Success/Error |

### Data Retrieval Endpoints
- `GET /api/observations` - Paginated observations
- `GET /api/summaries` - Paginated summaries
- `GET /api/prompts` - Paginated prompts
- `GET /api/stats` - Database statistics
- `GET /api/processing-status` - Current processing state

### Search API Endpoints (for skill-based search)
- `GET /api/search/observations` - Full-text search observations
- `GET /api/search/sessions` - Full-text search sessions
- `GET /api/search/prompts` - Full-text search prompts
- `GET /api/search/by-concept` - Search by concept tags
- `GET /api/search/by-file` - Search by file path
- `GET /api/search/by-type` - Search by observation type
- `GET /api/context/recent` - Get recent context
- `GET /api/context/timeline` - Get timeline
- `GET /api/timeline/by-query` - Get timeline by query
- `GET /api/search/help` - API help documentation

## Shared Utilities

### worker-utils.ts
```typescript
// Get worker port (from settings > env > default)
export function getWorkerPort(): number

// Check worker health and fail with instructions
export async function ensureWorkerRunning(): Promise<void>
```

### Database Types (worker-types.ts)
- `ActiveSession` - In-memory session state
- `PendingMessage` - Queued observation/summary
- `ObservationData` - Tool usage data
- `Observation` - DB record
- `Summary` - DB record
- `UserPrompt` - DB record
- `DBSession` - DB record

## VSCode Extension Mapping

### Language Model Tools (5 tools)
1. **mem_session_init** - Maps to new-hook + `/sessions/:id/init`
2. **mem_user_prompt_log** - Maps to new-hook (user prompt logging only)
3. **mem_observation_record** - Maps to save-hook + `/sessions/:id/observations`
4. **mem_summary_finalize** - Maps to summary-hook + `/sessions/:id/summarize`
5. **mem_session_cleanup** - Maps to cleanup-hook + `/sessions/:id/complete`

### Key Differences from Claude Code
1. **No SessionStart Hook**: VSCode doesn't have session start hook
   - Solution: Auto-run mem_session_init when chat participant starts
2. **No Direct DB Access**: Extension runs in separate process
   - Solution: Use worker HTTP API for all operations
3. **Different Event Model**: Copilot uses chat turns, not hooks
   - Solution: Map chat participant lifecycle to tool calls
4. **Tool Event Capture**: Copilot emits tool events
   - Solution: Listen to tool events and forward to mem_observation_record

## Configuration

### Settings Priority (existing pattern)
1. `~/.claude-mem/settings.json` - User settings
2. Environment variables
3. Default values

### Configurable Values
- `CLAUDE_MEM_WORKER_PORT` - Worker port (default: 37777)
- `CLAUDE_MEM_CONTEXT_OBSERVATIONS` - Observation count (default: 50)
- `CLAUDE_MEM_MODEL` - Model selection (default: claude-haiku-4-5)

## Error Handling Patterns

### Worker Connection Errors
```typescript
if (error.cause?.code === 'ECONNREFUSED' ||
    error.name === 'TimeoutError' ||
    error.message.includes('fetch failed')) {
  throw new Error("Worker problem - run: pm2 restart claude-mem-worker");
}
```

### HTTP Error Handling
- Non-2xx responses are thrown as errors
- Connection errors show restart instructions
- HTTP errors are re-thrown as-is

## Next Steps for Extension

1. **Create Extension Scaffold**
   - Clone VS Code chat-sample
   - Add TypeScript-only setup
   - Configure build pipeline

2. **Extract Shared Worker Client**
   - Create `src/vscode/worker-client.ts`
   - Export functions: `initSession`, `recordObservation`, `generateSummary`, `completeSession`
   - Reuse worker-utils pattern for port discovery and health checks

3. **Define Tool Contracts**
   - Add `contributes.languageModelTools` to package.json
   - Mirror hook input structures in JSON schemas
   - Provide clear descriptions for LLM invocation

4. **Implement Chat Participant**
   - Map Copilot conversation ID to claude-mem session ID
   - Auto-run mem_session_init on first turn
   - Capture tool events and forward to worker
   - Handle conversation disposal with cleanup

5. **Settings and UX**
   - Read from `~/.claude-mem/settings.json`
   - Add VS Code settings for Copilot-specific toggles
   - Status bar indicator for worker health
   - Quick actions for worker restart
