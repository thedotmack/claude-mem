import type { HookResult, NormalizedHookInput, PlatformAdapter } from '../types.js';
import { claudeCodeAdapter } from './claude-code.js';
import { AdapterRejectedInput, isValidCwd } from './errors.js';

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

// Devin CLI names its tools in lowercase (docs.devin.ai cli/extensibility/
// hooks/lifecycle-hooks, "Using the Matcher"). Capture keys on the Claude Code
// names: shellCommandOf and fileOperationTools (worker/http/shared.ts), the
// READ/WRITE sets in ResponseProcessor.ts, Edit compaction in
// field-optimizer.ts and the CLAUDE_MEM_SKIP_TOOLS defaults. Only tools with a
// direct Claude Code counterpart are mapped; the rest (and `mcp__<server>__<tool>`,
// which both hosts spell the same) pass through.
const DEVIN_TOOL_NAMES: Record<string, string> = {
  exec: 'Bash',
  read: 'Read',
  edit: 'Edit',
  write: 'Write',
  notebook_edit: 'NotebookEdit',
  grep: 'Grep',
  glob: 'Glob',
  webfetch: 'WebFetch',
  todo_write: 'TodoWrite',
  skill: 'Skill',
};

const FILE_PATH_TOOLS = new Set(['Read', 'Edit', 'Write']);

// Shared read capture and file-context use `file_path`. Devin documents only
// the exec input shape, so alias a `path` field for the file tools when
// `file_path` is absent, without mutating the caller's object.
function normalizeToolInput(toolName: string | undefined, input: unknown): unknown {
  if (!toolName || !FILE_PATH_TOOLS.has(toolName)) return input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const fileInput = input as Record<string, unknown>;
  if (stringOrUndefined(fileInput.file_path)) return input;
  const filePath = stringOrUndefined(fileInput.path);
  return filePath ? { ...fileInput, file_path: filePath } : input;
}

const SESSION_SOURCES = new Set(['startup', 'resume', 'clear', 'compact']);

export const devinAdapter: PlatformAdapter = {
  normalizeInput(raw): NormalizedHookInput {
    const r = (raw ?? {}) as Record<string, unknown>;
    // Devin's payload does not document `cwd`; it sets DEVIN_PROJECT_DIR to
    // the project root for every hook command.
    const cwd = stringOrUndefined(r.cwd) ?? stringOrUndefined(process.env.DEVIN_PROJECT_DIR) ?? process.cwd();
    if (!isValidCwd(cwd)) {
      throw new AdapterRejectedInput('invalid_cwd');
    }
    const sessionId = stringOrUndefined(r.session_id);
    if (!sessionId) {
      throw new AdapterRejectedInput('missing_session_id');
    }
    const rawToolName = stringOrUndefined(r.tool_name);
    const toolName = rawToolName ? DEVIN_TOOL_NAMES[rawToolName] ?? rawToolName : undefined;
    const source = stringOrUndefined(r.source);
    return {
      sessionId,
      cwd,
      prompt: stringOrUndefined(r.prompt),
      toolName,
      toolInput: normalizeToolInput(toolName, r.tool_input),
      // `{ success, output, error }`, stored as the host sent it.
      toolResponse: r.tool_response,
      // Devin's Stop carries no transcript path; summarize uses this instead.
      lastAssistantMessage: stringOrUndefined(r.last_assistant_message),
      reason: stringOrUndefined(r.reason),
      // Per-turn id, absent before the first prompt.
      turnId: stringOrUndefined(r.prompt_id),
      sessionSource: source && SESSION_SOURCES.has(source) ? source as NormalizedHookInput['sessionSource'] : undefined,
      hookEventName: stringOrUndefined(r.hook_event_name),
    };
  },

  // SessionStart and UserPromptSubmit read `hookSpecificOutput.additionalContext`,
  // the Claude Code envelope.
  formatOutput(result: HookResult): unknown {
    return claudeCodeAdapter.formatOutput(result);
  },
};
