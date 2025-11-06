# Chroma Vector Database - Hybrid Semantic Search

## Overview

Claude-Mem v5.0.0 introduced **Chroma**, a vector database that enables semantic search across your memory stream. Combined with SQLite's FTS5 keyword search, this creates a powerful **hybrid search architecture** that finds contextually relevant observations using both meaning and keywords.

**Key Benefits:**
- 🧠 **Semantic Search** - Find observations by meaning, not just keywords
- 🔍 **Hybrid Architecture** - Combines semantic similarity with keyword matching
- ⏱️ **Recency Filtering** - Focus on recent 90 days for relevant context
- ⚡ **Fast Performance** - Semantic search under 200ms with 8,000+ documents
- 🔄 **Auto-Sync** - ChromaSync service keeps vectors updated automatically

## What is Chroma?

[ChromaDB](https://www.trychroma.com/) is an open-source vector database designed for AI applications. It stores text as **vector embeddings** - mathematical representations that capture semantic meaning.

**Example:**
```
Query: "authentication bug"
Keyword Match: Must contain both "authentication" AND "bug"
Semantic Match: Also finds "login error", "auth failure", "sign-in issue"
```

Semantic search understands that "authentication bug" is conceptually similar to "login error" even though they share no keywords.

## Architecture

### Hybrid Search Flow

```
┌──────────────────────────────────────────────────────────────┐
│ User Query: "How does authentication work?"                  │
└──────────────────────────────────────────────────────────────┘
                            ↓
          ┌─────────────────┴─────────────────┐
          ↓                                   ↓
┌──────────────────────┐          ┌──────────────────────┐
│ Chroma Semantic      │          │ SQLite FTS5          │
│ Vector Similarity    │          │ Keyword Search       │
│                      │          │                      │
│ Finds conceptually   │          │ Finds exact/fuzzy    │
│ similar observations │          │ keyword matches      │
└──────────────────────┘          └──────────────────────┘
          ↓                                   ↓
          └─────────────────┬─────────────────┘
                            ↓
          ┌─────────────────────────────────┐
          │ Merge Results                   │
          │ - Deduplicate by ID             │
          │ - Sort by relevance + recency   │
          │ - Filter by 90-day window       │
          └─────────────────────────────────┘
                            ↓
          ┌─────────────────────────────────┐
          │ Return Top Matches              │
          │ Semantic + Keyword combined     │
          └─────────────────────────────────┘
```

### ChromaSync Service

The **ChromaSync** service (`src/services/sync/ChromaSync.ts`) automatically synchronizes observations to Chroma:

**When Observations Are Synced:**
1. **Session Summary** - After each session completes, all new observations synced
2. **Worker Startup** - On initialization, checks for unsynced observations
3. **Manual Trigger** - Can force sync via internal API (development only)

**What Gets Embedded:**
- Observation ID (unique identifier)
- Title (compressed learning statement)
- Narrative (detailed explanation)
- Project path (for project-specific filtering)
- Timestamp (for recency filtering)
- Concepts (semantic tags)
- File references (associated code files)

**Embedding Model:**
- Currently using Chroma's default embedding function
- Future: Configurable embedding models (e.g., OpenAI, sentence-transformers)

### Data Structure

**SQLite (Source of Truth):**
```sql
CREATE TABLE observations (
  id INTEGER PRIMARY KEY,
  title TEXT,
  narrative TEXT,
  facts TEXT,
  concepts TEXT,
  files TEXT,
  type TEXT,
  projectPath TEXT,
  createdAt INTEGER
);
```

**Chroma (Vector Embeddings):**
```typescript
{
  ids: ["obs_12345"],
  embeddings: [[0.123, -0.456, ...]], // 384-dimensional vector
  documents: ["Title: Authentication flow\nNarrative: Implemented..."],
  metadatas: [{
    type: "feature",
    project: "claude-mem",
    timestamp: 1698765432000,
    concepts: "pattern,architecture"
  }]
}
```

## How Semantic Search Works

### Vector Embeddings

Text converted to high-dimensional vectors that capture meaning:

```
"user authentication" → [0.12, -0.34, 0.56, ..., 0.78]
"login system"        → [0.15, -0.32, 0.54, ..., 0.81]
"database schema"     → [-0.45, 0.67, -0.23, ..., 0.12]
```

Notice: "user authentication" and "login system" have similar vectors (close in vector space), while "database schema" is distant.

### Similarity Search

Chroma uses **cosine similarity** to find nearest neighbors:

```typescript
// Query embedding
query: "authentication bug"
query_vector: [0.14, -0.33, 0.55, ..., 0.79]

// Find observations with similar vectors
results = chroma.query(
  query_vector,
  n_results: 10,
  where: { timestamp: { $gte: now - 90_days } }
)
```

**Result Ranking:**
- Higher cosine similarity = more semantically similar
- Filtered by 90-day recency window
- Combined with keyword matches from FTS5

## 90-Day Recency Filtering

Why 90 days?

**Rationale:**
- Recent context more likely relevant to current work
- Prevents very old observations from diluting results
- Balances completeness with relevance
- Reduces vector search space for faster queries

**Implementation:**
```typescript
const ninetyDaysAgo = Date.now() - (90 * 24 * 60 * 60 * 1000);

// Chroma metadata filter
where: {
  timestamp: { $gte: ninetyDaysAgo }
}

// SQLite WHERE clause
WHERE createdAt >= ?
```

**Configurable?**
- Not currently user-configurable
- Hard-coded in `src/servers/search-server.ts`
- Future: Add `CLAUDE_MEM_RECENCY_DAYS` environment variable

## MCP Tool Integration

All 9 MCP search tools benefit from hybrid search:

### search_observations (Hybrid)

```typescript
// Keyword-only (v4.x)
search_observations(query: "authentication")
// Returns: Observations containing "authentication"

// Hybrid semantic + keyword (v5.x)
search_observations(query: "authentication")
// Returns: Observations with "authentication" PLUS semantically similar:
//   - "login system"
//   - "user credentials"
//   - "session management"
```

### get_timeline_by_query (Semantic-First)

```typescript
// Uses Chroma to find best match, then builds timeline
get_timeline_by_query(
  query: "when did we implement the viewer UI?",
  mode: "auto",
  depth_before: 10,
  depth_after: 10
)

// Chroma finds: Observation #4057 "Web-Based Viewer UI for Real-Time Memory Stream"
// Returns: Timeline with 10 observations before + anchor + 10 after
```

### Benefits Across All Tools

- **find_by_concept**: Semantic similarity finds related concepts
- **find_by_file**: Finds semantically similar code changes
- **find_by_type**: Better relevance ranking within type
- **get_recent_context**: Prioritizes semantically relevant recent context

## Performance

### Benchmarks (8,279 vector documents)

| Operation | Time | Notes |
|-----------|------|-------|
| **Semantic Query** | 150-200ms | 90-day window, top 10 results |
| **Keyword Query (FTS5)** | 5-10ms | Full-text search |
| **Hybrid Query** | 160-220ms | Combined semantic + keyword |
| **Initial Sync** | 2-5 min | First-time embedding of all observations |
| **Incremental Sync** | 100-500ms | 1-10 new observations per session |

### Memory Usage

- **Chroma DB Size**: ~50MB for 8,000 observations
- **Embeddings**: 384 dimensions × 4 bytes = 1.5KB per observation
- **Metadata**: ~500 bytes per observation (project, type, timestamp)
- **Total**: ~2KB per observation in Chroma

### Optimization Tips

1. **Reduce vector dimensions**: Use smaller embedding models (future)
2. **Adjust recency window**: Narrow to 30/60 days for faster queries
3. **Limit result count**: Request fewer results (n_results=5 vs 10)
4. **Project filtering**: Add project filter to metadata query

## Installation & Dependencies

### Python Requirement

Chroma requires Python 3.7+ installed:

**Check Python:**
```bash
python3 --version
# Should show: Python 3.7.x or higher
```

**Install Python (if needed):**
- **macOS**: `brew install python3`
- **Windows**: Download from [python.org](https://www.python.org/downloads/)
- **Linux**: `apt-get install python3` or `yum install python3`

### ChromaDB Installation

Chroma installed automatically as npm dependency:

```bash
npm install
# Installs: chromadb (Python package via node-gyp bindings)
```

**Manual Installation (if auto-install fails):**
```bash
pip3 install chromadb
```

### Troubleshooting Installation

**Error: "Python not found"**
```bash
# Set Python path explicitly
export PYTHON=/usr/local/bin/python3
npm install
```

**Error: "chromadb module not found"**
```bash
# Reinstall chromadb
pip3 install --upgrade chromadb

# Verify installation
python3 -c "import chromadb; print(chromadb.__version__)"
```

**Error: "node-gyp build failed"**
```bash
# Install build tools
# macOS: xcode-select --install
# Windows: npm install --global windows-build-tools
# Linux: apt-get install build-essential
```

## Configuration

### Environment Variables

Currently no user-configurable settings. Future options:

```json
// Proposed for future versions
{
  "env": {
    "CLAUDE_MEM_CHROMA_ENABLED": "true",          // Enable/disable Chroma
    "CLAUDE_MEM_CHROMA_PATH": "~/.claude-mem/chroma", // DB location
    "CLAUDE_MEM_EMBEDDING_MODEL": "default",       // Embedding model choice
    "CLAUDE_MEM_RECENCY_DAYS": "90",              // Recency window
    "CLAUDE_MEM_VECTOR_DIM": "384"                // Embedding dimensions
  }
}
```

### Disabling Chroma (Future)

To disable semantic search and use keyword-only:

```json
{
  "env": {
    "CLAUDE_MEM_CHROMA_ENABLED": "false"
  }
}
```

Falls back to SQLite FTS5 keyword search only.

## Database Maintenance

### Location

```
~/.claude-mem/chroma/
├── chroma.sqlite3         # Chroma metadata database
└── index/                 # Vector index files
    └── *.bin              # Binary vector data
```

### Backup

```bash
# Backup entire Chroma directory
cp -r ~/.claude-mem/chroma ~/.claude-mem/chroma.backup

# Restore from backup
rm -rf ~/.claude-mem/chroma
cp -r ~/.claude-mem/chroma.backup ~/.claude-mem/chroma
```

### Reset Chroma (Force Resync)

```bash
# Delete Chroma database
rm -rf ~/.claude-mem/chroma

# Restart worker to trigger full resync
npm run worker:restart

# Check logs for sync progress
npm run worker:logs
```

**Note**: Resync can take 2-5 minutes for thousands of observations.

### Disk Space Management

**Chroma grows with observations:**
- 1,000 observations ≈ 5MB
- 10,000 observations ≈ 50MB
- 100,000 observations ≈ 500MB

**Cleanup old observations:**
```sql
-- Delete observations older than 1 year
-- This will trigger Chroma resync on next startup
sqlite3 ~/.claude-mem/claude-mem.db \
  "DELETE FROM observations WHERE createdAt < strftime('%s', 'now', '-1 year') * 1000;"
```

## Advanced Usage

### Direct Chroma Queries (Development)

For debugging or custom queries:

```typescript
import { ChromaSync } from './services/sync/ChromaSync';

const sync = new ChromaSync();
await sync.initialize();

// Query Chroma directly
const results = await sync.query({
  queryTexts: ["authentication implementation"],
  nResults: 10,
  where: {
    type: "feature",
    timestamp: { $gte: Date.now() - 90_days }
  }
});

console.log(results.ids, results.distances, results.documents);
```

### Custom Embedding Models (Future)

Chroma supports multiple embedding models:

```typescript
// Future configuration
const sync = new ChromaSync({
  embeddingModel: "sentence-transformers/all-MiniLM-L6-v2", // Smaller, faster
  // or: "text-embedding-ada-002" (OpenAI, requires API key)
  // or: "all-mpnet-base-v2" (Higher quality, slower)
});
```

### Metadata Filtering

Chroma supports advanced metadata queries:

```typescript
// Find observations by type and project
results = await sync.query({
  queryTexts: ["API design"],
  where: {
    $and: [
      { type: { $in: ["decision", "feature"] } },
      { project: "claude-mem" }
    ]
  }
});

// Find recent observations
results = await sync.query({
  queryTexts: ["database schema"],
  where: {
    timestamp: { $gte: Date.now() - 30_days }
  }
});
```

## Comparison: Semantic vs Keyword Search

| Aspect | Semantic (Chroma) | Keyword (FTS5) |
|--------|-------------------|----------------|
| **Speed** | 150-200ms | 5-10ms |
| **Accuracy** | High (meaning-based) | Medium (exact match) |
| **Storage** | ~2KB per observation | ~500 bytes per observation |
| **Conceptual Matching** | ✅ Yes | ❌ No |
| **Exact Match** | ❌ Not guaranteed | ✅ Always |
| **Typo Tolerance** | ✅ High | ⚠️ Limited (fuzzy) |
| **Dependencies** | Python + chromadb | None (SQLite built-in) |
| **Recency Bias** | ✅ Built-in (90 days) | Manual filtering |

**Best Practice:** Use hybrid search (both) for optimal results.

## Troubleshooting

### "Chroma not found" Error

**Symptom:** Worker logs show "Chroma not available, using keyword-only search"

**Solution:**
```bash
# Check Python installation
python3 --version

# Reinstall chromadb
pip3 install chromadb

# Restart worker
npm run worker:restart
```

### Slow Query Performance

**Symptom:** Searches taking >1 second

**Solutions:**
1. Reduce recency window (edit `src/servers/search-server.ts`)
2. Limit result count (`nResults: 5` instead of 10)
3. Add project filter to narrow search space
4. Check Chroma index size (may need rebuild)

### Out of Memory Errors

**Symptom:** Worker crashes with "JavaScript heap out of memory"

**Solution:**
```bash
# Increase Node.js heap size
export NODE_OPTIONS="--max-old-space-size=4096"

# Restart worker
npm run worker:restart
```

### Sync Taking Too Long

**Symptom:** Initial Chroma sync takes >10 minutes

**Possible Causes:**
- Large number of observations (>10,000)
- Slow embedding model
- Limited CPU resources

**Solutions:**
1. Let it complete (one-time cost)
2. Delete very old observations to reduce count
3. Close resource-intensive apps during sync

## Future Enhancements

Potential improvements for future versions:

- **Configurable Recency**: User-defined recency window (30/60/90/365 days)
- **Custom Embeddings**: Choose embedding model (quality vs speed trade-off)
- **Incremental Updates**: Update existing vectors instead of full resync
- **Semantic Filters**: Search by semantic concept ("all architectural decisions")
- **Multi-Language Support**: Embeddings optimized for non-English code/docs
- **Clustering**: Auto-cluster related observations for discovery
- **Visualization**: 2D/3D visualization of vector space (similar observations near each other)

## Resources

- **ChromaDB Documentation**: https://docs.trychroma.com/
- **Source Code**: `src/services/sync/ChromaSync.ts`
- **Search Server**: `src/servers/search-server.ts`
- **Python Package**: https://pypi.org/project/chromadb/

---

**Powered by ChromaDB** | **Hybrid Semantic + Keyword Search** | **90-Day Recency Window**
