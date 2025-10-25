# Claude-Mem Worker Server Architecture

**Document Version:** 1.0
**Last Updated:** 2025-01-24
**Author:** Analysis by Claude Code
**Purpose:** Comprehensive technical analysis of the worker server architecture, logic flow, blocking behavior, and component value assessment

---

## Executive Summary

The claude-mem worker server is a long-running HTTP service managed by PM2 that processes tool execution observations and generates session summaries using the Claude Agent SDK. It implements a **defensive, layered architecture** designed to maximize data persistence while maintaining flexibility.

### Key Design Principles

1. **Maximally Permissive Storage** - System defaults to saving data even if incomplete
2. **Auto-Recovery** - Worker restarts don't prevent processing (session state reconstructed from database)
3. **Queue-Based Processing** - HTTP API decoupled from AI processing for reliability
4. **Defensive Programming** - Auto-creates missing database records, accepts null fields
5. **Session Isolation** - Each session has independent state and SDK agent

### Architecture at a Glance

```
┌─────────────────────────────────────────────────────────────┐
│ Layer 1: HTTP API (Express.js)                              │
│ - 6 REST endpoints                                          │
│ - Always queues messages (maximally permissive)             │
└──────────────────┬──────────────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────────────┐
│ Layer 2: In-Memory Queue                                    │
│ - pendingMessages array per session                         │
│ - VULNERABILITY: Lost on worker restart                     │
└──────────────────┬──────────────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────────────┐
│ Layer 3: SDK Agent (Claude Agent SDK)                       │
│ - Processes queued messages via async generator             │
│ - Can fail due to config or AI errors                       │
└──────────────────┬──────────────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────────────┐
│ Layer 4: Parser (XML Extraction)                            │
│ - Extracts observations and summaries from AI responses     │
│ - Permissive (v4.2.5/v4.2.6 fixes ensure partial data saved)│
└──────────────────┬──────────────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────────────┐
│ Layer 5: Database (SQLite with better-sqlite3)              │
│ - Permanent storage (once here, data persists)              │
│ - Auto-creates missing sessions, accepts nulls              │
└─────────────────────────────────────────────────────────────┘
```

**Critical Insight:** Data can only be lost between layers 2-4. Once it reaches the database (layer 5), it's permanent.

---

## Component Inventory

### HTTP REST API Endpoints

| Endpoint | Purpose | Blocks Data? |
|----------|---------|--------------|
| `GET /health` | Worker health check | N/A |
| `POST /sessions/:id/init` | Initialize session and start SDK agent | Only if session not in DB (expected) |
| `POST /sessions/:id/observations` | Queue tool observation | ❌ Never (auto-recovery) |
| `POST /sessions/:id/summarize` | Queue summary request | ❌ Never (auto-recovery) |
| `GET /sessions/:id/status` | Get session status | N/A |
| `DELETE /sessions/:id` | Abort session | ⚠️ Queued messages lost |

### Core Processing Components

| Component | File | Lines | Purpose |
|-----------|------|-------|---------|
| WorkerService | worker-service.ts | 52-590 | Main service class, manages sessions |
| runSDKAgent | worker-service.ts | 345-404 | Runs SDK agent for a session |
| createMessageGenerator | worker-service.ts | 410-502 | Async generator feeding SDK |
| handleAgentMessage | worker-service.ts | 508-563 | Parses and stores SDK responses |
| parseObservations | parser.ts | 32-96 | Extracts observations from XML |
| parseSummary | parser.ts | 102-157 | Extracts summary from XML |
| SessionStore | SessionStore.ts | 9-1086 | Database operations |

---

## Deep Dive: HTTP Endpoints

### GET /health (lines 100-109)

**Purpose:** Health check for monitoring and debugging

**Logic Flow:**
1. Returns JSON with status, port, PID, active sessions, uptime, memory

**Blocking Analysis:** ❌ N/A (read-only endpoint)

**Value Assessment:** ✅ HIGH VALUE
- Essential for monitoring worker health
- Helps debug port conflicts and process state
- Keep as-is

---

### POST /sessions/:sessionDbId/init (lines 115-169)

**Purpose:** Initialize a new session and start the SDK agent

**Logic Flow:**
1. Parse `sessionDbId` from URL
2. Extract `project` and `userPrompt` from request body
3. Fetch session from database using `SessionStore.getSessionById()`
4. **CRITICAL CHECK:** Return 404 if session not found in DB
5. Retrieve `claudeSessionId` from database record
6. Create `ActiveSession` object with initial state:
   ```typescript
   {
     sessionDbId, claudeSessionId, sdkSessionId: null,
     project, userPrompt, pendingMessages: [],
     abortController: new AbortController(),
     generatorPromise: null, lastPromptNumber: 0,
     observationCounter: 0, startTime: Date.now()
   }
   ```
7. Store session in memory map (`this.sessions`)
8. Update `worker_port` in database
9. Start `runSDKAgent()` in background (fire-and-forget promise)
10. Return success response immediately

