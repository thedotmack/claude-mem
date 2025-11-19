# Chroma Search API Summary

**Status**: Cloud-only (not yet available for local deployments)
**Date Reviewed**: November 19, 2025

## Overview

Chroma has introduced a new Search API that provides a unified, expression-based interface for hybrid search operations. This replaces the previous separate `query()` and `get()` methods with a more powerful, composable approach.

## Key Features

### 1. Unified Interface
- Single `search()` method replaces both `query()` and `get()`
- Consistent API across all search operations
- Reduces cognitive overhead and API surface area

### 2. Expression-Based Queries
```python
# K() expressions for powerful filtering
Search()
  .where((K("category") == "science") & (K("year") >= 2020))
  .limit(5)
  .select(K.DOCUMENT, K.SCORE, "title", "author")
```

### 3. Composable Operations
- Chain methods naturally: `.where()` → `.limit()` → `.select()` → `.rank()`
- Build complex queries incrementally
- Reuse base query patterns

### 4. Type Safety
- Full type hints for IDE autocomplete
- Clear error messages
- Better developer experience

### 5. Advanced Capabilities
- **Hybrid search with RRF** (Reciprocal Rank Fusion)
- **Custom ranking expressions** for fine-tuned relevance
- **Batch operations** to reduce round trips
- **Flexible field selection** to minimize payload size

### 6. Dual Query Modes
```python
# Option 1: Pre-computed embeddings
result = collection.search(search.rank(Knn(query=embedding)))

# Option 2: Text query (auto-embedded using collection schema)
result = collection.search(search.rank(Knn(query="your text")))
```

## Feature Comparison

| Feature | Old `query()` | Old `get()` | New `search()` |
|---------|---------------|-------------|----------------|
| Vector similarity | ✅ | ❌ | ✅ |
| Metadata filtering | ✅ | ✅ | ✅ |
| Custom ranking | ❌ | ❌ | ✅ |
| Batch operations | ⚠️ Embedding only | ❌ | ✅ |
| Field selection | ⚠️ Coarse | ⚠️ Coarse | ✅ Fine-grained |
| Pagination | ❌ | ✅ | ✅ |
| Type safety | ⚠️ Partial | ⚠️ Partial | ✅ Full |

## Example Usage

```python
from chromadb import Search, K, Knn, Rrf

# Build base search
search = (
    Search()
    .where((K("category") == "science") & (K("year") >= 2020))
    .limit(5)
    .select(K.DOCUMENT, K.SCORE, "title", "author")
)

# Execute with KNN ranking
result = collection.search(
    search.rank(Knn(query="quantum computing breakthroughs"))
)

# Access results
rows = result.rows()[0]
for row in rows:
    print(f"{row['metadata']['title']}: {row['score']:.3f}")
```

## Critical Limitation

**⚠️ Cloud-Only Availability**

The Search API is currently **only available in Chroma Cloud**. Support for single-node (local) Chroma deployments is planned but not yet available.

This means:
- Cannot be used with local Chroma instances today
- Requires migration to Chroma Cloud to adopt
- Timeline for local support is unclear

## Potential Benefits for claude-mem

### If Local Support Becomes Available:

1. **Simplified Search Implementation**
   - Replace multiple query patterns with unified interface
   - Reduce code complexity in `ChromaSync.ts`

2. **Enhanced Hybrid Search**
   - Built-in RRF (Reciprocal Rank Fusion) for combining results
   - Currently we implement hybrid search manually with SQLite FTS5 + Chroma

3. **Better Filtering**
   - K() expressions more powerful than current metadata filters
   - Complex boolean logic: `(K("type") == "bugfix") & (K("date") >= "2025-01")`

4. **Batch Search Operations**
   - Search multiple queries in single request
   - Useful for mem-search skill when fetching multiple observation types

5. **Payload Optimization**
   - Select only needed fields: `.select(K.DOCUMENT, K.SCORE, "title")`
   - Reduce token usage when retrieving observations
   - Currently we retrieve full records and filter client-side

6. **Custom Ranking**
   - Weight recency vs relevance programmatically
   - Currently our 90-day filter is binary (in/out)
   - Could implement gradual decay: `K.SCORE * (1 - age_in_days/365)`

## Implementation Considerations

### Migration Path (if adopted)

1. **Dual Implementation Period**
   - Keep existing ChromaSync methods
   - Add new Search API wrapper alongside
   - Migrate incrementally

2. **Testing Strategy**
   - Compare results between old and new APIs
   - Validate ranking quality
   - Benchmark performance

3. **Breaking Changes**
   - Result structure may differ
   - Update mem-search skill endpoints
   - Update viewer UI if search contracts change

### Risks

1. **Cloud Lock-in**: Using Chroma Cloud creates dependency
2. **Local Development**: Can't use new API in local testing
3. **Migration Effort**: Non-trivial code changes required
4. **Timeline Uncertainty**: No clear ETA for local support

## Recommendation

**Wait for local support announcement** before investing in migration effort.

### Monitor For:
- Chroma GitHub releases announcing local Search API support
- Community feedback on Search API performance and stability
- Pricing implications if considering Chroma Cloud migration

### When Local Support Arrives:
- Prototype in `feature/search-api-exploration` branch
- Benchmark against current hybrid search implementation
- Measure token savings from field selection
- Evaluate RRF quality vs current approach

## References

- [Chroma Search API Overview](https://docs.trychroma.com/guides/search-api/overview)
- [Chroma GitHub](https://github.com/chroma-core/chroma)
- Current implementation: `src/services/sync/ChromaSync.ts`
