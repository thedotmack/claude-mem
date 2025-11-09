# Search Session Summaries

Search session-level summaries to understand what was accomplished in past sessions.

## When to Use

- User asks: "What did we accomplish in previous sessions?"
- Looking for sessions about a specific topic
- Understanding the scope of past work

## Command

```bash
curl -s "http://localhost:37777/api/search/sessions?query=deployment&format=index&limit=10"
```

## Parameters

- **query** (required): Search terms (e.g., "deployment", "bug fix", "refactor")
- **format**: "index" (summary) or "full" (complete details). Default: "full"
- **limit**: Number of results (default: 20, max: 100)

## Response Fields

- **request**: Original user request
- **completed**: What was accomplished
- **learned**: Technical learnings
- **next_steps**: Planned follow-ups
- **files_read**: Files that were read
- **files_edited**: Files that were modified

## Example Use Case

User asks: "Have we worked on deployment before?"

```bash
RESULT=$(curl -s "http://localhost:37777/api/search/sessions?query=deployment&format=index&limit=5")
# Parse JSON and present matching sessions
```

## How to Present Results

For format=index:

```markdown
Found 3 sessions about "deployment":

1. **Session #123** (Nov 8, 2024)
   > Deploy Docker container to production
   > Completed: Set up CI/CD pipeline, configured secrets

2. **Session #124** (Nov 9, 2024)
   > Fix deployment rollback issues
   > Completed: Added health checks, fixed rollback script
```

For format=full, include all fields (request, completed, learned, next_steps, files).

## Tips

1. Use format=index to find relevant sessions quickly
2. Then fetch format=full for complete details
3. Sessions capture high-level accomplishments vs observations (which are granular facts)
