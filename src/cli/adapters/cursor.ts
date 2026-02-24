import type { PlatformAdapter, NormalizedHookInput, HookResult } from '../types.js';

// Maps Cursor stdin format - field names differ from Claude Code
// Cursor uses: conversation_id, workspace_roots[], result_json, command/output
// Handle undefined input gracefully for hooks that don't receive stdin
//
// Cursor payload variations (#838, #1049):
//   Session ID: conversation_id, generation_id, or id
//   Prompt: prompt, query, input, or message (varies by Cursor version/hook type)
//   CWD: workspace_roots[0] or cwd
export const cursorAdapter: PlatformAdapter = {
  normalizeInput(raw) {
    const r = (raw ?? {}) as any;
    // Cursor-specific: shell commands come as command/output instead of tool_name/input/response
    const isShellCommand = !!r.command && !r.tool_name;
    return {
      sessionId: r.conversation_id || r.generation_id || r.id,
      cwd: r.workspace_roots?.[0] ?? r.cwd ?? process.cwd(),
      prompt: r.prompt ?? r.query ?? r.input ?? r.message,
      toolName: isShellCommand ? 'Bash' : r.tool_name,
      toolInput: isShellCommand ? { command: r.command } : r.tool_input,
      toolResponse: isShellCommand ? { output: r.output } : r.result_json,  // result_json not tool_response
      transcriptPath: undefined,  // Cursor doesn't provide transcript
      // Cursor-specific fields for file edits
      filePath: r.file_path,
      edits: r.edits,
    };
  },
  formatOutput(result) {
    // Cursor expects simpler response - just continue flag
    return { continue: result.continue ?? true };
  }
};
