/**
 * Runtime Launcher Script
 *
 * This script selects the appropriate runtime (Bun or Node.js) and
 * executes the target script with it. It's used by hooks.json to
 * dynamically choose the runtime.
 *
 * Usage: node run.js <script-path> [args...]
 *
 * Runtime selection priority:
 * 1. CLAUDE_MEM_RUNTIME environment variable
 * 2. Settings file at ~/.claude-mem/settings.json
 * 3. Default to Node.js (user must explicitly configure Bun)
 *
 * Note: This logic is intentionally duplicated from src/shared/runtime.ts
 * because this launcher must execute before TypeScript utilities are compiled.
 */

import { execSync, spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/**
 * Check if Bun is available
 */
function isBunAvailable() {
  try {
    execSync('bun --version', { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get configured runtime from environment or settings
 */
function getConfiguredRuntime() {
  // Environment variable has highest priority
  const envRuntime = process.env.CLAUDE_MEM_RUNTIME;
  if (envRuntime === 'bun' || envRuntime === 'node') {
    return envRuntime;
  }

  // Check settings file
  const settingsPath = join(homedir(), '.claude-mem', 'settings.json');
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      const runtime = settings.env?.CLAUDE_MEM_RUNTIME;
      if (runtime === 'bun' || runtime === 'node') {
        return runtime;
      }
    } catch {
      // Ignore read errors
    }
  }

  return undefined;
}

/**
 * Select the runtime to use
 */
function selectRuntime() {
  const configured = getConfiguredRuntime();

  if (configured === 'bun' && isBunAvailable()) {
    return 'bun';
  }

  if (configured === 'node') {
    return 'node';
  }

  // Default to Node.js (no auto-detection)
  // This ensures consistency with ecosystem.config.cjs and src/shared/runtime.ts
  return 'node';
}

// Main execution
const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node run.js <script-path> [args...]');
  process.exit(1);
}

const runtime = selectRuntime();
const scriptPath = args[0];
const scriptArgs = args.slice(1);

// Spawn the script with the selected runtime
const child = spawn(runtime, [scriptPath, ...scriptArgs], {
  stdio: 'inherit',
  env: process.env
});

child.on('error', (err) => {
  console.error(`Failed to start ${runtime}: ${err.message}`);
  process.exit(1);
});

child.on('close', (code) => {
  process.exit(code ?? 0);
});
