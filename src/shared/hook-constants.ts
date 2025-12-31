export const HOOK_TIMEOUTS = {
  DEFAULT: 300000,            // Standard HTTP timeout (5 min for slow systems)
  HEALTH_CHECK: 30000,        // Worker health check (30s for slow systems)
  WORKER_STARTUP_WAIT: 1000,
  WORKER_STARTUP_RETRIES: 300,
  PRE_RESTART_SETTLE_DELAY: 2000,  // Give files time to sync before restart
  WINDOWS_MULTIPLIER: 1.5     // Platform-specific adjustment
} as const;

/**
 * Hook exit codes for Claude Code
 */
export const HOOK_EXIT_CODES = {
  SUCCESS: 0,
  FAILURE: 1,
  /**
   * @deprecated Exit code 3 is not documented in Claude Code's hooks API.
   * Use SUCCESS (0) with stdout for informational messages instead.
   * See: https://docs.anthropic.com/en/docs/claude-code/hooks
   */
  USER_MESSAGE_ONLY: 3,
} as const;

export function getTimeout(baseTimeout: number): number {
  return process.platform === 'win32'
    ? Math.round(baseTimeout * HOOK_TIMEOUTS.WINDOWS_MULTIPLIER)
    : baseTimeout;
}
