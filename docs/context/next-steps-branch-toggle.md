# Next Steps: Branch-Based Beta Toggle System

**Date**: Nov 25, 2025
**Current Branch**: `beta/7.0` (v7.0.0-beta.1)

## What Was Completed

On `beta/7.0` branch:

1. **BranchManager.ts** - New utility at `src/services/worker/BranchManager.ts`
   - `getBranchInfo()` - Detects current branch, beta status, dirty state
   - `switchBranch(target)` - Handles git checkout, npm install, returns result
   - `pullUpdates()` - Pulls latest for current branch

2. **API Endpoints** - Added to `src/services/worker-service.ts`
   - `GET /api/branch/status` - Returns branch info
   - `POST /api/branch/switch` - Switches to target branch (main or beta/7.0)
   - `POST /api/branch/update` - Pulls latest updates

3. **Sidebar UI** - Updated `src/ui/viewer/components/Sidebar.tsx`
   - "Version Channel" section with Beta/Stable badge
   - Beta users see: "Switch to Stable" + "Check for Updates" buttons
   - Stable users see: "Try Beta (Endless Mode)" button

4. **Version Bump** - Updated to 7.0.0-beta.1 in:
   - package.json
   - plugin/.claude-plugin/plugin.json
   - .claude-plugin/marketplace.json
   - CLAUDE.md

## What Needs To Be Done

Switch to `main` branch and implement:

### 1. Cherry-pick BranchManager and API endpoints

```bash
git checkout main
git cherry-pick <commit-hash>  # or manually copy files
```

Files to bring over:
- `src/services/worker/BranchManager.ts` (copy as-is)
- `src/services/worker-service.ts` (add import + 3 API handlers)

### 2. Update Sidebar.tsx on main

The Sidebar should show:
- "Stable" badge (green)
- "Try Beta (Endless Mode)" button
- NO Endless Mode toggle checkbox (that's beta-only)

Key difference: Main branch Sidebar should NOT have the Endless Mode section at all.

### 3. Create protected sync-marketplace.js

**New file**: `scripts/sync-marketplace.js`

```javascript
#!/usr/bin/env node
const { execSync } = require('child_process');
const { existsSync } = require('fs');
const path = require('path');
const os = require('os');

const INSTALLED_PATH = path.join(os.homedir(), '.claude/plugins/marketplaces/thedotmack/');

function getCurrentBranch() {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: INSTALLED_PATH, encoding: 'utf-8'
    }).trim();
  } catch { return null; }
}

const branch = getCurrentBranch();

if (branch && branch !== 'main') {
  console.log('');
  console.log('WARNING: Installed plugin is on beta branch: ' + branch);
  console.log('Running rsync would overwrite beta code.');
  console.log('');
  console.log('Options:');
  console.log('  1. Use UI at http://localhost:37777 to update beta');
  console.log('  2. Switch to stable in UI first');
  console.log('  3. Force rsync: npm run sync-marketplace:force');
  console.log('');
  process.exit(1);
}

// Normal rsync for main branch
execSync(
  'rsync -av --delete --exclude=.git ./ ~/.claude/plugins/marketplaces/thedotmack/ && ' +
  'cd ~/.claude/plugins/marketplaces/thedotmack/ && npm install',
  { stdio: 'inherit' }
);
```

### 4. Update package.json scripts on main

```json
{
  "scripts": {
    "sync-marketplace": "node scripts/sync-marketplace.js",
    "sync-marketplace:force": "rsync -av --delete --exclude=.git ./ ~/.claude/plugins/marketplaces/thedotmack/ && cd ~/.claude/plugins/marketplaces/thedotmack/ && npm install"
  }
}
```

### 5. Keep main version on 6.x.x track

Main should stay at 6.2.x or bump to 6.3.0 - NOT 7.x.

## Architecture Summary

| Branch | Version | Has Endless Mode | Update Method |
|--------|---------|------------------|---------------|
| `main` | 6.x.x | No | `npm run sync-marketplace` |
| `beta/7.0` | 7.0.0-beta.x | Yes | Git pull via UI |

## Reference Files

- Plan: `~/.claude/plans/bubbly-imagining-cake.md`
- BranchManager: `src/services/worker/BranchManager.ts`
- Worker endpoints: `src/services/worker-service.ts` (lines 1454-1535)
- Sidebar UI: `src/ui/viewer/components/Sidebar.tsx` (lines 428-514)
