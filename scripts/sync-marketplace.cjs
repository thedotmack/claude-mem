#!/usr/bin/env node

const { execSync } = require('child_process');
const { existsSync, readFileSync } = require('fs');
const path = require('path');
const os = require('os');

const INSTALLED_PATH = path.join(os.homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack');
const CACHE_BASE_PATH = path.join(os.homedir(), '.claude', 'plugins', 'cache', 'thedotmack', 'claude-mem');

const PRESERVE_PATTERNS = [
  '.env',
  '.env.local',
  '.env.*',
  'docker-compose.override.yml',
  'docker-compose.override.*.yml',
  'secrets/',
  'secrets/***',
  'data/',
  'data/***',
  '.user-config/',
  '.user-config/***',
];

function preserveExcludes() {
  return PRESERVE_PATTERNS.map((pattern) => `--exclude=${JSON.stringify(pattern)}`).join(' ');
}

function buildDryRunCommand(rsyncCommand) {
  return rsyncCommand.replace(/^rsync\s+-/, 'rsync --dry-run -');
}

function deleteFlag() {
  const argv = process.argv.slice(2);
  if (argv.includes('--force-delete') || process.env.CLAUDE_MEM_SYNC_FORCE_DELETE === '1') {
    return '--delete';
  }
  return '';
}

function dryRunFlag() {
  const argv = process.argv.slice(2);
  return argv.includes('--dry-run') || argv.includes('-n');
}

function shouldShowPreview() {
  const argv = process.argv.slice(2);
  if (argv.includes('--non-interactive') || argv.includes('--no-preview')) {
    return false;
  }
  return process.env.CLAUDE_MEM_SYNC_NO_PREVIEW !== '1';
}

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

  const syncManagedFiles = new Set();

  const lines = readFileSync(gitignorePath, 'utf-8').split('\n');
  return lines
    .map(line => line.trim())
    .filter(line =>
      line &&
      !line.startsWith('#') &&
      !line.startsWith('!') &&
      !syncManagedFiles.has(line)
    )
    .map(pattern => `--exclude=${JSON.stringify(pattern)}`)
    .join(' ');
}

const DRY_RUN = dryRunFlag();
const branch = getCurrentBranch();
const isForce = process.argv.includes('--force');

if (branch && branch !== 'main' && !isForce && !DRY_RUN) {
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

console.log('Syncing to marketplace...');
if (DRY_RUN) {
  console.log('\x1b[33m%s\x1b[0m', '--dry-run: previewing all rsync invocations; no marketplace writes will happen.');
}

try {
  const rootDir = path.join(__dirname, '..');
  const gitignoreExcludes = getGitignoreExcludes(rootDir);
  const DELETE = deleteFlag();

  {
    const cmdBase = `rsync -av ${DELETE} --exclude=.git --exclude=bun.lock --exclude=package-lock.json --exclude=scripts/package.json --exclude=scripts/node_modules ${gitignoreExcludes} ${preserveExcludes()} ./ ~/.claude/plugins/marketplaces/thedotmack/`;
    if (DRY_RUN) {
      console.log('\x1b[36m%s\x1b[0m', 'Marketplace sync preview:');
      execSync(buildDryRunCommand(cmdBase), { stdio: 'inherit' });
    } else {
      if (shouldShowPreview() && DELETE) {
        console.log('\x1b[36m%s\x1b[0m', 'Preview (would-delete items below). Pass --non-interactive to skip:');
        execSync(buildDryRunCommand(cmdBase), { stdio: 'inherit' });
      }
      execSync(cmdBase, { stdio: 'inherit' });
    }
  }

  if (!DRY_RUN) {
    console.log('Running bun install in marketplace...');
    execSync(
      'cd ~/.claude/plugins/marketplaces/thedotmack/ && bun install',
      { stdio: 'inherit' }
    );
  }

  const version = getPluginVersion();
  const CACHE_VERSION_PATH = path.join(CACHE_BASE_PATH, version);

  const pluginDir = path.join(rootDir, 'plugin');
  const pluginGitignoreExcludes = getGitignoreExcludes(pluginDir);

  console.log(`Syncing to cache folder (version ${version})...`);
  {
    const cmdBase = `rsync -av ${DELETE} --exclude=.git ${pluginGitignoreExcludes} ${preserveExcludes()} plugin/ "${CACHE_VERSION_PATH}/"`;
    if (DRY_RUN) {
      console.log('\x1b[36m%s\x1b[0m', `Cache (version ${version}) sync preview:`);
      execSync(buildDryRunCommand(cmdBase), { stdio: 'inherit' });
    } else {
      if (shouldShowPreview() && DELETE) {
        console.log('\x1b[36m%s\x1b[0m', `Preview (cache ${version} would-delete):`);
        execSync(buildDryRunCommand(cmdBase), { stdio: 'inherit' });
      }
      execSync(cmdBase, { stdio: 'inherit' });
    }
  }

  if (!DRY_RUN) {
    console.log(`Running bun install in cache folder (version ${version})...`);
    execSync(`bun install`, { cwd: CACHE_VERSION_PATH, stdio: 'inherit' });
  }

  if (DRY_RUN) {
    console.log('\x1b[33m%s\x1b[0m', '--dry-run: skipping worker restart and bun installs. No marketplace writes happened.');
    process.exit(0);
  }

  console.log('\x1b[32m%s\x1b[0m', 'Sync complete!');

} catch (error) {
  console.error('\x1b[31m%s\x1b[0m', 'Sync failed:', error.message);
  process.exit(1);
}
