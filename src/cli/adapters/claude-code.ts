import type { PlatformAdapter, NormalizedHookInput, HookResult } from '../types.js';

// Maps Claude Code stdin format (session_id, cwd, tool_name, etc.)
// SessionStart hooks receive no stdin, so we must handle undefined input gracefully
export const claudeCodeAdapter: PlatformAdapter = {
  normalizeInput(raw) {
    const r = (raw ?? {}) as any;
    return {
      sessionId: r.session_id ?? r.id ?? r.sessionId,
      cwd: r.cwd ?? process.cwd(),
      prompt: r.prompt,
      toolName: r.tool_name,
      toolInput: r.tool_input,
      toolResponse: r.tool_response,
      transcriptPath: r.transcript_path,
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
    // Return only fields from the Claude Code hook contract.
    // Stop hooks validate against {decision?, reason?, systemMessage?} and reject
    // unrecognized fields like `continue` or `suppressOutput` with
    // "JSON validation failed". An empty object is valid for all hook types.
    const output: Record<string, unknown> = {};
    if (result.systemMessage) {
      output.systemMessage = result.systemMessage;
    }
    return output;
  }
};