**Blocking Analysis:** ⚠️ CONDITIONAL
- Returns 404 if session doesn't exist in database
- This is expected behavior - session must be created before init
- Doesn't prevent future initialization attempts
- Error logged and hook can retry

**Value Assessment:** ✅ HIGH VALUE
- Critical initialization step
- Background SDK agent startup prevents timeout
- Keep as-is

**Edge Cases:**
- Session exists but SDK agent fails to start → Session marked as failed, but new init can retry
- Multiple init calls for same session → First one wins (subsequent calls find session in memory)

---

### POST /sessions/:sessionDbId/observations (lines 175-230)

**Purpose:** Queue a tool execution observation for processing

**Logic Flow:**
1. Parse `sessionDbId` from URL
2. Extract `tool_name`, `tool_input`, `tool_output`, `prompt_number` from body
3. Check if session exists in memory map (`this.sessions.get(sessionDbId)`)
4. **AUTO-RECOVERY** (lines 181-209): If session NOT in memory:
   - Fetch session from database
   - Recreate `ActiveSession` object
   - Start new SDK agent in background
   - This enables recovery from worker restarts!
5. Increment `observationCounter` for correlation ID tracking
6. Push observation message to `pendingMessages` queue:
   ```typescript
   {
     type: 'observation',
     tool_name, tool_input, tool_output, prompt_number
   }
   ```
7. Return success with queue length

**Blocking Analysis:** ❌ NEVER BLOCKS
- Auto-creates session state from database if missing
- Always queues the observation
- HTTP response confirms receipt immediately
- Processing happens asynchronously

**Value Assessment:** ✅ HIGH VALUE
- Auto-recovery is brilliant design
- Worker restart doesn't lose ability to process observations
- Keep as-is

**Edge Cases:**
- Worker restart while observation in queue → Lost (queue is in-memory)
- But NEW observations after restart are queued successfully (auto-recovery)
- Database not found → Would throw error, but SessionStore auto-creates sessions

---

### POST /sessions/:sessionDbId/summarize (lines 236-284)

**Purpose:** Queue a summary generation request

**Logic Flow:**
1. Parse `sessionDbId` and `prompt_number` from request
2. Check if session exists in memory
3. **AUTO-RECOVERY** (lines 241-270): Same pattern as observations endpoint
   - Fetches session from database
   - Recreates `ActiveSession` object
   - Starts new SDK agent
4. Push summarize message to `pendingMessages` queue:
   ```typescript
   {
     type: 'summarize',
     prompt_number
   }
   ```
5. Return success with queue length

**Blocking Analysis:** ❌ NEVER BLOCKS
- Same auto-recovery mechanism as observations
- Always queues the summary request
- Processing happens asynchronously

**Value Assessment:** ✅ HIGH VALUE
- Auto-recovery pattern prevents data loss
- Keep as-is

**Code Quality Note:** ⚠️ MEDIUM - Duplicated auto-recovery code (lines 181-209 and 241-270 are nearly identical)
- Could extract to helper function: `getOrCreateSession(sessionDbId)`
- Would reduce duplication and improve maintainability

---

### GET /sessions/:sessionDbId/status (lines 289-304)

**Purpose:** Get current session status and queue length

**Logic Flow:**
1. Parse `sessionDbId` from URL
2. Get session from memory map
3. Return 404 if not found
4. Return session info: `sessionDbId`, `sdkSessionId`, `project`, `pendingMessages.length`

**Blocking Analysis:** ❌ N/A (read-only endpoint)

**Value Assessment:** ✅ MEDIUM VALUE
- Useful for debugging
- Not critical for core functionality
- Keep as-is

---

### DELETE /sessions/:sessionDbId (lines 309-340)

**Purpose:** Abort a running session and clean up

**Logic Flow:**
1. Parse `sessionDbId` from URL
2. Get session from memory map
3. Return 404 if not found
4. Call `abortController.abort()` to signal SDK agent to stop
5. Wait for `generatorPromise` to finish (max 5 seconds timeout)
6. Mark session as 'failed' in database
7. Delete session from memory map
8. Return success

**Blocking Analysis:** ⚠️ BLOCKS QUEUED MESSAGES
- Aborts SDK agent processing
- Any messages in `pendingMessages` queue are lost
- Already-stored observations/summaries remain in database

**Value Assessment:** ✅ MEDIUM VALUE
- Provides clean shutdown mechanism
- Used for manual cleanup
- As of v4.1.0, SessionEnd hook doesn't call DELETE (graceful cleanup)
- Keep for manual intervention, but not used automatically

**Historical Note:**
- v4.0.x: SessionEnd hook called DELETE → interrupted summary generation
- v4.1.0+: Graceful cleanup → workers finish naturally

---

## Deep Dive: SDK Agent Processing

### runSDKAgent (lines 345-404)

**Purpose:** Core processing engine that runs continuously for each session

**Logic Flow:**
1. Call `query()` from Claude Agent SDK with:
   ```typescript
   {
     prompt: this.createMessageGenerator(session),
     options: {
       model: MODEL,  // from CLAUDE_MEM_MODEL env var
       disallowedTools: DISALLOWED_TOOLS,
       abortController: session.abortController,
       pathToClaudeCodeExecutable: claudePath
     }
   }
   ```
