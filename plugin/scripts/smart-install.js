#!/usr/bin/env node

/**
 * Smart Install Script for claude-mem
 *
 * Features:
 * - Detects execution context (cache vs marketplace directory)
 * - Installs dependencies where the hooks actually run (cache directory)
 * - Only runs npm install when necessary (version change or missing deps)
 * - Caches installation state with version marker
 * - Provides helpful Windows-specific error messages
 * - Cross-platform compatible (pure Node.js)
 * - Fast when already installed (just version check)
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

// Determine the directory where THIS script is running from
// This could be either:
// 1. Cache: ~/.claude/plugins/cache/thedotmack/claude-mem/X.X.X/scripts/
// 2. Marketplace: ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/
const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_ROOT = dirname(__dirname); // Parent of scripts/ directory

// Detect if running from cache directory (has version number in path)
const CACHE_PATTERN = /[/\\]cache[/\\]thedotmack[/\\]claude-mem[/\\]\d+\.\d+\.\d+/;
const IS_RUNNING_FROM_CACHE = CACHE_PATTERN.test(__dirname);

// Set PLUGIN_ROOT based on where we're running
// If from cache, install dependencies IN the cache directory (where hooks run)
// If from marketplace, use marketplace directory
const PLUGIN_ROOT = IS_RUNNING_FROM_CACHE
  ? SCRIPT_ROOT  // Cache directory (e.g., ~/.claude/plugins/cache/thedotmack/claude-mem/7.0.3/)
  : join(homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack');

const PACKAGE_JSON_PATH = join(PLUGIN_ROOT, 'package.json');
const VERSION_MARKER_PATH = join(PLUGIN_ROOT, '.install-version');
const NODE_MODULES_PATH = join(PLUGIN_ROOT, 'node_modules');

// Colors for output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
};

function log(message, color = colors.reset) {
  console.error(`${color}${message}${colors.reset}`);
}

function getPackageVersion() {
  try {
    const packageJson = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf-8'));
    return packageJson.version;
  } catch (error) {
    log(`⚠️  Failed to read package.json: ${error.message}`, colors.yellow);
    return null;
  }
}

function getNodeVersion() {
  return process.version; // e.g., "v22.21.1"
}

function getInstalledVersion() {
  try {
    if (existsSync(VERSION_MARKER_PATH)) {
      const content = readFileSync(VERSION_MARKER_PATH, 'utf-8').trim();

      // Try parsing as JSON (new format)
      try {
        const marker = JSON.parse(content);
        return {
          packageVersion: marker.packageVersion,
          nodeVersion: marker.nodeVersion,
          installedAt: marker.installedAt
        };
      } catch {
        // Fallback: old format (plain text version string)
        return {
          packageVersion: content,
          nodeVersion: null, // Unknown
          installedAt: null
        };
      }
    }
  } catch (error) {
    // Marker doesn't exist or can't be read
  }
  return null;
}

function setInstalledVersion(packageVersion, nodeVersion) {
  try {
    const marker = {
      packageVersion,
      nodeVersion,
      installedAt: new Date().toISOString()
    };
    writeFileSync(VERSION_MARKER_PATH, JSON.stringify(marker, null, 2), 'utf-8');
  } catch (error) {
    log(`⚠️  Failed to write version marker: ${error.message}`, colors.yellow);
  }
}

function needsInstall() {
  // Check if package.json exists (required for npm install)
  if (!existsSync(PACKAGE_JSON_PATH)) {
    log(`⚠️  No package.json found at ${PLUGIN_ROOT}`, colors.yellow);
    return false; // Can't install without package.json
  }

  // Check if node_modules exists
  if (!existsSync(NODE_MODULES_PATH)) {
    log('📦 Dependencies not found - first time setup', colors.cyan);
    return true;
  }

  // Check version marker
  const currentPackageVersion = getPackageVersion();
  const currentNodeVersion = getNodeVersion();
  const installed = getInstalledVersion();

  if (!installed) {
    log('📦 No version marker found - installing', colors.cyan);
    return true;
  }

  // Check package version
  if (currentPackageVersion !== installed.packageVersion) {
    log(`📦 Version changed (${installed.packageVersion} → ${currentPackageVersion}) - updating`, colors.cyan);
    return true;
  }

  // Check Node.js version
  if (installed.nodeVersion && currentNodeVersion !== installed.nodeVersion) {
    log(`📦 Node.js version changed (${installed.nodeVersion} → ${currentNodeVersion}) - rebuilding native modules`, colors.cyan);
    return true;
  }

  // If old format (no nodeVersion), assume needs install
  if (!installed.nodeVersion) {
    log('📦 Old version marker format - updating', colors.cyan);
    return true;
  }

  // All good - no install needed
  log(`✓ Dependencies already installed (v${currentPackageVersion})`, colors.dim);
  return false;
}

async function runNpmInstall() {
  const isWindows = process.platform === 'win32';

  log('', colors.cyan);
  log(`🔨 Installing dependencies in ${IS_RUNNING_FROM_CACHE ? 'cache' : 'marketplace'}...`, colors.bright);
  log(`   ${PLUGIN_ROOT}`, colors.dim);
  log('', colors.reset);

  // Try normal install first, then retry with force if it fails
  const strategies = [
    { command: 'npm install', label: 'normal' },
    { command: 'npm install --force', label: 'with force flag' },
  ];

  let lastError = null;

  for (const { command, label } of strategies) {
    try {
      log(`Attempting install ${label}...`, colors.dim);

      // Run npm install silently
      execSync(command, {
        cwd: PLUGIN_ROOT,
        stdio: 'pipe', // Silent output unless error
        encoding: 'utf-8',
      });

      const packageVersion = getPackageVersion();
      const nodeVersion = getNodeVersion();
      setInstalledVersion(packageVersion, nodeVersion);

      log('', colors.green);
      log('✅ Dependencies installed successfully!', colors.bright);
      log(`   Package version: ${packageVersion}`, colors.dim);
      log(`   Node.js version: ${nodeVersion}`, colors.dim);
      log('', colors.reset);

      return true;

    } catch (error) {
      lastError = error;
      // Continue to next strategy
    }
  }

  // All strategies failed - show error
  log('', colors.red);
  log('❌ Installation failed after retrying!', colors.bright);
  log('', colors.reset);

  // Show generic error info with troubleshooting steps
  if (lastError) {
    if (lastError.stderr) {
      log('Error output:', colors.dim);
      log(lastError.stderr.toString(), colors.red);
    } else if (lastError.message) {
      log(lastError.message, colors.red);
    }

    log('', colors.yellow);
    log('📋 Troubleshooting Steps:', colors.bright);
    log('', colors.reset);
    log('1. Check your internet connection', colors.yellow);
    log('2. Try running: npm cache clean --force', colors.yellow);
    log('3. Try running: npm install (in plugin directory)', colors.yellow);
    log('4. Check npm version: npm --version (requires npm 7+)', colors.yellow);
    log('5. Try updating npm: npm install -g npm@latest', colors.yellow);
    log('', colors.reset);
  }

  return false;
}

async function main() {
  try {
    // Log execution context for debugging
    if (IS_RUNNING_FROM_CACHE) {
      log('📍 Running from cache directory', colors.dim);
    } else {
      log('📍 Running from marketplace directory', colors.dim);
    }

    // Check if we need to install dependencies
    const installNeeded = needsInstall();

    if (installNeeded) {
      // Run installation (now async)
      const installSuccess = await runNpmInstall();

      if (!installSuccess) {
        log('', colors.red);
        log('⚠️  Installation failed', colors.yellow);
        log('', colors.reset);
        process.exit(1);
      }
    }

    // NOTE: Worker auto-start disabled in smart-install.js
    // The context-hook.js calls ensureWorkerRunning() which handles worker startup
    // This avoids potential process management conflicts during plugin initialization
    log('✅ Installation complete', colors.green);

    // Success - dependencies installed (if needed)
    process.exit(0);

  } catch (error) {
    log(`❌ Unexpected error: ${error.message}`, colors.red);
    log('', colors.reset);
    process.exit(1);
  }
}

main();
