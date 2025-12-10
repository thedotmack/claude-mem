export const HOOK_TIMEOUTS = {
  DEFAULT: 5000,              // Standard HTTP timeout (up from 2000ms)
  HEALTH_CHECK: 1000,         // Worker health check (up from 500ms)
  WORKER_STARTUP_WAIT: 1000,
  WORKER_STARTUP_RETRIES: 15,
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
