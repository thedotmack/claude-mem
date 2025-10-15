# Claude-Mem v4.0 Architecture Specification

## Vision

A clean, hook-driven memory system where Claude Code hooks call CLI commands directly. All business logic lives in TypeScript, no separate hook files needed.

---

## System Overview

```
┌─────────────────┐
│  Claude Code    │
│     Hooks       │
└────────┬────────┘
         │ JSON via stdin
         ▼
┌─────────────────┐
│  CLI Commands   │
│  (TypeScript)   │
└────────┬────────┘
         │
         ├──► SQLite Database
         │    • streaming_sessions table
         │    • session_locks table
         │
         └──► Claude SDK
              • Streaming memory agent
              • Real-time processing
```

**Core Principles:**
- ✅ CLI commands are the only interface
- ✅ All state stored in SQLite
- ✅ SDK agent processes in-memory, writes to SQLite
- ✅ No command-to-command calls (no CLI calling CLI)
- ✅ No hook files to distribute

---

## Database Schema

### Table: `streaming_sessions`

Tracks all memory sessions with their metadata and final summaries.

```sql
CREATE TABLE streaming_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  claude_session_id TEXT UNIQUE NOT NULL,      -- From Claude Code
  sdk_session_id TEXT,                          -- From SDK init
  project TEXT NOT NULL,                        -- Project name
  title TEXT,                                   -- Generated title
  subtitle TEXT,                                -- Generated subtitle
  user_prompt TEXT,                             -- Initial prompt
  started_at TEXT NOT NULL,                     -- ISO timestamp
  started_at_epoch INTEGER NOT NULL,            -- Unix ms
  updated_at TEXT,                              -- Last update
  updated_at_epoch INTEGER,
  completed_at TEXT,                            -- Session end
  completed_at_epoch INTEGER,
  status TEXT NOT NULL CHECK(status IN ('active', 'completed', 'failed'))
);

CREATE INDEX idx_sessions_claude_id ON streaming_sessions(claude_session_id);
CREATE INDEX idx_sessions_sdk_id ON streaming_sessions(sdk_session_id);
CREATE INDEX idx_sessions_project_status ON streaming_sessions(project, status);
```

### Table: `session_locks`

Prevents concurrent SDK session access.

```sql
CREATE TABLE session_locks (
  sdk_session_id TEXT PRIMARY KEY,
  locked_by TEXT NOT NULL,                      -- Command name: 'save' or 'summary'
  locked_at TEXT NOT NULL,                      -- ISO timestamp
  locked_at_epoch INTEGER NOT NULL              -- Unix ms
);
```

**Lock lifecycle:**
- Acquired before resuming SDK session
- Released after SDK stream completes
- Auto-cleaned if older than 5 minutes (stale lock)

---

## The Four Commands

All commands accept JSON from stdin and output hook-appropriate responses to stdout.

### 1. `claude-mem context`

**Purpose:** Load recent session history for context injection

**Hook:** SessionStart (matcher: "startup")

**Input:**
```json
{
  "hook_event_name": "SessionStart",
  "session_id": "abc123",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/path/to/project",
  "source": "startup"
}
```

**Flow:**
1. Check `source` field → only process if "startup" or "clear"
2. Extract project name from `cwd` (e.g., `/Users/alex/myapp` → `myapp`)
3. Open SQLite database at `~/.claude-mem/claude-mem.db`
4. Query recent completed sessions:
   ```sql
   SELECT title, subtitle, user_prompt, started_at
   FROM streaming_sessions
   WHERE project = ? AND status = 'completed'
   ORDER BY started_at_epoch DESC
   LIMIT 10
   ```
5. Format as human-readable text
6. Output to stdout (plain text, NOT JSON)

**Output:**
```
===============================================================================
What's new | Wednesday, October 15, 2025 at 03:18 PM EDT
===============================================================================
Recent sessions for myapp:

• 2025-10-15 14:30: User Authentication Implementation
  Added JWT tokens and refresh logic

• 2025-10-14 10:15: Database Schema Refactor
  Migrated to normalized structure

• 2025-10-13 16:45: API Documentation
  Created OpenAPI specs for all endpoints

===============================================================================
```

