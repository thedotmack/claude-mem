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

const INSTALLED_PATH = path.join(os.homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack');
const CACHE_BASE_PATH = path.join(os.homedir(), '.claude', 'plugins', 'cache', 'thedotmack', 'claude-mem');

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

// Normal rsync for main branch or fresh install
console.log('Syncing to marketplace...');
try {
  // Clear Apple quarantine attributes (macOS only) to prevent "Operation not permitted" errors
  if (process.platform === 'darwin') {
    console.log('Clearing Apple quarantine attributes...');
    try {
      execSync('xattr -cr ./', { stdio: 'pipe' });
      if (existsSync(INSTALLED_PATH)) {
        execSync('xattr -cr "' + INSTALLED_PATH + '"', { stdio: 'pipe' });
      }
    } catch (e) {
      // xattr errors are non-fatal, continue with sync
    }
  }

  console.log('Transfer starting...');
  // Use try-catch for rsync as it may return non-zero exit code due to macOS permission warnings
  // These warnings don't affect the actual file transfer
  try {
    execSync(
      'rsync -av --delete --no-perms --exclude=.git --exclude=/.mcp.json ./ ~/.claude/plugins/marketplaces/thedotmack/',
      { stdio: 'inherit' }
    );
  } catch (rsyncError) {
    // Exit code 23 means partial transfer due to error (usually permission warnings on macOS)
    // Exit code 24 means partial transfer due to vanished source files
    // Both are acceptable as the core files are transferred successfully
    if (rsyncError.status === 23 || rsyncError.status === 24) {
      console.log('\\x1b[33m%s\\x1b[0m', 'ℹ Some files had permission warnings (non-fatal, continuing...)');
    } else {
      throw rsyncError;
    }
  }

  console.log('Running npm install in marketplace...');
  execSync(
    'cd ~/.claude/plugins/marketplaces/thedotmack/ && npm install',
    { stdio: 'inherit' }
  );

  // Sync to cache folder with version
  const version = getPluginVersion();
  const CACHE_VERSION_PATH = path.join(CACHE_BASE_PATH, version);

  console.log(`Syncing to cache folder (version ${version})...`);
  try {
    // First ensure the cache directory exists
    execSync(`mkdir -p "${CACHE_VERSION_PATH}"`, { stdio: 'pipe' });
    // Use cp instead of rsync to avoid permission issues with macOS
    execSync(
      `cp -R plugin/* "${CACHE_VERSION_PATH}/"`,
      { stdio: 'inherit' }
    );
  } catch (cpError) {
    // cp errors are usually non-fatal for plugin functionality
    console.log('\\x1b[33m%s\\x1b[0m', 'ℹ Cache sync had some warnings (non-fatal)');
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
