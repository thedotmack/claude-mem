# Claude-Mem Architecture Refactor Plan

## Core Purpose

Create a lightweight, hook-driven memory system that captures important context during Claude Code sessions and makes it available in future sessions.

**Principles:**
- Hooks should be fast and non-blocking
- SDK agent synthesizes observations, not just stores raw data
- Storage should be simple and queryable
- Users should never notice the memory system working

---

## Understanding the Foundation

### What Claude Code Hooks Actually Do

**SessionStart Hook:**
- Runs when Claude Code starts or resumes
- Can inject context via stdout (plain text) OR JSON `additionalContext`
- This is how we show "What's new" to Claude

**UserPromptSubmit Hook:**
- Runs BEFORE Claude processes the user's message
- Can inject context via stdout OR JSON `additionalContext`
- This is where we initialize per-session tracking

**PostToolUse Hook:**
- Runs AFTER each tool completes successfully
- Gets both tool input and output
- Runs in PARALLEL with other matching hooks
- This is where we observe what Claude is doing

**Stop Hook:**
- Runs when main agent finishes (NOT on user interrupt)
- This is where we finalize the session
- Summary should be structured responses that answer the following:
  - What did user request?
  - What did you investigate?
  - What did you learn?
  - What did you do?
  - What's next?
  - Files read
  - Files edited
  - Notes

### How SDK Streaming Actually Works

**Streaming Input Mode (what we need):**
- Persistent session with AsyncGenerator
- Can queue multiple messages
- Supports interruption
- Natural multi-turn conversations
- The SDK maintains conversation state

**Critical insight:** We use "Streaming Input Mode" which creates ONE long-running SDK session per Claude Code session, not multiple short sessions.

---

## Architecture

### What is the SDK agent's job?

The SDK agent is a **synthesis engine**, not a data collector.

It should:
- Receive tool observations as they happen
- Extract meaningful patterns and insights
- Store atomic, searchable observations in SQLite
- Synthesize a human-readable summary at the end

It should NOT:
- Store raw tool outputs
- Try to capture everything
- Make decisions about what Claude Code should do
- Block or slow down the main session

### How hooks run in parallel

PostToolUse hooks run in parallel. Handle this by:
- Make SDK agent calls async and fire-and-forget
- Use a message queue (in-memory) to serialize SDK prompts
- SDK session can handle streaming prompts naturally

### What if the user interrupts Claude Code?

Stop hook doesn't run on interrupts. So:
- Observations stay in queue
- Next session continues where left off
- Mark session as 'interrupted' after 24h of inactivity

---

## Database Schema

```sql
-- Tracks SDK streaming sessions
CREATE TABLE sdk_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  claude_session_id TEXT UNIQUE NOT NULL,
  sdk_session_id TEXT UNIQUE NOT NULL,
  project TEXT NOT NULL,
  user_prompt TEXT,
  started_at TEXT NOT NULL,
  started_at_epoch INTEGER NOT NULL,
  completed_at TEXT,
  completed_at_epoch INTEGER,
  status TEXT CHECK(status IN ('active', 'completed', 'failed'))
);

-- Tracks pending observations (message queue)
CREATE TABLE observation_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sdk_session_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_input TEXT NOT NULL,  -- JSON
  tool_output TEXT NOT NULL, -- JSON
  created_at_epoch INTEGER NOT NULL,
  processed_at_epoch INTEGER,
  FOREIGN KEY(sdk_session_id) REFERENCES sdk_sessions(sdk_session_id)
);

-- Stores extracted observations (what SDK decides is important)
CREATE TABLE observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sdk_session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  text TEXT NOT NULL,
  type TEXT NOT NULL, -- 'decision' | 'bugfix' | 'feature' | 'refactor' | 'discovery'
  created_at TEXT NOT NULL,
  created_at_epoch INTEGER NOT NULL,
  FOREIGN KEY(sdk_session_id) REFERENCES sdk_sessions(sdk_session_id)
);

CREATE INDEX idx_observations_project ON observations(project);
CREATE INDEX idx_observations_created ON observations(created_at_epoch DESC);

-- Stores session summaries
CREATE TABLE session_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sdk_session_id TEXT UNIQUE NOT NULL,
  project TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_at_epoch INTEGER NOT NULL,
  FOREIGN KEY(sdk_session_id) REFERENCES sdk_sessions(sdk_session_id)
);

CREATE INDEX idx_summaries_project ON session_summaries(project);
CREATE INDEX idx_summaries_created ON session_summaries(created_at_epoch DESC);
```

