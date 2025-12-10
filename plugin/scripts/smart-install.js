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
import { createRequire } from 'module';
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
const BETTER_SQLITE3_PATH = join(NODE_MODULES_PATH, 'better-sqlite3');

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

  // Check if better-sqlite3 is installed
  if (!existsSync(BETTER_SQLITE3_PATH)) {
    log('📦 better-sqlite3 missing - reinstalling', colors.cyan);
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

/**
 * Verify that better-sqlite3 native module loads correctly
 * This catches ABI mismatches and corrupted builds
 */
async function verifyNativeModules() {
  try {
    log('🔍 Verifying native modules...', colors.dim);

    // Use createRequire() to resolve from PLUGIN_ROOT's node_modules
    const require = createRequire(join(PLUGIN_ROOT, 'package.json'));
    const Database = require('better-sqlite3');

    // Try to create a test in-memory database
    const db = new Database(':memory:');

    // Run a simple query to ensure it works
    const result = db.prepare('SELECT 1 + 1 as result').get();

    // Clean up
    db.close();

    if (result.result !== 2) {
      throw new Error('SQLite math check failed');
    }

    log('✓ Native modules verified', colors.dim);
    return true;

  } catch (error) {
    if (error.code === 'ERR_DLOPEN_FAILED') {
      log('⚠️  Native module ABI mismatch detected', colors.yellow);
      return false;
    }

    // Other errors are unexpected - log and fail
    log(`❌ Native module verification failed: ${error.message}`, colors.red);
    return false;
  }
}

function getWindowsErrorHelp(errorOutput) {
  // Detect Python version at runtime
  let pythonStatus = '   Python not detected or version unknown';
  try {
    const pythonVersion = execSync('python --version', { encoding: 'utf-8', stdio: 'pipe' }).trim();
    const versionMatch = pythonVersion.match(/Python\s+([\d.]+)/);
    if (versionMatch) {
      pythonStatus = `   You have ${versionMatch[0]} installed ✓`;
    }
  } catch (error) {
    // Python not available or failed to detect - use default message
  }

  const help = [
    '',
    '╔══════════════════════════════════════════════════════════════════════╗',
    '║                    Windows Installation Help                        ║',
    '╚══════════════════════════════════════════════════════════════════════╝',
    '',
    '📋 better-sqlite3 requires build tools to compile native modules.',
    '',
    '🔧 Option 1: Install Visual Studio Build Tools (Recommended)',
    '   1. Download: https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022',
    '   2. Install "Desktop development with C++"',
    '   3. Restart your terminal',
    '   4. Try again',
    '',
    '🔧 Option 2: Install via npm (automated)',
    '   Run as Administrator:',
    '   npm install --global windows-build-tools',
    '',
    '🐍 Python Requirement:',
    '   Python 3.6+ is required.',
    pythonStatus,
    '',
  ];

  // Check for specific error patterns
  if (errorOutput.includes('MSBuild.exe')) {
    help.push('❌ MSBuild not found - install Visual Studio Build Tools');
  }
  if (errorOutput.includes('MSVS')) {
    help.push('❌ Visual Studio not detected - install Build Tools');
  }
  if (errorOutput.includes('permission') || errorOutput.includes('EPERM')) {
    help.push('❌ Permission denied - try running as Administrator');
  }

  help.push('');
  help.push('📖 Full documentation: https://github.com/WiseLibs/better-sqlite3/blob/master/docs/troubleshooting.md');
  help.push('');

  return help.join('\n');
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

      // Verify better-sqlite3 was installed
      if (!existsSync(BETTER_SQLITE3_PATH)) {
        throw new Error('better-sqlite3 installation verification failed');
      }

      // Verify native modules actually work
      const nativeModulesWork = await verifyNativeModules();
      if (!nativeModulesWork) {
        throw new Error('Native modules failed to load after install');
      }

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

  // Provide Windows-specific help
  if (isWindows && lastError && lastError.message && lastError.message.includes('better-sqlite3')) {
    log(getWindowsErrorHelp(lastError.message), colors.yellow);
  }

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
    } else {
      // Even if install not needed, verify native modules work
      const nativeModulesWork = await verifyNativeModules();

      if (!nativeModulesWork) {
        log('📦 Native modules need rebuild - reinstalling', colors.cyan);
        const installSuccess = await runNpmInstall();

        if (!installSuccess) {
          log('', colors.red);
          log('⚠️  Native module rebuild failed', colors.yellow);
          log('', colors.reset);
          process.exit(1);
        }
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
