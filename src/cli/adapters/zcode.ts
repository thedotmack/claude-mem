import type { HookResult, NormalizedHookInput, PlatformAdapter } from '../types.js';
import { claudeCodeAdapter } from './claude-code.js';
import { AdapterRejectedInput, isValidCwd } from './errors.js';

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

// ZCode sends Claude Code field and tool names (in snake_case and camelCase),
// so the Claude Code adapter does the mapping, PostToolUseFailure included.
export const zcodeAdapter: PlatformAdapter = {
  normalizeInput(raw): NormalizedHookInput {
    const r = (raw ?? {}) as Record<string, unknown>;
    // Only ZCode's own dirs: a CLAUDE_PROJECT_DIR inherited from the shell that
    // started ZCode names another project, so it must not replace this cwd.
    const cwd = stringOrUndefined(r.cwd) ?? stringOrUndefined(process.env.ZCODE_PROJECT_DIR) ?? r.cwd ?? process.cwd();
    if (!isValidCwd(cwd)) {
      throw new AdapterRejectedInput('invalid_cwd');
    }
    const input = claudeCodeAdapter.normalizeInput({ ...r, cwd });
    if (!stringOrUndefined(input.sessionId)) {
      throw new AdapterRejectedInput('missing_session_id');
    }
    return {
      ...input,
      cwd,
      // ZCode deletes this temp file once the hook exits and its format is not
      // documented; summarize uses last_assistant_message instead.
      transcriptPath: undefined,
    };
  },

  // ZCode reads `hookSpecificOutput.additionalContext`, the Claude Code envelope.
  formatOutput(result: HookResult): unknown {
    return claudeCodeAdapter.formatOutput(result);
  },
};
