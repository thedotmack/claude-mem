# MCP Best Practices

Universal guidelines for building high-quality MCP servers.

## Server Naming

- Use lowercase, hyphenated names: `my-service-mcp`
- Suffix with `-mcp` for clarity
- Name should reflect the service being wrapped

## Tool Naming

- Use consistent prefixes matching the service: `github_create_issue`, `github_list_repos`
- Action-oriented: verb + noun pattern
- Be specific: `search_issues_by_label` over `search`
- Group related tools with shared prefixes for discoverability

## Tool Descriptions

- First line: concise summary of what the tool does
- Include parameter descriptions with types and constraints
- Mention side effects explicitly
- Add examples in descriptions where input format is non-obvious
- Keep descriptions under ~200 words - agents scan, not read

## Response Format

**Prefer JSON for structured data:**
- Machine-parseable, composable across tool calls
- Use `structuredContent` with `outputSchema` when SDK supports it
- Include both `content` (text) and `structuredContent` (JSON) for maximum compatibility

**Use Markdown sparingly:**
- Only for human-facing summaries or when data is inherently narrative
- Never for data that downstream tools need to parse

## Pagination

- Support cursor-based pagination where the API allows it
- Default page sizes: 20-50 items (balance between too few calls and too much data)
- Return pagination metadata: `hasNextPage`, `cursor`, `totalCount` where available
- Tools should accept `cursor` and `limit` parameters

## Error Handling

**Actionable error messages:**
```
BAD:  "Request failed"
GOOD: "Authentication failed. Ensure GITHUB_TOKEN is set and has 'repo' scope."
```

- Include the HTTP status code when relevant
- Suggest specific fixes or next steps
- Distinguish between client errors (bad input) and server errors (API down)
- Never expose raw stack traces - wrap in meaningful context

**Error response structure:**
```json
{
  "error": "RATE_LIMITED",
  "message": "GitHub API rate limit exceeded. Resets at 2024-01-15T10:30:00Z.",
  "retryAfter": 120
}
```

## Authentication

- Accept credentials via environment variables (never hardcode)
- Document required env vars clearly in README and tool descriptions
- Validate credentials early (on server startup, not first tool call)
- Support multiple auth methods when the API does (token, OAuth, API key)

## Transport Selection

**Streamable HTTP (remote servers):**
- Stateless JSON request/response (simpler to scale)
- Works behind load balancers and CDNs
- Best for cloud-deployed servers
- Use when multiple clients may connect

**stdio (local servers):**
- Direct process communication
- Zero network overhead
- Best for local development tools and CLI integrations
- Use when server runs on same machine as client

## Input Validation

- Validate all inputs with schemas (Zod for TypeScript, Pydantic for Python)
- Use enums for known value sets
- Add `min`/`max` constraints for numbers
- Use `pattern` for string formats (dates, IDs, etc.)
- Provide defaults for optional parameters

## Security

- Never log or return credentials in responses
- Sanitize user input before passing to APIs
- Use least-privilege API scopes
- Rate limit tool calls if the underlying API has limits
- Validate URLs and file paths to prevent injection

## Performance

- Use connection pooling for HTTP clients
- Cache static data (user profiles, repo metadata) with appropriate TTLs
- Implement request batching where APIs support it
- Set reasonable timeouts (30s default, configurable)
- Return early with partial results rather than timing out silently

## Annotations

Set tool annotations to help clients make informed decisions:

```typescript
annotations: {
  readOnlyHint: true,      // Tool only reads data, no side effects
  destructiveHint: false,  // Tool doesn't delete or irreversibly modify
  idempotentHint: true,    // Safe to retry without side effects
  openWorldHint: true      // Tool interacts with external services
}
```

- `readOnlyHint`: GET-like operations
- `destructiveHint`: DELETE, irreversible updates
- `idempotentHint`: PUT-like operations safe to retry
- `openWorldHint`: Almost always `true` for API-wrapping servers

## Testing

- Test each tool with valid inputs, invalid inputs, and edge cases
- Mock external API calls in unit tests
- Use MCP Inspector for integration testing: `npx @modelcontextprotocol/inspector`
- Verify error messages are actionable
- Test pagination with empty results, single page, and multi-page scenarios
