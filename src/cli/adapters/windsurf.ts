import type { PlatformAdapter, NormalizedHookInput, HookResult } from '../types.js';

// Maps Windsurf stdin format — JSON envelope with agent_action_name + tool_info payload
//
// Common envelope (all hooks):
//   { agent_action_name, trajectory_id, execution_id, timestamp, tool_info: { ... } }
//
// Event-specific tool_info payloads:
//   pre_user_prompt:      { user_prompt: string }
//   post_write_code:      { file_path, edits: [{ old_string, new_string }] }
//   post_run_command:     { command_line, cwd }
//   post_mcp_tool_use:    { mcp_server_name, mcp_tool_name, mcp_tool_arguments, mcp_result }
//   post_cascade_response: { response }
export const windsurfAdapter: PlatformAdapter = {
  normalizeInput(raw) {
    const r = (raw ?? {}) as any;
    const toolInfo = r.tool_info ?? {};
    const actionName: string = r.agent_action_name ?? '';

    const base: NormalizedHookInput = {
      sessionId: r.trajectory_id ?? r.execution_id,
      cwd: toolInfo.cwd ?? process.cwd(),
      platform: 'windsurf',
    };

    switch (actionName) {
      case 'pre_user_prompt':
        return {
          ...base,
          prompt: toolInfo.user_prompt,
        };

      case 'post_write_code':
        return {
          ...base,
          toolName: 'Write',
          filePath: toolInfo.file_path,
          edits: toolInfo.edits,
          toolInput: {
            file_path: toolInfo.file_path,
            edits: toolInfo.edits,
          },
        };

      case 'post_run_command':
        return {
          ...base,
          cwd: toolInfo.cwd ?? base.cwd,
          toolName: 'Bash',
          toolInput: { command: toolInfo.command_line },
        };

      case 'post_mcp_tool_use':
        return {
          ...base,
          toolName: toolInfo.mcp_tool_name ?? 'mcp_tool',
          toolInput: toolInfo.mcp_tool_arguments,
          toolResponse: toolInfo.mcp_result,
        };

      case 'post_cascade_response':
        return {
          ...base,
          toolName: 'cascade_response',
          toolResponse: toolInfo.response,
        };

      default:
        // Unknown action — pass through what we can
        return base;
    }
  },

  formatOutput(result) {
    // Windsurf exit codes: 0 = success, 2 = block (pre-hooks only)
    // The CLI layer handles exit codes; here we just return a simple continue flag
    return { continue: result.continue ?? true };
  },
};