2. Iterate over SDK responses using `for await`
3. For each assistant message:
   - Extract text content from response
   - Log response size
   - Call `handleAgentMessage()` to parse and store
4. On completion:
   - Log session duration
   - Mark session as 'completed' in database
   - Delete session from memory map
5. On error:
   - Log error (or warning for AbortError)
   - Mark session as 'failed' in database
   - Throw error (caught by `generatorPromise.catch()`)

**Blocking Analysis:** ⚠️ CAN BLOCK IF:
- Invalid `CLAUDE_MEM_MODEL` → SDK initialization fails
- Invalid `CLAUDE_CODE_PATH` → SDK initialization fails
- SDK crashes → Session marked as failed
- BUT: Doesn't prevent NEW sessions from being created

**Value Assessment:** ✅ HIGH VALUE
- Core processing engine
- Proper error handling with session status tracking
- Keep as-is

**Configuration Dependencies:**
- `CLAUDE_MEM_MODEL` (default: 'claude-sonnet-4-5')
- `CLAUDE_CODE_PATH` (default: specific path to claude executable)
- `DISALLOWED_TOOLS` (default: ['Glob', 'Grep', 'ListMcpResourcesTool', 'WebSearch'])

**Edge Cases:**
- SDK hangs → AbortController provides cancellation mechanism
- Network issues → SDK handles retries internally
- Multiple concurrent sessions → Each has isolated SDK agent

---

### createMessageGenerator (lines 410-502)

**Purpose:** Async generator that feeds messages to the SDK agent (bridge between HTTP API and SDK)

**Logic Flow:**
1. Build init prompt using `buildInitPrompt(project, claudeSessionId, userPrompt)`
2. Yield initial user message:
   ```typescript
   {
     type: 'user',
     session_id: claudeSessionId,  // Real Claude Code session ID
     parent_tool_use_id: null,
     message: { role: 'user', content: initPrompt }
   }
   ```
3. Enter infinite loop (`while (true)`):
   - Check `abortController.signal.aborted` → break if aborted
   - If no pending messages → sleep 100ms and continue
   - While `pendingMessages.length > 0`:
     - Shift message from queue (FIFO)
     - If type === 'summarize':
       - Update `lastPromptNumber`
       - Fetch session from database
       - Build summary prompt using `buildSummaryPrompt()`
       - Yield summary prompt as user message
     - If type === 'observation':
       - Update `lastPromptNumber`
       - Build observation prompt using `buildObservationPrompt()`
       - Yield observation prompt as user message

**Blocking Analysis:** ❌ DOESN'T BLOCK
- Continuously processes queue until aborted
- 100ms polling means small delay but no data loss
- Messages shifted from queue and sent to SDK
- If SDK fails, messages lost from queue (but already confirmed via HTTP)

**Value Assessment:** ✅ HIGH VALUE
- Elegant async generator pattern
- Keep as-is

**Performance Note:** ⚠️ 100ms polling interval
- Could be improved with event-driven queue (e.g., `AsyncQueue` with notifications)
- Current implementation is simple and works well
- Low priority optimization

**Data Flow:**
```
HTTP /observations → pendingMessages.push() → [sleep 100ms] →
pendingMessages.shift() → buildObservationPrompt() → yield to SDK →
SDK processes → handleAgentMessage()
```

---

### handleAgentMessage (lines 508-563)

**Purpose:** Parse SDK response and store observations/summaries in database

**Logic Flow:**
1. Call `parseObservations(content, correlationId)`
2. If observations found:
   - For each observation:
     - Call `db.storeObservation(claudeSessionId, project, observation, promptNumber)`
     - Log success with correlation ID
3. Call `parseSummary(content, sessionId)`
4. If summary found:
   - Call `db.storeSummary(claudeSessionId, project, summary, promptNumber)`
   - Log success
5. If NO summary found:
   - Log warning with content sample

**Blocking Analysis:** ⚠️ CAN BLOCK IF:
- Parser returns empty array/null → Nothing stored (but this is expected for routine operations)
- Database error → Would throw and crash handler (rare with permissive schema)

**Value Assessment:** ✅ HIGH VALUE
- Core storage logic
- Proper logging for debugging
- Keep as-is

**Critical Dependencies:**
- `parseObservations()` must return valid observations
- `parseSummary()` must return valid summary
- Database must accept the data (schema constraints)

**Logging:**
- Extensive logging at INFO, SUCCESS, and WARN levels
- Correlation IDs for tracking individual observations
- Debug mode logs full SDK responses

---

## Deep Dive: Parser System

### parseObservations (parser.ts lines 32-96)

**Purpose:** Extract observation XML blocks from SDK response and parse into structured data

**Logic Flow:**
1. Use regex to find all `<observation>...</observation>` blocks (non-greedy):
   ```typescript
   /<observation>([\s\S]*?)<\/observation>/g
   ```