**Exit code:** 0

**Special behavior:** Claude Code injects stdout into conversation context automatically for SessionStart hooks.

---

### 2. `claude-mem new`

**Purpose:** Start new streaming memory session

**Hook:** UserPromptSubmit

**Input:**
```json
{
  "hook_event_name": "UserPromptSubmit",
  "session_id": "abc123",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/path/to/project",
  "prompt": "User's question or task",
  "timestamp": "2025-10-15T19:30:00Z"
}
```

**Flow:**

1. **Cleanup orphaned sessions**
   ```sql
   UPDATE streaming_sessions
   SET status = 'failed'
   WHERE project = ? AND status = 'active'
   ```

2. **Create session record**
   ```sql
   INSERT INTO streaming_sessions (
     claude_session_id, project, user_prompt,
     started_at, started_at_epoch, status
   ) VALUES (?, ?, ?, ?, ?, 'active')
   ```

3. **Build SDK system prompt**
   ```typescript
   const systemPrompt = `
   You are a memory assistant for project "${project}".
   Session: ${session_id}
   Date: ${date}

   The user said: "${user_prompt}"

   Your job: Analyze the work being done and remember important details.
   You will receive tool outputs. Extract what matters:
   - Key decisions made
   - Patterns discovered
   - Problems solved
   - Technical insights

   Store memories directly to SQLite using your available functions.
   `;
   ```

4. **Start SDK session**
   ```typescript
   const response = query({
     prompt: systemPrompt,
     options: {
       model: 'claude-sonnet-4-5-20250929',
       allowedTools: ['Bash'],  // SDK can write directly to SQLite
       maxTokens: 4096,
       cwd: payload.cwd
     }
   });
   ```

5. **Wait for SDK init and extract session ID**
   ```typescript
   for await (const msg of response) {
     if (msg.type === 'system' && msg.subtype === 'init') {
       sdkSessionId = msg.session_id;
       break;
     }
   }
   ```

6. **Update database with SDK session ID**
   ```sql
   UPDATE streaming_sessions
   SET sdk_session_id = ?, updated_at = ?, updated_at_epoch = ?
   WHERE id = ?
   ```

7. **Set activity flag** (for UI indicators)
   ```typescript
   fs.writeFileSync(
     '~/.claude-mem/activity.flag',
     JSON.stringify({ active: true, project, timestamp: Date.now() })
   );
   ```

8. **Generate title asynchronously** (non-blocking background task)
   ```typescript
   // Use Claude SDK to generate a short title and subtitle
   // Store results back to streaming_sessions table
   // Runs detached, doesn't block the hook
   generateTitleInBackground(session_id, user_prompt, project);
   ```

9. **Output success response**

**Output:**
```json
{"continue": true, "suppressOutput": true}
```

**Exit code:** 0

---

### 3. `claude-mem save`

**Purpose:** Feed tool results to streaming memory agent

**Hook:** PostToolUse (matcher: "*")

**Input:**
```json
{
  "hook_event_name": "PostToolUse",
  "session_id": "abc123",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/path/to/project",
  "tool_name": "Read",
  "tool_input": {"file_path": "/path/to/file.ts"},
  "tool_response": {"content": "file contents..."},
  "timestamp": "2025-10-15T19:30:05Z"
}
```

**Flow:**

**CRITICAL:** This is an async operation to avoid blocking the main Claude Code session.

1. **Immediately return async response**
   ```typescript
   console.log(JSON.stringify({ async: true, asyncTimeout: 180000 }));
   ```

