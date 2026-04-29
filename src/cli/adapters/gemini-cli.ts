import type { PlatformAdapter } from '../types.js';
import { AdapterRejectedInput, isValidCwd } from './errors.js';

export const geminiCliAdapter: PlatformAdapter = {
  normalizeInput(raw) {
    const r = (raw ?? {}) as any;

    const cwd = r.cwd
      ?? process.env.GEMINI_CWD
      ?? process.env.GEMINI_PROJECT_DIR
      ?? process.env.CLAUDE_PROJECT_DIR
      ?? process.cwd();
    if (!isValidCwd(cwd)) {
      throw new AdapterRejectedInput('invalid_cwd');
    }

    const sessionId = r.session_id
      ?? process.env.GEMINI_SESSION_ID
      ?? undefined;

    const hookEventName: string | undefined = r.hook_event_name;

    let toolName: string | undefined = r.tool_name;
    let toolInput: unknown = r.tool_input;
    let toolResponse: unknown = r.tool_response;

    if (hookEventName === 'AfterAgent' && r.prompt_response) {
      toolName = toolName ?? 'GeminiProvider';
      toolInput = toolInput ?? { prompt: r.prompt };
      toolResponse = toolResponse ?? { response: r.prompt_response };
    }

    if (hookEventName === 'BeforeTool' && toolName && !toolResponse) {
      toolResponse = { _preExecution: true };
    }

    if (hookEventName === 'Notification') {
      toolName = toolName ?? 'GeminiNotification';
      toolInput = toolInput ?? {
        notification_type: r.notification_type,
        message: r.message,
      };
      toolResponse = toolResponse ?? { details: r.details };
    }

    const metadata: Record<string, unknown> = {};
    if (r.source) metadata.source = r.source;                     
    if (r.reason) metadata.reason = r.reason;                     
    if (r.trigger) metadata.trigger = r.trigger;                  
    if (r.mcp_context) metadata.mcp_context = r.mcp_context;     
    if (r.notification_type) metadata.notification_type = r.notification_type;
    if (r.stop_hook_active !== undefined) metadata.stop_hook_active = r.stop_hook_active;
    if (r.original_request_name) metadata.original_request_name = r.original_request_name;
    if (hookEventName) metadata.hook_event_name = hookEventName;

    return {
      sessionId,
      cwd,
      prompt: r.prompt,
      toolName,
      toolInput,
      toolResponse,
      transcriptPath: r.transcript_path,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };
  },

  formatOutput(result) {
    const output: Record<string, unknown> = {};

    output.continue = result.continue ?? true;

    if (result.suppressOutput !== undefined) {
      output.suppressOutput = result.suppressOutput;
    }

    if (result.systemMessage) {
      const ansiRegex = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
      output.systemMessage = result.systemMessage.replace(ansiRegex, '');
    }

    if (result.hookSpecificOutput) {
      output.hookSpecificOutput = {
        additionalContext: result.hookSpecificOutput.additionalContext,
      };
    }

    return output;
  }
};
