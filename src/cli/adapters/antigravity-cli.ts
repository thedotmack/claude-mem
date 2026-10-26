import { homedir } from 'os';
import type { NormalizedHookInput, PlatformAdapter } from '../types.js';
import { AdapterRejectedInput, isValidCwd } from './errors.js';
import { extractLastMessage, findLastJsonlEntryBackward } from '../../shared/transcript-parser.js';
import { logger } from '../../utils/logger.js';
import { expandHomeDirectory, extractFilePaths } from './codex-file-context.js';

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

// Files named by the tool calls of an agy transcript PLANNER_RESPONSE that
// read them (read_file / view_file, and read commands in run_command).
function filePathsReadByToolCalls(toolCalls: unknown, cwd: string, homeDirectory: string): string[] {
  const filePaths: string[] = [];
  const seen = new Set<string>();
  const add = (filePath: string) => {
    if (seen.has(filePath)) return;
    seen.add(filePath);
    filePaths.push(filePath);
  };
  for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
    const callName = typeof call?.name === 'string' ? call.name : '';
    const args = (call?.args && typeof call.args === 'object') ? call.args as Record<string, unknown> : {};
    if (callName === 'read_file' || callName === 'view_file') {
      const filePath = unwrapArgString(args.Path ?? args.file_path ?? args.path);
      if (filePath) add(expandHomeDirectory(filePath, homeDirectory));
    } else if (callName === 'run_command') {
      const command = unwrapArgString(args.CommandLine ?? args.command);
      if (command) extractFilePaths('Bash', { command }, cwd, homeDirectory).forEach(add);
    }
  }
  return filePaths;
}

export interface AntigravityTurnState {
  /** True only when the newest conversational node is the user's USER_INPUT. */
  isNewUserTurn: boolean;
  /** Files read by the tool calls of the newest PLANNER_RESPONSE. */
  filePaths: string[];
}

const NOT_A_NEW_TURN: AntigravityTurnState = { isNewUserTurn: false, filePaths: [] };

// agy fires PreInvocation before EVERY model call of a turn, so it can't be
// read as a prompt submit. The newest USER_INPUT or PLANNER_RESPONSE node in
// the transcript tells the calls apart:
//   - USER_INPUT: the model hasn't answered yet, so this is the turn's first
//     call and the prompt is recorded once.
//   - PLANNER_RESPONSE: a follow-up call after a tool step; the files that
//     step read get their file-context.
// The scan reads backward in chunks and stops at that node. Anything that
// can't positively identify a new turn (no transcript, unreadable, no node)
// counts as a follow-up, so a broken transcript can't bring back one prompt
// row per model call (#5078).
export function inspectAntigravityTurn(
  transcriptPath: string | undefined,
  cwd: string,
  homeDirectory: string = homedir(),
): AntigravityTurnState {
  if (!transcriptPath) return NOT_A_NEW_TURN;
  try {
    return findLastJsonlEntryBackward<AntigravityTurnState>(transcriptPath, (node) => {
      if (node?.type === 'USER_INPUT') return { isNewUserTurn: true, filePaths: [] };
      if (node?.type === 'PLANNER_RESPONSE') {
        return { isNewUserTurn: false, filePaths: filePathsReadByToolCalls(node.tool_calls, cwd, homeDirectory) };
      }
      return undefined;
    }) ?? NOT_A_NEW_TURN;
  } catch (error) {
    logger.warn('HOOK', 'antigravity: transcript unreadable, not recording a prompt for this model call', {
      transcriptPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return NOT_A_NEW_TURN;
  }
}

// Session-init input for an agy PreInvocation. A new user turn keeps the
// prompt (as `submittedPrompt`); a follow-up call gets `submittedPrompt: null`,
// session-init's "not a user turn", plus the files its tool step read.
export function resolveAntigravityPreInvocation(
  input: NormalizedHookInput,
  homeDirectory: string = homedir(),
): NormalizedHookInput {
  const { isNewUserTurn, filePaths } = inspectAntigravityTurn(input.transcriptPath, input.cwd, homeDirectory);
  if (isNewUserTurn) {
    return input.prompt === undefined ? input : { ...input, submittedPrompt: input.prompt };
  }
  return {
    ...input,
    submittedPrompt: null,
    toolInput: { prompt: input.prompt ?? 'User Query', filePaths },
  };
}

// Antigravity's hook stdin is camelCase protojson with NO explicit event-name
// field (issue #4057). The event is encoded by which hook fired (the CLI arg in
// hooks.json → internal handler), and the payload key shape tells the events
// apart:
//   - SessionStart   : { conversationId, workspacePaths, transcriptPath,
//                        artifactDirectoryPath, modelName }
//   - PostToolUse    : { ..., toolCall, error? }            (error only on failure)
//   - Pre/PostInvocation : { ..., invocationNum, initialNumSteps } (no toolCall)
//   - Stop           : { ..., terminationReason }
// PreToolUse is never registered (#5078), so a toolCall payload is a PostToolUse.

export const antigravityCliAdapter: PlatformAdapter = {
  normalizeInput(raw) {
    const r = (raw ?? {}) as any;

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
    // Pre/PostInvocation payloads are identical; both carry invocationNum and no
    // toolCall.
    const isInvocationEvent = 'invocationNum' in r && !hasToolCall;

    let toolName: string | undefined = r.toolCall?.name ?? r.tool_name;
    let toolInput: unknown = normalizeAgyToolInput(toolName, r.toolCall?.args ?? r.tool_input, cwd);
    let toolResponse: unknown = r.tool_response;

    // Antigravity puts the user's prompt in the transcript's USER_INPUT node
    // (and may also include `lastUserInput` on stdin). Pull it (unwrapped) for
    // session-init and invocation observations.
    const transcriptPrompt = transcriptPath
      ? unwrapAgyUserInput(extractLastMessage(transcriptPath, 'user'))
      : '';
    const lastUserInputPrompt = typeof r.lastUserInput === 'string' && r.lastUserInput.trim()
      ? unwrapAgyUserInput(r.lastUserInput)
      : '';
    const prompt: string | undefined = r.prompt ?? (transcriptPrompt || lastUserInputPrompt || undefined);

    if (isInvocationEvent) {
      // PreInvocation routes to session-init, which works out whether this
      // model call starts a user turn (resolveAntigravityPreInvocation, run
      // only there); PostInvocation routes to observation and records the
      // assistant's turn, which lives in the transcript's PLANNER_RESPONSE node.
      const response = transcriptPath
        ? extractLastMessage(transcriptPath, 'assistant')
        : '';
      toolName = 'AntigravityProvider';
      toolInput = { prompt: prompt ?? 'User Query' };
      toolResponse = { response: response || 'Completed' };
    }

    if (hasToolCall && toolName && !toolResponse) {
      // PostToolUse, the only tool event claude-mem registers (#5078). agy
      // sends `error` only when the tool failed.
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
  //   - SessionStart   → { "injectSteps": [ ... ] } (startup context injection, issue #4911)
  //   - PreInvocation  → { "injectSteps": [ ... ] } (file-context for files the
  //                       previous tool step read, or semantic context on a new
  //                       turn when CLAUDE_MEM_SEMANTIC_INJECT is on; else {})
  //   - PostToolUse / PostInvocation / Stop → {}
  formatOutput(result) {
    const r = result ?? {};

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

    return {};
  }
};
