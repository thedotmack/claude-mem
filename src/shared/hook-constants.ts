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

export const HOOK_EXIT_CODES = {
  SUCCESS: 0,
  BLOCKING_ERROR: 2,
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
 * When set, observation / file-context exit 0 before worker start or stdin
 * work so Windows users can stop the focus-stealing console flash without
 * editing shipped hooks.json (which schema validation now rejects for
 * renamed keys). SessionStart / UserPromptSubmit / Stop stay active.
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

export function getTimeout(baseTimeout: number): number {
  return process.platform === 'win32'
    ? Math.round(baseTimeout * HOOK_TIMEOUTS.WINDOWS_MULTIPLIER)
    : baseTimeout;
}
