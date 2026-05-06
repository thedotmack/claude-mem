import type { HookResult, NormalizedHookInput, PlatformAdapter } from '../types.js';
import { AdapterRejectedInput, isValidCwd } from './errors.js';
import { extractFilePaths } from './codex-file-context.js';

type CodexEventName =
  | 'PreToolUse'
  | 'PermissionRequest'
  | 'PostToolUse'
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'Stop';

const EVENT_NAMES = new Set<CodexEventName>([
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'SessionStart',
  'UserPromptSubmit',
  'Stop',
]);

function eventName(value: unknown): CodexEventName | undefined {
  return typeof value === 'string' && EVENT_NAMES.has(value as CodexEventName)
    ? value as CodexEventName
    : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function booleanOrUndefined(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function cloneToolInput(toolInput: unknown): unknown {
  if (toolInput && typeof toolInput === 'object' && !Array.isArray(toolInput)) {
    return { ...(toolInput as Record<string, unknown>) };
  }
  return toolInput;
}

function buildBaseOutput(result: HookResult): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  if (result.continue !== undefined) output.continue = result.continue;
  if (result.suppressOutput !== undefined) output.suppressOutput = result.suppressOutput;
  if (result.systemMessage) output.systemMessage = result.systemMessage;
  if (result.decision === 'block') output.decision = 'block';
  if (result.reason) output.reason = result.reason;
  return output;
}

function inferOutputEvent(result: HookResult): CodexEventName | undefined {
  return eventName(result.hookSpecificOutput?.hookEventName);
}

export const codexAdapter: PlatformAdapter = {
  normalizeInput(raw): NormalizedHookInput {
    const r = (raw ?? {}) as Record<string, unknown>;
    const cwd = typeof r.cwd === 'string' ? r.cwd : process.cwd();
    if (!isValidCwd(cwd)) {
      throw new AdapterRejectedInput('invalid_cwd');
    }

    const hookEventName = eventName(r.hook_event_name);
    const toolName = stringOrUndefined(r.tool_name);
    let toolInput = cloneToolInput(r.tool_input);

    if (hookEventName === 'PreToolUse' && toolName) {
      const filePaths = extractFilePaths(toolName, toolInput, cwd);
      if (filePaths.length > 0 && toolInput && typeof toolInput === 'object' && !Array.isArray(toolInput)) {
        toolInput = { ...(toolInput as Record<string, unknown>), filePaths };
      }
    }

    const source = r.source;
    const sessionSource =
      source === 'startup' || source === 'resume' || source === 'clear'
        ? source
        : undefined;
    const sessionId = stringOrUndefined(r.session_id);
    if (!sessionId) {
      throw new AdapterRejectedInput('missing_session_id');
    }

    return {
      sessionId,
      cwd,
      prompt: stringOrUndefined(r.prompt),
      toolName,
      toolInput,
      toolResponse: r.tool_response,
      transcriptPath: stringOrUndefined(r.transcript_path),
      lastAssistantMessage: stringOrUndefined(r.last_assistant_message),
      turnId: stringOrUndefined(r.turn_id),
      stopHookActive: booleanOrUndefined(r.stop_hook_active),
      permissionMode: stringOrUndefined(r.permission_mode),
      model: stringOrUndefined(r.model),
      sessionSource,
    };
  },

  formatOutput(result): unknown {
    const r = result ?? {};
    const output = buildBaseOutput(r);
    const hookSpecific = r.hookSpecificOutput;
    const outputEvent = inferOutputEvent(r);

    if (!hookSpecific || !outputEvent || outputEvent === 'Stop') {
      return output;
    }

    const specific: Record<string, unknown> = {
      hookEventName: outputEvent,
    };

    if (hookSpecific.additionalContext) {
      specific.additionalContext = hookSpecific.additionalContext;
    }

    if (outputEvent === 'PreToolUse') {
      if (hookSpecific.permissionDecision === 'deny') {
        specific.permissionDecision = 'deny';
        if (hookSpecific.permissionDecisionReason) {
          specific.permissionDecisionReason = hookSpecific.permissionDecisionReason;
        }
      }
      if (hookSpecific.updatedInput) {
        specific.updatedInput = hookSpecific.updatedInput;
      }
    }

    output.hookSpecificOutput = specific;
    return output;
  },
};
