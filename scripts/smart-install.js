#!/usr/bin/env node

/**
 * Smart Install Script for claude-mem
 *
 * Features:
 * - Only runs npm install when necessary (version change or missing deps)
 * - Caches installation state with version marker
 * - Provides helpful Windows-specific error messages
 * - Cross-platform compatible (pure Node.js)
 * - Fast when already installed (just version check)
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Plugin root is parent directory of scripts/
const PLUGIN_ROOT = join(__dirname, '..');
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

function getInstalledVersion() {
  try {
    if (existsSync(VERSION_MARKER_PATH)) {
      return readFileSync(VERSION_MARKER_PATH, 'utf-8').trim();
    }
  } catch (error) {
    // Marker doesn't exist or can't be read
  }
  return null;
}

function setInstalledVersion(version) {
  try {
    writeFileSync(VERSION_MARKER_PATH, version, 'utf-8');
  } catch (error) {
    log(`⚠️  Failed to write version marker: ${error.message}`, colors.yellow);
  }
}

function needsInstall() {
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
  const currentVersion = getPackageVersion();
  const installedVersion = getInstalledVersion();

  if (!installedVersion) {
    log('📦 No version marker found - installing', colors.cyan);
    return true;
  }

  if (currentVersion !== installedVersion) {
    log(`📦 Version changed (${installedVersion} → ${currentVersion}) - updating`, colors.cyan);
    return true;
  }

  // All good - no install needed
  log(`✓ Dependencies already installed (v${currentVersion})`, colors.dim);
  return false;
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

function runNpmInstall() {
  const isWindows = process.platform === 'win32';

  log('', colors.cyan);
  log('🔨 Installing dependencies...', colors.bright);
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

      const version = getPackageVersion();
      setInstalledVersion(version);

      log('', colors.green);
      log('✅ Dependencies installed successfully!', colors.bright);
      log(`   Version: ${version}`, colors.dim);
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

/**
 * Check if we should fail when worker startup fails
 * Returns true if worker failed AND dependencies are missing
 */
function shouldFailOnWorkerStartup(workerStarted) {
  return !workerStarted && !existsSync(NODE_MODULES_PATH);
}

async function main() {
  try {
    // Check if we need to install dependencies
    const installNeeded = needsInstall();

    if (installNeeded) {
      // Run installation
      const installSuccess = runNpmInstall();

      if (!installSuccess) {
        log('', colors.red);
        log('⚠️  Installation failed', colors.yellow);
        log('', colors.reset);
        process.exit(1);
      }

      // Try to start the PM2 worker after fresh install
      try {
        log('🚀 Starting worker service...', colors.cyan);
        // On Windows, PM2 executable is pm2.cmd, not pm2
        const localPm2Base = join(NODE_MODULES_PATH, '.bin', 'pm2');
        const localPm2Cmd = process.platform === 'win32' ? localPm2Base + '.cmd' : localPm2Base;
        const pm2Command = existsSync(localPm2Cmd) ? localPm2Cmd : 'pm2';
        const ecosystemPath = join(PLUGIN_ROOT, 'ecosystem.config.cjs');

        // shell: true required for Windows to handle quoted paths correctly
        execSync(`"${pm2Command}" start "${ecosystemPath}"`, {
          cwd: PLUGIN_ROOT,
          stdio: 'pipe',
          encoding: 'utf-8',
          shell: true
        });

        log('✅ Worker service started', colors.green);
      } catch (error) {
        // Worker might already be running or PM2 not available - that's okay
        // The ensureWorkerRunning() function will handle auto-start when needed
        log('ℹ️  Worker will start automatically when needed', colors.dim);
      }
    }

    // Success - dependencies installed (if needed)
    process.exit(0);

  } catch (error) {
    log(`❌ Unexpected error: ${error.message}`, colors.red);
    log('', colors.reset);
    process.exit(1);
  }
}

main();
