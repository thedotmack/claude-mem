import type { PlatformAdapter, HookResult } from '../types.js';
import { AdapterRejectedInput, isValidCwd } from './errors.js';

const FILE_EDIT_TOOLS = new Set(['write', 'edit', 'multiedit']);

export const crushAdapter: PlatformAdapter = {
  normalizeInput(raw) {
    const r = (raw ?? {}) as any;

    const cwd =
      r.cwd ??
      process.env.CRUSH_CWD ??
      process.env.CRUSH_PROJECT_DIR ??
      process.cwd();

    if (!isValidCwd(cwd)) {
      throw new AdapterRejectedInput('invalid_cwd');
    }

    const sessionId =
      r.session_id ??
      r.sessionId ??
      process.env.CRUSH_SESSION_ID;

    const toolName =
      r.tool_name ??
      r.toolName ??
      process.env.CRUSH_TOOL_NAME;

    const toolInput = r.tool_input ?? r.toolInput;

    const metadata: Record<string, unknown> = {};
    if (r.event) metadata.hook_event_name = r.event;
    if (process.env.CRUSH_PROJECT_DIR) metadata.project_dir = process.env.CRUSH_PROJECT_DIR;

    const lowered = typeof toolName === 'string' ? toolName.toLowerCase() : '';
    const filePath =
      (toolInput && typeof toolInput === 'object'
        ? (toolInput as any).file_path ?? (toolInput as any).filePath ?? (toolInput as any).path
        : undefined) ?? process.env.CRUSH_TOOL_INPUT_FILE_PATH;

    const edits = FILE_EDIT_TOOLS.has(lowered)
      ? (toolInput && typeof toolInput === 'object'
          ? (toolInput as any).edits ?? [toolInput]
          : undefined)
      : undefined;

    return {
      sessionId,
      cwd,
      toolName,
      toolInput,
      toolResponse: r.tool_response ?? r.toolResponse,
      filePath,
      edits,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };
  },

  formatOutput(result) {
    const r = result ?? ({} as HookResult);
    const output: Record<string, unknown> = { version: 1 };

    const injected = r.hookSpecificOutput?.additionalContext;
    if (typeof injected === 'string' && injected.trim().length > 0) {
      output.context = injected;
    }

    return output;
  },
};
