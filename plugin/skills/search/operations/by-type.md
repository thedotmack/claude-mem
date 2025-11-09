# Search by Type

Find observations by their classification (bugfix, feature, refactor, decision, discovery, change).

## When to Use

- User asks: "What bugs did we fix?"
- User asks: "What features did we add?"
- User asks: "What decisions did we make?"
- Looking for specific types of work

## Command

```bash
curl -s "http://localhost:37777/api/search/by-type?type=bugfix&limit=10&format=index"
```

## Parameters

- **type** (required): Observation type
- **format**: "index" or "full" (default: "full")
- **limit**: Number of results (default: 10, max: 100)
- **project**: Filter by project name (optional)

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
curl -s "http://localhost:37777/api/search/by-type?type=bugfix&limit=10&format=index"
```

**"What features did we add this week?"**
```bash
curl -s "http://localhost:37777/api/search/by-type?type=feature&limit=20&format=index"
```

**"What architectural decisions have we made?"**
```bash
curl -s "http://localhost:37777/api/search/by-type?type=decision&limit=10&format=full"
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
