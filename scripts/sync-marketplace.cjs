#!/usr/bin/env node
/**
 * Dev sync script: checkout branch in marketplace, build, sync to cache.
 *
 * Instead of rsync from the dev repo (which fights .gitignore exclusions
 * and leaves the binary out), this script:
 *   1. Pushes current branch to origin
 *   2. Checks out that branch in the marketplace git clone
 *   3. Pulls latest
 *   4. Installs deps and builds (CJS + binary) in-place
 *   5. Nukes stale cache dirs, rsyncs plugin/ to the versioned cache
 *   6. Restarts the worker and waits for health check
 */

const { execSync } = require('child_process');
const { existsSync, readFileSync, readdirSync, rmSync } = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

// ── Paths ───────────────────────────────────────────────────────────
const DEV_REPO = path.join(__dirname, '..');
const MARKETPLACE_PATH = path.join(os.homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack');
const CACHE_BASE_PATH = path.join(os.homedir(), '.claude', 'plugins', 'cache', 'thedotmack', 'claude-mem');

// ── Helpers ─────────────────────────────────────────────────────────
function log(message) { console.log(`\x1b[32m[sync]\x1b[0m ${message}`); }
function warn(message) { console.log(`\x1b[33m[sync]\x1b[0m ${message}`); }
function fail(message) { console.error(`\x1b[31m[sync]\x1b[0m ${message}`); process.exit(1); }

function run(command, options = {}) {
  const defaults = { stdio: 'inherit', encoding: 'utf-8' };
  return execSync(command, { ...defaults, ...options });
}

function runQuiet(command, options = {}) {
  return execSync(command, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], ...options }).trim();
}

function getPluginVersion(repoPath) {
  const pluginJsonPath = path.join(repoPath, 'plugin', '.claude-plugin', 'plugin.json');
  return JSON.parse(readFileSync(pluginJsonPath, 'utf-8')).version;
}

// ── Step 1: Push current branch ─────────────────────────────────────
log('Step 1/6: Pushing current branch to origin...');

const devBranch = runQuiet('git rev-parse --abbrev-ref HEAD', { cwd: DEV_REPO });
if (!devBranch) fail('Could not determine current branch');
log(`  Branch: ${devBranch}`);

// Push to origin (create upstream if needed)
run(`git push -u origin ${devBranch}`, { cwd: DEV_REPO });

// ── Step 2: Checkout branch in marketplace ──────────────────────────
log(`Step 2/6: Checking out ${devBranch} in marketplace...`);

if (!existsSync(path.join(MARKETPLACE_PATH, '.git'))) {
  fail(`Marketplace path is not a git repo: ${MARKETPLACE_PATH}`);
}

// Claude Code installs plugins as single-branch clones (main only).
// Widen the fetch refspec so we can checkout any branch.
const currentRefspec = runQuiet('git config remote.origin.fetch', { cwd: MARKETPLACE_PATH });
if (!currentRefspec.includes('refs/heads/*')) {
  log('  Widening fetch refspec (was single-branch clone)');
  run('git config remote.origin.fetch "+refs/heads/*:refs/remotes/origin/*"', { cwd: MARKETPLACE_PATH });
}

// Discard any dirty state from previous rsync-based syncs
run('git checkout -- .', { cwd: MARKETPLACE_PATH });
run('git clean -fd', { cwd: MARKETPLACE_PATH });

run('git fetch origin', { cwd: MARKETPLACE_PATH });

// Checkout: try local branch first, fall back to creating from remote tracking
try {
  runQuiet(`git rev-parse --verify ${devBranch}`, { cwd: MARKETPLACE_PATH });
  run(`git checkout ${devBranch}`, { cwd: MARKETPLACE_PATH });
} catch {
  run(`git checkout -b ${devBranch} origin/${devBranch}`, { cwd: MARKETPLACE_PATH });
}

run(`git reset --hard origin/${devBranch}`, { cwd: MARKETPLACE_PATH });

log(`  Marketplace now on: ${runQuiet('git rev-parse --short HEAD', { cwd: MARKETPLACE_PATH })}`);

// ── Step 3: Install deps in marketplace ─────────────────────────────
log('Step 3/6: Installing dependencies...');
run('bun install', { cwd: MARKETPLACE_PATH });

