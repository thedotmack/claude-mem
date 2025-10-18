# Recommended Prompt Flow (Hybrid System)

## Design Principles

1. **Be Selective**: Quality over quantity - only store meaningful insights
2. **Hierarchical Storage**: Multiple levels for granular retrieval
3. **Clear Guidance**: No ambiguous language like "MOST"
4. **Structured Data**: XML format with clear schema
5. **Session Tracking**: Title + subtitle per session
6. **Per-Prompt Context**: Track which observations came from which user request

---

## Flow Timeline

### 1. SESSION START

**Trigger**: Claude Code session starts
**Hook**: `user-prompt-submit` (context-hook.js)

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
Process tool executions from this Claude Code session and store important observations.

Be selective. Only store observations when the tool output reveals important information about:
- Architecture or design patterns
- Implementation details of features or bug fixes
- System state or configuration
- Business logic or algorithms

Skip routine operations like:
- Empty git status checks
- Simple npm install output
- Trivial config changes
- Repetitive operations

OBSERVATION FORMAT
------------------
When you identify something worth remembering, output this XML structure:

```xml
<observation>
  <type>feature</type>
  <title>Short Title (3-8 words)</title>
  <subtitle>Concise summary explaining the significance (max 24 words)</subtitle>
  <facts>
    <fact>Specific detail 1 (50-150 chars, self-contained)</fact>
    <fact>Specific detail 2 (50-150 chars, self-contained)</fact>
    <fact>Specific detail 3 (50-150 chars, self-contained)</fact>
  </facts>
  <narrative>Full context: what was done, why it matters, how it works. (200-400 words)</narrative>
  <concepts>
    <concept>broad-category-1</concept>
    <concept>broad-category-2</concept>
  </concepts>
  <files>
    <file>path/to/file1.ts</file>
    <file>path/to/file2.ts</file>
  </files>
</observation>
```

FIELD REQUIREMENTS
------------------

**Type**: One of: decision, bugfix, feature, refactor, discovery

**Title**: 3-8 words capturing the core action
- Examples: "JWT Refresh Token Implementation", "Race Condition Fix in Auth Middleware"

**Subtitle**: Max 24 words explaining the significance
- Focus on outcome or benefit
- Examples: "Added 7-day refresh token rotation with Redis storage for secure long-lived sessions"

**Facts**: 3-7 atomic facts (50-150 chars each)
- Each fact is ONE specific piece of information
- Include filename/component when relevant
- No pronouns - each fact stands alone
- Examples:
  - "src/auth.ts: refreshToken() generates new JWT with 7-day expiry"
  - "Redis key format: refresh:{userId}:{tokenId} with TTL 604800s"
  - "Old token invalidated on refresh to prevent replay attacks"

**Narrative**: Full story (200-400 words)
- What was done
- Technical details (files, functions, implementation)
- Why it matters

**Concepts**: 2-5 broad categories for filtering
- Examples: "authentication", "caching", "error-handling"

**Files**: All files touched
- Full relative paths from project root

Ready to process tool executions.
```

---

### 2. TOOL EXECUTION

**Trigger**: Each tool execution
**Hook**: `user-prompt-submit` (context-hook.js)

**Observation Prompt Sent to SDK**:
```
TOOL OBSERVATION
================
Tool: {tool_name}
Time: {timestamp}
Prompt: {prompt_number}

Input:
{tool_input JSON}

Output:
{tool_output JSON}

Analyze this tool output. If it reveals important information about the codebase, generate an observation using the XML format from the init prompt.
```

**SDK Response Processing**:
1. SDK agent analyzes output
2. If meaningful, generates `<observation>` XML block
3. Worker parses XML and stores in SQLite
4. Links to `prompt_number` for per-request tracking

**Database Schema**:
```sql
CREATE TABLE observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sdk_session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  prompt_number INTEGER NOT NULL,

  -- Core fields
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  subtitle TEXT NOT NULL,
  narrative TEXT NOT NULL,

  -- Arrays (stored as JSON)
  facts TEXT NOT NULL,      -- JSON array of strings
  concepts TEXT NOT NULL,   -- JSON array of strings
  files TEXT NOT NULL,      -- JSON array of strings

  created_at INTEGER NOT NULL,

  FOREIGN KEY(sdk_session_id) REFERENCES sdk_sessions(sdk_session_id) ON DELETE CASCADE
);

-- Indexes for fast retrieval
CREATE INDEX idx_observations_session ON observations(sdk_session_id);
CREATE INDEX idx_observations_type ON observations(type);
CREATE INDEX idx_observations_prompt ON observations(prompt_number);
```

---

### 3. SESSION END

**Trigger**: Claude Code session ends
**Hook**: `session-end` (cleanup-hook.js)

**Finalize Prompt Sent to SDK**:
```
SESSION ENDING
==============
The Claude Code session is completing.

FINAL TASK
----------
Review all observations you've generated and create a session summary.

Output this XML structure:

```xml
<summary>
  <request>What did the user request?</request>
  <investigated>What code/systems did you explore?</investigated>
  <learned>What did you learn about the codebase?</learned>
  <completed>What was accomplished?</completed>
  <next_steps>What should happen next?</next_steps>
  <files_read>
    <file>path/to/file1.ts</file>
    <file>path/to/file2.ts</file>
  </files_read>
  <files_edited>
    <file>path/to/file3.ts</file>
  </files_edited>
  <notes>Additional context or insights</notes>
</summary>
```

