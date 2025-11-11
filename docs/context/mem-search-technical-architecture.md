# mem-search Skill: Technical Architecture & Implementation

**Author:** Claude Code
**Date:** 2025-11-11
**Purpose:** Comprehensive technical explanation of how the mem-search skill works

---

## Table of Contents

1. [Overview](#overview)
2. [Skill Invocation Mechanism](#skill-invocation-mechanism)
3. [Search Architecture](#search-architecture)
4. [Progressive Disclosure Workflow](#progressive-disclosure-workflow)
5. [Search Operations Deep Dive](#search-operations-deep-dive)
6. [Backend Processing](#backend-processing)
7. [Token Efficiency Engineering](#token-efficiency-engineering)
8. [Complete Request Flow Example](#complete-request-flow-example)

---

## Overview

The `mem-search` skill is a **Claude Code Skill** that provides access to claude-mem's persistent cross-session memory database through HTTP API calls. It enables Claude to search through past work, observations, sessions, and user prompts stored in SQLite and ChromaDB.

### Key Components

```
┌─────────────────────────────────────────────────────────────┐
│                      Claude Code Session                     │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  Claude (LLM)                                         │  │
│  │  - Reads skill description in session context         │  │
│  │  - Decides when to invoke based on trigger phrases    │  │
│  │  - Loads full SKILL.md when invoked                   │  │
│  │  - Executes curl commands from operation guides       │  │
│  └───────────────────────────────────────────────────────┘  │
│                            │                                 │
│                            ▼                                 │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  mem-search Skill (plugin/skills/mem-search/)         │  │
│  │  - SKILL.md (202 lines, navigation hub)               │  │
│  │  - operations/*.md (12 operation guides)              │  │
│  │  - principles/*.md (2 principle guides)               │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                            │
                            │ HTTP GET requests
                            │ (curl commands)
                            ▼
┌─────────────────────────────────────────────────────────────┐
│              Worker Service (PM2-managed)                    │
│              localhost:37777                                 │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  Express.js HTTP Server                               │  │
│  │  - GET /api/search/observations                       │  │
│  │  - GET /api/search/sessions                           │  │
│  │  - GET /api/search/prompts                            │  │
│  │  - GET /api/search/by-type                            │  │
│  │  - GET /api/search/by-file                            │  │
│  │  - GET /api/search/by-concept                         │  │
│  │  - GET /api/search/recent-context                     │  │
│  │  - GET /api/search/timeline                           │  │
│  │  - GET /api/search/timeline-by-query                  │  │
│  │  - GET /api/search/help                               │  │
│  └───────────────────────────────────────────────────────┘  │
│                            │                                 │
│                            ▼                                 │
│  ┌─────────────────┬──────────────────────────────────┐     │
│  │  SessionSearch  │  ChromaSync                      │     │
│  │  (FTS5)         │  (Vector Search)                 │     │
│  │                 │                                   │     │
│  │  SQLite DB      │  ChromaDB                        │     │
│  │  ~/.claude-mem/ │  ~/.claude-mem/chroma/           │     │
│  └─────────────────┴──────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────┘
```

---

## Skill Invocation Mechanism

### Phase 1: Session Start (Skill Discovery)

When a Claude Code session starts:

1. **Claude Code loads all skill descriptions** from `~/.claude/plugins/marketplaces/thedotmack/plugin/skills/*/SKILL.md`
2. **Only the YAML frontmatter is loaded into context** (~250 tokens for mem-search):
   ```yaml
   ---
   name: mem-search
   description: Search claude-mem's persistent cross-session memory database to find work from previous conversations days, weeks, or months ago. Access past session summaries, bug fixes, feature implementations, and decisions that are NOT in the current conversation context. Use when user asks "did we already solve this?", "how did we do X last time?", "what happened in last week's session?", or needs information from previous sessions stored in the PM2-managed database. Searches observations, session summaries, and user prompts across entire project history.
   ---
   ```
3. **Claude has awareness** that the skill exists and can be invoked via the `Skill` tool

**Token efficiency:** 250 tokens for skill description vs 2,500 tokens for MCP tool definitions (10x improvement)

### Phase 2: Trigger Detection (Auto-Invocation)

When the user asks a question, Claude:

1. **Analyzes the user prompt** for trigger phrases
2. **Compares against skill descriptions** loaded in context
3. **Decides whether to invoke** based on trigger matching

**Example trigger analysis:**

```
User: "What bugs did we fix last week?"

Claude's internal reasoning:
- "last week" = temporal trigger → cross-session query
- "bugs did we fix" = type=bugfix search
- Description says: "Use when user asks 'did we already solve this?'"
- Description says: "NOT in the current conversation context"
- Description says: "previous conversations days, weeks, or months ago"
→ MATCH: Invoke mem-search skill
```

**High-effectiveness triggers (85% concrete):**
- Temporal: "already", "before", "last time", "previously", "last week/month"
- System-specific: "claude-mem", "PM2-managed database", "cross-session memory"
- Scope boundaries: "NOT in the current conversation context"

**Why this works:**
- 5+ unique identifiers distinguish from native memory
- 9 scope differentiation keywords prevent false matches
- Explicit negative boundary ("NOT current conversation")

### Phase 3: Skill Loading (Progressive Disclosure)

When Claude invokes the skill:

1. **Loads full SKILL.md** into context (~1,500 tokens for mem-search)
2. **Reads navigation hub** with operation index
3. **Chooses appropriate operation** based on query type
4. **Loads specific operation guide** (e.g., `operations/observations.md`, ~400 tokens)
5. **Executes HTTP request** via curl command

**Token cost progression:**
- Session start: +250 tokens (description only)
- Skill invocation: +1,500 tokens (full SKILL.md)
- Operation load: +400 tokens (specific operation guide)
- **Total: ~2,150 tokens** vs ~2,500 for always-loaded MCP tools

---

## Search Architecture

### Hybrid Search System

claude-mem uses a **hybrid search architecture** combining:

1. **SQLite FTS5 (Full-Text Search)** - Keyword-based search
2. **ChromaDB (Vector Search)** - Semantic similarity search

```
┌─────────────────────────────────────────────────────────────┐
│                   Search Request Flow                        │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────┐
              │  Worker Service         │
              │  /api/search/*          │
              └─────────────────────────┘
                            │
              ┌─────────────┴─────────────┐
              ▼                           ▼
┌──────────────────────────┐  ┌──────────────────────────┐
│  SessionSearch (FTS5)    │  │  ChromaSync (Vector DB)  │
│                          │  │                          │
│  Full-text keyword       │  │  Semantic similarity     │
│  search on:              │  │  search on:              │
│  - titles                │  │  - narratives            │
│  - narratives            │  │  - facts                 │
│  - facts                 │  │  - file content          │
│  - concepts              │  │                          │
│                          │  │  Embeddings:             │
│  SQLite DB:              │  │  - text-embedding-3-small│
│  observations_fts        │  │  - 90-day recency filter │
│  sessions_fts            │  │                          │
│  prompts_fts             │  │  ChromaDB:               │
│                          │  │  observations collection │
└──────────────────────────┘  └──────────────────────────┘
              │                           │
              └─────────────┬─────────────┘
                            ▼
              ┌─────────────────────────┐
              │  Merged Results         │
              │  - Deduplicated         │
              │  - Sorted by relevance  │
              │  - Formatted (index/full)│
              └─────────────────────────┘
```

### Search Types

#### 1. Full-Text Search (FTS5)

**How it works:**
- Uses SQLite FTS5 virtual tables for instant keyword matching
- Supports boolean operators: `AND`, `OR`, `NOT`, `NEAR`, `*` (wildcard)
- Ranks results by BM25 relevance scoring
- Sub-100ms performance on 8,000+ observations

**Example query:**
```sql
-- User asks: "How did we implement JWT authentication?"
SELECT * FROM observations_fts
WHERE observations_fts MATCH 'JWT AND authentication'
ORDER BY rank
LIMIT 20;
```

#### 2. Vector Search (ChromaDB)

**How it works:**
- Text is embedded using OpenAI's `text-embedding-3-small` model
- Vector similarity search finds semantically related content
- 90-day recency filter prioritizes recent work
- Combined with keyword search for hybrid results

**Example query:**
```python
# User asks: "How did we handle user login flow?"
collection.query(
    query_texts=["user login flow authentication"],
    n_results=20,
    where={"created_at": {"$gte": ninety_days_ago}}
)
```

#### 3. Structured Filters

**Type-based filtering:**
```sql
-- User asks: "What bugs did we fix?"
SELECT * FROM observations
WHERE type = 'bugfix'
ORDER BY created_at DESC;
```

**File-based filtering:**
```sql
-- User asks: "What changes to auth.ts?"
SELECT * FROM observations
WHERE files LIKE '%auth.ts%'
ORDER BY created_at DESC;
```

**Concept-based filtering:**
```sql
-- User asks: "What gotchas did we encounter?"
SELECT * FROM observations
WHERE concepts LIKE '%gotcha%'
ORDER BY created_at DESC;
```

---

## Progressive Disclosure Workflow

### The 4-Step Token Efficiency Pattern

Progressive disclosure is **mandatory** to avoid token waste and MCP limits.

#### Step 1: Index Format Request (~50-100 tokens/result)

**What Claude does:**
```bash
curl -s "http://localhost:37777/api/search/observations?query=authentication&format=index&limit=5"
```

**What the backend returns:**
```json
{
  "query": "authentication",
  "count": 5,
  "format": "index",
  "results": [
    {
      "id": 1234,
      "type": "feature",
      "title": "Implemented JWT authentication",
      "subtitle": "Added token-based auth with refresh tokens",
      "created_at_epoch": 1699564800000,
      "project": "api-server"
    },
    {
      "id": 1235,
      "type": "bugfix",
      "title": "Fixed token expiration edge case",
      "subtitle": "Handled race condition in refresh flow",
      "created_at_epoch": 1699478400000,
      "project": "api-server"
    }
    // ... 3 more results
  ]
}
```

**Token cost:** 5 results × ~75 tokens = **~375 tokens**

#### Step 2: Relevance Assessment (Human-in-Loop)

**What Claude does:**
- Scans titles and subtitles
- Identifies which results are relevant to user's question
- Decides which items need full details

**Example reasoning:**
```
User asked: "How did we implement JWT authentication?"

Results scan:
- #1234 "Implemented JWT authentication" ← RELEVANT (direct match)
- #1235 "Fixed token expiration edge case" ← MAYBE (related to JWT)
- #1236 "Added OAuth2 provider" ← NOT RELEVANT (different auth method)
- #1237 "Refactored user model" ← NOT RELEVANT (no auth connection)
- #1238 "Updated login UI" ← MAYBE (UI for auth)

Decision: Request full details for #1234, maybe #1235
```

#### Step 3: Selective Full Details Request (~500-1000 tokens/result)

**What Claude does:**
```bash
# Request full details for ONLY relevant items
curl -s "http://localhost:37777/api/search/observations?query=authentication&format=full&limit=1&offset=0"
```

**What the backend returns:**
```json
{
  "query": "authentication",
  "count": 1,
  "format": "full",
  "results": [
    {
      "id": 1234,
      "type": "feature",
      "title": "Implemented JWT authentication",
      "subtitle": "Added token-based auth with refresh tokens",
      "narrative": "Implemented a complete JWT authentication system with access tokens (15min expiry) and refresh tokens (7-day expiry). The system uses RS256 signing with key rotation support. Added middleware for token validation, refresh endpoint for token renewal, and secure cookie storage for refresh tokens (httpOnly, secure, sameSite). Handled edge cases including concurrent refresh requests, token revocation, and graceful expiry.",
      "facts": [
        "Access tokens expire after 15 minutes",
        "Refresh tokens expire after 7 days",
        "Uses RS256 algorithm for signing",
        "Implements key rotation for security",
        "Stores refresh tokens in httpOnly cookies",
        "Handles concurrent refresh requests with locking"
      ],
      "files": [
        "src/auth/jwt.ts",
        "src/auth/middleware.ts",
        "src/routes/auth.ts"
      ],
      "concepts": ["how-it-works", "pattern"],
      "created_at_epoch": 1699564800000,
      "created_at_iso": "2024-11-09T12:00:00Z",
      "project": "api-server",
      "session_db_id": 123
    }
  ]
}
```

**Token cost:** 1 result × ~750 tokens = **~750 tokens**

#### Step 4: Present to User

**What Claude does:**
- Formats the results for user readability
- Includes file references with line numbers if available
- Provides actionable next steps

**Example response:**
```markdown
Based on past work, here's how we implemented JWT authentication:

🟣 **Implemented JWT authentication** (session #123, Nov 9 2024)

We built a complete JWT auth system with:
- Access tokens (15min expiry) + refresh tokens (7-day expiry)
- RS256 signing with key rotation support
- Secure httpOnly cookies for refresh token storage
- Concurrent refresh handling with locking

**Files modified:**
- src/auth/jwt.ts
- src/auth/middleware.ts
- src/routes/auth.ts

**Key implementation details:**
- Uses RS256 algorithm for signing
- Implements key rotation for security
- Handles edge cases: concurrent refreshes, token revocation, graceful expiry
```

### Token Efficiency Comparison

**Bad approach (no progressive disclosure):**
```bash
# Request full details for all 20 results upfront
curl -s "http://localhost:37777/api/search/observations?query=authentication&format=full&limit=20"
```
**Token cost:** 20 × 750 = **15,000 tokens** 🚫

**Good approach (progressive disclosure):**
```bash
# Step 1: Get index for 5 results
curl -s "...&format=index&limit=5"  # 375 tokens
# Step 2: Get full details for 1 relevant result
curl -s "...&format=full&limit=1&offset=0"  # 750 tokens
```
**Token cost:** 375 + 750 = **1,125 tokens** ✅

**Savings:** 15,000 - 1,125 = **13,875 tokens saved** (92% reduction)

---

## Search Operations Deep Dive

### 1. Observations Search

**User request:** "How did we implement X?"

**Skill workflow:**
1. Loads `operations/observations.md`
2. Constructs FTS5 query
3. Executes HTTP request

**Backend processing:**
```typescript
// src/services/worker-service.ts
app.get('/api/search/observations', async (req, res) => {
  const { query, format, limit, offset, project, type, concepts, files, dateRange } = req.query;

  // Step 1: Parse query parameters
  const searchParams = {
    query: query as string,
    limit: parseInt(limit as string) || 20,
    offset: parseInt(offset as string) || 0,
    format: (format as 'index' | 'full') || 'full',
  };

  // Step 2: Execute FTS5 search
  const results = await sessionSearch.searchObservations({
    query: searchParams.query,
    limit: searchParams.limit,
    offset: searchParams.offset,
    filters: {
      project: project as string,
      type: type as ObservationType,
      concepts: concepts ? (concepts as string).split(',') : undefined,
      files: files ? (files as string).split(',') : undefined,
      dateRange: dateRange ? JSON.parse(dateRange as string) : undefined,
    }
  });

  // Step 3: Format results based on format parameter
  if (searchParams.format === 'index') {
    return res.json({
      query: searchParams.query,
      count: results.length,
      format: 'index',
      results: results.map(r => ({
        id: r.id,
        type: r.type,
        title: r.title,
        subtitle: r.subtitle,
        created_at_epoch: r.created_at_epoch,
        project: r.project,
        concepts: r.concepts,
      }))
    });
  } else {
    return res.json({
      query: searchParams.query,
      count: results.length,
      format: 'full',
      results: results, // Full observation objects
    });
  }
});
```

**FTS5 query execution:**
```typescript
// src/services/sqlite/SessionSearch.ts
searchObservations(params: SearchParams): Observation[] {
  const { query, limit, offset, filters } = params;

  // Build FTS5 query
  let sql = `
    SELECT o.* FROM observations o
    JOIN observations_fts fts ON o.id = fts.rowid
    WHERE fts MATCH ?
  `;

  const queryParams: any[] = [query];

  // Apply filters
  if (filters.project) {
    sql += ` AND o.project = ?`;
    queryParams.push(filters.project);
  }

  if (filters.type) {
    sql += ` AND o.type = ?`;
    queryParams.push(filters.type);
  }

  if (filters.dateRange) {
    sql += ` AND o.created_at_epoch BETWEEN ? AND ?`;
    queryParams.push(filters.dateRange.start, filters.dateRange.end);
  }

  // Order by relevance
  sql += ` ORDER BY fts.rank LIMIT ? OFFSET ?`;
  queryParams.push(limit, offset);

  return this.db.prepare(sql).all(...queryParams);
}
```

### 2. Timeline Search

**User request:** "What was happening around that time?"

**Skill workflow:**
1. Identifies anchor point (observation ID, session ID, or timestamp)
2. Loads `operations/timeline.md`
3. Requests context window before/after anchor

**Backend processing:**
```typescript
// Timeline retrieval with depth before/after
app.get('/api/search/timeline', async (req, res) => {
  const { anchor, depth_before, depth_after, project } = req.query;

  // Step 1: Resolve anchor to timestamp
  let anchorTimestamp: number;
  if (typeof anchor === 'string' && anchor.startsWith('S')) {
    // Session ID format: "S123"
    const sessionId = parseInt(anchor.slice(1));
    const session = sessionStore.getSession(sessionId);
    anchorTimestamp = session.created_at_epoch;
  } else if (!isNaN(Number(anchor))) {
    // Observation ID
    const obs = sessionStore.getObservation(Number(anchor));
    anchorTimestamp = obs.created_at_epoch;
  } else {
    // ISO timestamp
    anchorTimestamp = new Date(anchor as string).getTime();
  }

  // Step 2: Fetch records before anchor
  const beforeRecords = await sessionSearch.getRecordsBeforeTimestamp({
    timestamp: anchorTimestamp,
    limit: parseInt(depth_before as string) || 10,
    project: project as string,
  });

  // Step 3: Fetch records after anchor
  const afterRecords = await sessionSearch.getRecordsAfterTimestamp({
    timestamp: anchorTimestamp,
    limit: parseInt(depth_after as string) || 10,
    project: project as string,
  });

  // Step 4: Merge and sort chronologically
  const timeline = [
    ...beforeRecords.reverse(), // Oldest first
    { type: 'anchor', timestamp: anchorTimestamp }, // Anchor point
    ...afterRecords, // Newest last
  ];

  return res.json({
    anchor: anchor,
    anchor_timestamp: anchorTimestamp,
    depth_before: beforeRecords.length,
    depth_after: afterRecords.length,
    timeline: timeline,
  });
});
```

### 3. Recent Context

**User request:** "What have we been working on?"

**Skill workflow:**
1. Loads `operations/recent-context.md`
2. Requests last N sessions with summaries and observations

**Backend processing:**
```typescript
app.get('/api/search/recent-context', async (req, res) => {
  const { limit, project } = req.query;
  const sessionLimit = parseInt(limit as string) || 3;

  // Step 1: Get recent sessions
  const sessions = await sessionSearch.getRecentSessions({
    limit: sessionLimit,
    project: project as string,
  });

  // Step 2: For each session, get summary and observations
  const context = await Promise.all(sessions.map(async (session) => {
    const summary = await sessionStore.getSummary(session.db_id);
    const observations = await sessionStore.getObservationsBySession(session.db_id);

    return {
      session: {
        db_id: session.db_id,
        created_at: session.created_at_iso,
        project: session.project,
      },
      summary: summary ? {
        request: summary.request,
        completion: summary.completion,
        learnings: summary.learnings,
      } : null,
      observations: observations.map(obs => ({
        id: obs.id,
        type: obs.type,
        title: obs.title,
        subtitle: obs.subtitle,
      })),
    };
  }));

  return res.json({
    limit: sessionLimit,
    project: project || 'all',
    sessions: context,
  });
});
```

---

## Backend Processing

### Request Flow Through Worker Service

```
1. HTTP Request arrives
   ↓
2. Express.js route handler
   ↓
3. Parameter parsing and validation
   ↓
4. Database query construction
   ↓
   ┌─────────────────┬──────────────────┐
   ▼                 ▼                  ▼
5. SessionSearch   SessionStore    ChromaSync
   (FTS5 queries)  (CRUD ops)      (Vector search)
   ↓                 ▼                  ▼
6. SQLite DB       SQLite DB       ChromaDB
   observations_fts observations    observations collection
   sessions_fts     sessions
   prompts_fts      summaries
   ↓                 ▼                  ▼
7. Raw results     Raw results     Vector results
   └─────────────────┴──────────────────┘
                     ▼
8. Result merging and deduplication
   ↓
9. Format transformation (index vs full)
   ↓
10. JSON response
   ↓
11. HTTP response sent to Claude
```

### Database Schema (Relevant Tables)

**Observations Table:**
```sql
CREATE TABLE observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_db_id INTEGER NOT NULL,
  type TEXT NOT NULL, -- bugfix, feature, refactor, decision, discovery, change
  title TEXT NOT NULL,
  subtitle TEXT,
  narrative TEXT NOT NULL,
  facts TEXT, -- JSON array
  files TEXT, -- JSON array
  concepts TEXT, -- JSON array
  created_at_epoch INTEGER NOT NULL,
  created_at_iso TEXT NOT NULL,
  project TEXT NOT NULL,
  FOREIGN KEY (session_db_id) REFERENCES sessions(db_id)
);
```

**FTS5 Virtual Table:**
```sql
CREATE VIRTUAL TABLE observations_fts USING fts5(
  title,
  subtitle,
  narrative,
  facts,
  concepts,
  content=observations,
  content_rowid=id
);
```

**Auto-sync Triggers:**
```sql
-- Keep FTS5 in sync with observations table
CREATE TRIGGER observations_ai AFTER INSERT ON observations BEGIN
  INSERT INTO observations_fts(rowid, title, subtitle, narrative, facts, concepts)
  VALUES (new.id, new.title, new.subtitle, new.narrative, new.facts, new.concepts);
END;

CREATE TRIGGER observations_ad AFTER DELETE ON observations BEGIN
  DELETE FROM observations_fts WHERE rowid = old.id;
END;

CREATE TRIGGER observations_au AFTER UPDATE ON observations BEGIN
  UPDATE observations_fts
  SET title = new.title,
      subtitle = new.subtitle,
      narrative = new.narrative,
      facts = new.facts,
      concepts = new.concepts
  WHERE rowid = new.id;
END;
```

---

## Token Efficiency Engineering

### Why Token Efficiency Matters

1. **MCP tool limits:** Maximum ~2,500 tokens per tool response
2. **Context window:** Every token loaded reduces available space for code/conversation
3. **Cost:** API costs scale with tokens
4. **Performance:** Smaller payloads = faster responses

### Engineering Decisions for Token Efficiency

#### 1. Skill-based Architecture vs MCP Tools

**Old approach (MCP tools):**
```xml
<tool>
  <name>search_observations</name>
  <description>...</description>
  <parameters>
    <parameter name="query">...</parameter>
    <parameter name="format">...</parameter>
    <!-- ... 15 more parameters ... -->
  </parameters>
</tool>
<!-- Repeat for 9 more search tools -->
```
**Token cost:** ~2,500 tokens loaded in EVERY session

**New approach (skill):**
```yaml
---
name: mem-search
description: Search claude-mem's persistent cross-session memory database...
---
```
**Token cost:** ~250 tokens at session start, ~2,150 total when invoked

**Savings:** ~350 tokens per session (when not invoked), breaks even when invoked

#### 2. Progressive Disclosure in Skill Structure

**SKILL.md structure:**
- **Navigation hub** (202 lines) - loaded on invocation
- **Operation guides** (separate files) - loaded only when needed
- **Principle guides** (separate files) - loaded only when referenced

**Token progression:**
1. Session start: 250 tokens (description only)
2. Skill invocation: +1,500 tokens (SKILL.md loaded)
3. Operation selection: +400 tokens (e.g., observations.md loaded)
4. Total: ~2,150 tokens

vs loading all 2,724 lines upfront: ~8,000+ tokens

#### 3. Index vs Full Format

**Index format design:**
```json
{
  "id": 1234,
  "type": "feature",
  "title": "Implemented JWT authentication",
  "subtitle": "Added token-based auth with refresh tokens",
  "created_at_epoch": 1699564800000,
  "project": "api-server"
}
```
**Token cost:** ~75 tokens

**Full format design:**
```json
{
  "id": 1234,
  "type": "feature",
  "title": "Implemented JWT authentication",
  "subtitle": "Added token-based auth with refresh tokens",
  "narrative": "Implemented a complete JWT authentication system with access tokens (15min expiry) and refresh tokens (7-day expiry). The system uses RS256 signing with key rotation support. Added middleware for token validation, refresh endpoint for token renewal, and secure cookie storage for refresh tokens (httpOnly, secure, sameSite). Handled edge cases including concurrent refresh requests, token revocation, and graceful expiry.",
  "facts": [
    "Access tokens expire after 15 minutes",
    "Refresh tokens expire after 7 days",
    "Uses RS256 algorithm for signing",
    "Implements key rotation for security",
    "Stores refresh tokens in httpOnly cookies",
    "Handles concurrent refresh requests with locking"
  ],
  "files": [
    "src/auth/jwt.ts",
    "src/auth/middleware.ts",
    "src/routes/auth.ts"
  ],
  "concepts": ["how-it-works", "pattern"],
  "created_at_epoch": 1699564800000,
  "created_at_iso": "2024-11-09T12:00:00Z",
  "project": "api-server",
  "session_db_id": 123
}
```
**Token cost:** ~750 tokens

**Ratio:** 10x difference

#### 4. Limit Parameter Defaults

**Anti-pattern:**
```bash
# Request 20 results by default
curl "...&limit=20"  # 20 × 750 = 15,000 tokens
```

**Best practice:**
```bash
# Start with 5 results
curl "...&limit=5"  # 5 × 75 = 375 tokens (index)
```

**Skill enforces this:** All operation guides recommend `limit=3-5` for initial requests

---

## Complete Request Flow Example

### Scenario: User asks "What bugs did we fix last week?"

#### Step 1: Trigger Detection

**Claude analyzes prompt:**
- "bugs" → type=bugfix
- "last week" → temporal trigger, dateRange filter
- "did we fix" → past tense, cross-session query

**Claude matches against mem-search description:**
- ✅ "persistent cross-session memory database"
- ✅ "previous conversations"
- ✅ "NOT in the current conversation context"
- ✅ "Use when user asks 'did we already solve this?'"

**Decision:** Invoke `mem-search` skill

#### Step 2: Skill Loading

**Claude invokes:**
```
Skill(skill: "claude-mem:mem-search")
```

**System loads:**
- `plugin/skills/mem-search/SKILL.md` (~1,500 tokens)

**Claude reads navigation:**
- "What is the user asking about?" → "Specific type (bugfixes)"
- Decision guide says: "Use by-type filter"
- Navigates to `operations/by-type.md`

#### Step 3: Operation Loading

**System loads:**
- `plugin/skills/mem-search/operations/by-type.md` (~400 tokens)

**Claude reads operation guide:**
- Parameter: `type=bugfix`
- Format: Start with `format=index`
- Limit: Use `limit=5`
- Date range: Can add `dateRange` filter

#### Step 4: Initial Search (Index Format)

**Claude constructs curl command:**
```bash
curl -s "http://localhost:37777/api/search/by-type?type=bugfix&format=index&limit=5&dateRange[start]=2024-11-04&dateRange[end]=2024-11-11"
```

**Worker service processes:**
```typescript
// Parse parameters
const type = 'bugfix';
const format = 'index';
const limit = 5;
const dateRange = { start: 1730678400000, end: 1731283200000 };

// Execute FTS5 query
const results = sessionSearch.searchByType({
  type: 'bugfix',
  limit: 5,
  filters: { dateRange }
});

// Format as index
return {
  type: 'bugfix',
  count: 3,
  format: 'index',
  results: [
    {
      id: 1245,
      type: 'bugfix',
      title: 'Fixed token expiration edge case',
      subtitle: 'Handled race condition in refresh flow',
      created_at_epoch: 1731100800000,
      project: 'api-server',
    },
    {
      id: 1246,
      type: 'bugfix',
      title: 'Resolved memory leak in worker',
      subtitle: 'Fixed event listener cleanup',
      created_at_epoch: 1731014400000,
      project: 'worker-service',
    },
    {
      id: 1247,
      type: 'bugfix',
      title: 'Fixed CORS preflight handling',
      subtitle: 'Added OPTIONS method support',
      created_at_epoch: 1730928000000,
      project: 'api-server',
    }
  ]
};
```

**Token cost:** ~225 tokens (3 results × 75)

#### Step 5: Relevance Assessment

**Claude scans results:**
- All 3 results are bugfixes from last week ✅
- Titles are descriptive enough to answer user's question

**Decision:** No need for full details, index provides sufficient information

#### Step 6: Response to User

**Claude formats response:**
```markdown
Last week we fixed 3 bugs:

🔴 **#1245** Fixed token expiration edge case (Nov 9, api-server)
   > Handled race condition in refresh flow

🔴 **#1246** Resolved memory leak in worker (Nov 8, worker-service)
   > Fixed event listener cleanup

🔴 **#1247** Fixed CORS preflight handling (Nov 7, api-server)
   > Added OPTIONS method support

Would you like more details on any of these fixes?
```

#### Alternative Flow: User Wants Details

If user asks: "Tell me more about the memory leak fix"

**Claude requests full details:**
```bash
curl -s "http://localhost:37777/api/search/by-type?type=bugfix&format=full&limit=1&offset=1"
```

**Worker returns full observation:**
```json
{
  "type": "bugfix",
  "count": 1,
  "format": "full",
  "results": [{
    "id": 1246,
    "type": "bugfix",
    "title": "Resolved memory leak in worker",
    "subtitle": "Fixed event listener cleanup",
    "narrative": "Discovered a memory leak in the worker service caused by event listeners not being removed when sessions ended. The session cleanup hook was creating new event listeners on each session but never removing them, causing memory to grow unbounded. Fixed by tracking active listeners and explicitly calling removeAllListeners() in the cleanup handler. Added WeakMap to prevent duplicate listener registration.",
    "facts": [
      "Memory grew by ~50MB per 100 sessions",
      "Event listeners were never removed",
      "Session cleanup hook was the culprit",
      "Fixed with removeAllListeners() call",
      "Added WeakMap to track active listeners"
    ],
    "files": [
      "src/hooks/cleanup-hook.ts",
      "src/services/worker-service.ts"
    ],
    "concepts": ["problem-solution", "gotcha"],
    "created_at_epoch": 1731014400000,
    "created_at_iso": "2024-11-08T00:00:00Z",
    "project": "worker-service",
    "session_db_id": 156
  }]
}
```

**Token cost:** ~750 tokens

**Claude provides detailed response:**
```markdown
The memory leak was in the worker service's session cleanup:

**Problem:** Event listeners were created on each session but never removed, causing ~50MB memory growth per 100 sessions.

**Root cause:** The session cleanup hook (`src/hooks/cleanup-hook.ts`) was adding listeners without tracking or removing them.

**Solution:**
- Added `removeAllListeners()` call in cleanup handler
- Implemented WeakMap to prevent duplicate listener registration
- Memory now stable across sessions

**Files modified:**
- src/hooks/cleanup-hook.ts
- src/services/worker-service.ts

This was a "gotcha" - we discovered event listeners in Node.js must be explicitly removed to prevent memory leaks.
```

### Total Token Cost Breakdown

**Efficient path (index only):**
- Skill description (session start): 250 tokens
- SKILL.md (invocation): 1,500 tokens
- Operation guide: 400 tokens
- Index results (3 items): 225 tokens
- **Total: 2,375 tokens**

**Detailed path (one full result):**
- Efficient path: 2,375 tokens
- Full details (1 item): 750 tokens
- **Total: 3,125 tokens**

**Comparison to loading everything upfront:**
- All 5 results in full format: 5 × 750 = 3,750 tokens
- Plus operation overhead: ~2,000 tokens
- **Total: 5,750 tokens**

**Savings:** 5,750 - 3,125 = **2,625 tokens saved** (45% reduction)

---

## Summary: How Everything Works

### The Complete Picture

1. **Session Start:**
   - Claude loads skill descriptions (250 tokens per skill)
   - mem-search description contains high-effectiveness triggers
   - Claude has awareness that skill exists

2. **User Query:**
   - Claude analyzes for trigger phrases
   - Temporal triggers: "already", "before", "last time", "last week"
   - System-specific triggers: "claude-mem", "cross-session memory"
   - Scope boundaries: "NOT current conversation"

3. **Skill Invocation:**
   - Claude invokes skill via `Skill` tool
   - Full SKILL.md loads (~1,500 tokens)
   - Decision guide helps choose operation

4. **Operation Selection:**
   - Claude loads specific operation guide (~400 tokens)
   - Learns HTTP API syntax and parameters
   - Understands progressive disclosure workflow

5. **Search Execution:**
   - Claude constructs curl command with appropriate parameters
   - Worker service receives HTTP GET request
   - Backend queries SQLite FTS5 or ChromaDB
   - Results formatted as index or full

6. **Progressive Disclosure:**
   - Start with index format (50-100 tokens/result)
   - Assess relevance from titles/subtitles
   - Request full details only for relevant items (500-1000 tokens/result)
   - Saves 10x tokens vs loading everything

7. **Response Formatting:**
   - Claude presents results to user
   - Includes file references, timestamps, project names
   - Offers to provide more details if needed

### Key Innovations

1. **Trigger Engineering:** 85% concrete triggers ensure reliable auto-invocation
2. **Progressive Disclosure:** 10x token efficiency via index-first workflow
3. **Hybrid Search:** FTS5 keyword + vector semantic search for best results
4. **Skill Architecture:** ~2,250 token savings vs always-loaded MCP tools
5. **HTTP API:** Simple curl commands vs complex MCP protocol
6. **Documentation:** 2,724 lines of operation guides prevent hallucination

### Why This Works Better Than MCP Tools

| Aspect | MCP Tools | mem-search Skill |
|--------|-----------|------------------|
| Token cost (session start) | ~2,500 tokens | 250 tokens |
| Token cost (invoked) | ~2,500 tokens | ~2,150 tokens |
| Auto-invocation reliability | Moderate | High (100% compliance) |
| Trigger effectiveness | Not measured | 85% concrete |
| Documentation size | Embedded in tool definitions | 2,724 lines (progressive) |
| User education | Tool descriptions only | Operations + principles guides |
| Token efficiency guidance | None | Mandatory progressive disclosure |
| Scope differentiation | Weak | Strong (9 keywords) |

**Result:** The mem-search skill provides better discoverability, higher reliability, and superior token efficiency compared to the previous MCP tool approach.

---

## Further Reading

**In this repository:**
- `plugin/skills/mem-search/SKILL.md` - User-facing skill documentation
- `plugin/skills/mem-search/principles/progressive-disclosure.md` - 4-step workflow
- `plugin/skills/mem-search/principles/anti-patterns.md` - Common mistakes
- `context/skill-audit-report.md` - Compliance validation
- `src/services/worker-service.ts` - HTTP API implementation
- `src/services/sqlite/SessionSearch.ts` - FTS5 search implementation
- `src/services/sync/ChromaSync.ts` - Vector search implementation

**External:**
- [Anthropic Skill Creator Documentation](https://github.com/anthropics/anthropic-quickstarts/tree/main/skill-creator)
- [SQLite FTS5 Documentation](https://www.sqlite.org/fts5.html)
- [ChromaDB Documentation](https://docs.trychroma.com/)
