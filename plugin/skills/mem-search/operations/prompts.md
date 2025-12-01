# Search User Prompts (Full-Text)

Search raw user prompts to find what was actually asked across all sessions.

## When to Use

- User asks: "What did I ask about authentication?"
- User asks: "Find my question about database migrations"
- User asks: "When did I ask about testing?"
- Looking for specific user questions or requests

## Command

```bash
curl -s "http://localhost:37777/api/search/prompts?query=authentication&format=index&limit=5"
```

## Parameters

- **query** (required): Search terms (e.g., "authentication", "how do I", "bug fix")
- **format**: "index" (truncated prompts) or "full" (complete prompt text). Default: "full"
- **limit**: Number of results (default: 20, max: 100)
- **project**: Filter by project name (optional)
- **dateStart/dateEnd**: Filter by date range (optional)

## When to Use Each Format

**Use format=index for:**
- Quick overviews of what was asked
- Finding prompt IDs for full text
- Listing multiple prompts
- **Token cost: ~50-100 per result (truncated to 200 chars)**

**Use format=full for:**
- Complete prompt text
- Understanding the full user request
- **Token cost: Variable (depends on prompt length, typically 100-300 tokens)**

## Example Response (format=index)

```json
{
  "query": "authentication",
  "count": 5,
  "format": "index",
  "results": [
    {
      "id": 1250,
      "session_id": "S545",
      "prompt_preview": "How do I implement JWT authentication with refresh tokens? I need to handle token expiration...",
      "created_at_epoch": 1699564800000,
      "project": "api-server"
    }
  ]
}
```

## How to Present Results

For format=index, present as a compact list:

```markdown
Found 5 user prompts about "authentication":

💬 **Prompt #1250** (Session #545)
   > "How do I implement JWT authentication with refresh tokens? I need to handle token expiration..."
   > Nov 9, 2024 • api-server

💬 **Prompt #1251** (Session #546)
   > "The auth tokens are expiring too quickly. Can you help debug the refresh flow?"
   > Nov 8, 2024 • api-server
```

For complete formatting guidelines, see [formatting.md](formatting.md).

## What Gets Searched

User prompts search covers:
- All user messages sent to Claude Code
- Raw text as typed by the user
- Multi-turn conversations (each message is a separate prompt)
- Questions, requests, commands, and clarifications

## Error Handling

**Missing query parameter:**
```json
{"error": "Missing required parameter: query"}
```
Fix: Add the query parameter

**No results found:**
```json
{"query": "foobar", "count": 0, "results": []}
```
Response: "No user prompts found for 'foobar'. Try different search terms."

## Tips

1. Use exact phrases in quotes: `?query="how do I"` for precise matches
2. Start with format=index to see preview, then get full text if needed
3. Use dateStart to find recent questions: `?query=bug&dateStart=2024-11-01`
4. Prompts show what was asked, sessions/observations show what was done
5. Combine with session search to see both question and answer

**Token Efficiency:**
- Start with format=index (~50-100 tokens per result, prompt truncated to 200 chars)
- Use format=full only for relevant items (100-300 tokens per result)
- See [../principles/progressive-disclosure.md](../principles/progressive-disclosure.md)

## When to Use Prompts vs Sessions

**Use prompts search when:**
- Looking for specific user questions
- Trying to remember what was asked
- Finding original request wording

**Use sessions search when:**
- Looking for what was accomplished
- Understanding work summaries
- Getting high-level context

**Combine both when:**
- Understanding the full conversation (what was asked + what was done)
- Investigating how a request was interpreted
