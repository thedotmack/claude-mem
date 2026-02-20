#!/usr/bin/env node
/**
 * Bun Runner - Finds and executes Bun even when not in PATH
 *
 * This script solves the fresh install problem where:
 * 1. smart-install.js installs Bun to ~/.bun/bin/bun
 * 2. But Bun isn't in PATH until terminal restart
 * 3. Subsequent hooks fail because they can't find `bun`
 *
 * Usage: node bun-runner.js <script> [args...]
 *
 * Fixes #818: Worker fails to start on fresh install
 */
import { spawnSync, spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const IS_WINDOWS = process.platform === 'win32';

/**
 * Find Bun executable - checks PATH first, then common install locations
 */
function findBun() {
  // Try PATH first
  const pathCheck = spawnSync(IS_WINDOWS ? 'where' : 'which', ['bun'], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: IS_WINDOWS
  });

  if (pathCheck.status === 0 && pathCheck.stdout.trim()) {
    return 'bun'; // Found in PATH
  }

  // Check common installation paths (handles fresh installs before PATH reload)
  // Windows: Bun installs to ~/.bun/bin/bun.exe (same as smart-install.js)
  // Unix: Check default location plus common package manager paths
  const bunPaths = IS_WINDOWS
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

// Get args: node bun-runner.js <script> [args...]
const args = process.argv.slice(2);

if (args.length === 0) {
  console.error('Usage: node bun-runner.js <script> [args...]');
  process.exit(1);
}

const bunPath = findBun();

if (!bunPath) {
  console.error('Error: Bun not found. Please install Bun: https://bun.sh');
  console.error('After installation, restart your terminal.');
  process.exit(1);
}

// Fix #646: Buffer stdin in Node.js before passing to Bun.
// On Linux, Bun's libuv calls fstat() on inherited pipe fds and crashes with
// EINVAL when the pipe comes from Claude Code's hook system. By reading stdin
// in Node.js first and writing it to a fresh pipe, Bun receives a normal pipe
// that it can fstat() without errors.
function collectStdin() {
  return new Promise((resolve) => {
    // If stdin is a TTY (interactive), there's no piped data to collect
    if (process.stdin.isTTY) {
      resolve(null);
      return;
    }

    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => {
      resolve(chunks.length > 0 ? Buffer.concat(chunks) : null);
    });
    process.stdin.on('error', () => {
      // stdin may not be readable (e.g. already closed), treat as no data
      resolve(null);
    });

    // Safety: if no data arrives within 5s, proceed without stdin
    setTimeout(() => {
      process.stdin.removeAllListeners();
      process.stdin.pause();
      resolve(chunks.length > 0 ? Buffer.concat(chunks) : null);
    }, 5000);
  });
}

const stdinData = await collectStdin();

// Spawn Bun with the provided script and args
// Use spawn (not spawnSync) to properly handle stdio
// Note: Don't use shell mode on Windows - it breaks paths with spaces in usernames
// Use windowsHide to prevent a visible console window from spawning on Windows
const child = spawn(bunPath, args, {
  stdio: [stdinData ? 'pipe' : 'ignore', 'inherit', 'inherit'],
  windowsHide: true,
  env: process.env
});

// Write buffered stdin to child's pipe, then close it so the child sees EOF
if (stdinData && child.stdin) {
  child.stdin.write(stdinData);
  child.stdin.end();
}

child.on('error', (err) => {
  console.error(`Failed to start Bun: ${err.message}`);
  process.exit(1);
});

child.on('close', (code) => {
  process.exit(code || 0);
});
