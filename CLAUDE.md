# Claude-Mem: AI Development Instructions

## What This Project Is

Claude-mem is a Claude Code plugin providing persistent memory across sessions. It captures tool usage, compresses observations using the Claude Agent SDK, and injects relevant context into future sessions.

**Your Role**: You are working on the plugin itself. When users interact with Claude Code with this plugin installed, your observations get captured and become their persistent memory.

**Current Version**: 6.0.9

## IMPORTANT: Skills Are Auto-Invoked

**There is no `/skill` command.** Skills auto-invoke based on description metadata matching user queries. Don't document manual invocation (e.g., "Run `/skill troubleshoot`"). Instead: "The troubleshoot skill auto-activates when issues are detected."

## Critical Architecture Knowledge

### The Lifecycle Flow

1. **SessionStart** → smart-install.js runs first (pre-hook), then `context-hook.ts` runs
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

**Note**: smart-install.js is a pre-hook script (not a lifecycle hook). It's called before context-hook via command chaining in hooks.json and only runs when dependencies need updating.

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

**Search Skill** (`plugin/skills/mem-search/SKILL.md`)
- Provides access to all search functionality via HTTP API + skill
- Auto-invoked when users ask about past work, decisions, or history
- Uses HTTP endpoints instead of MCP tools (~2,250 token savings per session)
- 10 search operations: observations, sessions, prompts, by-type, by-file, by-concept, timelines, etc.

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

### When You Modify Search Skill
```bash
npm run sync-marketplace
```
Skill changes take effect immediately on next Claude Code session. No build or restart needed (skills are markdown).

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
3. Changes are live for next session (hooks/skills) or after restart (worker)

## Coding Standards

**Philosophy**: Write the dumb, obvious thing first. Add complexity only when you hit the problem.

**Key Principles:**
1. **YAGNI**: Don't build it until you need it
2. **DRY**: Extract patterns after second duplication, not before
3. **Fail Fast**: Explicit errors beat silent failures
4. **Simple First**: Write the obvious solution, optimize only if needed
5. **Delete Aggressively**: Less code = fewer bugs

**Common anti-patterns to avoid:**
- Ceremonial wrapper functions for constants (just export the constant)
- Unused default parameters (remove if never used)
- Magic numbers without named constants
- Silent failures instead of explicit errors
- Fragile string parsing (use structured JSON output)
- Copy-pasted promise wrappers (extract helper functions)
- Overengineered "defensive" code for problems you don't have

## Common Tasks

### Adding a New Hook
1. Create `src/hooks/new-hook.ts`
2. Add to `scripts/build-hooks.js` build list
3. Add configuration to `plugin/hooks/hooks.json`
4. Build and sync: `npm run build && npm run sync-marketplace`

**Note**: smart-install.js is not a hook - it's a pre-hook dependency checker that runs before context-hook via command chaining.

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
5. Use mem-search skill to verify behavior (auto-invoked when asking about past work)

### Version Bumps
Use the `version-bump` skill (auto-invokes when requesting version updates). It handles:
- Semantic version increments (patch/minor/major)
- Updates all version references (package.json, plugin.json, CLAUDE.md, marketplace.json)
- Creates git tags and GitHub releases
- Auto-generates CHANGELOG.md from releases

## Investigation Best Practices

When investigations fail persistently, use Task agents for comprehensive file analysis instead of repeated grep/search. Deploy agents to read full files and answer specific questions - more efficient than multiple rounds of searching.

## Environment Variables

- `CLAUDE_MEM_MODEL` - Model for observations/summaries (default: claude-haiku-4-5)
- `CLAUDE_MEM_CONTEXT_OBSERVATIONS` - Observations injected at SessionStart (default: 50)
- `CLAUDE_MEM_WORKER_PORT` - Worker service port (default: 37777)

## Key Design Decisions

### Why PM2 Instead of Direct Process
Hooks have strict timeout limits. PM2 manages a persistent background worker, allowing AI processing to continue after hooks complete.

### Why SQLite FTS5
Enables instant full-text search across thousands of observations without external dependencies. Automatic sync triggers keep FTS5 tables synchronized.

### Why Graceful Cleanup
Changed from aggressive DELETE requests to marking sessions complete. Prevents interrupting summary generation and other async operations.

### Why Smart Install Caching
npm install is expensive (2-5s). Caching version state and only installing on changes makes SessionStart nearly instant (10ms).

### Why Web-Based Viewer UI
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
**Usage Analysis**: `npm run usage:today`
**Viewer UI**: http://localhost:37777 (auto-starts with worker)
