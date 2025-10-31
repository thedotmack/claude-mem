# Chroma MCP Experiment

This directory contains experimental scripts to test semantic search via ChromaDB without modifying production code.

## Files

- **chroma-sync-experiment.ts** - Syncs SQLite observations/summaries to ChromaDB via Chroma MCP tools
- **chroma-search-test.ts** - Compares semantic search (Chroma) vs keyword search (FTS5)
- **RESULTS.md** - Document findings and make decision on production integration

## Prerequisites

1. Chroma MCP server configured in Claude settings
2. Running: `uvx chroma-mcp --client-type persistent --data-dir ~/.claude-mem/vector-db`

## Running the Experiment

### Step 1: Sync Data
```bash
npx tsx experiment/chroma-sync-experiment.ts
```

This will:
- Connect to your Chroma MCP server
- Create collection `cm__claude-mem`
- Sync all observations and sessions from SQLite
- Report sync statistics

### Step 2: Test Search
```bash
npx tsx experiment/chroma-search-test.ts
```

This will:
- Run 8 test queries (4 semantic, 4 keyword)
- Compare Chroma semantic search vs FTS5 keyword search
- Display results side-by-side

### Step 3: Document Results
Edit `RESULTS.md` with your findings:
- Which queries worked better with semantic search?
- Which worked better with keyword search?
- Is hybrid search worth the complexity?

## Decision Point

Based on results:
- **If semantic search provides significant value**: Design production integration
- **If FTS5 is sufficient**: Keep current implementation, document why

## Note

This is a **pure experiment** - no production code changes. All scripts are self-contained in this directory.
