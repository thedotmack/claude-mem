# Claude-Mem iFlow CLI Integration

This is an integration of [claude-mem](https://github.com/thedotmack/claude-mem) for iFlow CLI.

## Quick Start

```bash
# One-click installation
curl -fsSL https://raw.githubusercontent.com/thedotmack/claude-mem/main/iflow-cli/install.sh | bash

# Restart iFlow CLI
iflow
```

## Features

- 🧠 **Persistent Memory** - Session context persists across sessions
- 📊 **Progressive Injection** - Automatically injects relevant historical context
- 🔍 **Semantic Search** - Use `@mem-search` to search historical memories
- 🤖 **Auto Capture** - Automatically records important tool calls
- 📝 **Session Summaries** - Automatically generates work summaries

## File Structure

```
claude-mem-iflow/
├── .iflow/
│   ├── settings.json        # Hooks + MCP configuration
│   ├── skills/
│   │   ├── mem-search/
│   │   │   └── SKILL.md     # @mem-search skill
│   │   └── mem-context/
│   │       └── SKILL.md     # @mem-context skill
│   └── hooks/
│       ├── start-worker.js       # Start worker
│       ├── capture-observation.js  # Capture tool calls
│       ├── inject-context.js     # Inject context
│       ├── summarize-session.js  # Generate summary
│       └── session-complete.js   # Save session state
├── install.sh               # Installation script
└── README.md
```

## Usage

### Automatic Features

After installation, the following are automatically enabled:

| Timing | Function |
|--------|----------|
| SessionStart | Start worker + inject historical context |
| PostToolUse | Auto capture tool calls as observations |
| Stop | Generate session summary |
| SessionEnd | Save session state |

### Manual Skills

```
@mem-search <query>     # Search historical memories
@mem-context            # Manually inject context
```

## Configuration

Edit `~/.iflow/settings.json`:

```json
{
  "claudeMem": {
    "workerPort": 37777,
    "project": "my-project",
    "autoCapture": true,
    "autoInject": true,
    "maxContextTokens": 4000
  }
}
```

## Relationship with Claude Code Version

This integration is an iFlow CLI adaptation of claude-mem:

| Feature | Claude Code | iFlow CLI |
|---------|-------------|-----------|
| Environment variables | `CLAUDE_*` | `IFLOW_*` |
| Trigger method | Plugin hooks | settings.json hooks |
| Command system | Skills | Skills |
| Data storage | Shared SQLite | Shared SQLite |

The core worker service is **shared**, so data can be synchronized between both platforms.

## API Endpoints Used

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/health` | GET | Check worker status |
| `/api/sessions/observations` | POST | Save observation |
| `/api/sessions/summarize` | POST | Generate summary |
| `/api/search` | GET | Search memories |

**Note**: All endpoints use `/api/` prefix, not just `/health`.

## Troubleshooting

### Worker Not Started

```bash
# Manual start
cd ~/.claude-mem
npm run worker:start

# Check status
curl http://localhost:37777/api/health
```

### Memories Not Injected

```bash
# Check configuration
cat ~/.iflow/settings.json | grep -A 20 hooks

# Manual injection
node ~/.claude-mem/iflow-cli/hooks/inject-context.js
```

### Debug Mode

```bash
# Run hooks manually to see output
node ~/.claude-mem/iflow-cli/hooks/start-worker.js
node ~/.claude-mem/iflow-cli/hooks/inject-context.js
```

## License

AGPL-3.0 (consistent with claude-mem main project)

## Related Links

- [claude-mem Main Project](https://github.com/thedotmack/claude-mem)
- [iFlow CLI Documentation](https://platform.iflow.cn/cli)