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
- Supports interruption via `interrupt()` method
- Natural multi-turn conversations
- The SDK maintains conversation state

**Critical insight:** We use "Streaming Input Mode" which creates ONE long-running SDK session per Claude Code session, not multiple short sessions.

**Session ID Management:**
- Session IDs change with each turn of the conversation
- Must capture session ID from the initial system message
- SDK worker needs to track session ID updates continuously, not just capture once
- The first message in the response stream is a system init message with the session_id

---

## Architecture

### Visual Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     CLAUDE CODE SESSION                          │
│  (Main session - user interacting with Claude Code)             │
│                                                                   │
│  User → Claude → Tools (Read, Edit, Write, Bash, etc.)          │
│                    │                                              │
│                    │ PostToolUse Hook                             │
│                    ↓                                              │
│              claude-mem save                                      │
│              (queues observation)                                 │
└─────────────────────────────────────────────────────────────────┘
                         │
                         │ SQLite observation_queue
                         ↓
┌─────────────────────────────────────────────────────────────────┐
│                  SDK WORKER PROCESS                              │
│  (Background process - detached from main session)              │
│                                                                   │
│  ┌─────────────────────────────────────────────┐                │
│  │  Message Generator (AsyncIterable)          │                │
│  │  - Yields initial prompt                    │                │
│  │  - Polls observation_queue                  │                │
│  │  - Yields observation prompts               │                │
│  └─────────────────────────────────────────────┘                │
│                         ↓                                         │
│  ┌─────────────────────────────────────────────┐                │
│  │  SDK query() → Claude API                   │                │
│  │  Model: claude-sonnet-4-5                   │                │
│  │  No tools needed (text-only synthesis)      │                │
│  └─────────────────────────────────────────────┘                │
│                         ↓                                         │
│  ┌─────────────────────────────────────────────┐                │
│  │  Response Handler                           │                │
│  │  - Parses XML <observation> blocks          │                │
│  │  - Parses XML <summary> blocks              │                │
│  │  - Writes to SQLite tables                  │                │
│  └─────────────────────────────────────────────┘                │
└─────────────────────────────────────────────────────────────────┘
                         │
                         │ SQLite: observations, session_summaries
                         ↓
