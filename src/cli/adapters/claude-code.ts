import type { PlatformAdapter } from '../types.js';

// Maps Claude Code stdin format (session_id, cwd, tool_name, etc.)
// SessionStart hooks receive no stdin, so we must handle undefined input gracefully
export const claudeCodeAdapter: PlatformAdapter = {
  normalizeInput(raw) {
    const r = (raw ?? {}) as Record<string, unknown>;
    return {
      sessionId: typeof r.session_id === 'string' ? r.session_id : '',
      cwd: (typeof r.cwd === 'string' ? r.cwd : undefined) ?? process.cwd(),
      prompt: typeof r.prompt === 'string' ? r.prompt : undefined,
      toolName: typeof r.tool_name === 'string' ? r.tool_name : undefined,
      toolInput: r.tool_input,
      toolResponse: r.tool_response,
      transcriptPath: typeof r.transcript_path === 'string' ? r.transcript_path : undefined,
    };
  },
  formatOutput(result) {
    if (result.hookSpecificOutput) {
      return { hookSpecificOutput: result.hookSpecificOutput };
    }
    return { continue: result.continue ?? true, suppressOutput: result.suppressOutput ?? true };
  }
};
