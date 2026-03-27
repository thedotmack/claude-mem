export const HOOK_TIMEOUTS = {
  DEFAULT: 300000, // Standard HTTP timeout (5 min for slow systems)
  HEALTH_CHECK: 3000, // Worker health check (3s — healthy worker responds in <100ms)
  POST_SPAWN_WAIT: 5000, // Wait for daemon to start after spawn (starts in <1s on Linux)
  READINESS_WAIT: 30000, // Wait for DB + search init after spawn (typically <5s)
  PORT_IN_USE_WAIT: 3000, // Wait when port occupied but health failing
  WORKER_STARTUP_WAIT: 1000,
  PRE_RESTART_SETTLE_DELAY: 2000, // Give files time to sync before restart
  POWERSHELL_COMMAND: 10000, // PowerShell process enumeration (10s - typically completes in <1s)
  WINDOWS_MULTIPLIER: 1.5, // Platform-specific adjustment for hook-side operations
} as const;

/**
 * Hook exit codes for Claude Code
 *
 * Exit code behavior per Claude Code docs:
 * - 0: Success. For SessionStart/UserPromptSubmit, stdout added to context.
 * - 2: Blocking error. For SessionStart, stderr shown to user only.
 * - Other non-zero: treated as hook error (stderr shown in verbose mode only).
 *
 * IMPORTANT: Only exit codes 0 and 2 are recognized by Claude Code.
 * Any other non-zero exit code (including 1, 3, etc.) is treated as a
 * hook failure and triggers the "hook error" UI message on every session start.
 */
export const HOOK_EXIT_CODES = {
  SUCCESS: 0,
  FAILURE: 1,
  /** Blocking error - for SessionStart, shows stderr to user only */
  BLOCKING_ERROR: 2,
} as const;

export function getTimeout(baseTimeout: number): number {
  return process.platform === "win32"
    ? Math.round(baseTimeout * HOOK_TIMEOUTS.WINDOWS_MULTIPLIER)
    : baseTimeout;
}