---

## Hook Implementation

### 1. SessionStart Hook

**Purpose:** Show user what happened in recent sessions

**Hook config:**
```json
{
  "hooks": {
    "SessionStart": [{
      "matcher": "startup",
      "hooks": [{
        "type": "command",
        "command": "claude-mem context"
      }]
    }]
  }
}
```

**Command: `claude-mem context`**

Flow:
1. Read stdin JSON (session_id, cwd, source, etc.)
2. If source !== "startup", exit immediately
3. Extract project from cwd basename
4. Query SQLite for recent summaries:
   ```sql
   SELECT summary, created_at
   FROM session_summaries
   WHERE project = ?
   ORDER BY created_at_epoch DESC
   LIMIT 10
   ```
5. Format results as human-readable text
6. Output to stdout (Claude Code automatically injects this)
7. Exit with code 0

### 2. UserPromptSubmit Hook

**Purpose:** Initialize SDK memory session in background

**Hook config:**
```json
{
  "hooks": {
    "UserPromptSubmit": [{
      "hooks": [{
        "type": "command",
        "command": "claude-mem new"
      }]
    }]
  }
}
```

**Command: `claude-mem new`**

Flow:
1. Read stdin JSON (session_id, prompt, cwd, etc.)
2. Extract project from cwd
3. Create SDK session record in database
4. Start SDK session with initialization prompt in background process
5. Save SDK session ID to database
6. Output: `{"continue": true, "suppressOutput": true}`
7. Exit immediately (SDK runs in background daemon/process)

**The Background SDK Process:**

The SDK session should run as a detached background process:
```typescript
// In claude-mem new
const child = spawn('claude-mem', ['sdk-worker', session_id], {
  detached: true,
  stdio: 'ignore'
});
child.unref();
```

The SDK worker:
```typescript
// claude-mem sdk-worker <session_id>
async function runSDKWorker(sessionId: string) {
  const session = await loadSessionFromDB(sessionId);

  async function* messageGenerator() {
    yield {
      type: "user",
      message: {
        role: "user",
        content: buildInitPrompt(session)
      }
    };

    // Then listen for queued observations
    while (session.status === 'active') {
      const observations = await pollObservationQueue(session.sdk_session_id);

      for (const obs of observations) {
        yield {
          type: "user",
          message: {
            role: "user",
            content: buildObservationPrompt(obs)
          }
        };
        markObservationProcessed(obs.id);
      }

      await sleep(1000); // Poll every second
    }
  }

  // Run SDK session
  const response = query({
    prompt: messageGenerator(),
    options: {
      model: 'claude-sonnet-4-5-20250929',
      allowedTools: ['mcp__claude-mem__*'], // ChromaDB tools
      maxTurns: 1000,
      cwd: session.cwd
    }
  });

  // Consume responses
  for await (const msg of response) {
    // SDK is storing observations to ChromaDB
    // We just need to keep the stream alive
  }
}
```

### 3. PostToolUse Hook

**Purpose:** Queue tool observations for SDK processing

**Hook config:**
```json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "*",
      "hooks": [{
        "type": "command",
        "command": "claude-mem save"
      }]
    }]
  }
}
```

**Command: `claude-mem save`**

Flow:
1. Read stdin JSON (tool_name, tool_input, tool_output, etc.)
2. Find active SDK session for this project
3. Insert observation into queue:
   ```sql
   INSERT INTO observation_queue
   (sdk_session_id, tool_name, tool_input, tool_output, created_at_epoch)
   VALUES (?, ?, ?, ?, ?)
   ```
