# Version Consistency Fix (Issue #XXX)

## Problem
Version mismatch between plugin and worker caused infinite restart loop:
- Plugin version: 9.0.0 (from plugin/.claude-plugin/plugin.json)
- Worker binary version: 8.5.9 (hardcoded in bundled worker-service.cjs)

This triggered the auto-restart mechanism on every hook call, which killed the SDK generator before it could complete the Claude API call to generate observations. Result: 0 observations were ever saved to the database despite hooks firing successfully.

## Root Cause
The `plugin/package.json` file had version `8.5.10` instead of `9.0.0`. When the project was last built, the build script correctly injected the version from root `package.json` into the bundled worker service. However, the `plugin/package.json` was manually created/edited and fell out of sync.

At runtime:
1. Worker service reads version from `~/.claude/plugins/marketplaces/thedotmack/package.json` → gets `8.5.10`
2. Running worker returns built-in version via `/api/version` → returns `8.5.9` (from old build)
3. Version check in `worker-service.ts` start command detects mismatch
4. Auto-restart triggered on every hook call
5. Observations never saved

## Solution
1. Updated `plugin/package.json` from version `8.5.10` to `9.0.0`
2. Rebuilt all hooks and worker service to inject correct version (`9.0.0`) into bundled artifacts
3. Added comprehensive test suite to prevent future version mismatches

## Verification
All versions now match:
```
Root package.json:       9.0.0 ✓
plugin/package.json:     9.0.0 ✓
plugin.json:             9.0.0 ✓
marketplace.json:        9.0.0 ✓
worker-service.cjs:      9.0.0 ✓
```

## Prevention
To prevent this issue in the future:

1. **Automated Build Process**: The `scripts/build-hooks.js` now regenerates `plugin/package.json` automatically with the correct version from root `package.json`

2. **Version Consistency Tests**: Added `tests/infrastructure/version-consistency.test.ts` to verify all version sources match

3. **Version Management Best Practices**:
   - NEVER manually edit `plugin/package.json` - it's auto-generated during build
   - Always update version in root `package.json` only
   - Run `npm run build` after version changes
   - The build script will sync the version to all necessary locations

## Files Changed
- `plugin/package.json` - Updated version from 8.5.10 to 9.0.0
- `plugin/scripts/worker-service.cjs` - Rebuilt with version 9.0.0 injected
- `plugin/scripts/mcp-server.cjs` - Rebuilt with version 9.0.0 injected
- `plugin/scripts/*.js` (hooks) - Rebuilt with version 9.0.0 injected
- `tests/infrastructure/version-consistency.test.ts` - New test suite

## Testing
Run the version consistency test:
```bash
npm run test:infra
```

Or manually verify:
```bash
node -e "
const fs = require('fs');
const rootPkg = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
const pluginPkg = JSON.parse(fs.readFileSync('plugin/package.json', 'utf-8'));
const workerContent = fs.readFileSync('plugin/scripts/worker-service.cjs', 'utf-8');
const workerMatch = workerContent.match(/Bre=\"([0-9.]+)\"/);
console.log('Root:', rootPkg.version);
console.log('Plugin:', pluginPkg.version);
console.log('Worker:', workerMatch ? workerMatch[1] : 'NOT_FOUND');
"
```

## Related Code Locations
- **Version Injection**: `scripts/build-hooks.js` line 43-45, 105, 130, 155, 178
- **Version Check**: `src/services/infrastructure/HealthMonitor.ts` line 133-143
- **Auto-Restart Logic**: `src/services/worker-service.ts` line 627-645
- **Runtime Version Read**: `src/shared/worker-utils.ts` line 73-76, 82-91
