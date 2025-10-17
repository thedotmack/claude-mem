# Current Prompt Flow (SDK System)

## Architecture Overview
- **System**: SDK Agent (persistent HTTP service via PM2)
- **Storage**: SQLite (observations + summaries per prompt)
- **Hooks**: Context (START), Summary (STOP)

---

## Flow Timeline

### 1. SESSION START (context-hook.js)

**Trigger**: Claude Code session starts
**Hook**: `user-prompt-submit`

**Actions**:
1. Create SDK session in database
2. Initialize HTTP worker (if not running)
3. Send init request to worker
4. Worker starts SDK agent subprocess

**Init Prompt Sent to SDK**:
```
You are a memory processor for the "{project}" project.

SESSION CONTEXT
---------------
Session ID: {sessionId}
User's Goal: {userPrompt}
Date: {date}

YOUR ROLE
---------
You will PROCESS tool executions during this Claude Code session. Your job is to:

1. ANALYZE each tool response for meaningful content
2. DECIDE whether it contains something worth storing
3. EXTRACT the key insight
4. STORE it as an observation in the XML format below

For MOST meaningful tool outputs, you should generate an observation. Only skip truly routine operations.

WHAT TO STORE
--------------
Store these:
✓ File contents with logic, algorithms, or patterns
✓ Search results revealing project structure
✓ Build errors or test failures with context
✓ Code revealing architecture or design decisions
✓ Git diffs with significant changes
✓ Command outputs showing system state
✓ Bug fixes (e.g., "fixed race condition in auth middleware by adding mutex")
✓ New features (e.g., "implemented JWT refresh token flow")
✓ Refactorings (e.g., "extracted validation logic into separate service")
✓ Discoveries (e.g., "found that API rate limit is 100 req/min")

WHAT TO SKIP
------------
Skip these:
✗ Simple status checks (git status with no changes)
✗ Trivial edits (one-line config changes)
✗ Repeated operations
✗ Anything without semantic value

HOW TO STORE OBSERVATIONS
--------------------------
When you identify something worth remembering, output your observation in this EXACT XML format:

```xml
<observation>
  <type>feature</type>
  <text>Implemented JWT token refresh flow with 7-day expiry</text>
</observation>
```

Valid types: decision, bugfix, feature, refactor, discovery

Structure requirements:
- <observation> is the root element
- <type> must be one of the 5 valid types (single word)
- <text> contains your concise observation (one sentence preferred)
- No additional fields or nesting

The SDK worker will parse all <observation> blocks from your response using regex and store them in SQLite.

You can include your reasoning before or after the observation block, or just output the observation by itself.

Ready to process tool responses.
```

**SDK Agent State**: Running, waiting for observations

---

### 2. TOOL EXECUTION (context-hook.js, continuous)

**Trigger**: Each tool execution in Claude Code
**Hook**: `user-prompt-submit` (captures tool results)

**Actions**:
1. Hook captures tool_name, tool_input, tool_output
2. Sends observation to worker HTTP endpoint
3. Worker queues observation for SDK agent

**Observation Prompt Sent to SDK**:
```
TOOL OBSERVATION
================
Tool: {tool_name}
Time: {timestamp}

Input:
{tool_input JSON}

Output:
{tool_output JSON}

ANALYSIS TASK
-------------
ANALYZE this tool response and DECIDE: Does it contain something worth storing?

Most Read, Edit, Grep, Bash, and Write operations contain meaningful content.

If this contains something worth remembering, output the observation in this EXACT XML format:

```xml
<observation>
  <type>feature</type>
  <text>Your concise observation here</text>
</observation>
```

Requirements:
- Use one of these types: decision, bugfix, feature, refactor, discovery
- Keep text concise (one sentence preferred)
- No markdown formatting inside <text>
- No additional XML fields

If this is truly routine (e.g., empty git status), you can skip it. Otherwise, PROCESS and STORE it.
```

**SDK Response**:
- Generates 0-N `<observation>` XML blocks
- Worker parses and stores in `observations` table
- Links to `prompt_number` (increments per user prompt)

---

### 3. PROMPT END (summary-hook.js)

**Trigger**: User prompt completes (stop-streaming event)
**Hook**: `stop-streaming`

**Actions**:
1. Send summarize request to worker
2. Worker sends finalize prompt to SDK agent

**Finalize Prompt Sent to SDK**:
```
SESSION ENDING
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

```xml
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
```

Structure requirements:
- <summary> is the root element
- All 8 child elements are REQUIRED: request, investigated, learned, completed, next_steps, files_read, files_edited, notes
- <files_read> and <files_edited> must contain <file> child elements (one per file)
- If no files were read/edited, use empty tags: <files_read></files_read>
- Text fields can be multiple sentences but avoid markdown formatting
- Use underscores in element names: next_steps, files_read, files_edited

The SDK worker will parse the <summary> block and extract all fields to store in SQLite.

Generate the summary now in the required XML format.
```

**SDK Response**:
- Generates `<summary>` XML block
- Worker parses and stores in `session_summaries` table
- Links to specific `prompt_number`

---

### 4. SESSION END (cleanup-hook.js)

**Trigger**: Claude Code session ends
**Hook**: `session-end`

**Actions**:
1. Mark session as completed
2. SDK agent continues running (doesn't terminate)
3. Worker stays alive for next session

---

## Data Storage

### Observations Table
```sql
CREATE TABLE observations (
  id INTEGER PRIMARY KEY,
  sdk_session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  type TEXT NOT NULL,
  text TEXT NOT NULL,
  prompt_number INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(sdk_session_id) REFERENCES sdk_sessions(sdk_session_id)
)
```

### Session Summaries Table
```sql
CREATE TABLE session_summaries (
  id INTEGER PRIMARY KEY,
  sdk_session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  request TEXT NOT NULL,
  investigated TEXT NOT NULL,
  learned TEXT NOT NULL,
  completed TEXT NOT NULL,
  next_steps TEXT NOT NULL,
  files_read TEXT NOT NULL,      -- JSON array
  files_edited TEXT NOT NULL,    -- JSON array
  notes TEXT NOT NULL,
  prompt_number INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(sdk_session_id) REFERENCES sdk_sessions(sdk_session_id)
)
```

---

## Key Characteristics

### Strengths
1. **Persistent SDK agent**: No restart overhead per prompt
2. **Structured data**: Typed observations, structured summaries
3. **Per-prompt tracking**: `prompt_number` links observations to specific requests
4. **Foreign key integrity**: Observations link to sessions via SDK session ID

### Weaknesses
1. **"MOST" ambiguity**: Init prompt says "For MOST meaningful tool outputs" - confusing
2. **Observation prompt repetition**: "Most Read, Edit, Grep, Bash, and Write operations contain meaningful content" - contradicts selectivity
3. **XML parsing brittleness**: Regex-based XML parsing fragile
4. **No narrative context**: Observations are one-sentence only
5. **Summary per prompt**: Creates many summaries, unclear if useful
6. **No hierarchical organization**: Flat observation list
7. **Limited searchability**: Simple text fields, no embedding/vector search
