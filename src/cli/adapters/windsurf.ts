import type { PlatformAdapter, NormalizedHookInput, HookResult } from '../types.js';
import { AdapterRejectedInput, isValidCwd } from './errors.js';

export const windsurfAdapter: PlatformAdapter = {
  normalizeInput(raw) {
    const r = (raw ?? {}) as any;
    const toolInfo = r.tool_info ?? {};
    const actionName: string = r.agent_action_name ?? '';

    const cwd = toolInfo.cwd || process.cwd();
    if (!isValidCwd(cwd)) {
      throw new AdapterRejectedInput('invalid_cwd');
    }

    const base: NormalizedHookInput = {
      sessionId: r.trajectory_id ?? r.execution_id,
      cwd,
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

      case 'post_mcp_tool_use': {
        const name = toolInfo.mcp_tool_name ?? 'mcp_tool';
        const server = toolInfo.mcp_server_name;
        return {
          ...base,
          // Windsurf sends the server and bare tool name separately. Retain
          // both in the common MCP identity so our own search/timeline calls
          // hit the recursion gate while external same-named tools still run.
          toolName: typeof server === 'string' && server.length > 0 && typeof name === 'string' && name.length > 0
            ? `mcp__${server}__${name}` : name,
          nativeToolName: typeof toolInfo.mcp_tool_name === 'string' ? toolInfo.mcp_tool_name : undefined,
          toolInput: toolInfo.mcp_tool_arguments,
          toolResponse: toolInfo.mcp_result,
        };
      }

      case 'post_cascade_response':
        return {
          ...base,
          toolName: 'cascade_response',
          toolResponse: toolInfo.response,
        };

      default:
        return base;
    }
  },

  formatOutput(result) {
    return { continue: result.continue ?? true };
  },
};