2. For each block:
   - Extract all fields: `type`, `title`, `subtitle`, `narrative`, `facts`, `concepts`, `files_read`, `files_modified`
   - **VALIDATION** (lines 52-67):
     - If `type` is missing or invalid → default to "change"
     - Valid types: `['bugfix', 'feature', 'refactor', 'change', 'discovery', 'decision']`
     - All other fields can be null
   - Filter out `type` from `concepts` array (types and concepts are separate dimensions)
   - Push observation to results array
3. Return all observations

**Blocking Analysis:** ❌ NEVER BLOCKS (as of v4.2.6)
- **CRITICAL FIX** (v4.2.6): Removed validation that required title, subtitle, and narrative
- Comment on line 52: "NOTE FROM THEDOTMACK: ALWAYS save observations - never skip. 10/24/2025"
- Always returns observations with whatever fields exist
- Only transformation: type defaults to "change" if invalid

**Value Assessment:** ✅ HIGH VALUE
- Permissive parsing ensures data is never lost
- v4.2.6 fix was critical for reliability
- Keep as-is

**Historical Context:**
- **Before v4.2.6:** Would skip observations missing required fields → data loss
- **After v4.2.6:** Always saves with defaults → maximally permissive

**Edge Cases:**
1. No `<observation>` tags → Returns empty array (normal for routine operations)
2. All fields empty → Returns observation with null fields and type="change"
3. Malformed XML → Regex won't match → Returns empty array (data loss)
4. Type in concepts → Filtered out (types and concepts are orthogonal)

**Example:**
```xml
<observation>
  <type>feature</type>
  <title>Authentication added</title>
  <subtitle>Implemented OAuth2 flow</subtitle>
  <facts>
    <fact>Added OAuth2 provider configuration</fact>
    <fact>Created callback endpoint</fact>
  </facts>
  <narrative>Full OAuth2 authentication...</narrative>
  <concepts>
    <concept>how-it-works</concept>
    <concept>what-changed</concept>
  </concepts>
  <files_read>
    <file>src/auth/oauth.ts</file>
  </files_read>
  <files_modified>
    <file>src/auth/oauth.ts</file>
  </files_modified>
</observation>
```

---

### parseSummary (parser.ts lines 102-157)

**Purpose:** Extract summary XML block from SDK response

**Logic Flow:**
1. Check for `<skip_summary reason="..."/>` tag (lines 104-113)
   - If found → log reason and return null (intentional skip)
