# Claude-mem Plugin Structure

This document describes the complete plugin structure for claude-mem, which enables self-contained installation via Claude Code's plugin system.

## Directory Structure

```
claude-mem/
├── .claude-plugin/
│   └── plugin.json                  # Plugin metadata
├── commands/
│   ├── claude-mem.md                # /claude-mem slash command
│   ├── remember.md                  # /remember slash command
│   └── save.md                      # /save slash command
├── hooks/
│   └── hooks.json                   # Hook definitions using ${CLAUDE_PLUGIN_ROOT}
├── scripts/
│   ├── build-hooks.js               # Build script for compiling hooks
│   └── hooks/                       # Compiled hook executables
│       ├── context-hook.js          # SessionStart hook (4KB)
│       ├── new-hook.js              # UserPromptSubmit hook (4KB)
│       ├── save-hook.js             # PostToolUse hook (4KB)
│       ├── summary-hook.js          # Stop hook (4KB)
│       └── worker.js                # Background SDK worker (232KB)
├── src/
│   ├── bin/
│   │   ├── cli.ts                   # Main CLI entry point
│   │   └── hooks/                   # Hook entry point sources
│   │       ├── context-hook.ts      # SessionStart entry point
│   │       ├── new-hook.ts          # UserPromptSubmit entry point
│   │       ├── save-hook.ts         # PostToolUse entry point
│   │       └── summary-hook.ts      # Stop entry point
│   ├── hooks/                       # Hook implementation functions
│   │   ├── context.ts
│   │   ├── new.ts
│   │   ├── save.ts
│   │   └── summary.ts
│   └── ...                          # Other source files
└── dist/
    └── claude-mem.min.js            # Bundled CLI executable
```

## How It Works

### 1. Plugin Installation

When users install the plugin via `/plugin install claude-mem`, Claude Code:
1. Downloads the plugin from the marketplace
2. Installs it to the local plugins directory
3. Registers the hooks from `hooks/hooks.json`
4. Makes slash commands from `commands/` directory available

### 2. Self-Contained Execution

The hooks are compiled as standalone executables that:
- **Don't require global CLI installation**: All dependencies are bundled
- **Use plugin-relative paths**: `${CLAUDE_PLUGIN_ROOT}` resolves to plugin directory
- **Work with Bun runtime**: Scripts are compiled for Bun and include shebang

### 3. Hook Configuration

The `hooks/hooks.json` file uses `${CLAUDE_PLUGIN_ROOT}` to reference bundled scripts:

```json
{
  "description": "Claude-mem memory system hooks",
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "bun ${CLAUDE_PLUGIN_ROOT}/scripts/hooks/context-hook.js",
        "timeout": 180000
      }]
    }],
    ...
  }
}
```

### 4. Hook Entry Points

Each hook has a standalone entry point in `src/bin/hooks/` that:
- Reads JSON input from stdin
- Calls the hook implementation function
- Handles errors gracefully
- Exits with appropriate status codes

Example from `context-hook.ts`:
```typescript
#!/usr/bin/env bun
import { contextHook } from '../../hooks/context.js';

const input = await Bun.stdin.text();
const parsed = input.trim() ? JSON.parse(input) : undefined;
contextHook(parsed);
```

### 5. Build Process

The build system compiles both the CLI and hook scripts:

```bash
npm run build          # Build both CLI and hooks
npm run build:cli      # Build only the CLI
npm run build:hooks    # Build only the hooks
```

The hook build process:
1. Compiles each hook entry point with Bun
2. Bundles all dependencies (except bun:sqlite)
3. Minifies the output
4. Adds shebang (`#!/usr/bin/env bun`)
5. Makes executable (`chmod +x`)
6. Outputs to `scripts/hooks/`

## Benefits

### ✅ Self-Contained
- No global CLI installation required
- All dependencies bundled with plugin
- Plugin directory has everything needed

### ✅ Easy Installation
- Single command: `/plugin install claude-mem`
- Hooks automatically registered
- Slash commands immediately available

### ✅ Version Control
- Plugin version tied to specific hook versions
- No version mismatch between CLI and hooks
- Easy updates via `/plugin update`

### ✅ Development Friendly
- Source code in TypeScript
- Compiled to optimized JavaScript
- Fast execution with Bun runtime

## Usage

### For Users

Install the plugin:
```
/plugin install claude-mem@marketplace-name
```

The plugin provides:
- **Hooks**: Automatic memory capture on SessionStart, UserPromptSubmit, PostToolUse, Stop
- **Commands**: `/claude-mem`, `/save`, `/remember` slash commands
- **MCP Integration**: Chroma vector database access via MCP tools

### For Developers

Build the plugin:
```bash
npm run build
```

Test hooks locally:
```bash
echo '{"session_id":"test","cwd":"/path"}' | bun scripts/hooks/context-hook.js
```

Publish to marketplace:
```bash
npm run publish:npm
```

## Worker Process Handling

### Background Worker

The `worker.js` is a special bundled script that runs as a long-lived background process. It:
- Runs an SDK agent session in the background
- Listens on a Unix socket for messages from hooks
- Processes tool observations and generates summaries
- Stores results in the database

### Spawning the Worker

The `new-hook` (UserPromptSubmit) is responsible for spawning the worker. It uses intelligent fallback:

```typescript
// Plugin mode: Use bundled worker with CLAUDE_PLUGIN_ROOT
if (process.env.CLAUDE_PLUGIN_ROOT) {
  const workerPath = path.join(pluginRoot, 'scripts', 'hooks', 'worker.js');
  spawn('bun', [workerPath, sessionId.toString()], { detached: true });
}
// Traditional mode: Use global CLI
else {
  spawn('claude-mem', ['worker', sessionId.toString()], { detached: true });
}
```

### Why This Approach?

1. **Self-contained plugin**: When installed as a plugin, uses bundled worker
2. **Backwards compatible**: When installed traditionally, uses global CLI
3. **No user intervention**: Automatically detects mode via environment variable

## File Sizes

Compiled hook scripts are optimized and small:
- `context-hook.js`: ~4.1 KB
- `new-hook.js`: ~4.0 KB
- `save-hook.js`: ~4.2 KB
- `summary-hook.js`: ~3.9 KB
- `worker.js`: ~232 KB (includes SDK dependencies)

Total package overhead: ~248 KB for all hook scripts combined.

## Dependencies

### Runtime
- **Bun**: Required for executing hook scripts
- **bun:sqlite**: Native SQLite module (not bundled)

### Build-time
- **Bun**: Used as bundler for compilation
- **Node.js**: Required for build scripts

## Backwards Compatibility

The plugin structure maintains backwards compatibility:
- CLI commands still work: `claude-mem context`, etc.
- Traditional installation still supported: `npm install -g claude-mem`
- Users can choose plugin OR CLI installation

## Future Enhancements

Potential improvements:
- [ ] Add more hooks (e.g., PreToolUse, Error)
- [ ] Support Node.js runtime in addition to Bun
- [ ] Add hook configuration UI
- [ ] Implement hook hot-reloading during development
- [ ] Create plugin marketplace for distribution

## See Also

- [Plugin Installation Guide](./PLUGIN_INSTALLATION.md) - User-facing installation instructions
- [Build Documentation](./BUILD.md) - Build system details
- [Claude Code Plugins Docs](https://docs.claude.com/en/docs/claude-code/plugins) - Official plugin documentation