4. Output: `{"continue": true, "suppressOutput": true}`
5. Exit immediately

**Observation Filtering:**

Not every tool is worth observing. Filter in the hook:
```typescript
const BORING_TOOLS = new Set(['Glob', 'Grep', 'ListMcpResourcesTool']);

if (BORING_TOOLS.has(tool_name)) {
  console.log('{"continue": true, "suppressOutput": true}');
  process.exit(0);
}
```

### 4. Stop Hook

**Purpose:** Signal SDK to finalize and generate summary

**Hook config:**
```json
{
  "hooks": {
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "claude-mem summary"
      }]
    }]
  }
}
```

**Command: `claude-mem summary`**

Flow:
1. Read stdin JSON (session_id, cwd, etc.)
2. Find active SDK session
3. Insert special "FINALIZE" message into observation queue:
   ```sql
   INSERT INTO observation_queue
   (sdk_session_id, tool_name, tool_input, tool_output, created_at_epoch)
   VALUES (?, 'FINALIZE', '{}', '{}', ?)
   ```
4. Output: `{"continue": true, "suppressOutput": true}`
5. Exit immediately

**SDK Worker Handling:**

When SDK worker sees FINALIZE message:
```typescript
if (obs.tool_name === 'FINALIZE') {
  yield {
    type: "user",
    message: {
      role: "user",
      content: buildFinalizePrompt(session)
    }
  };

  // Wait for SDK to finish processing
  await waitForSDKCompletion();

  // Update session status
  await markSessionCompleted(session.id);

  // Exit worker
  break;
}
```

---

## SDK Agent Prompts

### Initialization Prompt

```typescript
function buildInitPrompt(project: string, sessionId: string, userPrompt: string): string {
  return `You are a memory assistant for the "${project}" project.

SESSION CONTEXT
---------------
Session ID: ${sessionId}
User's Goal: ${userPrompt}
Date: ${new Date().toISOString().split('T')[0]}

YOUR ROLE
---------
You will observe tool executions during this Claude Code session. Your job is to:

1. Extract meaningful insights (not just raw data)
2. Store atomic observations in ChromaDB
3. Focus on: key decisions, patterns discovered, problems solved, technical insights

WHAT TO CAPTURE
----------------
✓ Architecture decisions (e.g., "chose PostgreSQL over MongoDB for ACID guarantees")
✓ Bug fixes (e.g., "fixed race condition in auth middleware by adding mutex")
✓ New features (e.g., "implemented JWT refresh token flow")
✓ Refactorings (e.g., "extracted validation logic into separate service")
✓ Discoveries (e.g., "found that API rate limit is 100 req/min")

✗ NOT routine operations (reading files, listing directories)
✗ NOT work-in-progress (only completed work)
✗ NOT obvious facts (e.g., "TypeScript file has types")

TOOLS AVAILABLE
---------------
The claude-mem process has direct access to the SQLite database using bun:sqlite.

