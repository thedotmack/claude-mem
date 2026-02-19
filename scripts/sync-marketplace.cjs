#!/usr/bin/env node
/**
 * Protected sync-marketplace script
 *
 * Prevents accidental rsync overwrite when installed plugin is on beta branch.
 * If on beta, the user should use the UI to update instead.
 */

const { execSync } = require('child_process');
const { existsSync, readFileSync } = require('fs');
const path = require('path');
const os = require('os');

const INSTALLED_PATH = path.join(os.homedir(), '.claude', 'plugins', 'marketplaces', 'magic-claude-mem');
const CACHE_BASE_PATH = path.join(os.homedir(), '.claude', 'plugins', 'cache', 'magic-claude-mem', 'magic-claude-mem');

// Additional Claude config directories to sync (e.g., work profile)
const EXTRA_CONFIG_DIRS = [
  path.join(os.homedir(), '.claude-work'),
];

function getCurrentBranch() {
  try {
    if (!existsSync(path.join(INSTALLED_PATH, '.git'))) {
      return null;
    }
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: INSTALLED_PATH,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
  } catch {
    return null;
  }
}

const branch = getCurrentBranch();
const isForce = process.argv.includes('--force');

if (branch && branch !== 'main' && !isForce) {
  console.log('');
  console.log('\x1b[33m%s\x1b[0m', `WARNING: Installed plugin is on beta branch: ${branch}`);
  console.log('\x1b[33m%s\x1b[0m', 'Running rsync would overwrite beta code.');
  console.log('');
  console.log('Options:');
  console.log('  1. Use UI at http://localhost:37777 to update beta');
  console.log('  2. Switch to stable in UI first, then run sync');
  console.log('  3. Force rsync: npm run sync-marketplace:force');
  console.log('');
  process.exit(1);
}

// Get version from plugin.json
function getPluginVersion() {
  try {
    const pluginJsonPath = path.join(__dirname, '..', 'plugin', '.claude-plugin', 'plugin.json');
    const pluginJson = JSON.parse(readFileSync(pluginJsonPath, 'utf-8'));
    return pluginJson.version;
  } catch (error) {
    console.error('\x1b[31m%s\x1b[0m', 'Failed to read plugin version:', error.message);
    process.exit(1);
  }
}

/**
 * Get the pinned Node binary directory from .install-version marker.
 * npm install must use the same Node binary that the worker daemon uses,
 * otherwise prebuild-install downloads native modules for the wrong ABI.
 */
function getPinnedNodeEnv() {
  const markerPath = path.join(INSTALLED_PATH, '.install-version');
  try {
    if (existsSync(markerPath)) {
      const marker = JSON.parse(readFileSync(markerPath, 'utf-8'));
      if (marker.execPath && existsSync(marker.execPath)) {
        const nodeDir = path.dirname(marker.execPath);
        console.log(`Pinning npm install to Node binary: ${marker.execPath}`);
        return { ...process.env, PATH: nodeDir + path.delimiter + (process.env.PATH || '') };
      }
    }
  } catch {
    // Marker missing or corrupt — use current Node
  }
  console.log('No pinned Node binary found, using current Node:', process.execPath);
  return process.env;
}

