import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';

/**
 * Runtime detection and selection utilities
 * 
 * Allows claude-mem to run on either Node.js or Bun runtime.
 * Users can configure their preferred runtime via:
 * 1. CLAUDE_MEM_RUNTIME environment variable ('bun' or 'node')
 * 2. Settings file at ~/.claude-mem/settings.json (runtime field)
 * 
 * Benefits of Bun:
 * - Faster startup and execution
 * - Built-in bun:sqlite (no native module compilation needed)
 * - Better memory efficiency
 */

export type Runtime = 'node' | 'bun';

/**
 * Check if Bun is available on the system
 */
export function isBunAvailable(): boolean {
  try {
    execSync('bun --version', { stdio: 'ignore', encoding: 'utf8', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if Node.js is available on the system
 */
export function isNodeAvailable(): boolean {
  try {
    execSync('node --version', { stdio: 'ignore', encoding: 'utf8', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the user's configured runtime preference from settings
 */
export function getConfiguredRuntime(): Runtime | undefined {
  // Check environment variable first (highest priority)
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
      // Ignore settings read errors
    }
  }

  return undefined;
}

/**
 * Detect the current runtime
 * Returns 'bun' if running under Bun, 'node' if running under Node.js
 */
export function detectCurrentRuntime(): Runtime {
  // Bun sets the Bun global
  if (typeof (globalThis as any).Bun !== 'undefined') {
    return 'bun';
  }
  return 'node';
}

/**
 * Get the runtime command to use for executing scripts
 *
 * Priority:
 * 1. CLAUDE_MEM_RUNTIME environment variable
 * 2. Settings file configuration
 * 3. Default to Node.js (user must explicitly configure Bun)
 */
export function getRuntime(): Runtime {
  // Check configured preference
  const configured = getConfiguredRuntime();
  if (configured) {
    // Verify the configured runtime is available
    if (configured === 'bun' && isBunAvailable()) {
      return 'bun';
    }
    if (configured === 'node' && isNodeAvailable()) {
      return 'node';
    }
    // Fall through if configured runtime not available
  }

  // Default to Node.js (no auto-detection)
  // This ensures consistency with ecosystem.config.cjs and matches the documented behavior
  return 'node';
}

/**
 * Get runtime command with full path if needed
 */
export function getRuntimeCommand(): string {
  return getRuntime();
}

/**
 * Check if we're running under the expected runtime
 * Useful for runtime-specific code paths
 */
export function isRunningBun(): boolean {
  return detectCurrentRuntime() === 'bun';
}

/**
 * Check if we're running under Node.js
 */
export function isRunningNode(): boolean {
  return detectCurrentRuntime() === 'node';
}