To store observations, the SDK will call internal functions that execute:
\`\`\`typescript
db.run(\`
  INSERT INTO observations (sdk_session_id, project, text, type, created_at, created_at_epoch)
  VALUES (?, ?, ?, ?, datetime('now'), unixepoch())
\`, [sessionId, project, observationText, type]);
\`\`\`

Types: decision, bugfix, feature, refactor, discovery

Example observations:
- feature: "Implemented JWT token refresh flow with 7-day expiry"
- bugfix: "Fixed race condition in session middleware by adding mutex"
- decision: "Chose PostgreSQL over MongoDB for ACID guarantees"

You don't need to write SQL directly - the system provides these observations automatically.

EXAMPLE
-------
Bad: "Read src/auth.ts file"
Good: "Implemented JWT token refresh flow with 7-day expiry"

Wait for tool observations. Acknowledge this message briefly.`;
}
```

### Observation Prompt

```typescript
function buildObservationPrompt(obs: Observation): string {
  return `TOOL OBSERVATION
================
Tool: ${obs.tool_name}
Time: ${new Date(obs.created_at_epoch).toISOString()}

Input:
${JSON.stringify(JSON.parse(obs.tool_input), null, 2)}

Output:
${JSON.stringify(JSON.parse(obs.tool_output), null, 2)}

ANALYSIS TASK
-------------
1. Does this observation contain something worth remembering?
2. If YES: Store it as a clear, concise observation in ChromaDB
3. If NO: Just acknowledge and wait for next observation

Remember: Quality over quantity. Only store meaningful insights.`;
}
```

### Finalization Prompt

```typescript
function buildFinalizePrompt(session: SDKSession): string {
  return `SESSION ENDING
==============
The Claude Code session is finishing.

FINAL TASK
----------
1. Review the observations you've stored this session
2. Generate a structured summary that answers these questions:
   - What did user request?
   - What did you investigate?
   - What did you learn?
   - What did you do?
   - What's next?
   - Files read
   - Files edited
   - Notes

3. The system will automatically store your summary using bun:sqlite when you provide it.

Just generate the structured summary text - the claude-mem process will handle storage using:
\`\`\`typescript
db.run(\`
  INSERT INTO session_summaries (sdk_session_id, project, summary, created_at, created_at_epoch)
  VALUES (?, ?, ?, datetime('now'), unixepoch())
\`, [sessionId, project, summaryText]);
\`\`\`

The summary should be suitable for showing the user in future sessions.

FORMAT EXAMPLE:
**Request:** Implement JWT authentication system
**Investigated:** Existing auth middleware, session management, token storage patterns
**Learned:** Current system uses session cookies; no JWT support; race condition in middleware
**Completed:** Implemented JWT token + refresh flow with 7-day expiry; fixed race condition with mutex; added token validation middleware
**Next Steps:** Add token revocation API endpoint; write integration tests
**Files Read:** src/auth.ts, src/middleware/session.ts, src/types/user.ts
**Files Edited:** src/auth.ts, src/middleware/auth.ts, src/routes/auth.ts
**Notes:** Token secret stored in .env; refresh tokens use rotation strategy

Generate and store the structured summary now.`;
}
```

---

## Hook Commands Architecture

All four hook commands (`claude-mem context`, `claude-mem new`, `claude-mem save`, `claude-mem summary`) are implemented as standalone TypeScript functions that:

1. **Use bun:sqlite directly** - No spawning child processes or CLI subcommands
2. **Are self-contained** - Each hook has all the logic it needs
3. **Share a common database layer** - Import from shared `db.ts` module
4. **Never call other claude-mem commands** - All functionality via direct library calls

```typescript
// Example structure
import { Database } from 'bun:sqlite';

export function contextHook(stdin: HookInput) {
  const db = new Database('~/.claude-mem/db.sqlite');
  // Query and return context directly
  const summaries = db.query('SELECT ...').all();
  console.log(formatContext(summaries));
  db.close();
}

export function saveHook(stdin: HookInput) {
  const db = new Database('~/.claude-mem/db.sqlite');
  // Insert observation directly
  db.run('INSERT INTO observation_queue ...', params);
  db.close();
  console.log('{"continue": true, "suppressOutput": true}');
}
```

**Key principle:** Hooks are fast, synchronous database operations. The SDK worker process is where async/complex logic happens.

---

## Background Process Management

The `claude-mem save` hook just queues observations - processing happens in the background SDK worker process that polls the queue continuously.

This way:
- No background daemons needed
- Works on all platforms
- Self-healing (if worker crashes, next tool restarts it)
- Simple state management

---

## Error Handling

**SDK worker failures:**
- Each observation processing is atomic
- Failed observations stay in queue
- Next worker run retries
- After 3 failures, mark observation as skipped

**Database corruption:**
- SQLite with WAL mode (write-ahead logging)
- Regular backups to ~/.claude-mem/backups/
- Automatic recovery from backups

**ChromaDB connection failures:**
- Graceful degradation (log error, continue)
- Retry with exponential backoff
- Don't block main Claude Code session
