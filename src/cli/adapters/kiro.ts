import type { PlatformAdapter } from '../types.js';
import { AdapterRejectedInput, isValidCwd } from './errors.js';

/**
 * Kiro CLI adapter (kiro.dev, formerly Amazon Q Developer CLI).
 *
 * Hook events are declared inside agent config JSONs (~/.kiro/agents/*.json)
 * and invoke `worker-service.cjs hook kiro <event>`. Kiro writes a snake_case
 * JSON payload to stdin: hook_event_name, cwd, plus prompt (userPromptSubmit,
 * and agentSpawn in headless mode), tool_name/tool_input/tool_response
 * (pre/postToolUse) and assistant_response (stop). Verified against a live
 * kiro-cli 2.11.0 capture (tests/fixtures/kiro/): the payload carries NO
 * session_id (despite the docs) — the session UUID arrives as the
 * KIRO_SESSION_ID environment variable — and no transcript_path or
 * agent_id/agent_type.
 *
 * Output contract differs from every other adapter: Kiro injects hook stdout
 * VERBATIM into model context (agentSpawn/userPromptSubmit only), so
 * formatOutput returns a raw string — emitModelContext prints it without a
 * JSON envelope, and an empty string emits nothing. On `stop`, Kiro parses
 * stdout for a `{"decision":"block"}` override that would force the
 * conversation to continue, so silence on non-context events is load-bearing.
 */

/**
 * Kiro built-in tool names → claude-mem canonical tool names. The worker's
 * file extraction and skip lists key on Claude Code names (`Write`, `Read`,
 * `Bash` — see src/services/worker/http/shared.ts), so built-ins are mapped
 * and everything else (`use_aws`, `@server/tool` MCP names) passes through.
 * Doc-derived; re-verify against a live capture (see docs/public/kiro-cli).
 */
const KIRO_TOOL_NAME_MAP: Record<string, string> = {
  fs_read: 'Read',
  fs_write: 'Write',
  execute_bash: 'Bash',
  // Documented aliases for the same built-ins.
  read: 'Read',
  write: 'Write',
  shell: 'Bash',
};

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Kiro built-in tool inputs carry paths where the worker expects Claude
 * Code's `file_path` (live-captured, kiro-cli 2.11.0):
 *   fs_write:     {"command":"create","path":...,"file_text":...}
 *   fs_read:      {"operations":[{"mode":"Line","path":...}, ...]}  (batched)
 * Alias without dropping the originals so observation payloads keep the exact
 * input Kiro reported.
 */
function normalizeToolInput(mappedToolName: string | undefined, toolInput: unknown): unknown {
  if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) {
    return toolInput;
  }
  const input = { ...(toolInput as Record<string, unknown>) };
  const needsFilePath = mappedToolName === 'Read' || mappedToolName === 'Write';
  if (needsFilePath && input.file_path === undefined) {
    if (typeof input.path === 'string') {
      input.file_path = input.path;
    } else if (Array.isArray(input.operations)) {
      const firstPath = (input.operations as Array<Record<string, unknown> | null>)
        .map(op => op?.path)
        .find((p): p is string => typeof p === 'string');
      if (firstPath) {
        input.file_path = firstPath;
      }
    }
  }
  return input;
}

export const kiroAdapter: PlatformAdapter = {
  normalizeInput(raw) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const cwd = typeof r.cwd === 'string' ? r.cwd : process.cwd();
    if (!isValidCwd(cwd)) {
      throw new AdapterRejectedInput('invalid_cwd');
    }

    const rawToolName = stringOrUndefined(r.tool_name);
    const toolName = rawToolName ? (KIRO_TOOL_NAME_MAP[rawToolName] ?? rawToolName) : undefined;

    // Live-captured 2.11.0 payloads carry no session_id field; the session
    // UUID is delivered to the hook process as KIRO_SESSION_ID instead. Keep
    // the payload field as first choice in case a future Kiro adds it.
    const sessionId = stringOrUndefined(r.session_id)
      ?? stringOrUndefined(process.env.KIRO_SESSION_ID);

    return {
      sessionId: sessionId as string,
      cwd,
      prompt: stringOrUndefined(r.prompt),
      toolName,
      toolInput: normalizeToolInput(toolName, r.tool_input),
      toolResponse: r.tool_response,
      lastAssistantMessage: stringOrUndefined(r.assistant_response),
    };
  },

  formatOutput(result) {
    const context = result?.hookSpecificOutput?.additionalContext;
    return typeof context === 'string' && context.trim().length > 0 ? context : '';
  },
};