Be concise but comprehensive. Focus on semantic insights, not mechanical details.
```

**Database Schema**:
```sql
CREATE TABLE session_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sdk_session_id TEXT NOT NULL,
  project TEXT NOT NULL,

  request TEXT NOT NULL,
  investigated TEXT NOT NULL,
  learned TEXT NOT NULL,
  completed TEXT NOT NULL,
  next_steps TEXT NOT NULL,
  files_read TEXT NOT NULL,   -- JSON array
  files_edited TEXT NOT NULL, -- JSON array
  notes TEXT NOT NULL,

  created_at INTEGER NOT NULL,

  FOREIGN KEY(sdk_session_id) REFERENCES sdk_sessions(sdk_session_id) ON DELETE CASCADE
);
```

---

## Data Retrieval Patterns

### Level 1: Session Titles (High-Level Browsing)
```sql
SELECT
  sdk_session_id,
  user_prompt as title,
  created_at
FROM sdk_sessions
WHERE project = ?
ORDER BY created_at DESC;
```

### Level 2: Session Summaries (Session Overview)
```sql
SELECT
  request,
  completed,
  next_steps
FROM session_summaries
WHERE sdk_session_id = ?;
```

### Level 3: Observation Titles (Scannable List)
```sql
SELECT
  type,
  title,
  subtitle
FROM observations
WHERE sdk_session_id = ?
ORDER BY id;
```

### Level 4: Atomic Facts (Precise Search)
```sql
SELECT
  title,
  facts
FROM observations
WHERE
  sdk_session_id = ?
  AND facts LIKE '%keyword%';
```

### Level 5: Full Narrative (Deep Dive)
```sql
SELECT
  title,
  subtitle,
  facts,
  narrative,
  files
FROM observations
WHERE id = ?;
```

### By Concept (Category Filter)
```sql
SELECT
  title,
  subtitle,
  concepts
FROM observations
WHERE concepts LIKE '%"authentication"%';
```

### By File (File-Based Search)
```sql
SELECT
  title,
  subtitle,
  files
FROM observations
WHERE files LIKE '%src/auth.ts%';
```

---

## Future Enhancements

### Phase 2: Semantic Search
- Add vector embeddings for facts and narratives
- Store in ChromaDB or similar
- Enable similarity search: "Find observations about authentication patterns"

### Phase 3: Cross-Session Memory
- Link related observations across sessions
- "Show all JWT-related observations from past 30 days"

### Phase 4: Session Metadata
- Add title/subtitle to sdk_sessions table
- Auto-generate from user_prompt or first summary

---

## Migration from Current System

### Step 1: Update Database Schema
```sql
-- Add new columns to observations table
ALTER TABLE observations ADD COLUMN title TEXT;
ALTER TABLE observations ADD COLUMN subtitle TEXT;
ALTER TABLE observations ADD COLUMN narrative TEXT;
ALTER TABLE observations ADD COLUMN facts TEXT;
ALTER TABLE observations ADD COLUMN concepts TEXT;
ALTER TABLE observations ADD COLUMN files TEXT;

-- Migrate existing observations (best-effort)
UPDATE observations
SET
  title = type || ' - ' || substr(text, 1, 50),
  subtitle = text,
  narrative = text,
  facts = '[]',
  concepts = '[]',
  files = '[]'
WHERE title IS NULL;
```

### Step 2: Update Prompts
- Replace `buildInitPrompt()` with new version (no "MOST")
- Replace `buildObservationPrompt()` with new version (no tool-type bias)
- Keep `buildFinalizePrompt()` mostly as-is

### Step 3: Update Parser
- Extend `parseObservations()` to extract all new fields
- Add `extractFactArray()`, `extractConceptArray()`, `extractFileArray()` helpers
- Keep backward compatibility with old one-sentence format

### Step 4: Update Storage
- Modify `HooksDatabase.storeObservation()` to accept all fields
- Store arrays as JSON strings

---

## Key Improvements Over Current System

1. ✅ **No "MOST" ambiguity** - Clear "be selective" guidance
2. ✅ **No tool-type bias** - Observation prompt doesn't mention tool names
3. ✅ **Hierarchical storage** - Title → Subtitle → Facts → Narrative
4. ✅ **Atomic facts** - Precise, searchable details
5. ✅ **File associations** - Track which files each observation relates to
6. ✅ **Concept tagging** - Categorical organization
7. ✅ **Rich narratives** - Full context for deep dives
8. ✅ **Multiple retrieval levels** - Can search at any granularity

---

## Key Improvements Over Old System

1. ✅ **No bash commands** - XML parsing instead of shell execution
2. ✅ **Auto-increment IDs** - No manual counter tracking
3. ✅ **Per-prompt tracking** - `prompt_number` links observations to requests
4. ✅ **Foreign key integrity** - Automatic cascade deletes
5. ✅ **No quote escaping hell** - JSON arrays instead of bash arguments
6. ✅ **Structured typing** - Typed observations (decision/bugfix/feature/refactor/discovery)
7. ✅ **Session summary at end** - Not just 2-3 sentences, but full structured summary
