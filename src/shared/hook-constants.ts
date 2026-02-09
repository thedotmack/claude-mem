export const HOOK_TIMEOUTS = {
  DEFAULT: 300000,            // Standard HTTP timeout (5 min for slow systems)
  HEALTH_CHECK: 30000,        // Worker health check (30s for slow systems)
  WORKER_STARTUP_WAIT: 1000,
  WORKER_STARTUP_RETRIES: 300,
  PRE_RESTART_SETTLE_DELAY: 2000,  // Give files time to sync before restart
  POWERSHELL_COMMAND: 10000,     // PowerShell process enumeration (10s - typically completes in <1s)
  WINDOWS_MULTIPLIER: 1.5     // Platform-specific adjustment
} as const;

/**
 * Hook exit codes for Claude Code
 *
 * Exit code behavior per Claude Code docs:
 * - 0: Success. For SessionStart/UserPromptSubmit, stdout added to context.
 * - 2: Blocking error. For SessionStart, stderr shown to user only.
 * - Other non-zero: stderr shown in verbose mode only.
 */
export const HOOK_EXIT_CODES = {
  SUCCESS: 0,
  FAILURE: 1,
  /** Blocking error - for SessionStart, shows stderr to user only */
  BLOCKING_ERROR: 2,
  /** Show stderr to user only, don't inject into context. Used by user-message handler (Cursor). */
  USER_MESSAGE_ONLY: 3,
} as const;

export function getTimeout(baseTimeout: number): number {
  return process.platform === 'win32'
    ? Math.round(baseTimeout * HOOK_TIMEOUTS.WINDOWS_MULTIPLIER)
    : baseTimeout;
}
