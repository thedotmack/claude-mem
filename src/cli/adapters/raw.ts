import type { PlatformAdapter, NormalizedHookInput, HookResult } from '../types.js';

// Raw adapter passes through with minimal transformation - useful for testing
export const rawAdapter: PlatformAdapter = {
  normalizeInput(raw) {
    const r = raw as any;
    return {
      sessionId: r.sessionId ?? r.session_id ?? 'unknown',
      cwd: r.cwd ?? process.cwd(),
      prompt: r.prompt,
      toolName: r.toolName ?? r.tool_name,
      toolInput: r.toolInput ?? r.tool_input,
      toolResponse: r.toolResponse ?? r.tool_response,
      transcriptPath: r.transcriptPath ?? r.transcript_path,
      filePath: r.filePath ?? r.file_path,
      edits: r.edits,
    };
  },
  formatOutput(result) {
    return result;
  }
};
