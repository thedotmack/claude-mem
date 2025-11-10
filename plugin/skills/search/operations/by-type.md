# Search by Type

Find observations by their classification (bugfix, feature, refactor, decision, discovery, change).

## When to Use

- User asks: "What bugs did we fix?"
- User asks: "What features did we add?"
- User asks: "What decisions did we make?"
- User asks: "What bugs did we fix yesterday?"
- Looking for specific types of work

## Command

Using the wrapper script (recommended - single permission prompt):
```bash
claude-mem-search.cjs by-type bugfix --limit=10 --format=index
```

Or using curl directly:
```bash
curl -s "http://localhost:37777/api/search/by-type?type=bugfix&limit=10&format=index"
```

## Parameters

- **type** (required): Observation type
- **format**: "index" or "full" (default: "full")
- **limit**: Number of results (default: 10, max: 100)
- **project**: Filter by project name (optional)
- **from**: Start date - ISO string or Unix timestamp in ms (optional)
- **to**: End date - ISO string or Unix timestamp in ms (optional)

## Valid Types

- **bugfix**: Bug fixes and error resolutions 🔴
- **feature**: New features and capabilities 🟣
- **refactor**: Code restructuring and improvements 🔄
- **decision**: Architectural or design decisions 🧠
- **discovery**: Learnings about the codebase 🔵
- **change**: General changes and updates ✅

## Use Cases

**"Show me recent bugs we fixed"**
```bash
claude-mem-search.cjs by-type bugfix --limit=10 --format=index
```

**"What features did we add yesterday?"**
```bash
claude-mem-search.cjs by-type feature --from=2025-11-09T00:00:00 --to=2025-11-09T23:59:59 --format=index
```

**"What architectural decisions have we made?"**
```bash
claude-mem-search.cjs by-type decision --limit=10 --format=full
```

## How to Present Results

```markdown
Found 5 recent bugfixes:

1. 🔴 **#1234** Fixed token expiration edge case
   > Handled race condition in refresh flow
   > Nov 9, 2024 • api-server

2. 🔴 **#1235** Resolved database connection pooling issue
   > Fixed connection leak in long-running queries
   > Nov 8, 2024 • api-server
```

Use type-specific emojis for visual clarity.

## Tips

1. type=bugfix is great for understanding what issues were resolved
2. type=decision helps understand architectural choices
3. type=discovery reveals learnings about the codebase
4. Combine with project filtering for focused results
