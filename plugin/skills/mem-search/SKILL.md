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
- `format: "index"` - ALWAYS start with index (lightweight)
- `limit: 30` - You can request large indexes as necessary
- `project` - Project name (required)

**Example:**

```
search(query="authentication", format="index", limit=30, project="my-project")
```

**Returns:**

```
1. [feature] Added JWT authentication
   Date: 11/17/2025, 3:48:45 PM
   ID: 11131

2. [bugfix] Fixed auth token expiration
   Date: 11/16/2025, 2:15:22 PM
   ID: 10942
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

**Fetch single observation:**

```
get_observation(id=11131)
```

**Fetch multiple observations (recommended for 2+ IDs):**

```
get_batch_observations(ids=[11131, 10942, 10855])
```

**With ordering and limit:**

```
get_batch_observations(
  ids=[11131, 10942, 10855],
  orderBy="date_desc",
  limit=10
)
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

**When to use batch:**

- Always use `get_batch_observations` when fetching 2+ observations
- More efficient: one request vs multiple
- Returns all observations in a single response

## Search Parameters

**Basic:**

- `query` - What to search for (required)
- `format` - "index" or "full" (always use "index" first)
- `limit` - How many results (default 30)
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
search(query="bug", type="observations", obs_type="bugfix", format="index", limit=30, project="my-project")
```

**Find what happened last week:**

Use date filters:

```
search(type="observations", dateStart="2025-11-11", format="index", limit=30, project="my-project")
```

**Search everything:**

Simple query search:

```
search(query="database migration", format="index", limit=30, project="my-project")
```

**Get detailed instructions:**

Use the `progressive_ix` tool to load full instructions on-demand:

```
progressive_ix(topic="workflow")  # Get 4-step workflow
progressive_ix(topic="search_params")  # Get parameters reference
progressive_ix(topic="examples")  # Get usage examples
progressive_ix(topic="all")  # Get complete guide
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

---

**Remember:** ALWAYS search with format=index first. ALWAYS get timeline context for observations you're interested in. ALWAYS fetch by ID for details. The IDs are there for a reason - use them.
