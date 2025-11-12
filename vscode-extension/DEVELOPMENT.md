# VSCode Extension Development Guide

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Ensure claude-mem worker is running:
   ```bash
   pm2 start claude-mem-worker
   ```

## Building

```bash
npm run build
```

This uses esbuild to bundle the extension into `dist/extension.js`.

## Development

### Watch Mode

```bash
npm run watch
```

This will automatically rebuild on file changes.

### Debugging

1. Open this folder in VSCode
2. Press F5 to launch the Extension Development Host
3. The extension will be loaded in a new VSCode window
4. Set breakpoints in your TypeScript source files

### Testing

Run tests:
```bash
npm test
```

The tests use `@vscode/test-electron` to run integration tests in a real VSCode environment.

## Architecture

### Files

- `src/extension.ts` - Main entry point, tool registration, commands
- `src/session-manager.ts` - Session lifecycle and database management
- `src/worker-client.ts` - HTTP client for worker service communication
- `build.mjs` - esbuild build script
- `package.json` - Extension manifest with tool definitions

### Language Model Tools

The extension registers 5 tools that GitHub Copilot can invoke:

1. **mem_session_init** - Initialize memory session
2. **mem_user_prompt_log** - Log user prompts
3. **mem_observation_record** - Record tool usage
4. **mem_summary_finalize** - Generate session summary
5. **mem_session_cleanup** - Mark session complete

Each tool:
- Has a `prepareInvocation` handler for validation and user confirmation
- Has an `invoke` handler that calls the worker service
- Returns a `LanguageModelToolResult` with success/error messages

### Session Management

Sessions are tracked in two places:

1. **In-memory** (SessionManager) - Active session state
2. **SQLite database** - Persistent storage shared with Claude Code plugin

The `conversationId` from Copilot maps to `claude_session_id` in the database.

### Worker Communication

All worker communication uses HTTP:

- Port discovery: `~/.claude-mem/settings.json` > env > default (37777)
- Health checks: `GET /health` with 1s timeout
- Session operations: `POST /sessions/:id/*` endpoints

Error handling:
- Connection errors → Show "worker not running" message
- HTTP errors → Pass through error text to LLM

## Packaging

To create a .vsix package:

```bash
npx @vscode/vsce package
```

This creates `claude-mem-vscode-0.1.0.vsix` that can be installed locally or published to the marketplace.

## Publishing

1. Build and test:
   ```bash
   npm run build
   npm test
   ```

2. Update version in package.json

3. Update CHANGELOG.md

4. Create package:
   ```bash
   npx @vscode/vsce package
   ```

5. Publish:
   ```bash
   npx @vscode/vsce publish
   ```

## Troubleshooting

### Extension Not Activating

- Check activation events in package.json
- Ensure tool names match exactly
- Look for errors in Developer Tools (Help > Toggle Developer Tools)

### Worker Connection Issues

- Verify worker is running: `pm2 list`
- Check worker logs: `pm2 logs claude-mem-worker`
- Test health endpoint: `curl http://localhost:37777/health`

### Database Errors

- Ensure database exists: `ls ~/.claude-mem/claude-mem.db`
- Check database permissions
- Verify better-sqlite3 is installed: `npm list better-sqlite3`

### Build Errors

- Clean and rebuild:
  ```bash
  rm -rf dist node_modules
  npm install
  npm run build
  ```

## Testing Integration with Copilot

1. Install the extension in VSCode
2. Open a workspace
3. Start a Copilot chat
4. The extension will automatically register tools
5. Copilot can now invoke mem_* tools

To verify tools are registered:
- Open Developer Tools (Help > Toggle Developer Tools)
- Check console for "Claude Mem extension is now active"
- Run command: "Claude Mem: Check Worker Health"

## Contributing

See the main claude-mem repository for contribution guidelines.
