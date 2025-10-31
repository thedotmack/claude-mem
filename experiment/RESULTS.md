# Chroma MCP Experiment Results

## Objective
Test whether semantic search via ChromaDB (accessed through Chroma MCP) provides better results than pure keyword search (SQLite FTS5) for claude-mem's search functionality.

## Setup
- **Semantic Search**: ChromaDB via existing Chroma MCP server (`uvx chroma-mcp`)
- **Keyword Search**: SQLite FTS5 (existing implementation)
- **Data**: Observations and session summaries from claude-mem project
- **Collection**: `cm__claude-mem`

## Test Queries

### 1. Conceptual Understanding
**Query**: "how does memory compression work"
**Expected Best**: Semantic

**Results**:
- Semantic (Chroma):
- Keyword (FTS5):

**Winner**:
**Notes**:

---

### 2. Similar Patterns
**Query**: "problems with database synchronization"
**Expected Best**: Semantic

**Results**:
- Semantic (Chroma):
- Keyword (FTS5):

**Winner**:
**Notes**:

---

### 3. Specific File
**Query**: "SessionStore.ts"
**Expected Best**: Keyword

**Results**:
- Semantic (Chroma):
- Keyword (FTS5):

**Winner**:
**Notes**:

---

### 4. Exact Function Name
**Query**: "getAllObservations"
**Expected Best**: Keyword

**Results**:
- Semantic (Chroma):
- Keyword (FTS5):

**Winner**:
**Notes**:

---

### 5. Technical Concept
**Query**: "FTS5 full text search implementation"
**Expected Best**: Both

**Results**:
- Semantic (Chroma):
- Keyword (FTS5):

**Winner**:
**Notes**:

---

### 6. User Intent
**Query**: "similar to context injection issues"
**Expected Best**: Semantic

**Results**:
- Semantic (Chroma):
- Keyword (FTS5):

**Winner**:
**Notes**:

---

### 7. Specific Error
**Query**: "NOT NULL constraint violation"
**Expected Best**: Keyword

**Results**:
- Semantic (Chroma):
- Keyword (FTS5):

**Winner**:
**Notes**:

---

### 8. Design Patterns
**Query**: "patterns for background worker processes"
**Expected Best**: Semantic

**Results**:
- Semantic (Chroma):
- Keyword (FTS5):

**Winner**:
**Notes**:

---

## Summary

### Semantic Search Wins
(Fill in which queries worked better with semantic search)

### Keyword Search Wins
(Fill in which queries worked better with keyword search)

### Tie
(Fill in which queries worked similarly)

## Performance Considerations
- Sync time:
- Query latency (Semantic):
- Query latency (Keyword):

## Decision

### Recommendation
[ ] Implement hybrid search in production
[ ] Keep FTS5-only (not worth the complexity)
[ ] Need more testing

### Rationale
(Explain decision based on test results)

### Next Steps
(If implementing hybrid search, outline the steps)
(If keeping FTS5-only, note any improvements we can make)