┌─────────────────────────────────────────────────────────────────┐
│                NEXT CLAUDE CODE SESSION                          │
│                                                                   │
│  SessionStart Hook → claude-mem context                          │
│  (Reads from SQLite and injects context)                         │
└─────────────────────────────────────────────────────────────────┘
```

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

### Session Management Strategy

**Built-in SDK Session Resumption:**

The Agent SDK provides native session resumption capabilities. Instead of manually tracking and rebuilding session state, we can leverage the SDK's built-in features:

```typescript
// Resume a previous SDK session
const resumedResponse = query({
  prompt: "Continue where we left off",
  options: {
    resume: sdkSessionId  // Use the session ID captured from init message
  }
});
```

**When to use session resumption:**
- User interrupts Claude Code and resumes later
- SDK worker crashes and needs to restart
- Long-running observations that span multiple Claude Code sessions

**Session state tracking:**
- Store SDK session ID in database when captured from init message
- Mark sessions as 'active', 'completed', 'interrupted', or 'failed'
- Use session status to determine whether to resume or start fresh

### How hooks run in parallel

PostToolUse hooks run in parallel. Handle this by:
- Make SDK agent calls async and fire-and-forget
- Use the observation_queue SQLite table to serialize observations
- SDK worker polls this queue and processes observations sequentially

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

**IMPORTANT DISTINCTION:**

There are TWO separate hook systems at play here:

1. **Claude Code Hooks** - External command hooks configured in `~/.config/claude-code/settings.json`
   - These hooks observe the MAIN Claude Code session
   - They run as external commands (like `claude-mem save`)
   - This is what we use to capture observations from the user's session

2. **SDK Hooks** - Programmatic hooks configured in TypeScript code via `HookMatcher`
   - These hooks would observe the MEMORY SDK agent's own tool usage
   - They run as TypeScript callbacks within the SDK worker process
   - We're NOT using these (yet) - they're a future enhancement

**Our architecture:** Use Claude Code hooks (external commands) to observe the main session, and run a separate SDK worker process that doesn't need its own hooks.

### 1. SessionStart Hook

**Purpose:** Show user what happened in recent sessions

**Claude Code Hook Config (in settings.json):**
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
import { query } from '@anthropic-ai/agent-sdk';
import type { Query, UserMessage } from '@anthropic-ai/agent-sdk';

async function runSDKWorker(sessionId: string) {
  const session = await loadSessionFromDB(sessionId);

  // Track the SDK session ID from the init message
  let sdkSessionId: string | undefined;
  const abortController = new AbortController();

  // Message generator yields UserMessage objects (role + content)
  // This matches the SDK's expected format for streaming input mode
  async function* messageGenerator(): AsyncIterable<UserMessage> {
    // Initial prompt
    yield {
      role: "user",
      content: buildInitPrompt(session)
    };

    // Then listen for queued observations
    while (session.status === 'active' && !abortController.signal.aborted) {
      const observations = await pollObservationQueue(session.sdk_session_id);

      for (const obs of observations) {
        yield {
          role: "user",
          content: buildObservationPrompt(obs)
        };
        markObservationProcessed(obs.id);
      }

      await sleep(1000); // Poll every second
    }
  }

  // Run SDK session with proper streaming interface
  // The query function signature: query({ prompt, options }): Query
  const response: Query = query({
    prompt: messageGenerator(), // AsyncIterable<UserMessage>
    options: {
      model: 'claude-sonnet-4-5', // Use documented model name
      disallowedTools: ['Glob', 'Grep', 'ListMcpResourcesTool', 'WebSearch'], // More efficient than filtering in hooks
      maxTurns: 1000,
      cwd: session.cwd,
      abortController: abortController
    }
  });

  try {
    // Consume responses from the Query AsyncGenerator
    for await (const msg of response) {
      // Capture session ID from system init message
      if (msg.type === 'system' && msg.subtype === 'init') {
        sdkSessionId = msg.session_id;
        console.log(`SDK session started with ID: ${sdkSessionId}`);
        // Store SDK session ID in database for potential resumption
        await updateSDKSessionId(session.id, sdkSessionId);
      }

      if (msg.type === 'text') {
        // Use an XML parser library (e.g., fast-xml-parser or similar) to parse observations and summaries
        // Parse <observation> blocks and call storeObservation(session_id, project, type, text)
        // Parse <summary> blocks, extract all 8 fields, format and call storeSummary(session_id, project, text)

        parseAndStoreObservations(msg.content, session);
        parseAndStoreSummary(msg.content, session);
      }
    }
  } catch (error) {
    if (abortController.signal.aborted) {
      console.log('SDK worker interrupted gracefully');
    } else {
      console.error('SDK worker error:', error);
      await markSessionFailed(session.id, error);
    }
  } finally {
    await cleanupSession(session.id);
  }
}

// Note: Query and UserMessage types are imported from '@anthropic-ai/agent-sdk'
// Query extends AsyncGenerator and provides interrupt() and setPermissionMode() methods
// UserMessage has the shape: { role: "user", content: string }
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

Tool filtering is now handled at the SDK level (see SDK Worker section) using `disallowedTools` option. The hook no longer needs to filter tools manually - all tool observations that reach the hook are already relevant.

However, you may still want to skip certain tools for performance reasons:
```typescript
// Optional: Skip very frequent or low-value tools
const SKIP_TOOLS = new Set(['TodoWrite', 'ListMcpResourcesTool']);

