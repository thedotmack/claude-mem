export type HookType = 'PreCompact' | 'SessionStart' | 'UserPromptSubmit' | 'PostToolUse' | 'Stop' | string;

export interface HookResponseOptions {
  reason?: string;
  context?: string;
}

export interface HookResponse {
  continue?: boolean;
  suppressOutput?: boolean;
  stopReason?: string;
  hookSpecificOutput?: {
    hookEventName: 'SessionStart';
    additionalContext: string;
  };
}

function buildHookResponse(
  hookType: HookType,
  success: boolean,
  options: HookResponseOptions
): HookResponse {
  if (hookType === 'PreCompact') {
    if (success) {
      return {
        continue: true,
        suppressOutput: true
      };
    }

    return {
      continue: false,
      stopReason: options.reason || 'Pre-compact operation failed',
      suppressOutput: true
    };
  }

  if (hookType === 'SessionStart') {
    if (success && options.context) {
      return {
        continue: true,
        suppressOutput: true,
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: options.context
        }
      };
    }

    return {
      continue: true,
      suppressOutput: true
    };
  }

  if (hookType === 'UserPromptSubmit' || hookType === 'PostToolUse') {
    return {
      continue: true,
      suppressOutput: true
    };
  }

  if (hookType === 'Stop') {
    return {
      continue: true,
      suppressOutput: true
    };
  }

  return {
    continue: success,
    suppressOutput: true,
    ...(options.reason && !success ? { stopReason: options.reason } : {})
  };
}

/**
 * Creates a standardized hook response using the HookTemplates system.
 */
export function createHookResponse(
  hookType: HookType,
  success: boolean,
  options: HookResponseOptions = {}
): string {
  const response = buildHookResponse(hookType, success, options);
  return JSON.stringify(response);
}
