# Plugin Development Guide

This guide helps developers work with the claude-mem plugin structure during development.

## Quick Start

### 1. Build the Plugin

```bash
# Build both CLI and hooks
npm run build

# Or build separately
npm run build:cli    # Just the CLI
npm run build:hooks  # Just the hooks
```

### 2. Test Hooks Locally

Test individual hooks by piping JSON input:

```bash
# Test context hook (SessionStart)
printf '{"session_id":"test-123","cwd":"/Users/you/project","source":"startup"}' | \
  bun scripts/hooks/context-hook.js

# Test new hook (UserPromptSubmit)
printf '{"session_id":"test-123","cwd":"/Users/you/project","prompt":"help me code"}' | \
  bun scripts/hooks/new-hook.js

# Test save hook (PostToolUse)
printf '{"session_id":"test-123","cwd":"/Users/you/project","tool_name":"Read","tool_input":{},"tool_output":{}}' | \
  bun scripts/hooks/save-hook.js

# Test summary hook (Stop)
printf '{"session_id":"test-123","cwd":"/Users/you/project"}' | \
  bun scripts/hooks/summary-hook.js

# Test worker (requires valid session ID in database)
bun scripts/hooks/worker.js 999
```

### 3. Test Worker with Plugin Root

Verify the new-hook correctly detects plugin mode:

```bash
# Without CLAUDE_PLUGIN_ROOT (traditional mode)
printf '{"session_id":"test-new","cwd":"/path","prompt":"test"}' | \
  bun scripts/hooks/new-hook.js

# With CLAUDE_PLUGIN_ROOT (plugin mode)
CLAUDE_PLUGIN_ROOT=$(pwd) printf '{"session_id":"test-plugin","cwd":"/path","prompt":"test"}' | \
  bun scripts/hooks/new-hook.js
```

In plugin mode, the new-hook will attempt to spawn `bun ${CLAUDE_PLUGIN_ROOT}/scripts/hooks/worker.js`.
In traditional mode, it will attempt to spawn `claude-mem worker`.

### 4. Test With No Input

Each hook should handle missing input gracefully:

```bash
echo '' | bun scripts/hooks/context-hook.js
# Output: No input provided - this script is designed to run as a Claude Code SessionStart hook
```

## Local Plugin Testing

### Option 1: Dev Marketplace (Recommended)

Create a development marketplace to test your plugin:

```bash
# Create marketplace structure
mkdir -p ~/dev-marketplace/.claude-plugin

# Create marketplace manifest
cat > ~/dev-marketplace/.claude-plugin/marketplace.json << 'EOF'
{
  "name": "dev-marketplace",
  "owner": {
    "name": "Developer"
  },
  "plugins": [
    {
      "name": "claude-mem",
      "source": "./claude-mem-plugin",
      "description": "Persistent memory system for Claude Code"
    }
  ]
}
EOF

# Symlink your working directory
ln -s /path/to/your/claude-mem ~/dev-marketplace/claude-mem-plugin
```

Then in Claude Code:

```
/plugin marketplace add /absolute/path/to/dev-marketplace
/plugin install claude-mem@dev-marketplace
```

### Option 2: Direct Testing

Test the CLI commands directly:

```bash
# Build first
npm run build

# Test CLI commands
./dist/claude-mem.min.js --version
./dist/claude-mem.min.js status
./dist/claude-mem.min.js --help
```

## Development Workflow

### Making Changes to Hooks

1. **Edit TypeScript source** in `src/hooks/` or `src/bin/hooks/`
2. **Rebuild hooks**: `npm run build:hooks`
3. **Test locally**: Use echo piping method above
4. **Reinstall plugin** (if testing in Claude Code):
   ```
   /plugin uninstall claude-mem@dev-marketplace
   /plugin install claude-mem@dev-marketplace
   ```

### Making Changes to CLI

1. **Edit TypeScript source** in `src/`
2. **Rebuild CLI**: `npm run build:cli`
3. **Test directly**: `./dist/claude-mem.min.js [command]`

### Making Changes to Commands

1. **Edit markdown files** in `commands/`
2. **No rebuild needed** (commands are read directly)
3. **Reinstall plugin** to pick up changes:
   ```
   /plugin uninstall claude-mem@dev-marketplace
   /plugin install claude-mem@dev-marketplace
   ```

## Debugging

### Enable Verbose Logging

Set environment variables for more detailed output:

