# Claude-Mem: AI Development Instructions

## What This Project Is

Claude-mem is a Claude Code plugin providing persistent memory across sessions. It captures tool usage, compresses observations using the Claude Agent SDK, and injects relevant context into future sessions.

**Your Role**: You are working on the plugin itself. When users interact with Claude Code with this plugin installed, your observations get captured and become their persistent memory.

**Current Version**: 5.1.3

## Critical Architecture Knowledge

### The Lifecycle Flow

1. **SessionStart** → `context-hook.ts` runs
   - Smart installer checks dependencies (cached, only runs on version changes)
   - Starts PM2 worker if not healthy
   - Injects context from previous sessions (configurable observation count)

2. **UserPromptSubmit** → `new-hook.ts` runs
   - Creates session record in SQLite
   - Saves raw user prompt for FTS5 search

3. **PostToolUse** → `save-hook.ts` runs
   - Captures your tool executions
   - Sends to worker service for AI compression

4. **Summary** → Summary hook generates session summaries

5. **SessionEnd** → `cleanup-hook.ts` runs
   - Marks session complete (graceful, not DELETE)
   - Skips on `/clear` to preserve ongoing sessions

### Key Components

**Hooks** (`src/hooks/*.ts`)
- Built to `plugin/scripts/*-hook.js` (ESM format)
- Must output valid JSON to `hookSpecificOutput` field
- Called by Claude Code lifecycle events

**Worker Service** (`src/services/worker-service.ts`)
- Express.js API on port 37777 (configurable via `CLAUDE_MEM_WORKER_PORT`)
- Managed by PM2 (auto-started by hooks)
- Built to `plugin/worker-service.cjs` (CJS format)
- Handles AI processing asynchronously to avoid hook timeouts

