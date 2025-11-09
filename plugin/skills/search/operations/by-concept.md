# Search by Concept

Find observations tagged with specific concepts.

## When to Use

- Looking for observations about a specific concept
- Understanding patterns across the codebase
- Finding related learnings

## Command

```bash
curl -s "http://localhost:37777/api/search/by-concept?concept=discovery&limit=5&format=index"
```

## Parameters

- **concept** (required): Concept tag to search for
- **format**: "index" or "full" (default: "full")
- **limit**: Number of results (default: 10, max: 100)
- **project**: Filter by project name (optional)

## Common Concepts

- **discovery**: Learnings and findings
- **decision**: Choices and rationale
- **architecture**: System design
- **performance**: Speed and optimization
- **security**: Security considerations
- **testing**: Test-related work
- **how-it-works**: Implementation details
- **why-it-exists**: Rationale and context
- **gotcha**: Tricky issues or edge cases
- **pattern**: Reusable patterns

## Use Case

"What have we learned about the database?" → Search concept=discovery + keyword search for "database"

You can combine concept search with keyword search:
```bash
# First get observations with concept=discovery
curl -s "http://localhost:37777/api/search/by-concept?concept=discovery&limit=20&format=index"
# Then filter results for "database" mentions
```

## How to Present Results

```markdown
Found 5 discoveries:

1. 🔵 **#1230** Database connection pooling best practices
   > Learned that pool size should match CPU cores * 2
   > Nov 8, 2024 • api-server

2. 🔵 **#1231** JWT library comparison
   > Evaluated 3 libraries: jsonwebtoken, jose, passport-jwt
   > Nov 8, 2024 • api-server
```

## Tips

1. Concepts provide semantic grouping beyond full-text search
2. Useful for finding patterns across different parts of work
3. Combine with full-text search for precise results
