#!/usr/bin/env node
/**
 * Bun Wrapper - Finds and executes Bun even if not in PATH
 * 
 * This wrapper solves the issue where smart-install.js successfully installs Bun
 * but it's not yet available in PATH for subsequent hooks in the same session.
 * 
 * Usage: node bun-wrapper.js <script> <args...>
 */

import { existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';

const IS_WINDOWS = process.platform === 'win32';

/**
 * Get the Bun executable path (from PATH or common install locations)
 */
function getBunPath() {
  // Try PATH first
  try {
    const result = spawnSync('bun', ['--version'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: IS_WINDOWS
    });
    if (result.status === 0) return 'bun';
  } catch {
    // Not in PATH
  }

  // Check common installation paths (handles fresh installs before PATH reload)
  const bunPaths = IS_WINDOWS
    ? [join(homedir(), '.bun', 'bin', 'bun.exe')]
    : [join(homedir(), '.bun', 'bin', 'bun'), '/usr/local/bin/bun', '/opt/homebrew/bin/bun'];

  for (const bunPath of bunPaths) {
    if (existsSync(bunPath)) {
      return bunPath;
    }
  }

  return null;
}

// Get Bun path
const bunPath = getBunPath();

if (!bunPath) {
  console.error('');
  console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.error('⚠️  Bun Runtime Not Found');
  console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.error('');
  console.error('The claude-mem plugin requires Bun to run.');
  console.error('');
  console.error('If you just installed the plugin, Bun may have been');
  console.error('installed but is not yet in your current shell PATH.');
  console.error('');
  console.error('📋 Next Steps:');
  console.error('');
  console.error('1. Restart your terminal/IDE completely');
  console.error('2. Try again');
  console.error('');
  console.error('If the issue persists, install Bun manually:');
  console.error('');
  if (IS_WINDOWS) {
    console.error('   winget install Oven-sh.Bun');
    console.error('   Or: powershell -c "irm bun.sh/install.ps1 | iex"');
  } else {
    console.error('   curl -fsSL https://bun.sh/install | bash');
    console.error('   Or: brew install oven-sh/bun/bun');
  }
  console.error('');
  console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.error('');
  process.exit(1);
}

// Get the script and args to execute
const [,, script, ...args] = process.argv;

if (!script) {
  console.error('Usage: bun-wrapper.js <script> <args...>');
  process.exit(1);
}

// Execute the script with Bun
const result = spawnSync(bunPath, [script, ...args], {
  stdio: 'inherit',
  shell: IS_WINDOWS
});

process.exit(result.status || 0);
