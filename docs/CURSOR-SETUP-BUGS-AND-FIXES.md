# Cursor Standalone Setup: Bugs and Fixes

This document describes two bugs discovered during Cursor standalone setup and their proposed solutions.

## Bug 1: `findCursorHooksDir()` Requires Legacy Shell Scripts

### Problem

The `findCursorHooksDir()` function in `src/services/integrations/CursorHooksInstaller.ts` checks for the existence of `common.sh` or `common.ps1` files:

```typescript
// Lines 133-150
export function findCursorHooksDir(): string | null {
  const possiblePaths = [
    path.join(homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack', 'cursor-hooks'),
    path.join(path.dirname(__filename), '..', '..', 'cursor-hooks'),
    path.join(process.cwd(), 'cursor-hooks'),
  ];

  for (const p of possiblePaths) {
    // Check for either bash or PowerShell common script
    if (existsSync(path.join(p, 'common.sh')) || existsSync(path.join(p, 'common.ps1'))) {
      return p;
    }
  }
  return null;
}
```

**Issue**: The unified CLI mode (introduced to replace shell scripts) doesn't use `common.sh` or `common.ps1`. These files don't exist in the `cursor-hooks/` directory, causing `findCursorHooksDir()` to return `null` and the installation to fail with:

```
Could not find cursor-hooks directory
   Expected at: ~/.claude/plugins/marketplaces/thedotmack/cursor-hooks/
```

### Root Cause

The check was written for the legacy shell script approach but wasn't updated when the unified CLI mode was implemented. The `installCursorHooks()` function no longer uses the shell scripts (note the `_sourceDir` parameter is unused), but the directory validation still requires them.

### Proposed Fix

Update `findCursorHooksDir()` to check for `hooks.json` instead (which exists in the directory):

```typescript
export function findCursorHooksDir(): string | null {
  const possiblePaths = [
    path.join(homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack', 'cursor-hooks'),
    path.join(path.dirname(__filename), '..', '..', 'cursor-hooks'),
    path.join(process.cwd(), 'cursor-hooks'),
  ];

  for (const p of possiblePaths) {
    // Check for hooks.json (unified CLI mode) or legacy shell scripts
    if (existsSync(path.join(p, 'hooks.json')) ||
        existsSync(path.join(p, 'common.sh')) ||
        existsSync(path.join(p, 'common.ps1'))) {
      return p;
    }
  }
  return null;
}
```

**Alternative**: Since `installCursorHooks()` doesn't actually use the source directory anymore (it generates hooks.json dynamically), the check could be removed entirely or simplified.

---

## Bug 2: Installer Uses `node` Instead of `bun`

### Problem

The `installCursorHooks()` function generates hooks.json with commands that use `node`:

```typescript
// Lines 319-321
const makeHookCommand = (command: string) => {
  return `node "${escapedWorkerPath}" hook cursor ${command}`;
};
```

**Issue**: The `worker-service.cjs` script imports `bun:sqlite`, which is a Bun-specific module not available in Node.js. When Cursor executes the hooks, they fail with:

```
Error: Cannot find module 'bun:sqlite'
Require stack:
- /home/user/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs
```

### Root Cause

The code assumes `node` is the runtime, but `worker-service.cjs` is built for Bun and uses Bun-specific APIs (`bun:sqlite`).

### Proposed Fix

Detect the Bun executable path and use it instead of `node`:

```typescript
import { existsSync } from 'fs';
import { homedir } from 'os';
import path from 'path';

/**
 * Find the Bun executable path
 * Checks common installation locations
 */
function findBunPath(): string {
  const possiblePaths = [
    path.join(homedir(), '.bun', 'bin', 'bun'),           // Standard install
    '/usr/local/bin/bun',                                  // Global install
    '/usr/bin/bun',                                        // System install
    process.platform === 'win32'
      ? path.join(homedir(), '.bun', 'bin', 'bun.exe')    // Windows
      : null,
  ].filter(Boolean) as string[];

  for (const p of possiblePaths) {
    if (existsSync(p)) {
      return p;
    }
  }

  // Fallback to 'bun' and hope it's in PATH
  return 'bun';
}

// In installCursorHooks():
const bunPath = findBunPath();
const escapedBunPath = bunPath.replace(/\\/g, '\\\\');

const makeHookCommand = (command: string) => {
  return `"${escapedBunPath}" "${escapedWorkerPath}" hook cursor ${command}`;
};
```

### Generated hooks.json (Fixed)

Before (broken):
```json
{
  "command": "node \"/path/to/worker-service.cjs\" hook cursor session-init"
}
```

After (working):
```json
{
  "command": "/home/user/.bun/bin/bun \"/path/to/worker-service.cjs\" hook cursor session-init"
}
```

---

## Summary of Changes

| File | Line(s) | Change |
|------|---------|--------|
| `src/services/integrations/CursorHooksInstaller.ts` | 145 | Check for `hooks.json` instead of/in addition to shell scripts |
| `src/services/integrations/CursorHooksInstaller.ts` | 319-321 | Use detected Bun path instead of hardcoded `node` |

## Testing

After applying fixes, verify with:

```bash
# 1. Install hooks
bun run cursor:install user

# 2. Check generated hooks.json uses bun
cat ~/.cursor/hooks.json | grep -o '"command": "[^"]*"' | head -1

# 3. Test hook execution
echo '{"conversation_id":"test","workspace_roots":["/tmp"],"tool_name":"Test","tool_input":{},"result_json":{}}' | \
  timeout 5 bun ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs hook cursor observation

# 4. Verify in Cursor
# - Restart Cursor
# - Check Settings → Hooks tab
# - Submit a prompt and check http://localhost:37777
```

## Workaround (Current)

Until these fixes are merged, users can manually:

1. Create stub file for Bug 1:
   ```bash
   echo '#!/bin/bash' > ~/.claude/plugins/marketplaces/thedotmack/cursor-hooks/common.sh
   ```

2. After installation, edit `~/.cursor/hooks.json` to replace `node` with full bun path:
   ```bash
   sed -i 's|"node |"/home/USER/.bun/bin/bun |g' ~/.cursor/hooks.json
   ```
