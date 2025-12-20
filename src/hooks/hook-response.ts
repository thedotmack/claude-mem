export type HookType = 'SessionStart' | 'UserPromptSubmit' | 'PostToolUse' | 'Stop';

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
 * Standard hook response for all hooks except SessionStart with context.
 * Tells Claude Code to continue processing and suppress the hook's output.
 */
export const STANDARD_HOOK_RESPONSE = JSON.stringify({
  continue: true,
  suppressOutput: true
});

/**
 * Creates a standardized hook response.
 *
 * For most hooks (UserPromptSubmit, PostToolUse, Stop), returns the standard response.
 * For SessionStart with context, includes hookSpecificOutput to inject context.
 */
export function createHookResponse(
  hookType: HookType,
  success: boolean,
  options: { context?: string } = {}
): string {
  // SessionStart with context is the only special case
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

  // All other cases use the standard response
  return STANDARD_HOOK_RESPONSE;
}
