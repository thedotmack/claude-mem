# Feature Implementation Plan: Hybrid Search (Chroma + SQLite)

## Status: Experimental validation complete, ready for production implementation

## Experiment Results Summary

**Branch:** `experiment/chroma-mcp`
**Validation:** Semantic search (Chroma) + Temporal filtering (SQLite) working correctly
**Collection:** `cm__claude-mem` with 2,800+ documents synced
**Decision:** Proceed with production implementation

---

## Implementation Plan

### Phase 1: Clean Start

#### 1.1 Create Feature Branch
```bash
# Start from clean main branch
git checkout main
git pull origin main

# Create new feature branch
git branch feature/hybrid-search
git checkout feature/hybrid-search
```

#### 1.2 Port Working Experiment Scripts

**Files to keep (these work correctly):**
- `experiment/chroma-sync-experiment.ts` - Syncs SQLite → Chroma
- `experiment/chroma-search-test.ts` - Validates search quality
- `experiment/README.md` - Experiment documentation
- `experiment/RESULTS.md` - Update with accurate current results

**Actions:**
```bash
# Cherry-pick only the experiment files from experiment/chroma-mcp
git checkout experiment/chroma-mcp -- experiment/

# Remove any experiment artifacts that reference old implementation
# (test-chroma-connection.ts uses broken ChromaOrchestrator)
git rm experiment/../test-chroma-connection.ts 2>/dev/null || true

# Commit clean experiment baseline
git commit -m "Add validated Chroma search experiments"
```

---

### Phase 2: Production Architecture

#### 2.1 Design Principles

**Core Rules:**
1. ✅ Direct MCP client usage (no wrapper abstractions)
2. ✅ Inline helper functions (no ChromaOrchestrator)
3. ✅ Each search workflow is deterministic (no fallbacks)
4. ✅ Temporal boundaries prevent stale results
5. ✅ Chroma handles semantic ranking, SQLite handles recency

**File Structure:**
```
src/
├── servers/
│   └── search-server.ts          # Hybrid MCP server (SQLite + Chroma)
├── services/
│   ├── sqlite/
│   │   ├── SessionStore.ts       # SQLite CRUD (unchanged)
│   │   └── SessionSearch.ts      # FTS5 search (fallback if Chroma fails)
│   └── sync/
│       └── ChromaSync.ts         # NEW: Sync SQLite → Chroma on observation save
└── shared/
    └── paths.ts                   # Add VECTOR_DB_DIR constant
```

#### 2.2 Search Workflows

**Workflow 1: search_observations (Semantic-First, Temporally-Bounded)**
```
User Query → Chroma Semantic Search (top 100)
           → Filter: created_at_epoch > (now - 90 days)
           → SQLite: Hydrate full records
           → Sort: created_at_epoch DESC
           → Return: Recent + semantically relevant
```

**Workflow 2: find_by_concept/type/file (Metadata-First, Semantic-Enhanced)**
```
User Query → SQLite: Filter by metadata (type/concept/file)
           → Chroma: Rank filtered IDs by semantic relevance
           → SQLite: Hydrate in semantic rank order
           → Return: Metadata-filtered + semantically ranked
```

**Workflow 3: search_sessions (SQLite FTS5 only)**
```
User Query → SQLite FTS5 search (sessions are already summarized)
           → Return: Keyword matches
```

**Workflow 4: get_recent_context (Temporal-First, No Semantic)**
```
Hook Request → SQLite: Last 50 observations ORDER BY created_at_epoch DESC
             → Return: Most recent context (no semantic ranking needed)
```

---

### Phase 3: Implementation Steps

#### 3.1 Add Chroma Support to search-server.ts

**File:** `src/servers/search-server.ts`

**Changes:**
1. Add Chroma MCP client initialization (lines 20-26):
   ```typescript
   let chromaClient: Client;
   const COLLECTION_NAME = 'cm__claude-mem';
   ```

2. Add `queryChroma()` helper function with proper Python dict parsing:
   ```typescript
   async function queryChroma(
     query: string,
     limit: number,
     whereFilter?: Record<string, any>
   ): Promise<{ ids: number[]; distances: number[]; metadatas: any[] }>
   ```

3. Initialize Chroma client in `main()`:
   ```typescript
   const chromaTransport = new StdioClientTransport({
     command: 'uvx',
     args: ['chroma-mcp', '--client-type', 'persistent', '--data-dir', VECTOR_DB_DIR]
   });
   chromaClient = new Client({...});
   await chromaClient.connect(chromaTransport);
   ```

4. Update `search_observations` handler (lines 350-427):
   - Replace FTS5 search with Chroma semantic search
   - Add 90-day temporal filter
   - Hydrate from SQLite in temporal order

5. Update `find_by_concept` handler (lines 501-575):
   - SQLite metadata filter first
   - Chroma semantic ranking second
   - Preserve semantic rank order in final results

6. Update `find_by_type` handler (lines 720-797):
   - Same pattern as find_by_concept

