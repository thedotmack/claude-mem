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

function getGitignoreExcludes(basePath) {
  const gitignorePath = path.join(basePath, '.gitignore');
  if (!existsSync(gitignorePath)) return '';

  const lines = readFileSync(gitignorePath, 'utf-8').split('\n');
  return lines
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && !line.startsWith('!'))
    .map(pattern => `--exclude=${JSON.stringify(pattern)}`)
    .join(' ');
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

// Preflight: if a worker is running on an older version than what we're about
// to build, Claude Code's plugin loader is pinned to that older version and
// hooks will keep respawning the worker from the old cache path no matter how
// many times we sync. Bail loudly so the user updates the plugin first.
function preflightVersionCheck(buildVersion) {
  const dataDir = process.env.CLAUDE_MEM_DATA_DIR || path.join(os.homedir(), '.claude-mem');
  const settingsPath = path.join(dataDir, 'settings.json');
  let port = parseInt(process.env.CLAUDE_MEM_WORKER_PORT, 10);
  if (!port && existsSync(settingsPath)) {
    try {
      const s = JSON.parse(readFileSync(settingsPath, 'utf8'));
      if (s.CLAUDE_MEM_WORKER_PORT) port = parseInt(s.CLAUDE_MEM_WORKER_PORT, 10);
    } catch {}
  }
  if (!port) {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 77;
    port = 37700 + (uid % 100);
  }
  let healthBody;
  try {
    healthBody = execSync(`curl -s --max-time 2 http://127.0.0.1:${port}/api/health`, {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
  } catch {
    return; // No worker running — nothing to compare against; sync proceeds.
  }
  if (!healthBody) return;
  let installedVersion;
  let installedPath;
  try {
    const j = JSON.parse(healthBody);
    installedVersion = j.version;
    installedPath = j.workerPath;
  } catch {
    return;
  }
  if (!installedVersion || installedVersion === buildVersion) return;
  console.log('');
  console.log('\x1b[31m%s\x1b[0m', `Version mismatch:`);
  console.log(`  Building:   ${buildVersion}`);
  console.log(`  Installed:  ${installedVersion}`);
  if (installedPath) console.log(`  Worker path: ${installedPath}`);
  console.log('');
  console.log('Claude Code is pinned to the installed version, so syncing will not');
  console.log('actually change which worker runs. Update the plugin first:');
  console.log('');
  console.log('\x1b[36m%s\x1b[0m', '  claude plugin update thedotmack/claude-mem');
  console.log('');
  console.log('then re-run build-and-sync. To sync anyway, pass --force.');
  process.exit(1);
}

if (!isForce) {
  preflightVersionCheck(getPluginVersion());
}

// Normal rsync for main branch or fresh install
console.log('Syncing to marketplace...');
try {
  const rootDir = path.join(__dirname, '..');
  const gitignoreExcludes = getGitignoreExcludes(rootDir);

  execSync(
    `rsync -av --delete --exclude=.git --exclude=bun.lock --exclude=package-lock.json ${gitignoreExcludes} ./ ~/.claude/plugins/marketplaces/thedotmack/`,
    { stdio: 'inherit' }
  );

  console.log('Running bun install in marketplace...');
  execSync(
    'cd ~/.claude/plugins/marketplaces/thedotmack/ && bun install',
    { stdio: 'inherit' }
  );

  // Sync to cache folder with version
  const version = getPluginVersion();
  const CACHE_VERSION_PATH = path.join(CACHE_BASE_PATH, version);

  const pluginDir = path.join(rootDir, 'plugin');
  const pluginGitignoreExcludes = getGitignoreExcludes(pluginDir);

  console.log(`Syncing to cache folder (version ${version})...`);
  execSync(
    `rsync -av --delete --exclude=.git ${pluginGitignoreExcludes} plugin/ "${CACHE_VERSION_PATH}/"`,
    { stdio: 'inherit' }
  );

  // Install dependencies in cache directory so worker can resolve them
  console.log(`Running bun install in cache folder (version ${version})...`);
  execSync(`bun install`, { cwd: CACHE_VERSION_PATH, stdio: 'inherit' });

  console.log('\x1b[32m%s\x1b[0m', 'Sync complete!');

  // Trigger worker restart after file sync
  console.log('\n🔄 Triggering worker restart...');
  const http = require('http');
  const dataDir = process.env.CLAUDE_MEM_DATA_DIR || path.join(os.homedir(), '.claude-mem');
  const settingsPath = path.join(dataDir, 'settings.json');
  let settingsPort = null;
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
      if (settings.CLAUDE_MEM_WORKER_PORT) {
        settingsPort = parseInt(settings.CLAUDE_MEM_WORKER_PORT, 10);
      }
    } catch {
      // fall through to env / default
    }
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : 77;
  const defaultPort = 37700 + (uid % 100);
  const workerPort =
    parseInt(process.env.CLAUDE_MEM_WORKER_PORT, 10) ||
    settingsPort ||
    defaultPort;
  const req = http.request({
    hostname: '127.0.0.1',
    port: workerPort,
    path: '/api/admin/restart',
    method: 'POST',
    timeout: 2000
  }, (res) => {
    if (res.statusCode === 200) {
      console.log('\x1b[32m%s\x1b[0m', `✓ Worker restart triggered on port ${workerPort}`);
    } else {
      console.log('\x1b[33m%s\x1b[0m', `ℹ Worker restart on port ${workerPort} returned status ${res.statusCode}`);
    }
  });
  req.on('error', () => {
    console.log('\x1b[33m%s\x1b[0m', `ℹ No worker reachable on port ${workerPort}; the next worker:restart step will start one.`);
  });
  req.on('timeout', () => {
    req.destroy();
    console.log('\x1b[33m%s\x1b[0m', `ℹ Worker restart on port ${workerPort} timed out`);
  });
  req.end();

} catch (error) {
  console.error('\x1b[31m%s\x1b[0m', 'Sync failed:', error.message);
  process.exit(1);
}