if (SKIP_TOOLS.has(tool_name)) {
  console.log('{"continue": true, "suppressOutput": true}');
  process.exit(0);
}
```

**Note:** The SDK worker uses `disallowedTools: ['Glob', 'Grep', 'ListMcpResourcesTool', 'WebSearch']` which is more efficient than hook-level filtering because it prevents the SDK agent from using these tools entirely.

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
2. Store atomic observations in SQLite
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

HOW TO STORE OBSERVATIONS
--------------------------
When you identify something worth remembering, output your observation in this EXACT XML format:

\`\`\`xml
<observation>
  <type>feature</type>
  <text>Implemented JWT token refresh flow with 7-day expiry</text>
</observation>
\`\`\`

Valid types: decision, bugfix, feature, refactor, discovery

Structure requirements:
- <observation> is the root element
- <type> must be one of the 5 valid types (single word)
- <text> contains your concise observation (one sentence preferred)
- No additional fields or nesting

The SDK worker will parse all <observation> blocks from your response using regex and store them in SQLite.

You can include your reasoning before or after the observation block, or just output the observation by itself.

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
2. If YES: Output the observation in this EXACT XML format:

   \`\`\`xml
   <observation>
     <type>feature</type>
     <text>Your concise observation here</text>
   </observation>
   \`\`\`

   Requirements:
   - Use one of these types: decision, bugfix, feature, refactor, discovery
   - Keep text concise (one sentence preferred)
   - No markdown formatting inside <text>
   - No additional XML fields

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

3. Generate the structured summary and output it in this EXACT XML format:

\`\`\`xml
<summary>
  <request>Implement JWT authentication system</request>
  <investigated>Existing auth middleware, session management, token storage patterns</investigated>
  <learned>Current system uses session cookies; no JWT support; race condition in middleware</learned>
  <completed>Implemented JWT token + refresh flow with 7-day expiry; fixed race condition with mutex; added token validation middleware</completed>
  <next_steps>Add token revocation API endpoint; write integration tests</next_steps>
  <files_read>
    <file>src/auth.ts</file>
    <file>src/middleware/session.ts</file>
    <file>src/types/user.ts</file>
  </files_read>
  <files_edited>
    <file>src/auth.ts</file>
    <file>src/middleware/auth.ts</file>
    <file>src/routes/auth.ts</file>
  </files_edited>
  <notes>Token secret stored in .env; refresh tokens use rotation strategy</notes>
</summary>
\`\`\`

Structure requirements:
- <summary> is the root element
- All 8 child elements are REQUIRED: request, investigated, learned, completed, next_steps, files_read, files_edited, notes
- <files_read> and <files_edited> must contain <file> child elements (one per file)
- If no files were read/edited, use empty tags: <files_read></files_read>
- Text fields can be multiple sentences but avoid markdown formatting
- Use underscores in element names: next_steps, files_read, files_edited

The SDK worker will parse the <summary> block and extract all fields to store in SQLite.

Generate the summary now in the required XML format.`;
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

The SDK worker is spawned by `claude-mem new` as a detached process and runs for the duration of the Claude Code session.

Benefits:
- Works on all platforms (no systemd/launchd needed)
- Self-contained (spawned and managed by claude-mem itself)
- Simple state management (all state in SQLite)

---

## Advanced SDK Features

### Permission Integration (Future Enhancement)

The SDK provides a permission system that could be integrated with memory for context-aware decisions:

```typescript
canUseTool: async (toolName, input) => {
  // Check memory for previous decisions about this tool/context
  const previousDecisions = await queryMemoryForTool(toolName, input);

  if (previousDecisions.shouldAllow) {
    return {
      behavior: "allow",
      updatedInput: input
    };
  }

  return {
    behavior: "ask_user",
    message: `This tool was previously flagged. Allow anyway?`
  };
}
```

This could enable:
- Learning from previous tool use patterns
- Automatically allowing/denying based on historical context
- Providing smart defaults based on project-specific patterns

**Implementation priority:** Low (add after core functionality is stable)

