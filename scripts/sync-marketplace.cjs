#!/usr/bin/env node

const { execFileSync, execSync } = require('child_process');
const { existsSync, readFileSync, writeFileSync } = require('fs');
const path = require('path');
const os = require('os');
const { mirrorDirectory } = require('./mirror-dir.cjs');

const INSTALLED_PATH = path.join(os.homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack');
const CACHE_BASE_PATH = path.join(os.homedir(), '.claude', 'plugins', 'cache', 'thedotmack', 'claude-mem');

const BASE_EXCLUDES = [
  '.git',
  'bun.lock',
  'package-lock.json',
  'scripts/package.json',
  'scripts/node_modules',
  '/workers',
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

function getGitignoreExcludes(basePath) {
  const gitignorePath = path.join(basePath, '.gitignore');
  if (!existsSync(gitignorePath)) return [];

  const syncManagedFiles = new Set();

  const lines = readFileSync(gitignorePath, 'utf-8').split('\n');
  return lines
    .map(line => line.trim())
    .filter(line =>
      line &&
      !line.startsWith('#') &&
      !line.startsWith('!') &&
      !syncManagedFiles.has(line)
    );
}

function getMarketplaceExcludes(rootDir) {
  return [...BASE_EXCLUDES, ...getGitignoreExcludes(rootDir)];
}

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

function probeVersion(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unavailable';
  }
}

function writeInstallMarker(directory, version, bunVersion, uvVersion) {
  writeFileSync(path.join(directory, '.install-version'), `${JSON.stringify({
    version,
    bun: bunVersion,
    uv: uvVersion,
    installedAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 });
}

function main() {
  const branch = getCurrentBranch();
  const isForce = process.argv.includes('--force');

  if (branch && branch !== 'main' && !isForce) {
    console.log('');
    console.log('\x1b[33m%s\x1b[0m', `WARNING: Installed plugin is on beta branch: ${branch}`);
    console.log('\x1b[33m%s\x1b[0m', 'Running sync would overwrite beta code.');
    console.log('');
    console.log('Options:');
    console.log('  1. Use the claude-mem UI on the configured worker port to update beta');
    console.log('  2. Switch to stable in UI first, then run sync');
    console.log('  3. Force sync: npm run sync-marketplace:force');
    console.log('');
    process.exit(1);
  }

  console.log('Syncing to marketplace...');
  try {
    const rootDir = path.join(__dirname, '..');
    const skipInstall = process.env.CLAUDE_MEM_SYNC_SKIP_INSTALL === '1';

    const marketplace = mirrorDirectory(rootDir, INSTALLED_PATH, {
      exclude: getMarketplaceExcludes(rootDir)
    });
    console.log(`Marketplace: ${marketplace.copied} copied, ${marketplace.metadata} metadata reconciled, ${marketplace.deleted} stale removed`);

    if (!skipInstall) {
      console.log('Running bun install in marketplace...');
      execSync('bun install', { cwd: INSTALLED_PATH, stdio: 'inherit' });
    }

    const version = getPluginVersion();
    const CACHE_VERSION_PATH = path.join(CACHE_BASE_PATH, version);

    const pluginDir = path.join(rootDir, 'plugin');

    console.log(`Syncing to cache folder (version ${version})...`);
    const cache = mirrorDirectory(pluginDir, CACHE_VERSION_PATH, {
      exclude: ['.git', ...getGitignoreExcludes(pluginDir)]
    });
    console.log(`Cache: ${cache.copied} copied, ${cache.metadata} metadata reconciled, ${cache.deleted} stale removed`);

    if (!skipInstall) {
      console.log(`Running bun install in cache folder (version ${version})...`);
      execSync('bun install', { cwd: CACHE_VERSION_PATH, stdio: 'inherit' });
    }

    const bunVersion = probeVersion('bun', ['--version']);
    const uvVersion = probeVersion('uv', ['--version']);
    writeInstallMarker(INSTALLED_PATH, version, bunVersion, uvVersion);
    writeInstallMarker(path.join(INSTALLED_PATH, 'plugin'), version, bunVersion, uvVersion);
    writeInstallMarker(CACHE_VERSION_PATH, version, bunVersion, uvVersion);

    console.log('\x1b[32m%s\x1b[0m', 'Sync complete!');

  } catch (error) {
    console.error('\x1b[31m%s\x1b[0m', 'Sync failed:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { getGitignoreExcludes, getMarketplaceExcludes, INSTALLED_PATH, CACHE_BASE_PATH };
