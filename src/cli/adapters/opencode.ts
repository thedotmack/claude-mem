import type { PlatformAdapter, NormalizedHookInput, HookResult } from '../types.js';

// OpenCode platform adapter for claude-mem
// Follows the pattern from raw.ts with OpenCode-specific field mappings
// OpenCode uses sessionID (camelCase), but we handle variants for robustness
export const opencodeAdapter: PlatformAdapter = {
  normalizeInput(raw: unknown): NormalizedHookInput {
    const r = (raw ?? {}) as Record<string, unknown>;
    return {
      sessionId: (r.sessionId ?? r.sessionID ?? r.session_id ?? 'unknown') as string,
      cwd: (r.cwd ?? r.directory ?? process.cwd()) as string,
      prompt: r.prompt as string | undefined,
      toolName: r.toolName as string | undefined,
      toolInput: r.toolInput,
      toolResponse: r.toolResponse ?? r.toolOutput,
      // OpenCode doesn't provide transcriptPath
    };
  },
  formatOutput(result: HookResult): unknown {
    // OpenCode expects simpler response like Cursor
    if (result.hookSpecificOutput) {
      return { context: result.hookSpecificOutput.additionalContext };
    }
    return { continue: result.continue ?? true };
  }
};
