/**
 * Claude Code's UserPromptSubmit timeout, the `timeout` (in seconds) of that
 * hook in plugin/hooks/hooks.json; a test pins the two together. The
 * session-init budget is derived from it (defaultSessionInitRequestTimeoutMs).
 */
const SESSION_INIT_HOOK_CAP_MS = 15_000;

export const HOOK_TIMEOUTS = {
  HEALTH_CHECK: 3000,         // Worker health check (3s — healthy worker responds in <100ms)
  API_REQUEST: 30000,         // Hook API calls should outlive health probes but stay below hook caps
  SESSION_INIT_HOOK_CAP: SESSION_INIT_HOOK_CAP_MS,
  SESSION_INIT_REQUEST: 10000, // POSIX default for the whole session-init round-trip (plan-17 step 3): the cap minus the hook's own overhead; never Windows-scaled up
  SESSION_INIT_REQUEST_MAX: SESSION_INIT_HOOK_CAP_MS - 1000, // Upper bound for CLAUDE_MEM_SESSION_INIT_TIMEOUT_MS: process-exit margin below the cap
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

// Hooks only ever exit 0: Claude Code reads exit 2 as "block", and a
// claude-mem failure must never block the user (plan-17 step 2).
export const HOOK_EXIT_CODES = {
  SUCCESS: 0,
} as const;

/** High-frequency tool hooks that fire on nearly every Claude Code action. */
export const TOOL_HOOK_EVENTS = ['observation', 'file-context'] as const;
export type ToolHookEvent = (typeof TOOL_HOOK_EVENTS)[number];

function isEnvFlagOn(value: string | undefined): boolean {
  return value === '1';
}

/**
 * Opt-out gate for PreToolUse / PostToolUse hooks (#3106).
 *
 * When set, observation / file-context exit 0 in hookCommand before any stdin
 * or worker work, so users can turn off tool-call capture without editing the
 * shipped hooks.json. It does not stop the hook process from starting: Claude
 * Code still spawns the on-PATH `claude-mem` launcher (exec form, no shell,
 * #3605), which runs worker-service.cjs before this check. SessionStart /
 * UserPromptSubmit / Stop stay active.
 *
 * - CLAUDE_MEM_DISABLE_TOOL_HOOKS=1 — both tool hooks
 * - CLAUDE_MEM_DISABLE_OBSERVATION=1 — PostToolUse observation only
 * - CLAUDE_MEM_DISABLE_FILE_CONTEXT=1 — PreToolUse file-context only
 */
export function isToolHookDisabledByEnv(
  event: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!(TOOL_HOOK_EVENTS as readonly string[]).includes(event)) {
    return false;
  }
  if (isEnvFlagOn(env.CLAUDE_MEM_DISABLE_TOOL_HOOKS)) {
    return true;
  }
  if (event === 'observation' && isEnvFlagOn(env.CLAUDE_MEM_DISABLE_OBSERVATION)) {
    return true;
  }
  if (event === 'file-context' && isEnvFlagOn(env.CLAUDE_MEM_DISABLE_FILE_CONTEXT)) {
    return true;
  }
  return false;
}

/**
 * Time a hook spends outside its handler but inside the host's limit: the
 * shell prelude, node bun-runner, bun start-up and the bundle load before it
 * (4-5 s on Windows, where process creation and antivirus scans are slow);
 * the outage notice, stdout and exit after it. A handler's budget is the
 * host's limit minus this, because the budget's clock starts in the handler.
 */
export function hookProcessOverheadMs(platform: NodeJS.Platform = process.platform): number {
  return platform === 'win32' ? 8_000 : 5_000;
}

/**
 * The default UserPromptSubmit session-init budget for `platform`: the 15 s
 * cap minus the hook's own overhead, so 10 s, or 7 s on Windows (the old flat
 * 10 s ran Windows hooks into Claude Code's kill).
 */
export function defaultSessionInitRequestTimeoutMs(platform: NodeJS.Platform = process.platform): number {
  return HOOK_TIMEOUTS.SESSION_INIT_HOOK_CAP - hookProcessOverheadMs(platform);
}

/**
 * The longest session-init budget that still ends the hook under the cap. On
 * Windows the hook's overhead leaves exactly the default, so any longer value
 * (a settings.json seeded with the old flat 10 s default, or a user override)
 * is cut to it. Elsewhere start-up is well under a second, so overrides up to
 * SESSION_INIT_REQUEST_MAX still fit.
 */
export function maxSessionInitRequestTimeoutMs(platform: NodeJS.Platform = process.platform): number {
  return platform === 'win32' ? defaultSessionInitRequestTimeoutMs(platform) : HOOK_TIMEOUTS.SESSION_INIT_REQUEST_MAX;
}

export function getTimeout(baseTimeout: number): number {
  return process.platform === 'win32'
    ? Math.round(baseTimeout * HOOK_TIMEOUTS.WINDOWS_MULTIPLIER)
    : baseTimeout;
}
