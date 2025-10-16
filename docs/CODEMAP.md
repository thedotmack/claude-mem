# Claude-Mem Codebase Map

**Version**: 3.9.16
**Description**: Memory compression system for Claude Code - persist context across sessions

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Architecture Overview](#architecture-overview)
3. [Directory Structure](#directory-structure)
4. [Core Components](#core-components)
5. [Entry Points & CLI](#entry-points--cli)
6. [Commands](#commands)
7. [Hooks System](#hooks-system)
8. [SDK & Worker](#sdk--worker)
9. [Services](#services)
10. [Shared Components](#shared-components)
11. [Utilities](#utilities)
12. [Key Workflows](#key-workflows)

---

## Project Overview

**claude-mem** is a sophisticated memory compression system designed to persist context across Claude Code sessions. It provides:

- **Automatic memory capture** via Claude Code hooks (SessionStart, Stop, UserPromptSubmit, PostToolUse)
- **SDK-powered intelligence** that extracts meaningful insights from tool observations
- **Vector storage** using Chroma MCP for semantic search
- **SQLite persistence** for structured data and session summaries
- **Smart trash system** with file recovery capabilities
- **Cross-platform support** (Windows, macOS, Linux)

---

## Architecture Overview

### High-Level Flow

```
User Works in Claude Code
         ↓
    Hooks Trigger
         ↓
┌────────────────────────────────────┐
│  SessionStart → context hook       │  Shows recent memories
│  UserPromptSubmit → new hook       │  Spawns SDK worker
│  PostToolUse → save hook           │  Queues observations
│  Stop → summary hook               │  Finalizes session
└────────────────────────────────────┘
         ↓
   SDK Worker Process
   (Background daemon)
         ↓
  ┌──────────────────────┐
  │  Claude Agent SDK    │  Analyzes observations
  │  Streaming Session   │  Extracts insights
  └──────────────────────┘
         ↓
    ┌─────────┬─────────┐
    │ SQLite  │ Chroma  │  Persistent storage
    └─────────┴─────────┘
         ↓
  Next Session Start
  (Memories restored)
```

### Key Components

1. **CLI Layer** (`src/bin/cli.ts`) - User-facing commands
2. **Hooks Layer** (`src/hooks/`) - Claude Code integration points
3. **SDK Layer** (`src/sdk/`) - Background intelligence worker
4. **Storage Layer** (`src/services/sqlite/`) - Data persistence
5. **Services Layer** (`src/services/`) - Path discovery, utilities

---

## Directory Structure

```
src/
├── bin/                    # CLI entry point
│   └── cli.ts             # Commander-based CLI router
├── commands/              # CLI command implementations
│   ├── install.ts         # Hook installation wizard
│   ├── uninstall.ts       # Hook removal
│   ├── doctor.ts          # Health checks
│   ├── status.ts          # System status
│   ├── logs.ts            # Log viewer
│   ├── trash.ts           # Move files to trash
│   ├── trash-view.ts      # View trash contents
│   ├── trash-empty.ts     # Empty trash
│   └── restore.ts         # Restore from trash
├── hooks/                 # Claude Code hook handlers
│   ├── index.ts           # Hook exports
│   ├── context.ts         # SessionStart hook
│   ├── new.ts             # UserPromptSubmit hook
│   ├── save.ts            # PostToolUse hook
│   └── summary.ts         # Stop hook
├── sdk/                   # Agent SDK integration
│   ├── index.ts           # SDK exports
│   ├── worker.ts          # Background worker process
│   ├── prompts.ts         # Prompt builders for SDK
│   └── parser.ts          # XML response parser
├── services/              # Core services
│   ├── path-discovery.ts  # Cross-platform path resolution
│   └── sqlite/            # Database layer
│       ├── index.ts       # Database exports
│       ├── Database.ts    # SQLite manager with migrations
│       ├── HooksDatabase.ts # Lightweight hooks interface
│       ├── migrations.ts  # Schema migrations
│       └── types.ts       # TypeScript interfaces
├── shared/                # Shared configuration
│   ├── config.ts          # Package metadata
│   ├── storage.ts         # Storage provider interface
│   └── types.ts           # Core type definitions
└── utils/                 # Utility functions
    └── platform.ts        # Platform-specific helpers
```

---

## Core Components

### Entry Points & CLI

#### `src/bin/cli.ts`

**Purpose**: Main CLI entry point using Commander.js

**Key Responsibilities**:
- Route CLI commands to handlers
- Define command-line arguments and options
- Handle stdin for hook commands
- Export database utilities for programmatic use

**Key Functions**:
- `readStdin()`: Reads JSON input from stdin for hooks
- Command definitions:
  - `install`: Install hooks wizard
  - `uninstall`: Remove hooks
  - `doctor`: Health check
  - `status`: System status
  - `logs`: View operation logs
  - `trash [files...]`: Move files to trash
  - `trash view`: View trash contents
  - `trash empty`: Empty trash
  - `restore`: Restore from trash
  - `context`: SessionStart hook (internal)
  - `new`: UserPromptSubmit hook (internal)
  - `save`: PostToolUse hook (internal)
  - `summary`: Stop hook (internal)
  - `worker <sessionId>`: SDK worker (internal)

**Exports**:
```typescript
export { DatabaseManager, migrations, initializeDatabase, getDatabase }
```

---

## Commands

### `src/commands/install.ts`

**Purpose**: Interactive installation wizard for claude-mem hooks

**Key Functions**:

- **`install(options)`**: Main installation flow
  - Creates directory structure
  - Installs uv package manager
  - Configures Claude Code hooks
  - Installs Chroma MCP server
  - Adds CLAUDE.md instructions
  - Optionally configures Smart Trash alias

- **`runInstallationWizard(existingInstall)`**: Interactive prompts
  - Scope selection (user/project/local)
  - Hook timeout configuration
  - Smart Trash opt-in
  - Save-on-clear opt-in

- **`ensureDirectoryStructure()`**: Creates all data directories
- **`configureHooks(settingsPath)`**: Writes Claude settings.json
- **`installChromaMcp(forceReinstall)`**: Installs Chroma MCP via `claude mcp add`
- **`ensureClaudeMdInstructions()`**: Adds/updates CLAUDE.md quick reference
- **`configureSmartTrashAlias()`**: Adds `rm` alias to shell configs
- **`installClaudeCommands()`**: Copies slash commands to ~/.claude/commands/

**Installation Scopes**:
- **User**: `~/.claude/settings.json` (recommended)
- **Project**: `./.claude/settings.json` (project-specific)
- **Local**: Custom path

**Hook Configuration**:
```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "claude-mem context", "timeout": 180 }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "claude-mem summary", "timeout": 60 }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "claude-mem new", "timeout": 60 }] }],
    "PostToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "claude-mem save", "timeout": 180 }] }]
  }
}
```

---

### `src/commands/uninstall.ts`

**Purpose**: Remove claude-mem hooks from Claude Code settings

**Key Functions**:
- **`uninstall(options)`**: Removes hooks from settings
  - Supports `--user`, `--project`, `--all` flags
  - Creates backups before modification
  - Removes Smart Trash alias from shell configs
- **`removeSmartTrashAlias()`**: Cleans up shell configuration files

---

### `src/commands/doctor.ts`

**Purpose**: Run health checks on claude-mem installation

**Key Functions**:
- **`doctor(options)`**: System health diagnostics
  - Checks data directory existence and permissions
  - Tests SQLite database connectivity
  - Verifies Chroma vector store initialization
  - Outputs results as JSON with `--json` flag

**Check Results**:
- ✅ `pass`: System component healthy
- ⚠️ `warn`: Non-critical issue
- ❌ `fail`: Critical problem

---

### `src/commands/status.ts`

**Purpose**: Display comprehensive system status

**Key Functions**:
- **`status()`**: Shows complete system state
  - Hook configuration (global and project)
  - Compressed transcript counts
  - Archive counts
  - Runtime environment (Node.js, Bun)
  - Chroma storage status
  - Installation summary

---

### `src/commands/logs.ts`

**Purpose**: View claude-mem operation logs

**Key Functions**:
- **`logs(options)`**: Display log files
  - Shows last N lines (default: 20)
  - Finds most recent log file
  - Supports `--tail` option
- **`showLog(logPath, logType, tail)`**: Formats and displays log content

**Log Location**: `~/.claude-mem/logs/claude-mem-{timestamp}.log`

---

### `src/commands/trash.ts`

**Purpose**: Smart trash implementation - safer file deletion

**Key Functions**:
- **`trash(filePaths, options)`**: Move files to trash
  - Supports glob patterns
  - `-r, --recursive`: Remove directories
  - `-f, --force`: Suppress errors
  - Adds timestamp to avoid conflicts

**Trash Location**: `~/.claude-mem/trash/`

---

### `src/commands/trash-view.ts`

**Purpose**: Display trash contents with metadata

**Key Functions**:
- **`viewTrash()`**: Shows trash items
  - Original filename
  - Size (files and directories)
  - Timestamp
  - Restore instructions
- **`formatSize(bytes)`**: Human-readable file sizes
- **`getDirectorySize(dirPath)`**: Recursive size calculation

---

### `src/commands/trash-empty.ts`

**Purpose**: Permanently delete all trash contents

**Key Functions**:
- **`emptyTrash(options)`**: Clear trash
  - Confirmation prompt (unless `--force`)
  - Shows counts before deletion
  - Recursive removal of all items

---

### `src/commands/restore.ts`

**Purpose**: Interactive file restoration from trash

**Key Functions**:
- **`restore()`**: Restore files
  - Interactive file selection
  - Restores to current directory
  - Preserves original filename

---

## Hooks System

The hooks system integrates claude-mem with Claude Code's lifecycle events.

### `src/hooks/index.ts`

**Purpose**: Export all hook handlers

**Exports**:
```typescript
export { contextHook } from './context.js';
export { saveHook } from './save.js';
export { newHook } from './new.js';
export { summaryHook } from './summary.js';
```

---

### `src/hooks/context.ts`

**Purpose**: SessionStart hook - provides recent session context

**Trigger**: When Claude Code starts a new session (source='startup')

**Key Functions**:
- **`contextHook(input)`**: Load and display recent memories
  - Extracts project name from `cwd`
  - Queries last 5 session summaries
  - Formats as markdown for Claude to read
  - Only runs on startup (not resume)

**Input**:
```typescript
interface SessionStartInput {
  session_id: string;
  cwd: string;
  source?: string;  // 'startup' | 'resume'
}
```

**Output** (to stdout):
```markdown
# Recent Session Context

Here's what happened in recent {project} sessions:

---

**Request:** {what user asked}
**Completed:** {what was done}
**Learned:** {key insights}
**Next Steps:** {future work}
**Files Edited:** file1.ts, file2.ts
**Date:** 2025-10-15
```

---

### `src/hooks/new.ts`

**Purpose**: UserPromptSubmit hook - initializes SDK session

**Trigger**: When user submits their first prompt in a session

**Key Functions**:
- **`newHook(input)`**: Start SDK worker
  - Creates SDK session record in SQLite
  - Spawns detached worker process via `claude-mem worker {sessionId}`
  - Returns immediately (non-blocking)

**Input**:
```typescript
interface UserPromptSubmitInput {
  session_id: string;
  cwd: string;
  prompt: string;
}
```

**Workflow**:
1. Check if SDK session already exists (prevent duplicates)
2. Create `sdk_sessions` table record with status='active'
3. Spawn worker: `spawn('claude-mem', ['worker', sessionId], { detached: true, stdio: 'ignore' })`
4. Output: `{"continue": true, "suppressOutput": true}`

**Worker Lifecycle**: The spawned worker runs in the background until Stop hook

---

### `src/hooks/save.ts`

**Purpose**: PostToolUse hook - queues tool observations

**Trigger**: After every tool execution in Claude Code

**Key Functions**:
- **`saveHook(input)`**: Send observation to worker
  - Skips low-value tools (TodoWrite, ListMcpResourcesTool)
  - Finds active SDK session
  - Sends observation via Unix socket to worker

**Input**:
```typescript
interface PostToolUseInput {
  session_id: string;
  cwd: string;
  tool_name: string;
  tool_input: any;
  tool_output: any;
}
```

**Skipped Tools**:
- `TodoWrite`: Too noisy
- `ListMcpResourcesTool`: Not meaningful

**Communication**: Unix socket at `~/.claude-mem/worker-{sessionId}.sock`

**Message Format**:
```json
{
  "type": "observation",
  "tool_name": "Read",
  "tool_input": "{\"file_path\": \"/path/to/file.ts\"}",
  "tool_output": "{\"content\": \"...\"}"
}
```

---

### `src/hooks/summary.ts`

**Purpose**: Stop hook - finalizes SDK session

**Trigger**: When Claude Code session ends (user closes or `/clear`)

**Key Functions**:
- **`summaryHook(input)`**: Signal worker to finalize
  - Finds active SDK session
  - Sends FINALIZE message via Unix socket
  - Worker generates summary and stores to database

**Input**:
```typescript
interface StopInput {
  session_id: string;
  cwd: string;
}
```

**Message Format**:
```json
{
  "type": "finalize"
}
```

**Worker Action**: Generates structured summary and stores to `session_summaries` table

---

## SDK & Worker

The SDK worker is a background daemon that analyzes tool observations using Claude Agent SDK.

### `src/sdk/worker.ts`

**Purpose**: Background process that synthesizes observations into insights

**Key Class**: `SDKWorker`

**Lifecycle**:
```
1. new hook spawns worker
   ↓
2. Worker starts Unix socket server
   ↓
3. Worker initializes SDK streaming session
   ↓
4. save hooks send observations via socket
   ↓
5. Worker feeds observations to SDK agent
   ↓
6. SDK agent extracts insights (observations)
   ↓
7. summary hook sends finalize message
   ↓
8. SDK agent generates summary
   ↓
9. Worker stores summary and exits
```

**Key Methods**:

- **`main()`**: Entry point
  - Parses sessionDbId from argv
  - Creates SDKWorker instance
  - Calls `run()`

- **`run()`**: Main worker loop
  - Loads session from database
  - Starts Unix socket server
  - Runs SDK agent with streaming input
  - Marks session as completed/failed
  - Cleans up socket

- **`startSocketServer()`**: Creates Unix socket
  - Socket path: `~/.claude-mem/worker-{sessionId}.sock`
  - Receives observation and finalize messages
  - Adds messages to `pendingMessages` queue

- **`handleMessage(message)`**: Process incoming messages
  - Queues observations for SDK processing
  - Sets `isFinalized` flag on finalize message

- **`runSDKAgent()`**: Initialize SDK streaming session
  - Model: `claude-sonnet-4-5`
  - Disallowed tools: `Glob, Grep, ListMcpResourcesTool, WebSearch`
  - Streaming input via async generator
  - Captures SDK session ID from init message

- **`createMessageGenerator()`**: Async generator for SDK
  - Yields initial prompt
  - Polls `pendingMessages` queue
  - Yields observation prompts
  - Yields finalize prompt when session ends

- **`handleAgentMessage(content)`**: Parse SDK responses
  - Extracts `<observation>` blocks → stores to `observations` table
  - Extracts `<summary>` block → stores to `session_summaries` table

- **`cleanup()`**: Shutdown
  - Closes socket server
  - Deletes socket file

**Socket Message Types**:
- `observation`: Tool execution to analyze
- `finalize`: Generate summary and exit

**SDK Session Configuration**:
```typescript
await query({
  model: 'claude-sonnet-4-5',
  messages: () => this.createMessageGenerator(),
  disallowedTools: ['Glob', 'Grep', 'ListMcpResourcesTool', 'WebSearch'],
  signal: this.abortController.signal,
  onSystemInitMessage: (msg) => {
    // Capture SDK session ID
  },
  onAgentMessage: (msg) => {
    // Parse observations and summaries
  }
});
```

---

### `src/sdk/prompts.ts`

**Purpose**: Build prompts for SDK agent

**Key Functions**:

- **`buildInitPrompt(project, sessionId, userPrompt)`**: Initialize SDK agent
  - Explains the agent's role
  - Defines what to capture (decisions, bugfixes, features, refactorings, discoveries)
  - Defines what NOT to capture (routine operations, WIP, obvious facts)
  - Provides XML format for observations

- **`buildObservationPrompt(obs)`**: Send tool observation
  - Shows tool name, time, input, output
  - Asks: "Is this worth remembering?"
  - If yes, output `<observation><type>...</type><text>...</text></observation>`

- **`buildFinalizePrompt(session)`**: Generate session summary
  - Reviews all observations
  - Generates structured summary with 8 required fields

**Observation Types**:
- `decision`: Architecture or design decisions
- `bugfix`: Bug fixes
- `feature`: New functionality
- `refactor`: Code restructuring
- `discovery`: New findings

**XML Formats**:

**Observation**:
```xml
<observation>
  <type>feature</type>
  <text>Implemented JWT token refresh flow with 7-day expiry</text>
</observation>
```

**Summary**:
```xml
<summary>
  <request>User's request</request>
  <investigated>What we explored</investigated>
  <learned>Key insights</learned>
  <completed>What was done</completed>
  <next_steps>Future work</next_steps>
  <files_read>
    <file>src/auth.ts</file>
  </files_read>
  <files_edited>
    <file>src/auth.ts</file>
  </files_edited>
  <notes>Additional notes</notes>
</summary>
```

**Types**:
```typescript
export interface Observation {
  id: number;
  tool_name: string;
  tool_input: string;
  tool_output: string;
  created_at_epoch: number;
}

export interface SDKSession {
  id: number;
  sdk_session_id: string | null;
  project: string;
  user_prompt: string;
}
```

---

### `src/sdk/parser.ts`

**Purpose**: Parse XML observation and summary blocks from SDK responses

**Key Functions**:

- **`parseObservations(text)`**: Extract observation blocks
  - Regex: `/<observation>\s*<type>([^<]+)<\/type>\s*<text>([^<]+)<\/text>\s*<\/observation>/g`
  - Validates observation type (decision/bugfix/feature/refactor/discovery)
  - Returns array of observations

- **`parseSummary(text)`**: Extract summary block
  - Regex: `/<summary>([\s\S]*?)<\/summary>/`
  - Extracts 8 required fields
  - Extracts file arrays
  - Returns null if missing required fields

- **`extractField(content, fieldName)`**: Extract simple text field
- **`extractFileArray(content, arrayName)`**: Extract file list

**Types**:
```typescript
export interface ParsedObservation {
  type: string;
  text: string;
}

export interface ParsedSummary {
  request: string;
  investigated: string;
  learned: string;
  completed: string;
  next_steps: string;
  files_read: string[];
  files_edited: string[];
  notes: string;
}
```

---

### `src/sdk/index.ts`

**Purpose**: Export SDK module components

**Exports**:
```typescript
export { buildInitPrompt, buildObservationPrompt, buildFinalizePrompt } from './prompts.js';
export { parseObservations, parseSummary } from './parser.js';
export type { Observation, SDKSession } from './prompts.js';
export type { ParsedObservation, ParsedSummary } from './parser.js';
```

---

## Services

### `src/services/path-discovery.ts`

**Purpose**: Central path resolution service for cross-platform compatibility

**Key Class**: `PathDiscovery` (Singleton)

**Key Responsibilities**:
- Discover paths across different installation scenarios (global npm, local, development)
- Handle cross-platform differences (Windows, macOS, Linux)
- Support environment variable overrides
- Find package resources (hooks, commands)

**Key Methods**:

**Data Directories**:
- `getDataDirectory()`: `~/.claude-mem` (or CLAUDE_MEM_DATA_DIR)
- `getArchivesDirectory()`: `~/.claude-mem/archives`
- `getLogsDirectory()`: `~/.claude-mem/logs`
- `getIndexDirectory()`: `~/.claude-mem`
- `getIndexPath()`: `~/.claude-mem/claude-mem-index.jsonl`
- `getTrashDirectory()`: `~/.claude-mem/trash`
- `getBackupsDirectory()`: `~/.claude-mem/backups`
- `getChromaDirectory()`: `~/.claude-mem/chroma`
- `getProjectArchiveDirectory(projectName)`: `~/.claude-mem/archives/{project}`
- `getUserSettingsPath()`: `~/.claude-mem/settings.json`

**Claude Integration Paths**:
- `getClaudeConfigDirectory()`: `~/.claude` (or CLAUDE_CONFIG_DIR)
- `getClaudeSettingsPath()`: `~/.claude/settings.json`
- `getClaudeCommandsDirectory()`: `~/.claude/commands`
- `getClaudeMdPath()`: `~/.claude/CLAUDE.md`
- `getMcpConfigPath()`: `~/.claude.json`
- `getProjectMcpConfigPath()`: `./.mcp.json`

**Package Discovery**:
- `getPackageRoot()`: Find claude-mem package root (3 fallback methods)
- `findPackageCommandsDirectory()`: Find commands directory in package

**Utility Methods**:
- `ensureDirectory(dirPath)`: Create directory if missing
- `ensureDirectories(dirPaths)`: Create multiple directories
- `ensureAllDataDirectories()`: Create all claude-mem data dirs
- `ensureAllClaudeDirectories()`: Create all Claude integration dirs

**Static Helpers**:
- `PathDiscovery.extractProjectName(filePath)`: Extract project from path
- `PathDiscovery.getCurrentProjectName()`: Get current project (git root or cwd)
- `PathDiscovery.createBackupFilename(originalPath)`: Generate timestamped backup
- `PathDiscovery.isPathAccessible(path)`: Check path existence and access

**Environment Overrides**:
- `CLAUDE_MEM_DATA_DIR`: Override data directory
- `CLAUDE_CONFIG_DIR`: Override Claude config directory

---

### `src/services/sqlite/Database.ts`

**Purpose**: SQLite database manager with migration support

**Key Class**: `DatabaseManager` (Singleton)

**Key Responsibilities**:
- Initialize SQLite database with optimized settings
- Run schema migrations in order
- Provide transaction support
- Manage connection lifecycle

**Key Methods**:

- **`initialize()`**: Setup database
  - Creates data directory
  - Opens database: `~/.claude-mem/claude-mem.db`
  - Applies optimized pragmas
  - Initializes schema_versions table
  - Runs pending migrations

- **`getConnection()`**: Get active database connection

- **`withTransaction(fn)`**: Execute function in transaction

- **`close()`**: Close database connection

- **`registerMigration(migration)`**: Add migration to queue

- **`runMigrations()`**: Apply pending migrations

- **`getCurrentVersion()`**: Get current schema version

**Optimized SQLite Settings**:
```sql
PRAGMA journal_mode = WAL;        -- Write-Ahead Logging for concurrency
PRAGMA synchronous = NORMAL;      -- Balance safety and performance
PRAGMA foreign_keys = ON;         -- Enforce relationships
PRAGMA temp_store = memory;       -- Use RAM for temp tables
PRAGMA mmap_size = 268435456;     -- 256MB memory-mapped I/O
PRAGMA cache_size = 10000;        -- Large cache for performance
```

**Migration Interface**:
```typescript
interface Migration {
  version: number;
  up: (db: Database) => void;
  down?: (db: Database) => void;
}
```

**Exports**:
```typescript
export { DatabaseManager }
export function getDatabase(): Database
export function initializeDatabase(): Promise<Database>
```

---

### `src/services/sqlite/HooksDatabase.ts`

**Purpose**: Lightweight synchronous database interface for hooks

**Key Class**: `HooksDatabase`

**Why Separate?**: Hooks need fast, synchronous operations without complex logic

**Key Methods**:

**Session Summaries**:
- **`getRecentSummaries(project, limit)`**: Get last N summaries for project
  - Returns: request, investigated, learned, completed, next_steps, files_read, files_edited, notes, created_at

**SDK Sessions**:
- **`findActiveSDKSession(claudeSessionId)`**: Find active session for Claude session
- **`createSDKSession(claudeSessionId, project, userPrompt)`**: Create new SDK session
- **`updateSDKSessionId(id, sdkSessionId)`**: Update with SDK session ID
- **`markSessionCompleted(id)`**: Mark session as completed
- **`markSessionFailed(id)`**: Mark session as failed

**Observations** (extracted by SDK):
- **`storeObservation(sdkSessionId, project, type, text)`**: Store insight

**Session Summaries**:
- **`storeSummary(sdkSessionId, project, summary)`**: Store structured summary

**Lifecycle**:
- **`close()`**: Close database connection

---

### `src/services/sqlite/migrations.ts`

**Purpose**: Database schema migrations

**Migrations**:

**Migration 001** - Initial schema:
- `sessions`: Core session tracking
- `memories`: Compressed memory chunks
- `overviews`: Session summaries (legacy)
- `diagnostics`: System health logs
- `transcript_events`: Raw conversation events

**Migration 002** - Hierarchical memory fields:
- Adds: `title`, `subtitle`, `facts`, `concepts`, `files_touched` to memories table

**Migration 003** - Streaming sessions:
- `streaming_sessions`: Real-time session tracking (DEPRECATED - dropped in migration005)

**Migration 004** - SDK agent architecture:
- `sdk_sessions`: Track SDK streaming sessions
- `observation_queue`: Pending observations (DEPRECATED - dropped in migration005, superseded by Unix sockets)
- `observations`: Extracted insights
- `session_summaries`: Structured session summaries

**Migration 005** - Remove orphaned tables:
- Drops `streaming_sessions` (superseded by `sdk_sessions`)
- Drops `observation_queue` (superseded by Unix socket communication in worker.ts)

**Table Schemas**:

**`sdk_sessions`**:
```sql
CREATE TABLE sdk_sessions (
  id INTEGER PRIMARY KEY,
  claude_session_id TEXT UNIQUE NOT NULL,
  sdk_session_id TEXT UNIQUE,
  project TEXT NOT NULL,
  user_prompt TEXT,
  started_at TEXT NOT NULL,
  started_at_epoch INTEGER NOT NULL,
  completed_at TEXT,
  completed_at_epoch INTEGER,
  status TEXT CHECK(status IN ('active', 'completed', 'failed'))
);
```

**`observations`**:
```sql
CREATE TABLE observations (
  id INTEGER PRIMARY KEY,
  sdk_session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  text TEXT NOT NULL,
  type TEXT CHECK(type IN ('decision', 'bugfix', 'feature', 'refactor', 'discovery')),
  created_at TEXT NOT NULL,
  created_at_epoch INTEGER NOT NULL
);
```

**`session_summaries`**:
```sql
CREATE TABLE session_summaries (
  id INTEGER PRIMARY KEY,
  sdk_session_id TEXT UNIQUE NOT NULL,
  project TEXT NOT NULL,
  request TEXT,
  investigated TEXT,
  learned TEXT,
  completed TEXT,
  next_steps TEXT,
  files_read TEXT,      -- JSON array
  files_edited TEXT,    -- JSON array
  notes TEXT,
  created_at TEXT NOT NULL,
  created_at_epoch INTEGER NOT NULL
);
```

**Export**:
```typescript
export const migrations: Migration[] = [
  migration001,
  migration002,
  migration003,
  migration004,
  migration005
];
```

---

### `src/services/sqlite/types.ts`

**Purpose**: TypeScript interfaces for database operations

**Key Types**:

**Input Types** (for creating records):
```typescript
export interface SessionInput {
  session_id: string;
  project: string;
  created_at: string;
  created_at_epoch: number;
  source?: string;
  archive_path?: string;
  metadata_json?: string;
}

export interface MemoryInput {
  session_id: string;
  text: string;
  document_id?: string;
  keywords?: string;
  project: string;
  created_at?: string;
  created_at_epoch?: number;
}

export interface OverviewInput {
  session_id: string;
  content: string;
  project: string;
  created_at?: string;
  created_at_epoch?: number;
}

export interface DiagnosticInput {
  session_id?: string;
  message: string;
  severity?: 'info' | 'warn' | 'error';
  project: string;
  created_at?: string;
  created_at_epoch?: number;
}
```

**Row Types** (returned from queries):
```typescript
export interface SessionRow {
  id: number;
  session_id: string;
  project: string;
  created_at: string;
  created_at_epoch: number;
  source: string;
  archive_path: string | null;
  metadata_json: string | null;
}

export interface MemoryRow {
  id: number;
  session_id: string;
  text: string;
  document_id: string | null;
  keywords: string | null;
  created_at: string;
  created_at_epoch: number;
  project: string;
}

export interface OverviewRow {
  id: number;
  session_id: string;
  content: string;
  created_at: string;
  created_at_epoch: number;
  project: string;
}

export interface DiagnosticRow {
  id: number;
  session_id: string | null;
  message: string;
  severity: string;
  created_at: string;
  created_at_epoch: number;
  project: string;
}
```

**Utilities**:
```typescript
export function normalizeTimestamp(timestamp: string | Date | number): {
  iso: string;
  epoch: number;
}
```

---

### `src/services/sqlite/index.ts`

**Purpose**: Export all SQLite components

**Exports**:
```typescript
// Database manager
export { DatabaseManager, getDatabase, initializeDatabase } from './Database.js';

// Hooks database
export { HooksDatabase } from './HooksDatabase.js';

// Types
export * from './types.js';

// Migrations
export { migrations } from './migrations.js';
```

---

## Shared Components

### `src/shared/config.ts`

**Purpose**: Package metadata configuration

**Exports**:
```typescript
export const PACKAGE_NAME: string;        // 'claude-mem'
export const PACKAGE_VERSION: string;     // From package.json or __DEFAULT_PACKAGE_VERSION__
export const PACKAGE_DESCRIPTION: string; // Project description
export const CLI_NAME: string;            // Alias for PACKAGE_NAME
```

**Build Process**: Version is replaced by build script using `--define` flag

---

### `src/shared/types.ts`

**Purpose**: Core type definitions

**Key Types**:

```typescript
export interface Settings {
  autoCompress?: boolean;
  projectName?: string;
  installed?: boolean;
  backend?: string;                     // 'chroma'
  embedded?: boolean;
  saveMemoriesOnClear?: boolean;
  claudePath?: string;
  rollingCaptureEnabled?: boolean;
  rollingSummaryEnabled?: boolean;
  rollingSessionStartEnabled?: boolean;
  rollingChunkTokens?: number;
  rollingChunkOverlapTokens?: number;
  rollingSummaryTurnLimit?: number;
  [key: string]: unknown;
}
```

---

### `src/shared/storage.ts`

**Purpose**: Storage provider abstraction (currently SQLite-only)

**Key Interfaces**:

```typescript
export type StorageBackend = 'sqlite' | 'jsonl';

export interface IStorageProvider {
  backend: StorageBackend;

  // Session operations
  createSession(session: SessionInput): Promise<SessionRow | void>;
  getSession(sessionId: string): Promise<SessionRow | null>;
  hasSession(sessionId: string): Promise<boolean>;
  getAllSessionIds(): Promise<Set<string>>;
  getRecentSessions(limit?: number): Promise<SessionRow[]>;
  getRecentSessionsForProject(project: string, limit?: number): Promise<SessionRow[]>;

  // Memory operations
  createMemory(memory: MemoryInput): Promise<MemoryRow | void>;
  createMemories(memories: MemoryInput[]): Promise<void>;
  getRecentMemories(limit?: number): Promise<MemoryRow[]>;
  getRecentMemoriesForProject(project: string, limit?: number): Promise<MemoryRow[]>;
  hasDocumentId(documentId: string): Promise<boolean>;

  // Overview operations
  createOverview(overview: OverviewInput): Promise<OverviewRow | void>;
  upsertOverview(overview: OverviewInput): Promise<OverviewRow | void>;
  getRecentOverviews(limit?: number): Promise<OverviewRow[]>;
  getRecentOverviewsForProject(project: string, limit?: number): Promise<OverviewRow[]>;

  // Diagnostic operations
  createDiagnostic(diagnostic: DiagnosticInput): Promise<DiagnosticRow | void>;

  // Health check
  isAvailable(): Promise<boolean>;
}
```

**Implementation**:
```typescript
export class SQLiteStorageProvider implements IStorageProvider {
  // ... implementation
}

export async function getStorageProvider(): Promise<IStorageProvider>
```

---

## Utilities

### `src/utils/platform.ts`

**Purpose**: Platform-specific utilities for cross-platform compatibility

**Key Functions**:

- **`Platform.findExecutable(name)`**: Find path to executable
  - Windows: `where {name}`
  - Unix: `which {name}`

- **`Platform.installUv()`**: Install uv package manager
  - Windows: PowerShell script
  - Unix: curl + sh script

- **`Platform.getShellConfigPaths()`**: Get shell config files
  - Windows: PowerShell profiles
  - Unix: `.bashrc`, `.zshrc`, `.bash_profile`

- **`Platform.getAliasDefinition(aliasName, command)`**: Get alias syntax
  - Windows: `function aliasName { command $args }`
  - Unix: `alias aliasName='command'`

**Platform Detection**:
```typescript
const isWindows = platform() === 'win32';
```

**Shell Configs**:
- **Windows**:
  - `~/Documents/PowerShell/Microsoft.PowerShell_profile.ps1`
  - `~/Documents/WindowsPowerShell/Microsoft.PowerShell_profile.ps1`
- **Unix**:
  - `~/.bashrc`
  - `~/.zshrc`
  - `~/.bash_profile`

---

## Key Workflows

### 1. Installation Flow

```
User runs: claude-mem install
         ↓
1. Interactive wizard
   - Select scope (user/project/local)
   - Configure timeouts
   - Enable Smart Trash?
   - Enable save-on-clear?
         ↓
2. Install uv package manager
         ↓
3. Create directory structure
   ~/.claude-mem/
   ├── archives/
   ├── logs/
   ├── trash/
   ├── backups/
   └── chroma/
         ↓
4. Install Chroma MCP server
   claude mcp add claude-mem -- uvx chroma-mcp ...
         ↓
5. Configure Claude hooks
   ~/.claude/settings.json
         ↓
6. Add CLAUDE.md instructions
   ~/.claude/CLAUDE.md
         ↓
7. Install slash commands
   ~/.claude/commands/
   ├── save.md
   ├── remember.md
   └── claude-mem.md
         ↓
8. Configure Smart Trash alias (optional)
   Add to shell config:
   alias rm="claude-mem trash"
         ↓
9. Show success message
```

---

### 2. Session Memory Capture Flow

```
User starts Claude Code
         ↓
SessionStart hook fires
         ↓
context hook runs
         ↓
Query recent summaries for project
         ↓
Output markdown to Claude
         ↓
User sees context:
"# Recent Session Context

 Here's what happened in recent sessions:

 **Request:** Add authentication
 **Completed:** Implemented JWT flow
 **Learned:** Token rotation prevents security issues
 **Next Steps:** Add refresh token API
 **Files Edited:** src/auth.ts, src/middleware.ts"
         ↓
User types first prompt
         ↓
UserPromptSubmit hook fires
         ↓
new hook runs
         ↓
Create sdk_sessions record (status='active')
         ↓
Spawn detached worker: claude-mem worker {sessionId}
         ↓
Worker starts Unix socket server
         ↓
Worker initializes SDK streaming session
         ↓
User works (reads files, edits code, etc.)
         ↓
PostToolUse hook fires after each tool
         ↓
save hook runs
         ↓
Send observation to worker via socket:
{
  "type": "observation",
  "tool_name": "Edit",
  "tool_input": "{...}",
  "tool_output": "{...}"
}
         ↓
Worker receives observation
         ↓
Worker feeds to SDK agent
         ↓
SDK analyzes: "Is this worth remembering?"
         ↓
If yes: SDK outputs:
<observation>
  <type>feature</type>
  <text>Implemented JWT refresh flow with 7-day expiry</text>
</observation>
         ↓
Worker parses XML and stores to observations table
         ↓
User finishes work and closes session
         ↓
Stop hook fires
         ↓
summary hook runs
         ↓
Send finalize message to worker:
{ "type": "finalize" }
         ↓
Worker receives finalize
         ↓
Worker sends finalize prompt to SDK
         ↓
SDK reviews all observations
         ↓
SDK generates summary:
<summary>
  <request>Add JWT authentication</request>
  <investigated>Session management, token storage</investigated>
  <learned>Rotation prevents token reuse attacks</learned>
  <completed>Implemented JWT + refresh flow with 7-day expiry</completed>
  <next_steps>Add token revocation endpoint</next_steps>
  <files_read>
    <file>src/auth.ts</file>
  </files_read>
  <files_edited>
    <file>src/auth.ts</file>
    <file>src/middleware/auth.ts</file>
  </files_edited>
  <notes>Token secret in .env, rotation strategy used</notes>
</summary>
         ↓
Worker parses summary XML
         ↓
Worker stores to session_summaries table
         ↓
Worker marks session as completed
         ↓
Worker closes socket and exits
         ↓
Next session: context hook loads this summary!
```

---

### 3. Smart Trash Flow

```
User runs: rm file.txt
         ↓
(Smart Trash enabled)
         ↓
Alias redirects: claude-mem trash file.txt
         ↓
trash command runs
         ↓
1. Check if file exists
2. Add timestamp: file.txt.1729123456789
3. Move to ~/.claude-mem/trash/
         ↓
User wants to see trash
         ↓
User runs: claude-mem trash view
         ↓
Display:
🗑️  Trash Contents
────────────────────────────────────────
📄 file.txt
   Size: 1.2 KB | Trashed: 2025-10-16 10:30:45
   ID: file.txt.1729123456789
────────────────────────────────────────
Total: 0 folders, 1 files (1.2 KB)
         ↓
User wants to restore
         ↓
User runs: claude-mem restore
         ↓
Interactive selection
         ↓
Restore file.txt.1729123456789 → ./file.txt
         ↓
User wants to empty trash
         ↓
User runs: claude-mem trash empty
         ↓
Confirmation prompt
         ↓
Permanently delete all files
```

---

### 4. Doctor/Status Flow

```
User runs: claude-mem doctor
         ↓
Check data directory: ~/.claude-mem
✅ Data directory accessible
         ↓
Check SQLite database
✅ SQLite database connected
         ↓
Check Chroma vector store
✅ Chroma vector store data dir exists
         ↓
User runs: claude-mem status
         ↓
Show:
⚙️  Settings Configuration:
  📋 Global: ~/.claude/settings.json
     SessionStart (claude-mem context): ✅
     Stop (claude-mem summary): ✅
     UserPromptSubmit (claude-mem new): ✅
     PostToolUse (claude-mem save): ✅

📦 Compressed Transcripts:
  Compressed files: 5
  Archive files: 2

🔧 Runtime Environment:
  ✅ Node.js: v20.11.0
  ✅ Bun: 1.0.26

🧠 Chroma Storage Status:
  ✅ Storage backend: Chroma MCP
  📍 Data location: ~/.claude-mem/chroma

📊 Summary:
  ✅ Claude Memory System is installed (Global)
```

---

## Summary

**claude-mem** is a sophisticated memory system that:

1. **Captures context automatically** via Claude Code hooks
2. **Analyzes observations intelligently** using Claude Agent SDK
3. **Extracts meaningful insights** (not just raw data)
4. **Stores structured summaries** in SQLite
5. **Provides vector search** via Chroma MCP
6. **Restores context seamlessly** in new sessions

**Key Innovation**: Instead of saving raw transcripts, claude-mem uses an AI agent to synthesize observations into actionable insights, creating a compressed, searchable knowledge base that grows with your work.

**Core Philosophy**: Quality over quantity - only meaningful insights are stored.

---

## File Reference Index

### Entry Points
- `src/bin/cli.ts:20-213` - CLI router with Commander

### Commands
- `src/commands/install.ts:429-538` - Installation wizard
- `src/commands/uninstall.ts:67-162` - Uninstall hooks
- `src/commands/doctor.ts:22-93` - Health checks
- `src/commands/status.ts:11-158` - System status
- `src/commands/logs.ts:40-73` - Log viewer
- `src/commands/trash.ts:11-60` - Move to trash
- `src/commands/trash-view.ts:53-124` - View trash
- `src/commands/trash-empty.ts:6-66` - Empty trash
- `src/commands/restore.ts:6-24` - Restore files

### Hooks
- `src/hooks/context.ts:16-92` - SessionStart hook
- `src/hooks/new.ts:16-56` - UserPromptSubmit hook
- `src/hooks/save.ts:25-81` - PostToolUse hook
- `src/hooks/summary.ts:16-62` - Stop hook

### SDK
- `src/sdk/worker.ts:36-311` - Background worker process
- `src/sdk/prompts.ts:24-177` - Prompt builders
- `src/sdk/parser.ts:26-132` - XML parser

### Services
- `src/services/path-discovery.ts:16-341` - Path resolution
- `src/services/sqlite/Database.ts:20-177` - Database manager
- `src/services/sqlite/HooksDatabase.ts:11-207` - Hooks database
- `src/services/sqlite/migrations.ts:7-374` - Schema migrations

### Shared
- `src/shared/config.ts:1-51` - Package metadata
- `src/shared/types.ts:15-30` - Core types
- `src/shared/storage.ts:26-188` - Storage abstraction

### Utilities
- `src/utils/platform.ts:11-78` - Platform helpers

---

**Generated**: 2025-10-16
**Claude-Mem Version**: 3.9.16
