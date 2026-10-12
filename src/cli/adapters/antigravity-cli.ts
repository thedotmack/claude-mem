import type { PlatformAdapter } from '../types.js';
import { AdapterRejectedInput, isValidCwd } from './errors.js';
import { extractLastMessage } from '../../shared/transcript-parser.js';

// `agy` wraps the real user message in <USER_REQUEST>...</USER_REQUEST> and
// appends injected <ADDITIONAL_METADATA> (local time) and <USER_SETTINGS_CHANGE>
// (model switches) blocks. Keep only the genuine request text.
function unwrapAgyUserInput(text: string): string {
  const match = text.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
  if (match) return match[1].trim();
  return text
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, '')
    .trim();
}

// Antigravity's hook stdin is camelCase protojson with NO explicit event-name
// field (issue #4057). The event is encoded by which hook fired (the CLI arg in
// hooks.json → internal handler), and the payload key shape is the reliable
// discriminator for output formatting:
//   - PreToolUse     : { conversationId, workspacePaths, transcriptPath,
//                        toolCall, stepIdx }                 (toolCall, no error)
//   - PostToolUse    : { ..., toolCall, error? }            (toolCall + error key)
//   - Pre/PostInvocation : { ..., invocationNum, initialNumSteps } (no toolCall)
//   - Stop           : { ..., terminationReason }
//
// formatOutput() must key its protojson response off the same raw payload, so we
// stash the last normalized raw input here (one normalizeInput→formatOutput
// cycle per hook process, so module state is safe).
let lastRawInput: Record<string, any> = {};

export const antigravityCliAdapter: PlatformAdapter = {
  normalizeInput(raw) {
    const r = (raw ?? {}) as any;
    lastRawInput = r;

    const cwd = r.workspacePaths?.[0]
      ?? r.cwd
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

    const transcriptPath = r.transcriptPath ?? r.transcript_path;

    const hasToolCall = Boolean(r.toolCall);
    const hasErrorKey = 'error' in r;
    // Pre/PostInvocation payloads are identical; both carry invocationNum and no
    // toolCall.
    const isInvocationEvent = 'invocationNum' in r && !hasToolCall;

    let toolName: string | undefined = r.toolCall?.name ?? r.tool_name;
    let toolInput: unknown = r.toolCall?.args ?? r.tool_input;
    let toolResponse: unknown = r.tool_response;

    // Antigravity does not put the user's prompt on stdin — it lives in the
    // transcript's USER_INPUT node. Pull it (unwrapped) for both invocation
    // observations and context injection.
    const transcriptPrompt = transcriptPath
      ? unwrapAgyUserInput(extractLastMessage(transcriptPath, 'user'))
      : '';
    const prompt: string | undefined = r.prompt ?? (transcriptPrompt || undefined);

    if (isInvocationEvent) {
      // PreInvocation routes to the context handler (ignores tool fields);
      // PostInvocation routes to observation and records the assistant's turn,
      // which lives in the transcript's PLANNER_RESPONSE node.
      const response = transcriptPath
        ? extractLastMessage(transcriptPath, 'assistant')
        : '';
      toolName = 'AntigravityProvider';
      toolInput = { prompt: prompt ?? 'User Query' };
      toolResponse = { response: response || 'Completed' };
    }

    if (hasToolCall && !hasErrorKey && toolName && !toolResponse) {
      // PreToolUse — the tool has not executed yet.
      toolResponse = { _preExecution: true };
    }

    if (hasToolCall && hasErrorKey && toolName && !toolResponse) {
      // PostToolUse — record the outcome.
      toolResponse = typeof r.error === 'string' && r.error
        ? { error: r.error }
        : { status: 'completed' };
    }

    return {
      sessionId,
      cwd,
      prompt,
      toolName,
      toolInput,
      toolResponse,
      transcriptPath,
    };
  },

  // Antigravity deserializes hook stdout with strict protojson: unknown fields
  // (continue / suppressOutput / systemMessage / hookSpecificOutput) make it
  // discard the whole payload (issue #4057). Emit ONLY fields agy understands:
  //   - PreToolUse     → { "decision": "allow" }   (or "deny" to block)
  //   - PreInvocation  → { "injectSteps": [ ... ] } (context injection)
  //   - PostToolUse / PostInvocation / Stop → {}
  formatOutput(result) {
    const r = result ?? {};
    const raw = lastRawInput ?? {};
    const isPreTool = Boolean(raw.toolCall) && !('error' in raw);

    if (r.continue === false || r.decision === 'block') {
      return { decision: 'deny', reason: r.reason ?? 'Denied by hook' };
    }

    // Context injection (PreInvocation) surfaces as additionalContext /
    // systemMessage on the result. Antigravity injects it via injectSteps.
    const additionalContext = r.hookSpecificOutput?.additionalContext ?? r.systemMessage;
    if (additionalContext) {
      const ansiRegex = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
      const cleanMessage = (additionalContext as string).replace(ansiRegex, '');
      return { injectSteps: [{ ephemeralMessage: cleanMessage }] };
    }

    if (isPreTool) {
      return { decision: 'allow' };
    }

    return {};
  }
};
