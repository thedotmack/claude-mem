import type { PlatformAdapter, NormalizedHookInput, HookResult } from '../types.js';
import { AdapterRejectedInput, isValidCwd } from './errors.js';
import { resolveHookProjectPath } from '../../utils/project-name.js';

const MAX_AGENT_FIELD_LEN = 128;
const pickAgentField = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 && v.length <= MAX_AGENT_FIELD_LEN ? v : undefined;
const pickStringField = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : undefined;
// Snake-case wins when it is a non-empty string. Grok Build sends camelCase
// (sessionId, toolName, toolResult, lastAssistantMessage) on the same payload.
const firstFilledString = (...values: unknown[]): string | undefined => {
  for (const value of values) {
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
};
const firstDefined = (...values: unknown[]): unknown => {
  for (const value of values) {
    if (value != null) return value;
  }
  return undefined;
};
const withGrokReadPath = (toolInput: unknown): unknown => {
  if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) return toolInput;
  const record = toolInput as Record<string, unknown>;
  if (typeof record.file_path === 'string' && record.file_path !== '') return toolInput;
  const target = record.target_file ?? record.filePath ?? record.path;
  if (typeof target !== 'string' || target === '') return toolInput;
  return { ...record, file_path: target };
};

export const claudeCodeAdapter: PlatformAdapter = {
  normalizeInput(raw) {
    const r = (raw ?? {}) as any;
    const inputCwd = r.cwd ?? process.cwd();
    if (!isValidCwd(inputCwd)) {
      throw new AdapterRejectedInput('invalid_cwd');
    }
    const cwd = resolveHookProjectPath(inputCwd);
    if (!isValidCwd(cwd)) {
      throw new AdapterRejectedInput('invalid_cwd');
    }
    return {
      sessionId: r.session_id ?? r.id ?? r.sessionId,
      cwd,
      prompt: firstFilledString(r.prompt, r.userPrompt),
      toolName: firstFilledString(r.tool_name, r.toolName),
      toolInput: withGrokReadPath(firstDefined(r.tool_input, r.toolInput)),
      toolResponse: firstDefined(r.tool_response, r.toolResponse, r.toolResult),
      toolUseId: firstFilledString(r.tool_use_id, r.toolUseId),
      transcriptPath: firstFilledString(r.transcript_path, r.transcriptPath),
      // #3161: feeds summarize.ts's re-entry loop breaker (codex.ts already
      // maps this; without it the breaker never fires on Claude Code).
      // Grok Build sends camelCase stopHookActive and lastAssistantMessage
      // and does not write a Claude transcript for the Stop hook.
      stopHookActive: typeof r.stop_hook_active === 'boolean'
        ? r.stop_hook_active
        : typeof r.stopHookActive === 'boolean' ? r.stopHookActive : undefined,
      lastAssistantMessage: firstFilledString(r.last_assistant_message, r.lastAssistantMessage),
      reason: pickStringField(r.reason),
      agentId: pickAgentField(r.agent_id) ?? pickAgentField(r.agentId),
      agentType: pickAgentField(r.agent_type) ?? pickAgentField(r.agentType) ?? pickAgentField(r.subagentType),
    };
  },
  formatOutput(result) {
    const r = result ?? ({} as HookResult);
    if (r.hookSpecificOutput) {
      const output: Record<string, unknown> = { hookSpecificOutput: result.hookSpecificOutput };
      if (r.systemMessage) {
        output.systemMessage = r.systemMessage;
      }
      return output;
    }
    const output: Record<string, unknown> = {};
    if (r.systemMessage) {
      output.systemMessage = r.systemMessage;
    }
    return output;
  }
};