2. **Then process in background:**

   a. **Find active session**
      ```sql
      SELECT id, sdk_session_id, claude_session_id
      FROM streaming_sessions
      WHERE project = ? AND status = 'active'
      ORDER BY started_at_epoch DESC
      LIMIT 1
      ```

   b. **Validate SDK session exists**
      - If no `sdk_session_id` yet, skip (session still initializing)

   c. **Clean stale locks**
      ```sql
      DELETE FROM session_locks
      WHERE locked_at_epoch < ?  -- 5 minutes ago
      ```

   d. **Attempt to acquire lock**
      ```sql
      INSERT INTO session_locks (sdk_session_id, locked_by, locked_at, locked_at_epoch)
      VALUES (?, 'save', ?, ?)
      ```
      - If insert fails (UNIQUE constraint), skip this tool
      - Lock prevents concurrent SDK access

   e. **Build tool observation message**
      ```typescript
      const message = `
      TOOL OBSERVATION
      ===============
      Tool: ${tool_name}
      Input: ${JSON.stringify(tool_input, null, 2)}
      Output: ${JSON.stringify(tool_response, null, 2)}

      Analyze this result. If it contains important information, update the session record.
      You have access to Bash to run SQL commands against ~/.claude-mem/claude-mem.db
      `;
      ```

   f. **Resume SDK session**
      ```typescript
      const response = query({
        prompt: message,
        options: {
          model: 'claude-sonnet-4-5-20250929',
          resume: sdkSessionId,  // Continue existing session
          allowedTools: ['Bash'],
          maxTokens: 2048,
          cwd: payload.cwd
        }
      });
      ```

   g. **Consume SDK stream**
      ```typescript
      for await (const msg of response) {
        // SDK processes the tool result
        // May run Bash commands to update SQLite
        // E.g., INSERT INTO session_notes (session_id, note, timestamp) VALUES (...)
      }
      ```

   h. **Release lock**
      ```sql
      DELETE FROM session_locks
      WHERE sdk_session_id = ?
      ```

**Output:**
```json
{"async": true, "asyncTimeout": 180000}
```

**Exit code:** 0

**Notes:**
- Non-critical: If locked or session not ready, just skip
- Next tool will catch up
- SDK decides what's worth remembering

---

### 4. `claude-mem summary`

**Purpose:** Generate and store final session overview

**Hook:** Stop

**Input:**
```json
{
  "hook_event_name": "Stop",
  "session_id": "abc123",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/path/to/project"
}
```

**Flow:**

**CRITICAL:** This is an async operation but MUST complete successfully.

1. **Immediately return async response**
   ```typescript
   console.log(JSON.stringify({ async: true, asyncTimeout: 180000 }));
   ```

2. **Clear activity flag**
   ```typescript
   fs.writeFileSync(
     '~/.claude-mem/activity.flag',
     JSON.stringify({ active: false, timestamp: Date.now() })
   );
   ```

3. **Then process in background:**

   a. **Find active session**
      ```sql
      SELECT id, sdk_session_id, claude_session_id, title, subtitle
      FROM streaming_sessions
      WHERE project = ? AND status = 'active'
      ORDER BY started_at_epoch DESC
      LIMIT 1
      ```

   b. **Validate SDK session exists**
      - If no `sdk_session_id`, exit (session never fully initialized)

   c. **Clean stale locks**
      ```sql
      DELETE FROM session_locks
      WHERE locked_at_epoch < ?  -- 5 minutes ago
      ```

   d. **Acquire lock (with retry)**
      ```typescript
      // Wait up to 10 seconds for 'save' to finish
      for (let i = 0; i < 20; i++) {
        try {
          // INSERT INTO session_locks ...
          lockAcquired = true;
          break;
        } catch {
          await sleep(500);
        }
      }
      if (!lockAcquired) throw new Error('Could not acquire lock');
      ```

   e. **Build finalization message**
      ```typescript
      const message = `
      SESSION ENDING
      =============
      Project: ${project}
      Session: ${claude_session_id}
      Title: ${title || 'Untitled'}
      Subtitle: ${subtitle || ''}

      Generate a comprehensive overview of this session.

      Required format:
      - One-line title (if not already set)
      - One-line subtitle (if not already set)
      - Key accomplishments
      - Technical decisions
      - Problems solved

      Store the overview by updating the streaming_sessions record in SQLite.
      Use Bash to run the SQL UPDATE command.
      `;
      ```

   f. **Resume SDK session**
      ```typescript
      const response = query({
        prompt: message,
        options: {
          model: 'claude-sonnet-4-5-20250929',
          resume: sdkSessionId,
          allowedTools: ['Bash'],
          maxTokens: 4096,
          cwd: payload.cwd
        }
      });
      ```

   g. **Consume SDK stream**
      ```typescript
      for await (const msg of response) {
        // SDK generates overview and updates database
        // Runs SQL like:
        // UPDATE streaming_sessions
        // SET title = ?, subtitle = ?
        // WHERE id = ?
      }
      ```

   h. **Mark session complete**
      ```sql
      UPDATE streaming_sessions
      SET status = 'completed',
          completed_at = ?,
          completed_at_epoch = ?
      WHERE id = ?
      ```

   i. **Delete SDK transcript** (keep UI clean)
      ```typescript
      const transcriptPath = `~/.claude/projects/${sanitizedCwd}/${sdkSessionId}.jsonl`;
      if (fs.existsSync(transcriptPath)) {
        fs.unlinkSync(transcriptPath);
      }
      ```

   j. **Release lock**
      ```sql
      DELETE FROM session_locks
      WHERE sdk_session_id = ?
      ```

