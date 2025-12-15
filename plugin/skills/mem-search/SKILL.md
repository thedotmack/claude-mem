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
get_batch_observations(ids=[11131, 10942, 10855])
```

**With ordering and limit:**

```
get_batch_observations(
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

- **ALWAYS use `get_batch_observations` for 2+ observations**
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

Use the `progressive_description` tool to load full instructions on-demand:

```
progressive_description(topic="workflow")  # Get 4-step workflow
progressive_description(topic="search_params")  # Get parameters reference
progressive_description(topic="examples")  # Get usage examples
progressive_description(topic="all")  # Get complete guide
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
- ALWAYS use `get_batch_observations` when fetching 2+ observations
- The workflow is optimized: search → timeline → batch fetch = 10-100x faster
