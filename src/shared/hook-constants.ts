export const HOOK_TIMEOUTS = {
  DEFAULT: 5000,              // Standard HTTP timeout (up from 2000ms)
  HEALTH_CHECK: 1000,         // Worker health check (up from 500ms)
  WORKER_STARTUP_WAIT: 1000,
  WORKER_STARTUP_RETRIES: 15,
  PRE_RESTART_SETTLE_DELAY: 2000,  // Give files time to sync before restart
  WINDOWS_MULTIPLIER: 1.5     // Platform-specific adjustment
} as const;

/**
 * Hook exit codes for Claude Code
 * See: https://code.claude.com/docs/en/hooks.md
 */
export const HOOK_EXIT_CODES = {
  /** Success - stdout shown in verbose mode, or added to context for SessionStart/UserPromptSubmit */
  SUCCESS: 0,
  /** Non-blocking error - stderr shown in verbose mode, execution continues */
  FAILURE: 1,
  /** Blocking error - stderr fed back to Claude, may block operations */
  BLOCKING_ERROR: 2,
} as const;

export function getTimeout(baseTimeout: number): number {
  return process.platform === 'win32'
    ? Math.round(baseTimeout * HOOK_TIMEOUTS.WINDOWS_MULTIPLIER)
    : baseTimeout;
}
