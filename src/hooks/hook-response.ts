export type HookType = 'SessionStart' | 'UserPromptSubmit' | 'PostToolUse' | 'Stop';

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

/**
 * Creates a standardized hook response.
 * All hooks return the same basic response, with optional context injection for SessionStart.
 */
export function createHookResponse(
  hookType: HookType,
  success: boolean,
  options: HookResponseOptions = {}
): string {
  if (hookType === 'SessionStart' && success && options.context) {
    return JSON.stringify({
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: options.context
      }
    });
  }

  return JSON.stringify({ continue: true, suppressOutput: true });
}