// Normal rsync for main branch or fresh install
console.log('Syncing to marketplace...');
try {
  execSync(
    'rsync -av --delete --exclude=.git --exclude=/.mcp.json --exclude=.install-version ./ ~/.claude/plugins/marketplaces/magic-claude-mem/',
    { stdio: 'inherit' }
  );

  // Pin PATH to the same Node binary that the worker daemon uses.
  // This ensures prebuild-install downloads native modules matching the correct ABI.
  const pinnedEnv = getPinnedNodeEnv();

  console.log('Running npm install in marketplace...');
  execSync(
    'cd ~/.claude/plugins/marketplaces/magic-claude-mem/ && npm install',
    { stdio: 'inherit', env: pinnedEnv }
  );

  // Force rebuild better-sqlite3 with the pinned Node binary.
  // npm install won't replace native binaries when the package version hasn't changed,
  // so we must explicitly delete and rebuild to ensure the correct ABI.
  const marketplaceSqlite = path.join(INSTALLED_PATH, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
  if (existsSync(marketplaceSqlite)) {
    const { unlinkSync } = require('fs');
    unlinkSync(marketplaceSqlite);
  }
  console.log('Rebuilding better-sqlite3 for pinned Node binary...');
  execSync(
    'cd ~/.claude/plugins/marketplaces/magic-claude-mem/ && npm rebuild better-sqlite3',
    { stdio: 'inherit', env: pinnedEnv }
  );

  // Mirror to additional config directories (e.g., ~/.claude-work)
  for (const configDir of EXTRA_CONFIG_DIRS) {
    const extraMarketplace = path.join(configDir, 'plugins', 'marketplaces', 'magic-claude-mem');
    if (!existsSync(path.join(configDir, 'plugins', 'marketplaces'))) continue;
    console.log(`\nSyncing to ${extraMarketplace}...`);
    execSync(
      `rsync -av --delete --exclude=.git --exclude=/.mcp.json --exclude=.install-version "${INSTALLED_PATH}/" "${extraMarketplace}/"`,
      { stdio: 'inherit' }
    );
    console.log('\x1b[32m%s\x1b[0m', `✓ Synced to ${path.basename(configDir)}`);
  }

  // Sync to cache folder with version
  const version = getPluginVersion();
  const CACHE_VERSION_PATH = path.join(CACHE_BASE_PATH, version);

  console.log(`Syncing to cache folder (version ${version})...`);
  execSync(
    `rsync -av --delete --exclude=.git --exclude=node_modules plugin/ "${CACHE_VERSION_PATH}/"`,
    { stdio: 'inherit' }
  );

  console.log('Installing dependencies in cache...');
  execSync(
    `cd "${CACHE_VERSION_PATH}" && npm install --production`,
    { stdio: 'inherit', env: pinnedEnv }
  );

  // Force rebuild better-sqlite3 in cache too
  const cacheSqlite = path.join(CACHE_VERSION_PATH, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
  if (existsSync(cacheSqlite)) {
    const { unlinkSync } = require('fs');
    unlinkSync(cacheSqlite);
  }
  console.log('Rebuilding better-sqlite3 in cache...');
  execSync(
    `cd "${CACHE_VERSION_PATH}" && npm rebuild better-sqlite3`,
    { stdio: 'inherit', env: pinnedEnv }
  );

  // WSL: also sync to Windows cache so Windows Claude Code picks up changes
  if (process.env.WSL_DISTRO_NAME || existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')) {
    // Resolve Windows home via cmd.exe to handle username mismatches between WSL and Windows
    let winHome;
    try {
      winHome = execSync('cmd.exe /C "echo %USERPROFILE%" 2>/dev/null', { encoding: 'utf-8' }).trim();
      // Convert Windows path (C:\Users\X) to WSL mount (/mnt/c/Users/X)
      winHome = winHome.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`);
    } catch {
      winHome = null;
    }
    const winCachePath = winHome
      ? path.join(winHome, '.claude', 'plugins', 'cache', 'magic-claude-mem', 'magic-claude-mem', version)
      : null;
    if (winCachePath && existsSync(path.dirname(winCachePath))) {
      console.log('Syncing to Windows cache (WSL detected)...');
      execSync(
        `rsync -av --delete --exclude=node_modules plugin/ "${winCachePath}/"`,
        { stdio: 'inherit' }
      );
      // Install deps in Windows cache too (pinned to same Node binary)
      console.log('Installing dependencies in Windows cache...');
      execSync(
        `cd "${winCachePath}" && npm install --production`,
        { stdio: 'inherit', env: pinnedEnv }
      );
      // Force rebuild better-sqlite3 in Windows cache
      const winCacheSqlite = path.join(winCachePath, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
      if (existsSync(winCacheSqlite)) {
        const { unlinkSync } = require('fs');
        unlinkSync(winCacheSqlite);
      }
      execSync(
        `cd "${winCachePath}" && npm rebuild better-sqlite3`,
        { stdio: 'inherit', env: pinnedEnv }
      );
    }
  }

  // Write/update install-version marker so the worker knows which Node binary to use.
  // This mirrors what smart-install.js does for end users.
  // The marker must point to the PINNED Node binary (from existing marker or current process).
  const markerPath = path.join(INSTALLED_PATH, '.install-version');
  try {
    let execPathToPin = process.execPath;
    // If there was an existing marker with a valid execPath, preserve it
    if (existsSync(markerPath)) {
      const existing = JSON.parse(readFileSync(markerPath, 'utf-8'));
      if (existing.execPath && existsSync(existing.execPath)) {
        execPathToPin = existing.execPath;
      }
    }
    const { writeFileSync } = require('fs');
    writeFileSync(markerPath, JSON.stringify({
      version,
      node: process.version,
      execPath: execPathToPin,
      installedAt: new Date().toISOString()
    }));
    console.log(`Install marker written: v${version}, pinned to ${execPathToPin}`);
  } catch (err) {
    console.log('\x1b[33m%s\x1b[0m', `Warning: Could not write install marker: ${err.message}`);
  }

  console.log('\x1b[32m%s\x1b[0m', 'Sync complete!');

  // Trigger worker restart after file sync
  console.log('\n🔄 Triggering worker restart...');
  const http = require('http');
  const req = http.request({
    hostname: '127.0.0.1',
    port: 37777,
    path: '/api/admin/restart',
    method: 'POST',
    timeout: 2000
  }, (res) => {
    if (res.statusCode === 200) {
      console.log('\x1b[32m%s\x1b[0m', '✓ Worker restart triggered');
    } else {
      console.log('\x1b[33m%s\x1b[0m', `ℹ Worker restart returned status ${res.statusCode}`);
    }
  });
  req.on('error', () => {
    console.log('\x1b[33m%s\x1b[0m', 'ℹ Worker not running, will start on next hook');
  });
  req.on('timeout', () => {
    req.destroy();
    console.log('\x1b[33m%s\x1b[0m', 'ℹ Worker restart timed out');
  });
  req.end();

} catch (error) {
  console.error('\x1b[31m%s\x1b[0m', 'Sync failed:', error.message);
  process.exit(1);
}
