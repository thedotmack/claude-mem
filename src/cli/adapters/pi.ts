import type { PlatformAdapter, NormalizedHookInput, HookResult } from '../types.js';
import { AdapterRejectedInput, isValidCwd } from './errors.js';

/**
 * Pi (https://github.com/badlogic/pi-mono) adapter.
 *
 * Pi is a coding agent with a TypeScript extension system. Extensions subscribe
 * to lifecycle hooks (`session_start`, `before_agent_start`, `tool_call`,
 * `tool_result`, `agent_end`, `session_before_compact`) via `pi.registerHook`
 * and shell out to the claude-mem worker through `bun-runner.js`.
 *
 * Pi-side extension scaffold lives in `pi-hooks/` and ships as a standalone
 * npm package. The extension is the authoritative source for the transcript
 * path under `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`;
 * the adapter never derives it on the worker side. When the extension omits
 * the path, worker-side handlers degrade to session-id lookup against the
 * observations table.
 *
 * - Pi exposes a `cwd` field on every hook event payload; if missing, fall
 *   back to `process.cwd()` as the worker invocation happens in the
 *   extension's host directory.
 * - `agent_type: 'pi'` is forwarded into `agentType` so dashboards and the
 *   project catalog group Pi observations cleanly.
 */

const MAX_AGENT_FIELD_LEN = 128;
const pickAgentField = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 && v.length <= MAX_AGENT_FIELD_LEN ? v : undefined;

const UNKNOWN_SESSION_ID = 'unknown';

/**
 * Coerce arbitrary stdin input into a safe session-id string. Falls back to
 * `'unknown'` so the returned `NormalizedHookInput.sessionId` always matches
 * the non-optional `string` contract on the interface (mirrors the
 * `rawAdapter` precedent).
 *
 * - `string` → trimmed; empty/whitespace collapses to `'unknown'`.
 * - `number` (some Pi forks pass numeric session ids) → stringified.
 * - anything else (objects, arrays, null, booleans) → `'unknown'`.
 *
 * Keeps downstream storage and lookup paths from seeing arbitrary runtime
 * values when a malformed extension forwards an unexpected shape, while
 * still satisfying the interface.
 */
function normalizeSessionId(value: unknown): string {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : UNKNOWN_SESSION_ID;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return UNKNOWN_SESSION_ID;
}

export const piAdapter: PlatformAdapter = {
  normalizeInput(raw) {
    const r = (raw ?? {}) as any;

    // Pi extension may emit either camelCase (NormalizedHookInput shape) or
    // snake_case (raw hook event shape). Accept both so the extension stays
    // free to forward Pi's native event payload without reshaping.
    const cwd = r.cwd ?? r.workingDirectory ?? process.cwd();
    if (!isValidCwd(cwd)) {
      throw new AdapterRejectedInput('invalid_cwd');
    }

    const sessionId = normalizeSessionId(
      r.sessionId ?? r.session_id ?? r.sessionUuid ?? r.session_uuid,
    );

    const toolName = r.toolName ?? r.tool_name ?? r.toolType ?? r.tool_type;
    const toolInput = r.toolInput ?? r.tool_input ?? r.input;
    const toolResponse =
      r.toolResponse ?? r.tool_response ?? r.output ?? r.result;

    return {
      sessionId,
      cwd,
      prompt: r.prompt ?? r.userMessage ?? r.user_message,
      toolName,
      toolInput,
      toolResponse,
      transcriptPath: r.transcriptPath ?? r.transcript_path,
      filePath: r.filePath ?? r.file_path ?? r.path,
      edits: r.edits,
      lastAssistantMessage:
        r.lastAssistantMessage ?? r.last_assistant_message,
      turnId: r.turnId ?? r.turn_id,
      stopHookActive: r.stopHookActive ?? r.stop_hook_active,
      permissionMode: r.permissionMode ?? r.permission_mode,
      model: r.model ?? r.modelName ?? r.model_name,
      sessionSource: r.sessionSource ?? r.session_source,
      agentId: pickAgentField(r.agentId ?? r.agent_id),
      agentType: pickAgentField(r.agentType ?? r.agent_type) ?? 'pi',
      metadata: r.metadata,
    };
  },
  formatOutput(result) {
    // Pi extensions consume the worker response as JSON and decide whether
    // to surface `additionalContext` to the model. Keep the response shape
    // close to the canonical Claude Code form so a Pi extension can reuse
    // the same hookSpecificOutput plumbing.
    const r = result ?? ({} as HookResult);
    const output: Record<string, unknown> = { continue: r.continue ?? true };
    if (r.hookSpecificOutput) {
      output.hookSpecificOutput = r.hookSpecificOutput;
    }
    if (r.systemMessage) {
      output.systemMessage = r.systemMessage;
    }
    if (r.suppressOutput !== undefined) {
      output.suppressOutput = r.suppressOutput;
    }
    return output;
  },
};
