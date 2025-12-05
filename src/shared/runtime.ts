import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';

export type Runtime = 'node' | 'bun';

/**
 * Check if Bun is available on the system
 */
export function isBunAvailable(): boolean {
  try {
    execSync('bun --version', { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get user's configured runtime from env var or settings file
 */
export function getConfiguredRuntime(): Runtime | undefined {
  const envRuntime = process.env.CLAUDE_MEM_RUNTIME;
  if (envRuntime === 'bun' || envRuntime === 'node') {
    return envRuntime;
  }

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
 * Get the runtime to use for executing scripts
 * Priority: env var > settings file > default to node
 */
export function getRuntime(): Runtime {
  const configured = getConfiguredRuntime();
  if (configured === 'bun' && isBunAvailable()) {
    return 'bun';
  }
  return 'node';
}

/**
 * Check if currently running under Bun
 */
export function isRunningBun(): boolean {
  return typeof (globalThis as any).Bun !== 'undefined';
}
