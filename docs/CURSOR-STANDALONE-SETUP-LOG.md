# Cursor Standalone Setup Log

This documents the setup process for using claude-mem with Cursor (without Claude Code).

## Date: January 15, 2026

## Prerequisites
- Bun installed at `~/.bun/bin/bun`
- claude-mem plugin synced to `~/.claude/plugins/marketplaces/thedotmack/`

## Setup Steps Performed

### 1. Sync Marketplace
```bash
node scripts/sync-marketplace.cjs
```

### 2. Fix Missing cursor-hooks Stub
The `findCursorHooksDir()` function checks for `common.sh` but it doesn't exist in unified CLI mode.

**Workaround:** Created stub file:
```bash
echo '#!/bin/bash
# Stub file - unified CLI mode does not use shell scripts' > ~/.claude/plugins/marketplaces/thedotmack/cursor-hooks/common.sh
```

**Bug to fix:** Update `src/services/integrations/CursorHooksInstaller.ts:133-150` to not require legacy shell scripts.

### 3. Install Hooks at User Level
```bash
~/.bun/bin/bun ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs cursor install user
```

This creates `~/.cursor/hooks.json`.

### 4. Fix hooks.json to Use Bun Instead of Node
The installer generates hooks using `node` but worker-service.cjs requires `bun:sqlite`.

**Manual fix:** Replace all `node` with `/home/prosperitylabs/.bun/bin/bun` in `~/.cursor/hooks.json`.

**Bug to fix:** Update `src/services/integrations/CursorHooksInstaller.ts:320-321` to use bun path instead of node.

### 5. Start the Worker
```bash
~/.bun/bin/bun ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs start
```

### 6. Restart Cursor
Close and reopen Cursor to load the hooks.

## Final hooks.json Configuration
Location: `~/.cursor/hooks.json`

```json
{
  "version": 1,
  "hooks": {
    "beforeSubmitPrompt": [
      {
        "command": "/home/prosperitylabs/.bun/bin/bun \"/home/prosperitylabs/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs\" hook cursor session-init"
      },
      {
        "command": "/home/prosperitylabs/.bun/bin/bun \"/home/prosperitylabs/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs\" hook cursor context"
      }
    ],
    "afterMCPExecution": [
      {
        "command": "/home/prosperitylabs/.bun/bin/bun \"/home/prosperitylabs/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs\" hook cursor observation"
      }
    ],
    "afterShellExecution": [
      {
        "command": "/home/prosperitylabs/.bun/bin/bun \"/home/prosperitylabs/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs\" hook cursor observation"
      }
    ],
    "afterFileEdit": [
      {
        "command": "/home/prosperitylabs/.bun/bin/bun \"/home/prosperitylabs/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs\" hook cursor file-edit"
      }
    ],
    "stop": [
      {
        "command": "/home/prosperitylabs/.bun/bin/bun \"/home/prosperitylabs/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs\" hook cursor summarize"
      }
    ]
  }
}
```

## Verification Commands

### Check hook status
```bash
~/.bun/bin/bun ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs cursor status
```

### Check worker is running
```bash
curl -s http://127.0.0.1:37777/api/readiness
```

### Check stats
```bash
curl -s http://127.0.0.1:37777/api/stats
```

### View web UI
Open http://localhost:37777 in browser.

### View logs
```bash
tail -f ~/.claude-mem/logs/worker-$(date +%Y-%m-%d).log
```

## Project Separation
Memory is automatically separated by project (folder name). Each project gets:
- Its own sessions
- Its own observations
- Its own context injection via `.cursor/rules/claude-mem-context.mdc`

## Bugs Found During Setup

See [CURSOR-SETUP-BUGS-AND-FIXES.md](./CURSOR-SETUP-BUGS-AND-FIXES.md) for detailed bug analysis and proposed fixes.

### Summary

1. **`findCursorHooksDir()` requires legacy shell scripts**
   - Location: `src/services/integrations/CursorHooksInstaller.ts:133-150`
   - Issue: Checks for `common.sh`/`common.ps1` which don't exist in unified CLI mode
   - Fix: Check for `hooks.json` instead

2. **Installer uses `node` instead of `bun`**
   - Location: `src/services/integrations/CursorHooksInstaller.ts:320-321`
   - Issue: `makeHookCommand` uses `node` but script requires `bun:sqlite`
   - Fix: Detect bun path and use that instead

## Useful Paths
- Plugin: `~/.claude/plugins/marketplaces/thedotmack/`
- Database: `~/.claude-mem/claude-mem.db`
- Logs: `~/.claude-mem/logs/`
- User hooks: `~/.cursor/hooks.json`
- Bun: `~/.bun/bin/bun`

---

## Testing Results (January 15, 2026)

### Verification Complete
After setup, tested with the `monra.app` project in Cursor.

**Stats after testing:**
- Sessions: 4
- Observations: 7
- Summaries: 0 (generated on session end)

### What Gets Captured

| Event | Captured | Notes |
|-------|----------|-------|
| User prompts | ✅ Yes | Stored via `beforeSubmitPrompt` hook |
| MCP tool usage | ✅ Yes | Stored via `afterMCPExecution` hook |
| Shell commands | ✅ Yes | Stored via `afterShellExecution` hook |
| File edits | ✅ Yes | Stored via `afterFileEdit` hook |
| AI text responses | ❌ No | Not captured by design |
| Session summaries | ✅ Yes | Generated via `stop` hook |

### Sample Observations Captured
From `monra.app` project database exploration:
1. Database Schema Verification Request
2. PostgreSQL MCP Connection SSL issue discovery
3. Database Schema Retrieved (17 tables found)
4. Primary Keys and Unique Constraints analysis
5. Foreign Key Relationships mapping
6. Updated Database Schema ERD creation

Each observation includes:
- `title`: Short description
- `narrative`: Detailed explanation
- `facts`: Key points extracted
- `concepts`: Categorization tags
- `files_read` / `files_modified`: File tracking

### Using Claude Code and Cursor Together

Both tools share the same memory database:
- **Same database**: `~/.claude-mem/claude-mem.db`
- **Same project separation**: Folder name determines project
- **Interchangeable**: Switch freely between tools
- **Shared context**: Context from Cursor sessions available in Claude Code and vice versa

### Debugging Tips

1. **Check Cursor Hooks output channel**:
   - Command Palette → "Output: Show Output Channels" → "Hooks"

2. **Test hooks manually**:
   ```bash
   echo '{"conversation_id":"test","workspace_roots":["/tmp"],"tool_name":"Test","tool_input":{},"result_json":{}}' | \
     timeout 5 ~/.bun/bin/bun ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs hook cursor observation
   ```

3. **Check database stats**:
   ```bash
   curl -s http://127.0.0.1:37777/api/stats
   ```

4. **View observations**:
   ```bash
   curl -s "http://127.0.0.1:37777/api/observations?limit=5"
   ```
