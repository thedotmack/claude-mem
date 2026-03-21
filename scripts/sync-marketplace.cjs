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

// Cross-platform sync: use rsync on Unix, robocopy on Windows
const isWindows = os.platform() === 'win32';

function parseExcludePatterns(gitignoreExcludesStr) {
  // Parse --exclude="pattern" flags into an array of patterns
  const patterns = [];
  const re = /--exclude=("([^"]+)"|(\S+))/g;
  let m;
  while ((m = re.exec(gitignoreExcludesStr)) !== null) {
    patterns.push(m[2] || m[3]);
  }
  return patterns;
}

function syncDir(src, dest, extraExcludes, gitignoreExcludesStr) {
  const { mkdirSync: mkdirSyncFs } = require('fs');
  mkdirSyncFs(dest, { recursive: true });

  if (!isWindows) {
    // Unix: use rsync as before
    const allExcludes = extraExcludes.map(e => `--exclude=${e}`).join(' ');
    execSync(
      `rsync -av --delete ${allExcludes} ${gitignoreExcludesStr} "${src}/" "${dest}/"`,
      { stdio: 'inherit' }
    );
    return;
  }

  // Windows: use robocopy (MIR = mirror/delete, similar to rsync --delete)
  // robocopy exit codes 0-7 are success, 8+ are errors
  const excludePatterns = [...extraExcludes, ...parseExcludePatterns(gitignoreExcludesStr)];

  // Clean up patterns for robocopy:
  // - Strip glob prefixes like **/ that robocopy doesn't understand
  // - Separate into directory names and file patterns
  const cleanPattern = (p) => p.replace(/^\*\*\//, '').replace(/\/$/, '').replace(/\//g, '\\');

  const excludeDirs = [];
  const excludeFiles = [];
  for (const raw of excludePatterns) {
    const p = cleanPattern(raw);
    // Skip empty or pure-wildcard patterns
    if (!p || p === '*') continue;
    // If it has a file extension and no path separators, treat as a file pattern
    if (/\.\w+$/.test(p) && !p.includes('\\')) {
      excludeFiles.push(p);
    } else {
      excludeDirs.push(p);
    }
  }

  // Normalize paths for Windows cmd
  const srcWin = src.replace(/\//g, '\\');
  const destWin = dest.replace(/\//g, '\\');

  let cmd = `robocopy "${srcWin}" "${destWin}" /MIR /NFL /NDL /NJH /NJS /NP`;
  if (excludeDirs.length > 0) {
    cmd += ` /XD ${excludeDirs.map(d => `"${d}"`).join(' ')}`;
  }
  if (excludeFiles.length > 0) {
    cmd += ` /XF ${excludeFiles.map(f => `"${f}"`).join(' ')}`;
  }

  try {
    execSync(cmd, { stdio: 'inherit', shell: true });
  } catch (error) {
    // robocopy exit codes 0-7 mean success (files copied, extra files, etc.)
    if (error.status != null && error.status < 8) {
      // Success - robocopy uses non-zero exit codes for informational purposes
    } else {
      throw error;
    }
  }
}

// Normal sync for main branch or fresh install
console.log('Syncing to marketplace...');
try {
  const rootDir = path.join(__dirname, '..');
  const gitignoreExcludes = getGitignoreExcludes(rootDir);

  syncDir(rootDir, INSTALLED_PATH, ['.git', 'bun.lock', 'package-lock.json'], gitignoreExcludes);

  console.log('Running bun install in marketplace...');
  execSync(
    isWindows
      ? `cd /d "${INSTALLED_PATH}" && bun install`
      : `cd "${INSTALLED_PATH}" && bun install`,
    { stdio: 'inherit', shell: true }
  );

  // Sync to cache folder with version
  const version = getPluginVersion();
  const CACHE_VERSION_PATH = path.join(CACHE_BASE_PATH, version);

  const pluginDir = path.join(rootDir, 'plugin');
  const pluginGitignoreExcludes = getGitignoreExcludes(pluginDir);

  console.log(`Syncing to cache folder (version ${version})...`);
  syncDir(pluginDir, CACHE_VERSION_PATH, ['.git'], pluginGitignoreExcludes);

  // Install dependencies in cache directory so worker can resolve them
  console.log(`Running bun install in cache folder (version ${version})...`);
  execSync(`bun install`, { cwd: CACHE_VERSION_PATH, stdio: 'inherit' });

  console.log('\x1b[32m%s\x1b[0m', 'Sync complete!');

  // Trigger worker restart after file sync — read port from worker.pid
  console.log('\n\u{1F504} Triggering worker restart...');
  let workerPort = 37777;
  try {
    const pidPath = path.join(os.homedir(), '.claude-mem', 'worker.pid');
    if (existsSync(pidPath)) {
      const pidInfo = JSON.parse(readFileSync(pidPath, 'utf-8'));
      if (pidInfo.port) workerPort = pidInfo.port;
    }
  } catch { /* use default */ }

  const http = require('http');
  const req = http.request({
    hostname: '127.0.0.1',
    port: workerPort,
    path: '/api/admin/restart',
    method: 'POST',
    timeout: 2000
  }, (res) => {
    if (res.statusCode === 200) {
      console.log('\x1b[32m%s\x1b[0m', '\u2713 Worker restart triggered');
    } else {
      console.log('\x1b[33m%s\x1b[0m', `\u2139 Worker restart returned status ${res.statusCode}`);
    }
  });
  req.on('error', () => {
    console.log('\x1b[33m%s\x1b[0m', '\u2139 Worker not running, will start on next hook');
  });
  req.on('timeout', () => {
    req.destroy();
    console.log('\x1b[33m%s\x1b[0m', '\u2139 Worker restart timed out');
  });
  req.end();

} catch (error) {
  console.error('\x1b[31m%s\x1b[0m', 'Sync failed:', error.message);
  process.exit(1);
}