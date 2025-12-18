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
2. **Timeline** - Get context around top results to understand what was happening
3. **Review** - Look at titles/dates/context, pick relevant IDs
4. **Fetch** - Get full details ONLY for those IDs

### Step 1: Search Everything

Use the `search` MCP tool:

**Required parameters:**

- `query` - Search term
- `limit: 20` - You can request large indexes as necessary
- `project` - Project name (required)

**Example:**

```
search(query="authentication", limit=20, project="my-project")
```

**Returns:**

```
| ID | Time | T | Title | Read | Work |
|----|------|---|-------|------|------|
| #11131 | 3:48 PM | 🟣 | Added JWT authentication | ~75 | 🛠️ 450 |
| #10942 | 2:15 PM | 🔴 | Fixed auth token expiration | ~50 | 🛠️ 200 |
```

### Step 2: Get Timeline Context

You MUST understand "what was happening" around a result.

Use the `timeline` MCP tool:

**Example with observation ID:**

```
timeline(anchor=11131, depth_before=3, depth_after=3, project="my-project")
```

**Example with query (finds anchor automatically):**

```
timeline(query="authentication", depth_before=3, depth_after=3, project="my-project")
```

**Returns exactly `depth_before + 1 + depth_after` items** - observations, sessions, and prompts interleaved chronologically around the anchor.

**When to use:**

- User asks "what was happening when..."
- Need to understand sequence of events
- Want broader context around a specific observation

### Step 3: Pick IDs

Review the index results (and timeline if used). Identify which IDs are actually relevant. Discard the rest.

### Step 4: Fetch by ID

For each relevant ID, fetch full details using MCP tools:

**Fetch multiple observations (ALWAYS use for 2+ IDs):**

```
get_observations(ids=[11131, 10942, 10855])
```

**With ordering and limit:**

```
get_observations(
  ids=[11131, 10942, 10855],
  orderBy="date_desc",
  limit=10,
  project="my-project"
)
```

**Fetch single observation (only when fetching exactly 1):**

```
get_observation(id=11131)
```

**Fetch session:**

```
get_session(id=2005)  # Just the number from S2005
```

**Fetch prompt:**

```
get_prompt(id=5421)
```

**ID formats:**

- Observations: Just the number (11131)
- Sessions: Just the number (2005) from "S2005"
- Prompts: Just the number (5421)

**Batch optimization:**

- **ALWAYS use `get_observations` for 2+ observations**
- 10-100x more efficient than individual fetches
- Single HTTP request vs N requests
- Returns all results in one response
- Supports ordering and filtering

## Search Parameters

**Basic:**

- `query` - What to search for (required)
- `limit` - How many results (default 20)
- `project` - Filter by project name (required)

**Filters (optional):**

- `type` - Filter to "observations", "sessions", or "prompts"
- `dateStart` - Start date (YYYY-MM-DD or epoch timestamp)
- `dateEnd` - End date (YYYY-MM-DD or epoch timestamp)
- `obs_type` - Filter observations by type (comma-separated): bugfix, feature, decision, discovery, change

## Examples

**Find recent bug fixes:**

Use the `search` MCP tool with filters:

```
search(query="bug", type="observations", obs_type="bugfix", limit=20, project="my-project")
```

**Find what happened last week:**

Use date filters:

```
search(type="observations", dateStart="2025-11-11", limit=20, project="my-project")
```

**Search everything:**

Simple query search:

```
search(query="database migration", limit=20, project="my-project")
```

**Get detailed instructions:**

Use the `help` tool to load full instructions on-demand:

```
help(topic="workflow")  # Get 4-step workflow
help(topic="search_params")  # Get parameters reference
help(topic="examples")  # Get usage examples
help(topic="all")  # Get complete guide
```

## Why This Workflow?

**Token efficiency:**

- **Search results:** ~50-100 tokens per result (table index)
- **Full observation:** ~500-1000 tokens each
- **10x savings** - only fetch full when you know it's relevant

**Batch fetching:**

- **Individual fetches:** 10 HTTP requests, ~5-10s latency
- **Batch fetch:** 1 HTTP request, ~0.5-1s latency
- **10-100x faster** for multi-observation queries

