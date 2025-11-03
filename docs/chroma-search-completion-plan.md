# Chroma Search Completion Plan

## Current State Analysis

### What's Working ✅
1. **Hybrid Search Implementation**
   - Chroma semantic search + SQLite temporal filtering is working
   - Evidence: Queries like "AI embeddings" find "hybrid search" through semantic similarity
   - All metadata-first tools use Chroma ranking

2. **Tools Using Chroma Correctly**
   - `search_observations` - Semantic-first workflow (Chroma top 100 → 90-day filter → SQLite hydrate)
   - `find_by_concept` - Metadata-first + Chroma semantic ranking
   - `find_by_file` - Metadata-first + Chroma semantic ranking
   - `find_by_type` - Metadata-first + Chroma semantic ranking

3. **Data Synced to Chroma**
   - ✅ Observations (all fields: narrative, facts, text as separate docs)
   - ✅ Session summaries (all fields: request, investigated, learned, completed, next_steps, notes as separate docs)
   - ❌ User prompts (NOT synced yet)

### What's Missing ❌

1. **search_sessions tool** - Only uses SQLite FTS5, not leveraging Chroma semantic search
2. **search_user_prompts tool** - Only uses SQLite FTS5, not leveraging Chroma semantic search
3. **User prompts not synced to Chroma** - Need to add to sync experiment and worker process

## Why User Prompts Need Semantic Search

**Benefits:**
- Users often search for "what I asked about X" but phrase it differently than original prompt
- Semantic search finds related requests even with different wording
- Example: Search "authentication setup" finds prompts about "login system", "user auth", "sign-in flow"
- Completes the triad: What was done (observations) + What was learned (summaries) + What was requested (prompts)

**Storage pattern:**
- Each user prompt becomes ONE document in Chroma (unlike observations/summaries which split by field)
- Metadata: `sqlite_id`, `doc_type: 'user_prompt'`, `sdk_session_id`, `project`, `created_at_epoch`, `prompt_number`
- Document ID format: `prompt_{id}` (simpler than observations since no field splitting)

## Implementation Plan

### Phase 1: Sync User Prompts to Chroma

**Files to modify:**
1. `experiment/chroma-sync-experiment.ts` - Add user_prompts sync section
2. Future: Worker service incremental sync (not in this phase)

**Implementation:**
```typescript
// In chroma-sync-experiment.ts after session summaries sync

// Fetch user prompts
console.log('📖 Reading user prompts from SQLite...');
const prompts = store.db.prepare(`
  SELECT * FROM user_prompts WHERE project = ? ORDER BY created_at_epoch DESC LIMIT 1000
`).all(project) as any[];
console.log(`Found ${prompts.length} user prompts`);

// Prepare prompt documents - one document per prompt
const promptDocs: ChromaDocument[] = [];

for (const prompt of prompts) {
  promptDocs.push({
    id: `prompt_${prompt.id}`,
    document: prompt.prompt_text,
    metadata: {
      sqlite_id: prompt.id,
      doc_type: 'user_prompt',
      sdk_session_id: prompt.sdk_session_id,
      project: prompt.project,
      created_at_epoch: prompt.created_at_epoch,
      prompt_number: prompt.prompt_number || 0
    }
  });
}

console.log(`Created ${promptDocs.length} user prompt documents\n`);

// Sync prompts in batches (same pattern as observations/sessions)
```

**Testing:**
```bash
npm run experiment:sync
# Verify prompts appear in Chroma collection
```

### Phase 2: Update search_sessions to Use Chroma

**File:** `src/servers/search-server.ts` (lines ~441-481)

**Current implementation:**
```typescript
const results = search.searchSessions(query, options);
```

**New implementation (semantic-first hybrid):**
```typescript
let results: SessionSummarySearchResult[] = [];

// Hybrid search: Try Chroma semantic search first, fall back to FTS5
if (chromaClient) {
  try {
    console.error('[search-server] Using hybrid semantic search for sessions');

    // Step 1: Chroma semantic search (top 100)
    const chromaResults = await queryChroma(query, 100, { doc_type: 'session_summary' });
    console.error(`[search-server] Chroma returned ${chromaResults.ids.length} semantic matches`);

    if (chromaResults.ids.length > 0) {
      // Step 2: Filter by recency (90 days)
      const ninetyDaysAgo = Math.floor(Date.now() / 1000) - (90 * 24 * 60 * 60);
      const recentIds = chromaResults.ids.filter((id, idx) => {
        const meta = chromaResults.metadatas[idx];
        return meta && meta.created_at_epoch > ninetyDaysAgo;
      });

      console.error(`[search-server] ${recentIds.length} results within 90-day window`);

      // Step 3: Hydrate from SQLite in temporal order
      if (recentIds.length > 0) {
        const limit = options.limit || 20;
        results = store.getSessionSummariesByIds(recentIds, { orderBy: 'date_desc', limit });
        console.error(`[search-server] Hydrated ${results.length} sessions from SQLite`);
      }
    }
  } catch (chromaError: any) {
    console.error('[search-server] Chroma query failed, falling back to FTS5:', chromaError.message);
  }
}

// Fall back to FTS5 if Chroma unavailable or returned no results
if (results.length === 0) {
  console.error('[search-server] Using FTS5 keyword search');
  results = search.searchSessions(query, options);
}
```