7. Update `find_by_file` handler (lines 592-700):
   - Same pattern as find_by_concept

**IMPORTANT:**
- Keep `SessionSearch` as fallback (if Chroma client fails to connect)
- Add error handling: if Chroma query fails, fall back to FTS5
- Log all Chroma operations to stderr for debugging

#### 3.2 Add VECTOR_DB_DIR Path Constant

**File:** `src/shared/paths.ts`

```typescript
export const VECTOR_DB_DIR = path.join(DATA_DIR, 'vector-db');
```

#### 3.3 Add Automatic Sync Service

**NEW File:** `src/services/sync/ChromaSync.ts`

**Purpose:** Automatically sync new observations to Chroma when worker saves them

**Key Methods:**
```typescript
class ChromaSync {
  async syncObservation(obs: Observation): Promise<void>
  async syncBatch(observations: Observation[]): Promise<void>
  async ensureCollection(): Promise<void>
}
```

**Integration Point:**
- `worker-service.ts` - After saving observation to SQLite, call `chromaSync.syncObservation()`
- Batch sync on startup: sync any observations not yet in Chroma

**Document Format (per experiment):**
```typescript
// Each observation creates multiple Chroma documents (one per semantic chunk)
id: `obs_${obs.id}_title`
document: obs.title
metadata: { sqlite_id: obs.id, type: obs.type, created_at_epoch: obs.created_at_epoch }

id: `obs_${obs.id}_narrative`
document: obs.narrative
metadata: { sqlite_id: obs.id, type: obs.type, created_at_epoch: obs.created_at_epoch }

// Facts become individual searchable chunks
id: `obs_${obs.id}_fact_${i}`
document: fact
metadata: { sqlite_id: obs.id, type: obs.type, created_at_epoch: obs.created_at_epoch }
```

---

### Phase 4: Build and Validation

#### 4.1 Build Process
```bash
# Build all scripts
npm run build

# Verify outputs
ls -lh plugin/scripts/search-server.js    # Should exist (ESM)
ls -lh plugin/scripts/search-server.cjs   # Should NOT exist (delete if present)

# Check build format
head -1 plugin/scripts/search-server.js   # Should show: #!/usr/bin/env node
```

#### 4.2 Validation Checklist

**✅ Pre-deployment checks:**
1. Run sync experiment: `npx tsx experiment/chroma-sync-experiment.ts`
   - Verify collection created
   - Verify documents synced
   - Check document count matches observations

2. Run search test: `npx tsx experiment/chroma-search-test.ts`
   - Verify semantic queries return results
   - Compare quality vs FTS5
   - Document results in RESULTS.md

3. Test MCP server standalone:
   ```bash
   # Start server manually
   node plugin/scripts/search-server.js

   # In another terminal, test with MCP inspector
   npx @modelcontextprotocol/inspector node plugin/scripts/search-server.js
   ```

4. Test with Claude Code:
   ```bash
   # Deploy to plugin directory
   cp -r plugin/* ~/.claude/plugins/marketplaces/thedotmack/

   # Restart worker
   pm2 restart claude-mem-worker

   # Start new Claude session and test search tools
   ```

**✅ Smoke tests:**
- Search for recent work: Should return last 90 days
- Search for old concepts: Should filter by recency
- Search by file: Should return file-specific observations
- Search by type: Should return only that type

---

### Phase 5: Documentation

#### 5.1 Update CLAUDE.md

Add to "What It Does" section:
```markdown
### Hybrid Search Architecture

Claude-mem uses a hybrid search system combining:
- **Semantic Search (Chroma)**: Vector embeddings for conceptual understanding
- **Keyword Search (SQLite FTS5)**: Full-text search for exact matches
- **Temporal Filtering**: 90-day recency boundary prevents stale results

Search workflows automatically choose the optimal combination:
- Conceptual queries → Semantic-first, temporally-bounded
- Metadata queries → Metadata-first, semantically-enhanced
- Recent context → Temporal-first (no semantic ranking)
```

#### 5.2 Update Architecture Section

```markdown
### Vector Database Layer

**Technology**: ChromaDB via Chroma MCP server
**Location**: `~/.claude-mem/vector-db/`
**Collection**: `cm__claude-mem`

**Sync Strategy**:
- Worker service syncs observations to Chroma after SQLite save
- Each observation creates multiple vector documents (title, narrative, facts)
- Metadata includes `sqlite_id` for cross-reference

**Search Strategy**:
- Semantic queries use Chroma with 90-day temporal filter
- Metadata queries filter SQLite first, then semantic rank
- Fallback to FTS5 if Chroma unavailable
```

#### 5.3 Write Release Notes

**File:** `EXPERIMENTAL_RELEASE_NOTES.md`

