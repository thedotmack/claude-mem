# Fix: Dependencies not found when hooks run from cache directory

## Context

The claude-mem plugin hooks run from Claude Code's **cache** directory
(`~/.claude/plugins/cache/doublefx/claude-mem/9.0.16/`) but `better-sqlite3`
(the only external native dependency) is only installed in the **marketplace**
directory (`~/.claude/plugins/marketplaces/doublefx/`). Node.js module
resolution from the cache path never reaches the marketplace's `node_modules`,
causing `MODULE_NOT_FOUND` errors for every hook execution.

Additionally, the source `scripts/smart-install.js` still references Bun
throughout and hasn't been migrated to match the plugin version that uses
Node.js/npm.

## Changes

### 1. Fix `plugin/scripts/smart-install.js` — install deps where hooks actually run

**File**: `plugin/scripts/smart-install.js`

- Derive `PLUGIN_ROOT` from the script's own location (`import.meta.url`)
  instead of hardcoding the marketplace path
- Install deps in `PLUGIN_ROOT` (which will be the cache dir at runtime)
- Keep marketplace ROOT for CLI alias installation and version marker
- Fix `require.resolve` usage (not available in ESM) — use `existsSync` check
  on `node_modules/better-sqlite3` instead

### 2. Fix source `scripts/smart-install.js` — complete Bun-to-Node migration

**File**: `scripts/smart-install.js`

- Remove all Bun references (getBunPath, isBunInstalled, getBunVersion, installBun)
- Use `npm install --production` instead of `bun install`
- Add CLI installation logic (matching plugin version)
- Add cache-aware dependency installation (matching plugin version)

### 3. Fix `scripts/sync-marketplace.cjs` — install deps in cache after sync

**File**: `scripts/sync-marketplace.cjs`

- After syncing `plugin/` to the cache directory, run
  `npm install --production` in the cache directory so `better-sqlite3`
  is available immediately after build-and-sync

### 4. Immediate fix — install deps in current cache

Run `npm install --production` in the cache directory to unblock the current
environment while source fixes are built and deployed.

## Verification

1. Run `npm install --production` in cache dir — worker should start
2. Run `npm run build-and-sync` — verify cache gets `node_modules`
3. Start a new Claude Code session — verify no hook errors
4. Run `curl http://localhost:37777/health` — verify worker responds