**Helper needed in queryChroma:**
Update `queryChroma` function to extract summary IDs from document IDs:
```typescript
// Extract unique summary IDs from document IDs
for (const docId of docIds) {
  // Handle both obs_{id}_* and summary_{id}_* formats
  const obsMatch = docId.match(/obs_(\d+)_/);
  const summaryMatch = docId.match(/summary_(\d+)_/);

  if (obsMatch) {
    const sqliteId = parseInt(obsMatch[1], 10);
    if (!ids.includes(sqliteId)) ids.push(sqliteId);
  } else if (summaryMatch) {
    const sqliteId = parseInt(summaryMatch[1], 10);
    if (!ids.includes(sqliteId)) ids.push(sqliteId);
  }
}
```

**Database helper needed:**
Add to `SessionStore.ts`:
```typescript
getSessionSummariesByIds(
  ids: number[],
  options: { orderBy?: 'date_desc' | 'date_asc'; limit?: number } = {}
): SessionSummarySearchResult[] {
  if (ids.length === 0) return [];

  const { orderBy = 'date_desc', limit } = options;
  const orderClause = orderBy === 'date_asc' ? 'ASC' : 'DESC';
  const limitClause = limit ? `LIMIT ${limit}` : '';
  const placeholders = ids.map(() => '?').join(',');

  const stmt = this.db.prepare(`
    SELECT * FROM session_summaries
    WHERE id IN (${placeholders})
    ORDER BY created_at_epoch ${orderClause}
    ${limitClause}
  `);

  return stmt.all(...ids) as SessionSummarySearchResult[];
}
```

### Phase 3: Update search_user_prompts to Use Chroma

**File:** `src/servers/search-server.ts` (lines ~956-1010)

**Current implementation:**
```typescript
const results = search.searchUserPrompts(query, options);
```

**New implementation (semantic-first hybrid):**
```typescript
let results: UserPromptSearchResult[] = [];

// Hybrid search: Try Chroma semantic search first, fall back to FTS5
if (chromaClient) {
  try {
    console.error('[search-server] Using hybrid semantic search for user prompts');

    // Step 1: Chroma semantic search (top 100)
    const chromaResults = await queryChroma(query, 100, { doc_type: 'user_prompt' });
    console.error(`[search-server] Chroma returned ${chromaResults.ids.length} semantic matches`);

    if (chromaResults.ids.length > 0) {
      // Step 2: Filter by recency (90 days)
      const ninetyDaysAgo = Math.floor(Date.now() / 1000) - (90 * 24 * 60 * 60);
      const recentIds = chromaResults.ids.filter((id, idx) => {
        const meta = chromaResults.metadatas[idx];
        return meta && meta.created_at_epoch > ninetyDaysAgo;
      });

      console.error(`[search-server] ${recentIds.length} results within 90-day window`);

      // Step 3: Hydrate from SQLite in temporal order
      if (recentIds.length > 0) {
        const limit = options.limit || 20;
        results = store.getUserPromptsByIds(recentIds, { orderBy: 'date_desc', limit });
        console.error(`[search-server] Hydrated ${results.length} user prompts from SQLite`);
      }
    }
  } catch (chromaError: any) {
    console.error('[search-server] Chroma query failed, falling back to FTS5:', chromaError.message);
  }
}

// Fall back to FTS5 if Chroma unavailable or returned no results
if (results.length === 0) {
  console.error('[search-server] Using FTS5 keyword search');
  results = search.searchUserPrompts(query, options);
}
```

**Helper needed in queryChroma:**
Update to handle `prompt_{id}` format:
```typescript
// Extract unique prompt IDs from document IDs
for (const docId of docIds) {
  const obsMatch = docId.match(/obs_(\d+)_/);
  const summaryMatch = docId.match(/summary_(\d+)_/);
  const promptMatch = docId.match(/prompt_(\d+)/);

  if (obsMatch) {
    const sqliteId = parseInt(obsMatch[1], 10);
    if (!ids.includes(sqliteId)) ids.push(sqliteId);
  } else if (summaryMatch) {
    const sqliteId = parseInt(summaryMatch[1], 10);
    if (!ids.includes(sqliteId)) ids.push(sqliteId);
  } else if (promptMatch) {
    const sqliteId = parseInt(promptMatch[1], 10);
    if (!ids.includes(sqliteId)) ids.push(sqliteId);
  }
}
```

