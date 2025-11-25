# Branch-Based Beta Feature Toggle System

**Date**: Nov 25, 2025
**Current Branch**: `beta/7.0` (v7.0.0-beta.1)

---

## Full Plan

### Summary

Use git branches in the installed plugin folder (`~/.claude/plugins/marketplaces/thedotmack/`) as the feature toggle mechanism. When user clicks "Try Beta" in the UI, we checkout the beta branch, install deps, and restart the worker.

### Key Architecture

#### Two Deployment Models

| Users | Branch | Version | Update Method |
|-------|--------|---------|---------------|
| Stable | `main` | 6.x.x | `npm run sync-marketplace` (rsync) |
| Beta | `beta/7.0` | 7.0.0-beta.x | `git pull` via UI button |

#### User Data Preservation
- All memory data at `~/.claude-mem/` is branch-agnostic
- Switching branches never affects user data

---

## Implementation Phases

### Phase 1: BranchManager Utility - [x] DONE

**New file**: `src/services/worker/BranchManager.ts`

```typescript
interface BranchInfo {
  branch: string | null;
  isBeta: boolean;
  isGitRepo: boolean;
  isDirty: boolean;
  version: string;
  canSwitch: boolean;
}

// Detection: git rev-parse --abbrev-ref HEAD
// Dirty check: git status --porcelain
```

### Phase 2: API Endpoints - [x] DONE

**File**: `src/services/worker-service.ts`

Add:
- [x] `GET /api/branch/status` - Returns BranchInfo
- [x] `POST /api/branch/switch` - Switches branch (fetch, checkout, npm install, pm2 restart)
- [x] `POST /api/branch/update` - Pulls latest for current branch

**Switch logic**:
1. `git checkout -- .` (discard rsync modifications)
2. `git fetch origin`
3. `git checkout <branch> && git pull`
4. `rm .install-version && npm install`
5. `pm2 restart claude-mem-worker`

### Phase 3: UI Integration - [x] DONE (Beta side only)

**File**: `src/ui/viewer/components/Sidebar.tsx`

**Stable users see**:
```
[Stable v6.2.1]
[ Try Beta (Endless Mode) ]
```

**Beta users see**:
```
[Beta v7.0.0-beta.1]
You're running beta with Endless Mode.
[ Switch to Stable ]
[ Check for Updates ]
```

### Phase 4: Version Updates (Beta Branch Only) - [x] DONE

Update to `7.0.0-beta.1`:
- [x] `package.json`
- [x] `plugin/.claude-plugin/plugin.json`
- [x] `.claude-plugin/marketplace.json`
- [x] `CLAUDE.md`

### Phase 5: Protected Sync Script - [ ] TODO (main branch)

**New file**: `scripts/sync-marketplace.js`

Detects if installed plugin is on beta branch and prevents accidental rsync overwrite:
```
WARNING: Installed plugin is on beta branch.
Running rsync would overwrite beta code.
Use UI to update beta, or switch to stable first.
```

---

## Files to Modify

| File | Change | Status |
|------|--------|--------|
| `src/services/worker/BranchManager.ts` | NEW - Branch detection/switching | [x] Done |
| `src/services/worker-service.ts` | Add 3 branch API endpoints | [x] Done |
| `src/ui/viewer/components/Sidebar.tsx` | Add branch toggle UI section | [x] Done (beta) |
| `scripts/sync-marketplace.js` | NEW - Protected sync with beta detection | [ ] TODO |
| `package.json` | Update version to 7.0.0-beta.1, update scripts | [x] Done |

---

## Execution Checklist

### 1. On `beta/7.0` branch - [x] COMPLETE

- [x] Rename branch: `git branch -m beta/7.0`
- [x] Add BranchManager.ts
- [x] Add branch API endpoints to worker-service.ts
- [x] Update Sidebar.tsx with branch UI (shows "Beta" badge + "Switch to Stable")
- [x] Update version to 7.0.0-beta.1
- [x] Push to origin: `git push origin beta/7.0`

### 2. On `main` branch - [ ] TODO

- [ ] Cherry-pick BranchManager.ts and API endpoints
- [ ] Update Sidebar.tsx (shows "Stable" badge + "Try Beta", remove Endless Mode toggle)
- [ ] Add protected sync-marketplace.js
- [ ] Keep version at 6.x.x (no Endless Mode code)

---

## Detailed TODO for Main Branch

### Step 1: Cherry-pick or copy BranchManager

```bash
git checkout main
# Copy the file from beta/7.0
git show beta/7.0:src/services/worker/BranchManager.ts > src/services/worker/BranchManager.ts
```

### Step 2: Add API endpoints to worker-service.ts

Copy from `beta/7.0` branch:
- Import statement (line ~36)
- Route registrations (lines ~187-190)
- Handler methods (lines ~1454-1535)

### Step 3: Update Sidebar.tsx for main

The main branch Sidebar should:
- Show "Stable" badge (green) with version
- Show "Try Beta (Endless Mode)" button
- **Remove** the Endless Mode toggle checkbox entirely (that's beta-only)
- Keep branch switching state and handlers

### Step 4: Create protected sync-marketplace.js

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

### Step 5: Update package.json scripts

```json
{
  "scripts": {
    "sync-marketplace": "node scripts/sync-marketplace.js",
    "sync-marketplace:force": "rsync -av --delete --exclude=.git ./ ~/.claude/plugins/marketplaces/thedotmack/ && cd ~/.claude/plugins/marketplaces/thedotmack/ && npm install"
  }
}
```

### Step 6: Keep main version on 6.x.x

Main should stay at 6.2.x or bump to 6.3.0 - NOT 7.x.

---

## Reference Files

| File | Location | Purpose |
|------|----------|---------|
| Plan | `~/.claude/plans/bubbly-imagining-cake.md` | Original approved plan |
| BranchManager | `src/services/worker/BranchManager.ts` | Git operations utility |
| Worker endpoints | `src/services/worker-service.ts:1454-1535` | Branch API handlers |
| Sidebar UI | `src/ui/viewer/components/Sidebar.tsx:428-514` | Version Channel section |
