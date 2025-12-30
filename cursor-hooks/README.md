# Claude-Mem Cursor Hooks Integration

> **Persistent AI Memory for Cursor - Free Options Available**

Give your Cursor AI persistent memory across sessions. Your agent remembers what it worked on, the decisions it made, and the patterns in your codebase - automatically.

### Why Claude-Mem?

- **Remember context across sessions**: No more re-explaining your codebase every time
- **Automatic capture**: MCP tools, shell commands, and file edits are logged without effort
- **Free tier options**: Works with Gemini (1500 free req/day) or OpenRouter (free models available)
- **Works with or without Claude Code**: Full functionality either way

### Quick Install (5 minutes)

```bash
# Clone and build
git clone https://github.com/thedotmack/claude-mem.git
cd claude-mem && bun install && bun run build

# Interactive setup (configures provider + installs hooks)
bun run cursor:setup
```

---

## Quick Start for Cursor Users

**Using Claude Code?** Skip to [Installation](#installation) - everything works automatically.

**Cursor-only (no Claude Code)?** See [STANDALONE-SETUP.md](STANDALONE-SETUP.md) for free-tier options using Gemini or OpenRouter.

---

## Overview

The hooks bridge Cursor's hook system to claude-mem's worker API, allowing:
- **Session Management**: Initialize sessions and generate summaries
- **Observation Capture**: Record MCP tool usage, shell commands, and file edits
- **Worker Readiness**: Ensure the worker is running before prompt submission

## Context Injection

Context is automatically injected via Cursor's **Rules** system:

1. **Install**: `claude-mem cursor install` generates initial context
2. **Stop hook**: Updates context in `.cursor/rules/claude-mem-context.mdc` after each session
3. **Cursor**: Automatically includes this rule in ALL chat sessions

**The context updates after each session ends**, so the next session sees fresh context.

### Additional Access Methods

- **MCP Tools**: Configure claude-mem's MCP server for `search`, `timeline`, `get_observations` tools
- **Web Viewer**: Access context at `http://localhost:37777`
- **Manual Request**: Ask the agent to search memory

See [CONTEXT-INJECTION.md](CONTEXT-INJECTION.md) for details.

## Installation

### Quick Install (Recommended)

```bash
# Install globally for all projects (recommended)
claude-mem cursor install user

# Or install for current project only
claude-mem cursor install
```

### Manual Installation

<details>
<summary>Click to expand manual installation steps</summary>

**User-level** (recommended - applies to all projects):
```bash
# Copy hooks.json to your home directory
cp cursor-hooks/hooks.json ~/.cursor/hooks.json

# Copy hook scripts
mkdir -p ~/.cursor/hooks
cp cursor-hooks/*.sh ~/.cursor/hooks/
chmod +x ~/.cursor/hooks/*.sh
```

**Project-level** (for per-project hooks):
```bash
# Copy hooks.json to your project
mkdir -p .cursor
cp cursor-hooks/hooks.json .cursor/hooks.json

# Copy hook scripts to your project
mkdir -p .cursor/hooks
cp cursor-hooks/*.sh .cursor/hooks/
chmod +x .cursor/hooks/*.sh
```

</details>

### After Installation

1. **Start the worker**:
   ```bash
   claude-mem start
   ```

2. **Restart Cursor** to load the hooks

3. **Verify installation**:
   ```bash
   claude-mem cursor status
   ```

## Hook Mappings

| Cursor Hook | Script | Purpose |
|-------------|--------|---------|
| `beforeSubmitPrompt` | `session-init.sh` | Initialize claude-mem session |
| `beforeSubmitPrompt` | `context-inject.sh` | Ensure worker is running |
| `afterMCPExecution` | `save-observation.sh` | Capture MCP tool usage |
| `afterShellExecution` | `save-observation.sh` | Capture shell command execution |
| `afterFileEdit` | `save-file-edit.sh` | Capture file edits |
| `stop` | `session-summary.sh` | Generate summary + update context file |

## How It Works

### Session Initialization (`session-init.sh`)
- Called before each prompt submission
- Initializes a new session in claude-mem using `conversation_id` as the session ID
- Extracts project name from workspace root
- Outputs `{"continue": true}` to allow prompt submission

### Context Hook (`context-inject.sh`)
- Ensures claude-mem worker is running before session
- Outputs `{"continue": true}` to allow prompt submission
- Note: Context file is updated by `session-summary.sh` (stop hook), not here

### Observation Capture (`save-observation.sh`)
- Captures MCP tool executions and shell commands
- Maps them to claude-mem's observation format
- Sends to `/api/sessions/observations` endpoint (fire-and-forget)

### File Edit Capture (`save-file-edit.sh`)
- Captures file edits made by the agent
- Treats edits as "write_file" tool usage
- Includes edit summaries in observations

### Session Summary (`session-summary.sh`)
- Called when agent loop ends (stop hook)
- Requests summary generation from claude-mem
- **Updates context file** in `.cursor/rules/claude-mem-context.mdc` for next session

## Configuration

The hooks read configuration from `~/.claude-mem/settings.json`:

- `CLAUDE_MEM_WORKER_PORT`: Worker port (default: 37777)
- `CLAUDE_MEM_WORKER_HOST`: Worker host (default: 127.0.0.1)

## Dependencies

The hook scripts require:
- `jq` - JSON processing
- `curl` - HTTP requests
- `bash` - Shell interpreter

Install on macOS: `brew install jq curl`
Install on Ubuntu: `apt-get install jq curl`

## Troubleshooting

### Hooks not executing

1. Check hooks are in the correct location:
   ```bash
   ls .cursor/hooks.json  # Project-level
   ls ~/.cursor/hooks.json  # User-level
   ```

2. Verify scripts are executable:
   ```bash
   chmod +x ~/.cursor/hooks/*.sh
   ```

3. Check Cursor Settings → Hooks tab for configuration status

4. Check Hooks output channel in Cursor for error messages

### Worker not responding

1. Verify worker is running:
   ```bash
   curl http://127.0.0.1:37777/api/readiness
   ```

2. Check worker logs:
   ```bash
   tail -f ~/.claude-mem/logs/worker-$(date +%Y-%m-%d).log
   ```

3. Restart worker:
   ```bash
   claude-mem restart
   ```

### Observations not being saved

1. Monitor worker logs for incoming requests

2. Verify session was initialized via web viewer at `http://localhost:37777`

3. Test observation endpoint directly:
   ```bash
   curl -X POST http://127.0.0.1:37777/api/sessions/observations \
     -H "Content-Type: application/json" \
     -d '{"contentSessionId":"test","tool_name":"test","tool_input":{},"tool_response":{},"cwd":"/tmp"}'
   ```

## Comparison with Claude Code Integration

| Feature | Claude Code | Cursor |
|---------|-------------|--------|
| Session Initialization | ✅ `SessionStart` hook | ✅ `beforeSubmitPrompt` hook |
| Context Injection | ✅ `additionalContext` field | ✅ Auto-updated `.cursor/rules/` file |
| Observation Capture | ✅ `PostToolUse` hook | ✅ `afterMCPExecution`, `afterShellExecution`, `afterFileEdit` |
| Session Summary | ✅ `Stop` hook with transcript | ⚠️ `stop` hook (no transcript) |
| MCP Search Tools | ✅ Full support | ✅ Full support (if MCP configured) |

## Files

- `hooks.json` - Hook configuration
- `common.sh` - Shared utility functions
- `session-init.sh` - Session initialization
- `context-inject.sh` - Context/worker readiness hook
- `save-observation.sh` - MCP and shell observation capture
- `save-file-edit.sh` - File edit observation capture
- `session-summary.sh` - Summary generation
- `cursorrules-template.md` - Template for `.cursorrules` file

## See Also

- [Claude-Mem Documentation](https://docs.claude-mem.ai)
- [Cursor Hooks Reference](../docs/context/cursor-hooks-reference.md)
- [Claude-Mem Architecture](https://docs.claude-mem.ai/architecture/overview)