**Database helper needed:**
Add to `SessionStore.ts`:
```typescript
getUserPromptsByIds(
  ids: number[],
  options: { orderBy?: 'date_desc' | 'date_asc'; limit?: number } = {}
): UserPromptSearchResult[] {
  if (ids.length === 0) return [];

  const { orderBy = 'date_desc', limit } = options;
  const orderClause = orderBy === 'date_asc' ? 'ASC' : 'DESC';
  const limitClause = limit ? `LIMIT ${limit}` : '';
  const placeholders = ids.map(() => '?').join(',');

  const stmt = this.db.prepare(`
    SELECT * FROM user_prompts
    WHERE id IN (${placeholders})
    ORDER BY created_at_epoch ${orderClause}
    ${limitClause}
  `);

  return stmt.all(...ids) as UserPromptSearchResult[];
}
```

### Phase 4: Timeline Context Tool

**New tool:** `get_context_timeline`

**Purpose:** Show observations/sessions/prompts around a specific point in time

**API:**
```typescript
{
  name: 'get_context_timeline',
  description: 'Get a timeline of context around a specific observation, session, or timestamp',
  inputSchema: z.object({
    anchor: z.union([
      z.number(), // observation ID
      z.string()  // ISO timestamp or session ID
    ]).describe('Anchor point: observation ID, session ID, or ISO timestamp'),
    depth_before: z.number().min(0).max(50).default(10).describe('Number of records to show before anchor'),
    depth_after: z.number().min(0).max(50).default(10).describe('Number of records to show after anchor'),
    format: z.enum(['index', 'full']).default('index'),
    project: z.string().optional()
  })
}
```

**Implementation approach:**
1. Resolve anchor to a timestamp (observation.created_at_epoch, session.created_at_epoch, or parse ISO)
2. Query observations within [anchor_time - depth_before_duration, anchor_time + depth_after_duration]
3. Return chronologically ordered results with anchor highlighted
4. Support mixing observations, sessions, and prompts in single timeline

**Database helper:**
```typescript
getTimelineAroundTimestamp(
  anchorEpoch: number,
  depthBefore: number,
  depthAfter: number,
  project?: string
): { observations: any[], sessions: any[], prompts: any[] } {
  // Calculate time windows based on depth
  // For now: each depth = 1 hour (configurable)
  const hourInSeconds = 3600;
  const startEpoch = anchorEpoch - (depthBefore * hourInSeconds);
  const endEpoch = anchorEpoch + (depthAfter * hourInSeconds);

  // Query all three tables
  const observations = this.db.prepare(`...`).all(...);
  const sessions = this.db.prepare(`...`).all(...);
  const prompts = this.db.prepare(`...`).all(...);

  return { observations, sessions, prompts };
}
```

## Testing Plan

### Phase 1 Testing
```bash
# Run sync experiment
npm run experiment:sync

# Check Chroma collection for prompts
# Should see prompt_* documents with doc_type: 'user_prompt'
```

### Phase 2 Testing
```bash
# Test semantic search for sessions
# Example: "authentication system" should find sessions about "login", "user auth", etc.
```

### Phase 3 Testing
```bash
# Test semantic search for user prompts
# Example: "fix bug" should find prompts with "error", "issue", "problem", etc.
```

### Phase 4 Testing
```bash
# Test timeline around specific observation
# Should show before/after context
```

## Files to Modify

1. **experiment/chroma-sync-experiment.ts** - Add user_prompts sync
2. **src/servers/search-server.ts** - Update search_sessions and search_user_prompts, add get_context_timeline
3. **src/services/sqlite/SessionStore.ts** - Add getSessionSummariesByIds, getUserPromptsByIds, getTimelineAroundTimestamp
4. **src/services/sqlite/types.ts** - Ensure all return types are exported

## Success Criteria

- ✅ All 8 search tools use Chroma semantic search with SQLite temporal fallback
- ✅ User prompts are synced to Chroma and searchable
- ✅ Timeline tool provides chronological context around any point
- ✅ Semantic search works across observations, sessions, and prompts
- ✅ All searches maintain 90-day temporal filtering for relevance

## Future Enhancements

1. **Incremental sync in worker service** - Currently only batch sync via experiment
2. **Configurable temporal windows** - Make 90-day filter configurable
3. **Cross-collection search** - Search across observations + sessions + prompts in one query
4. **Timeline view improvements** - Group by session, highlight anchor, show relationships
