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

/**
 * Read Qwen Code's `submitted_prompt` into the three states the handler needs.
 *
 * The distinction that matters is presence, not truthiness: an absent field
 * means the host cannot tell a continuation send from a user turn, and an empty
 * one means the host can and is saying this was not a user turn. Collapsing
 * those two is what wrote a fake `[media prompt]` row for every tool round
 * (#4215).
 */
export const normalizeSubmittedPrompt = (raw: unknown): string | null | undefined => {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, 'submitted_prompt')) return undefined;
  const value = record.submitted_prompt;
  if (typeof value !== 'string') return null;
  return value.trim() ? value : null;
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
      submittedPrompt: normalizeSubmittedPrompt(r),
      toolName: firstFilledString(r.tool_name, r.toolName),
      toolInput: withGrokReadPath(firstDefined(r.tool_input, r.toolInput)),
      toolResponse: firstDefined(r.tool_response, r.toolResponse, r.toolResult),
      toolUseId: firstFilledString(r.tool_use_id, r.toolUseId),
      transcriptPath: firstFilledString(r.transcript_path, r.transcriptPath),
      // stop_hook_active is deliberately not mapped. Claude Code sets it once a
      // Stop hook has blocked the stop and Claude kept working. claude-mem's
      // Stop hook never blocks (it always exits 0 with continue: true), so the
      // flag can only come from another plugin and never marks a loop
      // claude-mem must break. Honoring it (#3168) dropped the summary and the
      // advisor capture for every turn after such a hook fired. Grok Build's
      // camelCase stopHookActive is ignored for the same reason.
      // Grok Build sends lastAssistantMessage and does not write a Claude
      // transcript for the Stop hook.
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
