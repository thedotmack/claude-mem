# Investigation Report: Issue #557 - Plugin Fails to Start

**Date:** January 5, 2026
**Issue:** [#557](https://github.com/thedotmack/claude-mem/issues/557) - Plugin fails to start: settings.json not generated, worker throws module loader error
**Author:** Sheikh Abdur Raheem Ali (@sheikheddy)
**Investigator:** Claude (Opus 4.5)

---

## Executive Summary

The plugin fails to start during the SessionStart hook with a Node.js module loader error. This investigation identifies two separate but related issues:

1. **Primary Issue:** Runtime mismatch - hooks are built for Bun but invoked with Node.js
2. **Secondary Issue:** settings.json auto-creation only happens via HTTP API, not during initialization

The root cause appears to be that Claude Code 2.0.76 is invoking hooks with Node.js despite hooks having `#!/usr/bin/env bun` shebangs, and Node.js v25.2.1 cannot execute code with `bun:sqlite` imports (an external module reference that doesn't exist in Node.js).

---

## Environment Details

| Component | Version |
|-----------|---------|
| claude-mem | 8.1.0 |
| Claude Code | 2.0.76 |
| Node.js | v25.2.1 |
| Bun | 1.3.5 |
| OS | macOS 26.2 (arm64) |
| Database Size | 17.9 MB (existing data) |

---

## Issue Analysis

### Error Location

The error occurs at:
```
node:internal/modules/cjs/loader:1423
  throw err;
  ^
```

This error signature indicates Node.js (not Bun) is attempting to load a CommonJS module that has unresolvable dependencies.

### Hook Configuration Analysis

From `/Users/alexnewman/Scripts/claude-mem/plugin/hooks/hooks.json`:

```json
{
  "SessionStart": [
    {
      "matcher": "startup|clear|compact",
      "hooks": [
        {
          "type": "command",
          "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/smart-install.js\"",
          "timeout": 300
        },
        {
          "type": "command",
          "command": "bun \"${CLAUDE_PLUGIN_ROOT}/scripts/worker-service.cjs\" start",
          "timeout": 60
        },
        {
          "type": "command",
          "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/context-hook.js\"",
          "timeout": 60
        },
        {
          "type": "command",
          "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/user-message-hook.js\"",
          "timeout": 60
        }
      ]
    }
  ]
}
```

**Key Observation:** Hooks are explicitly invoked with `node` but are built as ESM bundles with Bun-specific features.

### Build Configuration Analysis

From `/Users/alexnewman/Scripts/claude-mem/scripts/build-hooks.js`:

1. **Hooks** are built with:
   - `format: 'esm'` (ES modules)
   - `external: ['bun:sqlite']` (Bun-specific SQLite binding)
   - Shebang: `#!/usr/bin/env bun`

2. **Worker Service** is built with:
   - `format: 'cjs'` (CommonJS)
   - `external: ['bun:sqlite']`
   - Shebang: `#!/usr/bin/env bun`

The `bun:sqlite` external dependency is the critical issue. When Node.js tries to load these files, it cannot resolve `bun:sqlite` as it's a Bun-specific built-in module.

### Settings.json Auto-Creation Analysis

From `/Users/alexnewman/Scripts/claude-mem/src/services/worker/http/routes/SettingsRoutes.ts`:

```typescript
private ensureSettingsFile(settingsPath: string): void {
  if (!existsSync(settingsPath)) {
    const defaults = SettingsDefaultsManager.getAllDefaults();
    const dir = path.dirname(settingsPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(settingsPath, JSON.stringify(defaults, null, 2), 'utf-8');
    logger.info('SETTINGS', 'Created settings file with defaults', { settingsPath });
  }
}
```

This method is only called when:
1. `GET /api/settings` is requested
2. `POST /api/settings` is requested

**Problem:** If the worker service fails to start (due to the module loader error), the HTTP API never becomes available, so `ensureSettingsFile` is never called.

### SettingsDefaultsManager Behavior

From `/Users/alexnewman/Scripts/claude-mem/src/shared/SettingsDefaultsManager.ts`:

```typescript
static loadFromFile(settingsPath: string): SettingsDefaults {
  try {
    if (!existsSync(settingsPath)) {
      return this.getAllDefaults();  // Returns defaults, doesn't create file
    }
    // ... rest of loading logic
  } catch (error) {
    return this.getAllDefaults();  // Fallback to defaults on any error
  }
}
```

**Behavior:** When settings.json doesn't exist, `loadFromFile` returns in-memory defaults but does NOT create the file. This is defensive programming (fail-safe) but means the file is never auto-created during worker startup.

---

## Root Cause Analysis

### Primary Root Cause: Runtime Mismatch

The hooks are designed to run under Bun (as indicated by their shebangs and `bun:sqlite` dependency), but hooks.json explicitly invokes them with `node`:

```json
"command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/context-hook.js\""
```

When Node.js v25.2.1 attempts to load these ESM bundles:
1. It parses the JavaScript successfully (ESM is valid)
2. It encounters `import ... from 'bun:sqlite'`
3. Node.js cannot resolve `bun:sqlite` (not a valid Node.js specifier)
4. CJS loader throws the error at line 1423

### Why This Worked Before (Potential Regression Paths)

1. **Bun Availability:** The smart-install.js script auto-installs Bun, but the PATH may not be updated within the same shell session
2. **Claude Code Change:** Claude Code 2.0.76 may have changed how it invokes hooks (not honoring shebangs, using explicit `node` command)
3. **Node.js v25 Change:** Node.js v25 may handle ESM/CJS boundaries differently than earlier versions

### Secondary Root Cause: Settings Not Auto-Created at Startup

The worker service's background initialization (`initializeBackground()`) loads settings but doesn't create the file:

```typescript
const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
const modeId = settings.CLAUDE_MEM_MODE;
ModeManager.getInstance().loadMode(modeId);
```

`loadFromFile` returns defaults when the file is missing but doesn't write them to disk.

---

## Affected Files

| File | Role | Issue |
|------|------|-------|
| `/plugin/hooks/hooks.json` | Hook configuration | Explicitly uses `node` instead of `bun` |
| `/plugin/scripts/context-hook.js` | SessionStart hook | ESM with `bun:sqlite` dependency |
| `/plugin/scripts/user-message-hook.js` | SessionStart hook | ESM with `bun:sqlite` dependency |
| `/plugin/scripts/worker-service.cjs` | Worker service | CJS with `bun:sqlite` dependency |
| `/src/shared/SettingsDefaultsManager.ts` | Settings manager | Doesn't auto-create file |
| `/src/services/worker/http/routes/SettingsRoutes.ts` | HTTP routes | Only creates file on API access |
| `/scripts/build-hooks.js` | Build script | Marks `bun:sqlite` as external |

---

## Proposed Fixes

### Fix 1: Update hooks.json to Use Bun (Recommended)

Change all hook commands from `node` to `bun`:

```json
{
  "type": "command",
  "command": "bun \"${CLAUDE_PLUGIN_ROOT}/scripts/context-hook.js\"",
  "timeout": 60
}
```

**Rationale:** Hooks depend on `bun:sqlite`, so they must run under Bun.

### Fix 2: Create Settings File During Startup

Add file creation to `SettingsDefaultsManager.loadFromFile`:

```typescript
static loadFromFile(settingsPath: string): SettingsDefaults {
  try {
    if (!existsSync(settingsPath)) {
      const defaults = this.getAllDefaults();
      // Create directory if needed
      const dir = path.dirname(settingsPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      // Write defaults to file
      writeFileSync(settingsPath, JSON.stringify(defaults, null, 2), 'utf-8');
      logger.info('SETTINGS', 'Created settings file with defaults', { settingsPath });
      return defaults;
    }
    // ... existing logic
  } catch (error) {
    logger.warn('SETTINGS', 'Failed to load/create settings, using defaults', { settingsPath }, error);
    return this.getAllDefaults();
  }
}
```

**Rationale:** This ensures settings.json always exists after first access, regardless of how the plugin starts.

### Fix 3: Build Hooks Without bun:sqlite Dependency (Alternative)

Modify the build to inline SQLite operations or use a Node.js-compatible SQLite library:

```javascript
// In build-hooks.js
external: [],  // Remove bun:sqlite from externals
```

This would require using `better-sqlite3` or similar, which has been deliberately avoided due to native module compilation issues.

### Fix 4: Add Fallback Logic in Hooks (Defensive)

Add runtime detection to hooks to provide better error messages:

```typescript
if (typeof Bun === 'undefined') {
  console.error('This hook requires Bun runtime. Please ensure Bun is installed.');
  process.exit(1);
}
```

---

## Verification Steps

1. **Confirm Bun is installed and in PATH:**
   ```bash
   which bun
   bun --version
   ```

2. **Manually test context-hook with Bun:**
   ```bash
   bun ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/context-hook.js
   ```

3. **Manually test context-hook with Node (should fail):**
   ```bash
   node ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/context-hook.js
   ```

4. **Check if settings.json exists:**
   ```bash
   cat ~/.claude-mem/settings.json
   ```

5. **Verify worker can start:**
   ```bash
   bun ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs start
   ```

---

## Related Issues

- **Issue #290:** `refactor: simplify hook execution - use Node directly instead of Bun` - This commit changed hooks to use Node, potentially introducing this regression
- **Issue #265:** `fix: add npm fallback when bun install fails with alias packages` - Related to Bun/npm installation issues
- **Issue #527:** `uv-homebrew-analysis` - Related to dependency installation issues

---

## Workaround for Users

Until a fix is released, users can manually:

1. **Ensure Bun is installed:**
   ```bash
   curl -fsSL https://bun.sh/install | bash
   source ~/.bashrc  # or ~/.zshrc
   ```

2. **Create settings.json manually:**
   ```bash
   mkdir -p ~/.claude-mem
   cat > ~/.claude-mem/settings.json << 'EOF'
   {
     "CLAUDE_MEM_MODEL": "claude-sonnet-4-5",
     "CLAUDE_MEM_CONTEXT_OBSERVATIONS": "50",
     "CLAUDE_MEM_WORKER_PORT": "37777",
     "CLAUDE_MEM_WORKER_HOST": "127.0.0.1",
     "CLAUDE_MEM_PROVIDER": "claude",
     "CLAUDE_MEM_DATA_DIR": "$HOME/.claude-mem",
     "CLAUDE_MEM_LOG_LEVEL": "INFO",
     "CLAUDE_MEM_MODE": "code"
   }
   EOF
   ```

3. **Start worker manually:**
   ```bash
   bun ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs start
   ```

---

## Conclusion

This issue is a **runtime mismatch regression** where hooks built for Bun are being invoked with Node.js. The fix requires updating `hooks.json` to use Bun for all hook commands that depend on `bun:sqlite`. The settings.json creation is a secondary issue that should be addressed by ensuring the file is created during first access in `SettingsDefaultsManager.loadFromFile`.

**Priority:** High (blocks plugin startup)
**Severity:** Critical (plugin completely non-functional)
**Effort:** Low (configuration change + minor code addition)
