# Worker Service Architecture

## Overview

The Worker Service is an Express HTTP server that handles all claude-mem operations. It runs on port 37777 (configurable via `CLAUDE_MEM_WORKER_PORT`) and is managed by PM2.

## Request Flow

```
Hook (plugin/scripts/*-hook.js)
  → HTTP Request to Worker (localhost:37777)
    → Route Handler (http/routes/*.ts)
      → MCP Server Tool (for search) OR Service Layer (for session/data)
        → Database (SQLite3 + Chroma vector DB)
```

## Directory Structure

```
src/services/worker/
├── README.md                     # This file
├── WorkerService.ts              # Slim orchestrator (~150 lines)
├── http/                         # HTTP layer
│   ├── middleware.ts             # Shared middleware (logging, CORS, etc.)
│   └── routes/                   # Route handlers organized by feature area
│       ├── SessionRoutes.ts      # Session lifecycle (init, observations, summarize, complete)
│       ├── DataRoutes.ts         # Data retrieval (get observations, summaries, prompts, stats)
│       ├── SearchRoutes.ts       # Search/MCP proxy (all search endpoints)
│       ├── SettingsRoutes.ts     # Settings, MCP toggle, branch switching
│       └── ViewerRoutes.ts       # Health check, viewer UI, SSE stream
└── services/                     # Business logic services (existing, NO CHANGES in Phase 1)
    ├── DatabaseManager.ts        # SQLite connection management
    ├── SessionManager.ts         # Session state tracking
    ├── SDKAgent.ts               # Claude Agent SDK for observations/summaries
    ├── SSEBroadcaster.ts         # Server-Sent Events for real-time updates
    ├── PaginationHelper.ts       # Query pagination utilities
    ├── SettingsManager.ts        # User settings CRUD
    └── BranchManager.ts          # Git branch operations
```

## Route Organization

### ViewerRoutes.ts
- `GET /health` - Health check endpoint
- `GET /` - Serve viewer UI (React app)
- `GET /stream` - SSE stream for real-time updates

### SessionRoutes.ts
Session lifecycle operations (use service layer directly):
- `POST /sessions/init` - Initialize new session
- `POST /sessions/:sessionId/observations` - Add tool usage observations
- `POST /sessions/:sessionId/summarize` - Trigger session summary
- `GET /sessions/:sessionId/status` - Get session status
- `DELETE /sessions/:sessionId` - Delete session
- `POST /sessions/:sessionId/complete` - Mark session complete
- `POST /sessions/claude-id/:claudeId/observations` - Add observations by claude_id
- `POST /sessions/claude-id/:claudeId/summarize` - Summarize by claude_id
- `POST /sessions/claude-id/:claudeId/complete` - Complete by claude_id

### DataRoutes.ts
Data retrieval operations (use service layer directly):
- `GET /observations` - List observations (paginated)
- `GET /summaries` - List session summaries (paginated)
- `GET /prompts` - List user prompts (paginated)
- `GET /observations/:id` - Get observation by ID
- `GET /sessions/:sessionId` - Get session by ID
- `GET /prompts/:id` - Get prompt by ID
- `GET /stats` - Get database statistics
- `GET /projects` - List all projects
- `GET /processing` - Get processing status
- `POST /processing` - Set processing status

### SearchRoutes.ts
All search operations (proxy to MCP server):
- `GET /search` - Unified search (observations + sessions + prompts)
- `GET /timeline` - Unified timeline context
- `GET /decisions` - Decision-type observations
- `GET /changes` - Change-related observations
- `GET /how-it-works` - How-it-works explanations
- `GET /search/observations` - Search observations
- `GET /search/sessions` - Search sessions
- `GET /search/prompts` - Search prompts
- `GET /search/by-concept` - Find by concept tag
- `GET /search/by-file` - Find by file path
- `GET /search/by-type` - Find by observation type
- `GET /search/recent-context` - Get recent context
- `GET /search/context-timeline` - Get context timeline
- `GET /context/preview` - Preview context
- `GET /context/inject` - Inject context
- `GET /search/timeline-by-query` - Timeline by search query
- `GET /search/help` - Search help

### SettingsRoutes.ts
Settings and configuration (use service layer directly):
- `GET /settings` - Get user settings
- `POST /settings` - Update user settings
- `GET /mcp/status` - Get MCP server status
- `POST /mcp/toggle` - Toggle MCP server on/off
- `GET /branch/status` - Get git branch info
- `POST /branch/switch` - Switch git branch
- `POST /branch/update` - Pull branch updates

## Current State (Phase 1)

**Phase 1** is a pure code reorganization with ZERO functional changes:
- Extract route handlers from WorkerService.ts monolith
- Organize into logical route classes
- Keep all existing behavior identical

**MCP vs Direct DB Split** (inherited, not changed in Phase 1):
- Search operations → MCP server (mem-search)
- Session/data operations → Direct DB access via service layer

## Future Phase 2

Phase 2 will unify the architecture:
1. Expand MCP server to handle ALL operations (not just search)
2. Convert all route handlers to proxy through MCP
3. Move database logic from service layer into MCP tools
4. Result: Worker becomes pure HTTP → MCP proxy for maximum portability

This separation allows the worker to be deployed anywhere (as a CLI tool, cloud service, etc.) without carrying database dependencies.

## Adding New Endpoints

1. Choose the appropriate route file based on the endpoint's purpose
2. Add the route handler method to the class
3. Register the route in the `setupRoutes()` method
4. Import any needed services in the constructor
5. Follow the existing patterns for error handling and logging

Example:
```typescript
// In DataRoutes.ts
private async handleGetFoo(req: Request, res: Response): Promise<void> {
  try {
    const result = await this.dbManager.getFoo();
    res.json(result);
  } catch (error) {
    logger.failure('WORKER', 'Get foo failed', {}, error as Error);
    res.status(500).json({ error: (error as Error).message });
  }
}

// Register in setupRoutes()
app.get('/foo', this.handleGetFoo.bind(this));
```

## Key Design Principles

1. **Progressive Disclosure**: Navigate from high-level (WorkerService.ts) to specific routes to implementation details
2. **Single Responsibility**: Each route class handles one feature area
3. **Dependency Injection**: Route classes receive only the services they need
4. **Consistent Error Handling**: All handlers use try/catch with logger.failure()
5. **Bound Methods**: All route handlers use `.bind(this)` to preserve context
