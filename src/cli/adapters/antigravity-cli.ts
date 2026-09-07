import type { PlatformAdapter } from '../types.js';
import { AdapterRejectedInput, isValidCwd } from './errors.js';

export const antigravityCliAdapter: PlatformAdapter = {
  normalizeInput(raw) {
    const r = (raw ?? {}) as any;

    const workspacePath = (Array.isArray(r.workspacePaths) && r.workspacePaths[0] ? r.workspacePaths[0] : undefined)
      ?? (Array.isArray(r.workspace_paths) && r.workspace_paths[0] ? r.workspace_paths[0] : undefined);
    const cwd = r.cwd
      ?? workspacePath
      ?? process.env.GEMINI_CWD
      ?? process.env.GEMINI_PROJECT_DIR
      ?? process.env.CLAUDE_PROJECT_DIR
      ?? process.cwd();
    if (!isValidCwd(cwd)) {
      throw new AdapterRejectedInput('invalid_cwd');
    }

    const sessionId = r.session_id
      ?? r.conversationId
      ?? r.sessionId
      ?? process.env.GEMINI_SESSION_ID
      ?? undefined;

    const hookEventName: string | undefined = r.hook_event_name ?? r.hookEventName;
    const stepIdx = r.stepIdx ?? r.step_idx;
    const prompt = r.prompt;
    const promptResponse = r.prompt_response ?? r.promptResponse;

    let toolName: string | undefined = r.tool_name ?? r.toolName ?? r.toolCall?.name;
    let toolInput: unknown = r.tool_input ?? r.toolInput ?? r.toolCall?.args;
    let toolResponse: unknown = r.tool_response ?? r.toolResponse ?? r.response ?? r.error ?? r.output;

    if (hookEventName === 'AfterAgent' && promptResponse !== undefined) {
      toolName = toolName ?? 'AntigravityProvider';
      toolInput = toolInput ?? { prompt };
      toolResponse = toolResponse ?? { response: promptResponse };
    }

    if ((hookEventName === 'BeforeTool' || hookEventName === 'PreToolUse') && toolName && toolResponse === undefined) {
      toolResponse = { _preExecution: true };
    }

    if (hookEventName === 'Notification') {
      toolName = toolName ?? 'AntigravityNotification';
      toolInput = toolInput ?? {
        notification_type: r.notification_type ?? r.notificationType,
        message: r.message,
      };
      toolResponse = toolResponse ?? { details: r.details };
    }

    // Default toolResponse if none provided so observation handler does not drop tool steps
    if (toolName && toolResponse === undefined) {
      toolResponse = { status: 'completed', stepIdx };
    }

    return {
      sessionId,
      cwd,
      prompt,
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
