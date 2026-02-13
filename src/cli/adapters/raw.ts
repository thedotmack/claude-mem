import type { PlatformAdapter } from '../types.js';

// Raw adapter passes through with minimal transformation - useful for testing
export const rawAdapter: PlatformAdapter = {
  normalizeInput(raw) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const strOrUndef = (v: unknown): string | undefined => typeof v === 'string' ? v : undefined;
    return {
      sessionId: typeof r.sessionId === 'string' ? r.sessionId : (typeof r.session_id === 'string' ? r.session_id : 'unknown'),
      cwd: (strOrUndef(r.cwd)) ?? process.cwd(),
      prompt: strOrUndef(r.prompt),
      toolName: strOrUndef(r.toolName) ?? strOrUndef(r.tool_name),
      toolInput: r.toolInput ?? r.tool_input,
      toolResponse: r.toolResponse ?? r.tool_response,
      transcriptPath: strOrUndef(r.transcriptPath) ?? strOrUndef(r.transcript_path),
      filePath: strOrUndef(r.filePath) ?? strOrUndef(r.file_path),
      edits: Array.isArray(r.edits) ? (r.edits as unknown[]) : undefined,
    };
  },
  formatOutput(result) {
    return result;
  }
};