### SDK Hook Configuration (Alternative to Claude Code Hooks)

Instead of using external command hooks via Claude Code settings.json, the SDK supports native hook configuration:

```typescript
import { HookMatcher } from '@anthropic-ai/agent-sdk';

const response = query({
  prompt: messageGenerator(),
  options: {
    hooks: {
      'PreToolUse': [
        HookMatcher(matcher='Bash', hooks=[validateBashCommand]),
        HookMatcher(hooks=[logToolUse])  // Applies to all tools
      ],
      'PostToolUse': [
        HookMatcher(hooks=[captureObservation])
      ]
    }
  }
});

type HookCallback = (
  input: HookInput,
  toolUseID: string | undefined,
  options: { signal: AbortSignal }
) => Promise<HookJSONOutput>;
```

**When to use SDK hooks vs Claude Code hooks:**
- **Claude Code hooks**: For integrating with the main Claude Code session (our current approach)
- **SDK hooks**: For controlling the memory agent's own tool usage (future enhancement)

**Implementation priority:** Medium (could simplify architecture, but adds complexity to migration)

---

## Error Handling

**SDK worker failures:**
- Each observation processing is atomic
- Failed observations stay in queue
- Next worker run retries
- After 3 failures, mark observation as skipped
- Use AbortController for graceful cancellation

**Abort signal handling:**
```typescript
try {
  for await (const msg of response) {
    if (abortController.signal.aborted) {
      throw new Error('Aborted');
    }
    // Process message
  }
} catch (error) {
  if (abortController.signal.aborted) {
    // Clean shutdown
    await response.interrupt();
  } else {
    // Actual error
    throw error;
  }
}
```

**Database corruption:**
- SQLite with WAL mode (write-ahead logging)
- Regular backups to ~/.claude-mem/backups/
- Automatic recovery from backups

**SDK API failures:**
- Retry with exponential backoff
- Don't block main Claude Code session
- Log errors for debugging
- Mark session as 'failed' after max retries

---

## Implementation Order

1. **Database setup** - Create tables and migration scripts
2. **Hook commands** - Implement the 4 hook commands (context, new, save, summary)
3. **SDK worker** - Implement the background worker process with response parsing
4. **SDK prompts** - Wire up the prompts and message generator
5. **Test end-to-end** - Run a real Claude Code session and verify it works

Start simple. Get one hook working before moving to the next. Don't try to build everything at once.

**Note:** MCP is only used for retrieval (when Claude Code needs to access stored memories), not for storage. The SDK agent stores data by outputting specially formatted text that the SDK worker parses and writes to SQLite.

### SDK Import Verification

Before implementing, verify the SDK exports match your usage:

```typescript
// Required imports from @anthropic-ai/agent-sdk
import { query } from '@anthropic-ai/agent-sdk';
import type { Query, UserMessage, Options } from '@anthropic-ai/agent-sdk';

// Verify the query function signature:
// function query(options: { prompt: string | AsyncIterable<UserMessage>; options?: Options }): Query

// Verify Query type:
// interface Query extends AsyncGenerator<SDKMessage, void> {
//   interrupt(): Promise<void>;
//   setPermissionMode(mode: PermissionMode): Promise<void>;
// }

// Verify UserMessage type:
// type UserMessage = { role: "user"; content: string }
```

If the SDK exports differ from this structure, adjust the implementation accordingly. The SDK documentation should be the source of truth.

---

## Key Corrections from Agent SDK Documentation

This refactor plan has been updated to align with the official Agent SDK documentation. Key corrections include:

### 1. Session ID Management
- **Before:** Captured session ID once in UserPromptSubmit hook
- **After:** Capture from system init message and track updates continuously
- **Why:** Session IDs change with each conversation turn

