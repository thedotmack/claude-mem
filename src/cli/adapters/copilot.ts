/**
 * Copilot CLI adapter.
 *
 * GitHub Copilot CLI writes hook stdin as JSON (see
 * https://docs.github.com/en/copilot/how-tos/use-copilot/use-copilot-cli ).
 * Field names have drifted between CLI versions, so this adapter accepts both
 * camelCase and snake_case plus a few aliases used in the copilot-sdk samples.
 *
 * Copilot CLI does not currently document Codex-style `suppressOutput`. Keep
 * stdout to `additionalContext` (and a continue permission) so unknown keys
 * cannot stall the host.
 */
import type { PlatformAdapter, NormalizedHookInput, HookResult } from '../types.js';
import { AdapterRejectedInput, isValidCwd } from './errors.js';

function firstString(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Copilot CLI `postToolUse` sends `toolResult.textResultForLlm`, not
 * `toolOutput`. Without this unwrap the observer sees a tool name with an
 * empty body and Haiku returns idle/prose instead of an observation.
 */
function extractToolResponse(r: Record<string, unknown>): unknown {
  const direct = r.toolResponse ?? r.tool_response ?? r.toolOutput ?? r.tool_output;
  if (direct !== undefined) return direct;

  const result = r.toolResult ?? r.tool_result;
  if (result && typeof result === 'object') {
    const rec = result as Record<string, unknown>;
    const text = rec.textResultForLlm ?? rec.text_result_for_llm;
    if (typeof text === 'string') return text;
    return result;
  }
  if (result !== undefined) return result;

  return r.error;
}

export const copilotAdapter: PlatformAdapter = {
  normalizeInput(raw) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const cwd = firstString(r.cwd, r.workingDirectory, r.working_directory) ?? process.cwd();
    if (!isValidCwd(cwd)) {
      throw new AdapterRejectedInput('invalid_cwd');
    }

    return {
      sessionId: firstString(r.sessionId, r.session_id, r.conversationId, r.conversation_id) ?? 'unknown',
      cwd,
      prompt: firstString(r.prompt, r.userPrompt, r.user_prompt, r.message, r.initialPrompt, r.initial_prompt),
      toolName: firstString(r.toolName, r.tool_name, r.tool),
      toolInput: r.toolInput ?? r.tool_input ?? r.toolArgs ?? r.tool_args,
      toolResponse: extractToolResponse(r),
      transcriptPath: firstString(r.transcriptPath, r.transcript_path),
      filePath: firstString(r.filePath, r.file_path, r.path),
    } satisfies NormalizedHookInput;
  },

  formatOutput(result: HookResult) {
    const additionalContext = result.hookSpecificOutput?.additionalContext;
    const output: Record<string, unknown> = {
      permissionDecision: 'continue',
    };
    if (additionalContext) {
      output.additionalContext = additionalContext;
    }
    if (result.systemMessage) {
      output.systemMessage = result.systemMessage;
    }
    return output;
  },
};