// ── Step 4: Build CJS hooks + binary in marketplace ─────────────────
log('Step 4/6: Building hooks and binary...');
run('npm run build', { cwd: MARKETPLACE_PATH });

// ── Step 5: Sync plugin/ to versioned cache ─────────────────────────
log('Step 5/6: Syncing to cache...');

const version = getPluginVersion(MARKETPLACE_PATH);
const cacheVersionPath = path.join(CACHE_BASE_PATH, version);

// Remove ALL stale cache versions
if (existsSync(CACHE_BASE_PATH)) {
  const staleVersions = readdirSync(CACHE_BASE_PATH)
    .filter(entry => !entry.startsWith('.') && entry !== version);
  if (staleVersions.length > 0) {
    log(`  Removing ${staleVersions.length} stale version(s): ${staleVersions.join(', ')}`);
    for (const stale of staleVersions) {
      rmSync(path.join(CACHE_BASE_PATH, stale), { recursive: true, force: true });
    }
  }
}

// Nuke current version cache to guarantee clean state
if (existsSync(cacheVersionPath)) {
  rmSync(cacheVersionPath, { recursive: true, force: true });
}

// rsync from marketplace's plugin/ (which has the freshly-built binary)
run(`rsync -a --delete --exclude=.git "${MARKETPLACE_PATH}/plugin/" "${cacheVersionPath}/"`);

// Verify binary landed in cache
const binaryInCache = path.join(cacheVersionPath, 'scripts', 'claude-mem');
if (existsSync(binaryInCache)) {
  log(`  Binary in cache: ${binaryInCache}`);
} else {
  warn('  Binary NOT in cache — hooks using binary commands will fail');
}

// Verify hooks.json is the new format
const cachedHooksPath = path.join(cacheVersionPath, 'hooks', 'hooks.json');
if (existsSync(cachedHooksPath)) {
  const cachedHooks = readFileSync(cachedHooksPath, 'utf-8');
  if (cachedHooks.includes('bun-runner')) {
    warn('  Cache has OLD hooks format (bun-runner). Expected new binary format.');
  } else {
    log('  Hooks format verified (binary commands)');
  }
}

// ── Step 6: Restart worker and wait ─────────────────────────────────
log('Step 6/6: Restarting worker...');

function restartWorker() {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: 37777,
      path: '/api/admin/restart',
      method: 'POST',
      timeout: 5000
    }, (res) => {
      if (res.statusCode === 200) {
        log('  Worker restart triggered');
        resolve(true);
      } else {
        warn(`  Worker restart returned status ${res.statusCode}`);
        resolve(false);
      }
    });
    req.on('error', () => {
      warn('  Worker not running, will start on next hook');
      resolve(false);
    });
    req.on('timeout', () => {
      req.destroy();
      warn('  Worker restart timed out');
      resolve(false);
    });
    req.end();
  });
}

function waitForWorkerHealthy(maxAttempts = 10, intervalMs = 1000) {
  return new Promise((resolve) => {
    let attempts = 0;
    const check = () => {
      attempts++;
      const req = http.request({
        hostname: '127.0.0.1',
        port: 37777,
        path: '/api/health',
        method: 'GET',
        timeout: 2000
      }, (res) => {
        if (res.statusCode === 200) {
          log(`  Worker healthy after ${attempts} check(s)`);
          resolve(true);
        } else if (attempts < maxAttempts) {
          setTimeout(check, intervalMs);
        } else {
          warn(`  Worker not healthy after ${maxAttempts} checks`);
          resolve(false);
        }
      });
      req.on('error', () => {
        if (attempts < maxAttempts) {
          setTimeout(check, intervalMs);
        } else {
          warn(`  Worker not reachable after ${maxAttempts} checks`);
          resolve(false);
        }
      });
      req.on('timeout', () => {
        req.destroy();
        if (attempts < maxAttempts) {
          setTimeout(check, intervalMs);
        } else {
          resolve(false);
        }
      });
      req.end();
    };
    check();
  });
}

(async () => {
  const restarted = await restartWorker();
  if (restarted) {
    await waitForWorkerHealthy();
  }
  log('Done.');
})();
