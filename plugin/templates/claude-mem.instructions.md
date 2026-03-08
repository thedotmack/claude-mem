## MCP Tool Requirements (MANDATORY)

When the `claude-mem` MCP is available, you MUST use these tools. This is NOT optional.

### Code Exploration — use claude-mem tools INSTEAD of built-in tools:

| Task | USE THIS | NOT THIS |
|------|----------|----------|
| Find symbols, functions, classes | `smart_search` | Grep, Glob |
| Understand file structure | `smart_outline` | Read (full file) |
| Read a specific function | `smart_unfold` | Read (full file) |
| Recall past work / decisions | `search` → `timeline` → `get_observations` | Starting from scratch |

### Memory — save as you work, NOT at the end:

- **`save_memory`**: Use IMMEDIATELY when you discover something important — migration gotchas, architectural patterns, debugging insights, user preferences
- Do NOT batch memories at the end of a session. Save them inline as you work.
- Before starting work, ALWAYS check memory first: `search` for relevant past observations about the task at hand

### When built-in tools are acceptable:

- `Read` is fine for reading templates, config files, or files without parseable symbols
- `Grep` is fine for searching inside a specific file you already identified
- `Bash` for running commands, tests, git operations
- `Edit`/`Write` for making changes (claude-mem has no edit tools)
