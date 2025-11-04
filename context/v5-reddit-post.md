# Claude-mem v5.0: I Fixed Vector Search's Time Blindness

Vector databases are amazing at finding similar content. Terrible at knowing *when* that content matters.

I just shipped claude-mem v5.0 with hybrid search—semantic relevance meets temporal context. Sub-200ms queries across 8,200+ vectors.

## The Problem With Pure Vector Search

You search for "authentication bug" in your ChromaDB. It returns:
- That auth refactor from 6 months ago (highly similar!)
- Login flow changes from last year (perfect match!)
- The actual bug you fixed yesterday (similar, but not as close semantically)

All semantically relevant. Chronologically useless.

Vector search finds *what* matches. Doesn't understand *when* it matters.

## v4.x Had the Opposite Problem

SQLite FTS5 keyword search. Fast. Reliable. Token-efficient.

But it only matched exact keywords. "authentication bug" wouldn't find "login validation error" even though they're the same concept.

You had to remember your exact wording from weeks ago. Good luck with that.

## v5.0: Hybrid Search Pipeline

```
Query → Chroma Semantic Search (top 100)
      → 90-day Recency Filter
      → SQLite Temporal Hydration
      → Chronologically Ordered Results
```

**What this means:**

1. **Chroma finds conceptually relevant matches** - "auth bug" matches "login validation error", "session timeout issue", "credential handling problem"

2. **90-day window filters to recent context** - Last 2-3 months of active work, automatically excludes stale results

3. **SQLite provides temporal ordering** - Results flow chronologically, showing how problems evolved and got solved

4. **Timeline reconstruction** - See the session where you hit the bug, the discovery observation, the fix, and what came next

## Example: Natural Language Timeline Search

New tool: `get_timeline_by_query`

**Auto mode** (search → instant timeline):
```
Query: "ChromaDB performance issues"

Found: Observation #3401 (Oct 28, 8:42 PM)
Title: "ChromaSync batch processing optimization"

Timeline (depth_before=10, depth_after=10):
├─ [10 records before] Session context, related observations
├─ [ANCHOR] The performance fix observation
└─ [10 records after] Test results, follow-up changes

Total: 21 records in chronological order
Response: <200ms
```

**Interactive mode** (pick your anchor):
```
Query: "authentication refactor"

Top 5 matches:
#3156 - "JWT token validation overhaul" (Oct 15)
#3089 - "Session middleware refactor" (Oct 12)
#2947 - "OAuth integration changes" (Oct 8)
...

Choose anchor → Get timeline → See full context
```

## Performance: The Numbers

- **1,390 observations** synced to **8,279 vector documents**
- **Semantic search**: <200ms for top 100 matches
- **90-day filter + temporal hydration**: Negligible overhead
- **Total query time**: <200ms end-to-end

This scales. I'm not searching 8K vectors every time—the 90-day window typically narrows to 500-800 recent documents before Chroma even sees them.

## ChromaSync: Automatic Vector Maintenance

New background service that syncs your SQLite data to Chroma:

- **Splits observations** into narrative + facts vectors (better semantic granularity)
- **Splits summaries** into request + learned vectors
- **Indexes user prompts** as single vectors
- **Runs automatically** via PM2 worker service
- **Metadata filtering** by project, type, concepts, files

Example: One observation → Multiple vectors for precise matching.

Your 500-word debugging narrative? Split into semantic chunks. Query matches the relevant section, not just "the whole document is kinda related."

## Graceful Fallback

No Python? No problem.

System detects missing Chroma and falls back to FTS5 keyword search. Same API, same tools, slightly less magical semantic matching.

You lose semantic understanding but keep full functionality. All 9 MCP search tools still work.

## All 9 Search Tools Now Hybrid

Every search method got the upgrade:

1. **search_observations** - Hybrid semantic + keyword across observations
2. **search_sessions** - Hybrid across session summaries
3. **search_user_prompts** - Hybrid across raw user input
4. **find_by_concept** - Filter by tags + semantic similarity
5. **find_by_file** - File references + semantic context
6. **find_by_type** - Type filter + semantic relevance
7. **get_recent_context** - Temporal only (no search needed)
8. **get_context_timeline** - Timeline around anchor point
9. **get_timeline_by_query** - Natural language timeline search

## Why This Matters

**Before v5.0:**
- "Show me auth bugs" → Exact keyword match only
- Miss semantically similar issues with different wording
- No temporal context about when/how issues evolved

**After v5.0:**
- "Show me auth bugs" → Finds authentication, login, session, credential issues
- Filtered to last 90 days automatically
- Results in chronological order showing problem evolution
- Timeline reconstruction shows full context

Claude doesn't just find relevant information. Claude sees *when* it happened and what came next.

## Migration

Zero breaking changes. Your existing SQLite data continues working.

**Optional upgrade** for semantic search:
```bash
# Install Chroma MCP server (requires Python 3.8+)
# Instructions in repo README

# That's it. ChromaSync detects Chroma and syncs automatically.
```

First sync takes ~30 seconds for 1,400 observations. After that, incremental syncs are near-instant.

## The Paradox Continues

v5.0's hybrid search is so good that Claude *still* rarely needs to search.

The context-hook's 50-observation startup context usually has everything. But when Claude needs something from 6 weeks ago? Semantic search + timeline reconstruction gets it instantly.

No keyword guessing. No re-reading code. Just: ask in natural language, get chronological context, keep coding.

## Install

```bash
# In Claude Code:
/plugin marketplace add thedotmack/claude-mem
/plugin install claude-mem

# Optional: Install Python + Chroma for semantic search
# Falls back to keyword search if you don't
```

**Repo:** https://github.com/thedotmack/claude-mem

claude-mem v5.0 combines the semantic magic of vector search with the temporal clarity of chronological ordering.

Finally: relevance *and* context. In under 200ms.

Anyone else built hybrid search systems? How did you handle the time dimension?
