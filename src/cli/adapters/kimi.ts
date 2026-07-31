import type { HookResult, NormalizedHookInput, PlatformAdapter } from '../types.js';
import { AdapterRejectedInput, isValidCwd } from './errors.js';

/**
 * Kimi Code CLI adapter. Kimi Code (Moonshot) mirrors the Claude Code hook
 * contract: snake_case stdin JSON (hook_event_name, session_id, cwd, plus
 * per-event fields like tool_input) and the same exit-code semantics
 * (0 = allow, 2 = block, anything else = allow). stdout JSON follows the
 * Claude Code shape (hookSpecificOutput / systemMessage).
 */

const MAX_AGENT_FIELD_LEN = 128;
const pickAgentField = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 && v.length <= MAX_AGENT_FIELD_LEN ? v : undefined;

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Kimi Code sends `prompt` as an array of content blocks
 * ([{type:'text',text:'…'}]) rather than Claude Code's plain string (confirmed
 * on a live 2026-07 session — the '[media prompt]' fallback would otherwise
 * swallow every real user prompt). Join the text blocks; tolerate mixed and
 * non-text entries by skipping them.
 */
function promptOrUndefined(value: unknown): string | undefined {
  const asString = stringOrUndefined(value);
  if (asString) return asString;
  if (Array.isArray(value)) {
    const joined = value
      .map(block => (block && typeof block === 'object' ? stringOrUndefined((block as any).text) : undefined))
      .filter((t): t is string => t !== undefined)
      .join('\n');
    return joined.length > 0 ? joined : undefined;
  }
  return undefined;
}

function booleanOrUndefined(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

export const kimiAdapter: PlatformAdapter = {
  normalizeInput(raw): NormalizedHookInput {
    const r = (raw ?? {}) as any;
    const cwd = typeof r.cwd === 'string' ? r.cwd : process.cwd();
    if (!isValidCwd(cwd)) {
      throw new AdapterRejectedInput('invalid_cwd');
    }

    // SessionStart carries `source: startup|resume` (matcher values). TODO(verify):
    // Kimi docs confirm the matcher enum; the stdin field name is assumed to
    // match Claude Code's `source` — tolerated as undefined when absent.
    const source = r.source;
    const sessionSource =
      source === 'startup' || source === 'resume' || source === 'clear'
        ? source
        : undefined;

    return {
      sessionId: r.session_id ?? r.id ?? r.sessionId,
      cwd,
      prompt: promptOrUndefined(r.prompt),
      toolName: stringOrUndefined(r.tool_name),
      toolInput: r.tool_input,
      toolResponse: r.tool_response,
      transcriptPath: stringOrUndefined(r.transcript_path),
      lastAssistantMessage: stringOrUndefined(r.last_assistant_message),
      turnId: stringOrUndefined(r.turn_id),
      stopHookActive: booleanOrUndefined(r.stop_hook_active),
      permissionMode: stringOrUndefined(r.permission_mode),
      model: stringOrUndefined(r.model),
      sessionSource,
      agentId: pickAgentField(r.agent_id),
      agentType: pickAgentField(r.agent_type),
    };
  },

  formatOutput(result): unknown {
    const r = result ?? ({} as HookResult);
    // Kimi's hook contract (verified in the installed CLI source, 0.29.1):
    // context reaches the model ONLY via UserPromptSubmit, where the appended
    // text is the JSON `message` field or, failing that, raw stdout. There is
    // no additionalContext/systemMessage support — `{}` envelopes would land
    // in context as literal noise. So: context goes out as plain text, and
    // every no-op result stays SILENT (empty stdout → skipped by Kimi's
    // userPromptHookMessage filter).
    const additional = r.hookSpecificOutput?.additionalContext;
    if (typeof additional === 'string' && additional.length > 0) {
      return additional;
    }
    return '';
  },
};
