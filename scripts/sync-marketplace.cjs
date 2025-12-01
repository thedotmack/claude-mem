#!/usr/bin/env node
/**
 * Protected sync-marketplace script
 *
 * Prevents accidental rsync overwrite when installed plugin is on beta branch.
 * If on beta, the user should use the UI to update instead.
 */

const { execSync } = require('child_process');
const { existsSync } = require('fs');
const path = require('path');
const os = require('os');

const INSTALLED_PATH = path.join(os.homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack');

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

if (branch && branch !== 'main') {
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

// Normal rsync for main branch or fresh install
console.log('Syncing to marketplace...');
try {
  execSync(
    'rsync -av --delete --exclude=.git ./ ~/.claude/plugins/marketplaces/thedotmack/',
    { stdio: 'inherit' }
  );

  console.log('Running npm install in marketplace...');
  execSync(
    'cd ~/.claude/plugins/marketplaces/thedotmack/ && npm install',
    { stdio: 'inherit' }
  );

  console.log('\x1b[32m%s\x1b[0m', 'Sync complete!');
} catch (error) {
  console.error('\x1b[31m%s\x1b[0m', 'Sync failed:', error.message);
  process.exit(1);
}