2. Match `<summary>...</summary>` block (non-greedy):
   ```typescript
   /<summary>([\s\S]*?)<\/summary>/
   ```
   - If not found → return null (SDK didn't provide summary)
3. Extract all fields: `request`, `investigated`, `learned`, `completed`, `next_steps`, `notes` (optional)
4. **VALIDATION REMOVED** (lines 133-147):
   - Comment: "NOTE FROM THEDOTMACK: 100% of the time we must SAVE the summary, even if fields are missing. 10/24/2025"
   - Comment: "NEVER DO THIS NONSENSE AGAIN."
   - Old code checked if all required fields present → would return null
   - New code returns summary with whatever fields exist
5. Return `ParsedSummary` object

**Blocking Analysis:** ⚠️ MINIMAL BLOCKING (as of v4.2.5)
- `<skip_summary>` tag → Returns null (intentional, not a bug)
- Missing `<summary>` tags → Returns null (SDK didn't provide)
- Missing fields within `<summary>` → Does NOT block anymore (v4.2.5 fix)

**Value Assessment:** ✅ HIGH VALUE
- v4.2.5 fix ensures partial summaries are saved
- Keep as-is

**Historical Context:**
- **Before v4.2.5:** Would return null if any required field missing → data loss
- **After v4.2.5:** Returns summary with whatever fields exist → maximally permissive

**Edge Cases:**
1. `<skip_summary reason="not enough data"/>` → Returns null, logs reason
2. No `<summary>` tags → Returns null (SDK didn't generate summary)
3. `<summary>` with all empty fields → Returns summary with empty/null strings
4. Malformed XML → Regex won't match → Returns null (data loss)

**Example:**
```xml
<summary>
  <request>Add OAuth2 authentication</request>
  <investigated>Reviewed existing auth system</investigated>
  <learned>System uses JWT tokens for sessions</learned>
  <completed>Implemented OAuth2 provider integration</completed>
  <next_steps>Test with production credentials</next_steps>
  <notes>Need to configure callback URLs in provider dashboard</notes>
</summary>
```

---

## Deep Dive: Database Layer

### SessionStore.storeObservation (SessionStore.ts lines 901-964)

**Purpose:** Store a parsed observation in the database

**Logic Flow:**
1. **AUTO-CREATE SESSION** (lines 920-940):
   - Check if `sdk_session_id` exists in `sdk_sessions` table
   - If NOT found:
     - Auto-create session record
     - Log: "Auto-created session record for session_id: {id}"
   - This prevents foreign key constraint errors
2. Prepare INSERT statement:
   ```sql
   INSERT INTO observations
   (sdk_session_id, project, type, title, subtitle, facts, narrative,
    concepts, files_read, files_modified, prompt_number, created_at, created_at_epoch)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
   ```
3. Insert observation with:
   - `facts`, `concepts`, `files_read`, `files_modified` → JSON.stringify()
   - Timestamps auto-generated
   - All fields as-is (nulls allowed)

**Blocking Analysis:** ❌ NEVER BLOCKS
- Auto-creates missing sessions (defensive programming)
- All fields nullable (except required ones)
- No validation checks that could fail
- Schema is permissive

**Value Assessment:** ✅ HIGH VALUE
- Auto-creation pattern is brilliant
- Prevents foreign key errors
- Keep as-is

**Schema Constraints:**
- `type` must be one of 6 valid types (CHECK constraint)
  - BUT: Parser ensures type is always valid (defaults to "change")
- `sdk_session_id` has foreign key to `sdk_sessions`
  - BUT: Auto-creation ensures session exists
- Arrays stored as JSON strings

**Edge Cases:**
- Session doesn't exist → Auto-created
- Invalid type → Parser prevents this (defaults to "change")
- Null fields → Allowed by schema

---

### SessionStore.storeSummary (SessionStore.ts lines 970-1029)

**Purpose:** Store a parsed summary in the database

**Logic Flow:**
1. **AUTO-CREATE SESSION** (lines 987-1007):
   - Same defensive pattern as `storeObservation()`
   - Ensures session exists before INSERT
2. Prepare INSERT statement:
   ```sql
   INSERT INTO session_summaries
   (sdk_session_id, project, request, investigated, learned, completed,
    next_steps, notes, prompt_number, created_at, created_at_epoch)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
   ```
3. Insert summary with:
   - All content fields as-is (nulls allowed)
   - Timestamps auto-generated

**Blocking Analysis:** ❌ NEVER BLOCKS
- Auto-creates missing sessions
- All content fields nullable
- No validation checks
- Multiple summaries per session allowed (migration 7 removed UNIQUE constraint)

**Value Assessment:** ✅ HIGH VALUE
- Auto-creation ensures reliability
- Nullable fields allow partial data
- Keep as-is

**Schema Evolution:**
- **Before migration 7:** `sdk_session_id` had UNIQUE constraint → Only one summary per session
- **After migration 7:** UNIQUE removed → Multiple summaries per session (one per prompt)

**Edge Cases:**
- Session doesn't exist → Auto-created
- All fields null/empty → Allowed
- Multiple summaries for same session → Allowed (migration 7)

---

### Database Schema Constraints

#### observations table
```sql
CREATE TABLE observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sdk_session_id TEXT NOT NULL,  -- Foreign key
  project TEXT NOT NULL,
  text TEXT,  -- Nullable (deprecated, migration 9)
  type TEXT NOT NULL CHECK(type IN ('decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change')),
  title TEXT,  -- Nullable
  subtitle TEXT,  -- Nullable
  facts TEXT,  -- Nullable (JSON array)
  narrative TEXT,  -- Nullable
  concepts TEXT,  -- Nullable (JSON array)
  files_read TEXT,  -- Nullable (JSON array)
  files_modified TEXT,  -- Nullable (JSON array)
  prompt_number INTEGER,  -- Nullable
  created_at TEXT NOT NULL,
  created_at_epoch INTEGER NOT NULL,
  FOREIGN KEY(sdk_session_id) REFERENCES sdk_sessions(sdk_session_id) ON DELETE CASCADE
);
```

**Blocking Potential:**
- Invalid `type` → CHECK constraint violation
  - Mitigated by: Parser defaults to "change"
- Missing `sdk_session_id` → Foreign key violation
  - Mitigated by: Auto-creation in storeObservation()

#### session_summaries table
```sql
CREATE TABLE session_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sdk_session_id TEXT NOT NULL,  -- No longer UNIQUE (migration 7)
  project TEXT NOT NULL,
  request TEXT,  -- Nullable
  investigated TEXT,  -- Nullable
  learned TEXT,  -- Nullable
  completed TEXT,  -- Nullable
  next_steps TEXT,  -- Nullable
  notes TEXT,  -- Nullable
  prompt_number INTEGER,  -- Nullable
  created_at TEXT NOT NULL,
  created_at_epoch INTEGER NOT NULL,
  FOREIGN KEY(sdk_session_id) REFERENCES sdk_sessions(sdk_session_id) ON DELETE CASCADE
);
```

**Blocking Potential:**
- Missing `sdk_session_id` → Foreign key violation
  - Mitigated by: Auto-creation in storeSummary()

**Key Design Decisions:**
1. **Nullable fields** - Allows partial data to be saved
2. **Auto-creation** - Prevents foreign key errors
3. **No UNIQUE constraints** (migration 7) - Multiple summaries per session
4. **WAL mode** - Better concurrency for multiple sessions
5. **JSON arrays** - Flexible storage for lists (facts, concepts, files)

---

## Deep Dive: Prompt System

### buildInitPrompt (prompts.ts lines 24-125)

**Purpose:** Generate initial prompt that instructs the SDK agent what to observe and how to record

**Content:**
1. **Role Definition:** "You are observing a development session to create searchable memory FOR FUTURE SESSIONS"
2. **Critical Instruction:** "Record what was BUILT/FIXED/DEPLOYED/CONFIGURED, not what you (the observer) are doing"
3. **What to Record:** Focus on deliverables, capabilities, technical changes
4. **When to Skip:** Routine operations (empty status checks, package installations, file listings)
5. **Output Format:** XML structure with `<observation>` tags and required fields

**Blocking Analysis:** ⚠️ CAN CAUSE SKIPPING
- "WHEN TO SKIP" section instructs SDK to not output for routine operations
- "No output necessary if skipping" means no observations stored
- **This is intentional filtering**, not a bug

**Value Assessment:** ✅ HIGH VALUE
- Prevents noise from routine operations
- Focuses on meaningful changes
- Keep as-is, but consider making "WHEN TO SKIP" configurable

**Key Instructions:**
```
WHEN TO SKIP
------------
Skip routine operations:
- Empty status checks
- Package installations with no errors
- Simple file listings
- Repetitive operations you've already documented
- **No output necessary if skipping.**
```

**Impact:**
- Reduces database size by filtering noise
- But could cause "missing" observations for operations user cares about
- Trade-off between signal and completeness

---

### buildObservationPrompt (prompts.ts lines 130-153)

**Purpose:** Wrap tool execution data in XML for SDK processing

**Content:**
```xml
<tool_used>
  <tool_name>{name}</tool_name>
  <tool_time>{ISO timestamp}</tool_time>
  <tool_input>{JSON}</tool_input>
  <tool_output>{JSON}</tool_output>
</tool_used>
```

**Blocking Analysis:** ❌ NO BLOCKING
- Just data presentation, no instructions to skip
- SDK processes based on init prompt rules

**Value Assessment:** ✅ HIGH VALUE
- Simple, clean data wrapper
- Keep as-is

---

### buildSummaryPrompt (prompts.ts lines 158-178)

**Purpose:** Request summary of the session so far

**Content:**
1. **Instruction:** "Think about the last request, and write a summary of what was done, what was learned, and what's next"
2. **Important Note:** "DO NOT summarize the observation process itself - you are summarizing a DIFFERENT claude code session, not this one"
3. **Output Format:** XML `<summary>` with required fields
4. **Encouragement:** "Always write at least a minimal summary explaining where we are at currently, even if you didn't learn anything new or complete any work"

**Blocking Analysis:** ❌ NO BLOCKING
- Encourages always writing summary
- SDK may still skip if truly nothing to summarize

**Value Assessment:** ✅ HIGH VALUE
- Ensures summaries are generated
- "Always write at least a minimal summary" reduces skip rate
- Keep as-is

---

## Data Flow Analysis

### End-to-End Flow: Tool Execution → Database

```
1. User executes tool in Claude Code
   ↓
2. PostToolUse hook captures execution
   ↓
3. Hook sends HTTP POST to worker /observations endpoint
   ↓
4. Worker queues message in pendingMessages array
   └─→ HTTP 200 response (confirmed receipt)
   ↓
5. createMessageGenerator polls queue (100ms interval)
   ↓
6. Message shifted from queue
   ↓
7. buildObservationPrompt wraps tool data in XML
   ↓
8. Generator yields message to SDK agent
   ↓
9. SDK sends message to Claude API
   ↓
10. Claude processes tool data based on init prompt
    ↓
11. Claude responds with XML (or skips if routine operation)
    ↓
12. SDK returns response to runSDKAgent
    ↓
13. handleAgentMessage receives response
    ↓
14. parseObservations extracts <observation> blocks
    ↓
15. For each observation:
    - db.storeObservation called
    - Auto-creates session if missing
    - Inserts into observations table
    ↓
16. Data persisted in SQLite database
```

**Failure Points:**
- **Point 3:** Worker not running → HTTP request fails → Hook logs error
- **Point 4:** Worker crashes before processing → Queue lost
- **Point 9:** Invalid model config → SDK fails → Session marked failed
- **Point 11:** Malformed XML response → Parser returns empty array
- **Point 15:** Database error (rare) → Throws exception

**Recovery Mechanisms:**
- **Auto-recovery:** New requests after worker restart auto-create session
- **Graceful degradation:** Partial data saved (v4.2.5/v4.2.6 fixes)
- **Database persistence:** Once stored, data survives all restarts

---

## Blocking Assessment Matrix

### Components That CAN Block Data Storage

| Component | Blocking Scenario | Impact | Mitigation |
|-----------|------------------|---------|------------|
| Worker not running | HTTP requests fail | Observations not queued | PM2 auto-restart, health monitoring |
| Invalid CLAUDE_MEM_MODEL | SDK agent fails to start | Queued messages never processed | Validation in settings script |
| Invalid CLAUDE_CODE_PATH | SDK agent fails to start | Queued messages never processed | Default path, env var fallback |
| Malformed XML in SDK response | Parser can't extract | Data lost for that response | Better error handling, partial parsing |
| Worker restart | In-memory queue lost | Queued messages lost | Could persist queue to DB |
| Session abort (DELETE) | Queue processing stopped | Remaining queue lost | Graceful cleanup (v4.1.0) |
| Init prompt "WHEN TO SKIP" | SDK intentionally skips | No observation stored | Intentional filtering, configurable? |

### Components That CANNOT Block Data Storage

| Component | Reason | Design Pattern |
|-----------|--------|----------------|
| /observations endpoint | Auto-recovery, always queues | Maximally permissive |
| /summarize endpoint | Auto-recovery, always queues | Maximally permissive |
| parseObservations() | Defaults to "change" type, accepts nulls | Permissive (v4.2.6 fix) |
| parseSummary() | Returns partial summaries | Permissive (v4.2.5 fix) |
| storeObservation() | Auto-creates sessions, accepts nulls | Defensive programming |
| storeSummary() | Auto-creates sessions, accepts nulls | Defensive programming |
| Database schema | Nullable fields, no UNIQUE constraints | Flexible storage |

---

## Critical Findings

### 1. Auto-Recovery Pattern Prevents Worker Restart Data Loss

**Location:** `/observations` and `/summarize` endpoints (lines 181-209, 241-270)

**How it works:**
```typescript
if (!session) {
  // Fetch session from database
  const dbSession = db.getSessionById(sessionDbId);

  // Recreate in-memory state
  session = {
    sessionDbId,
    claudeSessionId: dbSession!.claude_session_id,
    sdkSessionId: null,
    project: dbSession!.project,
    userPrompt: dbSession!.user_prompt,
    pendingMessages: [],
    abortController: new AbortController(),
    generatorPromise: null,
    lastPromptNumber: 0,
    observationCounter: 0,
    startTime: Date.now()
  };

  // Start new SDK agent
  session.generatorPromise = this.runSDKAgent(session);
}
```

**Value:** ✅ HIGH
- Worker restart doesn't prevent new observations from being processed
- Database is source of truth
- Stateless design enables resilience

**Recommendation:** Extract to helper function to reduce duplication

---

### 2. Parser Fixes (v4.2.5/v4.2.6) Ensure Partial Data Saved

**parseObservations (v4.2.6):**
```typescript
// NOTE FROM THEDOTMACK: ALWAYS save observations - never skip. 10/24/2025
// All fields except type are nullable in schema
// If type is missing or invalid, use "change" as catch-all fallback

let finalType = 'change'; // Default catch-all
if (type && validTypes.includes(type.trim())) {
  finalType = type.trim();
}

// All other fields are optional - save whatever we have
observations.push({
  type: finalType,
  title,        // Can be null
  subtitle,     // Can be null
  facts,
  narrative,    // Can be null
  concepts,
  files_read,
  files_modified
});
```

**parseSummary (v4.2.5):**
```typescript
// NOTE FROM THEDOTMACK: 100% of the time we must SAVE the summary,
// even if fields are missing. 10/24/2025
// NEVER DO THIS NONSENSE AGAIN.

return {
  request,       // Can be null
  investigated,  // Can be null
  learned,       // Can be null
  completed,     // Can be null
  next_steps,    // Can be null
  notes          // Can be null
};
```

**Value:** ✅ CRITICAL
- Prevents data loss from incomplete AI responses
- LLMs make mistakes - system must be resilient
- Partial data is better than no data

**Recommendation:** Keep as-is, this is the right design

---

### 3. In-Memory Queue is Main Vulnerability

**Issue:** `pendingMessages` array is in-memory only
- Worker restart → All queued messages lost
- But HTTP response already confirmed receipt

**Current behavior:**
1. Hook sends observation → Worker responds "queued" → Hook thinks it's saved
2. Worker crashes before processing → Observation lost
3. BUT: New observations after restart are still processed (auto-recovery)

**Impact:** ⚠️ MEDIUM
- Data loss window between queue and processing
- But observations are idempotent (can be resent)
- Hooks don't retry on success response

**Recommendation:** ⚠️ CONSIDER
- Persist queue to database (e.g., `pending_observations` table)
- Mark as processed when SDK handles
- Increases reliability but adds complexity

---

### 4. Init Prompt "WHEN TO SKIP" Intentionally Filters

**Instruction:**
```
WHEN TO SKIP
------------
Skip routine operations:
- Empty status checks
- Package installations with no errors
- Simple file listings
- Repetitive operations you've already documented
- **No output necessary if skipping.**
```

**Impact:**
- Reduces noise in database
- Focuses on meaningful changes
- BUT: User might wonder why some tool executions aren't recorded

**Value:** ✅ MEDIUM - Intentional filtering
- Prevents database bloat
- Trade-off between signal and completeness

**Recommendation:** ⚠️ CONSIDER
- Make "WHEN TO SKIP" configurable (env var or settings)
- Or add verbosity levels (minimal/normal/verbose)

---

## Value Assessment by Component

### HIGH VALUE - Keep As-Is

| Component | Reason |
|-----------|--------|
| Auto-recovery pattern | Prevents worker restart data loss |
| Permissive parser (v4.2.5/v4.2.6) | Ensures partial data saved, critical for reliability |
| Nullable database schema | Flexible storage, allows incomplete data |
| WAL mode SQLite | Good concurrency, reliable writes |
| Isolated session state | No cross-contamination between sessions |
| Queue-based architecture | Decouples HTTP from SDK processing |
| storeObservation/storeSummary auto-creation | Defensive programming, prevents foreign key errors |

### MEDIUM VALUE - Consider Improvements

| Component | Current State | Potential Improvement |
|-----------|--------------|----------------------|
| In-memory queue | Lost on restart | Persist to DB for durability |
| 100ms polling | Works but inefficient | Event-driven async queue |
| Duplicated auto-recovery code | Lines 181-209 and 241-270 identical | Extract to `getOrCreateSession()` helper |
| No try-catch around DB ops | Errors crash handler | Add error handling with logging |
| Model/port defaults | Hard-coded | Already configurable via env vars ✓ |
| Init prompt filtering | Fixed "WHEN TO SKIP" rules | Make configurable (verbosity levels) |

### LOW VALUE - Questionable Design

| Component | Issue | Recommendation |
|-----------|-------|----------------|
| cleanupOrphanedSessions() | Marks ALL active sessions failed on startup | Aggressive, but necessary with fixed port |
| 5-second DELETE timeout | Arbitrary | Make configurable via env var |
| "NO SUMMARY TAGS FOUND" warning | Log level too high | Change to INFO level |

---

## Recommendations

### Priority 1: Critical Reliability Improvements

1. **Persist Message Queue to Database**
   - Create `pending_messages` table
   - Store queued observations/summaries
   - Mark as processed when handled by SDK
   - Prevents data loss on worker restart
   - **Effort:** Medium, **Impact:** High

2. **Add Error Handling Around Database Operations**
   - Wrap `db.storeObservation()` and `db.storeSummary()` in try-catch
   - Log errors with full context
   - Continue processing other messages on error
   - **Effort:** Low, **Impact:** Medium

### Priority 2: Code Quality Improvements

3. **Extract Auto-Recovery to Helper Function**
   ```typescript
   private async getOrCreateSession(sessionDbId: number): Promise<ActiveSession> {
     // Consolidate lines 181-209 and 241-270
   }
   ```
   - **Effort:** Low, **Impact:** Low (code quality)

4. **Make Configuration More Flexible**
   - Add `CLAUDE_MEM_VERBOSITY` env var (minimal/normal/verbose)
   - Adjust init prompt "WHEN TO SKIP" based on verbosity
   - Add `CLAUDE_MEM_DELETE_TIMEOUT` env var
   - **Effort:** Low, **Impact:** Medium

### Priority 3: Performance Optimizations

5. **Replace Polling with Event-Driven Queue**
   - Use `AsyncQueue` with notifications instead of 100ms polling
   - Reduces latency from queue to processing
   - **Effort:** Medium, **Impact:** Low (performance)

6. **Add Queue Metrics**
   - Track queue length over time
   - Alert if queue grows unbounded
   - Add to `/health` endpoint
   - **Effort:** Low, **Impact:** Low (observability)

---

## Appendix: Configuration Reference

### Environment Variables

| Variable | Default | Purpose | Blocking Impact |
|----------|---------|---------|----------------|
| `CLAUDE_MEM_MODEL` | `claude-sonnet-4-5` | AI model for processing | Invalid = SDK fails |
| `CLAUDE_MEM_WORKER_PORT` | `37777` | HTTP server port | Invalid = Worker won't start |
| `CLAUDE_CODE_PATH` | `/Users/alexnewman/.nvm/versions/node/v24.5.0/bin/claude` | Path to Claude Code | Invalid = SDK fails |

### Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| `DISALLOWED_TOOLS` | `['Glob', 'Grep', 'ListMcpResourcesTool', 'WebSearch']` | Tools SDK agent can't use |
| Polling interval | `100ms` | Queue polling frequency |
| DELETE timeout | `5000ms` | Max wait for agent shutdown |

---

## Conclusion

The claude-mem worker server is a well-designed system with a clear **defensive, layered architecture** that prioritizes **data persistence**. The key strengths are:

1. **Auto-recovery** from worker restarts
2. **Permissive parsing** that saves partial data
3. **Nullable schema** that accepts incomplete information
4. **Session isolation** preventing cross-contamination

The main vulnerability is the **in-memory queue**, which could be mitigated by persisting to the database. Overall, the system achieves its goal of creating a persistent memory system that survives failures and continues operating even with incomplete data.

**Design Philosophy:** "Better to save partial data than lose everything."

This philosophy is evident throughout the codebase, from the v4.2.5/v4.2.6 parser fixes to the auto-creation patterns in the database layer. The system is built to be resilient to AI errors, configuration issues, and process failures.

---

**End of Document**
