import type { PlatformAdapter } from '../types.js';

// Maps Cursor stdin format - field names differ from Claude Code
// Cursor uses: conversation_id, workspace_roots[], result_json, command/output
// Handle undefined input gracefully for hooks that don't receive stdin
export const cursorAdapter: PlatformAdapter = {
  normalizeInput(raw) {
    const r = (raw ?? {}) as Record<string, unknown>;
    // Cursor-specific: shell commands come as command/output instead of tool_name/input/response
    const isShellCommand = !!r.command && !r.tool_name;
    const workspaceRoots = Array.isArray(r.workspace_roots) ? r.workspace_roots : [];
    return {
      sessionId: typeof r.conversation_id === 'string' ? r.conversation_id : (typeof r.generation_id === 'string' ? r.generation_id : ''),  // conversation_id preferred
      cwd: (typeof workspaceRoots[0] === 'string' ? workspaceRoots[0] : undefined) ?? process.cwd(),     // First workspace root
      prompt: typeof r.prompt === 'string' ? r.prompt : undefined,
      toolName: isShellCommand ? 'Bash' : (typeof r.tool_name === 'string' ? r.tool_name : undefined),
      toolInput: isShellCommand ? { command: r.command } : r.tool_input,
      toolResponse: isShellCommand ? { output: r.output } : r.result_json,  // result_json not tool_response
      transcriptPath: undefined,  // Cursor doesn't provide transcript
      // Cursor-specific fields for file edits
      filePath: typeof r.file_path === 'string' ? r.file_path : undefined,
      edits: Array.isArray(r.edits) ? (r.edits as unknown[]) : undefined,
    };
  },
  formatOutput(result) {
    // Cursor expects simpler response - just continue flag
    return { continue: result.continue ?? true };
  }
};
