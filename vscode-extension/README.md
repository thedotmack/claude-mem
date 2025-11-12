# Claude Mem for VSCode Copilot

Persistent memory for GitHub Copilot conversations powered by claude-mem.

## Features

- **Automatic Memory Capture**: Records your Copilot interactions for future reference
- **Session Management**: Tracks conversations with automatic initialization
- **Tool Integration**: Captures file edits, terminal commands, and other tool usage
- **Session Summaries**: Generates structured summaries of what was investigated, learned, and completed
- **Worker Health Monitoring**: Status bar indicator shows worker service health
- **Memory Viewer**: Built-in web viewer to explore your memory stream

## Requirements

- **Claude-mem worker service must be running** (install separately)
- VSCode 1.90.0 or higher
- GitHub Copilot extension

## Installation

1. Install the claude-mem worker service:
   ```bash
   npm install -g claude-mem
   ```

2. Start the worker:
   ```bash
   pm2 start claude-mem-worker
   ```

3. Install this extension from the VSCode marketplace

## Usage

### Automatic Mode

The extension automatically:
- Initializes memory sessions when you start a Copilot conversation
- Captures tool usage as observations
- Generates summaries when you stop Copilot

### Manual Commands

- **Claude Mem: Check Worker Health** - Verify worker is running
- **Claude Mem: Restart Worker** - Restart the worker service
- **Claude Mem: Open Memory Viewer** - View your memory stream in browser
- **Claude Mem: Open Settings** - Configure extension settings

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `claudeMem.workerPort` | 37777 | Port for worker service |
| `claudeMem.autoInit` | true | Auto-initialize sessions |
| `claudeMem.autoCapture` | true | Auto-capture tool usage |
| `claudeMem.maxObservationsPerPrompt` | 10 | Max observations per prompt |
| `claudeMem.showStatusBar` | true | Show status bar indicator |

## Architecture

This extension provides 5 Language Model Tools that Copilot can invoke:

1. **mem_session_init** - Initialize memory session
2. **mem_user_prompt_log** - Log user prompts
3. **mem_observation_record** - Record tool usage
4. **mem_summary_finalize** - Generate session summary
5. **mem_session_cleanup** - Mark session complete

All data is stored in the same SQLite database as the Claude Code plugin (`~/.claude-mem/claude-mem.db`).

## Troubleshooting

### Worker Not Responding

If you see a warning icon in the status bar:

1. Click the status bar item to check health
2. Run: `pm2 restart claude-mem-worker`
3. Check logs: `pm2 logs claude-mem-worker`

### Session Not Initializing

- Ensure worker is running: `pm2 list`
- Check worker health: Click status bar item
- Verify database exists: `~/.claude-mem/claude-mem.db`

## Development

See [docs/context/vscode-copilot-extension-plan.md](../docs/context/vscode-copilot-extension-plan.md) for implementation details.

## License

MIT

## More Information

- [Claude-mem Plugin](https://github.com/thedotmack/claude-mem)
- [Report Issues](https://github.com/thedotmack/claude-mem/issues)