**Database** (`src/services/sqlite/`)
- SQLite3 with better-sqlite3 (NOT bun:sqlite - that's legacy)
- Location: `~/.claude-mem/claude-mem.db`
- FTS5 virtual tables for full-text search
- `SessionStore` = CRUD, `SessionSearch` = FTS5 queries

**MCP Search Server** (`src/servers/search-server.ts`)
- Exposes 9 search tools to Claude Code
- Configured in `plugin/.mcp.json`
- Built to `plugin/search-server.mjs` (ESM format)

**Chroma Vector Database** (`src/services/sync/ChromaSync.ts`)
- Hybrid semantic + keyword search architecture
- Automatic vector embedding synchronization
- 90-day recency filtering for relevant results
- Combined with SQLite FTS5 for optimal search performance

**Viewer UI** (`src/ui/viewer/`)
- React + TypeScript web interface accessible at http://localhost:37777
- Real-time memory stream visualization via Server-Sent Events (SSE)
- Infinite scroll pagination for observations, sessions, and user prompts
- Project filtering and settings persistence
- Built to `plugin/ui/viewer.html` (self-contained bundle via esbuild)
- Auto-reconnection and error recovery

## How to Make Changes

### When You Modify Hooks
```bash
npm run build
npm run sync-marketplace
```
Changes take effect on next Claude Code session. No worker restart needed.

### When You Modify Worker Service
```bash
npm run build
npm run sync-marketplace
npm run worker:restart
```
Must restart PM2 worker for changes to take effect.

### When You Modify MCP Server
```bash
npm run build
npm run sync-marketplace
# Restart Claude Code for MCP changes
```

### When You Modify Viewer UI
```bash
npm run build
npm run sync-marketplace
npm run worker:restart
```
Changes to React components, styles, or viewer logic require rebuilding and restarting the worker. Refresh browser to see changes.

### Build Pipeline
1. `npm run build` → Compiles TypeScript, outputs to `plugin/`
2. `npm run sync-marketplace` → Syncs to `~/.claude/plugins/marketplaces/thedotmack/`
3. Changes are live for next session (hooks/MCP) or after restart (worker)

## Coding Standards: DRY, YAGNI, and Anti-Patterns

**Philosophy**: Write the dumb, obvious thing first. Add complexity only when you actually hit the problem.

### Common Anti-Patterns to Avoid

**1. Wrapper Functions for Constants**
```typescript
// ❌ DON'T: Ceremonial wrapper that adds zero value
export function getWorkerPort(): number {
  return FIXED_PORT;
}

// ✅ DO: Export the constant directly
export const WORKER_PORT = parseInt(process.env.CLAUDE_MEM_WORKER_PORT || "37777", 10);
```

**2. Unused Default Parameters**
```typescript
// ❌ DON'T: Defaults that are never actually used
async function isHealthy(timeout: number = 3000) { ... }
// Every call: isHealthy(1000) - the default is dead code

// ✅ DO: Remove the default if no one uses it
async function isHealthy(timeout: number) { ... }
```

**3. Magic Numbers Everywhere**
```typescript
// ❌ DON'T: Unexplained magic numbers scattered throughout
if (await isWorkerHealthy(1000)) { ... }
await waitForHealth(10000);
setTimeout(resolve, 100);

// ✅ DO: Named constants with context
const HEALTH_CHECK_TIMEOUT_MS = 1000;
const HEALTH_CHECK_MAX_WAIT_MS = 10000;
const HEALTH_CHECK_POLL_INTERVAL_MS = 100;
```

**4. Overengineered Error Handling**
```typescript
// ❌ DON'T: Silent failures and defensive programming for ghosts
checkProcess.on("close", (code) => {
  // PM2 list can fail, but we should still continue - just assume worker isn't running
  resolve(); // <- Silent failure!
});

// ✅ DO: Fail fast with clear errors
checkProcess.on("close", (code) => {
  if (code !== 0) {
    reject(new Error(`PM2 not found - install dependencies first`));
  }
  resolve();
});
```

**5. Fragile String Parsing**
```typescript
// ❌ DON'T: Parse human-readable output with string matching
const isRunning = output.includes("claude-mem-worker") && output.includes("online");

// ✅ DO: Use structured output (JSON)
const processes = JSON.parse(execSync('pm2 jlist'));
const isRunning = processes.some(p => p.name === 'claude-mem-worker' && p.pm2_env.status === 'online');
```

**6. Duplicated Promise Wrappers**
```typescript
// ❌ DON'T: Copy-paste the same promise pattern multiple times
await new Promise((resolve, reject) => {
  process1.on("error", reject);
  process1.on("close", (code) => { /* ... */ });
});
// ... later ...
await new Promise((resolve, reject) => {
  process2.on("error", reject);
  process2.on("close", (code) => { /* ... same pattern */ });
});

// ✅ DO: Extract a helper function
async function waitForProcess(process: ChildProcess, validateExitCode = false): Promise<void> {
  return new Promise((resolve, reject) => {
    process.on("error", reject);
    process.on("close", (code) => {
      if (validateExitCode && code !== 0 && code !== null) {
        reject(new Error(`Process failed with exit code ${code}`));
      } else {
        resolve();
      }
    });
  });
}
```

**7. YAGNI Violations - Solving Problems You Don't Have**
```typescript
// ❌ DON'T: 50+ lines checking PM2 status before starting
const checkProcess = spawn(pm2Path, ["list", "--no-color"]);
// ... parse output ...
// ... check if running ...
// ... then maybe start it ...

// ✅ DO: Just start it (PM2 start is idempotent)
if (!await isWorkerHealthy()) {
  await startWorker(); // PM2 handles "already running" gracefully
  if (!await waitForWorkerHealth()) {
    throw new Error("Worker failed to become healthy");
  }
}
```

### Why These Patterns Appear

These anti-patterns often emerge from:
- **Training bias**: Code that looks "professional" is often overengineered
- **Risk aversion**: Optimizing for "what could go wrong" instead of "what do you actually need"
- **Pattern matching**: Seeing a problem and immediately scaffolding a framework
- **No real-world pain**: Not debugging at 2am means not feeling the cost of complexity

### The Actual Standard

1. **YAGNI (You Aren't Gonna Need It)**: Don't build it until you need it
2. **DRY (Don't Repeat Yourself)**: Extract patterns after the second duplication, not before
3. **Fail Fast**: Explicit errors beat silent failures
4. **Simple First**: Write the obvious solution, then optimize only if needed
5. **Delete Aggressively**: Less code = fewer bugs

**Reference**: See worker-utils.ts critique (conversation 2025-11-05) for detailed examples.

## Common Tasks

### Adding a New Hook
1. Create `src/hooks/new-hook.ts`
2. Add to `scripts/build-hooks.js` build list
3. Add configuration to `plugin/hooks/hooks.json`
4. Build and sync: `npm run build && npm run sync-marketplace`

### Modifying Database Schema
1. Update schema in `src/services/sqlite/schema.ts`
2. Update SessionStore/SessionSearch classes
3. Migration strategy: The plugin currently recreates on schema changes (acceptable for alpha)
4. TODO: Add proper migrations for production

### Debugging Worker Issues
```bash
pm2 list                    # Check worker status
npm run worker:logs         # View logs
npm run worker:restart      # Restart if needed
pm2 delete claude-mem-worker # Force clean start
```

### Testing Changes Locally
1. Make changes in `src/`
2. `npm run build && npm run sync-marketplace`
3. Start new Claude Code session (hooks) or restart worker (worker changes)
4. Check `~/.claude-mem/claude-mem.db` for database state
5. Use MCP search tools to verify behavior

### Version Bumps
Use the version-bump skill:
```bash
/skill version-bump
```
Choose patch/minor/major. Updates package.json, marketplace.json, plugin.json, and CLAUDE.md.

## Investigation Best Practices

**When investigations are failing persistently**, use Task agents for comprehensive file analysis instead of grep/search:

**❌ Don't:** Repeatedly grep and search for patterns when failing to find the issue

**✅ Do:** Deploy a Task agent to read files in full and answer specific questions
```
"Read these files in full and answer: [specific questions about the implementation]"
- Reduces token usage by delegating to a specialized agent
- Provides comprehensive analysis in one pass
- Finds issues that grep might miss due to poor query formulation
- More efficient than multiple rounds of searching
```

**Example:**
```
Deploy a general-purpose Task agent to:
1. Read src/hooks/context-hook.ts in full
2. Read src/servers/search-server.ts in full
3. Answer: How do these files work together? What's the current implementation state?
4. Find any bugs or inconsistencies between them
```

Use this when:
- Investigating how multiple files interact
- Search queries aren't finding what you expect
- Need complete implementation context
- Issue might be a subtle inconsistency between files

## Recent Changes

### v5.1.2 - Theme Toggle
**Theme Support**: Light/dark mode for viewer UI
- User-selectable theme with persistent settings
- Automatic system preference detection
- Smooth transitions between themes
- Settings stored in browser localStorage

### v5.1.0 - Web-Based Viewer UI
**Major Feature**: Web-Based Viewer UI for Real-Time Memory Stream
- Production-ready viewer accessible at http://localhost:37777
- Real-time visualization via Server-Sent Events (SSE) - see observations, sessions, and prompts as they happen
- Infinite scroll pagination with automatic deduplication
- Project filtering to focus on specific codebases
- Settings persistence (sidebar state, selected project)
- Auto-reconnection with exponential backoff
- GPU-accelerated animations for smooth interactions

**Worker Service API Endpoints** (14 HTTP/SSE endpoints total):

*Viewer & Health:*
- `GET /` - Serves viewer HTML (self-contained React app)
- `GET /health` - Health check endpoint
- `GET /stream` - Server-Sent Events for real-time updates

*Data Retrieval:*
- `GET /api/prompts` - Paginated user prompts with project filtering
- `GET /api/observations` - Paginated observations with project filtering
- `GET /api/summaries` - Paginated session summaries with project filtering
- `GET /api/stats` - Database statistics (total counts by project)

*Settings:*
- `GET /api/settings` - Get current viewer settings
- `POST /api/settings` - Update viewer settings

*Session Management:*
- `POST /sessions/:sessionDbId/init` - Initialize new session
- `POST /sessions/:sessionDbId/observations` - Add observations to session
- `POST /sessions/:sessionDbId/summarize` - Generate session summary
- `GET /sessions/:sessionDbId/status` - Get session status
- `DELETE /sessions/:sessionDbId` - Delete session (graceful cleanup)

**Database Enhancements** (+98 lines in SessionStore):
- `getRecentPrompts()` - Paginated prompts with OFFSET/LIMIT
- `getRecentObservations()` - Paginated observations with OFFSET/LIMIT
- `getRecentSummaries()` - Paginated summaries with OFFSET/LIMIT
- `getStats()` - Aggregated statistics by project
- `getUniqueProjects()` - Distinct project names

**Complete React UI** (17 new files, 1,500+ lines):
- Components: Header, Sidebar, Feed, Cards (Observation, Prompt, Summary, Skeleton)
- Hooks: useSSE, usePagination, useSettings, useStats
- Utils: Data merging, formatters, constants
- Assets: Monaspace Radon font, logos (dark mode + logomark)
- Build: esbuild pipeline for self-contained HTML bundle

**Why This Matters**: Users can now visualize their memory stream in real-time. See exactly what claude-mem is capturing as you work, filter by project, and understand the context being injected into sessions.

### v5.0.3 - Smart Install Caching
**Smart Caching Installer for Windows Compatibility**:
- Eliminated redundant npm install on every SessionStart (2-5s → 10ms)
- Caches version in `.install-version` file
- Only runs npm install when actually needed (first time, version change, missing deps)
- 200x performance improvement for cached installations

### v5.0.0 - Hybrid Search Architecture
**Major Feature**: Chroma Vector Database Integration
- Hybrid semantic + keyword search combining ChromaDB with SQLite FTS5
- ChromaSync service for automatic vector embedding synchronization (738 lines)
- 90-day recency filtering for contextually relevant results
- New MCP tools: `get_context_timeline` and `get_timeline_by_query`
- Performance: Semantic search <200ms with 8,000+ vector documents
- Enhanced all 9 MCP search tools with hybrid search capabilities

## Configuration Users Can Set

**Model Selection** (`~/.claude/settings.json`):
```json
{
  "env": {
    "CLAUDE_MEM_MODEL": "claude-haiku-4-5"  // or sonnet-4-5, opus-4, etc.
  }
}
```

**Context Observation Count** (`~/.claude/settings.json`):
```json
{
  "env": {
    "CLAUDE_MEM_CONTEXT_OBSERVATIONS": "50"  // default, adjust based on needs
  }
}
```

**Worker Port** (`~/.claude/settings.json`):
```json
{
  "env": {
    "CLAUDE_MEM_WORKER_PORT": "37777"  // default
  }
}
```

## Key Design Decisions

### Why PM2 Instead of Direct Process
Hooks have strict timeout limits. PM2 manages a persistent background worker, allowing AI processing to continue after hooks complete.

### Why SQLite FTS5
Enables instant full-text search across thousands of observations without external dependencies. Automatic sync triggers keep FTS5 tables synchronized.

### Why Graceful Cleanup (v4.1.0)
Changed from aggressive DELETE requests to marking sessions complete. Prevents interrupting summary generation and other async operations.

### Why Smart Install Caching (v5.0.3)
npm install is expensive (2-5s). Caching version state and only installing on changes makes SessionStart nearly instant (10ms).

### Why Web-Based Viewer UI (v5.1.0)
Real-time visibility into memory stream helps users understand what's being captured and how context is being built. SSE provides instant updates without polling. Self-contained HTML bundle (esbuild) eliminates deployment complexity - everything served from a single file.

## File Locations

**Source**: `<project-root>/src/` - TypeScript source files
**Built Plugin**: `<project-root>/plugin/` - Compiled JavaScript outputs
**Installed Plugin**: `~/.claude/plugins/marketplaces/thedotmack/` - User's installed plugin location
**Database**: `~/.claude-mem/claude-mem.db` - SQLite database with observations, sessions, summaries
**Chroma Database**: `~/.claude-mem/chroma/` - Vector embeddings for semantic search
**Usage Logs**: `~/.claude-mem/usage-logs/usage-YYYY-MM-DD.jsonl` - Daily API usage tracking

## Quick Reference

**Build**: `npm run build`
**Sync**: `npm run sync-marketplace`
**Worker Restart**: `npm run worker:restart`
**Worker Logs**: `npm run worker:logs`
**Version Bump**: `/skill version-bump`
**Usage Analysis**: `npm run usage:today`
**Viewer UI**: http://localhost:37777 (auto-starts with worker)