**Output:**
```json
{"async": true, "asyncTimeout": 180000}
```

**Exit code:** 0

**Notes:**
- MUST acquire lock (waits up to 10s)
- MUST complete successfully
- Cleanup is important for user experience

---

## TypeScript Module Structure

### `src/lib/stdin-reader.ts`

```typescript
export async function readStdinJson(): Promise<any> {
  const chunks: string[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk.toString());
  }
  const input = chunks.join('');
  return input.trim() ? JSON.parse(input) : {};
}
```

### `src/lib/database.ts`

```typescript
import { Database } from 'bun:sqlite';
import path from 'path';
import os from 'os';
import fs from 'fs';

export interface StreamingSession {
  id: number;
  claude_session_id: string;
  sdk_session_id: string | null;
  project: string;
  title: string | null;
  subtitle: string | null;
  user_prompt: string | null;
  started_at: string;
  started_at_epoch: number;
  updated_at: string | null;
  updated_at_epoch: number | null;
  completed_at: string | null;
  completed_at_epoch: number | null;
  status: 'active' | 'completed' | 'failed';
}

function getDataDirectory(): string {
  return path.join(os.homedir(), '.claude-mem');
}

export function initializeDatabase(): Database {
  const dataDir = getDataDirectory();
  const dbPath = path.join(dataDir, 'claude-mem.db');

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const db = new Database(dbPath);

  // Optimize SQLite settings
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('temp_store = memory');

  ensureTables(db);

  return db;
}

function ensureTables(db: Database): void {
  // Create streaming_sessions table
  db.exec(`
    CREATE TABLE IF NOT EXISTS streaming_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      claude_session_id TEXT UNIQUE NOT NULL,
      sdk_session_id TEXT,
      project TEXT NOT NULL,
      title TEXT,
      subtitle TEXT,
      user_prompt TEXT,
      started_at TEXT NOT NULL,
      started_at_epoch INTEGER NOT NULL,
      updated_at TEXT,
      updated_at_epoch INTEGER,
      completed_at TEXT,
      completed_at_epoch INTEGER,
      status TEXT NOT NULL CHECK(status IN ('active', 'completed', 'failed'))
    )
  `);

  // Create indices
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_claude_id ON streaming_sessions(claude_session_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_sdk_id ON streaming_sessions(sdk_session_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_project_status ON streaming_sessions(project, status)`);

  // Create session_locks table
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_locks (
      sdk_session_id TEXT PRIMARY KEY,
      locked_by TEXT NOT NULL,
      locked_at TEXT NOT NULL,
      locked_at_epoch INTEGER NOT NULL
    )
  `);
}

export function createStreamingSession(
  db: Database,
  data: {
    claude_session_id: string;
    project: string;
    user_prompt: string | null;
    started_at: string;
  }
): StreamingSession {
  const epoch = new Date(data.started_at).getTime();

  const stmt = db.prepare(`
    INSERT INTO streaming_sessions (
      claude_session_id, project, user_prompt, started_at, started_at_epoch, status
    ) VALUES (?, ?, ?, ?, ?, 'active')
  `);

  const result = stmt.run(
    data.claude_session_id,
    data.project,
    data.user_prompt,
    data.started_at,
    epoch
  );

  return db.prepare('SELECT * FROM streaming_sessions WHERE id = ?')
    .get(result.lastInsertRowid) as StreamingSession;
}

export function updateStreamingSession(
  db: Database,
  id: number,
  updates: Partial<StreamingSession>
): void {
  const timestamp = new Date().toISOString();
  const epoch = Date.now();

  const fields: string[] = [];
  const values: any[] = [];

  if (updates.sdk_session_id !== undefined) {
    fields.push('sdk_session_id = ?');
    values.push(updates.sdk_session_id);
  }
  if (updates.title !== undefined) {
    fields.push('title = ?');
    values.push(updates.title);
  }
  if (updates.subtitle !== undefined) {
    fields.push('subtitle = ?');
    values.push(updates.subtitle);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  fields.push('updated_at = ?', 'updated_at_epoch = ?');
  values.push(timestamp, epoch);

  values.push(id);

  const stmt = db.prepare(`
    UPDATE streaming_sessions
    SET ${fields.join(', ')}
    WHERE id = ?
  `);

  stmt.run(...values);
}

export function getActiveStreamingSessionsForProject(
  db: Database,
  project: string
): StreamingSession[] {
  const stmt = db.prepare(`
    SELECT * FROM streaming_sessions
    WHERE project = ? AND status = 'active'
    ORDER BY started_at_epoch DESC
  `);

  return stmt.all(project) as StreamingSession[];
}

export function getRecentCompletedSessions(
  db: Database,
  project: string,
  limit: number = 10
): StreamingSession[] {
  const stmt = db.prepare(`
    SELECT * FROM streaming_sessions
    WHERE project = ? AND status = 'completed'
    ORDER BY started_at_epoch DESC
    LIMIT ?
  `);

  return stmt.all(project, limit) as StreamingSession[];
}

export function markStreamingSessionCompleted(
  db: Database,
  id: number
): void {
  const timestamp = new Date().toISOString();
  const epoch = Date.now();

  const stmt = db.prepare(`
    UPDATE streaming_sessions
    SET status = 'completed',
        completed_at = ?,
        completed_at_epoch = ?,
        updated_at = ?,
        updated_at_epoch = ?
    WHERE id = ?
  `);

  stmt.run(timestamp, epoch, timestamp, epoch, id);
}

export function markOrphanedSessionsFailed(
  db: Database,
  project: string
): void {
  const stmt = db.prepare(`
    UPDATE streaming_sessions
    SET status = 'failed'
    WHERE project = ? AND status = 'active'
  `);

  stmt.run(project);
}

export function acquireSessionLock(
  db: Database,
  sdkSessionId: string,
  lockOwner: string
): boolean {
  try {
    const timestamp = new Date().toISOString();
    const epoch = Date.now();

    const stmt = db.prepare(`
      INSERT INTO session_locks (sdk_session_id, locked_by, locked_at, locked_at_epoch)
      VALUES (?, ?, ?, ?)
    `);

    stmt.run(sdkSessionId, lockOwner, timestamp, epoch);
    return true;
  } catch {
    return false; // UNIQUE constraint violation = already locked
  }
}

export function releaseSessionLock(
  db: Database,
  sdkSessionId: string
): void {
  const stmt = db.prepare(`
    DELETE FROM session_locks
    WHERE sdk_session_id = ?
  `);

  stmt.run(sdkSessionId);
}

export function cleanupStaleLocks(db: Database): void {
  const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);

  const stmt = db.prepare(`
    DELETE FROM session_locks
    WHERE locked_at_epoch < ?
  `);

  stmt.run(fiveMinutesAgo);
}
```