```bash
DEBUG=claude-mem:* bun scripts/hooks/context-hook.js
```

### Check Hook Output

Hooks write to stdout/stderr. Capture output:

```bash
echo '{"session_id":"test","cwd":"/path"}' | \
  bun scripts/hooks/context-hook.js 2>&1 | tee hook-output.log
```

### Verify Plugin Root Variable

Test that `${CLAUDE_PLUGIN_ROOT}` resolves correctly:

```bash
# Manually set it for testing
export CLAUDE_PLUGIN_ROOT=/path/to/your/plugin
echo '{"session_id":"test","cwd":"/path"}' | \
  bun ${CLAUDE_PLUGIN_ROOT}/scripts/hooks/context-hook.js
```

## Build System Details

### Hook Build Process

The `scripts/build-hooks.js` script:
1. Reads each entry point from `src/bin/hooks/`
2. Bundles with Bun build system
3. Minifies output
4. Adds shebang for direct execution
5. Sets executable permissions
6. Outputs to `scripts/hooks/`

### CLI Build Process

The `scripts/build.js` script:
1. Bundles main CLI from `src/bin/cli.ts`
2. Externalizes large dependencies
3. Minifies output
4. Adds shebang
5. Sets executable permissions
6. Outputs to `dist/claude-mem.min.js`

### Build Configuration

Both builds use similar Bun configuration:
- **Target**: `bun` runtime
- **Minify**: `true`
- **External**: `bun:sqlite` (native module)
- **Define**: `__DEFAULT_PACKAGE_VERSION__` from package.json

## Testing

### Run Tests

```bash
bun test tests/
```

### Test Database Operations

```bash
# Test hooks database
bun test tests/hooks-database-integration.test.ts

# Test session lifecycle
bun test tests/session-lifecycle.test.ts
```

## Publishing

### Pre-publish Checklist

- [ ] All tests pass: `bun test tests/`
- [ ] Build succeeds: `npm run build`
- [ ] Version updated in `package.json`
- [ ] Changelog updated in `docs/CHANGELOG.md`
- [ ] Plugin.json version matches package.json
- [ ] Hooks tested locally
- [ ] CLI tested locally

### Publish to npm

```bash
npm run publish:npm
```

This will:
1. Run `prepublishOnly` script (builds everything)
2. Publish to npm registry
3. Include files listed in `package.json` "files" array

### Files Included in Package

The npm package includes:
- `dist/` - Compiled CLI
- `scripts/` - Compiled hooks
- `commands/` - Slash command definitions
- `hooks/` - Hook configuration
- `.claude-plugin/` - Plugin metadata
- `src/` - TypeScript source (for reference)
- `docs/` - Documentation
- `.mcp.json` - MCP server configuration

## Troubleshooting

### Build Fails

**Problem**: `bun: command not found`
**Solution**: Install Bun from https://bun.sh

**Problem**: Build errors with external dependencies
**Solution**: Check that `bun:sqlite` is not bundled (should be external)

### Hooks Don't Execute

**Problem**: `Permission denied` when executing hooks
**Solution**: Ensure scripts are executable: `chmod +x scripts/hooks/*.js`

**Problem**: Hooks exit silently
**Solution**: Check error handling - hooks catch all errors and exit gracefully

### Plugin Not Found

**Problem**: `/plugin install` can't find claude-mem
**Solution**:
1. Verify marketplace is added: `/plugin marketplace list`
2. Check marketplace manifest includes claude-mem
3. Refresh marketplace: `/plugin marketplace refresh`

## Tips

1. **Use symlinks** in dev marketplace for faster iteration
2. **Test hooks with edge cases** (empty input, malformed JSON)
3. **Check file sizes** after build to catch bloat
4. **Version everything together** (CLI, hooks, plugin.json)
5. **Document breaking changes** in CHANGELOG.md

## Resources

- [Plugin Structure Documentation](./PLUGIN_STRUCTURE.md)
- [Plugin Installation Guide](./PLUGIN_INSTALLATION.md)
- [Build Documentation](./BUILD.md)
- [Claude Code Plugins Docs](https://docs.claude.com/en/docs/claude-code/plugins)
- [Bun Documentation](https://bun.sh/docs)

## Getting Help

- **Issues**: https://github.com/thedotmack/claude-mem/issues
- **Discussions**: https://github.com/thedotmack/claude-mem/discussions
