---
name: mem-search
description: Search claude-mem's persistent cross-session memory database. Use when user asks "did we already solve this?", "how did we do X last time?", or needs work from previous sessions.
---

# Memory Search

Search past work across all sessions. Simple workflow: search -> filter -> fetch.

## When to Use

Use when users ask about PREVIOUS sessions (not current conversation):

- "Did we already fix this?"
- "How did we solve X last time?"
- "What happened last week?"

## 3-Layer Workflow (ALWAYS Follow)

**NEVER fetch full details without filtering first. 10x token savings.**

### Step 1: Search - Get Index with IDs

Use the `search` MCP tool:

```
search(query="authentication", limit=20, project="my-project")
```

**Returns:** Table with IDs, timestamps, types, titles (~50-100 tokens/result)

```
| ID | Time | T | Title | Read |
|----|------|---|-------|------|
| #11131 | 3:48 PM | 🟣 | Added JWT authentication | ~75 |
| #10942 | 2:15 PM | 🔴 | Fixed auth token expiration | ~50 |
```

**Parameters:**

- `query` (string) - Search term
- `limit` (number) - Max results, default 20, max 100
- `project` (string) - Project name filter
- `type` (string, optional) - "observations", "sessions", or "prompts"
- `obs_type` (string, optional) - Comma-separated: bugfix, feature, decision, discovery, change
- `dateStart` (string, optional) - YYYY-MM-DD or epoch ms
- `dateEnd` (string, optional) - YYYY-MM-DD or epoch ms
- `offset` (number, optional) - Skip N results
- `orderBy` (string, optional) - "date_desc" (default), "date_asc", "relevance"

### Step 2: Timeline - Get Context Around Interesting Results

Use the `timeline` MCP tool:

```
timeline(anchor=11131, depth_before=3, depth_after=3, project="my-project")
```

Or find anchor automatically from query:

```
timeline(query="authentication", depth_before=3, depth_after=3, project="my-project")
```

**Returns:** `depth_before + 1 + depth_after` items in chronological order with observations, sessions, and prompts interleaved around the anchor.

**Parameters:**

- `anchor` (number, optional) - Observation ID to center around
- `query` (string, optional) - Find anchor automatically if anchor not provided
- `depth_before` (number, optional) - Items before anchor, default 5, max 20
- `depth_after` (number, optional) - Items after anchor, default 5, max 20
- `project` (string) - Project name filter

### Step 3: Fetch - Get Full Details ONLY for Filtered IDs

Review titles from Step 1 and context from Step 2. Pick relevant IDs. Discard the rest.

Use the `get_observations` MCP tool:

```
get_observations(ids=[11131, 10942])
```

**ALWAYS use `get_observations` for 2+ observations - single request vs N requests.**

**Parameters:**

- `ids` (array of numbers, required) - Observation IDs to fetch
- `orderBy` (string, optional) - "date_desc" (default), "date_asc"
- `limit` (number, optional) - Max observations to return
- `project` (string, optional) - Project name filter

**Returns:** Complete observation objects with title, subtitle, narrative, facts, concepts, files (~500-1000 tokens each)

## Examples

**Find recent bug fixes:**

```
search(query="bug", type="observations", obs_type="bugfix", limit=20, project="my-project")
```

**Find what happened last week:**

```
search(type="observations", dateStart="2025-11-11", limit=20, project="my-project")
```

**Understand context around a discovery:**

```
timeline(anchor=11131, depth_before=5, depth_after=5, project="my-project")
```

**Batch fetch details:**

```
get_observations(ids=[11131, 10942, 10855], orderBy="date_desc")
```

## Why This Workflow?

- **Search index:** ~50-100 tokens per result
- **Full observation:** ~500-1000 tokens each
- **Batch fetch:** 1 HTTP request vs N individual requests
- **10x token savings** by filtering before fetching

## Smart-Explore Language Support

Smart-explore tools (`smart_search`, `smart_outline`, `smart_unfold`) use tree-sitter AST parsing. The following languages are supported out of the box.

### 24 Bundled Languages

JS, TS, Python, Go, Rust, Ruby, Java, C, C++, Kotlin, Swift, PHP, Elixir, Lua, Scala, Bash, Haskell, Zig, CSS, SCSS, TOML, YAML, SQL, Markdown

### Markdown Special Support

Markdown files get structure-aware parsing beyond generic tree-sitter:

- **Heading hierarchy** -- `#`/`##`/`###` headings are extracted as nested symbols (sections contain subsections)
- **Code block detection** -- fenced code blocks are surfaced as `code` symbols with language annotation
- **Section-aware unfold** -- `smart_unfold` on a heading returns the full section content (heading through all subsections until the next heading of equal or higher level)

### User-Installable Grammars via `.claude-mem.json`

Add custom tree-sitter grammars for languages not in the bundled set. Place `.claude-mem.json` in the project root:

```json
{
  "grammars": {
    "gleam": {
      "package": "tree-sitter-gleam",
      "extensions": [".gleam"]
    },
    "protobuf": {
      "package": "tree-sitter-proto",
      "extensions": [".proto"],
      "query": ".claude-mem/queries/proto.scm"
    }
  }
}
```

**Fields:**

- `package` (string, required) -- npm package name for the tree-sitter grammar
- `extensions` (array of strings, required) -- file extensions to associate with this language
- `query` (string, optional) -- path to a custom `.scm` query file for symbol extraction. If omitted, a generic query is used.

**Rules:**

- User grammars do NOT override bundled languages. If a language is already bundled, the entry is ignored.
- The npm package must be installed in the project (`npm install tree-sitter-gleam`).
- Config is cached per project root. Changes to `.claude-mem.json` take effect on next worker restart.

## Knowledge Agents

Want synthesized answers instead of raw records? Use `/knowledge-agent` to build a queryable corpus from your observation history. The knowledge agent reads all matching observations and answers questions conversationally.