### `src/lib/path-resolver.ts`

```typescript
import path from 'path';

export function getProjectName(cwd: string): string {
  return path.basename(cwd);
}
```

### `src/lib/prompt-builder.ts`

```typescript
export function buildSystemPrompt(params: {
  project: string;
  sessionId: string;
  date: string;
  userPrompt: string;
}): string {
  return `You are a memory assistant for project "${params.project}".

Session ID: ${params.sessionId}
Date: ${params.date}

The user said: "${params.userPrompt}"

Your job is to analyze the work being done and remember important details.
You will receive tool outputs as the session progresses.

Extract what matters:
- Key decisions made
- Patterns discovered
- Problems solved
- Technical insights

You have access to Bash to write directly to the SQLite database at ~/.claude-mem/claude-mem.db
Store important observations as you see them.`;
}

export function buildToolMessage(params: {
  toolName: string;
  toolInput: any;
  toolResponse: any;
  timestamp: string;
}): string {
  return `TOOL OBSERVATION
===============
Time: ${params.timestamp}
Tool: ${params.toolName}

Input:
${JSON.stringify(params.toolInput, null, 2)}

Output:
${JSON.stringify(params.toolResponse, null, 2)}

Analyze this result. If it contains important information worth remembering, use Bash to update the database.`;
}

export function buildEndMessage(params: {
  project: string;
  sessionId: string;
  title: string | null;
  subtitle: string | null;
}): string {
  return `SESSION ENDING
