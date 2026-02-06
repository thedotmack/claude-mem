# Investigation: Plugin Load Failure in Second Terminal

**Date:** February 5, 2026
**Branch:** `fix/fk-constraint-memory-session-id`
**Status:** Partially resolved - worker fixes complete, Claude Code hook execution issue remains

---

## Problem Statement

The claude-mem plugin fails to load in a second terminal with error:
```
ENOENT: no such file or directory, open '/home/eti/.claude/plugins/marketplaces/thedotmack/package.json'
```

## Root Cause Analysis

### Why Two Locations Exist

| Location | Purpose | Status |
|----------|---------|--------|
| `~/.claude/plugins/marketplaces/thedotmack/` | Development sync target | Gets deleted by Claude Code autoUpdate |
| `~/.claude/plugins/cache/thedotmack/claude-mem/9.0.16/` | Production install | Where Claude Code actually loads the plugin |

### Files That Used Hardcoded Paths

| File | Issue | Fix Status |
|------|-------|------------|
| `src/shared/worker-utils.ts` | `MARKETPLACE_ROOT` hardcoded | ✅ Fixed - uses `getPackageRoot()` |
| `src/services/infrastructure/HealthMonitor.ts` | `marketplaceRoot` hardcoded | ✅ Fixed - uses `getPackageRoot()` |
| `src/services/worker/BranchManager.ts` | `INSTALLED_PLUGIN_PATH` hardcoded | ⚠️ Not needed - development feature only |
| `plugin/scripts/smart-install.js` | `ROOT` hardcoded | ✅ Fixed - uses `import.meta.url` |

---

## Fixes Applied

### 1. smart-install.js
Changed `ROOT` from hardcoded path to dynamic resolution via `import.meta.url`.

### 2. worker-utils.ts
`getPluginVersion()` now uses `getPackageRoot()` instead of hardcoded marketplace path.

### 3. HealthMonitor.ts
`getInstalledPluginVersion()` now uses `getPackageRoot()` instead of hardcoded path.

### 4. worker-service.ts
Database initialization callback moved to ensure proper sequencing.

---

## Verification Results

### Worker Start Test (from cache directory)
```bash
cd ~/.claude/plugins/cache/thedotmack/claude-mem/9.0.16
node scripts/bun-runner.js scripts/worker-service.cjs start
# Result: {"continue":true,"suppressOutput":true,"status":"ready"}
```

### Health Check
```bash
curl http://localhost:37777/api/health
# Result: {"status":"ok","initialized":true,"mcpReady":true}
```

### Manual Hook Execution
All hooks execute correctly when run manually:
- `smart-install.js` ✅
- `worker-service.cjs start` ✅
- `worker-service.cjs hook claude-code context` ✅
- `worker-service.cjs hook claude-code observation` ✅

### Forced Observation Test
```bash
curl -X POST http://localhost:37777/api/sessions/init \
  -d '{"contentSessionId":"test","project":"claude-mem","prompt":"test"}'
# Result: {"sessionDbId":9146,"promptNumber":1,"skipped":false}

curl -X POST http://localhost:37777/api/sessions/observations \
  -d '{"contentSessionId":"test","tool_name":"Bash",...}'
# Result: {"status":"queued"}
```
Observation successfully processed and stored (ID #2545).

---

## Remaining Issue

### Claude Code Does Not Execute Hooks

Despite all fixes:
1. Worker starts correctly from cache ✅
2. API endpoints work correctly ✅
3. Observations are processed correctly ✅
4. **Claude Code does not trigger the hooks** ❌

### Observations

1. Plugin is enabled in `~/.claude/settings.json`:
   ```json
   {"claude-mem@thedotmack": true}
   ```

2. Multiple versions exist in cache:
   ```
   ~/.claude/plugins/cache/thedotmack/claude-mem/
   ├── 9.0.10/
   ├── 9.0.12/
   └── 9.0.16/
   ```

3. Other plugins with hooks (ralph-wiggum) use hash-based versioning:
   ```
   ~/.claude/plugins/cache/claude-plugins-official/ralph-wiggum/bf48ae6c75e7/
   ```

4. hooks.json is identical between source and cache.

5. All script files are present with correct permissions.

### Hypothesis

Claude Code may be:
1. Selecting an older version (9.0.10 or 9.0.12) instead of 9.0.16
2. Having issues with semver-based version directories vs hash-based
3. Caching plugin metadata that points to wrong location

---

## Next Steps

1. **Test in fresh terminal** - Run `/plugins` to see if claude-mem is listed
2. **Clear old versions** - Remove 9.0.10 and 9.0.12 from cache
3. **Check Claude Code logs** - If available, look for plugin loading errors
4. **Force plugin reinstall** - Disable and re-enable plugin in settings

---

## Files Modified in This Session

### Source Files
- `src/shared/worker-utils.ts` - Dynamic path resolution
- `src/services/infrastructure/HealthMonitor.ts` - Dynamic path resolution
- `src/services/worker-service.ts` - Database init sequencing
- `plugin/scripts/smart-install.js` - Dynamic ROOT via import.meta.url

### Build Artifacts (synced to cache)
- `plugin/scripts/worker-service.cjs`
- `plugin/scripts/mcp-server.cjs`
- `plugin/scripts/context-generator.cjs`
- `plugin/scripts/smart-install.js`

---

## Conclusion

The ENOENT error is resolved - the worker now starts correctly from the cache directory. The remaining issue is that Claude Code does not execute the hooks when starting a new session. This appears to be a Claude Code plugin registration/loading issue rather than a code bug in claude-mem.
