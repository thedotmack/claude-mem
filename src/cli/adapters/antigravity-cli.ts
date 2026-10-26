import { existsSync, readFileSync } from 'fs';
import type { PlatformAdapter } from '../types.js';
import { AdapterRejectedInput, isValidCwd } from './errors.js';
import { extractLastMessage } from '../../shared/transcript-parser.js';
import { extractFilePaths } from './codex-file-context.js';

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

// Antigravity transcript tool_calls encode string args as JSON-quoted literals
// (e.g. `"\"/path/to/file\""`), whereas hook stdin passes plain strings.
function unwrapArgString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'string') return parsed.trim() || undefined;
    } catch {
      return trimmed.slice(1, -1).trim() || undefined;
    }
  }
  return trimmed;
}

function normalizeAgyToolInput(toolName: string | undefined, toolInput: unknown, cwd: string): unknown {
  if (!toolName || !toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) {
    return toolInput;
  }
  const input = toolInput as Record<string, unknown>;
  if (toolName === 'read_file' || toolName === 'view_file' || toolName === 'edit_file' || toolName === 'write_file') {
    const filePath = unwrapArgString(input.file_path ?? input.Path ?? input.path);
    if (filePath && input.file_path !== filePath) {
      return { ...input, file_path: filePath };
    }
    return input;
  }
  if (toolName === 'run_command') {
    const command = unwrapArgString(input.command ?? input.CommandLine);
    if (!command) return input;
    const filePaths = extractFilePaths('Bash', { command }, cwd);
    return {
      ...input,
      command,
      ...(filePaths.length > 0 ? { filePaths } : {}),
    };
  }
  return input;
}

// Inspect the tail of an Antigravity transcript to distinguish:
//   1. The first PreInvocation of a user turn (the newest USER_INPUT has no
//      PLANNER_RESPONSE after it yet → isNewUserTurn = true).
//   2. Follow-up PreInvocations after tool calls (the newest conversational
//      node is a PLANNER_RESPONSE → isNewUserTurn = false, and any files read
//      in that PLANNER_RESPONSE's tool_calls are extracted for file-context).
function inspectAgyTranscript(
  transcriptPath: string | undefined,
  cwd: string,
): { isNewUserTurn: boolean; filePaths: string[] } {
  if (!transcriptPath || !existsSync(transcriptPath)) {
    return { isNewUserTurn: true, filePaths: [] };
  }
  let content: string;
  try {
    content = readFileSync(transcriptPath, 'utf-8');
  } catch {
    return { isNewUserTurn: true, filePaths: [] };
  }

  const lines = content.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const rawLine = lines[i].trim();
    if (!rawLine) continue;
    let node: Record<string, any>;
    try {
      node = JSON.parse(rawLine);
    } catch {
      continue;
    }

    if (node.type === 'USER_INPUT') {
      return { isNewUserTurn: true, filePaths: [] };
    }

    if (node.type === 'PLANNER_RESPONSE') {
      const filePaths: string[] = [];
      const seen = new Set<string>();
      const toolCalls = Array.isArray(node.tool_calls) ? node.tool_calls : [];
      for (const call of toolCalls) {
        const callName = typeof call?.name === 'string' ? call.name : '';
        const args = (call?.args && typeof call.args === 'object') ? call.args as Record<string, unknown> : {};
        if (callName === 'read_file' || callName === 'view_file') {
          const p = unwrapArgString(args.Path ?? args.file_path ?? args.path);
          if (p && !seen.has(p)) {
            seen.add(p);
            filePaths.push(p);
          }
        } else if (callName === 'run_command') {
          const cmd = unwrapArgString(args.CommandLine ?? args.command);
          if (cmd) {
            for (const p of extractFilePaths('Bash', { command: cmd }, cwd)) {
              if (!seen.has(p)) {
                seen.add(p);
                filePaths.push(p);
              }
            }
          }
        }
      }
      return { isNewUserTurn: false, filePaths };
    }
  }

  return { isNewUserTurn: true, filePaths: [] };
}

// Antigravity's hook stdin is camelCase protojson with NO explicit event-name
// field (issue #4057). The event is encoded by which hook fired (the CLI arg in
// hooks.json → internal handler), and the payload key shape is the reliable
// discriminator for output formatting:
//   - SessionStart   : { conversationId, workspacePaths, transcriptPath,
//                        artifactDirectoryPath, modelName }
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
    let toolInput: unknown = normalizeAgyToolInput(toolName, r.toolCall?.args ?? r.tool_input, cwd);
    let toolResponse: unknown = r.tool_response;
    let submittedPrompt: string | null | undefined;

    // Antigravity puts the user's prompt in the transcript's USER_INPUT node
    // (and may also include `lastUserInput` on stdin). Pull it (unwrapped) for
    // session-init, invocation observations, and context injection.
    const transcriptPrompt = transcriptPath
      ? unwrapAgyUserInput(extractLastMessage(transcriptPath, 'user'))
      : '';
    const lastUserInputPrompt = typeof r.lastUserInput === 'string' && r.lastUserInput.trim()
      ? unwrapAgyUserInput(r.lastUserInput)
      : '';
    const prompt: string | undefined = r.prompt ?? (transcriptPrompt || lastUserInputPrompt || undefined);

    if (isInvocationEvent) {
      // PreInvocation routes to session-init (on the first invocation of a user
      // turn) or file-context (on follow-up invocations after tool calls);
      // PostInvocation routes to observation and records the assistant's turn,
      // which lives in the transcript's PLANNER_RESPONSE node.
      const { isNewUserTurn, filePaths } = inspectAgyTranscript(transcriptPath, cwd);
      submittedPrompt = isNewUserTurn ? (prompt ?? undefined) : null;
      const response = transcriptPath
        ? extractLastMessage(transcriptPath, 'assistant')
        : '';
      toolName = 'AntigravityProvider';
      toolInput = filePaths.length > 0
        ? {
            prompt: prompt ?? 'User Query',
            filePaths,
            ...(filePaths.length === 1 ? { file_path: filePaths[0] } : {}),
          }
        : { prompt: prompt ?? 'User Query' };
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
      ...(submittedPrompt !== undefined ? { submittedPrompt } : {}),
      toolName,
      toolInput,
      toolResponse,
      transcriptPath,
    };
  },

  // Antigravity deserializes hook stdout with strict protojson: unknown fields
  // (continue / suppressOutput / systemMessage / hookSpecificOutput) make it
  // discard the whole payload (issue #4057). Emit ONLY fields agy understands:
  //   - SessionStart   → { "injectSteps": [ ... ] } (startup context injection, issue #4911)
  //   - PreToolUse     → { "decision": "allow" }   (or "deny" to block)
  //   - PreInvocation  → { "injectSteps": [ ... ] } (transient injection if enabled)
  //   - PostToolUse / PostInvocation / Stop → {}
  formatOutput(result) {
    const r = result ?? {};
    const raw = lastRawInput ?? {};
    const isPreTool = Boolean(raw.toolCall) && !('error' in raw);

    if (r.continue === false || r.decision === 'block') {
      return { decision: 'deny', reason: r.reason ?? 'Denied by hook' };
    }

    // Context injection (SessionStart / PreInvocation) surfaces as additionalContext /
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