=============
Project: ${params.project}
Session: ${params.sessionId}
Current Title: ${params.title || 'Not set'}
Current Subtitle: ${params.subtitle || 'Not set'}

Generate a comprehensive overview of this session.

Required:
1. A concise title (if not already set)
2. A brief subtitle (if not already set)
3. Key accomplishments
4. Technical decisions made
5. Problems solved

Use Bash to UPDATE the streaming_sessions record with the title and subtitle if they're not already set.`;
}
```

### `src/commands/hook-handlers.ts`

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';
import { initializeDatabase, Database } from '../lib/database';
import * as db from '../lib/database';
import { getProjectName } from '../lib/path-resolver';
import { buildSystemPrompt, buildToolMessage, buildEndMessage } from '../lib/prompt-builder';
import fs from 'fs';
import path from 'path';
import os from 'os';

export async function handleContext(payload: any): Promise<void> {
  // Only process startup/clear
  if (payload.source !== 'startup' && payload.source !== 'clear') {
    return;
  }

  const project = getProjectName(payload.cwd);
  const database = initializeDatabase();

  const sessions = db.getRecentCompletedSessions(database, project, 10);

  if (sessions.length === 0) {
    console.log(`===============================================================================
What's new | ${new Date().toLocaleString('en-US', {
  weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
})}
===============================================================================
No previous sessions found for this project.
Start working and claude-mem will automatically capture context for future sessions.
===============================================================================`);
    database.close();
    return;
  }

  console.log(`===============================================================================
