# Hybrid Search Implementation Plan

## Architecture Overview

The claude-mem MCP search server will act as BOTH:
1. **MCP Server** - Serves claude-mem tools to Claude (via stdio)
2. **MCP Client** - Calls Chroma MCP server tools (subprocess)

```
Claude Code
    ↓
claude-mem MCP Server (search-server.ts)
    ├─→ SQLite (direct via SessionSearch)
    └─→ Chroma MCP Server (MCP client calls)
```

## Core Principle: No Fallbacks

Each tool implements ONE deterministic optimal workflow:
- Temporal-first when recency is critical
- Semantic-first when understanding is critical
- Metadata-first when structure filters are needed

NO optional parameters, NO mode selection, NO fallbacks.

## Four Optimal Workflows

### Workflow 1: Temporal-First (for get_recent_context)

**Use Case**: SessionStart hook context injection

**Flow**:
```
1. SQLite: Get last 50 observations ORDER BY created_at_epoch DESC
2. Chroma MCP: Score those 50 by semantic relevance to current concepts
3. Return: Top 10 most semantically relevant of the recent 50
```

**Why**: Context MUST be recent. Never inject outdated info. Semantic scoring within recent set ensures most relevant recent items surface.

**Critical**: Temporal boundary FIRST, semantic ranking SECOND.

---

### Workflow 2: Semantic-First, Temporally-Bounded (for search_observations)

**Use Case**: "How does X work?" or "What problems did we have with Y?"

**Flow**:
```
1. Chroma MCP: Semantic search (top 100 matches)
2. Filter: Keep only last 90 days (created_at_epoch > now - 90 days)
3. Extract: Get sqlite_id values from Chroma results
4. SQLite: Hydrate full records WHERE id IN (...) ORDER BY created_at_epoch DESC
5. Return: Recent + semantically relevant, sorted newest first
```

**Why**: Semantic understanding finds conceptually relevant content. Temporal filter removes ancient history. Final temporal sort ensures newest understanding is prioritized.

**Critical**: Never return old semantically-perfect matches over recent updates.

---

### Workflow 3: Metadata-First, Semantic-Enhanced (for find_by_type/concept/file)

**Use Case**: "Show me decisions about PM2" or "Find bugs in hooks"

**Flow**:
```
1. SQLite: Filter by metadata (type="decision" or concept="problem-solution")
2. Extract: Get IDs from filtered results
3. Chroma MCP: Query with where={sqlite_id IN [...]} and semantic query
4. Return: Metadata-filtered results ranked by semantic relevance
```

**Why**: Metadata filters (type, concept, file) are structural - eliminate entire categories fast. Semantic ranking within filtered set ensures best match surfaces first.

**Critical**: Two-stage filtering prevents semantic search across irrelevant types.

---

### Workflow 4: Pure Temporal (for temporal investigation)

**Use Case**: "What changed recently?" or "Show me last session's work"

**Flow**:
```
SQLite only: ORDER BY created_at_epoch DESC
```

**Why**: No semantic filtering needed - user explicitly wants chronological view.

**Note**: This is already implemented correctly in existing tools.

---

## Chroma MCP Client Setup

**From experiment/chroma-sync-experiment.ts lines 11-44:**

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'uvx',
  args: [
    'chroma-mcp',
    '--client-type', 'persistent',
    '--data-dir', '/Users/alexnewman/.claude-mem/vector-db'
  ]
});

const client = new Client({
  name: 'claude-mem-search-orchestrator',
  version: '1.0.0'
}, {
  capabilities: {}
});

