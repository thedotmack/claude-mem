#!/usr/bin/env node

/**
 * claude-mem installer - Cross-platform bootstrap
 * Works on Windows, macOS, and Linux
 *
 * Usage: node install.js
 *   or:  node install.js --provider=gemini --api-key=YOUR_KEY
 */

import { execSync, spawn } from 'child_process';
import { existsSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ANSI colors for terminal output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
};

function error(message) {
  console.error(`${colors.red}Error: ${message}${colors.reset}`);
  process.exit(1);
}

function info(message) {
  console.log(`${colors.cyan}${message}${colors.reset}`);
}

function success(message) {
  console.log(`${colors.green}${message}${colors.reset}`);
}

/**
 * Parse Node.js version from "vX.Y.Z" format
 */
function parseNodeVersion(versionStr) {
  const match = versionStr.match(/v(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    major: parseInt(match[1]),
    minor: parseInt(match[2]),
    patch: parseInt(match[3]),
    full: versionStr.trim(),
  };
}

/**
 * Check if Node.js is installed and meets version requirements
 */
function checkNodeVersion() {
  try {
    const nodeVersion = execSync('node -v', { encoding: 'utf-8' });
    const parsed = parseNodeVersion(nodeVersion);

    if (!parsed) {
      error('Could not parse Node.js version');
    }

    info(`claude-mem installer (Node.js ${parsed.full})`);

    if (parsed.major < 18) {
      error(`Node.js >= 18 required. Current: ${parsed.full}`);
    }

    return parsed.full;
  } catch (err) {
    error('Node.js is required but not found. Install from https://nodejs.org');
  }
}

/**
 * Find and validate installer script
 */
function findInstaller() {
  const possiblePaths = [
    // 1. Local in same directory
    resolve(__dirname, 'installer.js'),
    // 2. From project root installer/dist
    resolve(__dirname, '../..', 'installer/dist/index.js'),
    // 3. From current working directory
    resolve(process.cwd(), 'installer.js'),
    resolve(process.cwd(), 'installer/dist/index.js'),
  ];

  for (const path of possiblePaths) {
    if (existsSync(path)) {
      info(`Using installer: ${path}`);
      return path;
    }
  }

  error(
    'Installer script not found. Expected one of:\n  ' +
    possiblePaths.join('\n  ')
  );
}

/**
 * Run installer subprocess
 */
async function runInstaller(installerPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [installerPath, ...args], {
      stdio: ['inherit', 'inherit', 'inherit'],
      shell: process.platform === 'win32', // Use shell on Windows for proper TTY handling
    });

    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Installer exited with code ${code}`));
      }
    });

    child.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Main installer entry point
 */
async function main() {
  try {
    // Check Node.js version
    checkNodeVersion();

    // Find installer script
    const installerPath = findInstaller();

    // Get command-line arguments (skip "node" and "install.js")
    const args = process.argv.slice(2);

    info('Starting claude-mem installation...\n');

    // Run installer
    await runInstaller(installerPath, args);

    success('\n✅ claude-mem installation complete!');
    process.exit(0);
  } catch (err) {
    error(err.message || String(err));
  }
}

// Run installer
main().catch((err) => {
  error(err.message || String(err));
});
