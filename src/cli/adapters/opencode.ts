import type { PlatformAdapter } from '../types.js';

export const opencodeAdapter: PlatformAdapter = {
  normalizeInput(raw) {
    const r = (raw ?? {}) as any;
    return {
      sessionId: r.sessionId ?? r.session_id ?? r.id ?? r.conversation_id,
      cwd: r.cwd ?? r.directory ?? r.worktree ?? process.cwd(),
      prompt: r.prompt ?? r.query ?? r.input ?? r.message,
      toolName: r.toolName ?? r.tool_name ?? r.tool,
      toolInput: r.toolInput ?? r.tool_input ?? r.args,
      toolResponse: r.toolResponse ?? r.tool_response ?? r.result ?? r.output,
      transcriptPath: r.transcriptPath ?? r.transcript_path,
      filePath: r.filePath ?? r.file_path,
      edits: r.edits,
    };
  },
  formatOutput(result) {
    if (result.hookSpecificOutput) {
      const output: Record<string, unknown> = { hookSpecificOutput: result.hookSpecificOutput };
      if (result.systemMessage) output.systemMessage = result.systemMessage;
      return output;
    }

    const output: Record<string, unknown> = {
      continue: result.continue ?? true,
      suppressOutput: result.suppressOutput ?? true,
    };

    if (result.systemMessage) output.systemMessage = result.systemMessage;
    return output;
  }
};
