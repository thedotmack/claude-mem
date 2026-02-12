#!/usr/bin/env node
/**
 * claude-mem Setup Hook
 * Cross-platform setup script (Windows + Unix)
 * Ensures dependencies are installed before plugin runs
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Use CLAUDE_PLUGIN_ROOT if available, otherwise detect from script location
const ROOT = process.env.CLAUDE_PLUGIN_ROOT || join(__dirname, '..');
const MARKER = join(ROOT, '.install-version');
const PKG_JSON = join(ROOT, 'package.json');

// Colors
const colors = {
  RED: '\x1b[0;31m',
  GREEN: '\x1b[0;32m',
  YELLOW: '\x1b[0;33m',
  BLUE: '\x1b[0;34m',
  NC: '\x1b[0m'
};

const log = {
  info: (msg) => console.error(`${colors.BLUE}ℹ${colors.NC} ${msg}`),
  ok: (msg) => console.error(`${colors.GREEN}✓${colors.NC} ${msg}`),
  warn: (msg) => console.error(`${colors.YELLOW}⚠${colors.NC} ${msg}`),
  error: (msg) => console.error(`${colors.RED}✗${colors.NC} ${msg}`)
};

/**
 * Find Bun executable (cross-platform)
 */
function findBun() {
  try {
    const bunPath = execSync('where bun', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim().split('\n')[0];
    if (bunPath) return bunPath;
  } catch {}
  
  // Try common locations
  const paths = process.platform === 'win32' 
    ? [
        join(process.env.USERPROFILE || '', '.bun', 'bin', 'bun.exe'),
        'C:\\Program Files\\bun\\bun.exe'
      ]
    : [
        join(process.env.HOME || '', '.bun', 'bin', 'bun'),
        '/usr/local/bin/bun',
        '/opt/homebrew/bin/bun'
      ];
  
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  
  return null;
}

/**
 * Find uv executable (cross-platform)
 */
function findUv() {
  try {
    const uvPath = execSync('where uv', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim().split('\n')[0];
    if (uvPath) return uvPath;
  } catch {}
  
  // Try common locations
  const paths = process.platform === 'win32'
    ? [
        join(process.env.USERPROFILE || '', '.local', 'bin', 'uv.exe'),
        join(process.env.USERPROFILE || '', '.cargo', 'bin', 'uv.exe')
      ]
    : [
        join(process.env.HOME || '', '.local', 'bin', 'uv'),
        join(process.env.HOME || '', '.cargo', 'bin', 'uv'),
        '/usr/local/bin/uv',
        '/opt/homebrew/bin/uv'
      ];
  
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  
  return null;
}

/**
 * Get package.json version
 */
function getPkgVersion() {
  if (!existsSync(PKG_JSON)) return null;
  try {
    const pkg = JSON.parse(readFileSync(PKG_JSON, 'utf8'));
    return pkg.version;
  } catch {
    return null;
  }
}

/**
 * Check if setup is needed
 */
function needsSetup() {
  if (!existsSync(MARKER)) return true;
  
  const currentVersion = getPkgVersion();
  if (!currentVersion) return true;
  
  try {
    const installedVersion = readFileSync(MARKER, 'utf8').trim();
    return installedVersion !== currentVersion;
  } catch {
    return true;
  }
}

/**
 * Main setup logic
 */
async function main() {
  log.info('claude-mem setup check');
  
  // Check if setup needed
  if (!needsSetup()) {
    log.ok('Dependencies already installed (version matches)');
    return 0;
  }
  
  log.info('Installing dependencies...');
  
  // Find Bun
  const bunPath = findBun();
  if (!bunPath) {
    log.error('Bun not found. Please install Bun: https://bun.sh');
    return 1;
  }
  log.ok(`Found Bun: ${bunPath}`);
  
  // Find uv (optional for vector search)
  const uvPath = findUv();
  if (uvPath) {
    log.ok(`Found uv: ${uvPath}`);
  } else {
    log.warn('uv not found (optional). Vector search may be unavailable.');
  }
  
  // Install Node.js dependencies if package.json exists
  if (existsSync(PKG_JSON)) {
    try {
      log.info('Installing Node.js dependencies...');
      execSync(`"${bunPath}" install`, { 
        cwd: ROOT, 
        stdio: 'inherit',
        shell: true 
      });
      log.ok('Node.js dependencies installed');
    } catch (error) {
      log.error(`Failed to install dependencies: ${error.message}`);
      return 1;
    }
  }
  
  // Mark as installed
  const version = getPkgVersion();
  if (version) {
    writeFileSync(MARKER, version);
    log.ok(`Setup complete (version ${version})`);
  }
  
  return 0;
}

// Run
main().then(code => process.exit(code)).catch(error => {
  log.error(`Setup failed: ${error.message}`);
  process.exit(1);
});
