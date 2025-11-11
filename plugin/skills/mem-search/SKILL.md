---
name: mem-search
description: Search claude-mem's persistent cross-session memory database to find work from previous conversations days, weeks, or months ago. Access past session summaries, bug fixes, feature implementations, and decisions that are NOT in the current conversation context. Use when user asks "did we already solve this?", "how did we do X last time?", "what happened in last week's session?", or needs information from previous sessions stored in the PM2-managed database. Searches observations, session summaries, and user prompts across entire project history.
---

# Memory Search

Access claude-mem's persistent cross-session memory through HTTP API. Find past work, understand context across sessions, and learn from previous decisions.

## When to Use This Skill

**Use when users ask about work from PREVIOUS sessions** (not current conversation):

### Temporal Triggers (Key Indicators)
- "Did we **already** fix this bug?" or "Have we seen this error **before**?"
- "How did we solve X **last time**?" or "What approach did we take **previously**?"
- "What did we do in **yesterday's/last week's/last month's** session?"
- "**When** did we last work on this?" or "What's the **history** of this file?"

### Cross-Session Queries
- "Show me all authentication-related changes **across all sessions**"
- "What features did we add **last month**?" (not "today" or "this session")
- "Why did we choose this approach **before**?" (decisions from past sessions)
- "What files did we modify **when we added X**?" (historical context)

**Do NOT use** for current session work, future planning, or questions Claude can answer from current conversation context.

## Common Trigger Phrases

This skill activates when detecting phrases about **cross-session history**:

- "Did we already solve this?" / "Have we done this before?"
- "How did we implement X last time?"
- "What did we work on yesterday/last week/last month?"
- "Show me the history of [file/feature/decision]"
- "When did we fix/add/change X?"
- "What was happening around [date/time]?"
- "Catch me up on recent sessions" / "What have we been doing?"
- "What changes to [filename] across all sessions?"

**Unique identifiers:** claude-mem, persistent memory, cross-session database, session history, PM2-managed database

## Available Operations

### Full-Text Search
- **observations** - Search all observations by keyword (bugs, features, decisions, discoveries, changes)
  - Use when: "How did we implement X?" or "What bugs did we fix?"
  - Example: Search for "authentication JWT" to find auth-related work

- **sessions** - Search session summaries to find what was accomplished when
  - Use when: "What did we accomplish last time?" or "What was the goal of that session?"
  - Example: Find sessions where "added login feature"

- **prompts** - Find what users have asked about in previous sessions
  - Use when: "Did I ask about this before?" or "What did I request last week?"
  - Example: Search for "database migration" in past user prompts

### Filtered Search
- **by-type** - Filter observations by type (bugfix, feature, refactor, decision, discovery, change)
  - Use when: "Show me all bug fixes" or "List features we added"
  - Example: Get all observations with type=bugfix from last month

- **by-concept** - Find observations tagged with specific concepts (problem-solution, how-it-works, gotcha)
  - Use when: "What patterns did we discover?" or "Show me gotchas"
  - Example: Find all observations tagged with concept "gotcha"

- **by-file** - Find all work related to a specific file path across all sessions
  - Use when: "What changes to auth.ts?" or "History of this file"
  - Example: Get all work related to "src/auth/login.ts"

### Timeline & Context
- **recent-context** - Get last N sessions with summaries and observations
  - Use when: "What's been happening?" or "Catch me up on recent work"
  - Example: Get last 3 sessions with limit=3

- **timeline** - Get chronological context around a specific point in time (before/after window)
  - Use when: "What was happening around [date]?" or "Show me context from that time"
  - Example: Timeline around session 123 with depth 5 before and after

- **timeline-by-query** - Search first, then get timeline context around best match
  - Use when: "When did we implement auth?" combined with "show me context around that time"
  - Example: Search for "OAuth implementation" then get surrounding timeline

For detailed instructions on any operation, read the corresponding file in [operations/](operations/).

## Quick Decision Guide

**What is the user asking about?**

