export const HOOK_TIMEOUTS = {
  DEFAULT: 300000,            // Standard HTTP timeout (5 min for slow systems)
  HEALTH_CHECK: 3000,         // Worker health check (3s — healthy worker responds in <100ms)
  POST_SPAWN_WAIT: 15000,     // Wait for daemon to start after spawn (starts in <1s on Linux, 6-8s on macOS with Chroma)
  READINESS_WAIT: 30000,      // Wait for DB + search init after spawn (typically <5s)
  PORT_IN_USE_WAIT: 3000,     // Wait when port occupied but health failing
  WORKER_STARTUP_WAIT: 1000,
  PRE_RESTART_SETTLE_DELAY: 2000,  // Give files time to sync before restart
  POWERSHELL_COMMAND: 10000,     // PowerShell process enumeration (10s - typically completes in <1s)
  WINDOWS_MULTIPLIER: 1.5     
} as const;

export const HOOK_EXIT_CODES = {
  SUCCESS: 0,
  FAILURE: 1,
  BLOCKING_ERROR: 2,
  USER_MESSAGE_ONLY: 3,
} as const;

export function getTimeout(baseTimeout: number): number {
  return process.platform === 'win32'
    ? Math.round(baseTimeout * HOOK_TIMEOUTS.WINDOWS_MULTIPLIER)
    : baseTimeout;
}
