---
name: mem-search
description: Search claude-mem's persistent cross-session memory database. Use when user asks "did we already solve this?", "how did we do X last time?", or needs work from previous sessions.
---

# Memory Search

Search past work across all sessions. Simple workflow: search → get IDs → fetch details by ID.

## When to Use

Use when users ask about PREVIOUS sessions (not current conversation):
- "Did we already fix this?"
- "How did we solve X last time?"
- "What happened last week?"

## The Workflow

**ALWAYS follow this exact flow:**

1. **Search** - Get an index of results with IDs
2. **Review** - Look at titles/dates, pick relevant IDs
3. **Fetch** - Get full details ONLY for those IDs

### Step 1: Search Everything

```bash
curl "http://localhost:37777/api/search?query=authentication&format=index&limit=5"
```

**Required parameters:**
- `query` - Search term
- `format=index` - ALWAYS start with index (lightweight)
- `limit=5` - Start small (3-5 results)

**Returns:**
```
1. [feature] Added JWT authentication
   Date: 11/17/2025, 3:48:45 PM
   ID: 11131

2. [bugfix] Fixed auth token expiration
   Date: 11/16/2025, 2:15:22 PM
   ID: 10942
```

### Step 2: Pick IDs

Review the index results. Identify which IDs are actually relevant. Discard the rest.

### Step 3: Fetch by ID

For each relevant ID, fetch full details:

```bash
# Fetch observation
curl "http://localhost:37777/api/observation/11131"

# Fetch session
curl "http://localhost:37777/api/session/2005"

# Fetch prompt
curl "http://localhost:37777/api/prompt/5421"
```

**ID formats:**
- Observations: Just the number (11131)
- Sessions: Just the number (2005) from "S2005"
- Prompts: Just the number (5421)

## Search Parameters

**Basic:**
- `query` - What to search for (required)
- `format` - "index" or "full" (always use "index" first)
- `limit` - How many results (default 5, max 100)

**Filters (optional):**
- `type` - Filter to "observations", "sessions", or "prompts"
- `project` - Filter by project name
- `dateRange[start]` - Start date (YYYY-MM-DD)
- `dateRange[end]` - End date (YYYY-MM-DD)
- `obs_type` - Filter observations by: bugfix, feature, decision, discovery, change

## Examples

**Find recent bug fixes:**
```bash
curl "http://localhost:37777/api/search?query=bug&type=observations&obs_type=bugfix&format=index&limit=5"
```

**Find what happened last week:**
```bash
curl "http://localhost:37777/api/search?query=&type=observations&dateRange[start]=2025-11-11&format=index&limit=10"
```

**Search everything:**
```bash
curl "http://localhost:37777/api/search?query=database+migration&format=index&limit=5"
```

## Why This Workflow?

**Token efficiency:**
- Index format: ~50-100 tokens per result
- Full format: ~500-1000 tokens per result
- **10x difference** - only fetch full when you know it's relevant

**Clarity:**
- See everything first
- Pick what matters
- Get details only for what you need

## Error Handling

If search fails, tell the user the worker isn't available and suggest:
```bash
pm2 list  # Check if worker is running
```

---

**Remember:** ALWAYS search with format=index first. ALWAYS fetch by ID for details. The IDs are there for a reason - USE THEM.
