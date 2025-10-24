# Configuration

## Environment Variables

| Variable                | Default                         | Description                           |
|-------------------------|---------------------------------|---------------------------------------|
| `CLAUDE_PLUGIN_ROOT`    | Set by Claude Code              | Plugin installation directory         |
| `CLAUDE_MEM_DATA_DIR`   | `~/.claude-mem/`                | Data directory (dev override)         |
| `CLAUDE_MEM_WORKER_PORT`| `37777`                         | Worker service port                   |
| `CLAUDE_MEM_MODEL`      | `claude-sonnet-4-5`             | AI model for processing observations  |
| `NODE_ENV`              | `production`                    | Environment mode                      |
| `FORCE_COLOR`           | `1`                             | Enable colored logs                   |

## Model Configuration

Configure which AI model processes your observations.

### Available Models

- `claude-haiku-4-5` - Fast, cost-efficient
- `claude-sonnet-4-5` - Balanced (default)
- `claude-opus-4` - Most capable
- `claude-3-7-sonnet` - Alternative version

### Using the Interactive Script

```bash
./claude-mem-settings.sh
```

This script manages `CLAUDE_MEM_MODEL` in `~/.claude/settings.json`.

### Manual Configuration

Edit `~/.claude/settings.json`:

```json
{
  "CLAUDE_MEM_MODEL": "claude-sonnet-4-5"
}
```

## Files and Directories

### Data Directory Structure

```
~/.claude-mem/
├── claude-mem.db           # SQLite database
├── worker.port             # Current worker port file
└── logs/
    ├── worker-out.log      # Worker stdout logs
    └── worker-error.log    # Worker stderr logs
```

### Plugin Directory Structure

```
${CLAUDE_PLUGIN_ROOT}/
├── .claude-plugin/
│   └── plugin.json         # Plugin metadata
├── .mcp.json               # MCP server configuration
├── hooks/
│   └── hooks.json          # Hook configuration
└── scripts/                # Built executables
    ├── context-hook.js
    ├── new-hook.js
    ├── save-hook.js
    ├── summary-hook.js
    ├── cleanup-hook.js
    ├── worker-service.cjs
    └── search-server.js
```

## Plugin Configuration

### Hooks Configuration

Hooks are configured in `plugin/hooks/hooks.json`:

```json
{
  "description": "Claude-mem memory system hooks",
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "cd \"${CLAUDE_PLUGIN_ROOT}/..\" && npm install --prefer-offline --no-audit --no-fund --loglevel=error && node ${CLAUDE_PLUGIN_ROOT}/scripts/context-hook.js",
        "timeout": 120
      }]
    }],
    "UserPromptSubmit": [{
      "hooks": [{
        "type": "command",
        "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/new-hook.js",
        "timeout": 120
      }]
    }],
    "PostToolUse": [{
      "matcher": "*",
      "hooks": [{
        "type": "command",
        "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/save-hook.js",
        "timeout": 120
      }]
    }],
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/summary-hook.js",
        "timeout": 120
      }]
    }],
    "SessionEnd": [{
      "hooks": [{
        "type": "command",
        "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/cleanup-hook.js",
        "timeout": 120
      }]
    }]
  }
}
```

### MCP Server Configuration

The MCP search server is configured in `plugin/.mcp.json`:

```json
{
  "mcpServers": {
    "claude-mem-search": {
      "type": "stdio",
      "command": "${CLAUDE_PLUGIN_ROOT}/scripts/search-server.js"
    }
  }
}
```

This registers the `claude-mem-search` server with Claude Code, making the 7 search tools available in all sessions.

## PM2 Configuration

Worker service is managed by PM2 via `ecosystem.config.cjs`:

```javascript
module.exports = {
  apps: [{
    name: 'claude-mem-worker',
    script: './plugin/scripts/worker-service.cjs',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      FORCE_COLOR: '1'
    }
  }]
};
```

### PM2 Settings

- **instances**: 1 (single instance)
- **autorestart**: true (auto-restart on crash)
- **watch**: false (no file watching)
- **max_memory_restart**: 1G (restart if memory exceeds 1GB)

## Customization

### Custom Data Directory

For development or testing, override the data directory:

```bash
export CLAUDE_MEM_DATA_DIR=/custom/path
```

### Custom Worker Port

If port 37777 is in use:

```bash
export CLAUDE_MEM_WORKER_PORT=38000
npm run worker:restart
```

### Custom Model

Use a different AI model:

```bash
export CLAUDE_MEM_MODEL=claude-opus-4
npm run worker:restart
```

## Advanced Configuration

### Hook Timeouts

Modify timeouts in `plugin/hooks/hooks.json`:

```json
{
  "timeout": 120  // Default: 120 seconds
}
```

Recommended values:
- SessionStart: 120s (needs time for npm install and context retrieval)
- UserPromptSubmit: 60s
- PostToolUse: 120s (can process many observations)
- Stop: 60s
- SessionEnd: 60s

### Worker Memory Limit

Modify PM2 memory limit in `ecosystem.config.cjs`:

```javascript
{
  max_memory_restart: '2G'  // Increase if needed
}
```

### Logging Verbosity

Enable debug logging:

```bash
export DEBUG=claude-mem:*
npm run worker:restart
npm run worker:logs
```

## Configuration Best Practices

1. **Use defaults**: Default configuration works for most use cases
2. **Override selectively**: Only change what you need
3. **Document changes**: Keep track of custom configurations
4. **Test after changes**: Verify worker restarts successfully
5. **Monitor logs**: Check worker logs after configuration changes

## Troubleshooting Configuration

### Configuration Not Applied

1. Restart worker after changes:
   ```bash
   npm run worker:restart
   ```

2. Verify environment variables:
   ```bash
   echo $CLAUDE_MEM_MODEL
   echo $CLAUDE_MEM_WORKER_PORT
   ```

3. Check worker logs:
   ```bash
   npm run worker:logs
   ```

### Invalid Model Name

If you specify an invalid model name, the worker will fall back to `claude-sonnet-4-5` and log a warning.

Valid models:
- claude-haiku-4-5
- claude-sonnet-4-5
- claude-opus-4
- claude-3-7-sonnet

### Port Already in Use

If port 37777 is already in use:

1. Set custom port:
   ```bash
   export CLAUDE_MEM_WORKER_PORT=38000
   ```

2. Restart worker:
   ```bash
   npm run worker:restart
   ```

3. Verify new port:
   ```bash
   cat ~/.claude-mem/worker.port
   ```

## Next Steps

- [Architecture Overview](architecture/overview.md) - Understand the system
- [Troubleshooting](troubleshooting.md) - Common issues
- [Development](development.md) - Building from source