await client.connect(transport);
```

**Available Chroma MCP Tools:**
- `chroma_query_documents` - Semantic search with filters
- `chroma_get_documents` - Get by metadata filters
- `chroma_get_collection_count` - Document count
- `chroma_get_collection_info` - Collection metadata

---

## Implementation Steps

### Step 1: Create ChromaOrchestrator Service

**File**: `src/services/chroma/ChromaOrchestrator.ts`

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { VECTOR_DB_DIR } from '../../shared/paths.js';

interface ChromaQueryResult {
  ids: string[][];
  documents: string[][];
  metadatas: Record<string, any>[][];
  distances: number[][];
}

export class ChromaOrchestrator {
  private client: Client | null = null;
  private collectionName = 'cm__claude-mem';

  async connect(): Promise<void> {
    const transport = new StdioClientTransport({
      command: 'uvx',
      args: [
        'chroma-mcp',
        '--client-type', 'persistent',
        '--data-dir', VECTOR_DB_DIR
      ]
    });

    this.client = new Client({
      name: 'claude-mem-search-orchestrator',
      version: '1.0.0'
    }, { capabilities: {} });

    await this.client.connect(transport);
  }

  async queryDocuments(
    query: string,
    nResults: number = 100,
    where?: Record<string, any>
  ): Promise<ChromaQueryResult> {
    if (!this.client) throw new Error('Chroma client not connected');

    const result = await this.client.callTool({
      name: 'chroma_query_documents',
      arguments: {
        collection_name: this.collectionName,
        query_texts: [query],
        n_results: nResults,
        ...(where && { where }),
        include: ['documents', 'metadatas', 'distances']
      }
    });

    return JSON.parse(result.content[0].text);
  }

  extractSqliteIds(chromaResult: ChromaQueryResult): number[] {
    // Extract unique sqlite_id values from metadata
    const ids = new Set<number>();
    chromaResult.metadatas[0]?.forEach(meta => {
      if (meta.sqlite_id) ids.add(meta.sqlite_id);
    });
    return Array.from(ids);
  }

  async close(): Promise<void> {
    if (this.client) await this.client.close();
  }
}
```

---

### Step 2: Add Chroma Client to search-server.ts

**Location**: After SessionSearch/SessionStore initialization (line 28)

```typescript
import { ChromaOrchestrator } from '../services/chroma/ChromaOrchestrator.js';

// Initialize search instances
let search: SessionSearch;
let store: SessionStore;
let chroma: ChromaOrchestrator;

try {
  search = new SessionSearch();
  store = new SessionStore();
  chroma = new ChromaOrchestrator();
  await chroma.connect();
  console.error('[search-server] Chroma MCP client connected');
} catch (error: any) {
  console.error('[search-server] Failed to initialize:', error.message);
  process.exit(1);
}
```

---

### Step 3: Implement get_recent_context Hybrid Workflow

**Replace handler at line 591** with:

```typescript
handler: async (args: any) => {
  try {
    const project = args.project || basename(process.cwd());
    const limit = args.limit || 10;

    // WORKFLOW 1: Temporal-First
    // Step 1: Get last 50 observations from SQLite (temporal boundary)
    const recentObs = store.db.prepare(`
      SELECT id, title, created_at_epoch, narrative
      FROM observations
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT 50
    `).all(project) as any[];

    if (recentObs.length === 0) {
      return { /* no results response */ };
    }

    // Step 2: Score by semantic relevance via Chroma
    const obsIds = recentObs.map(o => o.id);
    const chromaResult = await chroma.queryDocuments(
      project, // semantic focus on project context
      50,
      { sqlite_id: { $in: obsIds } }
    );

    // Step 3: Extract top N by semantic score
    const rankedIds = chroma.extractSqliteIds(chromaResult).slice(0, limit);

    // Step 4: Get full records from SQLite in temporal order
    const finalResults = store.db.prepare(`
      SELECT * FROM observations
      WHERE id IN (${rankedIds.map(() => '?').join(',')})
      ORDER BY created_at_epoch DESC
    `).all(...rankedIds);

    // Format and return
    return formatResults(finalResults);
  } catch (error: any) {
    return { /* error response */ };
  }
}
```

---

### Step 4: Implement search_observations Hybrid Workflow

**Replace handler at line 286** with:

