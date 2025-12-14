#!/usr/bin/env node
/**
 * Bun Hook Wrapper
 * 
 * Resolves the Bun executable path and executes the target script.
 * This allows hooks to work in environments where Bun is not in /bin/sh PATH
 * (e.g., fish shell users).
 * 
 * Usage: node bun-wrapper.js <script.js> [args...]
 */

const { spawnSync } = require('child_process');
const { existsSync } = require('fs');
const { join } = require('path');
const { homedir } = require('os');

/**
 * Get the Bun executable path
 */
function getBunPath() {
  const isWindows = process.platform === 'win32';

  // Try PATH first
  try {
    const result = spawnSync('bun', ['--version'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: isWindows
    });
    if (result.status === 0) {
      return 'bun';
    }
  } catch {
    // Not in PATH
  }

  // Check common installation paths
  const bunPaths = isWindows
    ? [join(homedir(), '.bun', 'bin', 'bun.exe')]
    : [
        join(homedir(), '.bun', 'bin', 'bun'),
        '/usr/local/bin/bun',
        '/opt/homebrew/bin/bun',
        '/home/linuxbrew/.linuxbrew/bin/bun'
      ];

  for (const bunPath of bunPaths) {
    if (existsSync(bunPath)) {
      return bunPath;
    }
  }

  return null;
}

// Main execution
const bunPath = getBunPath();

if (!bunPath) {
  const isWindows = process.platform === 'win32';
  const installCmd = isWindows
    ? 'powershell -c "irm bun.sh/install.ps1 | iex"'
    : 'curl -fsSL https://bun.sh/install | bash';
  console.error(`Error: Bun is required but not found.`);
  console.error(`Install it with: ${installCmd}`);
  console.error(`Then restart your terminal.`);
  process.exit(1);
}

// Get the script to run from arguments
const [,, scriptPath, ...scriptArgs] = process.argv;

if (!scriptPath) {
  console.error('Usage: node bun-wrapper.js <script.js> [args...]');
  process.exit(1);
}

// Execute the script with bun
const result = spawnSync(bunPath, [scriptPath, ...scriptArgs], {
  stdio: 'inherit',
  shell: false
});

process.exit(result.status || 0);
