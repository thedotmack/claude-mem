export const HOOK_TIMEOUTS = {
  DEFAULT: 5000,              // Standard HTTP timeout (up from 2000ms)
  HEALTH_CHECK: 2000,         // Worker readiness check (increased from 1000ms for Windows)
  WORKER_STARTUP_WAIT: 1000,
  WORKER_STARTUP_RETRIES: 25, // Increased from 15 for Windows startup
  PRE_RESTART_SETTLE_DELAY: 2000,  // Give files time to sync before restart
  WINDOWS_MULTIPLIER: 2.0,    // Platform-specific adjustment (increased from 1.5x)
  MCP_INIT_TIMEOUT_MS: 15000  // Timeout for MCP connection initialization
} as const;

/**
 * Hook exit codes for Claude Code
 */
export const HOOK_EXIT_CODES = {
  SUCCESS: 0,
  FAILURE: 1,
  /** Show user message that Claude does NOT receive as context */
  USER_MESSAGE_ONLY: 3,
} as const;

export function getTimeout(baseTimeout: number): number {
  return process.platform === 'win32'
    ? Math.round(baseTimeout * HOOK_TIMEOUTS.WINDOWS_MULTIPLIER)
    : baseTimeout;
}
