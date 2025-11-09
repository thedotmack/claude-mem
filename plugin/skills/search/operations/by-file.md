# Search by File Path

Find all work related to a specific file.

## When to Use

- User asks: "What changes did we make to auth/login.ts?"
- Understanding the history of a specific file
- Finding all observations that touched a file

## Command

```bash
curl -s "http://localhost:37777/api/search/by-file?filePath=auth/login.ts&limit=10&format=index"
```

## Parameters

- **filePath** (required): Full or partial file path
  - Examples: "auth/", "login.ts", "src/components/Button.tsx"
- **format**: "index" or "full" (default: "full")
- **limit**: Number of results per type (default: 10, max: 100)
- **project**: Filter by project name (optional)

## Response Structure

Returns both observations and sessions that touched the file:

```json
{
  "filePath": "auth/login.ts",
  "count": 5,
  "format": "index",
  "results": {
    "observations": [...],
    "sessions": [...]
  }
}
```

## Use Cases

**Full file path:**
```bash
curl -s "http://localhost:37777/api/search/by-file?filePath=src/auth/login.ts&limit=10"
```

**Partial path (matches all files in directory):**
```bash
curl -s "http://localhost:37777/api/search/by-file?filePath=auth/&limit=10"
```

**Filename only (matches across directories):**
```bash
curl -s "http://localhost:37777/api/search/by-file?filePath=login.ts&limit=10"
```

## How to Present Results

```markdown
Found 5 changes to auth/login.ts:

**Observations:**
1. 🟣 **#1234** Implemented JWT authentication
   > Added token-based auth with refresh tokens
   > Nov 9, 2024

2. 🔴 **#1235** Fixed token expiration edge case
   > Handled race condition in refresh flow
   > Nov 9, 2024

**Sessions:**
1. **Session #123** (Nov 8, 2024)
   > Add user authentication
   > Completed: Implemented JWT auth, added middleware
```

## Tips

1. Partial paths are powerful for finding all work in a directory
2. Use this before modifying a file to understand its history
3. Helps identify who/when/why changes were made
4. Combine observations + sessions for complete file history
