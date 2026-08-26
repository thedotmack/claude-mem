import type { PlatformAdapter } from '../types.js';
import { AdapterRejectedInput, isValidCwd } from './errors.js';

export const antigravityCliAdapter: PlatformAdapter = {
  normalizeInput(raw) {
    const r = (raw ?? {}) as any;

    const cwd = r.cwd
      ?? (Array.isArray(r.workspacePaths) && r.workspacePaths[0] ? r.workspacePaths[0] : undefined)
      ?? process.env.GEMINI_CWD
      ?? process.env.GEMINI_PROJECT_DIR
      ?? process.env.CLAUDE_PROJECT_DIR
      ?? process.cwd();
    if (!isValidCwd(cwd)) {
      throw new AdapterRejectedInput('invalid_cwd');
    }

    const sessionId = r.session_id
      ?? r.conversationId
      ?? process.env.GEMINI_SESSION_ID
      ?? undefined;

    const hookEventName: string | undefined = r.hook_event_name;

    let toolName: string | undefined = r.tool_name ?? r.toolCall?.name;
    let toolInput: unknown = r.tool_input ?? r.toolCall?.args;
    let toolResponse: unknown = r.tool_response ?? r.error ?? r.output;

    if (hookEventName === 'AfterAgent' && r.prompt_response) {
      toolName = toolName ?? 'AntigravityProvider';
      toolInput = toolInput ?? { prompt: r.prompt };
      toolResponse = toolResponse ?? { response: r.prompt_response };
    }

    if ((hookEventName === 'BeforeTool' || hookEventName === 'PreToolUse') && toolName && !toolResponse) {
      toolResponse = { _preExecution: true };
    }

    if (hookEventName === 'Notification') {
      toolName = toolName ?? 'AntigravityNotification';
      toolInput = toolInput ?? {
        notification_type: r.notification_type,
        message: r.message,
      };
      toolResponse = toolResponse ?? { details: r.details };
    }

    // Default toolResponse if none provided so observation handler does not drop tool steps
    if (toolName && toolResponse === undefined) {
      toolResponse = { status: 'completed', stepIdx: r.stepIdx };
    }

    return {
      sessionId,
      cwd,
      prompt: r.prompt,
      toolName,
      toolInput,
      toolResponse,
      transcriptPath: r.transcript_path ?? r.transcriptPath,
    };
  },

  formatOutput(result) {
    const output: Record<string, unknown> = {};

    output.continue = result.continue ?? true;
    output.decision = output.continue ? 'allow' : 'deny';

    if (result.suppressOutput !== undefined) {
      output.suppressOutput = result.suppressOutput;
    }

    const rawMessage = result.systemMessage || result.hookSpecificOutput?.additionalContext;
    if (rawMessage) {
      const ansiRegex = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
      const cleanMessage = rawMessage.replace(ansiRegex, '');
      output.systemMessage = cleanMessage;
      output.injectSteps = [{ ephemeralMessage: cleanMessage }];
    }

    if (result.hookSpecificOutput) {
      output.hookSpecificOutput = {
        additionalContext: result.hookSpecificOutput.additionalContext,
      };
    }

    return output;
  }
};
