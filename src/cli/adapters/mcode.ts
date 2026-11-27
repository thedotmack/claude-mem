import type { HookResult, NormalizedHookInput, PlatformAdapter } from '../types.js';
import { claudeCodeAdapter } from './claude-code.js';
import { AdapterRejectedInput, isValidCwd } from './errors.js';

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

// MiniMax Code sends Claude Code field names but its own lowercase tool names.
// Capture keys on the Claude Code names (see devin.ts), so the tools with a
// direct counterpart are mapped; the rest pass through.
const MCODE_TOOL_NAMES: Record<string, string> = {
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  bash: 'Bash',
  grep: 'Grep',
  glob: 'Glob',
  todowrite: 'TodoWrite',
  skill: 'Skill',
  web_fetch: 'WebFetch',
  web_search: 'WebSearch',
  task: 'Task',
};

// `read` and `write` take `path`; file capture reads `file_path`.
function withFilePath(toolName: string | undefined, input: unknown): unknown {
  if (toolName !== 'Read' && toolName !== 'Write') return input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const record = input as Record<string, unknown>;
  if (stringOrUndefined(record.file_path)) return input;
  return stringOrUndefined(record.path) ? { ...record, file_path: record.path } : input;
}

export const mcodeAdapter: PlatformAdapter = {
  normalizeInput(raw): NormalizedHookInput {
    const r = (raw ?? {}) as Record<string, unknown>;
    const cwd = stringOrUndefined(r.cwd) ?? process.cwd();
    if (!isValidCwd(cwd)) {
      throw new AdapterRejectedInput('invalid_cwd');
    }
    const input = claudeCodeAdapter.normalizeInput({ ...r, cwd });
    if (!stringOrUndefined(input.sessionId)) {
      throw new AdapterRejectedInput('missing_session_id');
    }
    const toolName = input.toolName && Object.hasOwn(MCODE_TOOL_NAMES, input.toolName)
      ? MCODE_TOOL_NAMES[input.toolName]
      : input.toolName;
    return {
      ...input,
      cwd,
      toolName,
      toolInput: withFilePath(toolName, input.toolInput),
      // MiniMax Code deletes this temp file when the session ends; summarize
      // uses last_assistant_message instead.
      transcriptPath: undefined,
    };
  },

  // SessionStart and UserPromptSubmit read `hookSpecificOutput.additionalContext`.
  formatOutput(result: HookResult): unknown {
    return claudeCodeAdapter.formatOutput(result);
  },
};