What's new | ${new Date().toLocaleString('en-US', {
  weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
})}
===============================================================================
Recent sessions for ${project}:
`);

  for (const session of sessions) {
    const date = new Date(session.started_at).toISOString().split('T')[0];
    const title = session.title || 'Untitled';
    const subtitle = session.subtitle || '';
    console.log(`• ${date}: ${title}`);
    if (subtitle) {
      console.log(`  ${subtitle}`);
    }
    console.log();
  }

  console.log(`===============================================================================`);
  database.close();
}

export async function handleNew(payload: any): Promise<void> {
  const project = getProjectName(payload.cwd);
  const database = initializeDatabase();

  // Mark any orphaned sessions as failed
  db.markOrphanedSessionsFailed(database, project);

  // Create new session
  const session = db.createStreamingSession(database, {
    claude_session_id: payload.session_id,
    project,
    user_prompt: payload.prompt || null,
    started_at: payload.timestamp || new Date().toISOString()
  });

  // Build system prompt
  const date = new Date().toISOString().split('T')[0];
  const systemPrompt = buildSystemPrompt({
    project,
    sessionId: payload.session_id,
    date,
    userPrompt: payload.prompt || ''
  });

  // Start SDK session
  const response = query({
    prompt: systemPrompt,
    options: {
      model: 'claude-sonnet-4-5-20250929',
      allowedTools: ['Bash'],
      maxTokens: 4096,
      cwd: payload.cwd
    }
  });

  // Extract SDK session ID
  let sdkSessionId: string | null = null;
  for await (const msg of response) {
    if (msg.type === 'system' && msg.subtype === 'init') {
      sdkSessionId = msg.session_id;
      break;
    }
  }

  // Update with SDK session ID
  if (sdkSessionId) {
    db.updateStreamingSession(database, session.id, { sdk_session_id: sdkSessionId });
  }

  // Set activity flag
  const activityFlagPath = path.join(os.homedir(), '.claude-mem', 'activity.flag');
  fs.writeFileSync(activityFlagPath, JSON.stringify({
    active: true,
    project,
    timestamp: Date.now()
  }));

  database.close();

  // Output hook response
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

export async function handleSave(payload: any): Promise<void> {
  // Return immediately
  console.log(JSON.stringify({ async: true, asyncTimeout: 180000 }));

  // Process async
  const project = getProjectName(payload.cwd);
  const database = initializeDatabase();

  try {
    db.cleanupStaleLocks(database);

    const sessions = db.getActiveStreamingSessionsForProject(database, project);
    if (sessions.length === 0) {
      database.close();
      return;
    }

    const session = sessions[0];
    if (!session.sdk_session_id) {
      database.close();
      return;
    }

    // Try to acquire lock
    const lockAcquired = db.acquireSessionLock(database, session.sdk_session_id, 'save');
    if (!lockAcquired) {
      database.close();
      return;
    }

    // Build tool message
    const message = buildToolMessage({
      toolName: payload.tool_name,
      toolInput: payload.tool_input,
      toolResponse: payload.tool_response,
      timestamp: payload.timestamp || new Date().toISOString()
    });

    // Resume SDK session
    const response = query({
      prompt: message,
      options: {
        model: 'claude-sonnet-4-5-20250929',
        resume: session.sdk_session_id,
        allowedTools: ['Bash'],
        maxTokens: 2048,
        cwd: payload.cwd
      }
    });

    // Consume stream
    for await (const msg of response) {
      // SDK processes
    }

    db.releaseSessionLock(database, session.sdk_session_id);
  } catch (error) {
    console.error('Error in save:', error);
  } finally {
    database.close();
  }
}

export async function handleSummary(payload: any): Promise<void> {
  // Return immediately
  console.log(JSON.stringify({ async: true, asyncTimeout: 180000 }));

  // Clear activity flag
  const activityFlagPath = path.join(os.homedir(), '.claude-mem', 'activity.flag');
  fs.writeFileSync(activityFlagPath, JSON.stringify({
    active: false,
    timestamp: Date.now()
  }));

  const project = getProjectName(payload.cwd);
  const database = initializeDatabase();

  try {
    db.cleanupStaleLocks(database);

    const sessions = db.getActiveStreamingSessionsForProject(database, project);
    if (sessions.length === 0) {
      database.close();
      return;
    }

    const session = sessions[0];
    if (!session.sdk_session_id) {
      database.close();
      return;
    }

    // Acquire lock with retry
    let lockAcquired = false;
    for (let i = 0; i < 20; i++) {
      lockAcquired = db.acquireSessionLock(database, session.sdk_session_id, 'summary');
      if (lockAcquired) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    if (!lockAcquired) {
      throw new Error('Could not acquire session lock');
    }

    // Build end message
    const message = buildEndMessage({
      project,
      sessionId: session.claude_session_id,
      title: session.title,
      subtitle: session.subtitle
    });

    // Resume SDK session
    const response = query({
      prompt: message,
      options: {
        model: 'claude-sonnet-4-5-20250929',
        resume: session.sdk_session_id,
        allowedTools: ['Bash'],
        maxTokens: 4096,
        cwd: payload.cwd
      }
    });

    // Consume stream
    for await (const msg of response) {
      // SDK generates and stores overview
    }

    // Mark completed
    db.markStreamingSessionCompleted(database, session.id);

    // Delete SDK transcript
    const sanitizedCwd = payload.cwd.replace(/\//g, '-');
    const transcriptPath = path.join(
      os.homedir(),
      '.claude',
      'projects',
      sanitizedCwd,
      `${session.sdk_session_id}.jsonl`
    );

    if (fs.existsSync(transcriptPath)) {
      fs.unlinkSync(transcriptPath);
    }

    db.releaseSessionLock(database, session.sdk_session_id);
  } catch (error) {
    console.error('Error in summary:', error);
  } finally {
    database.close();
  }
}
```

