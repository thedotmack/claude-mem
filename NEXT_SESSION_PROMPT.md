# Prompt for Next Session: Hybrid Search Implementation

Copy this entire prompt into a new Claude Code session to continue the hybrid search feature implementation.

---

## Context

I'm working on the `claude-mem` project (persistent memory system for Claude Code). I have an experimental branch `experiment/chroma-mcp` that attempted to add semantic search via ChromaDB, but it has implementation issues and was done in the wrong order.

**Current Status:**
- ✅ Experiment validated: Semantic search (Chroma) + temporal filtering (SQLite) works
- ✅ Chroma collection `cm__claude-mem` has 2,800+ documents synced
- ✅ Search quality tests show semantic search provides value
- ❌ Production implementation has issues (dead code, uncommitted fixes, wrong process)
- ✅ Feature plan written and ready to execute

**Your Task:**
Follow the feature implementation plan in `FEATURE_PLAN_HYBRID_SEARCH.md` to implement hybrid search correctly from the ground up.

---

## Immediate Actions

1. **Read the feature plan:**
   ```
   Read: /Users/alexnewman/Scripts/claude-mem/FEATURE_PLAN_HYBRID_SEARCH.md
   ```

2. **Understand the experiment results:**
   - The experiment scripts work correctly
   - Chroma semantic search is functional
   - We just need to implement it properly in production

3. **Execute Phase 1 of the plan:**
   - Create new `feature/hybrid-search` branch from `main`
   - Port working experiment scripts from `experiment/chroma-mcp`
   - Clean up any dead code references

---

## Key Principles for This Implementation

1. **Start clean:** New branch from `main`, no baggage from failed attempt
2. **No abstractions:** Direct MCP client usage, no ChromaOrchestrator wrapper
3. **Validate at each step:** Don't commit until you've tested it works
4. **Proper parsing:** Chroma MCP returns Python dicts, not JSON - use regex parsing
5. **Temporal boundaries:** 90-day filter prevents stale semantic matches

---

## Files You'll Need to Work With

**Core Implementation:**
- `src/servers/search-server.ts` - Add hybrid search workflows
- `src/services/sync/ChromaSync.ts` - NEW: Auto-sync observations to Chroma
- `src/services/worker-service.ts` - Integrate auto-sync
- `src/shared/paths.ts` - Add VECTOR_DB_DIR constant

**Experiment Files (keep these, they work):**
- `experiment/chroma-sync-experiment.ts` - Manual sync tool
- `experiment/chroma-search-test.ts` - Search quality validator

**Files to DELETE (dead code from failed attempt):**
- `src/services/chroma/ChromaOrchestrator.ts` - Broken wrapper, never used
- `test-chroma-connection.ts` - Uses broken ChromaOrchestrator
- `plugin/scripts/search-server.cjs` - Stale CommonJS build

---

## Validation Checklist

Before committing any code, verify:

```bash
# 1. Build succeeds
npm run build

# 2. Sync works
npx tsx experiment/chroma-sync-experiment.ts

# 3. Search works
npx tsx experiment/chroma-search-test.ts

# 4. MCP server starts
node plugin/scripts/search-server.js
# (Ctrl+C to stop)

# 5. No dead code
grep -r "ChromaOrchestrator" src/  # Should return nothing

# 6. No stale builds
ls plugin/scripts/search-server.cjs  # Should not exist

# 7. Git status clean
git status  # No uncommitted changes to production files
```

---

## Implementation Workflow (from Phase 3 of plan)

### Step 1: Add queryChroma Helper
In `src/servers/search-server.ts`, add a helper function that:
- Takes: `query: string, limit: number, whereFilter?: object`
- Calls: `chromaClient.callTool({ name: 'chroma_query_documents', ... })`
- Parses: Python dict response with regex (see lines 256-318 in current branch for example)
- Returns: `{ ids: number[], distances: number[], metadatas: any[] }`

### Step 2: Initialize Chroma Client
In `main()` function:
```typescript
const chromaTransport = new StdioClientTransport({
  command: 'uvx',
  args: ['chroma-mcp', '--client-type', 'persistent', '--data-dir', VECTOR_DB_DIR]
});
chromaClient = new Client({ name: 'claude-mem-search-chroma-client', version: '1.0.0' }, { capabilities: {} });
await chromaClient.connect(chromaTransport);
```

### Step 3: Update search_observations Handler
Replace FTS5 keyword search with:
1. Chroma semantic search (top 100)
2. Filter by recency (90 days)
3. Hydrate from SQLite in temporal order
4. Return results

### Step 4: Update Metadata Search Handlers
For `find_by_concept`, `find_by_type`, `find_by_file`:
1. SQLite metadata filter first
2. Chroma semantic ranking second
3. Preserve semantic rank order in results

---

## Expected Timeline

- Phase 1 (Clean Start): 15 minutes
- Phase 2 (Architecture Review): Already done, read the plan
- Phase 3 (Implementation): 2-3 hours
- Phase 4 (Validation): 1 hour
- Phase 5 (Documentation): 1 hour
- Phase 6 (Deployment): 30 minutes

**Total: ~5-6 hours**

---

## Questions to Ask Me

If you encounter any issues:

1. "The Chroma MCP client isn't connecting" → Check if `uvx chroma-mcp` is available
2. "Parsing errors from Chroma responses" → Show me the response format, I'll help fix regex
3. "Not sure about the search workflow logic" → Reference Phase 2.2 in the plan
4. "Should I commit now?" → Only if validation checklist passes
5. "Merge to main or PR?" → I'll decide, just get to Phase 6 first

---

## Success Criteria

Don't merge until ALL of these are true:

- ✅ Sync experiment completes without errors
- ✅ Search test shows Chroma returning relevant results
- ✅ MCP server starts and responds to queries
- ✅ Fallback to FTS5 works if Chroma unavailable
- ✅ No breaking changes to MCP tool interfaces
- ✅ Documentation updated (CLAUDE.md + release notes)
- ✅ No uncommitted changes in git status
- ✅ No dead code (ChromaOrchestrator removed)
- ✅ No stale build artifacts (.cjs files deleted)

---

## Start Here

```
1. Read the feature plan:
   Read: /Users/alexnewman/Scripts/claude-mem/FEATURE_PLAN_HYBRID_SEARCH.md

2. Create the feature branch:
   Bash: git checkout main && git pull && git checkout -b feature/hybrid-search

3. Begin Phase 1 of the plan (porting experiment scripts)

4. Work through each phase systematically, validating at each step

5. Ask me questions if anything is unclear
```

Let's build this correctly, from the ground up. Take your time and validate at each step.
