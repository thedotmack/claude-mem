import { existsSync, readFileSync } from 'fs';
import type { PlatformAdapter } from '../types.js';
import { AdapterRejectedInput, isValidCwd } from './errors.js';

export const antigravityCliAdapter: PlatformAdapter = {
  normalizeInput(raw) {
    const r = (raw ?? {}) as any;

    const cwd = r.cwd
      ?? (Array.isArray(r.workspacePaths) && r.workspacePaths.length > 0 && typeof r.workspacePaths[0] === 'string'
        ? r.workspacePaths[0]
        : undefined)
      ?? process.env.GEMINI_CWD
      ?? process.env.GEMINI_PROJECT_DIR
      ?? process.env.CLAUDE_PROJECT_DIR
      ?? process.cwd();
    if (!isValidCwd(cwd)) {
      throw new AdapterRejectedInput('invalid_cwd');
    }

    const sessionId = r.conversationId
      ?? r.session_id
      ?? process.env.GEMINI_SESSION_ID
      ?? undefined;

    const hookEventName: string | undefined = r.hook_event_name;

    let toolName: string | undefined = r.toolCall?.name
      ?? r.tool_name
      ?? r.toolName;
    let toolInput: unknown = r.toolCall?.args
      ?? r.tool_input
      ?? r.toolInput;
    let toolResponse: unknown = r.toolResult
      ?? r.tool_response
      ?? r.toolResponse
      ?? (r.error ? { error: r.error } : undefined);

    if (hookEventName === 'AfterAgent' && r.prompt_response) {
      toolName = toolName ?? 'AntigravityProvider';
      toolInput = toolInput ?? { prompt: r.prompt };
      toolResponse = toolResponse ?? { response: r.prompt_response };
    }

    if (hookEventName === 'BeforeTool' && toolName && !toolResponse) {
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

    const transcriptPath = r.transcriptPath ?? r.transcript_path;
    if (!toolName && transcriptPath && typeof transcriptPath === 'string') {
      try {
        if (existsSync(transcriptPath)) {
          const content = readFileSync(transcriptPath, 'utf-8');
          const lines = content.trim().split('\n');
          for (let i = lines.length - 1; i >= 0; i--) {
            try {
              const step = JSON.parse(lines[i]);
              if (Array.isArray(step.tool_calls) && step.tool_calls.length > 0) {
                toolName = step.tool_calls[0].name;
                toolInput = step.tool_calls[0].args;
                break;
              }
            } catch {
              // Ignore malformed line
            }
          }
        }
      } catch {
        // Defensive non-blocking fallback
      }
    }

    return {
      sessionId,
      cwd,
      prompt: r.prompt,
      toolName,
      toolInput,
      toolResponse,
      transcriptPath,
    };
  },

  formatOutput(result) {
    const output: Record<string, unknown> = {};

    if (result.systemMessage) {
      const ansiRegex = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
      const clean = result.systemMessage.replace(ansiRegex, '');
      if (clean) {
        output.injectSteps = [{ ephemeralMessage: clean }];
      }
    }

    if (result.hookSpecificOutput?.additionalContext) {
      output.injectSteps = [
        {
          ephemeralMessage: result.hookSpecificOutput.additionalContext,
        },
      ];
    }

    return output;
  }
};