**Clarity:**

- See everything first (table index)
- Get timeline context around interesting results
- Pick what matters based on context
- Fetch details only for what you need (batch when possible)

---

**Remember:**

- ALWAYS get timeline context to understand what was happening
- ALWAYS use `get_observations` when fetching 2+ observations
- The workflow is optimized: search → timeline → batch fetch = 10-100x faster

---

## Tool Reference

Comprehensive parameter documentation for all memory tools. For MCP usage, call `help(topic="search")` to load specific tool docs.

### search

Search across all memory types (observations, sessions, prompts).

**Parameters:**

- `query` (string, optional) - Search term for full-text search
- `limit` (number, optional) - Maximum results to return. Default: 20, Max: 100
- `offset` (number, optional) - Number of results to skip. Default: 0
- `project` (string, required) - Project name to filter by
- `type` (string, optional) - Filter by type: "observations", "sessions", "prompts"
- `dateStart` (string, optional) - Start date filter (YYYY-MM-DD or epoch ms)
- `dateEnd` (string, optional) - End date filter (YYYY-MM-DD or epoch ms)
- `obs_type` (string, optional) - Filter observations by type (comma-separated): bugfix, feature, decision, discovery, change
- `orderBy` (string, optional) - Sort order: "date_desc" (default), "date_asc", "relevance"

**Returns:** Table of results with IDs, timestamps, types, titles

### timeline

Get chronological context around a specific point in time or observation.

**Parameters:**

- `anchor` (number, optional) - Observation ID to center timeline around. If not provided, uses most recent result from query
- `query` (string, optional) - Search term to find anchor automatically (if anchor not provided)
- `depth_before` (number, optional) - Items before anchor. Default: 5, Max: 20
- `depth_after` (number, optional) - Items after anchor. Default: 5, Max: 20
- `project` (string, required) - Project name to filter by

**Returns:** Exactly `depth_before + 1 + depth_after` items in chronological order, with observations, sessions, and prompts interleaved

### get_recent_context

Get the most recent observations from current or recent sessions.

**Parameters:**

- `limit` (number, optional) - Maximum observations to return. Default: 10, Max: 50
- `project` (string, required) - Project name to filter by

**Returns:** Recent observations in reverse chronological order

### get_context_timeline

Get timeline context around a specific observation ID.

**Parameters:**

- `anchor` (number, required) - Observation ID to center timeline around
- `depth_before` (number, optional) - Items before anchor. Default: 5, Max: 20
- `depth_after` (number, optional) - Items after anchor. Default: 5, Max: 20
- `project` (string, optional) - Project name to filter by

**Returns:** Timeline items centered on the anchor observation

### get_observation

Fetch a single observation by ID with full details.

**Parameters:**

- `id` (number, required) - Observation ID to fetch

**Returns:** Complete observation object with title, subtitle, narrative, facts, concepts, files, timestamps

### get_observations

Batch fetch multiple observations by IDs. Always prefer this over individual fetches for 2+ observations.

**Parameters:**

- `ids` (array of numbers, required) - Array of observation IDs to fetch
- `orderBy` (string, optional) - Sort order: "date_desc" (default), "date_asc"
- `limit` (number, optional) - Maximum observations to return. Default: no limit
- `project` (string, optional) - Project name to filter by

**Returns:** Array of complete observation objects, 10-100x faster than individual fetches

### get_session

Fetch a single session by ID with metadata.

**Parameters:**

- `id` (number, required) - Session ID to fetch (just the number, not "S2005" format)

**Returns:** Session object with ID, start time, end time, project, model info

### get_prompt

Fetch a single prompt by ID with full text.

**Parameters:**

- `id` (number, required) - Prompt ID to fetch

**Returns:** Prompt object with ID, text, timestamp, session reference

### help

Load detailed instructions for specific topics or all documentation.

**Parameters:**

- `topic` (string, optional) - Specific topic to load: "workflow", "search", "timeline", "get_recent_context", "get_context_timeline", "get_observation", "get_observations", "get_session", "get_prompt", "all". Default: "all"

**Returns:** Formatted documentation for the requested topic
