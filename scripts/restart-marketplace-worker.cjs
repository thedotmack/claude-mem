#!/usr/bin/env node

const { execSync } = require('child_process');
const { existsSync } = require('fs');
const path = require('path');
const os = require('os');

const INSTALLED_PATH = path.join(os.homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack');

if (!existsSync(INSTALLED_PATH)) {
  console.error('\x1b[31m%s\x1b[0m', `Marketplace not found at ${INSTALLED_PATH} - run npm run sync-marketplace first`);
  process.exit(1);
}

try {
  execSync('npm run worker:restart', { cwd: INSTALLED_PATH, stdio: 'inherit' });
} catch (error) {
  console.error('\x1b[31m%s\x1b[0m', 'Worker restart failed:', error.message);
  process.exit(1);
}
