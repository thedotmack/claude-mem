export const HOOK_TIMEOUTS = {
  DEFAULT: 300000,            // Standard HTTP timeout (5 minutes - designed to never timeout)
  HEALTH_CHECK: 30000,        // Worker health check (30 seconds - allow slow systems)
  WORKER_STARTUP_WAIT: 1000,  // Wait between startup retries (1 second - responsive polling)
  WORKER_STARTUP_RETRIES: 300, // Number of startup retries (300 retries * 1s = 5 min total)
  PRE_RESTART_SETTLE_DELAY: 2000,  // Give files time to sync before restart
  WINDOWS_MULTIPLIER: 1.5     // Platform-specific adjustment
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
