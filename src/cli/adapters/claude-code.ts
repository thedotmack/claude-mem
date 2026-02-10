import type { PlatformAdapter, NormalizedHookInput, HookResult } from '../types.js';

// Maps Claude Code stdin format (session_id, cwd, tool_name, etc.)
// SessionStart hooks receive no stdin, so we must handle undefined input gracefully
export const claudeCodeAdapter: PlatformAdapter = {
  normalizeInput(raw) {
    const r = (raw ?? {}) as any;
    return {
      sessionId: r.session_id,
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
      return { hookSpecificOutput: result.hookSpecificOutput };
    }

    // Issue #987: Only include `continue` field when explicitly set by the handler.
    // Stop hooks (summarize, session-complete) intentionally omit `continue` to
    // prevent Claude Code from interpreting the response as "continue the conversation,"
    // which causes infinite session loops.
    const output: Record<string, unknown> = {
      suppressOutput: result.suppressOutput ?? true
    };
    if (result.continue !== undefined) {
      output.continue = result.continue;
    }
    return output;
  }
};
