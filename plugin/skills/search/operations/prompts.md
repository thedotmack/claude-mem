# Search User Prompts

Find what users have asked about in the past.

## When to Use

- User asks: "Have we worked on Docker before?"
- Looking for patterns in user requests
- Understanding what topics have been explored

## Command

```bash
curl -s "http://localhost:37777/api/search/prompts?query=docker&format=index&limit=10"
```

## Parameters

- **query** (required): Search terms
- **format**: "index" (summary) or "full" (complete details). Default: "full"
- **limit**: Number of results (default: 20, max: 100)
- **project**: Filter by project name (optional)

## Use Case

"Have we worked on Docker before?" → Search prompts to see related user requests

## Example Response

```json
{
  "query": "docker",
  "count": 3,
  "format": "index",
  "results": [
    {
      "id": 456,
      "claude_session_id": "abc-123",
      "prompt_number": 1,
      "prompt_text": "Help me set up Docker for this project",
      "created_at_epoch": 1699564800000,
      "score": 0.98
    }
  ]
}
```

## How to Present Results

```markdown
Found 3 past prompts about "docker":

1. **Prompt #456** (Nov 8, 2024)
   > "Help me set up Docker for this project"

2. **Prompt #457** (Nov 9, 2024)
   > "Fix Docker compose networking issues"
```

## Tips

1. Useful for understanding what users have asked about
2. Combine with session search to see both questions and outcomes
3. Helps identify recurring topics or pain points
