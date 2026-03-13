import type { PlatformAdapter, NormalizedHookInput, HookResult } from '../types.js';

/**
 * Droid CLI (Factory) platform adapter.
 *
 * Droid uses the same snake_case stdin format as Claude Code but includes
 * additional fields: permission_mode, hook_event_name, source, reason,
 * stop_hook_active. Uses DROID_PLUGIN_ROOT / FACTORY_PROJECT_DIR env vars.
 */
export const droidAdapter: PlatformAdapter = {
  normalizeInput(raw) {
    const r = (raw ?? {}) as any;
    return {
      sessionId: r.session_id ?? r.id ?? r.sessionId,
      cwd: r.cwd ?? process.cwd(),
      platform: 'droid',
      prompt: r.prompt,
      toolName: r.tool_name,
      toolInput: r.tool_input,
      toolResponse: r.tool_response,
      transcriptPath: r.transcript_path,
      // Droid-specific fields
      permissionMode: r.permission_mode,
      hookEventName: r.hook_event_name,
      source: r.source,
      reason: r.reason,
      stopHookActive: r.stop_hook_active,
    };
  },
  formatOutput(result) {
    if (result.hookSpecificOutput) {
      const output: Record<string, unknown> = { hookSpecificOutput: result.hookSpecificOutput };
      if (result.systemMessage) {
        output.systemMessage = result.systemMessage;
      }
      return output;
    }
    return { continue: result.continue ?? true, suppressOutput: result.suppressOutput ?? true };
  }
};
