# Claude-Mem: Persistent Memory Plugin

You have access to the **claude-mem** MCP server which provides persistent memory across sessions and AST-based code intelligence. Always prefer these tools over built-in equivalents when they are available.

## Memory Tools (3-Layer Workflow)

Follow this pattern to recall past work efficiently:

1. **`search`** — Search memory by query. Returns an index with observation IDs (~50-100 tokens/result).
   - Params: `query`, `limit`, `project`, `type`, `obs_type`, `dateStart`, `dateEnd`, `offset`, `orderBy`
2. **`timeline`** — Get chronological context around a result.
   - Params: `anchor` (observation ID) OR `query` (finds anchor automatically), `depth_before`, `depth_after`, `project`
3. **`get_observations`** — Fetch full details for specific IDs. Only call after filtering with search/timeline.
   - Params: `ids` (array, required), `orderBy`, `limit`, `project`

**Rule:** Never jump straight to `get_observations`. Always filter first with `search` → `timeline` → `get_observations`. This saves 10x tokens.

### `save_memory`
Persist important discoveries, decisions, patterns, or context for future sessions.
- Params: `text` (required), `title`, `project`

## Code Intelligence Tools

Prefer these over reading entire files or running grep:

### `smart_search`
AST-based search for symbols, functions, and classes using tree-sitter. Returns folded structural views with token counts. **Use instead of grep/find for symbol lookups.**
- Params: `query` (required), `path`, `max_results`, `file_pattern`

### `smart_outline`
Get the structural outline of a file — all symbols with signatures but bodies folded. **Use instead of reading a full file when you only need to understand its structure.** Much cheaper than reading the whole file.
- Params: `file_path` (required)

### `smart_unfold`
Expand a specific symbol to see its full source code. **Use after `smart_search` or `smart_outline` to read only the code you need** instead of reading the entire file.
- Params: `file_path` (required), `symbol_name` (required)

## When to Use These Tools

| Task | Use | Instead of |
|------|-----|------------|
| Find a function/class/symbol | `smart_search` | grep, find, file search |
| Understand a file's structure | `smart_outline` | Reading the entire file |
| Read a specific function | `smart_unfold` | Reading the entire file |
| Recall past work or decisions | `search` → `timeline` → `get_observations` | Asking the user |
| Save an important finding | `save_memory` | — |
