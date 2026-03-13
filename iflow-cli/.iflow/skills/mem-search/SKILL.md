---
name: "mem-search"
description: "Search historical memories. Use when the user wants to find past work records, decisions, bug fixes, or any historical context."
license: MIT
metadata:
  version: 1.0.0
  author: claude-mem
  category: memory
  updated: 2026-03-13
---

# Memory Search

Search claude-mem persistent storage for historical memories using semantic search.

## Usage

```
/mem-search <query> [options]
```

## Arguments

- `query` - Search keyword or natural language description
- `--type <type>` - Filter by type: decision, bugfix, feature, discovery, change
- `--limit <n>` - Number of results to return, default 10, max 100
- `--date <range>` - Date range, e.g., "today", "week", "month", "2024-01"

## Examples

```
/mem-search authentication
/mem-search bug fix --type bugfix
/mem-search database schema --limit 20
/mem-search last week changes --date week
```

## How It Works

1. Use semantic search to match relevant memories
2. Return a list of most relevant results
3. Use `/mem-context <id>` to get details

## Memory Types

| Type | Icon | Description |
|------|------|-------------|
| decision | 🔵 | Technical decision |
| bugfix | 🔴 | Bug fix |
| feature | 🟢 | New feature development |
| discovery | 🟡 | Exploration discovery |
| change | 🟣 | Code change |

## Notes

- First-time use requires claude-mem worker to be running
- Search results are sorted by semantic similarity
- Sensitive information (such as passwords, keys) is automatically filtered

## Related Skills

- **@mem-context**: USE to manually inject historical context