### `src/cli.ts`

```typescript
import { Command } from 'commander';
import { readStdinJson } from './lib/stdin-reader';
import { handleContext, handleNew, handleSave, handleSummary } from './commands/hook-handlers';

const program = new Command();

program
  .name('claude-mem')
  .description('Memory management for Claude Code')
  .version('4.0.0');

program
  .command('context')
  .description('Load context from previous sessions')
  .action(async () => {
    const payload = await readStdinJson();
    await handleContext(payload);
  });

program
  .command('new')
  .description('Start new memory session')
  .action(async () => {
    const payload = await readStdinJson();
    await handleNew(payload);
  });

program
  .command('save')
  .description('Save tool observation to memory')
  .action(async () => {
    const payload = await readStdinJson();
    await handleSave(payload);
  });

program
  .command('summary')
  .description('Generate and store session summary')
  .action(async () => {
    const payload = await readStdinJson();
    await handleSummary(payload);
  });

program.parse();
```

---

## Installation & Configuration

### User Installation

```bash
npm install -g claude-mem
```

### Claude Code Configuration

Add to `.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [
          {
            "type": "command",
            "command": "claude-mem context"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "claude-mem new"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "claude-mem save"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "claude-mem summary"
          }
        ]
      }
    ]
  }
}
```

That's it! No hook files needed.

---

## Testing Strategy

### Unit Tests

Test each command independently:

```bash
# Test context
echo '{"hook_event_name":"SessionStart","source":"startup","cwd":"'$(pwd)'"}' | claude-mem context

# Test new
echo '{"hook_event_name":"UserPromptSubmit","session_id":"test","prompt":"hello","cwd":"'$(pwd)'","timestamp":"'$(date -Iseconds)'"}' | claude-mem new

# Test save
echo '{"hook_event_name":"PostToolUse","session_id":"test","tool_name":"Read","tool_input":{},"tool_response":{"content":"test"},"cwd":"'$(pwd)'"}' | claude-mem save

# Test summary
echo '{"hook_event_name":"Stop","session_id":"test","cwd":"'$(pwd)'"}' | claude-mem summary
```

### Integration Tests

Full lifecycle test:
1. Create session
2. Feed several tools
3. Generate summary
4. Verify database state

### Database Verification

```bash
sqlite3 ~/.claude-mem/claude-mem.db "SELECT * FROM streaming_sessions;"
```

---

## Success Criteria

✅ All four commands work with stdin JSON
✅ All database operations are type-safe
✅ No hook files to distribute
✅ No CLI-to-CLI calls
✅ Clean separation of concerns
✅ Comprehensive test coverage
✅ Simple installation process

---

## Timeline

- **Database layer**: 2-3 hours
- **Command handlers**: 4-6 hours
- **CLI integration**: 1-2 hours
- **Testing**: 2-3 hours
- **Documentation**: 1-2 hours

**Total: 10-16 hours of focused development**