1. **Recent work** (last 3-5 sessions) → Use **recent-context** with limit=3-5
2. **Specific topic/keyword** (bugs, features, decisions) → Use **observations** search
3. **Specific file history** (changes to a file) → Use **by-file** search
4. **Timeline/chronology** (what happened when) → Use **timeline** or **timeline-by-query**
5. **Type-specific** (all bug fixes, all features) → Use **by-type** filter

**Most common:** Use **observations** search for general "how did we..." questions.

## Progressive Disclosure Workflow (Token Efficiency)

**Core Principle**: Find high-signal items in index format FIRST (~50-100 tokens each), then request full details ONLY for relevant items (~500-1000 tokens each).

**4-Step Workflow:**

1. **Start with Index Format**
   - Always use `format=index` initially
   - Set `limit=3-5` (not 10-20)
   - Review titles and dates to assess relevance
   - Token cost: ~50-100 per result

2. **Identify Relevant Items**
   - Scan index results
   - Discard irrelevant items from list
   - Keep only 1-3 most relevant

3. **Request Full Details Selectively**
   - Use `format=full` ONLY for specific relevant items
   - Token cost: ~500-1000 per result
   - **10x cost difference** - be selective

4. **Refine with Filters**
   - Use type, dateRange, concepts, files filters
   - Paginate with offset if needed
   - Narrow scope before expanding limits

**DO:**
- ✅ Start with `format=index` and `limit=3-5`
- ✅ Use filters (type, dateRange, concepts, files) to narrow results
- ✅ Request `format=full` ONLY for specific relevant items
- ✅ Use offset for pagination instead of large limits

**DON'T:**
- ❌ Jump straight to `format=full`
- ❌ Request `limit=20` without assessing index results first
- ❌ Load full details for all results upfront
- ❌ Skip index format to "save a step" (costs 10x more tokens)

See [principles/progressive-disclosure.md](principles/progressive-disclosure.md) for complete workflow with examples and token calculations.

## Quick Reference Table

| Need | Operation | Key Parameters |
|------|-----------|----------------|
| Recent context | recent-context | limit=3-5 |
| Search observations | observations | query, format=index, limit=5 |
| Search sessions | sessions | query, format=index, limit=5 |
| Find by type | by-type | type=(bugfix\|feature\|decision), format=index |
| Find by file | by-file | filePath, format=index |
| Timeline around event | timeline | anchor=(sessionDbId), depth_before=5, depth_after=5 |
| Search + timeline | timeline-by-query | query, mode=auto |

## Common Workflows

For step-by-step guides on typical user requests, see [operations/common-workflows.md](operations/common-workflows.md):
- Understanding past work from previous sessions
- Finding specific bug fixes from history
- Understanding file history across sessions
- Timeline investigation workflows
- Search composition patterns

## Response Formatting

For guidelines on presenting search results to users, see [operations/formatting.md](operations/formatting.md):
- Index format responses (compact lists with titles/dates)
- Full format responses (complete observation details)
- Timeline responses (chronologically grouped)
- Error handling and user-friendly messages

## Technical Notes

- **Port:** Default 37777 (configurable via `CLAUDE_MEM_WORKER_PORT`)
- **Response format:** Always JSON
- **Search engine:** FTS5 full-text search + structured filters
- **All operations:** HTTP GET with query parameters
- **Worker:** PM2-managed background process

## Error Handling

If HTTP request fails:
1. Inform user the claude-mem search service isn't available
2. Suggest checking if worker is running: `pm2 list` or `pm2 status claude-mem-worker`
3. Offer to help troubleshoot using the troubleshoot skill

## Resources

**Principles:**
- [principles/progressive-disclosure.md](principles/progressive-disclosure.md) - Complete 4-step workflow with token calculations
- [principles/anti-patterns.md](principles/anti-patterns.md) - 5 anti-patterns to avoid with LLM behavior insights

**Operations:**
- [operations/](operations/) - Detailed instructions for each operation (9 operations + help)
- [operations/common-workflows.md](operations/common-workflows.md) - Step-by-step workflow guides
- [operations/formatting.md](operations/formatting.md) - Response formatting templates

---

**Remember:** This skill searches **cross-session persistent memory**, NOT current conversation. Start with index format for token efficiency. Use temporal triggers to differentiate from native Claude memory.
