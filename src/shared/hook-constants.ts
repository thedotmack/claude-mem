export const HOOK_TIMEOUTS = {
  HEALTH_CHECK: 3000,         // Worker health check (3s — healthy worker responds in <100ms)
  API_REQUEST: 30000,         // Hook API calls should outlive health probes but stay below hook caps
  HOOK_READINESS_WAIT: 10000, // Per-hook wait for an already-starting worker to finish DB/search init
  POST_SPAWN_WAIT: 15000,     // Wait for daemon to start after spawn (starts in <1s on Linux, 6-8s on macOS with Chroma)
  READINESS_WAIT: 30000,      // Wait for DB + search init after spawn (typically <5s)
  PORT_IN_USE_WAIT: 3000,     // Wait when port occupied but health failing
  POWERSHELL_COMMAND: 10000,     // PowerShell process enumeration (10s - typically completes in <1s)
  WINDOWS_MULTIPLIER: 1.5
} as const;

/**
 * Seconds a worker must have been up before a silent or never-ready worker may
 * be treated as WEDGED (recycled by the hook, or reclaimed by a launcher)
 * instead of still booting. Override with CLAUDE_MEM_WEDGED_WORKER_UPTIME_S.
 */
export const WEDGED_WORKER_UPTIME_DEFAULT_S = 300;
export const WEDGED_WORKER_UPTIME_BOUNDS_S = { min: 60, max: 86400 } as const;

/** CLAUDE_MEM_WEDGED_WORKER_UPTIME_S when valid, else the default. Never throws. */
export function readWedgedWorkerUptimeSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env.CLAUDE_MEM_WEDGED_WORKER_UPTIME_S ?? '', 10);
  return Number.isFinite(parsed)
    && parsed >= WEDGED_WORKER_UPTIME_BOUNDS_S.min
    && parsed <= WEDGED_WORKER_UPTIME_BOUNDS_S.max
    ? parsed
    : WEDGED_WORKER_UPTIME_DEFAULT_S;
}

export const HOOK_EXIT_CODES = {
  SUCCESS: 0,
  BLOCKING_ERROR: 2,
} as const;

export function getTimeout(baseTimeout: number): number {
  return process.platform === 'win32'
    ? Math.round(baseTimeout * HOOK_TIMEOUTS.WINDOWS_MULTIPLIER)
    : baseTimeout;
}
