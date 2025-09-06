# MCP Configuration Documentation
## Source: Official Claude Code Docs v2025
## Last Verified: 2025-08-31

## MCP Configuration File Locations

### User Scope
- **File**: `~/.claude.json`
- **Purpose**: User-wide MCP servers available across all projects
- **Persistence**: Persists across projects
- **Example Path**: `/Users/username/.claude.json`

### Project Scope
- **File**: `./.mcp.json`
- **Purpose**: Project-specific servers for team collaboration
- **Persistence**: Checked into version control
- **Example Path**: `/path/to/project/.mcp.json`

### Local Scope
- **Status**: Not officially documented
- **Implementation**: Currently uses `~/.claude.json` (may need revision)

## Configuration Structure

```json
{
  "mcpServers": {
    "server-name": {
      "command": "command-to-run",
      "args": ["arg1", "arg2"],
      "env": {
        "ENV_VAR": "value"
      }
    }
  }
}
```

## Example Configurations

### Memory Server (stdio)
```json
{
  "mcpServers": {
    "claude-mem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"]
    }
  }
}
```

### HTTP Server
```json
{
  "mcpServers": {
    "api-server": {
      "type": "sse",
      "url": "${API_BASE_URL:-https://api.example.com}/mcp",
      "headers": {
        "Authorization": "Bearer ${API_KEY}"
      }
    }
  }
}
```

## Environment Variable Expansion

MCP configs support environment variable expansion:
- `${VAR}` - Direct expansion
- `${VAR:-default}` - With fallback value

Applicable fields:
- `command`
- `args`
- `env`
- `url`
- `headers`

## CLI Commands

```bash
# Add a server
claude mcp add <name> <command> [args...]

# Add with scope
claude mcp add <name> --scope project /path/to/server
claude mcp add <name> --scope user /path/to/server

# List servers
claude mcp list

# Get server details
claude mcp get <name>

# Remove server
claude mcp remove <name>

# Check status (within Claude Code)
/mcp
```

## Tool Naming Convention

MCP tools follow the pattern: `mcp__<serverName>__<toolName>`

Example:
- Server: `claude-mem`
- Tool: `create_entities`
- Full name: `mcp__claude_mem__create_entities`

## Security Considerations

1. **Tool Permissions**: Must explicitly allow MCP tools via `--allowedTools`
2. **Server Trust**: Only use MCP servers from trusted sources
3. **Credential Management**: Use environment variables for sensitive data
4. **Audit Trail**: MCP operations can be monitored via hooks

## Common Issues

### Issue: MCP server not connecting
**Solution**: Check that the command and args are correct, and npx is in PATH

### Issue: Tools not available
**Solution**: Ensure server is in allowed list and properly configured

### Issue: Configuration not loading
**Solution**: Verify JSON syntax and file location

## References
- Official Docs: https://docs.anthropic.com/en/docs/claude-code/mcp
- MCP Protocol: https://modelcontextprotocol.io/