```typescript
handler: async (args: any) => {
  try {
    const { query, format = 'index', ...options } = args;

    // WORKFLOW 2: Semantic-First, Temporally-Bounded
    // Step 1: Semantic search via Chroma (top 100)
    const chromaResult = await chroma.queryDocuments(query, 100);

    if (chromaResult.ids[0].length === 0) {
      return { /* no results response */ };
    }

    // Step 2: Filter by recency (last 90 days)
    const ninetyDaysAgo = Date.now() - (90 * 24 * 60 * 60 * 1000);
    const recentIds = chroma.extractSqliteIds(chromaResult).filter(id => {
      const meta = chromaResult.metadatas[0].find(m => m.sqlite_id === id);
      return meta && meta.created_at_epoch > ninetyDaysAgo;
    });

    if (recentIds.length === 0) {
      return { /* no recent results response */ };
    }

    // Step 3: Hydrate from SQLite in temporal order
    const results = store.db.prepare(`
      SELECT * FROM observations
      WHERE id IN (${recentIds.map(() => '?').join(',')})
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(...recentIds, options.limit || 20);

    // Format and return
    return formatResults(results, format);
  } catch (error: any) {
    return { /* error response */ };
  }
}
```

---

### Step 5: Implement find_by_type Hybrid Workflow

**Replace handler at line 540** with:

```typescript
handler: async (args: any) => {
  try {
    const { type, format = 'index', ...filters } = args;

    // WORKFLOW 3: Metadata-First, Semantic-Enhanced
    // Step 1: Filter by type in SQLite
    const typeFilter = Array.isArray(type) ? type : [type];
    const typeResults = store.db.prepare(`
      SELECT id FROM observations
      WHERE type IN (${typeFilter.map(() => '?').join(',')})
      AND project = ?
    `).all(...typeFilter, filters.project || basename(process.cwd())) as any[];

    if (typeResults.length === 0) {
      return { /* no results response */ };
    }

    // Step 2: Rank by semantic relevance via Chroma
    const typeIds = typeResults.map(r => r.id);
    const chromaResult = await chroma.queryDocuments(
      filters.project || basename(process.cwd()),
      typeIds.length,
      { sqlite_id: { $in: typeIds } }
    );

    // Step 3: Get ranked IDs
    const rankedIds = chroma.extractSqliteIds(chromaResult)
      .slice(0, filters.limit || 20);

    // Step 4: Hydrate full records in semantic rank order
    const results = store.db.prepare(`
      SELECT * FROM observations
      WHERE id IN (${rankedIds.map(() => '?').join(',')})
      ORDER BY
        CASE id ${rankedIds.map((id, i) => `WHEN ${id} THEN ${i}`).join(' ')} END
    `).all(...rankedIds);

    // Format and return
    return formatResults(results, format);
  } catch (error: any) {
    return { /* error response */ };
  }
}
```

---

## Testing Checklist

1. **Temporal Ordering Verification**
   - Query: "context injection"
   - Verify: Results sorted by created_at_epoch DESC
   - Check: No old results ranked higher than recent ones

2. **Semantic Quality**
   - Query: "How does the worker service work?"
   - Verify: Returns conceptually relevant results
   - Compare: Better than FTS5 keyword search

3. **Metadata Filtering**
   - Query: find_by_type("decision", query="PM2 configuration")
   - Verify: Only decisions returned
   - Check: Ranked by semantic relevance to PM2

4. **Recency Boundaries**
   - Query old content (>90 days)
   - Verify: Excluded from search_observations
   - Check: Available in find_by_type (no time filter)

---

## Key Design Decisions

### Why Temporal Boundaries Matter

Without temporal filtering, Chroma returns semantically perfect OLD matches over recent updates:

```
Query: "context injection problems"

Bad (semantic only):
- obs #2515 (Oct 24) - distance 0.77 ⭐ Best semantic match
- obs #2543 (Oct 26) - distance 0.98 ← Newer but ranked lower!

Good (semantic + temporal):
- obs #2543 (Oct 26) - Most recent relevant match ✓
- obs #2515 (Oct 24) - Older but still relevant
```

### Why MCP-to-MCP Architecture

- Reuses existing Chroma MCP server (already configured)
- No new dependencies (chromadb library not needed)
- Consistent with claude-mem's plugin architecture
- Easy to test/debug (can inspect Chroma MCP separately)

### Why No Fallbacks

Fallbacks create ambiguity. Each tool should have ONE optimal workflow that ALWAYS produces the best result for its use case. No mode parameters, no optional behaviors.

---

## Next Session Checklist

- [ ] Create `src/services/chroma/ChromaOrchestrator.ts`
- [ ] Add Chroma client init to `search-server.ts`
- [ ] Implement `get_recent_context` hybrid workflow
- [ ] Implement `search_observations` hybrid workflow
- [ ] Implement `find_by_type` hybrid workflow
- [ ] Implement `find_by_concept` hybrid workflow (same as find_by_type)
- [ ] Implement `find_by_file` hybrid workflow (same as find_by_type)
- [ ] Test temporal ordering
- [ ] Test semantic quality
- [ ] Build and deploy

---

## Collection Name

**Important**: The Chroma collection is `cm__claude-mem` (confirmed by sync experiment).