```markdown
# Hybrid Search Release (v4.4.0)

## Breaking Changes
None - Search MCP tools maintain same interface

## New Features

### Semantic Search via Chroma
- Added ChromaDB integration for vector-based semantic search
- Observations automatically synced to vector database
- Search understands conceptual queries (not just keywords)

### Hybrid Search Workflows
- `search_observations`: Semantic search with 90-day recency filter
- `find_by_concept/type/file`: Metadata filtering + semantic ranking
- Automatic fallback to FTS5 if Chroma unavailable

### Sync Automation
- Worker service auto-syncs new observations to Chroma
- Batch sync on startup for any missing observations
- Collection: `cm__claude-mem` in `~/.claude-mem/vector-db/`

## Technical Details

**New Dependencies:**
- `@modelcontextprotocol/sdk` (already present)
- External: `uvx chroma-mcp` (Python package via uvx)

**New Files:**
- `src/services/sync/ChromaSync.ts` - Auto-sync service
- `experiment/chroma-sync-experiment.ts` - Manual sync tool
- `experiment/chroma-search-test.ts` - Search quality validator

**Modified Files:**
- `src/servers/search-server.ts` - Hybrid search implementation
- `src/services/worker-service.ts` - Auto-sync integration
- `src/shared/paths.ts` - Added VECTOR_DB_DIR constant

**Design Rationale:**
- Temporal boundaries prevent old semantically-perfect matches from outranking recent updates
- Metadata-first filtering eliminates irrelevant categories before semantic ranking
- Direct MCP client usage avoids abstraction overhead
- Inline helpers keep parsing logic close to usage
```

---

### Phase 6: Deployment

#### 6.1 Pre-merge Validation
```bash
# Ensure all tests pass
npm run build
npm run test:parser  # If applicable

# Validate experiment results
npx tsx experiment/chroma-sync-experiment.ts
npx tsx experiment/chroma-search-test.ts

# Test production MCP server
node plugin/scripts/search-server.js &
# Send test queries via MCP inspector

# Clean build artifacts
rm -f plugin/scripts/*.cjs  # Remove stale CommonJS builds
```

#### 6.2 Commit Strategy
```bash
# Commit 1: Experiment scripts (already done if following plan)
git add experiment/
git commit -m "Add validated Chroma search experiments"

# Commit 2: Core implementation
git add src/servers/search-server.ts src/shared/paths.ts
git commit -m "Implement hybrid search: Chroma semantic + SQLite temporal"

# Commit 3: Auto-sync service
git add src/services/sync/ src/services/worker-service.ts
git commit -m "Add automatic observation sync to Chroma vector DB"

# Commit 4: Documentation
git add CLAUDE.md EXPERIMENTAL_RELEASE_NOTES.md
git commit -m "Document hybrid search architecture and usage"

# Commit 5: Build artifacts
npm run build
git add plugin/scripts/
git commit -m "Build hybrid search implementation"
```

#### 6.3 Merge to Main
```bash
# Push feature branch
git push origin feature/hybrid-search

# Create PR or merge directly (your choice)
git checkout main
git merge feature/hybrid-search
git push origin main

# Tag release
git tag v4.4.0
git push origin v4.4.0
```

---

## Rollback Plan

If issues arise post-deployment:

```bash
# Quick rollback
git checkout main
git revert HEAD~5..HEAD  # Revert last 5 commits
git push origin main

# Or cherry-pick the revert
git checkout -b hotfix/rollback-hybrid-search
git revert <commit-sha>
git push origin hotfix/rollback-hybrid-search
```

**Chroma data cleanup (if needed):**
```bash
# Remove vector database
rm -rf ~/.claude-mem/vector-db/

# Search server will fall back to FTS5 if Chroma unavailable
```

---

## Success Criteria

**Must have before merge:**
- ✅ Sync experiment completes without errors
- ✅ Search test shows Chroma returning results
- ✅ MCP server starts and responds to queries
- ✅ Fallback to FTS5 works if Chroma unavailable
- ✅ No breaking changes to existing MCP tool interfaces
- ✅ Documentation updated
- ✅ No uncommitted changes
- ✅ No dead code (ChromaOrchestrator removed)
- ✅ No stale build artifacts (.cjs files)

**Nice to have:**
- Performance benchmarks (Chroma vs FTS5 query time)
- Search quality metrics (relevance scores)
- Token usage comparison (semantic vs keyword results)

---

## Timeline Estimate

- Phase 1 (Clean Start): 15 minutes
- Phase 2 (Architecture Review): 30 minutes
- Phase 3 (Implementation): 2-3 hours
- Phase 4 (Validation): 1 hour
- Phase 5 (Documentation): 1 hour
- Phase 6 (Deployment): 30 minutes

**Total: ~5-6 hours** for complete, validated implementation

---

## Notes

- The experiment validated that semantic search works and provides value
- This plan avoids all the mistakes from the previous attempt:
  - ✅ Clean branch from main (no baggage)
  - ✅ Implementation AFTER experiment validation
  - ✅ No dead code (ChromaOrchestrator)
  - ✅ Proper commit strategy
  - ✅ Complete documentation
  - ✅ Validation at every step