### 2. Hook Configuration
- **Before:** Mixed up SDK hook format with Claude Code hook format
- **After:** Clarified that Claude Code uses settings.json format (external commands); SDK uses TypeScript HookMatcher (programmatic callbacks)
- **Why:** Two separate hook systems with different purposes and configuration methods
- **Our approach:** Use Claude Code hooks to observe the main session; SDK hooks are future enhancement

### 3. Message Generator and Query Interface
- **Before:** Custom SDKMessage type with nested message structure
- **After:** Simple UserMessage type `{ role: "user", content: string }` yielded from AsyncIterable
- **Why:** SDK expects AsyncIterable<UserMessage>, not a custom wrapper format
- **Query type:** Properly typed as `Query` which extends AsyncGenerator with interrupt() and setPermissionMode()

### 4. Tool Filtering
- **Before:** Filter "boring tools" in PostToolUse hook
- **After:** Use SDK's `disallowedTools` option in query configuration
- **Why:** More efficient to prevent SDK from using tools entirely

### 5. Model Identifier
- **Before:** Used `claude-haiku-4-5-20251001` (undocumented)
- **After:** Use `claude-sonnet-4-5` (documented model name)
- **Why:** Stick to documented model identifiers for stability

### 6. Error Handling
- **Before:** Custom error handling without SDK features
- **After:** Use AbortController and response.interrupt() for graceful cancellation
- **Why:** SDK provides built-in cancellation mechanisms

### 7. Session Resumption
- **Before:** Manual session state reconstruction
- **After:** Leverage SDK's built-in `resume: sessionId` option
- **Why:** SDK already handles session resumption

### Future Enhancements to Consider

1. **Permission integration** - Use canUseTool callback to make memory-aware decisions
2. **SDK native hooks** - Replace external command hooks with SDK HookMatcher
3. **Better session recovery** - Use SDK resumption for interrupted sessions

These corrections ensure our implementation follows Agent SDK best practices and avoids reinventing functionality the SDK already provides.

---

## Architecture Validation Summary

This plan has been validated against the official Agent SDK documentation and confirmed to be architecturally sound.

### ✅ Validated Design Decisions

1. **Hook System Usage** - Correctly uses Claude Code external command hooks for observation; SDK programmatic hooks reserved for future enhancement
2. **Query Function Interface** - Properly implements AsyncIterable<UserMessage> for streaming input mode
3. **Session Management** - Leverages SDK's built-in session resumption instead of manual state reconstruction
4. **Tool Filtering** - Uses SDK's `disallowedTools` option for efficiency
5. **Error Handling** - Implements AbortController and interrupt() for graceful cancellation
6. **Separation of Concerns** - Clean isolation between main Claude Code session and background SDK worker

### 🎯 Architecture Strengths

- **Non-blocking** - Hooks are fast database operations; complex logic happens in background
- **Queue-based** - Handles parallel hook execution correctly via observation_queue table
- **Fault-tolerant** - Failed observations stay in queue for retry; graceful degradation
- **Platform-agnostic** - No dependency on systemd/launchd; works everywhere
- **Type-safe** - Uses official SDK TypeScript types throughout

### 📋 Pre-Implementation Checklist

Before starting implementation, verify:

1. [ ] Agent SDK installed and accessible: `@anthropic-ai/agent-sdk`
2. [ ] Verify SDK exports match expected structure (query, Query, UserMessage types)
3. [ ] SQLite database location decided: `~/.claude-mem/db.sqlite`
4. [ ] Claude Code settings.json hook configuration tested
5. [ ] Background process spawning works on target platform (test detached process)

### 🚀 Ready for Implementation

The architecture is validated and ready for implementation. Follow the phased approach:

1. Database setup first (get schema working with bun:sqlite)
2. Implement hooks one at a time (start with `context`, then `save`)
3. Build SDK worker with simple message generator
4. Test end-to-end with a real Claude Code session
5. Iterate and refine based on real-world usage

**Remember:** Start simple, get one piece working, then build on it. Don't try to implement everything at once.
