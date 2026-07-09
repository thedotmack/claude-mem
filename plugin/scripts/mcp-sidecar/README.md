# claude-mem MCP Sidecar

> Adds 4 MCP Resources + 3 MCP Prompts that the main claude-mem MCP server is missing.
> Spec: `../../docs/sprint2/05-mcp-resources-prompts.md`.

## Install
```bash
cd work/src/mcp-sidecar
npm install      # pulls @modelcontextprotocol/sdk + zod
```

## Register in Claude Code

Add to `~/.claude/settings.json` (or project `.mcp.json`):
```json
{
  "mcpServers": {
    "claude-mem-sidecar": {
      "type": "stdio",
      "command": "bun",
      "args": ["/Users/rob/Development/plugin-fix/work/src/mcp-sidecar/server.mjs"]
    }
  }
}
```

Restart Claude Code, then invoke via host UI:
- `@claude-mem://observations/<project>` — observation feed
- `@claude-mem://sessions/<session_id>` — session bundle (markdown)
- `@claude-mem://stats` — DB stats
- `/summarize-session <session_id>` — prompt
- `/prep-handoff <project>` — prompt
- `/kb-question <question>` — prompt

## Resources (4)
| URI | MIME | Purpose |
|---|---|---|
| `claude-mem://observations/{project}` | json | Top 200 observations per project |
| `claude-mem://observation/{id}` | json | Single observation by id |
| `claude-mem://sessions/{session_id}` | md | Session bundle as markdown |
| `claude-mem://stats` | json | DB observation/session counts + types histogram |

## Prompts (3)
| Name | Args | Use |
|---|---|---|
| `summarize-session` | session_id | Markdown recap |
| `prep-handoff` | project, focus? | Session-handoff doc |
| `kb-question` | question, project? | Standardized RAG with citation/hedging rules |

## Safety
- Sidecar opens the DB **READ-ONLY** (`{readonly:true}`) — cannot corrupt main DB.
- Resources are paginated to ≤200 rows.
- Sidecar runs as a separate stdio process; if it crashes, the main claude-mem stays up.

## Verification (without Claude Code)
Once `npm install`ed, you can speak JSON-RPC manually:
```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}' | bun server.mjs
# Then send: {"jsonrpc":"2.0","id":2,"method":"resources/list","params":{}}
```
